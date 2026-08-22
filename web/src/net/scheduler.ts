// 単一の choke point。3D Tiles も COPC も タイルも GeoJSON も、ネットワークは全部ここを通る。
// renderer は fetch を呼ばない。必要なもの（key + class + rank）を submit するだけ。
// docs/WEB_DESIGN.md §4

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

/** 並列上限（docs/WEB_DESIGN.md §4.2）。すべて初期値であり、実測でチューニングする前提 */
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
    if (hit) return Promise.resolve(hit)
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
      startedAt: performance.now(), bytes: 0, cancelled: true, wastedBytes: 0, retries: 0,
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
      startedAt: performance.now(), bytes: 0, cancelled: false, wastedBytes: 0, retries: attempt,
    }
    const live: Live = { ctrl, task: w.task, rec, received: 0 }
    this.live.set(w.task.key, live)
    this.peak = Math.max(this.peak, this.live.size)
    try {
      const r = await rangeFetch(w.task.url, w.task.range, ctrl.signal, (n) => { live.received = n })
      rec.endedAt = performance.now()
      rec.ttfbMs = r.ttfbMs
      rec.bytes = r.bytes.byteLength
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
    if (dt <= 0.005 || rec.bytes < 4096) return
    const bps = rec.bytes / dt
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

  stats(): SchedulerStats {
    const byClass: SchedulerStats['byClass'] = {}
    let bytes = 0, wasted = 0, cancelled = 0, failed = 0, completed = 0
    for (const r of this.records) {
      const b = (byClass[r.cls] ??= { issued: 0, bytes: 0, cancelled: 0, wasted: 0 })
      b.issued++
      b.bytes += r.bytes
      bytes += r.bytes
      wasted += r.wastedBytes
      b.wasted += r.wastedBytes
      if (r.cancelled) { cancelled++; b.cancelled++ }
      else if (r.error) failed++
      else completed++
    }
    return {
      issued: this.records.length, completed, cancelled, failed,
      bytes, wastedBytes: wasted,
      peakConcurrent: this.peak, concurrentNow: this.live.size,
      byClass, coalesced: { ...this.coalesceStats },
      bandwidthBps: Math.round(this.bwBps), protocol: this.protocol,
    }
  }
}
