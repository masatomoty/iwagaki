// 単一の choke point。3D Tiles も COPC も タイルも GeoJSON も、ネットワークは全部ここを通る。
// renderer は fetch を呼ばない。必要なもの（key + class + rank）を submit するだけ。
// docs/WEB_DESIGN.md「リクエストスケジューラ」

import { ByteLru } from './cache'
import { rangeFetch, RangeNotHonoured } from './rangefetch'
import { P, type FetchTask, type RequestClass, type RequestRecord, type SchedulerStats } from './types'

interface Waiter {
  task: FetchTask
  seq: number
  resolve: (v: Uint8Array) => void
  reject: (e: unknown) => void
}

interface Live {
  ctrl: AbortController
  task: FetchTask
  rec: RequestRecord
  received: number
}

/** 並列上限（docs/WEB_DESIGN.md「並列上限」）。すべて初期値であり、実測でチューニングする前提 */
const CAPS = {
  h1: { global: 6, group: { a: 4, b: 4, c: 3, d: 3, e: 1 } },
  h2: { global: 12, group: { a: 6, b: 6, c: 4, d: 6, e: 2 } },
}
const GROUP: Record<RequestClass, 'a' | 'b' | 'c' | 'd' | 'e'> = {
  catalog: 'a', terrainCoarse: 'a',
  terrainFine: 'b', pcIndex: 'b',
  semantics: 'c', plateau: 'c',
  pcCoarse: 'd', pcFine: 'd',
  prefetch: 'e',
}
/** first_meaningful_render が立つまで止めておくクラス */
const GATED: RequestClass[] = ['pcCoarse', 'pcFine']
const MAX_RETRIES = 2
const CANCEL_PROGRESS_GUARD = 0.8   // 8 割受信済みなら捨てる方が損

export interface SchedulerOptions {
  memoryCacheBytes?: number
  onRecord?: (r: RequestRecord) => void
}

export class Scheduler {
  private queue: Waiter[] = []
  private live = new Map<string, Live>()
  private inflightPromise = new Map<string, Promise<Uint8Array>>()
  private cache: ByteLru<Uint8Array>
  private seq = 0
  private records: RequestRecord[] = []
  private gateOpen = false
  private epoch = 0
  private protocol: 'h1' | 'h2' = 'h2'
  private bwBps = 0
  private peak = 0
  private coalesceStats = { groups: 0, members: 0, extraBytes: 0 }
  private onRecord?: (r: RequestRecord) => void

  constructor(opts: SchedulerOptions = {}) {
    this.cache = new ByteLru(opts.memoryCacheBytes ?? 96 * 1024 * 1024)
    this.onRecord = opts.onRecord
  }

  /** first_meaningful_render 後に呼ぶ。点群クラスの停止を解除する */
  openGate() { if (!this.gateOpen) { this.gateOpen = true; this.pump() } }
  get gated() { return !this.gateOpen }

  setEpoch(n: number) { this.epoch = n }
  get currentEpoch() { return this.epoch }

  noteCoalesce(members: number, extraBytes: number) {
    this.coalesceStats.groups += 1
    this.coalesceStats.members += members
    this.coalesceStats.extraBytes += extraBytes
  }

  submit(task: FetchTask): Promise<Uint8Array> {
    const hit = this.cache.get(task.key)
    if (hit) {
      if (task.parts && task.onPart) {
        const b = task.range?.[0] ?? 0
        for (const p of task.parts) task.onPart(p.key, hit.slice(p.begin - b, p.end - b))
      }
      return Promise.resolve(hit)
    }
    const existing = this.inflightPromise.get(task.key)
    if (existing) return existing            // L0: 同一 key の重複を合流
    const p = new Promise<Uint8Array>((resolve, reject) => {
      this.queue.push({ task, seq: this.seq++, resolve, reject })
    })
    this.inflightPromise.set(task.key, p)
    this.pump()
    return p
  }

  /**
   * 不要になったタスクを落とす。
   * epoch が古いだけでは切らない。「新しい可視集合に無い」ことを条件にする（§4.5）。
   */
  reap(): { queued: number; aborted: number } {
    let queued = 0
    this.queue = this.queue.filter((w) => {
      if (this.stale(w.task)) {
        queued++
        this.settleCancelled(w)
        return false
      }
      return true
    })
    let aborted = 0
    for (const [, l] of this.live) {
      if (P[l.task.cls] < P.semantics) continue      // class <= 1 は切らない
      if (!this.stale(l.task)) continue
      const total = l.task.estBytes ?? 0
      if (total > 0 && l.received / total >= CANCEL_PROGRESS_GUARD) continue
      l.ctrl.abort()
      aborted++
    }
    if (queued || aborted) this.pump()
    return { queued, aborted }
  }

