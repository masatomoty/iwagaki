// 点群の何が重いのか。点数 vs フレーム時間の関係を測る。
//
// **p50 は vsync に張り付く（16.7 ms）ので、それだけ見ても頭打ちが分からない。**
// p95 と max、それに GPU バイトも一緒に出す。60 fps を割るのは p50 が
// 16.7 ms を超えたときで、そこが常駐点数の上限になる。
import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:8080'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 140)) })
await page.goto(BASE + '/?pc=1', { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().pointcloud?.residentPoints > 0,
  null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(2500)

// ノードを間引いて常駐点数を変えながら、ドラッグ中のフレーム時間を測る
const drag = async () => {
  await page.evaluate(() => { globalThis.__ft = []; globalThis.__last = performance.now()
    globalThis.__tick = () => { const n = performance.now(); globalThis.__ft.push(n - globalThis.__last)
      globalThis.__last = n; if (globalThis.__ft.length < 300) requestAnimationFrame(globalThis.__tick) }
    requestAnimationFrame(globalThis.__tick) })
  await page.mouse.move(700, 450); await page.mouse.down()
  for (let i = 0; i < 30; i++) { await page.mouse.move(700 + Math.cos(i/5)*200, 450 + Math.sin(i/5)*120); await page.waitForTimeout(25) }
  await page.mouse.up(); await page.waitForTimeout(300)
  return page.evaluate(() => { const t = globalThis.__ft.filter(x => x > 0).sort((a,b)=>a-b)
    const q = (f) => +t[Math.min(t.length - 1, Math.floor(t.length * f))].toFixed(1)
    return { p50: q(0.5), p95: q(0.95), max: q(0.999) } })
}

const rows = []
for (const [label, maxPoints] of [
  ['12 M', 12_000_000], ['6 M', 6_000_000], ['3 M', 3_000_000],
  ['1.5 M', 1_500_000], ['0.8 M', 800_000], ['0.3 M', 300_000],
]) {
  await page.evaluate(async (mp) => {
    const w = globalThis.__iwagaki
    // sse と maxBytes は上限を測るために緩める。既定値は main.ts 側
    await w.pc.update({ eye: [0,0,600], viewportHeight: 900, fovY: 0.6435 },
      { maxPoints: mp, maxBytes: 600e6, screenSpaceError: 0.3, coarseDepth: 3 })
  }, maxPoints)
  await page.waitForTimeout(2500)
  const st = await page.evaluate(() => globalThis.__iwagaki.snapshot().pointcloud)
  rows.push([label, st.residentPoints, st.drawCalls, st.gpuBytes, await drag()])
}
console.log('\n| budget | 常駐点数 | draw call | GPU | drag p50 | p95 | max |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
for (const [l, pts, dc, gb, f] of rows) {
  console.log(`| ${l} | ${(pts/1e6).toFixed(2)} M | ${dc} | ${(gb/1e6).toFixed(0)} MB `
    + `| ${f.p50} ms | ${f.p95} ms | ${f.max} ms |`)
}
console.log('\nconsole:', [...new Set(errs)].slice(0, 5).join(' | ') || '(なし)')
await browser.close()
