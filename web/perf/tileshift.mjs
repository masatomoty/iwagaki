// 粗メッシュ（z14-15）から細メッシュ（z16-18）に切り替わる瞬間に、
// 地形・浸水色が「ずれる」のか「細かくなるだけ」なのかを画像で確かめる。
//
// 回線を絞って粗と細の間に窓を作り、同じカメラで 2 枚撮って差分を取る。
// 平行移動なら差分が輪郭の片側に偏り、解像度差だけなら輪郭の両側に出る。
import { chromium } from '@playwright/test'
import sharp from 'sharp'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const OUT = 'perf/shots'

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } })
const p = await ctx.newPage()
const cdp = await ctx.newCDPSession(p)
await cdp.send('Network.enable')
// 1 Mbps / RTT 400 ms。粗が出てから細が揃うまでの窓を広げる
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, downloadThroughput: 1e6 / 8, uploadThroughput: 0.5e6 / 8, latency: 400,
})

// 点群と建物は消す。地形だけを見たい
await p.goto(`${BASE}/?pc=0`, { waitUntil: 'commit' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.first_meaningful_render !== undefined,
  null, { timeout: 60_000 })
await p.evaluate(() => {
  globalThis.__iwagaki.setLayer('plateau', false)
  globalThis.__iwagaki.setLayer('semantics', false)
  globalThis.__iwagaki.setLayer('pcCoverage', false)
})
await p.waitForTimeout(1200)
await p.screenshot({ path: `${OUT}/tileshift-coarse.png` })
const s1 = await p.evaluate(() => globalThis.__iwagaki.snapshot().milestones)

// 細が揃うまで待つ
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_terrain !== undefined,
  null, { timeout: 120_000 }).catch(() => {})
await p.waitForTimeout(3000)
await p.screenshot({ path: `${OUT}/tileshift-fine.png` })
const s2 = await p.evaluate(() => globalThis.__iwagaki.snapshot().milestones)
console.log('coarse 時点', JSON.stringify(s1))
console.log('fine 時点  ', JSON.stringify(s2))
await b.close()

// --- 2 枚を比べる ---------------------------------------------------------
const load = async (f) => {
  const { data, info } = await sharp(f).greyscale().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}
const a = await load(`${OUT}/tileshift-coarse.png`)
const c = await load(`${OUT}/tileshift-fine.png`)
const W = Math.min(a.width, c.width), H = Math.min(a.height, c.height)
const lum = (img, x, y) => img.data[y * img.width + x]
/** dx,dy だけずらしたときの平均絶対差。最小になる (dx,dy) が「ずれ」 */
const sad = (dx, dy) => {
  let s = 0, n = 0
  for (let y = 8; y < H - 8; y += 2) {
    for (let x = 8; x < W - 8; x += 2) {
      const xx = x + dx, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
      s += Math.abs(lum(a, x, y) - lum(c, xx, yy)); n++
    }
  }
  return s / n
}
let best = { dx: 0, dy: 0, v: Infinity }
for (let dy = -12; dy <= 12; dy++) {
  for (let dx = -12; dx <= 12; dx++) {
    const v = sad(dx, dy)
    if (v < best.v) best = { dx, dy, v }
  }
}
console.log(`\n位置合わせ: dx=${best.dx}px dy=${best.dy}px で差が最小 (平均差 ${best.v.toFixed(2)})`)
console.log(`ずらさない場合の平均差 ${sad(0, 0).toFixed(2)}`)
console.log(best.dx === 0 && best.dy === 0
  ? '→ 平行移動は無い。違いは解像度によるもの'
  : '→ 平行移動している。半テクセルのサンプリングずれが疑わしい')

// 差分画像も残す
const buf = Buffer.alloc(W * H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    buf[y * W + x] = Math.min(255, Math.abs(lum(a, x, y) - lum(c, x, y)) * 3)
  }
}
await sharp(buf, { raw: { width: W, height: H, channels: 1 } })
  .png().toFile(`${OUT}/tileshift-diff.png`)
console.log(`差分画像: ${OUT}/tileshift-diff.png`)
