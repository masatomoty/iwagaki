#!/usr/bin/env node
// 「地理データを 1 バイトも見る前に、アプリの JS で何バイト・何秒使うか」だけを測る。
//
// docs/WEB_RESULTS.md「転送の内訳」の結論（FMR を決めているのはバンドルだった）を、
// iwagaki と別の Web shell（GeoLibre 等）で同じ条件で比べるために切り出した。
// perf/run.mjs と違って計測対象の内部 API を必要としないので、
// 任意の URL に当てられる。__iwagaki があれば FMR も併記する。
//
//   node perf/shellcost.mjs --url=https://localhost:8477/ --label=iwagaki
//   node perf/shellcost.mjs --url=https://web.geolibre.app/ --label=geolibre
//
// プロファイルの数値は perf/run.mjs と同一（docs/WEB_DESIGN.md「ネットワークプロファイル」）。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a === undefined ? dflt : a.slice(name.length + 3)
}
const URL_ = opt('url', 'https://localhost:8477/')
const LABEL = opt('label', 'shell')
const WINDOW_MS = Number(opt('window', '20000'))
const PROFILES = {
  normal: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
  fast4g: { offline: false, downloadThroughput: 4e6 / 8, uploadThroughput: 3e6 / 8, latency: 70 },
  'slow-highrtt': { offline: false, downloadThroughput: 1e6 / 8, uploadThroughput: 0.5e6 / 8, latency: 400 },
}
const ONLY = opt('profiles', '').split(',').filter(Boolean)
const VIEWPORT = { width: 1100, height: 750 }

/** そのリクエストが「アプリのコード」か「地理データ」か。転送量を分けて数える */
function classify(url) {
  const u = url.split('?')[0]
  if (/\.(js|mjs|cjs|css|wasm|map)$/i.test(u)) return 'code'
  if (/\.(woff2?|ttf|otf)$/i.test(u)) return 'font'
  if (/\.(png|jpe?g|webp|avif|b3dm|laz|copc|geojson|json|pbf|mvt|glb|gltf)$/i.test(u)) return 'data'
  return 'other'
}

