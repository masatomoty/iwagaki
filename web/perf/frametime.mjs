// 何が重いのかを切り分ける。構成を変えながらフレーム時間を測る。
import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:8080'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
await page.goto(BASE + '/', { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_plateau !== undefined,
  null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(3000)

// 1 秒間のフレーム時間を測る
const frames = () => page.evaluate(() => new Promise((res) => {
  const t = []; let last = performance.now(); let n = 0
  const tick = () => { const now = performance.now(); t.push(now - last); last = now; n++
    if (n < 90) requestAnimationFrame(tick)
    else { t.sort((a, b) => a - b); res({ p50: +t[45].toFixed(1), p95: +t[85].toFixed(1), max: +t[89].toFixed(1) }) } }
  requestAnimationFrame(tick)
}))

const set = (k, v) => page.evaluate(([k, v]) => globalThis.__iwagaki.setLayer(k, v), [k, v])
const rows = []
const run = async (label) => { await page.waitForTimeout(1500); rows.push([label, await frames()]) }

await run('全部 ON（既定）')
await set('pointcloud', false); await run('点群 OFF')
await set('plateau', false);    await run('点群+PLATEAU OFF')
await set('semantics', false);  await run('地形のみ')
await set('semantics', true); await set('plateau', true)
await run('点群 OFF に戻す')

// スライダを動かしている間のフレーム時間
const drag = await page.evaluate(async () => {
  const t = []; let last = performance.now()
  for (let i = 0; i <= 40; i++) {
    globalThis.__iwagaki.setWaterLevel((i % 30) / 10)
    await new Promise((r) => requestAnimationFrame(r))
    const now = performance.now(); t.push(now - last); last = now
  }
  t.sort((a, b) => a - b)
  return { p50: +t[20].toFixed(1), p95: +t[38].toFixed(1), max: +t[40].toFixed(1) }
})
rows.push(['水位スライダ操作中（点群OFF）', drag])

const stats = await page.evaluate(() => globalThis.__iwagaki.snapshot())
console.log('\n| 構成 | frame p50 | p95 | max |')
console.log('|---|---:|---:|---:|')
for (const [l, f] of rows) console.log(`| ${l} | ${f.p50} ms | ${f.p95} ms | ${f.max} ms |`)
console.log('\npointcloud:', JSON.stringify(stats.pointcloud))
await browser.close()
