// 計測。FPS は見ない。「いつ・何バイトで・何が見えたか」を測る。
// docs/WEB_DESIGN.md §8

import type { Scheduler } from '../net/scheduler'

export type Milestone =
  | 'app_start' | 'catalog_loaded' | 'first_meaningful_render'
  | 'time_to_terrain' | 'time_to_plateau'
  | 'time_to_first_useful_pc' | 'time_to_pc_refined'

export interface CameraEvent { at: number; settledAt?: number; latencyMs?: number }

interface ResourceSample { at: number; bytes: number }

export class PerfRecorder {
  readonly t0 = performance.now()
  private marks = new Map<string, number>()
  private samples: ResourceSample[] = []
  private cumulative = 0
  private decode: number[] = []
  private gpuUpload: number[] = []
  private cameraEvents: CameraEvent[] = []
  private observer?: PerformanceObserver
  private listeners = new Set<() => void>()

  constructor(private scheduler: Scheduler) {
    this.mark('app_start', 0)
    if (typeof PerformanceObserver !== 'undefined') {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          // transferSize はクロスオリジンだと 0。同一オリジン配信が前提（§8.3）
          const b = e.transferSize || e.encodedBodySize || 0
          this.cumulative += b
          this.samples.push({ at: e.responseEnd, bytes: this.cumulative })
        }
        this.emit()
      })
      try { this.observer.observe({ type: 'resource', buffered: true }) } catch { /* noop */ }
    }
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { for (const f of this.listeners) f() }

  /** 値は app_start からの経過 ms。同じ名前は最初の 1 回だけ記録する */
  mark(name: Milestone | string, at = performance.now()) {
    if (this.marks.has(name)) return
    this.marks.set(name, name === 'app_start' ? 0 : at - this.t0)
    this.emit()
  }

  has(name: string) { return this.marks.has(name) }
  get(name: string) { return this.marks.get(name) }

  noteDecode(ms: number) { this.decode.push(ms) }
  noteGpuUpload(ms: number) { this.gpuUpload.push(ms) }

  cameraMoveStart() { this.cameraEvents.push({ at: performance.now() - this.t0 }) }
  cameraSettled() {
    const last = this.cameraEvents[this.cameraEvents.length - 1]
    if (!last || last.settledAt !== undefined) return
    last.settledAt = performance.now() - this.t0
    last.latencyMs = last.settledAt - last.at
    this.emit()
  }

  bytesAt(msSinceStart: number): number {
    const cut = this.t0 + msSinceStart
    let last = 0
    for (const s of this.samples) { if (s.at > cut) break; last = s.bytes }
    return last
  }

  get bytesNow() { return this.cumulative }

  private static pct(a: number[], p: number) {
    if (a.length === 0) return null
    const s = [...a].sort((x, y) => x - y)
    return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] * 100) / 100
  }

  snapshot() {
    const fmr = this.marks.get('first_meaningful_render')
    const st = this.scheduler.stats()
    return {
      milestones: Object.fromEntries(
        [...this.marks].map(([k, v]) => [k, Math.round(v)])),
      bytes: {
        initial_to_fmr: fmr !== undefined ? this.bytesAt(fmr) : null,
        at_5s: this.bytesAt(5000),
        at_10s: this.bytesAt(10000),
        total_now: this.cumulative,
      },
      scheduler: st,
      decode_ms: { p50: PerfRecorder.pct(this.decode, 0.5), p95: PerfRecorder.pct(this.decode, 0.95), n: this.decode.length },
      gpu_upload_ms: { p50: PerfRecorder.pct(this.gpuUpload, 0.5), p95: PerfRecorder.pct(this.gpuUpload, 0.95), n: this.gpuUpload.length },
      camera: {
        events: this.cameraEvents.length,
        settle_latency_ms: this.cameraEvents
          .filter((c) => c.latencyMs !== undefined)
          .map((c) => Math.round(c.latencyMs!)),
      },
    }
  }
}
