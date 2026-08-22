// ドキュメント用のスクリーンショット。差分モードの確認も兼ねる。
import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'https://localhost:8443'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
await page.goto(BASE + '/', { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_plateau !== undefined,
  null, { timeout: 40000 }).catch(() => {})
await page.waitForTimeout(3000)

// 点群は地表面に重なるので、地形・差分の確認では切る
await page.evaluate(() => globalThis.__iwagaki.setLayer('pointcloud', false))
await page.waitForTimeout(800)

for (const [surface, H, name] of [
  ['highres', 1.0, 'viewer-highres-H1.0'],
  ['baseline', 1.0, 'viewer-baseline-H1.0'],
  ['diff', 1.0, 'viewer-diff-H1.0'],
  ['diff', 1.5, 'viewer-diff-H1.5'],
]) {
  await page.evaluate(([s, h]) => {
    globalThis.__iwagaki.setSurface(s); globalThis.__iwagaki.setWaterLevel(h)
  }, [surface, H])
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `perf/shots/${name}.png` })
  console.log(name)
}
// 地物クリック
await page.evaluate(() => { globalThis.__iwagaki.setSurface('highres') })
await page.waitForTimeout(1200)
await page.mouse.click(760, 560)
await page.waitForTimeout(800)
await page.screenshot({ path: 'perf/shots/viewer-inspector.png' })
console.log('inspector')
await page.evaluate(() => globalThis.__iwagaki.setLayer('pointcloud', true))
await page.waitForTimeout(2500)
await page.screenshot({ path: 'perf/shots/viewer-pointcloud.png' })
console.log('pointcloud')
console.log(JSON.stringify(await page.evaluate(() => globalThis.__iwagaki.snapshot().milestones)))
await browser.close()
