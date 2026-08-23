// index -> LOD -> Scheduler(coalescing) -> decode worker -> renderer をつなぐ。
// ここが唯一 4 者を知っている場所。renderer を差し替えてもここ以外は変わらない。

import { boxesOverlap, boxIntersectsPolygon } from '../domain/camera'
import { coalesce, type RangeMember } from '../net/coalesce'
import type { Scheduler } from '../net/scheduler'
import type { PerfRecorder } from '../perf/recorder'
import { CopcIndex, schedulerGetter } from './copcIndex'
import type { PointCloudRenderer } from './renderer'
import { DecodePool } from './decodePool'
import { selectNodes } from './lod'
import type { LodBudget, NodeRequest, ViewState } from './types'

export interface PcControllerOptions {
  url: string
  scheduler: Scheduler
  perf: PerfRecorder
  renderer: PointCloudRenderer
  origin6674: [number, number]
  matrix: [number, number, number, number]
  geoid: number
  /** coalescing の設定。off にして比較計測できるようにしておく */
  coalesceGap: number
  maxSpan: number
  /**
   * 「点群が見えた」とみなす、LOD が選んだ点数に対する割合。
   *
   * 以前は絶対値（20 万点）で判定していた。これは合成点群（325 万点・一様）向けに
   * 決めた値で、実点群では LOD の選択が 17.3〜21.6 万点と閾値をまたぐため、
   * 同じ画面でもプロファイルによって計測できたりできなかったりした。
   * データの密度や LOD 予算を変えるたびに意味が変わる指標は使えない。
   *
   * LOD が「この視点にはこれだけ要る」と決めた点数に対する割合で見れば、
   * データセットにも予算にも依らず「点群が実質そろった時刻」を指せる。
   */
  usefulFraction: number
}

export class PointCloudController {
  private index?: CopcIndex
  private pool = new DecodePool()
  private inFlight = new Set<string>()
  private resident = new Set<string>()
  /** いま必要としているノード。stillNeeded はここを見る（発行時の集合ではなく） */
  private wanted = new Set<string>()
  /** LOD がいまの視点に必要と判断した点数。useful 判定の分母 */
  private wantedPoints = 0
  private epoch = 0
  private opened = false

  constructor(private readonly o: PcControllerOptions) {}

  get ready() { return this.opened }
  get nodeCount() { return this.index?.nodes.size ?? 0 }
  get decodeWorkers() { return this.pool.size }

  /** COPC の header + root hierarchy だけ先に取る（class pcIndex は gate を通る） */
  async open() {
    const getter = schedulerGetter(this.o.scheduler, this.o.url, 'pcIndex')
    this.index = new CopcIndex(this.o.url, getter)
    await this.index.open()
    await this.index.expand(4)
    this.opened = true
    this.o.perf.mark('pc_index_loaded')
  }

  toLocal = (x: number, y: number): [number, number] => {
    const [a, b, c, d] = this.o.matrix
    const dx = x - this.o.origin6674[0]
    const dy = y - this.o.origin6674[1]
    return [a * dx + b * dy, c * dx + d * dy]
  }

  /** カメラが落ち着いたら呼ぶ。必要なノードを取りに行く */
  async update(view: ViewState, budget: LodBudget) {
    if (!this.index) return
    this.epoch++
    const wanted = selectNodes({
      info: this.index.info,
      nodes: this.index.allNodes,
      view, budget,
      toLocal: this.toLocal,
      // ノード境界は EPSG:6674。画面範囲はローカル メートルで来るので、
      // ここで同じ空間に揃える。**多角形があるならそちらを使う**
      // （外接矩形は傾けた視野で実際の 2 倍近く残す）
      isVisible: (view.visiblePoly?.length ?? 0) >= 3 || view.visible ? (b) => {
        const [x0, y0] = this.toLocal(b[0], b[1])
        const [x1, y1] = this.toLocal(b[3], b[4])
        const box: [number, number, number, number] = [
          Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1),
        ]
        if ((view.visiblePoly?.length ?? 0) >= 3) {
          return boxIntersectsPolygon(box, view.visiblePoly!, view.visibleMarginM ?? 0)
        }
        return boxesOverlap(box, view.visible!)
      } : undefined,
    })
    this.wanted = new Set(wanted.map((w) => w.key))
    this.wantedPoints = wanted.reduce((s, w) => s + w.pointCount, 0)
    const wantedKeys = this.wanted

    // 不要になったものを GPU から降ろす
    const drop = [...this.resident].filter((k) => !wantedKeys.has(k))
    if (drop.length) {
      this.o.renderer.evict(drop)
      for (const k of drop) this.resident.delete(k)
    }

    const todo = wanted.filter((w) => !this.resident.has(w.key) && !this.inFlight.has(w.key))
    if (todo.length === 0) { this.o.perf.cameraSettled(); return }

