// PLATEAU の tileset がどこで止まっているかを直接見る。
// time_to_plateau が立たない原因が「読み込みが終わっていない」のか
// 「終わっているのに指標が立たない」のかを切り分ける。
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const PC = process.env.PC ?? '1'
// headless では rAF が絞られ、deck.gl の tileset traversal がほとんど進まない。
// 既定は headed。HEADED=0 で headless にして比較できる
const b = await chromium.launch({
  headless: process.env.HEADED === '0',
  args: ['--ignore-certificate-errors'],
})
const p = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 750 } })
  .then((c) => c.newPage())
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)) })

await p.goto(`${BASE}/?pc=${PC}`, { waitUntil: 'load' })

for (const t of [3000, 8000, 15000, 25000]) {
  await p.waitForTimeout(t === 3000 ? t : t - (t === 8000 ? 3000 : t === 15000 ? 8000 : 15000))
  const s = await p.evaluate(() => {
    const snap = globalThis.__iwagaki?.snapshot?.() ?? {}
    const ts = globalThis.__iwagaki?.plateauTileset?.()
    return {
      plateau: snap.plateau,
      time_to_plateau: snap.milestones?.time_to_plateau ?? null,
      tileset: ts
        ? {
            isLoaded: typeof ts.isLoaded === 'function' ? ts.isLoaded() : `型=${typeof ts.isLoaded}`,
            pending: ts._pendingCount, frame: ts._frameNumber,
            requested: ts._requestedTiles?.length, selected: ts.selectedTiles?.length,
            tiles: ts.tiles?.length, gpuMemory: ts.gpuMemoryUsageInBytes,
            maxMemory: ts.options?.maximumMemoryUsage,
          }
        : '(tileset が公開されていない)',
    }
  })
  console.log(`t=${t}ms`, JSON.stringify(s))
}
console.log('errors:', [...new Set(errs)].slice(0, 6).join(' || ') || '(なし)')
await b.close()
