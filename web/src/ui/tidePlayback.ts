// 潮位再生。**モデルの時間積分ではなく、静水位 H のパラメータ掃引**である。
// requestAnimationFrame で曲線の時刻を進め、その時刻の潮位を state.waterLevel に置くだけ。
// h_conn 評価は定数時間なので、サーバ往復もタイルの作り直しも発生しない。

import { advancedTime, formatJst, tideAt, timeValue,
         type TidePoint, type TideSeries } from '../domain/tideSeries'
import type { Store } from '../state'

export interface PlaybackStats {
  under: number
  above: number
  regulatedRoads: number
}

const SPEEDS = [60, 300, 1800]
const WIDTH = 300
const HEIGHT = 58

function curvePath(points: TidePoint[]): string {
  if (points.length < 2) return ''
  const t0 = timeValue(points[0].time)
  const t1 = timeValue(points[points.length - 1].time)
  const lo = Math.min(...points.map((p) => p.tide_m_tp))
  const hi = Math.max(...points.map((p) => p.tide_m_tp))
  const span = Math.max(0.01, hi - lo)
  const x = (t: number) => ((t - t0) / (t1 - t0)) * WIDTH
  const y = (v: number) => HEIGHT - 4 - ((v - lo) / span) * (HEIGHT - 10)
  return points.map((p, i) => `${i ? 'L' : 'M'}${x(timeValue(p.time)).toFixed(1)},${y(p.tide_m_tp).toFixed(1)}`).join('')
}

function markerStyle(points: TidePoint[], peak: string): string {
  const t0 = timeValue(points[0].time)
  const t1 = timeValue(points[points.length - 1].time)
  const left = ((timeValue(peak) - t0) / (t1 - t0)) * 100
  return `left:${left}%`
}

