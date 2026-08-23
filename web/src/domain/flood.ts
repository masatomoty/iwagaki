// 浸水判定。docs/design.md「任意の水位を定数時間で評価できること」の h_conn をそのまま使う。
// GLSL 側（view/floodMeshLayer.ts）と同じ式であることを test/parity で検証する。

import type { ComparisonPair, FeatureAssertion, MTP, TerrainCondition } from './types'

/** そのセル/地物が水位 H で海側と連結して浸水しているか */
export function wet(hConn: MTP | undefined, H: MTP): boolean {
  return hConn !== undefined && Number.isFinite(hConn) && hConn <= H
}

/** 浸水深 [m]。連結していなければ 0 */
export function depth(elev: MTP | undefined, hConn: MTP | undefined, H: MTP): number {
  if (!wet(hConn, H) || elev === undefined || !Number.isFinite(elev)) return 0
  return Math.max(0, H - elev)
}

export function featureDepth(a: FeatureAssertion, c: TerrainCondition, H: MTP): number {
  return depth(a.groundElev[c], a.hConn[c], H)
}

export function featureWet(a: FeatureAssertion, c: TerrainCondition, H: MTP): boolean {
  return featureDepth(a, c, H) > 0
}

/** 道路の通行支障クラス。閾値は catalog の road_depth_classes_m */
export function roadClass(d: number, thresholds: number[]): number {
  let c = 0
  for (let i = 0; i < thresholds.length; i++) if (d >= thresholds[i]) c = i + 1
  return c
}

/**
 * **ペアで指定した 2 条件**の間で判定が変わるか。
 * 道路は通行支障クラスの変化、建物は浸水/非浸水の変化で見る（scripts/50 と同じ規則）。
 *
 * ペアは呼び側が `domain/terrain.ts` の `comparisonPair(surface)` から取る。
 * 以前ここで baseline / highres を固定していたため、**どの条件を見ていても
 * 「判定が変わる」が 5m↔0.5m の話になっていた**（地形の色と地物の色が食い違う）。
 */
export function decisionChanged(
  a: FeatureAssertion, H: MTP, roadThresholds: number[], pair: ComparisonPair,
): boolean {
  if (a.unreliable) return false
  if (pair.from === pair.to) return false        // 出発点そのものを見ているとき
  const df = featureDepth(a, pair.from, H)
  const dt = featureDepth(a, pair.to, H)
  // 片方の条件に値が無い地物（点群は歩いた帯にしか無い）は「変わった」と言えない
  if (a.hConn[pair.from] === undefined || a.hConn[pair.to] === undefined) return false
  if (a.featureType === 'tran:Road') {
    return roadClass(df, roadThresholds) !== roadClass(dt, roadThresholds)
  }
  return df > 0 !== dt > 0
}

/**
 * 判定が変わる水位帯 [lo, hi)。ペアの h_conn の差そのもの。
 * H がこの帯に入っているとき decision が割れる。
 */
export function changeBand(
  a: FeatureAssertion, pair: ComparisonPair,
): [MTP, MTP] | undefined {
  const f = a.hConn[pair.from]
  const t = a.hConn[pair.to]
  if (f === undefined || t === undefined || f === t) return undefined
  return f < t ? [f, t] : [t, f]
}
