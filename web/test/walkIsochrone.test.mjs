// domain/walkIsochrone.ts の読み方を、`scripts/94_walk_isochrone.py` が書く形の
// GeoJSON（EPSG:4326、`network_isochrone` / `simple_buffer` の 2 面）で確かめる。
//
// camera.test.mjs と同じ方針で、tsc で対象ファイルだけ JS にしてから import する
// （domain 層は three / maplibre / deck.gl を import しない純関数なので単体で通る）。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const out = mkdtempSync(path.join(tmpdir(), 'iwagaki-walkiso-'))
execFileSync('pnpm', ['exec', 'tsc', 'src/domain/walkIsochrone.ts', '--outDir', out,
                     '--module', 'es2022', '--target', 'es2022',
                     '--moduleResolution', 'bundler', '--skipLibCheck'],
             { stdio: 'inherit' })
writeFileSync(path.join(out, 'package.json'), '{"type":"module"}')
const wi = await import(path.join(out, 'walkIsochrone.js'))

const NOT_OFFICIAL = 'PLATEAU の車道中心線ベース。公式の歩行者網ではない'
  + '（一方通行・歩道橋・地下道・私道・歩車分離を区別しない）。妥当性は未検証'
const AOI_ONLY = 'AOI 内でのみ有効。道路グラフの端で等時線も切れる'

const COMMON = {
  aoi: 'higashi_maizuru',
  aoi_label: '東舞鶴',
  origin_lon: 135.39,
  origin_lat: 35.4753,
  minutes: 10,
  walk_speed_m_per_min: 80,
  reach_distance_m: 800,
  not_official_pedestrian_network: NOT_OFFICIAL,
  valid_in_aoi_only: AOI_ONLY,
}

const SQUARE = [[
  [135.385, 35.470], [135.395, 35.470], [135.395, 35.480], [135.385, 35.480], [135.385, 35.470],
]]

/** `scripts/94` の `build()` が inside_aoi かつ道路が近くにあるとき返す形 */
const OK_FC = {
  type: 'FeatureCollection',
  metadata: {
    ...COMMON,
    model: '多始点 Dijkstra（道路面ポリゴンの隣接グラフ）',
    network_over_buffer_ratio: 0.21,
    graph_components: 3,
    network_fragmentation_note: '道路グラフは 3 連結成分（最大成分が全ノードの 92%）',
  },
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: SQUARE },
      properties: { layer: 'network_isochrone', status: 'ok', reached_node_count: 240, area_m2: 168000, snap_distance_m: 12.3 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: SQUARE },
      properties: { layer: 'simple_buffer', status: 'ok', radius_m: 800, area_m2: 2010000 },
    },
  ],
}

/** 起点が AOI 外のとき（両方 null） */
const OUTSIDE_FC = {
  type: 'FeatureCollection',
  metadata: { ...COMMON, origin_lon: 200, origin_lat: 35 },
  features: [
    { type: 'Feature', geometry: null, properties: { layer: 'network_isochrone', status: 'outside_aoi' } },
    { type: 'Feature', geometry: null, properties: { layer: 'simple_buffer', status: 'outside_aoi' } },
  ],
}

/** 起点付近に道路が無いとき（ネットワーク側だけ null、バッファは常に出る） */
const NO_ROAD_FC = {
  type: 'FeatureCollection',
  metadata: { ...COMMON },
  features: [
    { type: 'Feature', geometry: null, properties: { layer: 'network_isochrone', status: 'no_nearby_road' } },
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: SQUARE },
      properties: { layer: 'simple_buffer', status: 'ok', radius_m: 800, area_m2: 2010000 },
    },
  ],
}

test('pickWalkIsochroneLayer はレイヤ名で feature を引ける', () => {
  const net = wi.pickWalkIsochroneLayer(OK_FC, 'network_isochrone')
  const buf = wi.pickWalkIsochroneLayer(OK_FC, 'simple_buffer')
  assert.equal(net?.properties.status, 'ok')
  assert.equal(buf?.properties.radius_m, 800)
  assert.equal(wi.pickWalkIsochroneLayer(OUTSIDE_FC, 'network_isochrone')?.properties.status, 'outside_aoi')
})

test('hasReachablePolygon は geometry と status の両方を見る', () => {
  assert.ok(wi.hasReachablePolygon(wi.pickWalkIsochroneLayer(OK_FC, 'network_isochrone')))
  assert.ok(wi.hasReachablePolygon(wi.pickWalkIsochroneLayer(OK_FC, 'simple_buffer')))
  assert.ok(!wi.hasReachablePolygon(wi.pickWalkIsochroneLayer(OUTSIDE_FC, 'network_isochrone')))
  assert.ok(!wi.hasReachablePolygon(wi.pickWalkIsochroneLayer(OUTSIDE_FC, 'simple_buffer')))
  assert.ok(!wi.hasReachablePolygon(undefined))
  // 起点付近に道路が無くても単純バッファは出る（ネットワークだけ落ちる）
  assert.ok(!wi.hasReachablePolygon(wi.pickWalkIsochroneLayer(NO_ROAD_FC, 'network_isochrone')))
  assert.ok(wi.hasReachablePolygon(wi.pickWalkIsochroneLayer(NO_ROAD_FC, 'simple_buffer')))
})

test('walkIsochroneInfo は起点・所要時間・注意書きを UI 向けに集約する', () => {
  const info = wi.walkIsochroneInfo(OK_FC)
  assert.equal(info.aoi, 'higashi_maizuru')
  assert.equal(info.aoiLabel, '東舞鶴')
  assert.equal(info.originLon, 135.39)
  assert.equal(info.originLat, 35.4753)
  assert.equal(info.minutes, 10)
  assert.equal(info.reachDistanceM, 800)
  // 「公式歩行者網ではない」旨は 3D に焼かず、ここから文字列として引ける
  assert.match(info.notOfficialNote, /公式の歩行者網ではない/)
  assert.match(info.aoiOnlyNote, /AOI 内でのみ有効/)
  assert.equal(info.networkStatus, 'ok')
  assert.equal(info.networkAreaM2, 168000)
  assert.equal(info.bufferAreaM2, 2010000)
  assert.equal(info.networkOverBufferRatio, 0.21)
  // ネットワークは単純バッファより明確に小さい（実測: 東舞鶴で比 ≈ 0.2）
  assert.ok(info.networkAreaM2 < info.bufferAreaM2)
})

test('walkIsochroneInfo は起点が AOI 外でも例外を投げない', () => {
  const info = wi.walkIsochroneInfo(OUTSIDE_FC)
  assert.equal(info.networkStatus, 'outside_aoi')
  assert.equal(info.networkAreaM2, undefined)
  assert.equal(info.bufferAreaM2, undefined)
})

test('walkIsochroneInfo は道路が無い起点でもバッファの面積は拾う', () => {
  const info = wi.walkIsochroneInfo(NO_ROAD_FC)
  assert.equal(info.networkStatus, 'no_nearby_road')
  assert.equal(info.networkAreaM2, undefined)
  assert.equal(info.bufferAreaM2, 2010000)
})