async function measure(browser, profileName) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORT })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.clearBrowserCache')
  await cdp.send('Network.clearBrowserCookies')
  await cdp.send('Network.emulateNetworkConditions', PROFILES[profileName])

  // ServiceWorker のプリキャッシュが混ざると「初回に何バイト要るか」が読めなくなる。
  // 登録は消してから測る（GeoLibre は PWA なので必須）。
  await ctx.addInitScript(() => {
    try {
      navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()))
    } catch { /* noop */ }
  })

  const urlOf = new Map()          // requestId -> url
  const seen = new Map()           // requestId -> ここまで数えたバイト
  const events = []                // { id, at, bytes, kind }
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)))
  cdp.on('Network.requestWillBeSent', (e) => urlOf.set(e.requestId, e.request.url))
  const t0 = Date.now()
  // encodedDataLength = ヘッダ込みの実転送量。content-length ではなくこれを数える。
  //
  // **スロットル下では dataReceived の encodedDataLength が 0 で来る**（実測）。
  // 総量は loadingFinished にしか出ないので、チャンクごとの値を足しつつ、
  // 完了時に「申告された総量 - ここまで足した分」を足して埋める。
  // そのため時刻分解はリクエスト完了粒度まで粗くなる（プロファイル間では同条件）。
  const add = (id, bytes) => {
    if (!bytes) return
    seen.set(id, (seen.get(id) ?? 0) + bytes)
    events.push({ id, at: Date.now() - t0, bytes, kind: classify(urlOf.get(id) ?? '') })
  }
  cdp.on('Network.dataReceived', (e) => add(e.requestId, e.encodedDataLength))
  cdp.on('Network.loadingFinished', (e) => {
    add(e.requestId, Math.max(0, (e.encodedDataLength ?? 0) - (seen.get(e.requestId) ?? 0)))
  })

  await page.goto(URL_, { waitUntil: 'commit' })
  await page.evaluate(async () => {
    if ('caches' in globalThis) for (const k of await caches.keys()) await caches.delete(k)
  }).catch(() => {})

  // 画面に何か出た時刻。FCP は「アプリが動き出した」の下限として使う
  const paints = () => page.evaluate(() => {
    const out = {}
    for (const e of performance.getEntriesByType('paint')) out[e.name] = Math.round(e.startTime)
    const c = [...document.querySelectorAll('canvas')].find((x) => x.width > 100 && x.height > 100)
    out.has_canvas = !!c
    out.fmr = globalThis.__iwagaki?.snapshot?.().milestones?.first_meaningful_render ?? null
    return out
  }).catch(() => ({}))

  // canvas（= 地図の描画面）が立った時刻を 250 ms 刻みで拾う
  let tCanvas = null
  const deadline = Date.now() + WINDOW_MS
  while (Date.now() < deadline) {
    const p = await paints()
    if (tCanvas === null && p.has_canvas) tCanvas = Date.now() - t0
    await page.waitForTimeout(250)
  }
  const final = await paints()

  const bytesAt = (ms, kind) => events
    .filter((e) => e.at <= ms && (kind === undefined || e.kind === kind))
    .reduce((a, e) => a + e.bytes, 0)
  const reqAt = (ms) => new Set(events.filter((e) => e.at <= ms).map((e) => e.id)).size

  await page.screenshot({ path: path.join(HERE, 'results', `shell-${LABEL}-${profileName}.png`) })
  await ctx.close()

  return {
    profile: profileName,
    profile_settings: PROFILES[profileName],
    first_paint_ms: final['first-paint'] ?? null,
    first_contentful_paint_ms: final['first-contentful-paint'] ?? null,
    time_to_canvas_ms: tCanvas,
    first_meaningful_render_ms: final.fmr,
    // 「コード」と「地理データ」を分けて数える。shell の値段はここに出る
    bytes: {
      code_total: bytesAt(WINDOW_MS, 'code'),
      data_total: bytesAt(WINDOW_MS, 'data'),
      at_3s: bytesAt(3000),
      at_10s: bytesAt(10000),
      total: bytesAt(WINDOW_MS),
    },
    requests_at_10s: reqAt(10000),
    page_errors: [...new Set(errors)].slice(0, 6),
  }
}

const names = (ONLY.length ? ONLY : Object.keys(PROFILES))
const results = []
for (const n of names) {
  // プロファイルごとにブラウザを立て直す。同じブラウザで context を作り直すと
  // HTTP キャッシュが残り、2 回目以降が cold cache でなくなる
  const browser = await chromium.launch({
    headless: process.env.HEADED === '0',
    args: ['--ignore-certificate-errors'],
  })
  const r = await measure(browser, n)
  await browser.close()
  results.push(r)
  console.log(`${LABEL} ${n}: FCP ${r.first_contentful_paint_ms} ms / canvas ${r.time_to_canvas_ms} ms`
    + `${r.first_meaningful_render_ms !== null ? ` / FMR ${r.first_meaningful_render_ms} ms` : ''}`
    + ` | code ${(r.bytes.code_total / 1e6).toFixed(2)} MB, data ${(r.bytes.data_total / 1e6).toFixed(2)} MB`
    + `, @10s ${(r.bytes.at_10s / 1e6).toFixed(2)} MB, reqs ${r.requests_at_10s}`)
}
await mkdir(path.join(HERE, 'results'), { recursive: true })
await writeFile(
  path.join(HERE, 'results', `shell-${LABEL}.json`),
  JSON.stringify({ label: LABEL, url: URL_, window_ms: WINDOW_MS, results }, null, 2) + '\n',
)
console.log(`-> perf/results/shell-${LABEL}.json`)
