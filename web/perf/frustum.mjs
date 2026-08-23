#!/usr/bin/env node
// 点群 LOD の視野判定が「地面に落とした視錐台（台形）」になっているかを確かめる。
//
// 旧実装は台形の**外接矩形**で絞っていた。傾けるほど広く出るので、
// 視野に無いノードまで残る。どれだけ広いのかを角度ごとに出す。
//
//   BASE=https://localhost:8477 node perf/frustum.mjs
//
// pitch 0 で台形 = 外接矩形（比 1.00）になるのが、幾何が正しいことの確認になる。
// **この AOI では比が 2 倍でも選ばれるノードは変わらない** — 点群の octree は
// 427 x 799 m しかなく、台形（最小でも 1.4 km2）に丸ごと入るため
// （docs/web_results.md「視錐台を厳密にしても、この点群では何も落ちない」）。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://localhost:8477'
const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 750 } })
const p = await ctx.newPage()
await p.goto(`${BASE}/?pc=1`, { waitUntil: 'commit' })
await p.waitForFunction(() => globalThis.__iwagaki?.pc?.stats?.()?.wantedPoints > 0, null, { timeout: 90000 }).catch(()=>{})
await p.waitForTimeout(3000)
for (const [label, cam] of [
  ['既定 pitch52', null],
  ['pitch 0', { pitch: 0 }],
  ['pitch 75', { pitch: 75 }],
  ['pitch 84', { pitch: 84 }],
  ['pitch 84 引き', { pitch: 84, zoom: 14.6 }],
]) {
  const r = await p.evaluate(async (cam) => {
    const w = globalThis.__iwagaki
    if (cam) w.viewer.jumpTo(cam)
    await new Promise((r) => setTimeout(r, 1200))
    const poly = w.viewer.getGroundPolygonLngLat()
    // 台形の面積と、その外接矩形の面積（度→m はざっくり）
    const lat = poly[0][1]
    const mx = 111412.84 * Math.cos(lat * Math.PI / 180), my = 111132.92
    const pts = poly.map(([lo, la]) => [lo * mx, la * my])
    let a2 = 0
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i], s = pts[(i + 1) % pts.length]
      a2 += q[0] * s[1] - s[0] * q[1]
    }
    const area = Math.abs(a2) / 2
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
    const bbox = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
    return { area, bbox, ratio: bbox / area,
      zoom: +w.viewer.getZoom().toFixed(2), wanted: w.pc?.stats?.().wantedPoints ?? 0 }
  }, cam)
  console.log(`${label.padEnd(14)} zoom ${String(r.zoom).padStart(5)}`
    + ` 台形 ${(r.area/1e6).toFixed(3)} km2 / 外接 ${(r.bbox/1e6).toFixed(3)} km2`
    + ` = ${r.ratio.toFixed(2)}x | wanted ${r.wanted}`)
}
await b.close()
