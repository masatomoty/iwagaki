// 点群 LOD のバイト予算を A/B する（docs/TODO.md F2）。
//
// 既定は `maxBytes = 帯域推定 × 6`（下限 2 MB / 上限 20 MB）。
// 「遅い回線ほど細部を諦める」という設計だが、根拠を測っていない。
//
// 前提が 2 つ変わったので測り直す:
//   1. LOD がカメラに追従するようになった（F1）。視錐台で絞るぶん、
//      同じ予算でも選ばれるノードが減る
//   2. キャンセルが効くようになった。取りすぎても途中で切れる＝
//      予算を厳しくする理由が 1 つ減った
//
//   ROUNDS=2 BASE=... node perf/budgetab.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const ROUNDS = Number(process.env.ROUNDS ?? 2)
const PROFILES = process.env.PROFILES ?? 'fast4g,slow-highrtt,fatpipe-highrtt'
/** '' は既定（帯域推定 × 6） */
const ARMS = (process.env.ARMS ?? ',2000000,8000000,40000000').split(',')
const KEYS = ['time_to_first_useful_pc', 'time_to_pc_refined']

const acc = new Map()   // "profile / arm" -> {key: []}
const push = (row, key, v) => {
  const m = acc.get(row) ?? {}
  ;(m[key] ??= []).push(v)
  acc.set(row, m)
}

for (let i = 1; i <= ROUNDS; i++) {
  for (const arm of ARMS) {
    const label = `budget-${arm || 'auto'}-${i}`
    execFileSync(process.execPath,
      ['perf/run.mjs', `--suffix=?pc=1${arm ? `&maxbytes=${arm}` : ''}`,
       `--profiles=${PROFILES}`, `--label=${label}`],
      { env: { ...process.env, BASE }, stdio: 'ignore' })
    for (const r of JSON.parse(readFileSync(`perf/results/profiles${label}.json`, 'utf8'))) {
      const row = `${r.profile} / ${arm ? `${Number(arm) / 1e6} MB` : '既定'}`
      const m = r.after_camera_move?.milestones ?? {}
      for (const k of KEYS) push(row, k, m[k] ?? null)
      const bc = r.after_camera_move?.scheduler?.byClass ?? {}
      const pcBytes = ['pcCoarse', 'pcFine'].reduce((s, k) => s + (bc[k]?.wireBytes ?? 0), 0)
      push(row, 'pc_wire_kB', Math.round(pcBytes / 1e3))
      push(row, 'pc_points', r.after_camera_move?.pointcloud?.residentPoints ?? null)
      push(row, 'wasted_kB', Math.round((r.after_camera_move?.scheduler?.wastedBytes ?? 0) / 1e3))
    }
    process.stderr.write(`round ${i} arm=${arm || 'auto'} done\n`)
  }
}

const med = (xs) => {
  const v = (xs ?? []).filter((x) => typeof x === 'number').sort((a, b) => a - b)
  return v.length === 0 ? null : v[(v.length - 1) >> 1]
}
const fmt = (xs) => {
  const v = (xs ?? []).filter((x) => typeof x === 'number')
  if (v.length === 0) return '—'
  return `${med(xs)}`.padStart(7) + (v.length > 1 ? ` (${Math.min(...v)}–${Math.max(...v)})` : '')
}
const rows = [...acc].sort()
console.log(`\n${'profile / 予算'.padEnd(34)}${'useful'.padStart(9)}${'refined'.padStart(9)}` +
            `${'pc kB'.padStart(9)}${'点数'.padStart(10)}${'無駄kB'.padStart(9)}`)
for (const [row, m] of rows) {
  console.log(row.padEnd(34) +
    fmt(m.time_to_first_useful_pc).padStart(9) + fmt(m.time_to_pc_refined).padStart(9) +
    fmt(m.pc_wire_kB).padStart(9) + fmt(m.pc_points).padStart(10) +
    fmt(m.wasted_kB).padStart(9))
}