  private stale(t: FetchTask): boolean {
    if (t.epoch === undefined) return false
    if (t.epoch >= this.epoch) return false
    return t.stillNeeded ? !t.stillNeeded() : true
  }

  private settleCancelled(w: Waiter) {
    this.inflightPromise.delete(w.task.key)
    const rec: RequestRecord = {
      key: w.task.key, cls: w.task.cls, url: w.task.url, ranged: !!w.task.range,
      startedAt: performance.now(), bytes: 0, wireBytes: 0, cancelled: true,
      wastedBytes: 0, retries: 0,
    }
    this.pushRecord(rec)
    w.reject(new DOMException('cancelled before start', 'AbortError'))
  }

  private capacity() {
    const caps = CAPS[this.protocol]
    const perGroup: Record<string, number> = {}
    for (const [, l] of this.live) perGroup[GROUP[l.task.cls]] = (perGroup[GROUP[l.task.cls]] ?? 0) + 1
    return { caps, perGroup, total: this.live.size }
  }

  private pump() {
    if (this.queue.length === 0) return
    this.queue.sort((a, b) =>
      P[a.task.cls] - P[b.task.cls] ||
      (a.task.rank ?? 0) - (b.task.rank ?? 0) ||
      a.seq - b.seq)
    for (;;) {
      const { caps, perGroup, total } = this.capacity()
      if (total >= caps.global) return
      const idx = this.queue.findIndex((w) => {
        if (!this.gateOpen && GATED.includes(w.task.cls)) return false
        const g = GROUP[w.task.cls]
        return (perGroup[g] ?? 0) < caps.group[g]
      })
      if (idx < 0) return
      const [w] = this.queue.splice(idx, 1)
      void this.run(w)
    }
  }

  private async run(w: Waiter, attempt = 0) {
    const ctrl = new AbortController()
    if (w.task.signal) w.task.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    const rec: RequestRecord = {
      key: w.task.key, cls: w.task.cls, url: w.task.url, ranged: !!w.task.range,
      startedAt: performance.now(), bytes: 0, wireBytes: 0, cancelled: false,
      wastedBytes: 0, retries: attempt,
    }
    const live: Live = { ctrl, task: w.task, rec, received: 0 }
    this.live.set(w.task.key, live)
    this.peak = Math.max(this.peak, this.live.size)
    // まとめた range の中を、届いた順に払い出す（1 本の完了を待たない）
    const spanBegin = w.task.range?.[0] ?? 0
    const pending = w.task.parts ? [...w.task.parts].sort((a, b) => a.end - b.end) : []
    let emitted = 0
    const onData = w.task.parts && w.task.onPart
      ? (buf: Uint8Array, received: number) => {
          while (emitted < pending.length &&
                 pending[emitted].end - spanBegin <= received) {
            const p = pending[emitted++]
            try {
              w.task.onPart!(p.key, buf.slice(p.begin - spanBegin, p.end - spanBegin))
            } catch {
              /* 呼び出し側の失敗で取得を止めない */
            }
          }
        }
      : undefined

    try {
      const r = await rangeFetch(
        w.task.url, w.task.range, ctrl.signal, (n) => { live.received = n }, onData)
      if (onData) onData(r.bytes, r.bytes.byteLength)   // 取りこぼしを最後に流す
      rec.endedAt = performance.now()
      rec.ttfbMs = r.ttfbMs
      rec.bytes = r.bytes.byteLength
      // 圧縮されていなければデコード後 = wire。されていれば stats() で引き当て直す
      rec.wireBytes = r.encoded ? -1 : r.bytes.byteLength
      rec.status = r.status
      this.live.delete(w.task.key)
      this.noteBandwidth(rec)
      this.cache.set(w.task.key, r.bytes)
      this.inflightPromise.delete(w.task.key)
      this.pushRecord(rec)
      w.resolve(r.bytes)
    } catch (e) {
      this.live.delete(w.task.key)
      const aborted = (e as Error)?.name === 'AbortError'
      if (!aborted && !(e instanceof RangeNotHonoured) && attempt < MAX_RETRIES) {
        const backoff = 250 * 2 ** attempt * (0.8 + Math.random() * 0.4)
        setTimeout(() => void this.run(w, attempt + 1), backoff)
        return
      }
      rec.endedAt = performance.now()
      rec.cancelled = aborted
      rec.wastedBytes = aborted ? live.received : 0
      rec.error = aborted ? 'aborted' : String((e as Error)?.message ?? e)
      this.inflightPromise.delete(w.task.key)
      this.pushRecord(rec)
      w.reject(e)
    } finally {
      this.pump()
    }
  }

