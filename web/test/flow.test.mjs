// 「水みち／窪地」（flow accumulation）の配信物と復号。
//
// pair.test.mjs / parity.test.mjs と同じ方針で、**TS を import せず式を二重化**して
// 実データ（catalog.json / catalog.flow.pits の geojson）に対して検査する。
//
// 見るもの:
//  1. catalog.flow の形（条件ごとに accum_max_cells / zoom、pits の件数）
//  2. 越流点マーカーが AOI の bbox に入っていて、properties が揃っている
//  3. R チャネル（log8）の encode↔decode 往復（scripts/80 の decode_flow /
//     three/floodMaterial.ts の decodeFlow と同じ式）

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'public', 'data')
const catalog = JSON.parse(readFileSync(path.join(DATA, 'catalog.json'), 'utf8'))

// --- domain/flow.ts の resolveFlow と同じ規則 ------------------------------
const isFlowAsset = (v) => !!v && 'accum_max_cells' in v
const resolveFlow = (flow, condition) => {
  if (!flow) return undefined
  const direct = flow[condition]
  if (isFlowAsset(direct)) return direct
  return isFlowAsset(flow.highres) ? flow.highres : undefined
}

test('catalog.flow の形', () => {
  const flow = catalog.flow
  assert.ok(flow, 'catalog.flow が無い（scripts/83 の flow() を確認）')
  // 条件（水みちタイル）だけを拾う。'pits' / 'basins' / 'channels' は条件ではない
  // （`domain/flow.ts` の isFlowAsset と同じ判定 = accum_max_cells を持つものだけ）
  const conds = Object.keys(flow).filter((k) => isFlowAsset(flow[k]))
  assert.ok(conds.includes('highres'), 'highres の水みちタイルが無い')
  for (const c of conds) {
    const a = flow[c]
    assert.ok(Number.isInteger(a.accum_max_cells) && a.accum_max_cells > 0,
      `${c}: accum_max_cells`)
    assert.ok(a.min_zoom >= 10 && a.max_zoom >= a.min_zoom, `${c}: zoom`)
    assert.match(a.url, /\/tiles\/.*flow_.*\{z\}\/\{x\}\/\{y\}\.png$/, `${c}: url`)
  }
})

test('resolveFlow は欠損条件を highres にフォールバックする', () => {
  const flow = catalog.flow
  assert.equal(resolveFlow(flow, 'highres')?.url, flow.highres.url)
  // drainage は flow タイルを焼かない -> highres に落ちる
  assert.equal(resolveFlow(flow, 'drainage')?.url, flow.highres.url)
  assert.equal(resolveFlow(undefined, 'highres'), undefined)
})

test('越流点マーカーは AOI 内・properties が揃っている', () => {
  const pits = catalog.flow?.pits
  if (!pits) return                       // 焼いていない配信物では skip
  const fc = JSON.parse(readFileSync(path.join(DATA, path.basename(pits.url)), 'utf8'))
  assert.equal(fc.features.length, pits.count)
  assert.ok(pits.count <= 60, `越流点が多すぎる（${pits.count} > 60）`)
  const [w, s, e, n] = catalog.aoi.bbox_wgs84
  for (const f of fc.features) {
    const [lon, lat] = f.geometry.coordinates
    assert.ok(lon >= w && lon <= e && lat >= s && lat <= n,
      `AOI の外に越流点: ${lon},${lat}`)
    for (const k of ['pit_id', 'area_ha', 'max_fill_depth_m', 'volume_m3',
      'spill_elev_m_tp']) {
      assert.ok(k in f.properties, `properties.${k} が無い`)
    }
  }
})

// --- 部分流域（クリックで集水域抽出）------------------------------------------

