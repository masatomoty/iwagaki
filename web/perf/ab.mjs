// 同一デプロイに対して A/B を交互に n 回まわし、指標のばらつきごと見る。
// 1 回の計測で結論を出すと、実測のばらつき（無絞りで terrain が 551 と 992 の幅）に
// 引っかかる。交互にやるのは、時間帯による回線変動を両条件に等しく乗せるため。
//
//   FLAG=defer ROUNDS=3 node perf/ab.mjs     # 既定。?defer=0/1
//   FLAG=rgb   ROUNDS=3 node perf/ab.mjs     # 点群の色（?rgb=0/1）
//   KEYS=decode_p50 FLAG=rgb node perf/ab.mjs
//
// **フラグ名を決め打ちにしない。** 比べたいものが増えるたびにこのファイルを
// 複製するのは筋が悪い（`?sat=` を足そうとして気づいた）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const ROUNDS = Number(process.env.ROUNDS ?? 3)
const FLAG = process.env.FLAG ?? 'defer'
const KEYS = (process.env.KEYS ?? 'first_meaningful_render,time_to_terrain,time_to_plateau,'
  + 'time_to_first_useful_pc,time_to_pc_refined').split(',')
const PROFILES = (process.env.PROFILES ?? 'normal,fast4g,slow-highrtt,fatpipe-highrtt').split(',')

const run = (label, value) => {
  execFileSync(process.execPath, ['perf/run.mjs', `--suffix=?pc=1&${FLAG}=${value}`,
                                  `--label=${label}`, `--profiles=${PROFILES.join(',')}`],
               { env: { ...process.env, BASE }, stdio: 'ignore' })
  return JSON.parse(readFileSync(`perf/results/profiles${label}.json`, 'utf8'))
}

const acc = { on: {}, off: {} }
for (const p of PROFILES) { acc.on[p] = {}; acc.off[p] = {} }

for (let i = 1; i <= ROUNDS; i++) {
  for (const [arm, value] of [['off', '0'], ['on', '1']]) {
    const rows = run(`ab-${arm}-${i}`, value)
    for (const r of rows) {
      const m = r.after_camera_move?.milestones ?? {}
      // マイルストーン以外（decode_p50 など）も比べられるようにする
      const extra = {
        decode_p50: r.after_camera_move?.decode_ms?.p50 ?? r.load?.decode_ms?.p50 ?? null,
        decode_p95: r.after_camera_move?.decode_ms?.p95 ?? r.load?.decode_ms?.p95 ?? null,
      }
      for (const k of KEYS) {
        (acc[arm][r.profile][k] ??= []).push(m[k] ?? extra[k] ?? null)
      }
    }
    process.stderr.write(`round ${i} ${arm} done\n`)
  }
}

const med = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  return v.length === 0 ? null : v[(v.length - 1) >> 1]
}
const fmt = (xs) => {
  const v = xs.filter((x) => typeof x === 'number')
  if (v.length === 0) return '—'
  return `${med(xs)} (n=${v.length}/${xs.length}, ${Math.min(...v)}–${Math.max(...v)})`
}

console.log(`\nFLAG=${FLAG}  ROUNDS=${ROUNDS}  BASE=${BASE}`)
for (const p of PROFILES) {
  console.log(`\n== ${p}`)
  for (const k of KEYS) {
    console.log(`   ${k.padEnd(26)} off ${fmt(acc.off[p][k]).padEnd(30)} on ${fmt(acc.on[p][k])}`)
  }
}