  private noteBandwidth(rec: RequestRecord) {
    const dt = (rec.endedAt! - rec.startedAt) / 1000
    // **デコード後ではなく wire で測る。** br が効く geojson/json を
    // デコード後で数えると帯域を 6 倍に見積もり、点群の LOD 予算
    // （maxBytes = bw * 6）がその分だけ甘くなる
    // wire が未確定（圧縮応答）ならデコード後で代用する。帯域を過大に見積もる側だが、
    // 完了直後に PerformanceResourceTiming が揃っているとは限らない
    const w = rec.wireBytes < 0 ? rec.bytes : rec.wireBytes
    if (dt <= 0.005 || w < 4096) return
    const bps = w / dt
    this.bwBps = this.bwBps === 0 ? bps : this.bwBps * 0.7 + bps * 0.3
  }

  private pushRecord(r: RequestRecord) {
    this.records.push(r)
    this.onRecord?.(r)
  }

  /** nextHopProtocol を見て h1/h2 を判定する。並列上限の結論が変わるので必ず記録する */
  detectProtocol() {
    const es = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const proto = es.map((e) => e.nextHopProtocol).filter(Boolean)
    const h2 = proto.filter((p) => p === 'h2' || p === 'h3').length
    this.protocol = h2 > proto.length / 2 ? 'h2' : 'h1'
    return { protocol: this.protocol, observed: proto[proto.length - 1] ?? '' }
  }

  get bandwidthBps() { return this.bwBps }
  get allRecords(): readonly RequestRecord[] { return this.records }

  /**
   * 圧縮された応答の wire バイト数を PerformanceResourceTiming から引き当てる。
   *
   * Cloudflare は br 応答に content-length を付けないので、fetch のヘッダからは
   * 符号化後の長さが取れない。`encodedBodySize` は content-coding 適用後の
   * ボディ長そのもので、これが欲しい値。同一オリジン配信が前提（§8.3）。
   *
   * 同じ URL に複数回（Range で）投げることがあるので、開始時刻が近いものを選ぶ。
   * 引き当てられなければ -1 のままにせず、デコード後の値に戻す
   * （**過大に出る方に倒す**。ネットワーク費用を小さく見せる方に倒すと判断を誤る）。
   */
  private resolveWireBytes() {
    const pending = this.records.filter((r) => r.wireBytes < 0)
    if (pending.length === 0 || typeof performance.getEntriesByType !== 'function') return
    const byUrl = new Map<string, PerformanceResourceTiming[]>()
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      const list = byUrl.get(e.name)
      if (list) list.push(e)
      else byUrl.set(e.name, [e])
    }
    for (const r of pending) {
      const cands = byUrl.get(new URL(r.url, location.href).href)
      if (!cands?.length) { r.wireBytes = r.bytes; continue }
      let best: PerformanceResourceTiming | undefined
      let bestDt = Infinity
      for (const e of cands) {
        const dt = Math.abs(e.startTime - r.startedAt)
        if (dt < bestDt) { bestDt = dt; best = e }
      }
      // encodedBodySize は cross-origin だと 0。その場合は諦めてデコード後を使う
      r.wireBytes = best && best.encodedBodySize > 0 ? best.encodedBodySize : r.bytes
    }
  }

  stats(): SchedulerStats {
    this.resolveWireBytes()
    const byClass: SchedulerStats['byClass'] = {}
    let bytes = 0, wire = 0, wasted = 0, cancelled = 0, failed = 0, completed = 0
    for (const r of this.records) {
      const b = (byClass[r.cls] ??= { issued: 0, bytes: 0, wireBytes: 0, cancelled: 0, wasted: 0 })
      b.issued++
      b.bytes += r.bytes
      bytes += r.bytes
      const w = r.wireBytes < 0 ? r.bytes : r.wireBytes
      b.wireBytes += w
      wire += w
      wasted += r.wastedBytes
      b.wasted += r.wastedBytes
      if (r.cancelled) { cancelled++; b.cancelled++ }
      else if (r.error) failed++
      else completed++
    }
    return {
      issued: this.records.length, completed, cancelled, failed,
      bytes, wireBytes: wire, wastedBytes: wasted,
      peakConcurrent: this.peak, concurrentNow: this.live.size,
      byClass, coalesced: { ...this.coalesceStats },
      bandwidthBps: Math.round(this.bwBps), protocol: this.protocol,
    }
  }
}
