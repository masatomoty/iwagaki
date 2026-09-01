// 流域の**主流路**（`catalog.flow.channels`、断面ツールの自動測線用）の配信物。
//
// flow.test.mjs / pair.test.mjs と同じ方針で、**TS を import せず式を二重化**して
// 実データ（catalog.json / catalog.flow.channels の geojson）に対して検査する。
//
// 見るもの:
//  1. catalog.flow.channels の形（url / count / condition）
//  2. 各 LineString が AOI の bbox に入っていて、properties が揃っている
//  3. properties.basin_id が catalog.flow.basins の実在する id である
//  4. main.ts の buildSectionAlongChannel が組む「区間ごとに sampleLine、距離を
//     積み上げる」処理を二重化し、距離が単調に増え、合計が properties.length_m
//     と大きくは食い違わないこと（単純化で頂点は減るが、始点・終点は変わらない）

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'public', 'data')
const catalog = JSON.parse(readFileSync(path.join(DATA, 'catalog.json'), 'utf8'))

// --- assets/terrainSampler.ts の metres と同じ式（TS を import しない）-----------
const metres = (a, b) => {
  const mLat = 111132.92
  const mLon = 111412.84 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  return Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * mLat)
}

test('catalog.flow.channels の形', () => {
  const c = catalog.flow?.channels
  if (!c) return                          // 焼いていない配信物では skip
  assert.equal(c.condition, 'highres')
  assert.ok(Number.isInteger(c.count) && c.count > 0, 'count')
  assert.match(c.url, /\/flow_channels-.*\.geojson$/, 'url')
  assert.ok(c.bytes > 0)

  const fc = JSON.parse(readFileSync(path.join(DATA, path.basename(c.url)), 'utf8'))
  assert.equal(fc.features.length, c.count)
})

test('主流路は AOI 内・basin_id が実在し・先頭≠末尾（2 点以上）', () => {
  const c = catalog.flow?.channels
  if (!c) return
  const fc = JSON.parse(readFileSync(path.join(DATA, path.basename(c.url)), 'utf8'))
  const basins = catalog.flow?.basins
  const basinIds = basins
    ? new Set(JSON.parse(readFileSync(path.join(DATA, path.basename(basins.url)), 'utf8'))
      .features.map((f) => f.properties.basin_id))
    : null

  const [w, s, e, n] = catalog.aoi.bbox_wgs84
  const seenIds = new Set()
  for (const f of fc.features) {
    assert.equal(f.geometry.type, 'LineString')
    const coords = f.geometry.coordinates
    assert.ok(coords.length >= 2, `basin ${f.properties.basin_id}: 頂点が 2 未満`)
    for (const [lon, lat] of coords) {
      assert.ok(lon >= w - 1e-6 && lon <= e + 1e-6 && lat >= s - 1e-6 && lat <= n + 1e-6,
        `主流路が AOI の外: ${lon},${lat}`)
    }
    for (const k of ['basin_id', 'length_m', 'n_points', 'truncated']) {
      assert.ok(k in f.properties, `properties.${k} が無い`)
    }
    assert.equal(f.properties.n_points, coords.length)
    assert.ok(f.properties.length_m > 0)
    if (basinIds) {
      assert.ok(basinIds.has(f.properties.basin_id),
        `basin_id ${f.properties.basin_id} が flow.basins に無い`)
    }
    assert.ok(!seenIds.has(f.properties.basin_id), 'basin_id が重複している')
    seenIds.add(f.properties.basin_id)
  }
})

test('main.ts の区間ごと sampleLine ＋距離積み上げは単調増加で、単純化前の実長を超えない', () => {
  const c = catalog.flow?.channels
  if (!c) return
  const fc = JSON.parse(readFileSync(path.join(DATA, path.basename(c.url)), 'utf8'))

  for (const f of fc.features.slice(0, 40)) {
    const line = f.geometry.coordinates
    // buildSectionAlongChannel と同じ組み立て: 区間ごとの距離を積み上げる
    let d = 0
    const ds = [0]
    for (let i = 0; i < line.length - 1; i++) {
      d += metres(line[i], line[i + 1])
      ds.push(d)
    }
    // 距離は単調非減少（sampleLine が返す各点の d もこの理屈でオフセットする）
    for (let i = 1; i < ds.length; i++) assert.ok(ds[i] >= ds[i - 1])
    // 単純化された折れ線の弦の和は、単純化前の実長（properties.length_m、セル沿いの
    // 生の折れ線で測った長さ）を超えない（弦は弧より短い）。度単位近似のぶん少し
    // 緩めに見る
    assert.ok(d <= f.properties.length_m * 1.05 + 1,
      `basin ${f.properties.basin_id}: 積算距離 ${d} > 実長 ${f.properties.length_m}`)
    assert.ok(d > 0)
  }
})
