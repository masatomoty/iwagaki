// 「地域別の浸水建物」ダウンロード（`domain/download.ts`、discussion.md 5.3）。
// src の TS を Node の型除去でそのまま読む（`waterLevel.test.mjs` と同じ）。
//
//   node --test test/download.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  areaFloodFileBase, areaFloodToCsv, areaFloodToGeoJson,
} from '../src/domain/download.ts'

const ctx = {
  waterLevelMTp: 0.93, floodModel: 'connected', condition: 'highres', floorAboveDepthM: 0.5,
}

const rows = [
  { areaCode: 'A001', areaName: '旧舞鶴東吉原一', total: 134, under: 15, above: 113,
    flooded: 128, floodRate: 128 / 134 },
  { areaCode: 'A002', areaName: '旧舞鶴東吉原二', total: 40, under: 2, above: 0,
    flooded: 2, floodRate: 0.05 },
  { areaCode: undefined, areaName: '(小地域外)', total: 6, under: 1, above: 1,
    flooded: 2, floodRate: 2 / 6 },
]

function parseCsv(csv) {
  const lines = csv.trim().split('\r\n')
  const header = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    return Object.fromEntries(header.map((k, i) => [k, cells[i]]))
  })
}

test('areaFloodToCsv: 表と同じ行・同じ数字を書き出す（(小地域外) を含む）', () => {
  const csv = areaFloodToCsv(rows, ctx)
  const parsed = parseCsv(csv)
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].area_code, 'A001')
  assert.equal(parsed[0].total_bldg, '134')
  assert.equal(parsed[0].flooded_bldg, '128')
  assert.equal(parsed[0].floor_above_bldg, '113')
  assert.equal(parsed[0].floor_under_bldg, '15')
  assert.equal(parsed[2].area_code, '(小地域外)')
})

test('areaFloodToCsv: 集計条件（潮位・モデル・条件）を全行に埋め込む', () => {
  const parsed = parseCsv(areaFloodToCsv(rows, ctx))
  for (const row of parsed) {
    assert.equal(row.target_tide_m_tp, '0.93')
    assert.equal(row.flood_model, 'connected')
    assert.equal(row.terrain_condition, 'highres')
  }
})

test('areaFloodToCsv: カンマ・改行を含む地域名は引用符で包む', () => {
  const csv = areaFloodToCsv(
    [{ areaCode: 'A003', areaName: '例, 名前', total: 1, under: 0, above: 1,
      flooded: 1, floodRate: 1 }], ctx)
  assert.match(csv, /"例, 名前"/)
})

test('areaFloodFileBase: 潮位・モデル・条件をファイル名に埋め込む', () => {
  assert.equal(areaFloodFileBase(ctx), 'area_flood_H0.93_connected_highres')
})

const smallAreas = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
      properties: { area_code: 'A001', area_name: '旧舞鶴東吉原一', total_bldg: 134 } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[1, 1]]] },
      properties: { area_code: 'A002', area_name: '旧舞鶴東吉原二', total_bldg: 40 } },
    // 表に無い小地域（境界データの版差）は features から落ちる
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[2, 2]]] },
      properties: { area_code: 'A999', area_name: 'よそ', total_bldg: 1 } },
  ],
}

test('areaFloodToGeoJson: area_code でポリゴンと突き合わせる', () => {
  const fc = areaFloodToGeoJson(rows, smallAreas, ctx)
  assert.equal(fc.features.length, 2)
  const a001 = fc.features.find((f) => f.properties.area_code === 'A001')
  assert.equal(a001.properties.total_bldg, 134)
  assert.equal(a001.properties.flooded_bldg, 128)
  assert.deepEqual(a001.geometry, smallAreas.features[0].geometry)
})

test('areaFloodToGeoJson: ポリゴンを持たない (小地域外) は features に出さず metadata へ', () => {
  const fc = areaFloodToGeoJson(rows, smallAreas, ctx)
  assert.equal(fc.features.some((f) => f.properties.area_code === undefined), false)
  assert.deepEqual(fc.metadata.outside_small_area,
    { total_bldg: 6, flooded_bldg: 2, floor_above_bldg: 1, floor_under_bldg: 1 })
})

test('areaFloodToGeoJson: metadata に集計条件を持つ', () => {
  const fc = areaFloodToGeoJson(rows, smallAreas, ctx)
  assert.equal(fc.metadata.target_tide_m_tp, 0.93)
  assert.equal(fc.metadata.flood_model, 'connected')
  assert.equal(fc.metadata.terrain_condition, 'highres')
  assert.match(fc.metadata.value_kind, /モデル由来/)
})

test('areaFloodToGeoJson: (小地域外) が 0 棟なら metadata.outside_small_area を出さない', () => {
  const rowsZeroOutside = rows.map((r) => (r.areaCode === undefined
    ? { ...r, total: 0, under: 0, above: 0, flooded: 0, floodRate: 0 } : r))
  const fc = areaFloodToGeoJson(rowsZeroOutside, smallAreas, ctx)
  assert.equal(fc.metadata.outside_small_area, undefined)
})
