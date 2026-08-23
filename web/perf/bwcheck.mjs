#!/usr/bin/env node
// 帯域推定が**実効帯域とどれだけずれているか**を、絞ったプロファイルごとに測る。
//
// なぜ要るか: 点群 LOD の予算は `maxBytes = clamp(bandwidthBps * 2, 1 MB, 20 MB)` で、
// 推定がずれると予算ごとずれる。しかも**画面は出てしまうので見て気づけない**。
// 実際、1 リクエストごとに `wireBytes / 所要時間` を測っていた頃は
// 並列数のぶん割られて実効の 1/5 以下しか出ておらず、
// **下限がそのまま予算になっていた**（docs/WEB_RESULTS.md）。
//
//   BASE=https://localhost:8477 node perf/bwcheck.mjs
//     PROFS=  測るプロファイル（既定は絞りのある 3 つ + normal）
//     Q=      クエリ（既定 ?pc=1。?maxbytes= で予算を固定して比べられる）
//
// プロファイルの数値は perf/run.mjs と同一（docs/WEB_DESIGN.md「ネットワークプロファイル」）。
import { chromium } from '@playwright/test'

// [CDP の設定, 実効帯域 B/s]。実効は downloadThroughput そのもの
const PROFILES = {
  normal: [{ offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 }, null],
  fast4g: [{ offline: false, downloadThroughput: 4e6 / 8, uploadThroughput: 3e6 / 8, latency: 70 }, 4e6 / 8],
  'slow-highrtt': [{ offline: false, downloadThroughput: 1e6 / 8, uploadThroughput: 0.5e6 / 8, latency: 400 }, 1e6 / 8],
  'fatpipe-highrtt': [{ offline: false, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8, latency: 400 }, 20e6 / 8],
}
const BASE = process.env.BASE ?? 'https://localhost:8477'
const Q = process.env.Q ?? '?pc=1'
const WINDOW_MS = 12_000            // 計測の窓（docs/WEB_RESULTS.md と同じ）

for (const name of (process.env.PROFS ?? 'slow-highrtt,fast4g,fatpipe-highrtt,normal').split(',')) {
  const [prof, truth] = PROFILES[name]
  const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 750 } })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.clearBrowserCache')
  await cdp.send('Network.emulateNetworkConditions', prof)
  await page.goto(`${BASE}/${Q}`, { waitUntil: 'commit' })
  await page.waitForTimeout(WINDOW_MS)
  const s = await page.evaluate(() => globalThis.__iwagaki.snapshot())
  const bw = Math.round(s.scheduler?.bandwidthBps ?? -1)
  const m = s.milestones_navigation ?? {}
  const pc = s.pointcloud ?? {}
  const ms = (v) => String(v ?? '—').padStart(6)
  console.log(`${name.padEnd(16)} bw ${String(bw).padStart(9)} B/s`
    + (truth ? ` (実効 ${truth} = ${(bw / truth).toFixed(2)}x)` : ' (実効 無制限)').padEnd(30)
    + ` | FMR ${ms(m.first_meaningful_render)} terrain ${ms(m.time_to_terrain)}`
    + ` PLATEAU ${ms(m.time_to_plateau)}`
    + ` | 建物 ${String(s.plateau?.loaded ?? 0).padStart(2)}/22`
    + ` | 点 ${String(pc.residentPoints ?? 0).padStart(6)}/${String(pc.wantedPoints ?? 0).padStart(6)}`
    + ` | @10s ${String(s.bytes.at_10s).padStart(7)}`)
  await browser.close()
}
