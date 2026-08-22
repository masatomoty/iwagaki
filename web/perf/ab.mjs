// 同一デプロイに対して A/B を交互に n 回まわし、指標のばらつきごと見る。
// 1 回の計測で結論を出すと、実測のばらつき（無絞りで terrain が 551 と 992 の幅）に
// 引っかかる。交互にやるのは、時間帯による回線変動を両条件に等しく乗せるため。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const ROUNDS = Number(process.env.ROUNDS ?? 3)
const KEYS = ['first_meaningful_render', 'time_to_terrain', 'time_to_plateau',
              'time_to_first_useful_pc', 'time_to_pc_refined']
const PROFILES = ['normal', 'fast4g', 'slow-highrtt', 'fatpipe-highrtt']

const run = (label, defer) => {
  execFileSync(process.execPath, ['perf/run.mjs', `--suffix=?pc=1&defer=${defer}`,
                                  `--label=${label}`],
               { env: { ...process.env, BASE }, stdio: 'ignore' })
  return JSON.parse(readFileSync(`perf/results/profiles${label}.json`, 'utf8'))
}

const acc = { on: {}, off: {} }
for (const p of PROFILES) { acc.on[p] = {}; acc.off[p] = {} }

for (let i = 1; i <= ROUNDS; i++) {
  for (const [arm, defer] of [['off', '0'], ['on', '1']]) {
    const rows = run(`ab-${arm}-${i}`, defer)
    for (const r of rows) {
      const m = r.after_camera_move?.milestones ?? {}
      for (const k of KEYS) {
        (acc[arm][r.profile][k] ??= []).push(m[k] ?? null)
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

for (const p of PROFILES) {
  console.log(`\n== ${p}`)
  for (const k of KEYS) {
    console.log(`   ${k.padEnd(26)} off ${fmt(acc.off[p][k]).padEnd(30)} on ${fmt(acc.on[p][k])}`)
  }
}
