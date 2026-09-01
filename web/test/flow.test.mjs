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
  const conds = Object.keys(flow).filter((k) => k !== 'pits')
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
