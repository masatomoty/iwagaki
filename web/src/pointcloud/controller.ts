// index -> LOD -> Scheduler(coalescing) -> decode worker -> renderer をつなぐ。
// ここが唯一 4 者を知っている場所。renderer を差し替えてもここ以外は変わらない。

import { coalesce, type RangeMember } from '../net/coalesce'
import type { Scheduler } from '../net/scheduler'
import type { PerfRecorder } from '../perf/recorder'
import { CopcIndex, schedulerGetter } from './copcIndex'
import type { DeckPointCloudRenderer } from './deckRenderer'
import { DecodePool } from './decodePool'
import { selectNodes } from './lod'
import type { LodBudget, NodeRequest, ViewState } from './types'

export interface PcControllerOptions {
  url: string
  scheduler: Scheduler
  perf: PerfRecorder
  renderer: DeckPointCloudRenderer
  origin6674: [number, number]
  matrix: [number, number, number, number]
  geoid: number
  /** coalescing の設定。off にして比較計測できるようにしておく */
  coalesceGap: number
  maxSpan: number
  usefulPoints: number
}

export class PointCloudController {
  private index?: CopcIndex
  private pool = new DecodePool()
  private inFlight = new Set<string>()
  private resident = new Set<string>()
  /** いま必要としているノード。stillNeeded はここを見る（発行時の集合ではなく） */
  private wanted = new Set<string>()
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
    })
    this.wanted = new Set(wanted.map((w) => w.key))
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
    const epochAtIssue = this.epoch
    try {
      const bytes = await this.o.scheduler.submit({
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
      })
      const chunks = await Promise.all(g.members.map(async (m) => {
        const slice = bytes.slice(m.begin - g.begin, m.end - g.begin)
        const buf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
        return this.pool.decode({
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
      }))
      for (const c of chunks) {
        this.o.perf.noteDecode(c.decodeMs)
        this.resident.add(c.key)
      }
      const t0 = performance.now()
      this.o.renderer.upsert(chunks)
      this.o.perf.noteGpuUpload(performance.now() - t0)

      const pts = this.o.renderer.stats().residentPoints
      if (pts >= this.o.usefulPoints) this.o.perf.mark('time_to_first_useful_pc')
      if (this.inFlight.size === 0) {
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

  stats() {
    return {
      nodes: this.nodeCount,
      resident: this.resident.size,
      inFlight: this.inFlight.size,
      ...this.o.renderer.stats(),
    }
  }

  dispose() { this.pool.dispose() }
}
