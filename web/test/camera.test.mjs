// domain/camera.ts の換算を、画面を出さずに確かめる。
//
// ここが壊れていても絵は出る（点群がそれらしく描かれる）ので、
// 見て気づけない。実際、旧実装は視点が定数になっていて LOD が
// 働いていなかったのに、半年近く気づかれなかった。
//
//   node --experimental-strip-types test/camera.test.mjs
//   （TS のまま読めない環境では npm run build 後の dist を使う）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// tsc で 1 ファイルだけ JS にしてから読む。テストのために src を汚さない
const out = mkdtempSync(path.join(tmpdir(), 'iwagaki-cam-'))
// skipLibCheck を付ける。camera.ts は DOM も node も使わない純関数だが、
// 単体で tsc に掛けると @types/node の中の解決エラー（undici-types）を拾ってしまう
execFileSync('npx', ['tsc', 'src/domain/camera.ts', '--outDir', out,
                     '--module', 'es2022', '--target', 'es2022',
                     '--moduleResolution', 'bundler', '--skipLibCheck'],
             { stdio: 'inherit' })
writeFileSync(path.join(out, 'package.json'), '{"type":"module"}')
const cam = await import(path.join(out, 'camera.js'))

const ORIGIN = [135.3279642, 35.4573106]   // catalog.local_frame.origin_wgs84
let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok', name) }

check('原点はローカル (0,0)', () => {
  const [e, nn] = cam.lonLatToLocal(ORIGIN, ORIGIN)
  assert.ok(Math.abs(e) < 1e-9 && Math.abs(nn) < 1e-9)
})

check('AOI の WGS84 外接矩形が回転分だけ大きく出る', () => {
  // catalog.aoi.bbox_wgs84
  const [w, s, e, nth] = [135.3224183, 35.4527731, 135.3335096, 35.4618478]
  const [x0, y0] = cam.lonLatToLocal([w, s], ORIGIN)
  const [x1, y1] = cam.lonLatToLocal([e, nth], ORIGIN)
  // AOI は EPSG:6674 上で厳密に 1000 m 四方だが、平面直角座標は真北から
  // 約 0.39 度回っている（catalog.local_frame の行列の非対角 0.0068 = tan 0.39度）。
  // 回転した正方形の軸並行外接矩形は 1000 * (cos θ + sin θ) = 1006.8 m になる。
  // **この値が出ること自体が、ENU 近似が効いていることの確認になる。**
  const theta = Math.atan(0.006805373)
  const expect = 1000 * (Math.cos(theta) + Math.sin(theta))
  assert.ok(Math.abs((x1 - x0) - expect) < 2, `東西 ${(x1 - x0).toFixed(1)} m / 期待 ${expect.toFixed(1)} m`)
  assert.ok(Math.abs((y1 - y0) - expect) < 2, `南北 ${(y1 - y0).toFixed(1)} m / 期待 ${expect.toFixed(1)} m`)
})

check('metresPerPixel はズームで半分になる', () => {
  const a = cam.metresPerPixel(35.4573, 15)
  const b = cam.metresPerPixel(35.4573, 16)
  assert.ok(Math.abs(a / b - 2) < 1e-9)
})

const base = {
  centre: ORIGIN, zoom: 16, pitchDeg: 0, bearingDeg: 0,
  viewportHeight: 750, fovY: (Math.PI / 180) * 36.87, cameraToCentrePx: 1000,
}

check('pitch=0 なら注視点の真上', () => {
  const [e, nn, up] = cam.eyeInLocal(base, ORIGIN)
  assert.ok(Math.abs(e) < 1e-6 && Math.abs(nn) < 1e-6)
  assert.ok(up > 0)
})

check('**高度がズームで変わる**（旧実装が落としていた性質）', () => {
  const z16 = cam.eyeInLocal({ ...base, zoom: 16 }, ORIGIN)[2]
  const z18 = cam.eyeInLocal({ ...base, zoom: 18 }, ORIGIN)[2]
  assert.ok(z16 > z18, `z16 ${z16.toFixed(1)} m は z18 ${z18.toFixed(1)} m より高いはず`)
  assert.ok(Math.abs(z16 / z18 - 4) < 1e-6, 'ズーム 2 段で 4 倍')
})

check('pitch を倒すと低くなり、後ろに下がる', () => {
  const flat = cam.eyeInLocal(base, ORIGIN)
  const tilt = cam.eyeInLocal({ ...base, pitchDeg: 60 }, ORIGIN)
  assert.ok(tilt[2] < flat[2], '高度が下がる')
  assert.ok(Math.hypot(tilt[0], tilt[1]) > 1, '水平にずれる')
  // 距離は保たれる（カメラ〜注視点は pitch に依らない）
  assert.ok(Math.abs(Math.hypot(...tilt) - Math.hypot(...flat)) < 1e-6)
})

check('bearing=0 で傾けるとカメラは南（north が負）へ下がる', () => {
  const [e, nn] = cam.eyeInLocal({ ...base, pitchDeg: 60, bearingDeg: 0 }, ORIGIN)
  assert.ok(Math.abs(e) < 1e-6)
  assert.ok(nn < 0, `north ${nn.toFixed(1)} は負のはず`)
})

check('bearing=90 で傾けるとカメラは西（east が負）へ下がる', () => {
  const [e, nn] = cam.eyeInLocal({ ...base, pitchDeg: 60, bearingDeg: 90 }, ORIGIN)
  assert.ok(e < 0, `east ${e.toFixed(1)} は負のはず`)
  assert.ok(Math.abs(nn) < 1e-6)
})

check('注視点を動かすと視点も動く（旧実装が落としていた性質）', () => {
  const here = cam.eyeInLocal(base, ORIGIN)
  const there = cam.eyeInLocal({ ...base, centre: [ORIGIN[0] + 0.005, ORIGIN[1]] }, ORIGIN)
  assert.ok(there[0] - here[0] > 300, `東へ 0.005 度 = 約 450 m 動くはず`)
})

check('visibleBoxLocal は原点中心の bbox を包む', () => {
  const b = cam.visibleBoxLocal([ORIGIN[0] - 0.001, ORIGIN[1] - 0.001,
                                 ORIGIN[0] + 0.001, ORIGIN[1] + 0.001], ORIGIN, 10)
  assert.ok(b[0] < -10 && b[1] < -10 && b[2] > 10 && b[3] > 10)
})

check('boxesOverlap', () => {
  assert.equal(cam.boxesOverlap([0, 0, 10, 10], [5, 5, 15, 15]), true)
  assert.equal(cam.boxesOverlap([0, 0, 10, 10], [11, 0, 20, 10]), false)
  assert.equal(cam.boxesOverlap([0, 0, 10, 10], [0, 11, 10, 20]), false)
  // 接している場合は重なりとみなす（落としすぎるより安全）
  assert.equal(cam.boxesOverlap([0, 0, 10, 10], [10, 10, 20, 20]), true)
})

console.log(`\n${n} 件すべて通過`)
