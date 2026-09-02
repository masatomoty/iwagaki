// src/domain/tideForecast.ts のテスト。Worker（deploy/worker.js）の応答を
// TideSeries に正規化する層と、更新ボタンの状態機械（失敗時に既存データを
// 維持すること）を、ネットワーク・DOM 抜きの純粋関数として検証する。
//
//   pnpm test

import assert from 'node:assert/strict'
import {
  failTideForecastFetch, filterForecastWindow, initialTideForecastState,
  parseTideForecastResponse, startTideForecastFetch, succeedTideForecastFetch,
} from '../src/domain/tideForecast.ts'

const NOW = Date.UTC(2026, 8, 3, 3, 0, 0)   // 2026-09-03 12:00 JST
const DAY_MS = 24 * 3600 * 1000

function point(offsetHours, v = 0.1) {
  const t = new Date(NOW + offsetHours * 3600 * 1000).toISOString()
  return { time: t, tide_m_tp: v }
}

function fullWeekResponse(overrides = {}) {
  const points = Array.from({ length: 7 * 24 + 1 }, (_, i) => point(i, 0.1 + (i % 5) * 0.05))
  return {
    ok: true,
    retrieved_at: new Date(NOW).toISOString(),
    source_label: '気象庁 潮位表（潮汐推算）',
    series: {
      id: 'forecast-maizuru', label: '気象庁 潮位予測（舞鶴・7日間）', kind: 'computed',
      points, peak_time: points[0].time, peak_value_m_tp: 0.1,
    },
    ...overrides,
  }
}

// --- 7 日間フィルタリング / JST -------------------------------------------
{
  const points = [
    { time: new Date(NOW - 3600 * 1000).toISOString(), tide_m_tp: 0.1 },   // 過去 → 除外
    { time: new Date(NOW).toISOString(), tide_m_tp: 0.2 },                 // 境界 → 含む
    { time: new Date(NOW + 3 * DAY_MS).toISOString(), tide_m_tp: 0.3 },
    { time: new Date(NOW + 7 * DAY_MS).toISOString(), tide_m_tp: 0.4 },    // 境界 → 含む
    { time: new Date(NOW + 7 * DAY_MS + 3600 * 1000).toISOString(), tide_m_tp: 0.5 }, // 超過 → 除外
  ]
  const filtered = filterForecastWindow(points, NOW)
  assert.equal(filtered.length, 3)
  assert.equal(filtered[0].tide_m_tp, 0.2)
  assert.equal(filtered.at(-1).tide_m_tp, 0.4)
  console.log('ok filterForecastWindow は現在〜7日後の範囲だけを残す（境界は両端含む）')
}
{
  // 逆順・不正時刻混じりでも時刻順に並び替え、不正な点は落とす
  const points = [
    { time: new Date(NOW + 2 * DAY_MS).toISOString(), tide_m_tp: 0.3 },
    { time: 'not-a-date', tide_m_tp: 0.9 },
    { time: new Date(NOW + 1 * DAY_MS).toISOString(), tide_m_tp: 0.2 },
    { time: new Date(NOW).toISOString(), tide_m_tp: NaN },
  ]
  const filtered = filterForecastWindow(points, NOW)
  assert.deepEqual(filtered.map((p) => p.tide_m_tp), [0.2, 0.3])
  console.log('ok filterForecastWindow は不正な time/tide_m_tp を捨て、時刻順に並べ替える')
}

// --- TideSeries への変換（正常系） ------------------------------------------
{
  const result = parseTideForecastResponse(fullWeekResponse(), NOW)
  assert.equal(result.ok, true)
  const { series, retrievedAt, sourceLabel } = result.value
  assert.equal(series.kind, 'computed')
  assert.equal(series.id, 'forecast-maizuru')
  assert.ok(series.points.length >= 2)
  assert.equal(typeof retrievedAt, 'string')
  assert.equal(sourceLabel, '気象庁 潮位表（潮汐推算）')
  assert.equal(series.peak_value_m_tp, Math.max(...series.points.map((p) => p.tide_m_tp)))
  console.log('ok parseTideForecastResponse は正常な応答を TideSeries に変換する')
}

// --- 空データ・不正データ・7日未満データ ------------------------------------
{
  const r = parseTideForecastResponse(null, NOW)
  assert.equal(r.ok, false)
}
{
  const r = parseTideForecastResponse({ ok: false, error: '502' }, NOW)
  assert.equal(r.ok, false)
  assert.equal(r.error, '502')
}
{
  // series が無い / points が配列でない
  const r1 = parseTideForecastResponse({ ok: true }, NOW)
  assert.equal(r1.ok, false)
  const r2 = parseTideForecastResponse({ ok: true, series: { kind: 'computed', points: 'x' } }, NOW)
  assert.equal(r2.ok, false)
}
{
  // kind が computed でない（観測データを予測 API 経由で誤って返した想定）
  const bad = fullWeekResponse()
  bad.series.kind = 'observed'
  const r = parseTideForecastResponse(bad, NOW)
  assert.equal(r.ok, false)
}
{
  // 空の points
  const empty = fullWeekResponse({ series: { id: 'x', label: 'x', kind: 'computed', points: [] } })
  const r = parseTideForecastResponse(empty, NOW)
  assert.equal(r.ok, false)
}
{
  // 7 日に遠く満たない（フィルタ後 1 点以下）→ エラー扱い
  const short = fullWeekResponse({
    series: {
      id: 'forecast-maizuru', label: 'x', kind: 'computed',
      points: [point(0)], peak_time: point(0).time, peak_value_m_tp: 0.1,
    },
  })
  const r = parseTideForecastResponse(short, NOW)
  assert.equal(r.ok, false)
}
console.log('ok parseTideForecastResponse は空・不正・種別違い・データ不足を ok:false にする')

// --- 更新失敗時に既存データを維持すること -----------------------------------
{
  let state = initialTideForecastState()
  assert.equal(state.status, 'idle')

  state = startTideForecastFetch(state)
  assert.equal(state.status, 'loading')

  const ok = parseTideForecastResponse(fullWeekResponse(), NOW)
  assert.equal(ok.ok, true)
  state = succeedTideForecastFetch(state, ok.value)
  assert.equal(state.status, 'success')
  assert.ok(state.series)
  const seriesAfterSuccess = state.series
  const retrievedAtAfterSuccess = state.retrievedAt

  // 次の更新が失敗しても、直前の series / retrievedAt はそのまま残る
  state = startTideForecastFetch(state)
  state = failTideForecastFetch(state, 'ネットワークエラー')
  assert.equal(state.status, 'error')
  assert.equal(state.error, 'ネットワークエラー')
  assert.equal(state.series, seriesAfterSuccess, '失敗で既存の series が消えている')
  assert.equal(state.retrievedAt, retrievedAtAfterSuccess, '失敗で既存の retrievedAt が消えている')
  console.log('ok 更新失敗時も直前の series / retrievedAt を維持する')
}
{
  // 一度も成功していない状態で失敗しても、単に error 状態になる（series は無いまま）
  let state = initialTideForecastState()
  state = startTideForecastFetch(state)
  state = failTideForecastFetch(state, '取得失敗')
  assert.equal(state.status, 'error')
  assert.equal(state.series, undefined)
  console.log('ok 初回から失敗した場合は series 無しの error 状態になる')
}
