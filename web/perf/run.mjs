#!/usr/bin/env node
// cold cache でネットワークプロファイルを変えて計測する（docs/web_design.md「ネットワークプロファイル」）。
// FPS は測らない。「いつ・何バイトで・何が見えたか」を測る。
//
//   node perf/run.mjs                 # 既定 3 プロファイル
//   node perf/run.mjs --scenario=coalesce
//
// 事前に `pnpm build` と `node serve.mjs`（別プロセス）が必要。

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
  // range coalescing の効果を切り分けるために足した（docs/web_results.md「range coalescing」）
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
  // --profiles= で絞れる。A/B のときは条件を減らして往復数を稼ぐ
  const only = opt('profiles', '').split(',').filter(Boolean)
  for (const p of (only.length ? only : Object.keys(PROFILES))) {
    process.stdout.write(`measuring ${p} ... `)
    out.push(await measure(browser, p, `${BASE}/${SUFFIX}`))
    console.log('done')
  }
} else if (SCENARIO === 'cancel') {
  // キャンセル経路の検証。これまでのカメラ操作（中心から 260px パン）では
  // 可視集合がほとんど変わらず、キャンセルが 1 件も出ていなかった。
  // 大きくズームアウト / 対角へ飛ぶ / すぐ引き返す、を読み込み中にぶつける。
  // **normal を入れる。** 絞った回線では LOD 予算（maxBytes = 帯域 × 6）が
  // 効いて pcCoarse 1 本で打ち止めになり、pcFine が 1 度も発行されない。
  // 発行されないものはキャンセルできないので、点群経路の検証にならない。
  for (const p of (opt('profiles', 'normal,fast4g,fatpipe-highrtt')).split(',')) {
    process.stdout.write(`measuring cancel ${p} ... `)
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORT })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.clearBrowserCache')
    await cdp.send('Network.emulateNetworkConditions', PROFILES[p])
    // ?maxbytes= を渡せるようにする。絞った回線では LOD 予算が pcFine の
    // 発行を止めてしまい、キャンセルすべき飛行中の要求が作れない
    const mb = opt('maxbytes', '')
    await page.goto(`${BASE}/?pc=1${mb ? `&maxbytes=${mb}` : ''}`, { waitUntil: 'commit' })
    await page.waitForFunction(
      () => globalThis.__iwagaki?.snapshot?.().milestones?.first_meaningful_render !== undefined,
      null, { timeout: 20_000 }).catch(() => {})
    // **点群の index が揃うまで待つ。** ここを待たずにカメラを振ると、
    // pcCoarse / pcFine がまだ 1 本も発行されていない状態でシナリオが終わり、
    // キャンセルされるのは地形タイルだけになる（実測: terrainFine 36 件に対し点群 0 件）。
    // 検証したいのは点群経路なので、要求が出ている状態を作ってから振る。
    await page.waitForFunction(
      () => globalThis.__iwagaki?.snapshot?.().milestones?.pc_index_loaded !== undefined,
      null, { timeout: 60_000 }).catch(() => {})
    // 細ノードの要求が飛ぶまでの猶予。飛ぶ前に振ると切る対象が無い
    await page.waitForTimeout(1500)

    // 読み込みが走っている最中に、視野を大きく変える操作を連続で当てる。
    //
    // **絶対座標で跳ぶ**。相対移動（dx/dy の足し込み）だと、点群の被覆から
    // 出たかどうかが積算の結果に左右されて確かめられない。
    // 実点群は歩いた帯（3.17 ha / AOI 100 ha）にしか無いので、
    // 被覆の中心に寄ってから被覆外の隅へ跳べば、発行済みノードが確実に
    // `wanted` から外れる。合成点群は AOI 全体を覆っていたので、
    // この状況が原理的に作れなかった（docs/web_results.md「キャンセル」）。
    const PC_CENTER = [135.328894, 35.456748]   // 点群 bounds の中心
    const AOI_SW = [135.323041, 35.453227]      // 被覆外
    const AOI_NE = [135.332888, 35.461394]      // 被覆外
    const moves = [
      { center: PC_CENTER, zoom: 18.2, bearing: 0, pitch: 60 },    // 点群を深く要求させる
      { center: AOI_SW, zoom: 18.0, bearing: 120, pitch: 70 },     // 被覆外へ跳ぶ
      { center: PC_CENTER, zoom: 18.5, bearing: -60, pitch: 75 },  // 戻して再要求
      { center: AOI_NE, zoom: 18.0, bearing: 200, pitch: 80 },     // 反対の隅へ
      { center: PC_CENTER, zoom: 13.2, bearing: 0, pitch: 0 },     // 引いて全部不要にする
    ]
    for (const m of moves) {
      await page.evaluate((mv) => {
        // zoom は上の表と docs/web_results.md に合わせて **MapLibre 基準**（タイル 512 px）で
        // 書いてある。Viewer は 256 px 基準なので +1 して渡す（docs/web_design.md「ズームの規約」）
        globalThis.__iwagaki.viewer.jumpTo({
          center: mv.center, zoom: mv.zoom + 1, bearing: mv.bearing, pitch: mv.pitch,
        })
      }, m)
      // 発行はされたが完了はしていない、という間に次を当てたい。
      //
      // **滞在時間はキャンセルが出るかを直接決める。** 実測すると、
      // 500 ms では絞りなしの回線で点群のノードが取り切れてしまい
      // （pcFine 3 本 4.32 MB が完了、キャンセル 0 件）、
      // 逆に絞った回線では LOD 予算が足りず pcFine が 1 本も出ない。
      // 「発行されるだけの帯域があり、かつ飛行中である」窓を作るために短くする。
      await page.waitForTimeout(Number(opt('dwell', '200')))
    }
    await page.waitForTimeout(4000)
    const snap = await page.evaluate(() => globalThis.__iwagaki.snapshot())
    out.push({ profile: `${p}/cancel`, load: snap,
               water_level_sweep: { requests_issued: null, quiescent: false },
               after_camera_move: { milestones: snap.milestones, scheduler: snap.scheduler,
                                    camera: snap.camera, pointcloud: snap.pointcloud },
               page_errors: [] })
    await page.screenshot({ path: path.join(HERE, 'results', `cancel-${p}.png`) })
    await ctx.close()
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
    mb(r.load.shell?.bytes),
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
// shell（コード）は毎回見る数字にする。FMR を決めているのはこれ（§8）
const head = ['profile', 'FMR ms', 'terrain ms', 'PLATEAU ms', 'pc useful ms',
  'MB shell', 'MB→FMR', 'MB@10s', 'reqs', 'peak', 'cancel', 'MB wasted', 'coalesce g/m',
  'decode p50', 'slider reqs', 'camera ms']
const rows = out.map(row)
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |'
console.log('\n' + line(head))
console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|')
for (const r of rows) console.log(line(r))
console.log(`\nwrote ${path.relative(process.cwd(), file)}`)
