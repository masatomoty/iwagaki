// 実点群 COPC を viewer で読ませて、指標と画面を確認する。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://localhost:8444'
const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 160)) })

await p.goto(BASE + '/?pc=1', { waitUntil: 'load' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().pointcloud?.residentPoints > 0,
  null, { timeout: 90000 },
).catch(() => {})
await p.waitForTimeout(9000)

const s = await p.evaluate(() => globalThis.__iwagaki.snapshot())
console.log('milestones', JSON.stringify(s.milestones))
console.log('pointcloud', JSON.stringify(s.pointcloud))
console.log('bytes     ', JSON.stringify(s.bytes))
console.log('sched     ', JSON.stringify({
  reqs: s.scheduler.issued, peak: s.scheduler.peakConcurrent,
  cancel: s.scheduler.cancelled, coalesce: s.scheduler.coalesced,
  byClass: Object.fromEntries(Object.entries(s.scheduler.byClass)
    .map(([k, v]) => [k, [v.issued, Math.round(v.bytes / 1e6) + 'MB']])),
}))
console.log('decode    ', JSON.stringify(s.decode_ms))

await p.evaluate(() => {
  globalThis.__iwagaki.setCamera('iso')
  globalThis.__iwagaki.setLayer('flood', false)
})
await p.waitForTimeout(3000)
await p.screenshot({ path: 'perf/shots/real-pc.png' })
await p.evaluate(() => globalThis.__iwagaki.setLayer('flood', true))
await p.waitForTimeout(2500)
await p.screenshot({ path: 'perf/shots/real-pc-flood.png' })
console.log('errors:', [...new Set(errs)].slice(0, 5).join(' || ') || '(なし)')
await b.close()
