#!/usr/bin/env node
// cold cache でネットワークプロファイルを変えて計測する（docs/WEB_DESIGN.md §8.5）。
// FPS は測らない。「いつ・何バイトで・何が見えたか」を測る。
//
//   node perf/run.mjs                 # 既定 3 プロファイル
//   node perf/run.mjs --scenario=coalesce
//
// 事前に `npm run build` と `node serve.mjs`（別プロセス）が必要。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE ?? 'https://localhost:8443'
const args = process.argv.slice(2)
/** 値に '=' が含まれても壊れないように、最初の '=' 以降を全部取る */
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a === undefined ? dflt : a.slice(name.length + 3)
}
const SCENARIO = opt('scenario', 'profiles')
const LABEL = opt('label', '')
/** 既定の URL に付けるクエリ。点群は既定 OFF なので計測では ?pc=1 を付ける */
const SUFFIX = opt('suffix', '')

// Chrome DevTools のプリセットを模した本リポジトリ定義の値（プリセットそのものではない）
const PROFILES = {
  normal: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
  fast4g: { offline: false, downloadThroughput: (4e6) / 8, uploadThroughput: (3e6) / 8, latency: 70 },
  'slow-highrtt': { offline: false, downloadThroughput: (1e6) / 8, uploadThroughput: (0.5e6) / 8, latency: 400 },
  // 帯域は十分だが RTT が大きい回線。往復回数が支配的になる条件で
  // range coalescing の効果を切り分けるために足した（docs/WEB_RESULTS.md §4）
  'fatpipe-highrtt': { offline: false, downloadThroughput: (20e6) / 8, uploadThroughput: (5e6) / 8, latency: 400 },
}

const WAIT_MS = 20_000
const LOAD_WINDOW_MS = 12_000
const HEADED = process.env.HEADED !== '0'
const VIEWPORT = { width: 1100, height: 750 }

const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))])

async function measure(browser, profileName, url) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORT })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.clearBrowserCache')       // cold cache
  await cdp.send('Network.clearBrowserCookies')
  await cdp.send('Network.emulateNetworkConditions', PROFILES[profileName])

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)))

  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'commit' })
  // Cache API も消す（HTTP キャッシュだけでは L2 が残る）
  await page.evaluate(async () => {
    if ('caches' in globalThis) for (const k of await caches.keys()) await caches.delete(k)
  }).catch(() => {})

  await page.waitForFunction(
    () => globalThis.__iwagaki?.snapshot?.().milestones?.first_meaningful_render !== undefined,
    null, { timeout: WAIT_MS },
  ).catch(() => {})
  await page.waitForTimeout(Math.max(0, LOAD_WINDOW_MS - (Date.now() - t0)))
  const load = await page.evaluate(() => globalThis.__iwagaki.snapshot())

  // --- 水位変更でネットワークが発生しないことを確認する ---------------------
  // 読み込み継続中に測ると「進行中のリクエスト」を数えてしまう。静止するまで待つ
  const quiescent = await page.waitForFunction(
    () => {
      const s = globalThis.__iwagaki.scheduler.stats()
      return s.concurrentNow === 0
    }, null, { timeout: 8000 },
  ).then(() => true).catch(() => false)
  const before = await page.evaluate(() => globalThis.__iwagaki.scheduler.stats().issued)
  const tSlider = await withTimeout(page.evaluate(async () => {
    const t = performance.now()
    for (let i = 0; i <= 30; i++) {
      globalThis.__iwagaki.setWaterLevel(i / 10)
      await new Promise((r) => setTimeout(r, 16))
    }
    return performance.now() - t
  }), 15_000, -1)
  const after = await page.evaluate(() => globalThis.__iwagaki.scheduler.stats().issued)

  // --- カメラ操作 -> 詳細が出るまで ---------------------------------------
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await page.mouse.down()
  await page.mouse.move(VIEWPORT.width / 2 + 260, VIEWPORT.height / 2 - 130, { steps: 16 })
  await page.mouse.up()
  await page.waitForTimeout(8000)
  const afterMove = await page.evaluate(() => globalThis.__iwagaki.snapshot())

  await page.screenshot({ path: path.join(HERE, 'results', `${profileName}${LABEL}.png`) })
  await ctx.close()

  return {
    profile: profileName,
    profile_settings: PROFILES[profileName],
    url,
    load,
    water_level_sweep: {
      steps: 31,
      duration_ms: Math.round(tSlider),
      // 静止状態で測れたときだけ有効。0 でなければ設計違反
      requests_issued: quiescent ? after - before : null,
      quiescent,
    },
    after_camera_move: {
      milestones: afterMove.milestones,
      scheduler: afterMove.scheduler,
      camera: afterMove.camera,
      pointcloud: afterMove.pointcloud,
    },
    page_errors: [...new Set(errors)].slice(0, 8),
  }
}

// headless のソフトウェア GL だと点群の描画が律速して計測が壊れる。既定は headed。
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--ignore-certificate-errors',
    ...(HEADED ? [] : ['--enable-unsafe-swiftshader'])],
})
await mkdir(path.join(HERE, 'results'), { recursive: true })
const out = []

if (SCENARIO === 'profiles') {
  for (const p of Object.keys(PROFILES)) {
    process.stdout.write(`measuring ${p} ... `)
    out.push(await measure(browser, p, `${BASE}/${SUFFIX}`))
    console.log('done')
  }
} else if (SCENARIO === 'coalesce') {
  const only = opt('profiles', undefined)
  const list = only ? only.split(',') : ['fast4g', 'slow-highrtt']
  for (const on of [1, 0]) {
    for (const p of list) {
      process.stdout.write(`measuring coalesce=${on} ${p} ... `)
      const r = await measure(browser, p, `${BASE}/?pc=1&coalesce=${on}`)
      r.profile = `${p}/coalesce=${on}`
      out.push(r)
      console.log('done')
    }
  }
}
await browser.close()

const file = path.join(HERE, 'results', `${SCENARIO}${LABEL}.json`)
await writeFile(file, JSON.stringify(out, null, 2))

// --- 比較表 --------------------------------------------------------------
const row = (r) => {
  const m = r.load.milestones
  const s = r.load.scheduler
  const b = r.load.bytes
  const mb = (v) => (v == null ? '—' : (v / 1e6).toFixed(2))
  return [
    r.profile,
    m.first_meaningful_render ?? '—',
    m.time_to_terrain ?? '—',
    m.time_to_plateau ?? '—',
    m.time_to_first_useful_pc ?? '—',
    mb(b.initial_to_fmr),
    mb(b.at_10s),
    s.issued,
    s.peakConcurrent,
    s.cancelled,
    mb(s.wastedBytes),
    `${s.coalesced.groups}/${s.coalesced.members}`,
    r.load.decode_ms.p50 ?? '—',
    r.water_level_sweep.quiescent ? r.water_level_sweep.requests_issued : 'n/a',
    (r.after_camera_move.camera.settle_latency_ms.at(-1) ?? '—'),
  ]
}
const head = ['profile', 'FMR ms', 'terrain ms', 'PLATEAU ms', 'pc useful ms',
  'MB→FMR', 'MB@10s', 'reqs', 'peak', 'cancel', 'MB wasted', 'coalesce g/m',
  'decode p50', 'slider reqs', 'camera ms']
const rows = out.map(row)
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |'
console.log('\n' + line(head))
console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|')
for (const r of rows) console.log(line(r))
console.log(`\nwrote ${path.relative(process.cwd(), file)}`)
