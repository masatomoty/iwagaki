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

// 実時間 1 秒あたりに進める潮位時系列の長さ（秒）。ラベルは「1 秒でどれだけ
// 潮位が進むか」に翻訳する（生の ×60 は庁内で意味が読めなかった）。
const SPEEDS = [60, 300, 1800] as const
const SPEED_LABEL: Record<number, string> = { 60: '1分/秒', 300: '5分/秒', 1800: '30分/秒' }
const WIDTH = 300
const HEIGHT = 56

function extent(points: TidePoint[]): { t0: number; t1: number; lo: number; hi: number } {
  const t0 = timeValue(points[0].time)
  const t1 = timeValue(points[points.length - 1].time)
  const lo = Math.min(...points.map((p) => p.tide_m_tp))
  const hi = Math.max(...points.map((p) => p.tide_m_tp))
  return { t0, t1, lo, hi }
}

/** 曲線の座標変換。viewBox は 0..WIDTH / 0..HEIGHT で、SVG 側で幅いっぱいに引き伸ばす */
function projector(points: TidePoint[]) {
  const { t0, t1, lo, hi } = extent(points)
  const span = Math.max(0.01, hi - lo)
  return {
    x: (t: number) => ((t - t0) / (t1 - t0)) * WIDTH,
    y: (v: number) => HEIGHT - 4 - ((v - lo) / span) * (HEIGHT - 10),
  }
}

function curvePath(points: TidePoint[]): string {
  if (points.length < 2) return ''
  const { x, y } = projector(points)
  return points.map((p, i) =>
    `${i ? 'L' : 'M'}${x(timeValue(p.time)).toFixed(1)},${y(p.tide_m_tp).toFixed(1)}`).join('')
}

/** 曲線の下を塗る面。線を下辺まで閉じるだけ */
function fillPath(points: TidePoint[]): string {
  const line = curvePath(points)
  return line ? `${line}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z` : ''
}

