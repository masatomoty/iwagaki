// coalescing の on/off を交互に n 回まわして中央値と範囲を出す。
// §4.1 の on/off 比較はノード 11〜14 本の合成点群時代のもので、
// 実点群（1,594 ノード）でやり直す必要があった。
// 1 回ずつの比較では判断できない（docs/WEB_RESULTS.md「計測時の注意」）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'https://iwagaki-viewer.tonbo.workers.dev'
const ROUNDS = Number(process.env.ROUNDS ?? 3)
const PROFILES = process.env.PROFILES ?? 'normal,fast4g,fatpipe-highrtt'
const KEYS = ['first_meaningful_render', 'time_to_first_useful_pc', 'time_to_pc_refined']

const acc = new Map()   // "profile/coalesce=n" -> {key: []}
const push = (row, key, v) => {
  const m = acc.get(row) ?? {}
  ;(m[key] ??= []).push(v)
  acc.set(row, m)
}

for (let i = 1; i <= ROUNDS; i++) {
  execFileSync(process.execPath,
    ['perf/run.mjs', '--scenario=coalesce', `--profiles=${PROFILES}`, `--label=coalab-${i}`],
    { env: { ...process.env, BASE }, stdio: 'ignore' })
  const rows = JSON.parse(readFileSync(`perf/results/coalescecoalab-${i}.json`, 'utf8'))
  for (const r of rows) {
    const m = r.after_camera_move?.milestones ?? {}
    for (const k of KEYS) push(r.profile, k, m[k] ?? null)
    // まとめられた本数そのものも見る。0 なら比較の前提が無い
    const c = r.after_camera_move?.scheduler?.coalesced
    push(r.profile, 'coalesced_members', c ? c.members : null)
  }
  process.stderr.write(`round ${i} done\n`)
}

const fmt = (xs) => {
  const v = (xs ?? []).filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (v.length === 0) return '—'
  return `${v[(v.length - 1) >> 1]} (n=${v.length}, ${v[0]}–${v[v.length - 1]})`
}
for (const [row, m] of [...acc].sort()) {
  console.log(`\n== ${row}`)
  for (const k of [...KEYS, 'coalesced_members']) {
    console.log(`   ${k.padEnd(26)} ${fmt(m[k])}`)
  }
}
