// 点群のキャンセルが発火しない理由を切り分ける。
// 候補は 3 つ:
//   (a) 被覆外へ飛んでも wanted が空にならない（stillNeeded が真のまま）
//   (b) reap の時点で 8 割受信済みで、捨てるほうが損と判定される
//   (c) そもそも飛行中の要求が無い（速すぎる / 予算で発行されない）
// wanted と inFlight を時系列で見れば区別できる。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const PC_CENTER = [135.328894, 35.456748]
const AOI_SW = [135.323041, 35.453227]

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 720 } })
const p = await ctx.newPage()
const cdp = await ctx.newCDPSession(p)
await cdp.send('Network.enable')
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8, latency: 400,
})

await p.goto(`${BASE}/?pc=1&maxbytes=40000000`, { waitUntil: 'commit' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.pc_index_loaded !== undefined,
  null, { timeout: 60_000 })

const snap = async (tag) => {
  const s = await p.evaluate(() => {
    const i = globalThis.__iwagaki
    const st = i.pc?.stats?.() ?? {}
    const sc = i.scheduler
    return {
      wantedPoints: st.wantedPoints, resident: st.resident, inFlight: st.inFlight,
      schedEpoch: sc.currentEpoch,
      live: sc.stats().concurrentNow,
      cancelled: sc.stats().cancelled,
      pc: Object.fromEntries(Object.entries(sc.stats().byClass)
        .filter(([k]) => k.startsWith('pc'))
        .map(([k, v]) => [k, `${v.issued}発行/${v.cancelled}取消`])),
    }
  })
  console.log(tag.padEnd(22), JSON.stringify(s))
}

// 点群を深く要求させる
await p.evaluate((c) => globalThis.__iwagaki.map.jumpTo(
  { center: c, zoom: 18.4, pitch: 65, bearing: 0 }), PC_CENTER)
await p.waitForTimeout(150); await snap('被覆中心 +150ms')

// **被覆外へパンしても wanted は減らない。**
// 点群の octree は 427 x 799 m しかなく、1 km の AOI 内をどう動いても
// 視野から出ない。SSE を下げるにはズームアウトするしかない。
await p.evaluate((c) => globalThis.__iwagaki.map.jumpTo(
  { center: c, zoom: 12.5, pitch: 0, bearing: 0 }), AOI_SW)
await p.waitForTimeout(120); await snap('ズームアウト +120ms')
await p.waitForTimeout(200); await snap('ズームアウト +320ms')
await p.waitForTimeout(500); await snap('ズームアウト +820ms')
await p.waitForTimeout(3000); await snap('ズームアウト +3.8s')
await b.close()
