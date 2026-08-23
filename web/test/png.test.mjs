// assets/png.ts が焼いたタイルを正しく復号するかを、Python 側と突き合わせる。
//
// canvas 経由の読み戻しは A < 255 の画素で RGB が壊れる。ここが壊れると
// 断面の標高が静かに狂う（実際に 1.5 m のはずが 32512 m として読めた）ので、
// **絵ではなく値で**検査する。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const TILE = process.env.TILE
  ?? path.join(ROOT, 'web/public/data/tiles/highres/18/229614/103429.png')

const out = mkdtempSync(path.join(tmpdir(), 'iwagaki-png-'))
execFileSync('pnpm', ['exec', 'tsc', 'src/assets/png.ts', '--outDir', out,
                     '--module', 'es2022', '--target', 'es2022',
                     '--moduleResolution', 'bundler', '--skipLibCheck', '--lib', 'es2022,dom'],
             { cwd: path.join(ROOT, 'web'), stdio: 'inherit' })
writeFileSync(path.join(out, 'package.json'), '{"type":"module"}')
const { decodeRgba8 } = await import(path.join(out, 'png.js'))

const bytes = new Uint8Array(readFileSync(TILE))
const img = await decodeRgba8(bytes)
assert.equal(img.width, 256)
assert.equal(img.height, 256)
assert.equal(img.data.length, 256 * 256 * 4)

// Python（Pillow）で同じタイルを読んで、全画素を突き合わせる
const py = path.join(ROOT, '.venv/bin/python')
const ref = JSON.parse(execFileSync(py, ['-c', `
import json, sys
from PIL import Image
import numpy as np
a = np.asarray(Image.open(sys.argv[1]).convert('RGBA'))
print(json.dumps({'shape': list(a.shape), 'sum': int(a.astype('int64').sum()),
                  'sample': [[int(v) for v in a[r, c]] for r, c in
                             ((0,0),(0,255),(255,0),(255,255),(128,128),(37,201))]}))
`, TILE]).toString())

assert.deepEqual([img.height, img.width, 4], ref.shape)
let sum = 0
for (const v of img.data) sum += v
assert.equal(sum, ref.sum, '全画素の総和が Pillow と一致しない')

const at = (r, c) => [...img.data.subarray((r * 256 + c) * 4, (r * 256 + c) * 4 + 4)]
const spots = [[0, 0], [0, 255], [255, 0], [255, 255], [128, 128], [37, 201]]
spots.forEach(([r, c], i) => assert.deepEqual(at(r, c), ref.sample[i], `画素 (${r},${c})`))

// 標高として意味のある範囲に入っているか（吉原の AOI は 0〜153 m）
const { decodeElev } = await import(path.join(ROOT, 'web/src/assets/packing.ts'))
  .catch(() => ({ decodeElev: (r, g, b) => (r === 0 && g === 0 && b === 0)
    ? NaN : r * 256 + g + b / 256 - 32768 }))
let n = 0
let bad = 0
for (let i = 0; i < img.data.length; i += 4) {
  const e = decodeElev(img.data[i], img.data[i + 1], img.data[i + 2])
  if (!Number.isFinite(e)) continue
  n++
  if (e < -20 || e > 200) bad++
}
assert.ok(n > 1000, `有効画素が少なすぎる (${n})`)
assert.equal(bad, 0, `範囲外の標高が ${bad} 画素`)

console.log(`OK: ${TILE.split('/').slice(-3).join('/')} を Pillow と全画素一致で復号`)
console.log(`    有効 ${n} 画素、標高はすべて -20〜200 m の範囲`)