function options(curves: TideSeries[], selected: string): string {
  return curves.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.label}</option>`).join('')
}

export function tidePlaybackHtml(curves: TideSeries[], selected: string): string {
  const points = curves.find((c) => c.id === selected)?.points ?? []
  return `
    <p class="grouplabel" data-tip="実測の台風イベント（および気象擾乱を含まない天文潮）の毎時潮位を再生し、水位が上がるにつれ浸水域がどう広がるかを見る。モデルの時間発展ではなく、各時刻を静水位で解いたもの。最高潮位で自動で止まる">潮位の記録を再生</p>
    <div id="playback" data-curve="${selected}">
      <select id="pcurve" aria-label="再生する潮位の記録">${options(curves, selected)}</select>
      <div class="pb-graph">
        <svg class="tidecurve" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" aria-hidden="true">
          <path id="curve-fill" d="${fillPath(points)}"></path>
          <path id="curve" d="${curvePath(points)}"></path>
          <line id="playhead" x1="0" y1="0" x2="0" y2="${HEIGHT}"></line>
          <circle id="peakdot" r="2.4"></circle>
        </svg>
        <input id="ptime" type="range" min="0" max="1000" value="0" step="1"
               aria-label="再生位置" />
      </div>
      <div class="pb-bar">
        <button id="play" type="button" aria-pressed="false">▶ 再生</button>
        <div class="seg" id="pspeed" data-tip="再生の速さ。実時間 1 秒あたりに進む潮位時系列の長さ">${SPEEDS.map((s, i) =>
          `<button data-s="${s}" type="button" aria-pressed="${i === 1}">${SPEED_LABEL[s]}</button>`).join('')}</div>
      </div>
      <dl class="pb-read">
        <div><dt>現在</dt><dd id="pnow">—</dd></div>
        <div><dt>最高</dt><dd id="ppeak">—</dd></div>
      </dl>
      <div id="pstats" class="pb-stats">—</div>
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
  // store.set は地物全体の再彩色を誘発する。再生中は約 15 Hz に間引く
  // （ホバーを store.set の外に出したのと同じ理由）。停止時は必ず流す。
  let lastPush = -Infinity

  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(sel)
  let peakMs = timeValue(curve.peak_time)

  /** 曲線が変わったときだけ呼ぶ。線・面・ピーク点の座標を貼り替える */
  const setCurveGeometry = () => {
    peakMs = timeValue(curve.peak_time)
    const line = q<SVGPathElement>('#curve')
    const fill = q<SVGPathElement>('#curve-fill')
    if (line) line.setAttribute('d', curvePath(curve.points))
    if (fill) fill.setAttribute('d', fillPath(curve.points))
    const dot = q<SVGCircleElement>('#peakdot')
    if (dot) {
      const { x, y } = projector(curve.points)
      dot.setAttribute('cx', String(x(peakMs).toFixed(1)))
      dot.setAttribute('cy', String(y(curve.peak_value_m_tp).toFixed(1)))
    }
  }

  const paint = () => {
    const value = tideAt(curve.points, currentMs)
    const start = timeValue(curve.points[0].time)
    const end = timeValue(curve.points[curve.points.length - 1].time)
    const k = end > start ? (currentMs - start) / (end - start) : 0
    const pnow = q('#pnow'); const input = q<HTMLInputElement>('#ptime')
    const peak = q('#ppeak'); const head = q<SVGLineElement>('#playhead')
    if (pnow) pnow.textContent = `${formatJst(currentMs)}・${value.toFixed(2)} m`
    if (peak) peak.textContent = `${formatJst(peakMs)}・${curve.peak_value_m_tp.toFixed(2)} m`
    if (input && document.activeElement !== input) input.value = String(Math.round(k * 1000))
    if (head) {
      const x = (k * WIDTH).toFixed(1)
      head.setAttribute('x1', x); head.setAttribute('x2', x)
    }
  }

  const tick = (now: number) => {
    if (!playing) return
    if (lastFrame !== undefined) {
      const prev = currentMs
      const next = advancedTime(curve.points, currentMs, now - lastFrame, speed)
      currentMs = next.timeMs
      // ピークは「手前から向かってきたとき」だけ停止点になる。越えた後の
      // 再生で巻き戻らないようにする
      if (stopAtPeak && prev < peakMs && currentMs >= peakMs) {
        currentMs = peakMs
        playing = false
        stopAtPeak = false
      } else if (next.atEnd) playing = false
    }
    lastFrame = now
    if (!playing || now - lastPush >= 66) {
      lastPush = now
      store.set({ waterLevel: tideAt(curve.points, currentMs) })
    }
    paint()
    const btn = q<HTMLButtonElement>('#play')
    if (btn) {
      btn.textContent = playing ? '⏸ 停止' : '▶ 再生'
      btn.setAttribute('aria-pressed', String(playing))
    }
    if (playing) raf = requestAnimationFrame(tick)
  }

  q<HTMLButtonElement>('#play')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement
    playing = !playing
    stopAtPeak = true
    lastFrame = undefined
    btn.textContent = playing ? '⏸ 停止' : '▶ 再生'
    btn.setAttribute('aria-pressed', String(playing))
    if (playing) {
      const end = timeValue(curve.points[curve.points.length - 1].time)
      if (currentMs >= end) currentMs = timeValue(curve.points[0].time)
      // すでにピークを越えているなら停止点としては扱わない
      stopAtPeak = currentMs < peakMs
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
    setCurveGeometry()
    store.set({ waterLevel: tideAt(next.points, currentMs) })
    paint()
  })
  setCurveGeometry(); paint()
}

/** refresh ごとに**出力だけ**を書き換える。入力 DOM は保持する */
export function updateTidePlayback(
  parent: HTMLElement, stats: PlaybackStats | undefined,
): void {
  const el = parent.querySelector<HTMLElement>('#playback')
  const out = parent.querySelector<HTMLElement>('#pstats')
  if (!el || !out || !stats) return
  // 棟数は scripts/91 と読み合わせるため**単純モデル**で固定評価。
  // viewer の地図配色は connected 既定なので、食い違いを明示して残す
  const n = (v: number, unit: string) => `<span class="pb-fig"><b>${v}</b> ${unit}</span>`
  out.innerHTML = `いまの潮位で 床下 ${n(stats.under, '棟')}`
    + ` / 床上 ${n(stats.above, '棟')} / 規制対象道路 ${n(stats.regulatedRoads, '本')}`
}