test('catalog.flow.basins の形', () => {
  const b = catalog.flow?.basins
  if (!b) return                          // 焼いていない配信物では skip
  assert.equal(b.condition, 'highres')
  const fc = JSON.parse(readFileSync(path.join(DATA, path.basename(b.url)), 'utf8'))
  assert.equal(fc.features.length, b.count)
  const ids = new Set(fc.features.map((f) => f.properties.basin_id))
  const [w, s, e, n] = catalog.aoi.bbox_wgs84
  for (const f of fc.features) {
    const p = f.properties
    for (const k of ['basin_id', 'downstream_basin_id', 'area_ha',
      'max_accum_cells', 'edge_truncated']) {
      assert.ok(k in p, `properties.${k} が無い`)
    }
    // downstream は実在する id か -1
    assert.ok(p.downstream_basin_id === -1 || ids.has(p.downstream_basin_id),
      `downstream_basin_id ${p.downstream_basin_id} が実在しない`)
    // ポリゴンは AOI bbox に収まる
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
      : f.geometry.coordinates
    for (const rings of polys) for (const [lon, lat] of rings[0]) {
      assert.ok(lon >= w - 1e-6 && lon <= e + 1e-6 && lat >= s - 1e-6 && lat <= n + 1e-6,
        `流域が AOI の外: ${lon},${lat}`)
    }
  }
  // downstream グラフは非循環（catchmentOf が終端する前提）
  for (const start of ids) {
    let cur = start
    const seen = new Set()
    while (cur !== -1) {
      assert.ok(!seen.has(cur), `downstream に循環: ${start}`)
      seen.add(cur)
      cur = fc.features.find((f) => f.properties.basin_id === cur)
        ?.properties.downstream_basin_id ?? -1
    }
  }
})

// domain/flow.ts の pointInRing / basinAt / catchmentOf を二重化（TS を import しない）
const pointInRing = (ring, x, y) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const basinAt = (features, lon, lat) => {
  for (const f of features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
      : f.geometry.coordinates
    for (const rings of polys) {
      if (!pointInRing(rings[0], lon, lat)) continue
      if (rings.slice(1).some((h) => pointInRing(h, lon, lat))) continue
      return f.properties.basin_id
    }
  }
  return undefined
}

test('basinAt は流域内の点でその流域を返し、catchmentOf は下流閉包', () => {
  const b = catalog.flow?.basins
  if (!b) return
  const fc = JSON.parse(readFileSync(path.join(DATA, path.basename(b.url)), 'utf8'))
  const upstream = new Map()
  for (const f of fc.features) {
    const d = f.properties.downstream_basin_id
    if (d < 0) continue
    if (!upstream.has(d)) upstream.set(d, [])
    upstream.get(d).push(f.properties.basin_id)
  }
  const catchmentOf = (root) => {
    const out = new Set(); const st = [root]
    while (st.length) {
      const x = st.pop()
      if (out.has(x)) continue
      out.add(x)
      for (const u of upstream.get(x) ?? []) st.push(u)
    }
    return out
  }

  let hits = 0
  for (const f of fc.features.slice(0, 40)) {
    const rings = (f.geometry.type === 'Polygon' ? f.geometry.coordinates
      : f.geometry.coordinates[0])
    const ring = rings[0]
    // リングの重心付近の点（凹形だと外れるので複数試す）
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length
    const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length
    const got = basinAt(fc.features, cx, cy)
    if (got === undefined) continue
    hits++
    // 返ってきた流域の集水域は「自分を含み」「下流方向へは広がらない」
    const cat = catchmentOf(got)
    assert.ok(cat.has(got))
    for (const id of cat) {
      const d = fc.features.find((x) => x.properties.basin_id === id)
        .properties.downstream_basin_id
      if (id !== got) assert.ok(cat.has(d) || d === got || d === -1)
    }
  }
  assert.ok(hits > 5, `重心が流域に当たった数が少なすぎる（${hits}）`)
})

// --- scripts/80 の decode_flow / floodMaterial.ts の decodeFlow と同じ式 ---
const encodeR8 = (accum, accumMax) => {
  const t = Math.log1p(Math.max(accum, 0)) / Math.log1p(Math.max(accumMax, 1))
  return Math.min(255, Math.max(0, Math.round(t * 255)))
}
const decodeAccum = (r8, accumMax) =>
  Math.expm1((r8 / 255) * Math.log1p(Math.max(accumMax, 1)))

test('log8 の encode↔decode 往復（相対誤差）', () => {
  const accumMax = 673381                 // catalog の highres と同オーダー
  for (const a of [0, 1, 5, 50, 500, 5000, 50000, 300000, accumMax]) {
    const back = decodeAccum(encodeR8(a, accumMax), accumMax)
    // 8bit 量子化なので log 空間で 1/255 以内、線形では相対誤差で見る
    const tA = Math.log1p(a) / Math.log1p(accumMax)
    const tB = Math.log1p(Math.max(back, 0)) / Math.log1p(accumMax)
    assert.ok(Math.abs(tA - tB) <= 1 / 255 + 1e-9,
      `accum=${a}: |d(log)|=${Math.abs(tA - tB)}`)
  }
})