    const members: RangeMember<NodeRequest>[] = todo.map((n) => ({
      item: n, begin: n.byteRange[0], end: n.byteRange[1],
    }))
    // COPC + Range は「採用しただけ」では足りない。連続レンジにまとめて往復を減らす
    const groups = this.o.coalesceGap > 0
      ? coalesce(members, this.o.coalesceGap, this.o.maxSpan)
      : members.map((m) => ({ begin: m.begin, end: m.end, members: [m], extraBytes: 0 }))

    for (const g of groups) {
      if (g.members.length > 1) this.o.scheduler.noteCoalesce(g.members.length, g.extraBytes)
      for (const m of g.members) this.inFlight.add(m.item.key)
      void this.fetchGroup(g)
    }
  }

  private async fetchGroup(
    g: { begin: number; end: number; members: RangeMember<NodeRequest>[]; extraBytes: number },
  ) {
    const anyCoarse = g.members.some((m) => m.item.coarse)
    /**
     * **Scheduler の epoch を渡す。コントローラ自身の `this.epoch` ではない。**
     *
     * `Scheduler.stale()` は `task.epoch < scheduler.epoch` で古さを判定する。
     * ここに別のカウンタを渡すと比較が成立しない。実際、
     * `main.ts` はカメラ移動のたびに `scheduler.setEpoch(+1)` してから
     * `controller.update()` を呼ぶので、コントローラの epoch は常に
     * Scheduler より 1 進んでいた。結果 `stale()` が恒真で false になり、
     * **点群の要求は一度もキャンセルされなかった**（実測: 高 RTT 回線で
     * pcFine が飛行中でもキャンセル 0 件）。
     */
    const epochAtIssue = this.o.scheduler.currentEpoch
    const byKey = new Map(g.members.map((m) => [m.item.key, m]))
    const decoding: Promise<void>[] = []
    try {
      await this.o.scheduler.submit({
        key: `${this.o.url}#${g.begin}-${g.end}`,
        url: this.o.url,
        range: [g.begin, g.end - 1],
        cls: anyCoarse ? 'pcCoarse' : 'pcFine',
        rank: Math.min(...g.members.map((m) => m.item.depth)),
        epoch: epochAtIssue,
        estBytes: g.end - g.begin,
        // 発行時の集合を閉じ込めると永久に true になり、キャンセルが一度も発火しない。
        // 常に「いま必要なノード」を見る
        stillNeeded: () => g.members.some((m) => this.wanted.has(m.item.key)),
        // まとめた range の中を、届いた順にデコードする。
        // 1 本の完了を待つと coalescing がそのまま「最初の点の遅延」になる
        parts: g.members.map((m) => ({ key: m.item.key, begin: m.begin, end: m.end })),
        onPart: (key, bytes) => {
          const m = byKey.get(key)
          if (m) decoding.push(this.decodeAndShow(m, bytes))
        },
      })
      await Promise.all(decoding)
      if (this.inFlight.size <= g.members.length) {
        this.o.perf.mark('time_to_pc_refined')
        this.o.perf.cameraSettled()
      }
    } catch {
      /* キャンセル/失敗は scheduler が記録済み */
    } finally {
      for (const m of g.members) this.inFlight.delete(m.item.key)
      if (this.inFlight.size === 0) this.o.perf.cameraSettled()
    }
  }

  /** 1 ノード分のバイトが届いた時点でデコードし、そのまま画面に出す */
  private async decodeAndShow(m: RangeMember<NodeRequest>, bytes: Uint8Array): Promise<void> {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const chunk = await this.pool.decode({
      key: m.item.key,
      header: this.index!.header,
      eb: this.index!.eb,
      node: {
        pointCount: m.item.pointCount,
        pointDataOffset: m.begin,
        pointDataLength: m.end - m.begin,
      },
      bytes: buf,
      origin: this.o.origin6674,
      matrix: this.o.matrix,
      geoid: this.o.geoid,
    }, [buf])
    this.o.perf.noteDecode(chunk.decodeMs)
    this.resident.add(chunk.key)
    const t0 = performance.now()
    this.o.renderer.upsert([chunk])
    this.o.perf.noteGpuUpload(performance.now() - t0)
    const need = this.wantedPoints * this.o.usefulFraction
    if (need > 0 && this.o.renderer.stats().residentPoints >= need) {
      this.o.perf.mark('time_to_first_useful_pc')
    }
  }

  stats() {
    return {
      nodes: this.nodeCount,
      wantedPoints: this.wantedPoints,
      resident: this.resident.size,
      inFlight: this.inFlight.size,
      ...this.o.renderer.stats(),
    }
  }

  dispose() { this.pool.dispose() }
}
