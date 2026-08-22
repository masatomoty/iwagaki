import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:8080'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)) })
page.on('pageerror', (e) => errs.push('[pe] ' + String(e.message).slice(0, 120)))
await page.goto(BASE + '/', { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_plateau !== undefined,
  null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(4000)
const s = await page.evaluate(() => globalThis.__iwagaki.snapshot())
console.log('milestones', JSON.stringify(s.milestones))
console.log('plateau', JSON.stringify(s.plateau))
console.log('byClass', JSON.stringify(s.scheduler.byClass))
const scenegraphErrors = errs.filter((e) => e.includes('size: 1')).length
console.log(`ScenegraphLayer size:1 エラー: ${scenegraphErrors} 件`)
console.log('other errors:', [...new Set(errs.filter((e) => !e.includes('size: 1')))].slice(0, 4).join(' | ') || '(なし)')
await page.evaluate(() => { globalThis.__iwagaki.setCamera('iso'); globalThis.__iwagaki.setWaterLevel(1.0) })
await page.waitForTimeout(2000)
await page.screenshot({ path: 'perf/shots/verify-buildings.png' })
await browser.close()
