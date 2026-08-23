// 画面に出ている地形・浸水が、焼いたタイルの「その場所」の値かどうかを確かめる。
//
// tileshift.mjs は「粗→細で平行移動するか」しか見ていないので、
// 全ズームで同じ向きに間違っている（例: タイル内で南北反転している）場合は
// 検出できない。ここでは画面を真上から撮り、各画素の lng/lat を map.unproject で
// 取り出して、**焼いた PNG の同じ座標の (標高, h_conn)** と直接照合する。
//
//   使い方: node perf/tileorient.mjs      （既定 https://localhost:8443, zoom 18, H=1.0 m）
//     BASE=  配信元   ZOOM=  画面の zoom   REF_Z=  参照に使うタイルの z
//     WATER= 水位 H   TILES= 参照タイルの置き場   MARGIN= 判定が紙一重とみなす幅（m）
//
//   **ZOOM は REF_Z と同じにする。** Viewer の zoom はタイル 1 枚 = 256 px 基準で、
//   `Math.round(getZoom())` がそのまま要求する z になる（docs/web_design.md「ズームの規約」）。
//   MapLibre + deck.gl 時代は画面 zoom が 512 px 基準で、tileSize 256 の TileLayer が
//   zoom+1 の z を要求していたため ZOOM = REF_Z - 1 だった。**数字が 1 ずれる。**
//   pitch 0 を前提にしている（視差の補正が中心対称であることを使っている）。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import sharp from 'sharp'

const BASE = process.env.BASE ?? 'https://localhost:8443'
// タイルのディレクトリ名には内容ハッシュが入る（docs/infra.md）。
// 直書きすると焼き直すたびに壊れるので、catalog の url から引く
const TILES = process.env.TILES ?? (() => {
  const c = JSON.parse(readFileSync('public/data/catalog.json', 'utf8'))
  return 'public/' + c.terrain.highres.url.replace('/{z}/{x}/{y}.png', '')
})()
const OUT = 'perf/shots'
// 256 px 基準なので、画面 zoom 18 で要求されるのも z18。参照と同じタイルで比べられる
const ZOOM = Number(process.env.ZOOM ?? 18)
const REF_Z = Number(process.env.REF_Z ?? 18)   // 参照に使うタイルの z（最も細かいもの）
const STEP = 4                                  // 何画素ごとに照合するか
const WATER = Number(process.env.WATER ?? 1.0)  // 水位 H（m, T.P.）
const R = 6378137.0
const ORIGIN = Math.PI * R

// ---- 画面を撮る ----------------------------------------------------------
const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } })
const p = await ctx.newPage()
await p.goto(`${BASE}/?pc=0`, { waitUntil: 'commit' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.first_meaningful_render !== undefined,
  null, { timeout: 60_000 })
// 地形だけを残す。建物・地物・輪郭が乗っていると色で判定できない
const setup = await p.evaluate(({ zoom, water }) => {
  const w = globalThis.__iwagaki
  for (const k of ['plateau', 'semantics', 'pcCoverage', 'pointcloud']) w.setLayer(k, false)
  // パネル・ビューキューブ・断面・出典バーは地形を隠す。色で判定するので消しておく
  for (const sel of ['#controls', '#inspector', '#perf', '#section', '#viewcube', '#attrib']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
  w.setSurface('highres')
  w.setWaterLevel(water)
  w.setExaggeration(1)
  const c = w.store.state.catalog.aoi.centre_wgs84
  w.viewer.jumpTo({ center: c, zoom, pitch: 0, bearing: 0 })
  return {
    waterLevel: w.store.state.waterLevel,
    hStep: w.store.state.catalog.packing.h_step,
    geoid: w.store.state.catalog.vertical.geoid_undulation_m,
    exaggeration: w.store.state.exaggeration,
  }
}, { zoom: ZOOM, water: WATER })
await p.waitForTimeout(6000)
await p.screenshot({ path: `${OUT}/tileorient-screen.png` })

// 画素 -> lng/lat は Viewer 自身に聞く。投影を自前で書き直すと、
// 検証したい対象（座標の対応）を検証側でも間違えられる
const { w: W, h: H, pts, cam } = await p.evaluate((step) => {
  const v = globalThis.__iwagaki.viewer
  const cv = v.canvas
  const w = cv.clientWidth, h = cv.clientHeight
  const pts = []
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const ll = v.unproject(x, y)
      if (!ll) continue                 // 地平線より上（pitch 0 では起きない）
      pts.push(x, y, ll[0], ll[1])
    }
  }
  const [clng, clat] = v.getCenterLngLat()
  return {
    w, h, pts,
    // 視差の補正に使う（下記）。カメラは真上にある（pitch 0）なので、
    // 注視点からの距離がそのままカメラ高度になる
    cam: {
      altitude: v.cameraState.distance * Math.cos((v.cameraState.pitch * Math.PI) / 180),
      byDistance: v.cameraState.distance,
      lng: clng, lat: clat,
    },
  }
}, STEP)
await b.close()