function options(curves: TideSeries[], selected: string): string {
  return curves.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.label}</option>`).join('')
}

export function tidePlaybackHtml(curves: TideSeries[], selected: string): string {
  return `
    <p class="grouplabel">潮位の再生</p>
    <div id="playback" data-curve="${selected}">
      <div class="wlrow"><button id="play" type="button" aria-pressed="false">再生</button>
        <input id="ptime" type="range" min="0" max="1000" value="0" step="1"
               aria-label="潮位時系列の時刻" /></div>
      <div class="timeline"><span class="peakmark" id="peakmark"></span></div>
      <svg class="tidecurve" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true">
        <path id="curve" d="${curvePath(curves.find((c) => c.id === selected)?.points ?? [])}"></path>
        <circle id="peakdot" r="2.6"></circle>
      </svg>
      <div class="subrow"><span id="pnow">—</span>
        <span>最高 <b id="ppeak">—</b> <i data-speed="peak"></i></span></div>
      <div class="seg" id="pspeed">${SPEEDS.map((s, i) =>
        `<button data-s="${s}" type="button" aria-pressed="${i === 1}">×${s}</button>`).join('')}</div>
      <select id="pcurve" aria-label="潮位曲線">${options(curves, selected)}</select>
      <div id="pstats" class="livecounts">—</div>
      <div class="sub"><b>各時刻を静水位で解いた掃引</b>。時間発展・流量・波は解いていない</div>
    </div>`
}

/** 初回構築後だけ呼ぶ。以後の refresh では DOM を作り直さない */
export function mountTidePlayback(
  parent: HTMLElement, curves: TideSeries[], selected: string, store: Store,
): void {
  const el = parent.querySelector<HTMLElement>('#playback')
  if (!el) return
  let curve = curves.find((c) => c.id === selected) ?? curves[0]
  let currentMs = timeValue(curve.points[0].time)
  let speed = 300
  let playing = false
  let lastFrame: number | undefined
  let stopAtPeak = true
  let raf = 0

  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(sel)
  const peakMs = timeValue(curve.peak_time)
  const setPeakUi = () => {
    const mark = q('#peakmark')
    const dot = q<SVGCircleElement>('#peakdot')
    if (mark) mark.setAttribute('style', markerStyle(curve.points, curve.peak_time))
    if (dot) {
      const lo = Math.min(...curve.points.map((p) => p.tide_m_tp))
      const hi = Math.max(...curve.points.map((p) => p.tide_m_tp))
      const x = ((peakMs - timeValue(curve.points[0].time))
        / (timeValue(curve.points[curve.points.length - 1].time)
          - timeValue(curve.points[0].time))) * WIDTH
      const y = HEIGHT - 4 - ((curve.peak_value_m_tp - lo) / Math.max(0.01, hi - lo)) * (HEIGHT - 10)
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y))
    }
  }

  const paint = () => {
    const value = tideAt(curve.points, currentMs)
    const start = timeValue(curve.points[0].time)
    const end = timeValue(curve.points[curve.points.length - 1].time)
    const pnow = q('#pnow'); const input = q<HTMLInputElement>('#ptime')
    const peak = q('#ppeak')
    if (pnow) pnow.textContent = `${formatJst(currentMs)} / H ${value.toFixed(2)} m`
    if (input) input.value = String(Math.round(((currentMs - start) / (end - start)) * 1000))
    if (peak) peak.textContent = `${formatJst(peakMs)} ${curve.peak_value_m_tp.toFixed(2)} m`
  }

  const tick = (now: number) => {
    if (!playing) return
    if (lastFrame !== undefined) {
      const next = advancedTime(curve.points, currentMs, now - lastFrame, speed)
      currentMs = next.timeMs
      if (stopAtPeak && currentMs >= peakMs) {
        currentMs = peakMs
        playing = false
        stopAtPeak = false
      } else if (next.atEnd) playing = false
    }
    lastFrame = now
    store.set({ waterLevel: tideAt(curve.points, currentMs) })
    paint()
    const btn = q<HTMLButtonElement>('#play')
    if (btn) {
      btn.textContent = playing ? '停止' : '再生'
      btn.setAttribute('aria-pressed', String(playing))
    }
    if (playing) raf = requestAnimationFrame(tick)
  }

  q<HTMLButtonElement>('#play')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement
    playing = !playing
    stopAtPeak = true
    lastFrame = undefined
    btn.textContent = playing ? '停止' : '再生'
    btn.setAttribute('aria-pressed', String(playing))
    if (playing) {
      const end = timeValue(curve.points[curve.points.length - 1].time)
      if (currentMs >= end) currentMs = timeValue(curve.points[0].time)
      raf = requestAnimationFrame(tick)
    } else cancelAnimationFrame(raf)
  })
  q<HTMLInputElement>('#ptime')?.addEventListener('input', (e) => {
    const start = timeValue(curve.points[0].time)
    const end = timeValue(curve.points[curve.points.length - 1].time)
    const k = Number((e.target as HTMLInputElement).value) / 1000
    currentMs = start + k * (end - start)
    playing = false
    cancelAnimationFrame(raf)
    stopAtPeak = false
    store.set({ waterLevel: tideAt(curve.points, currentMs) })
    paint()
  })
  q('#pspeed')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-s]')
    if (!b) return
    speed = Number(b.dataset.s)
    for (const x of q('#pspeed')!.querySelectorAll<HTMLButtonElement>('button')) {
      x.setAttribute('aria-pressed', String(x === b))
    }
  })
  q<HTMLSelectElement>('#pcurve')?.addEventListener('change', (e) => {
    const next = curves.find((c) => c.id === (e.target as HTMLSelectElement).value) ?? curves[0]
    curve = next
    currentMs = timeValue(next.points[0].time)
    playing = false
    cancelAnimationFrame(raf)
    stopAtPeak = true
    el.dataset.curve = next.id
    const path = q<SVGPathElement>('#curve')
    if (path) path.setAttribute('d', curvePath(next.points))
    setPeakUi()
    store.set({ waterLevel: tideAt(next.points, currentMs) })
    paint()
  })
  setPeakUi(); paint()
}

/** refresh ごとに**出力だけ**を書き換える。入力 DOM は保持する */
export function updateTidePlayback(
  parent: HTMLElement, stats: PlaybackStats | undefined,
): void {
  const el = parent.querySelector<HTMLElement>('#playback')
  const out = parent.querySelector<HTMLElement>('#pstats')
  if (!el || !out || !stats) return
  out.innerHTML = `床下 <b>${stats.under}</b> 棟 / 床上 <b>${stats.above}</b> 棟`
    + ` / 規制対象道路 <b>${stats.regulatedRoads}</b> 本`
}
