// 潮位時系列の掃引。**時間発展モデルを作るのではない。**
// 各時刻の潮位を取り出し、その値を既存の静水位モデルへ入力するだけである。

export interface TidePoint {
  /** ISO 8601（JST, +09:00） */
  time: string
  /** m T.P. */
  tide_m_tp: number
}

export interface TideSeries {
  id: string
  label: string
  kind: 'observed' | 'computed'
  points: TidePoint[]
  peak_time: string
  peak_value_m_tp: number
}

/** Date の楽なテストのため、時刻は実行環境に依らず UTC で解釈する（JST オフセット付き） */
export function timeValue(time: string): number {
  return Date.parse(time)
}

/** 区間線形補間。観測は毎時なので、補間は描画用の滑らかさを得るための近似 */
export function tideAt(points: TidePoint[], timeMs: number): number {
  if (points.length === 0) return Number.NaN
  const first = timeValue(points[0].time)
  if (timeMs <= first) return points[0].tide_m_tp
  for (let i = 1; i < points.length; i++) {
    const b = points[i]
    const t2 = timeValue(b.time)
    if (timeMs <= t2) {
      const a = points[i - 1]
      const t1 = timeValue(a.time)
      const k = (timeMs - t1) / Math.max(1, t2 - t1)
      return a.tide_m_tp + k * (b.tide_m_tp - a.tide_m_tp)
    }
  }
  return points[points.length - 1].tide_m_tp
}

/** Δreal ms 分だけ進める。終端では止める（無音ループを作らない） */
export function advancedTime(
  points: TidePoint[], currentMs: number, deltaMs: number, speed = 1,
): { timeMs: number; atEnd: boolean } {
  const start = points.length ? timeValue(points[0].time) : 0
  const end = points.length ? timeValue(points[points.length - 1].time) : 0
  const next = Math.min(end, currentMs + deltaMs * speed)
  return { timeMs: next, atEnd: points.length === 0 || next >= end }
}

/** JST 固定（UTC+9）の時刻表示。実行環境の TZ に依らず舞鶴の時刻を出す */
export function formatJst(timeMs: number): string {
  const d = new Date(timeMs + 9 * 3600 * 1000)
  const mm = `${d.getUTCMonth() + 1}`.padStart(2, '0')
  const dd = `${d.getUTCDate()}`.padStart(2, '0')
  const hh = `${d.getUTCHours()}`.padStart(2, '0')
  const mi = `${d.getUTCMinutes()}`.padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}
