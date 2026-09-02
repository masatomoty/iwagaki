// 潮位（静水位 H）の値域と 1 段の動かし方。**スライダ・−／＋ ボタン・
// 左右キーで共有する**。以前は `ui/controls.ts` にインラインで持っていた。

import type { Catalog } from './catalog'

/**
 * スライダ／キー操作で到達できる潮位の上限 [m T.P.]。**配信物の `max`（3.0）とは別。**
 * 既往最高 0.93・高潮想定 0.69 に対して 3 m は目盛りが間延びしすぎるので頭打ちにする。
 */
export const WATER_LEVEL_UI_MAX_M_TP = 2

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

/** Shift を押しながらのキー操作で 1 打鍵に進む段数（速く掃くため）。 */
export const WATER_LEVEL_FAST_STEPS = 5

/**
 * 潮位を `steps` 段（符号つき。1 段 = `range.step`）動かした値。値域でクランプし、
 * mm 単位に丸める。−／＋ ボタンは ±1、Shift ＋ ← → は ±`WATER_LEVEL_FAST_STEPS`。
 *
 * **刻みの格子には乗せ直さない。** 端の値（既定は MSL 0.124 m）や参照潮位は
 * その値そのものに意味があり、格子に丸めると出典と合わなくなる。
 */
export function nudgeWaterLevel(
  current: number, steps: number, range: WaterLevelRange,
): number {
  const v = Math.min(range.max, Math.max(range.min, current + steps * range.step))
  return Math.round(v * 1000) / 1000
}
