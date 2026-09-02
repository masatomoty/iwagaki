// 舞鶴（気象庁 MZ）潮位予測 Worker（deploy/worker.js）の純粋関数のテスト。
// 固定長テキストの解析・T.P. 換算・7 日フィルタリングを、実際に気象庁から
// 取得した行（2026-09-03 に https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/
// txt/2026/MZ.txt から確認）を使って検証する。
//
//   pnpm test

import assert from 'node:assert/strict'
import {
  buildMaizuruForecastSeries, parseSuisanLine, parseSuisanText,
  tideTableCmToTpMeters, TP_OF_TIDE_TABLE_DATUM_M,
} from '../deploy/worker.js'

// --- T.P. 換算 ------------------------------------------------------------
//
// docs/data.md §4 / src/iwagaki/config.py と同じ値であることを確認する
// （潮位表基準面の標高 -0.066 m T.P.(2024) を、測地成果2011→2024 の
// 補正 -0.19031 m だけ引き戻した値。地形と同じ測地成果2011 基準に揃える）
assert.ok(Math.abs(TP_OF_TIDE_TABLE_DATUM_M - 0.12431) < 1e-9,
  `TP_OF_TIDE_TABLE_DATUM_M が docs/data.md の値と食い違う: ${TP_OF_TIDE_TABLE_DATUM_M}`)
assert.ok(Math.abs(tideTableCmToTpMeters(0) - 0.12431) < 1e-9)
assert.ok(Math.abs(tideTableCmToTpMeters(100) - 1.12431) < 1e-9)
console.log('ok tideTableCmToTpMeters は docs/data.md §4 の換算式と一致する')

// --- 固定長行の解析 ---------------------------------------------------------
//
// 2026-09-03 に実機で取得した舞鶴（MZ）2026 年 1 月 1 日の行そのもの
const RAW_LINE_1 = ' 24 20 15  9  3 -1 -4 -5 -4  1  6 12 16 19 20 21 20 20 20 21 22 24 27 2926 1 1MZ1450 212324 2999999999999999 652 -51742 2099999999999999'
{
  const rec = parseSuisanLine(RAW_LINE_1, 2026)
  assert.ok(rec, '実データの行が解析できない')
  assert.deepEqual(rec.hourlyCm.slice(0, 5), [24, 20, 15, 9, 3])
  assert.equal(rec.hourlyCm.length, 24)
  assert.equal(rec.year, 2026)
  assert.equal(rec.month, 1)
  assert.equal(rec.day, 1)
  console.log('ok parseSuisanLine は気象庁の固定長フォーマット（136 カラム）を解ける')
}

// 埋め込み年が取得元の年と食い違う行は壊れているとみなして捨てる
assert.equal(parseSuisanLine(RAW_LINE_1, 2027), null)
// 短すぎる・非数値・局記号違いも捨てる
assert.equal(parseSuisanLine('too short', 2026), null)
assert.equal(parseSuisanLine('X'.repeat(90), 2026), null)
assert.equal(parseSuisanLine(RAW_LINE_1.slice(0, 78) + 'XX' + RAW_LINE_1.slice(80), 2026), null)
console.log('ok parseSuisanLine は壊れた行・局違いの行を null で捨てる')

{
  const text = `${RAW_LINE_1}\nnot a valid line\n${RAW_LINE_1}`
  const records = parseSuisanText(text, 2026)
  assert.equal(records.length, 2, '壊れた行を挟んでも他の行は解析できる')
}
assert.deepEqual(parseSuisanText('', 2026), [])
console.log('ok parseSuisanText は空データ・不正データを例外なく捨てる')

// --- 7 日間フィルタリング / JST の扱い -------------------------------------
function dayRecord(year, month, day, cm = 0) {
  return { year, month, day, hourlyCm: Array(24).fill(cm) }
}

{
  // 1/1 00:00 JST を「いま」とする。1/1〜1/8 の 24*7+1 点が範囲に入るはず
  // （境界は now と now+7日 を両端含む）
  const records = Array.from({ length: 10 }, (_, i) => dayRecord(2026, 1, i + 1, i))
  const nowMs = Date.UTC(2025, 11, 31, 15, 0, 0)   // 2026-01-01 00:00 JST
  const built = buildMaizuruForecastSeries(records, nowMs)
  assert.equal(built.ok, true)
  assert.equal(built.warning, undefined)
  assert.equal(built.series.points.length, 24 * 7 + 1)
  assert.equal(built.series.points[0].time, '2026-01-01T00:00:00+09:00')
  assert.equal(built.series.points.at(-1).time, '2026-01-08T00:00:00+09:00')
  // 現在時刻より前（12/31 のデータは元々渡していないが、境界の 1/1 00:00 は含まれる）
  assert.ok(built.series.points.every((p) => new Date(p.time).getTime() >= nowMs))
  console.log('ok buildMaizuruForecastSeries は現在時刻〜7日後・JST で正しく絞り込む')
}

