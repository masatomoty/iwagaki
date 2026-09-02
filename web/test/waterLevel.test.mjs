// 潮位の 1 段送り（`domain/waterLevel.ts` の `nudgeWaterLevel` /
// `waterLevelRange`）。スライダの −／＋ と左右キーが共有する純関数。
// src の TS を Node の型除去でそのまま読む（`jst.test.mjs` と同じ）。
//
//   node --test test/waterLevel.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nudgeWaterLevel, WATER_LEVEL_FAST_STEPS, WATER_LEVEL_UI_MAX_M_TP, waterLevelRange,
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

test('nudgeWaterLevel は steps × step ぶん動かす', () => {
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(0.5, 1, r), 0.55)
  assert.equal(nudgeWaterLevel(0.5, -1, r), 0.45)
})

test('nudgeWaterLevel は Shift 併用の高速段（5 段）でまとめて動かす', () => {
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(0.5, WATER_LEVEL_FAST_STEPS, r), 0.75)
  assert.equal(nudgeWaterLevel(0.5, -WATER_LEVEL_FAST_STEPS, r), 0.25)
})

test('nudgeWaterLevel は値域でクランプする（高速段でも越えない）', () => {
  const r = waterLevelRange(catalog())
  assert.equal(nudgeWaterLevel(WATER_LEVEL_UI_MAX_M_TP, 1, r), WATER_LEVEL_UI_MAX_M_TP)
  assert.equal(nudgeWaterLevel(-0.5, -1, r), -0.5)
  assert.equal(nudgeWaterLevel(1.9, WATER_LEVEL_FAST_STEPS, r), WATER_LEVEL_UI_MAX_M_TP)
})

test('nudgeWaterLevel は刻みの格子に乗せ直さない（端の値・参照潮位を保つ）', () => {
  const r = waterLevelRange(catalog())
  // MSL 0.124 から 1 段上げても 0.15 ではなく 0.174 のまま +step
  assert.equal(nudgeWaterLevel(0.124, 1, r), 0.174)
})

test('nudgeWaterLevel は mm 単位に丸めて浮動小数の誤差を消す', () => {
  const r = waterLevelRange(catalog({ step: 0.1 }))
  assert.equal(nudgeWaterLevel(0.3, 1, r), 0.4)
})
