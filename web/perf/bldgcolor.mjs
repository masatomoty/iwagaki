// PLATEAU 建物の属性色分けのコストを測る。
//
// 色は b3dm の glTF に焼き込む（属性値ごとに primitive を分ける）ので、
// タイルあたりの primitive 数 = draw call が増える。増分と、
// カメラ操作中のフレーム時間への影響を実測する。
//
// headless で回す。非 headless の macOS だとウィンドウが他のウィンドウに隠れた
// 瞬間に Chromium が requestAnimationFrame を止め、deck.gl のタイル走査ごと
// 停止する（タイルが 1 枚も来ず time_to_plateau が立たない）。
// swiftshader なのでフレーム時間の絶対値は実 GPU と比べられない。比べるのはモード間の差。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://localhost:8443'
const OUT = process.env.OUT ?? 'perf/shots'
// HEADLESS=0 で実 GPU に切り替えられる（フレーム時間の絶対値を見るとき）。
// ただしウィンドウが前面にある間しか測れない
const HEADLESS = process.env.HEADLESS !== '0'
const browser = await chromium.launch({
  headless: HEADLESS,
  args: HEADLESS
    ? ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader',
       '--enable-unsafe-swiftshader']
    : ['--ignore-certificate-errors', '--disable-backgrounding-occluded-windows',
       '--disable-renderer-backgrounding'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)))
await page.bringToFront()
await page.goto(BASE + '/', { waitUntil: 'load' })
await page.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_plateau !== undefined,
  null, { timeout: 60000 })
await page.waitForTimeout(3000)

/** カメラをドラッグしながらフレーム時間を取る（静止時の rAF は 60 fps 上限で潰れる） */
async function drag() {
  await page.evaluate(() => {
    globalThis.__ft = []
    let last = performance.now()
    const tick = () => {
      const n = performance.now(); globalThis.__ft.push(n - last); last = n
      if (globalThis.__ft.length < 300) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.mouse.move(700, 500)
  await page.mouse.down()
  for (let i = 0; i < 32; i++) {
    await page.mouse.move(700 + Math.cos(i / 5) * 200, 500 + Math.sin(i / 5) * 130)
    await page.waitForTimeout(25)
  }
  await page.mouse.up()
  await page.waitForTimeout(400)
  return page.evaluate(() => {
    const t = globalThis.__ft.filter((x) => x > 0).sort((a, b) => a - b)
    return { p50: +t[Math.floor(t.length * 0.5)].toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(1) }
  })
}

for (const mode of ['none', 'usage', 'class']) {
  await page.evaluate((m) => { globalThis.__mode = m; globalThis.__iwagaki.setBuildingColor(m) }, mode)
  // レイヤを作り直すので、22 タイルが揃って落ち着いてから測る。
  // 切り替え直後に測るとタイルの再パースと GPU アップロードを測ることになる
  await page.waitForFunction(() => {
    const p = globalThis.__iwagaki.snapshot().plateau
    return p.colorMode === globalThis.__mode && p.loaded >= p.expected
  }, null, { timeout: 30000 }).catch(() => console.log('  ! タイルが揃わない'))
  await page.waitForTimeout(3000)
  const p = await page.evaluate(() => globalThis.__iwagaki.snapshot().plateau)
  const bytes = await page.evaluate(() => globalThis.__iwagaki.scheduler.stats().byClass.plateau)
  const legend = await page.evaluate(() => [...document.querySelectorAll('#bldglegend div')]
    .map((d) => d.textContent.replace(/\s+/g, ' ').trim()))
  await page.screenshot({ path: `${OUT}/bldgcolor-${mode}.png` })
  const f = await drag()
  console.log(`[${mode}] タイル ${p.loaded}/${p.expected} 失敗 ${p.failed} / primitive ${p.primitives}`
    + ` / 色が付いた棟 ${p.coloured}/${p.buildings} / frame p50 ${f.p50} p95 ${f.p95} ms`
    + ` / plateau 転送 ${(bytes.bytes / 1e6).toFixed(2)} MB (${bytes.issued} req)`)
  if (legend.length) console.log(`  凡例: ${legend.join(' | ')}`)
}
console.log('milestones', JSON.stringify(await page.evaluate(() => globalThis.__iwagaki.snapshot().milestones)))
await browser.close()