// ---- 焼いたタイルから参照を作る ------------------------------------------
const cache = new Map()
async function tilePixels(z, x, y) {
  const key = `${z}/${x}/${y}`
  if (cache.has(key)) return cache.get(key)
  const f = path.join(TILES, String(z), String(x), `${y}.png`)
  let v = null
  if (existsSync(f)) {
    const { data } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    v = data
  }
  cache.set(key, v)
  return v
}
const merc = (lon, lat) => [
  (lon * Math.PI / 180) * R,
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R,
]
const unmerc = (mx, my) => [
  mx / R * 180 / Math.PI,
  (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI,
]

/**
 * `map.unproject` は **z=0 平面**との交点を返す。ところが地表は
 * `z = geoid(36.955 m) + 標高 * 鉛直強調` の高さに描かれており、MapLibre は
 * 透視投影なので、その高さの分だけ画面外側にずれて写っている。
 *
 * カメラ高度 h（pitch 0 なら中心の真上）に対し、高さ zp の点は z=0 平面上の
 * 交点から中心方向に (1 - zp/h) 倍の位置にある。**画面端では 10 px 以上効く**
 * （zoom 17 で h ≈ 1 km、zp ≈ 38 m）ので、これを入れないと汀線が
 * 一致しない理由が「向きのずれ」なのか視差なのか分けられない。
 */
function parallax(lon, lat, zp) {
  const k = 1 - zp / cam.altitude
  const [cx, cy] = merc(cam.lng, cam.lat)
  const [mx, my] = merc(lon, lat)
  return unmerc(cx + (mx - cx) * k, cy + (my - cy) * k)
}

/**
 * 焼いたタイルから「そこは水か」。null = タイルが無い / nodata。
 *
 * シェーダと同じ判定にする。h_conn <= H でも **標高が H 以上なら水深 0** で
 * 地面色になる（浸水深 0 を青く塗らない）。参照側でこれを落とすと、
 * 建物の載った高い画素が全部「食い違い」に数えられてしまう。
 *
 * off は「参照を何セルずらして引くか」。0 以外で一致率が上がるなら、
 * 画面と焼いたタイルの間にまだ平行移動が残っている。
 */
async function refCell(lon, lat, z, offX = 0, offY = 0) {
  const [mx0, my0] = merc(lon, lat)
  const span = 2 * ORIGIN / 2 ** z
  const cell = span / 256
  const mx = mx0 + offX * cell
  const my = my0 + offY * cell
  const x = Math.floor((mx + ORIGIN) / span)
  const y = Math.floor((ORIGIN - my) / span)
  const data = await tilePixels(z, x, y)
  if (!data) return null
  const px = Math.min(255, Math.max(0, Math.floor(((mx + ORIGIN) % span) / span * 256)))
  const py = Math.min(255, Math.max(0, Math.floor(((ORIGIN - my) % span) / span * 256)))
  const i = (py * 256 + px) * 4
  if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) return null   // nodata
  const elev = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768
  const a = data[i + 3]
  const hConn = a === 0 ? Infinity : (a - 1) * setup.hStep
  return { elev, hConn, wet: hConn <= setup.waterLevel && setup.waterLevel - elev > 0 }
}
const refWet = async (lon, lat, z, dx = 0, dy = 0) =>
  (await refCell(lon, lat, z, dx, dy))?.wet ?? null

