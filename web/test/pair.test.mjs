// 比較のペア（domain/terrain.ts の comparisonPair）と、
// ペアに対する判定（domain/flood.ts の decisionChanged）。
//
// **ペアの取り違えは絵を見ても気づけない。** 地形は差分タイルの色で塗られ、
// 地物は decisionChanged で塗られるので、片方だけ違う条件を見ていても
// 「それらしい絵」が出る。実際に、以前は baseline / highres が
// ハードコードされていて、`diff_pc` を選んでも赤い地物は 5m↔0.5m のままだった。
//
// parity.test.mjs と同じ方針で、**TS を import せず式そのものを二重化して**
// 実データ（catalog.semantics.url が指す geojson）に対する件数を突き合わせる。
// 相対 import に拡張子が無いので node からは TS を直接読めない。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'public', 'data')

// --- domain/terrain.ts の comparisonPair と同じ規則 ---
const comparisonPair = (surface) =>
  surface === 'diff' ? { from: 'baseline', to: 'highres' }
  : surface === 'diff_pc' ? { from: 'highres', to: 'pointcloud' }
  : { from: 'baseline', to: surface }

// --- domain/flood.ts と同じ式 ---
const depth = (elev, hConn, H) => {
  if (hConn === null || hConn === undefined || elev === null || elev === undefined) return 0
  if (!(hConn <= H)) return 0
  return Math.max(0, H - elev)
}
const roadClass = (d, th) => {
  let c = 0
  for (let i = 0; i < th.length; i++) if (d >= th[i]) c = i + 1
  return c
}
const decisionChanged = (p, H, th, pair) => {
  if (p.unreliable) return false
  if (pair.from === pair.to) return false
  const hf = p[`h_conn_${pair.from}`]
  const ht = p[`h_conn_${pair.to}`]
  if (hf === undefined || hf === null || ht === undefined || ht === null) return false
  const df = depth(p[`ground_elev_${pair.from}`], hf, H)
  const dt = depth(p[`ground_elev_${pair.to}`], ht, H)
  if (p.feature_type === 'tran:Road') {
    return roadClass(df, th) !== roadClass(dt, th)
  }
  return (df > 0) !== (dt > 0)
}

const catalog = JSON.parse(readFileSync(path.join(DATA, 'catalog.json'), 'utf8'))
// ファイル名には内容ハッシュが入る（docs/infra.md）。直書きしない
const features = JSON.parse(
  readFileSync(path.join(DATA, catalog.semantics.url.replace(/^data\//, '')), 'utf8'),
).features
const TH = catalog.semantics.road_depth_classes_m

let checks = 0
let failures = 0
const eq = (got, want, what) => {
  checks++
  if (got !== want) { failures++; console.error(`FAIL ${what}: ${got} vs ${want}`) }
}
const deepEq = (got, want, what) => {
  checks++
  try { assert.deepEqual(got, want) } catch { failures++; console.error(`FAIL ${what}`) }
}

// --- 1. surface -> ペア -------------------------------------------------------
// 差分は「その差分タイルが持つ 2 条件」、1 条件は「出発点 対 その条件」。
deepEq(comparisonPair('diff'), { from: 'baseline', to: 'highres' }, 'pair(diff)')
deepEq(comparisonPair('diff_pc'), { from: 'highres', to: 'pointcloud' }, 'pair(diff_pc)')
deepEq(comparisonPair('control'), { from: 'baseline', to: 'control' }, 'pair(control)')
deepEq(comparisonPair('highres'), { from: 'baseline', to: 'highres' }, 'pair(highres)')
deepEq(comparisonPair('pointcloud'), { from: 'baseline', to: 'pointcloud' }, 'pair(pointcloud)')
// 出発点そのものを見ているときは比較相手が自分になる
deepEq(comparisonPair('baseline'), { from: 'baseline', to: 'baseline' }, 'pair(baseline)')

// **既定のペアは以前のハードコードと同じ組でなければならない。**
// state.ts の初期値が 'highres' なので、既定の画面の意味が変わらないことを固定する。
deepEq(comparisonPair('highres'), comparisonPair('diff'), 'default pair == 旧ハードコード')

// --- 2. ペアごとの件数（実データ） -------------------------------------------
// 数字は配信中の geojson から数えたもの。判定規則が変わると動く。
const count = (surface, H) => {
  const pair = comparisonPair(surface)
  return features.filter((f) => decisionChanged(f.properties, H, TH, pair)).length
}
// **2026-08-24 に全部動いた。** 吉原の建物・道路を 3 次メッシュ 1 枚からしか
// 取っていなかったのを 4 枚に直し、911 -> 1,223 地物になったため
// （docs/results.md「3 次メッシュの取りこぼし」）。
// 旧値: 0.93 {95,140,18} / 1.0 {137,119,30} / 1.5 {32,40,14}
const EXPECT = {
  0.93: { highres: 106, control: 149, diff_pc: 22, baseline: 0 },
  1.0: { highres: 155, control: 136, diff_pc: 33, baseline: 0 },
  1.5: { highres: 43, control: 44, diff_pc: 16, baseline: 0 },
}
for (const [H, rows] of Object.entries(EXPECT)) {
  for (const [surface, want] of Object.entries(rows)) {
    eq(count(surface, Number(H)), want, `changed(${surface})@H=${H}`)
  }
}

// `diff` と `highres` は同じペアなので、件数も一致しなければならない
for (const H of [0.93, 1.0, 1.5]) {
  eq(count('diff', H), count('highres', H), `diff == highres @H=${H}`)
}

// --- 3. 規則としての性質 -----------------------------------------------------
// 向きを入れ替えても「変わったか」は同じ（対称）
for (const H of [0.93, 1.0, 1.5]) {
  const fwd = features.filter((f) =>
    decisionChanged(f.properties, H, TH, { from: 'highres', to: 'pointcloud' })).length
  const rev = features.filter((f) =>
    decisionChanged(f.properties, H, TH, { from: 'pointcloud', to: 'highres' })).length
  eq(fwd, rev, `対称 highres<->pointcloud @H=${H}`)
}

// 解析対象外（橋梁・高架・トンネル）は、どのペアでも「変わらない」
const unreliable = features.filter((f) => f.properties.unreliable)
eq(unreliable.length, 6, '解析対象外の件数')
for (const f of unreliable) {
  for (const surface of ['highres', 'control', 'pointcloud', 'diff', 'diff_pc']) {
    eq(decisionChanged(f.properties, 1.0, TH, comparisonPair(surface)), false,
      `unreliable ${f.properties.gml_id} ${surface}`)
  }
}

// **片方の条件に値が無い地物は「変わった」と言えない。**
// 点群は歩いた線に沿った帯しか無いので、h_conn(pointcloud) が無い地物がある
const noPc = features.filter((f) => f.properties.h_conn_pointcloud === null
  || f.properties.h_conn_pointcloud === undefined)
// 旧値 880（911 地物の時代）。3 次メッシュを 4 枚に直して 1,223 地物になった
eq(features.length - noPc.length, 1049, '点群の h_conn を持つ地物')
for (const f of noPc) {
  eq(decisionChanged(f.properties, 1.0, TH, comparisonPair('diff_pc')), false,
    `点群の値が無い ${f.properties.gml_id}`)
}

console.log(`pair: ${checks} checks, ${failures} failures`)
if (failures > 0) process.exit(1)
