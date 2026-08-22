// 初回ロードで叩いた URL を origin 別に集計する。
// クロスオリジンの応答は PerformanceResourceTiming の transferSize /
// encodedBodySize が 0 になるので、**アプリ側の転送バイト集計から丸ごと抜ける**。
// 「抜けている分がどれだけあるか」を CDP の実測で押さえるための道具。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const WAIT_MS = Number(process.env.WAIT_MS ?? 20000)

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 750 } })
const p = await ctx.newPage()
const cdp = await ctx.newCDPSession(p)
await cdp.send('Network.enable')

/** requestId -> {url, bytes} */
const seen = new Map()
cdp.on('Network.requestWillBeSent', (e) => {
  seen.set(e.requestId, { url: e.request.url, bytes: 0 })
})
cdp.on('Network.dataReceived', (e) => {
  const r = seen.get(e.requestId)
  if (r) r.bytes += e.encodedDataLength || 0
})
cdp.on('Network.loadingFinished', (e) => {
  const r = seen.get(e.requestId)
  // encodedDataLength は「そのリクエスト全体の符号化後バイト数」（ヘッダ込み）
  if (r && e.encodedDataLength > r.bytes) r.bytes = e.encodedDataLength
})

await p.goto(`${BASE}/?pc=1`, { waitUntil: 'load' })
await p.waitForTimeout(WAIT_MS)

const origin = new URL(BASE).origin
const byOrigin = new Map()
for (const { url, bytes } of seen.values()) {
  let o = '(不明)'
  let path = url.slice(0, 52)
  try { const u = new URL(url); o = u.origin; path = u.pathname.slice(-52) } catch { /* data: 等 */ }
  const e = byOrigin.get(o) ?? { reqs: 0, bytes: 0, samples: [] }
  e.reqs++
  e.bytes += bytes
  if (e.samples.length < 4) e.samples.push(path)
  byOrigin.set(o, e)
}
const rows = [...byOrigin].sort((a, c) => c[1].bytes - a[1].bytes)
let cross = 0
console.log(`${'origin'.padEnd(44)}${'req'.padStart(5)}${'wire kB'.padStart(11)}`)
for (const [o, e] of rows) {
  if (o !== origin) cross += e.bytes
  const label = o === origin ? `${o} (同一)` : o
  console.log(`${label.padEnd(44)}${String(e.reqs).padStart(5)}${(e.bytes / 1e3).toFixed(1).padStart(11)}`)
  for (const s of e.samples) console.log(`      ${s}`)
}
console.log(`\nクロスオリジン計 ${(cross / 1e3).toFixed(1)} kB`)
console.log('→ この分はアプリ側の転送バイト集計（transferSize / encodedBodySize）から抜ける')

const inApp = await p.evaluate(() => globalThis.__iwagaki?.snapshot?.().bytes ?? null)
console.log('アプリ側の集計:', JSON.stringify(inApp))
await b.close()
