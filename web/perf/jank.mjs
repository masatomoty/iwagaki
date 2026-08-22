// 「重い」の正体を切り分ける。静止時の rAF ではなく、
// (a) 読み込み中の long task と (b) カメラ操作中のフレーム時間を測る。
import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:8080'
const PC = process.env.PC !== '0'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()

await page.addInitScript(() => {
  globalThis.__long = []
  new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__long.push(Math.round(e.duration)) })
    .observe({ type: 'longtask', buffered: true })
})
await page.goto(BASE + (PC ? '/?pc=1' : '/'), { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_plateau !== undefined,
  null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(4000)

const long = await page.evaluate(() => globalThis.__long.slice())
const total = long.reduce((a, b) => a + b, 0)
console.log(`\n[読み込み中] long task ${long.length} 回 / 合計 ${total} ms / 最大 ${Math.max(0, ...long)} ms`)
console.log(`  上位: ${long.sort((a,b)=>b-a).slice(0,8).join(', ')} ms`)

// カメラをぐるぐる回しながらフレーム時間を測る
const drag = async (label) => {
  await page.evaluate(() => { globalThis.__long.length = 0; globalThis.__ft = []; globalThis.__last = performance.now()
    globalThis.__tick = () => { const n = performance.now(); globalThis.__ft.push(n - globalThis.__last); globalThis.__last = n
      if (globalThis.__ft.length < 400) requestAnimationFrame(globalThis.__tick) }
    requestAnimationFrame(globalThis.__tick) })
  await page.mouse.move(700, 450)
  await page.mouse.down()
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(700 + Math.cos(i / 6) * 220, 450 + Math.sin(i / 6) * 140)
    await page.waitForTimeout(25)
  }
  await page.mouse.up()
  await page.waitForTimeout(500)
  const r = await page.evaluate(() => {
    const t = globalThis.__ft.filter((x) => x > 0).sort((a, b) => a - b)
    return { n: t.length, p50: +t[Math.floor(t.length*.5)].toFixed(1), p95: +t[Math.floor(t.length*.95)].toFixed(1),
             max: +t[t.length-1].toFixed(1), long: globalThis.__long.length }
  })
  console.log(`[${label}] frame p50 ${r.p50} / p95 ${r.p95} / max ${r.max} ms, longtask ${r.long} 回`)
}
await drag('カメラ操作中')
await page.evaluate(() => globalThis.__iwagaki.setLayer('pointcloud', false))
await page.waitForTimeout(1500)
await drag('カメラ操作中（点群OFF）')

// 水位スライダを実際の input イベントで動かす
await page.evaluate(() => { globalThis.__long.length = 0 })
const t0 = Date.now()
const slider = page.locator('#wl')
for (let i = 0; i <= 30; i++) {
  await slider.evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', {bubbles:true})) }, i / 10)
}
const dt = Date.now() - t0
const sliderLong = await page.evaluate(() => globalThis.__long.slice())
console.log(`[水位スライダ 31 段] ${dt} ms, longtask ${sliderLong.length} 回 / 合計 ${sliderLong.reduce((a,b)=>a+b,0)} ms`)
console.log('  pointcloud:', JSON.stringify((await page.evaluate(() => globalThis.__iwagaki.snapshot())).pointcloud))
await browser.close()