// ---- 画面の色 -> 濡れ / 乾き ---------------------------------------------
const { data: img, info } = await sharp(`${OUT}/tileorient-screen.png`)
  .removeAlpha().raw().toBuffer({ resolveWithObject: true })
/** 浸水色は青（b >> r）、地面は無彩色（r ≈ b）、背景は暗い */
function screenClass(x, y) {
  const sx = Math.round(x * info.width / W), sy = Math.round(y * info.height / H)
  const i = (sy * info.width + sx) * 3
  const r = img[i], g = img[i + 1], bl = img[i + 2]
  if (Math.max(r, g, bl) < 45) return 'bg'
  if (bl - r > 25) return 'wet'
  if (Math.abs(bl - r) < 20 && r > 45) return 'dry'
  return 'other'
}

const samples = []
for (let k = 0; k < pts.length; k += 4) {
  const [x, y, lon0, lat0] = pts.slice(k, k + 4)
  const cls = screenClass(x, y)
  if (cls !== 'wet' && cls !== 'dry') continue
  // 標高は視差の補正量に効くので 1 回だけ折り返す（geoid 36.955 m が支配的）
  let [lon, lat] = parallax(lon0, lat0, setup.geoid)
  const c0 = await refCell(lon, lat, REF_Z)
  if (c0) [lon, lat] = parallax(lon0, lat0, setup.geoid + c0.elev * setup.exaggeration)
  samples.push({ x, y, lon, lat, wet: cls === 'wet' })
}
const CELL_M = 2 * ORIGIN / 2 ** REF_Z / 256 * Math.cos(cam.lat * Math.PI / 180)
console.log(`カメラ高度 ${cam.altitude.toFixed(0)} m` +
  `（cameraToCenterDistance からの検算 ${cam.byDistance.toFixed(0)} m）/ 視差補正 ` +
  `${((setup.geoid / cam.altitude) * 100).toFixed(1)} %（画面端で ` +
  `${(Math.hypot(W, H) / 2 * setup.geoid / cam.altitude).toFixed(1)} px 相当）`)
console.log(`参照 z${REF_Z} の 1 セル = ${CELL_M.toFixed(2)} m`)

/** ずらし量ごとの一致率。食い違った画素も返す */
async function score(offX, offY) {
  let wetwet = 0, drydry = 0, wetdry = 0, drywet = 0, skipped = 0
  const wrong = []
  for (const s of samples) {
    const wet = await refWet(s.lon, s.lat, REF_Z, offX, offY)
    if (wet === null) { skipped++; continue }
    if (wet && s.wet) wetwet++
    else if (!wet && !s.wet) drydry++
    else if (wet) { drywet++; wrong.push([s.x, s.y]) }
    else { wetdry++; wrong.push([s.x, s.y]) }
  }
  const n = wetwet + drydry + wetdry + drywet
  return { wetwet, drydry, wetdry, drywet, skipped, n, agree: (wetwet + drydry) / n, wrong }
}

/**
 * 食い違いの残りが「向きのずれ」ではなく「判定が紙一重の場所」であることを示す。
 *
 * 画面の水深は **メッシュ 128 分割の頂点標高を補間した値**（テクスチャは 256 なので
 * 面は 2 分の 1 に間引かれている）。参照はセルの標高そのもの。吉原は起伏が 0〜3 m で
 * H=1.0 m はその真ん中なので、**標高が H の前後 ±MARGIN に入る画素は、
 * 補間の差だけで水／地面が入れ替わる**。
 *
 * MARGIN と「前後 1 セルで判定が変わる帯」の 2 つを外して数える。
 */
