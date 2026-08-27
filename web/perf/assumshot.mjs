// 「仮定の段階」レイヤが実際に描かれているかを見る。
//
//   node perf/assumshot.mjs
//
// **GLSL のコンパイルエラーは実行時にしか出ない**ので、typecheck と build では
// 足りない。3 段（面の青 / 斜線 2 種）が画面に出ていることまで確かめる。
// 判定そのものの正しさはタイルを直接数えて解析ラスタと突き合わせてある
// （docs/results.md「仮定の段階」）。ここが見るのは**描画**である。
//
// 事前に `pnpm build` と `node serve.mjs`（別プロセス）が必要。
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'https://localhost:8443'
const PY = process.env.PY ?? '../.venv/bin/python'
const MODES = ['highres', 'diff_drainage', 'assumption']
/** floodMaterial.ts の assumptionFill() と同じ 3 色（0-255） */
const STEPS = [['3段 仮定なし', 41, 87, 148],
               ['2段 吐口があれば', 77, 143, 194],
               ['1段 経路を示せない', 140, 189, 219]]

const b = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 720 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)) })

// 仮想排水路は東舞鶴にしか焼いていない（config.CONDITIONS_BY_AOI）
await p.goto(`${BASE}/?area=higashi_maizuru&pc=0`, { waitUntil: 'load' })
await p.waitForFunction(
  () => globalThis.__iwagaki?.snapshot?.().milestones?.time_to_terrain !== undefined,
  null, { timeout: 60_000 }).catch(() => {})
await p.evaluate(() => {
  globalThis.__iwagaki.setLayer('plateau', false)
  globalThis.__iwagaki.setLayer('semantics', false)
  globalThis.__iwagaki.setWaterLevel(0.93)      // 既往最高潮位
})
await p.waitForTimeout(4000)

const shots = []
for (const m of MODES) {
  await p.evaluate((v) => globalThis.__iwagaki.setSurface(v), m)
  await p.waitForTimeout(6000)
  const f = `perf/shots/assum-${m}.png`
  await p.screenshot({ path: f })
  shots.push([m, f])
}
await b.close()

// 画素の数えは Pillow に出す（test/png.test.mjs と同じ理由。JS 側に画像依存を足さない）
const script = `
import sys, json
import numpy as np
from PIL import Image
steps = json.loads(sys.argv[1])
for mode, f in json.loads(sys.argv[2]):
    a = np.asarray(Image.open(f).convert('RGB')).astype(int)
    lit = float(((a > 40).any(-1)).mean() * 100)
    hits = [int((np.abs(a - np.array(s[1:])).max(-1) < 26).sum()) for s in steps]
    print(f"{mode:<14} 明るい画素 {lit:5.1f} %  "
          + " / ".join(f"{s[0]} {h:>6}" for s, h in zip(steps, hits)))
    if mode == 'assumption' and min(hits) == 0:
        raise SystemExit(f"{mode}: 出ていない段がある {hits}")
`
console.log(execFileSync(PY, ['-c', script, JSON.stringify(STEPS), JSON.stringify(shots)],
                         { encoding: 'utf8' }).trim())
console.log('errors:', [...new Set(errs)].slice(0, 5).join(' || ') || '(なし)')
