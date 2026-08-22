// 点群の何が重いのか。点数 vs フレーム時間の関係を測る。
import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:8080'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 140)) })
await page.goto(BASE + '/?pc=1', { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().pointcloud?.residentPoints > 2e6,
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
    return +t[Math.floor(t.length*.5)].toFixed(1) })
}

const rows = []
for (const keep of [1, 0.5, 0.25, 0.1, 0]) {
  const info = await page.evaluate((k) => {
    const r = globalThis.__iwagaki.pc ? globalThis.__iwagaki.pc : null
    if (!r) return null
    // renderer の chunks を間引く（内部を直接触る。計測用）
    const rend = r.o?.renderer ?? r['o']?.renderer
    return null
  }, keep)
  void info
  break
}
// 素直に LOD budget を変えて測り直す方が確実
for (const [label, maxPoints] of [['3.0 M', 3_000_000], ['1.5 M', 1_500_000], ['0.8 M', 800_000], ['0.3 M', 300_000]]) {
  await page.evaluate((mp) => {
    const pc = globalThis.__iwagaki.pc
    pc.o.budgetOverride = mp
  }, maxPoints).catch(() => {})
  await page.evaluate(async (mp) => {
    const w = globalThis.__iwagaki
    await w.pc.update({ eye: [0,0,600], viewportHeight: 900, fovY: 0.6435 },
      { maxPoints: mp, maxBytes: 60e6, screenSpaceError: 1.0, coarseDepth: 3 })
  }, maxPoints)
  await page.waitForTimeout(2500)
  const st = await page.evaluate(() => globalThis.__iwagaki.snapshot().pointcloud)
  rows.push([label, st.residentPoints, st.drawCalls, await drag()])
}
console.log('\n| budget | 常駐点数 | draw call | drag frame p50 |')
console.log('|---|---:|---:|---:|')
for (const r of rows) console.log(`| ${r[0]} | ${(r[1]/1e6).toFixed(2)} M | ${r[2]} | ${r[3]} ms |`)
console.log('\nconsole:', [...new Set(errs)].slice(0, 5).join(' | ') || '(なし)')
await browser.close()
