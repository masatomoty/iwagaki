// 交通規制と潮位掃引の純関数テスト。
// 判定は scripts/91_traffic_regulation.py::regulation_of と同一に保つ。
//
//   pnpm test

import assert from 'node:assert/strict'

// domain/flood.ts と同じ式。TS を node --test で直接読まない既存テストの形に合わせる。
const regulation = (depth, frontage5) => {
  if (!Number.isFinite(depth) || depth <= 0) return 'none'
  if (depth >= 0.15) return 'stop'
  if (frontage5 !== undefined && Number.isFinite(frontage5) && frontage5 >= 1) return 'consider'
  return 'slow'
}
const tideAt = (points, t) => {
  if (t <= points[0].t) return points[0].v
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i]
      const k = (t - a.t) / (b.t - a.t)
      return a.v + k * (b.v - a.v)
    }
  }
  return points[points.length - 1].v
}
const advanced = (points, t, dt, speed) => {
  const end = points[points.length - 1].t
  const next = Math.min(end, t + dt * speed)
  return { t: next, atEnd: next >= end }
}

assert.equal(regulation(0, undefined), 'none')
assert.equal(regulation(0.001, 0), 'slow')
assert.equal(regulation(0.10, undefined), 'slow')
assert.equal(regulation(0.10, 1), 'consider')
assert.equal(regulation(0.149, 5), 'consider')
assert.equal(regulation(0.15, 0), 'stop')
assert.equal(regulation(0.30, undefined), 'stop')

const points = [{ t: 0, v: 0.3 }, { t: 1000, v: 0.5 }, { t: 2000, v: 0.4 }]
assert.equal(tideAt(points, 0), 0.3)
assert.equal(tideAt(points, 500), 0.4)
assert.equal(tideAt(points, 3000), 0.4)
assert.deepEqual(advanced(points, 0, 100, 3), { t: 300, atEnd: false })
assert.deepEqual(advanced(points, 1900, 100, 3), { t: 2000, atEnd: true })

console.log('regulation + tide sweep: ok')
