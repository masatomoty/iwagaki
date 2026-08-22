// 浸水判定。docs/DESIGN.md §1.2 の h_conn をそのまま使う。
// GLSL 側（view/floodMeshLayer.ts）と同じ式であることを test/parity で検証する。

import type { FeatureAssertion, MTP, TerrainCondition } from './types'

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
 * baseline と highres で判定が変わるか。
 * 道路は通行支障クラスの変化、建物は浸水/非浸水の変化で見る（scripts/50 と同じ規則）。
 */
export function decisionChanged(a: FeatureAssertion, H: MTP, roadThresholds: number[]): boolean {
  if (a.unreliable) return false
  const db = featureDepth(a, 'baseline', H)
  const dh = featureDepth(a, 'highres', H)
  if (a.featureType === 'tran:Road') {
    return roadClass(db, roadThresholds) !== roadClass(dh, roadThresholds)
  }
  return db > 0 !== dh > 0
}

/**
 * 判定が変わる水位帯 [lo, hi)。h_conn の差そのもの。
 * H がこの帯に入っているとき decision が割れる。
 */
export function changeBand(a: FeatureAssertion): [MTP, MTP] | undefined {
  const b = a.hConn.baseline
  const h = a.hConn.highres
  if (b === undefined || h === undefined || b === h) return undefined
  return b < h ? [b, h] : [h, b]
}