{
  // 過去日を混ぜても除外される（「現在時刻以前のデータを除外」の確認）
  const records = [dayRecord(2025, 12, 30), dayRecord(2025, 12, 31),
    ...Array.from({ length: 8 }, (_, i) => dayRecord(2026, 1, i + 1))]
  const nowMs = Date.UTC(2025, 11, 31, 15, 0, 0)   // 2026-01-01 00:00 JST
  const built = buildMaizuruForecastSeries(records, nowMs)
  assert.equal(built.ok, true)
  assert.ok(built.series.points.every((p) => new Date(p.time).getTime() >= nowMs),
    '現在時刻より前の点が残ってしまっている')
  console.log('ok buildMaizuruForecastSeries は現在時刻以前のデータを除外する')
}

{
  // JST の日付境界をまたぐケース:「いま」が 2026-06-09 23:30 JST（= UTC 14:30）
  // だと、当日 06-09 の毎時点（0〜23 時、すべて 23:30 より前）は 1 つも
  // 残らず、次に来るのは翌日 06-10 の 00:00 JST のはず
  // （`domain/tideSeries.ts` の `formatJst` と同じ JST 固定の規約で検証する）
  const records = Array.from({ length: 9 }, (_, i) => dayRecord(2026, 6, 9 + i))
  const nowMs = Date.UTC(2026, 5, 9, 14, 30, 0)   // 2026-06-09 23:30 JST
  const built = buildMaizuruForecastSeries(records, nowMs)
  assert.equal(built.ok, true)
  const day9 = built.series.points.filter((p) => p.time.startsWith('2026-06-09'))
  assert.deepEqual(day9, [], '23:30 JST より前の当日の毎時点は残らないはず')
  assert.equal(built.series.points[0].time, '2026-06-10T00:00:00+09:00')
  console.log('ok buildMaizuruForecastSeries は JST の日境界をまたいでも正しい')
}

// --- TideSeries への変換 ----------------------------------------------------
{
  const records = Array.from({ length: 8 }, (_, i) => dayRecord(2026, 1, i + 1,
    i === 3 ? 100 : 0))   // 1/4 だけ潮位を高くしてピークにする
  const nowMs = Date.UTC(2025, 11, 31, 15, 0, 0)
  const built = buildMaizuruForecastSeries(records, nowMs)
  assert.equal(built.ok, true)
  const s = built.series
  assert.equal(s.id, 'forecast-maizuru')
  assert.equal(s.kind, 'computed')
  assert.equal(typeof s.label, 'string')
  assert.ok(s.points.every((p) => typeof p.time === 'string' && Number.isFinite(p.tide_m_tp)))
  assert.equal(s.peak_value_m_tp, Math.max(...s.points.map((p) => p.tide_m_tp)))
  assert.ok(s.points.some((p) => p.time === s.peak_time))
  console.log('ok buildMaizuruForecastSeries は TideSeries 形式（id/label/kind/points/peak_*）を満たす')
}

// --- 空データ・7 日未満データ -----------------------------------------------
{
  const built = buildMaizuruForecastSeries([], Date.now())
  assert.equal(built.ok, false)
  assert.equal(typeof built.error, 'string')
  console.log('ok buildMaizuruForecastSeries は空データをエラーにする（無理に補間しない）')
}

{
  // 2 日ぶんしか無い（7 日に遠く満たない）→ エラーにはしないが警告を付ける
  const records = [dayRecord(2026, 1, 1), dayRecord(2026, 1, 2)]
  const nowMs = Date.UTC(2025, 11, 31, 15, 0, 0)
  const built = buildMaizuruForecastSeries(records, nowMs)
  assert.equal(built.ok, true)
  assert.equal(typeof built.warning, 'string', '7 日に満たないのに警告が無い')
  assert.ok(built.series.points.length > 0, '取れた分は返す（無理な補間はしない＝取れた分だけ）')
  console.log('ok buildMaizuruForecastSeries は7日未満データを警告付きで返す（補間しない）')
}
