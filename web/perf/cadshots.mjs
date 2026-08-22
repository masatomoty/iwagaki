import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'http://localhost:8080'
const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)) })
await page.goto(BASE + '/', { waitUntil: 'load' })
await page.waitForFunction(() => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_terrain !== undefined,
  null, { timeout: 40000 }).catch(() => {})
await page.waitForTimeout(3000)
for (const [cam, exag, name] of [
  ['iso', 1, 'cad-iso-x1'],
  ['south', 5, 'cad-south-x5'],
  ['top', 1, 'cad-top'],
  ['west', 10, 'cad-west-x10'],
]) {
  await page.evaluate(([c, e]) => { globalThis.__iwagaki.setCamera(c); globalThis.__iwagaki.setExaggeration(e) }, [cam, exag])
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `perf/shots/${name}.png` })
  console.log(name)
}
console.log('errors:', [...new Set(errs)].slice(0, 6).join(' || ') || '(なし)')
await browser.close()