const MARGIN = Number(process.env.MARGIN ?? 0.25)
async function scoreInterior() {
  let ok = 0, ng = 0, edge = 0, thin = 0, skipped = 0
  const wrong = []
  for (const s of samples) {
    const c = await refCell(s.lon, s.lat, REF_Z)
    if (!c) { skipped++; continue }
    if (Math.abs(setup.waterLevel - c.elev) < MARGIN) { thin++; continue }
    const ns = await Promise.all([[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => refWet(s.lon, s.lat, REF_Z, dx, dy)))
    if (ns.some((v) => v === null || v !== c.wet)) { edge++; continue }
    if (c.wet === s.wet) ok++; else { ng++; wrong.push([s.x, s.y]) }
  }
  return { ok, ng, edge, thin, skipped, agree: ok / (ok + ng), wrong }
}

const base = await score(0, 0)
console.log(`水位 H=${setup.waterLevel} m / 参照 z${REF_Z} / 照合 ${base.n} 点（除外 ${base.skipped}）`)
console.log(`  画面=浸水 参照=浸水  ${base.wetwet}`)
console.log(`  画面=地面 参照=地面  ${base.drydry}`)
console.log(`  画面=浸水 参照=地面  ${base.wetdry}   <- 出るべきでない場所に水`)
console.log(`  画面=地面 参照=浸水  ${base.drywet}   <- 水が出るべき場所に地面`)
console.log(`一致率 ${(base.agree * 100).toFixed(1)} %`)

const inner = await scoreInterior()
console.log(`標高が H±${MARGIN} m の画素（${inner.thin}）と、前後 1 セルで判定が変わる帯` +
  `（${inner.edge}）を外すと ${(inner.agree * 100).toFixed(1)} %` +
  `（一致 ${inner.ok} / 食い違い ${inner.ng}）`)

// ずらして一致率が上がるかを見る。上がるなら平行移動が残っている
const OFFS = [-2, -1, -0.5, 0, 0.5, 1, 2]
console.log(`\n参照をずらしたときの一致率（セル単位, z${REF_Z} の 1 セル）:`)
const rows = []
for (const dy of OFFS) {
  const cells = []
  for (const dx of OFFS) cells.push((await score(dx, dy)).agree)
  rows.push({ dy, cells })
}
console.log('    dy\\dx ' + OFFS.map((d) => String(d).padStart(7)).join(''))
let best = { v: -1 }
for (const r of rows) {
  console.log(String(r.dy).padStart(9) + ' ' +
    r.cells.map((v) => (v * 100).toFixed(1).padStart(7)).join(''))
  r.cells.forEach((v, i) => { if (v > best.v) best = { v, dx: OFFS[i], dy: r.dy } })
}
const gain = (best.v - base.agree) * 100
console.log(best.dx === 0 && best.dy === 0
  ? '→ ずらさない時が最良。平行移動は残っていない'
  : `→ 最良は (dx=${best.dx}, dy=${best.dy}) セル = ` +
    `(${(best.dx * CELL_M).toFixed(2)}, ${(best.dy * CELL_M).toFixed(2)}) m で ` +
    `+${gain.toFixed(1)} ポイント。` +
    (gain < 0.5 ? '半セル以下・利得も小さいので視差補正の誤差の範囲' : 'まだずれている'))

// 食い違った画素を赤で焼いた画像も残す
const overlay = Buffer.from(img)
for (const [x, y] of base.wrong) {
  const sx = Math.round(x * info.width / W), sy = Math.round(y * info.height / H)
  for (let dy = 0; dy < STEP; dy++) for (let dx = 0; dx < STEP; dx++) {
    const yy = sy + dy, xx = sx + dx
    if (yy >= info.height || xx >= info.width) continue
    const i = (yy * info.width + xx) * 3
    overlay[i] = 255; overlay[i + 1] = 0; overlay[i + 2] = 0
  }
}
await sharp(overlay, { raw: { width: info.width, height: info.height, channels: 3 } })
  .png().toFile(`${OUT}/tileorient-mismatch.png`)
console.log(`食い違い: ${OUT}/tileorient-mismatch.png`)
