import { chromium } from '@playwright/test'
const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } })
const p = await ctx.newPage()
const zs = new Map()
p.on('request', (r) => {
  const m = r.url().match(/\/tiles\/(highres|baseline)\/(\d+)\/(\d+)\/(\d+)\.png/)
  if (m) zs.set(m[0], Number(m[2]))
})
await p.goto(`${BASE}/?pc=0`, { waitUntil: 'load' })
await p.waitForTimeout(14000)
const count = {}
for (const z of zs.values()) count[z] = (count[z] ?? 0) + 1
console.log('要求された地形タイルの z 分布:', JSON.stringify(count))
const cam = await p.evaluate(() => {
  const m = globalThis.__iwagaki.map
  return { zoom: +m.getZoom().toFixed(2), pitch: m.getPitch(), bearing: m.getBearing() }
})
console.log('カメラ:', JSON.stringify(cam))
await b.close()
