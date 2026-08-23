// 断面が出るか、水位を変えたときに水位線と塗りが動くかを撮って確かめる。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
// 吉原入江を横断する測線（護岸をまたぐ向き）
const FROM = [135.3255, 35.4570]
const TO = [135.3320, 35.4548]

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)) })

await p.goto(`${BASE}/?pc=0`, { waitUntil: 'load' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_terrain !== undefined,
  null, { timeout: 60_000 }).catch(() => {})
await p.waitForTimeout(2000)

// 真上から見て測線を引きやすくする
await p.evaluate(() => globalThis.__iwagaki.setCamera('top'))
await p.waitForTimeout(1500)

// 「測線を引く」→ 2 点クリック
await p.click('#secbtn')
const click = async (lonlat) => {
  const pt = await p.evaluate((c) => {
    const q = globalThis.__iwagaki.viewer.project(c[0], c[1])
    return [q.x, q.y]
  }, lonlat)
  await p.mouse.click(pt[0], pt[1])
  await p.waitForTimeout(300)
}
await click(FROM)
await click(TO)
await p.waitForTimeout(3500)

// **引いた測線が実際に反映されたかを確かめる。**
// 既定の断面を出すようにしてから、クリックが断面パネルに飲まれても
// 「既定の測線が出たまま」で全部それらしく通ってしまう時期があった。
// 撮れた絵ではなく、測線の長さで照合する
const R = 6378137
const want = Math.hypot(
  (TO[0] - FROM[0]) * Math.PI / 180 * R * Math.cos(FROM[1] * Math.PI / 180),
  (TO[1] - FROM[1]) * Math.PI / 180 * R)
const got = await p.evaluate(() => globalThis.__iwagaki.section?.[0]?.points?.at(-1)?.d ?? null)
if (got === null || Math.abs(got - want) / want > 0.05) {
  console.error(`NG: 測線が反映されていない。期待 ${want.toFixed(0)} m / 実際 ${got === null ? 'なし' : got.toFixed(0) + ' m'}`)
  await b.close()
  process.exit(1)
}
console.log(`測線 ${got.toFixed(0)} m（期待 ${want.toFixed(0)} m）`)

for (const h of [0.25, 1.0, 2.0]) {
  await p.evaluate((v) => globalThis.__iwagaki.setWaterLevel(v), h)
  await p.waitForTimeout(900)
  await p.screenshot({ path: `perf/shots/section-H${h}.png` })
  console.log(`H=${h} 撮影`)
}
const note = await p.evaluate(() => document.getElementById('sec-note')?.textContent ?? '')
console.log('note:', note)
console.log('errors:', [...new Set(errs)].slice(0, 5).join(' || ') || '(なし)')
await b.close()
