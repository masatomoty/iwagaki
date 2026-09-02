// 潮位（静水位 H）の値域と 1 段の動かし方。**スライダ・−／＋ ボタン・
// 左右キーで共有する**。以前は `ui/controls.ts` にインラインで持っていた。

import type { Catalog } from './catalog'

/**
 * スライダ／キー操作で到達できる潮位の上限 [m T.P.]。**配信物の `max`（3.0）とは別。**
 * 既往最高 0.93・高潮想定 0.69 に対して 3 m は目盛りが間延びしすぎるので頭打ちにする。
 */
export const WATER_LEVEL_UI_MAX_M_TP = 2

/**
 * キーボードの ← → 1 打鍵で動かす量 [m]。**スライダの `step`（配信物由来、0.05 m）
 * より細かい 0.01 m** にして、キーでは値を追い込めるようにする（外部要望、2026-09）。
 */
export const WATER_LEVEL_KEY_STEP_M = 0.01
/** Shift ＋ ← → 1 打鍵で動かす量 [m]。スライダの刻みと同じ 0.05 m で速く掃く。 */
export const WATER_LEVEL_KEY_FAST_STEP_M = 0.05

export interface WaterLevelRange {
  min: number
  max: number
  step: number
}

/** 配信物の値域に UI の上限（`WATER_LEVEL_UI_MAX_M_TP`）を被せたもの。 */
export function waterLevelRange(catalog: Catalog): WaterLevelRange {
  const { min, max, step } = catalog.water_level
  return { min, max: Math.min(max, WATER_LEVEL_UI_MAX_M_TP), step }
}

/**
 * 潮位を `deltaM` メートル（符号つき）動かした値。値域でクランプし、mm 単位に丸める。
 * −／＋ ボタンは ±`range.step`、← → は ±`WATER_LEVEL_KEY_STEP_M`、
 * Shift ＋ ← → は ±`WATER_LEVEL_KEY_FAST_STEP_M`。
 *
 * **刻みの格子には乗せ直さない。** 端の値（既定は MSL 0.124 m）や参照潮位は
 * その値そのものに意味があり、格子に丸めると出典と合わなくなる。
 */
export function nudgeWaterLevel(
  current: number, deltaM: number, range: WaterLevelRange,
): number {
  const v = Math.min(range.max, Math.max(range.min, current + deltaM))
  return Math.round(v * 1000) / 1000
}
