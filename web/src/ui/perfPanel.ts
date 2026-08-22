// 計測の常時表示。FPS は出さない（docs/WEB_DESIGN.md §8.1）。

import type { Scheduler } from '../net/scheduler'
import type { PerfRecorder } from '../perf/recorder'
import type { PointCloudController } from '../pointcloud/controller'
import type { Store } from '../state'

const mb = (b: number) => `${(b / 1e6).toFixed(2)} MB`
const ms = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v)} ms`)

export function renderPerf(
  el: HTMLElement, perf: PerfRecorder, sched: Scheduler,
  pc: PointCloudController | undefined, store: Store,
) {
  const s = perf.snapshot()
  const st = s.scheduler
  const p = pc?.stats() ?? { residentPoints: 0, drawCalls: 0, gpuBytes: 0 }
  el.innerHTML = `
    <h1>計測 <span class="sub">${st.protocol} / ${(st.bandwidthBps / 125000).toFixed(1)} Mbps 推定</span></h1>
    <table>
      <tr><td>catalog</td><td class="num">${ms(s.milestones.catalog_loaded)}</td></tr>
      <tr><td>first meaningful render</td><td class="num ${s.milestones.first_meaningful_render ? 'ok' : ''}">${ms(s.milestones.first_meaningful_render)}</td></tr>
      <tr><td>terrain 完了</td><td class="num">${ms(s.milestones.time_to_terrain)}</td></tr>
      <tr><td>PLATEAU 完了</td><td class="num">${ms(s.milestones.time_to_plateau)}</td></tr>
      <tr><td>点群 useful</td><td class="num">${ms(s.milestones.time_to_first_useful_pc)}</td></tr>
      <tr><td>FMR までの転送</td><td class="num">${s.bytes.initial_to_fmr === null ? '—' : mb(s.bytes.initial_to_fmr)}</td></tr>
      <tr><td>10 s 転送</td><td class="num">${mb(s.bytes.at_10s)}</td></tr>
      <tr><td>累計転送</td><td class="num">${mb(s.bytes.total_now)}</td></tr>
      <tr><td>Range リクエスト</td><td class="num">${st.issued}</td></tr>
      <tr><td>同時実行 peak / now</td><td class="num">${st.peakConcurrent} / ${st.concurrentNow}</td></tr>
      <tr><td>キャンセル</td><td class="num ${st.cancelled ? 'bad' : ''}">${st.cancelled} (${mb(st.wastedBytes)} 無駄)</td></tr>
      <tr><td>coalesce</td><td class="num">${st.coalesced.groups} 群 / ${st.coalesced.members} 本 / +${mb(st.coalesced.extraBytes)}</td></tr>
      <tr><td>decode p50/p95</td><td class="num">${s.decode_ms.p50 ?? '—'} / ${s.decode_ms.p95 ?? '—'} ms</td></tr>
      <tr><td>GPU upload p50</td><td class="num">${s.gpu_upload_ms.p50 ?? '—'} ms</td></tr>
      <tr><td>点群 常駐</td><td class="num">${(p.residentPoints / 1e6).toFixed(2)} M / ${p.drawCalls} draw</td></tr>
      <tr><td>カメラ応答</td><td class="num">${s.camera.settle_latency_ms.slice(-3).join(', ') || '—'}</td></tr>
    </table>
    <div class="note">水位 ${store.state.waterLevel.toFixed(2)} m。スライダ操作でリクエストは増えない。</div>
  `
}
