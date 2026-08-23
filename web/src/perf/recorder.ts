// 計測。FPS は見ない。「いつ・何バイトで・何が見えたか」を測る。
// docs/web_design.md「計測のしかけ」

import type { Scheduler } from '../net/scheduler'

export type Milestone =
  | 'app_start' | 'catalog_loaded' | 'first_meaningful_render'
  | 'time_to_terrain' | 'time_to_plateau'
  | 'time_to_first_useful_pc' | 'time_to_pc_refined'
  // 地物は「取得 -> JSON 解釈 -> 三角形化」で費用の質が違う。分けて測る
  | 'semantics_loaded' | 'semantics_parsed' | 'semantics_mesh_built'

export interface CameraEvent { at: number; settledAt?: number; latencyMs?: number }

interface ResourceSample { at: number; bytes: number }

/**
 * そのリクエストが「アプリのコード」か「地理データ」か。
 *
 * FMR を決めているのはバンドルであって地理データではない（§1、§6.6.4）。
 * それなら **コードのバイト数は毎回見る数字**であるべきで、
 * 別ツール（perf/shellcost.mjs）を走らせないと分からない状態にしておくと、
 * 増えたことに気づけない。分類は perf/shellcost.mjs の classify() と揃える。
 */
function shellKind(url: string): 'code' | 'font' | 'data' {
  const u = url.split('?')[0]
  if (/\.(js|mjs|cjs|css|wasm|map)$/i.test(u)) return 'code'
  if (/\.(woff2?|ttf|otf)$/i.test(u)) return 'font'
  return 'data'
}

export class PerfRecorder {
  readonly t0 = performance.now()
  private marks = new Map<string, number>()
  private samples: ResourceSample[] = []
  private cumulative = 0
  /** shell（コード + フォント）の転送量。地理データと分けて数える */
  private shellBytes = 0
  private shellRequests = 0
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
          if (shellKind(e.name) !== 'data') { this.shellBytes += b; this.shellRequests++ }
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

  /**
   * ナビゲーション開始（`performance.timeOrigin`）から、この recorder が
   * 作られるまでの時間。= **アプリの JS を落として実行し終えるまで**。
   *
   * マイルストーンはすべて `t0` 基準（アプリ起動から）で記録している。
   * `docs/web_design.md`「マイルストーンの定義」は `app_start = performance.timeOrigin` と書いていたが、
   * 実装はそうなっていなかった。つまり公表していた `first_meaningful_render` は
   * **バンドルの取得と実行にかかった時間を含んでいない**。
   * shell のコストを比較する土俵ではそこが本体なので（`docs/adr/2026-08-22-web-shell.md`）、
   * 既存の値はそのまま残したうえで、ナビゲーション基準の値を併記する。
   */
  get bootOffsetMs() { return this.t0 }

  snapshot() {
    const fmr = this.marks.get('first_meaningful_render')
    const st = this.scheduler.stats()
    const milestones = Object.fromEntries(
      [...this.marks].map(([k, v]) => [k, Math.round(v)]))
    return {
      milestones,
      boot_offset_ms: Math.round(this.t0),
      /** 同じマイルストーンをナビゲーション開始基準に直したもの */
      milestones_navigation: Object.fromEntries(
        [...this.marks].map(([k, v]) => [k, Math.round(v + this.t0)])),
      shell: {
        // 地理データを 1 バイトも見る前に払っているコスト。回帰指標（§8）
        bytes: this.shellBytes,
        requests: this.shellRequests,
      },
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
