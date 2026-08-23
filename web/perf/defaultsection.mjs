// 起動時に既定の断面（天端を横切る線）が出るか、水位で追従するかを確かめる。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)) })

await p.goto(`${BASE}/?pc=0`, { waitUntil: 'load' })
await p.waitForFunction(
  () => document.getElementById('section')?.style.display === 'block',
  null, { timeout: 60_000 }).catch(() => {})
await p.waitForTimeout(4000)

const info = await p.evaluate(() => {
  const s = globalThis.__iwagaki.section ?? []
  const line = globalThis.__iwagaki.store.state.catalog.default_section
  return {
    visible: document.getElementById('section')?.style.display,
    series: s.map((x) => {
      const v = x.points.map((q) => q.elev).filter(Number.isFinite).sort((a, b) => a - b)
      return { label: x.label, valid: v.length, min: v[0], max: v.at(-1) }
    }),
    line,
  }
})
console.log('断面パネル:', info.visible)
console.log('既定測線:', JSON.stringify(info.line))
for (const s of info.series) {
  console.log(`  ${s.label.padEnd(12)} 有効 ${String(s.valid).padStart(4)} 点  `
    + `標高 ${s.min?.toFixed(2)} 〜 ${s.max?.toFixed(2)} m`)
}
for (const h of [0.25, 0.93, 2.0]) {
  await p.evaluate((v) => globalThis.__iwagaki.setWaterLevel(v), h)
  await p.waitForTimeout(800)
  await p.screenshot({ path: `perf/shots/defsec-H${h}.png` })
}
console.log('errors:', [...new Set(errs)].slice(0, 5).join(' || ') || '(なし)')
await b.close()
