// 標高基準（測地成果2011／2024）の表示変換（`domain/elevationDatum.ts`）の純関数。
//
//   node --test test/elevationDatum.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ELEVATION_DATUM, displayTpFormatter, fromDisplayTp, toDisplayTp,
} from '../src/domain/elevationDatum.ts'

// docs/data.md「標高成果の世代」の実測値（吉原の3次メッシュ、水準点用パラメータ）
const SHIFT_M = -0.19031

test('DEFAULT_ELEVATION_DATUM は新（測地成果2024。気象庁の公表値と揃える）', () => {
  assert.equal(DEFAULT_ELEVATION_DATUM, 'jgd2024')
})

test('toDisplayTp は jgd2011 なら内部値をそのまま返す', () => {
  assert.equal(toDisplayTp(0.69, 'jgd2011', SHIFT_M), 0.69)
})

test('toDisplayTp は jgd2024 なら shift を足す', () => {
  assert.equal(toDisplayTp(0.69, 'jgd2024', SHIFT_M), 0.69 + SHIFT_M)
})

test('fromDisplayTp は toDisplayTp の逆変換になる（往復で内部値に戻る）', () => {
  for (const datum of ['jgd2011', 'jgd2024']) {
    const internal = 0.545
    const displayed = toDisplayTp(internal, datum, SHIFT_M)
    assert.ok(Math.abs(fromDisplayTp(displayed, datum, SHIFT_M) - internal) < 1e-9)
  }
})

test('displayTpFormatter は toDisplayTp を部分適用したもの', () => {
  const f = displayTpFormatter('jgd2024', SHIFT_M)
  assert.equal(f(0.93), toDisplayTp(0.93, 'jgd2024', SHIFT_M))
})
