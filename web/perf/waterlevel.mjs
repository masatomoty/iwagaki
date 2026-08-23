// 水位を変えたときに画面が変わるかを、画素で確かめる。
// 設計上ここはシェーダの uniform を書き換えるだけで、
// 再取得も再計算も発生しないはず（docs/README「連結浸水開始水位」）。
import { chromium } from '@playwright/test'
import sharp from 'sharp'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const LEVELS = [0.2, 1.0, 2.0, 3.0]

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)) })

await p.goto(`${BASE}/?pc=0`, { waitUntil: 'load' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_terrain !== undefined,
  null, { timeout: 60_000 }).catch(() => {})
await p.evaluate(() => {
  globalThis.__iwagaki.setLayer('plateau', false)
  globalThis.__iwagaki.setLayer('semantics', false)
  globalThis.__iwagaki.setLayer('pcCoverage', false)
})
await p.waitForTimeout(2500)

/** 青（浸水色）の画素数を数える。水位を上げれば増えるはず */
const blueCount = async (f) => {
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true })
  let n = 0
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], bl = data[i + 2]
    if (bl > 70 && bl > r + 25 && bl > g + 10) n++
  }
  return n
}

const before = []
for (const h of LEVELS) {
  await p.evaluate((v) => globalThis.__iwagaki.setWaterLevel(v), h)
  await p.waitForTimeout(1200)
  const f = `perf/shots/wl-${h}.png`
  await p.screenshot({ path: f })
  const state = await p.evaluate(() => ({
    waterLevel: globalThis.__iwagaki.store.state.waterLevel,
    reqs: globalThis.__iwagaki.scheduler.stats().issued,
  }))
  const blue = await blueCount(f)
  before.push({ h, blue, ...state })
  console.log(`H=${h.toFixed(2)}  state.waterLevel=${state.waterLevel}  青画素=${blue}  累計req=${state.reqs}`)
}

await b.close()

// --- 判定 -----------------------------------------------------------------
// 期待する性質は 2 つ。どちらも設計の根幹なので、片方でも崩れたら失敗にする。
//   1. 水位を上げると浸水域は単調に増える
//   2. 水位を変えてもリクエストは増えない（h_conn を 1 枚持つ設計）
let ok = true
for (let i = 1; i < before.length; i++) {
  if (before[i].blue <= before[i - 1].blue) {
    console.log(`NG: H=${before[i - 1].h} -> ${before[i].h} で浸水域が増えていない `
      + `(${before[i - 1].blue} -> ${before[i].blue})`)
    ok = false
  }
}
const reqDelta = before.at(-1).reqs - before[0].reqs
if (reqDelta > 2) {
  console.log(`NG: 水位変更で ${reqDelta} 本のリクエストが増えた。`
    + '水位はシェーダの uniform だけで表現するはず')
  ok = false
}
if (errs.length) { console.log('NG: page error', [...new Set(errs)].slice(0, 3)); ok = false }
console.log(ok ? '\nOK: 水位が画面に反映され、再取得も起きていない' : '\n失敗')
process.exit(ok ? 0 : 1)
