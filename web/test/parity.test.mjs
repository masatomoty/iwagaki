// docs/WEB_DESIGN.md §8.4 の「正しさを守るテスト」。
// 性能とは別に、パッキングと判定ロジックが Python 側とずれていないことを押さえる。
//
//   node test/parity.test.mjs
//
// 事前に scripts/85_emit_parity_fixture.py でフィクスチャを作っておく。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fx = JSON.parse(readFileSync(path.join(HERE, 'fixtures/parity.json'), 'utf8'))

// --- assets/packing.ts と同じ式（TS を import せず、式そのものを二重化して比較する）---
const decodeElev = (r, g, b) => (r === 0 && g === 0 && b === 0 ? NaN : r * 256 + g + b / 256 - 32768)
const decodeHConn = (a, hStep) => (a === 0 ? Infinity : (a - 1) * hStep)

// --- domain/flood.ts と同じ式 ---
const wet = (h, H) => h !== undefined && Number.isFinite(h) && h <= H
const depth = (e, h, H) => (!wet(h, H) || e === undefined || !Number.isFinite(e) ? 0 : Math.max(0, H - e))
const roadClass = (d, th) => { let c = 0; for (let i = 0; i < th.length; i++) if (d >= th[i]) c = i + 1; return c }

let checked = 0
let failed = 0
const near = (a, b, tol, msg) => {
  checked++
  if (Number.isNaN(a) && Number.isNaN(b)) return
  if (!(Math.abs(a - b) <= tol)) { failed++; console.error(`FAIL ${msg}: ${a} vs ${b}`) }
}

// 1) タイルのパッキング往復
for (const s of fx.packing) {
  near(decodeElev(s.r, s.g, s.b), s.elev ?? NaN, 1 / 256 + 1e-9, `elev(${s.r},${s.g},${s.b})`)
  const h = decodeHConn(s.a, fx.h_step)
  const expected = s.h_conn === null ? Infinity : s.h_conn
  if (expected === Infinity) { checked++; if (h !== Infinity) { failed++; console.error('FAIL hconn inf') } }
  else near(h, expected, fx.h_step / 2 + 1e-9, `hconn(a=${s.a})`)
}

// 2) 地物ごとの浸水判定が Python(scripts/50) の出力と一致するか
for (const f of fx.features) {
  for (const [H, exp] of Object.entries(f.at)) {
    const h = Number(H)
    const db = depth(f.ground_elev_baseline, f.h_conn_baseline, h)
    const dh = depth(f.ground_elev_highres, f.h_conn_highres, h)
    near(db, exp.depth_baseline, 1e-6, `${f.gml_id} depth_baseline@${H}`)
    near(dh, exp.depth_highres, 1e-6, `${f.gml_id} depth_highres@${H}`)
    const changed = f.unreliable ? false
      : f.feature_type === 'tran:Road'
        ? roadClass(db, fx.road_depth_classes_m) !== roadClass(dh, fx.road_depth_classes_m)
        : (db > 0) !== (dh > 0)
    checked++
    if (changed !== exp.decision_changed) {
      failed++
      console.error(`FAIL ${f.gml_id} decision_changed@${H}: ${changed} vs ${exp.decision_changed}`)
    }
  }
}

// 3) GLSL に同じ定数が入っているか（式の二重管理が崩れていないかの最低限のガード）
const glsl = readFileSync(path.join(HERE, '../src/view/shaders/flood.ts'), 'utf8')
for (const token of ['32768', '256.0', 'flood.hStep', 'flood.waterLevel']) {
  checked++
  if (!glsl.includes(token)) { failed++; console.error(`FAIL glsl missing ${token}`) }
}

console.log(`parity: ${checked} checks, ${failed} failures`)
process.exit(failed ? 1 : 0)
