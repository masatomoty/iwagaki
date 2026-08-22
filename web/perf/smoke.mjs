import { chromium } from '@playwright/test'

const URL = process.env.URL ?? 'https://localhost:8443/'
const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack||'').split('\n').slice(0,4).join('\n')}`))
const failed = []
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`))

await page.goto(URL, { waitUntil: 'load' })
await page.waitForTimeout(12000)
const snap = await page.evaluate(() => globalThis.__iwagaki?.snapshot?.() ?? null)
console.log(JSON.stringify(snap, null, 2))
console.log('--- console ---'); for (const e of errors.slice(0, 25)) console.log(e)
console.log('--- failed requests ---'); for (const f of failed.slice(0, 15)) console.log(f)
await page.screenshot({ path: 'perf/smoke.png' })
await browser.close()
