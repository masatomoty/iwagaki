// 潮位の 1 段送り（`domain/waterLevel.ts` の `nudgeWaterLevel` /
// `waterLevelRange`）。スライダの −／＋ と左右キーが共有する純関数。
// src の TS を Node の型除去でそのまま読む（`jst.test.mjs` と同じ）。
//
//   node --test test/waterLevel.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nudgeWaterLevel, WATER_LEVEL_KEY_FAST_STEP_M, WATER_LEVEL_KEY_STEP_M,
  WATER_LEVEL_UI_MAX_M_TP, waterLevelRange,
} from '../src/domain/waterLevel.ts'

const catalog = (over = {}) => ({
  water_level: { min: -0.5, max: 3, step: 0.05, ...over },
})

test('waterLevelRange は配信物の max を UI 上限で頭打ちにする', () => {
  const r = waterLevelRange(catalog())
  assert.equal(r.min, -0.5)
  assert.equal(r.max, WATER_LEVEL_UI_MAX_M_TP)
  assert.equal(r.step, 0.05)
})

test('waterLevelRange は配信物の max が上限より低ければそのまま使う', () => {
  assert.equal(waterLevelRange(catalog({ max: 1.5 })).max, 1.5)
})

test('nudgeWaterLevel は deltaM ぶん動かす', () => {
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(0.5, WATER_LEVEL_KEY_STEP_M, r), 0.51)
  assert.equal(nudgeWaterLevel(0.5, -WATER_LEVEL_KEY_STEP_M, r), 0.49)
})

test('キーの刻みは ← → 0.01 m / Shift ＋ ← → 0.05 m', () => {
  assert.equal(WATER_LEVEL_KEY_STEP_M, 0.01)
  assert.equal(WATER_LEVEL_KEY_FAST_STEP_M, 0.05)
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(0.5, WATER_LEVEL_KEY_FAST_STEP_M, r), 0.55)
})

test('nudgeWaterLevel は値域でクランプする（大きい delta でも越えない）', () => {
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(WATER_LEVEL_UI_MAX_M_TP, 0.05, r), WATER_LEVEL_UI_MAX_M_TP)
  assert.equal(nudgeWaterLevel(-0.5, -0.05, r), -0.5)
  assert.equal(nudgeWaterLevel(1.98, WATER_LEVEL_KEY_FAST_STEP_M, r), WATER_LEVEL_UI_MAX_M_TP)
})

test('nudgeWaterLevel は刻みの格子に乗せ直さない（端の値・参照潮位を保つ）', () => {
  const r = waterLevelRange(catalog())
  // MSL 0.124 から ← → 1 打鍵で 0.13 ではなく 0.134
  assert.equal(nudgeWaterLevel(0.124, WATER_LEVEL_KEY_STEP_M, r), 0.134)
})

test('nudgeWaterLevel は mm 単位に丸めて浮動小数の誤差を消す', () => {
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(0.3, 0.1, r), 0.4)
})
