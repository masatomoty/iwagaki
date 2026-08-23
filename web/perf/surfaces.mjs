// 6 つの地形モードを順に切り替えて、全部描けているかを確認する。
// タイルが焼けていない条件を選ぶと真っ黒になるので、
// 「載せたつもりで載っていない」を検出するのが目的。
import { chromium } from '@playwright/test'
import sharp from 'sharp'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const MODES = ['baseline', 'highres', 'control', 'pointcloud', 'diff', 'diff_pc']

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 720 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 160)) })

await p.goto(`${BASE}/?pc=0`, { waitUntil: 'load' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_terrain !== undefined,
  null, { timeout: 60_000 }).catch(() => {})
await p.evaluate(() => {
  globalThis.__iwagaki.setLayer('plateau', false)
  globalThis.__iwagaki.setLayer('semantics', false)
  globalThis.__iwagaki.setLayer('pcCoverage', false)
})

for (const m of MODES) {
  await p.evaluate((v) => globalThis.__iwagaki.setSurface(v), m)
  await p.waitForTimeout(6000)
  const f = `perf/shots/surface-${m}.png`
  await p.screenshot({ path: f })
  // 地形が描かれていれば、暗い背景以外の画素がそれなりにある
  const { data, info } = await sharp(f).greyscale().raw()
    .toBuffer({ resolveWithObject: true })
  let lit = 0
  for (let i = 0; i < data.length; i++) if (data[i] > 40) lit++
  const pct = (lit / (info.width * info.height)) * 100
  console.log(`${m.padEnd(11)} 明るい画素 ${pct.toFixed(1).padStart(5)} %  ${pct < 5 ? '← 描けていない可能性' : ''}`)
}
console.log('errors:', [...new Set(errs)].slice(0, 5).join(' || ') || '(なし)')
await b.close()
