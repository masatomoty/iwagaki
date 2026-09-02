// 舞鶴（気象庁 MZ）の潮位予測。取得は `deploy/worker.js` の `/api/tide/maizuru`
// （同一オリジン。気象庁への通信は Worker 側で行い、ブラウザは直接気象庁へは出ない）。
// ここは Worker の応答を検証し、既存の `TideSeries` 形式（domain/tideSeries.ts）へ
// 正規化する層。**Worker 側で一度フィルタ・検証済みの応答でも、ここでもう一度
// 検証する。** 応答形式が壊れていても再生パネルの既存曲線を壊さないため
// （main.ts は失敗時に直前の状態を変えない）。

import type { TidePoint, TideSeries } from './tideSeries'

// **`timeValue`（= `Date.parse`）を tideSeries.ts から import しない。** ここは
// import type だけにして、Node の型除去（`node --test`）が実行時に
// `./tideSeries` を解決しに行かない状態を保つ（拡張子なしの相対 import は
// tsc の `moduleResolution: bundler` では書けるが、Node 単体実行では解決できない）。
// `Date.parse` そのものなので中身は完全に同じ
const timeValue = (time: string): number => Date.parse(time)

/** `/api/tide/maizuru` の生の応答形式 */
export interface TideForecastApiResponse {
  ok: boolean
  warning?: string
  retrieved_at?: string
  source_label?: string
  source_url?: string
  station_label?: string
  series?: TideSeries
  error?: string
}

export interface TideForecastParsed {
  series: TideSeries
  /** ISO 8601（UTC。表示は `formatJst` で JST に変換する） */
  retrievedAt: string
  sourceLabel: string
  /** 7 日分に満たない等、致命的ではないが利用者に伝えるべき事情 */
  warning?: string
}

export type TideForecastParseResult =
  | { ok: true; value: TideForecastParsed }
  | { ok: false; error: string }

const FORECAST_WINDOW_MS = 7 * 24 * 3600 * 1000
/** これ未満なら「対象期間のデータが無い」とみなす（1 点だけでは曲線にならない） */
const MIN_POINTS = 2

/**
 * 現在時刻以前を除外し、`now`〜`now + 7日` に絞って時刻順に並べ替える。
 * Worker 側でも同じ絞り込みをしているが、ここでも独立にかけることで、
 * 応答が壊れていても（例: 過去データが混ざっている）呼び出し側に漏らさない。
 */
export function filterForecastWindow(points: TidePoint[], nowMs: number): TidePoint[] {
  const endMs = nowMs + FORECAST_WINDOW_MS
  return points
    .filter((p) => {
      if (typeof p?.time !== 'string' || !Number.isFinite(p.tide_m_tp)) return false
      const t = timeValue(p.time)
      return Number.isFinite(t) && t >= nowMs && t <= endMs
    })
    .sort((a, b) => timeValue(a.time) - timeValue(b.time))
}

/**
 * Worker の応答 JSON を検証し、`TideSeries` に正規化する。
 * 空データ・不正な形式・7 日に満たないデータ（0〜1 点まで絞られた場合）は
 * `ok: false` を返す。呼び出し側（main.ts）はこれを「更新失敗」として扱い、
 * 直前に成功していたデータをそのまま使い続ける。
 */
export function parseTideForecastResponse(json: unknown, nowMs: number): TideForecastParseResult {
  if (!json || typeof json !== 'object') return { ok: false, error: '不正な応答形式です' }
  const r = json as Partial<TideForecastApiResponse>
  if (r.ok !== true) {
    return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : '潮位予測の取得に失敗しました' }
  }
  const series = r.series
  if (!series || !Array.isArray(series.points) || series.kind !== 'computed') {
    return { ok: false, error: '潮位予測データの形式が不正です' }
  }

  const points = filterForecastWindow(series.points, nowMs)
  if (points.length < MIN_POINTS) {
    return { ok: false, error: '対象期間（現在〜7日後）の潮位予測データがありません' }
  }

  let peak = points[0]
  for (const p of points) if (p.tide_m_tp > peak.tide_m_tp) peak = p

  const normalized: TideSeries = {
    id: series.id || 'forecast-maizuru',
    label: series.label || '気象庁 潮位予測（舞鶴・7日間）',
    kind: 'computed',
    points,
    peak_time: peak.time,
    peak_value_m_tp: peak.tide_m_tp,
  }

  return {
    ok: true,
    value: {
      series: normalized,
      retrievedAt: typeof r.retrieved_at === 'string' ? r.retrieved_at : new Date(nowMs).toISOString(),
      sourceLabel: typeof r.source_label === 'string' && r.source_label ? r.source_label : '気象庁',
      warning: typeof r.warning === 'string' ? r.warning : undefined,
    },
  }
}

// ---- 更新ボタンの状態 -----------------------------------------------------
//
// 「更新中・成功・失敗」を出すための小さな状態機械。**失敗しても
// `series` / `retrievedAt` は直前の成功結果のまま残す**（潮位パネルの既存
// データを消さない、という仕様の核心）。DOM にもネットワークにも触れない
// 純粋関数にしてあるので、ここだけを単体テストできる。

export type TideForecastStatus = 'idle' | 'loading' | 'success' | 'error'

export interface TideForecastState {
  status: TideForecastStatus
  series?: TideSeries
  retrievedAt?: string
  sourceLabel?: string
  warning?: string
  error?: string
}

export function initialTideForecastState(): TideForecastState {
  return { status: 'idle' }
}

export function startTideForecastFetch(state: TideForecastState): TideForecastState {
  return { ...state, status: 'loading', error: undefined }
}

export function succeedTideForecastFetch(
  state: TideForecastState, parsed: TideForecastParsed,
): TideForecastState {
  return {
    status: 'success',
    series: parsed.series,
    retrievedAt: parsed.retrievedAt,
    sourceLabel: parsed.sourceLabel,
    warning: parsed.warning,
    error: undefined,
  }
}

/** 直前の `series` / `retrievedAt` / `sourceLabel` はそのまま残す（消さない） */
export function failTideForecastFetch(state: TideForecastState, error: string): TideForecastState {
  return { ...state, status: 'error', error }
}
