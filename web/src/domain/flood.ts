// 浸水判定。docs/design.md「任意の水位を定数時間で評価できること」の h_conn をそのまま使う。
// GLSL 側（view/floodMeshLayer.ts）と同じ式であることを test/parity で検証する。

import type { ComparisonPair, FeatureAssertion, FloodModel, MTP,
              TerrainCondition } from './types'

/** そのセル/地物が水位 H で海側と連結して浸水しているか */
export function wet(hConn: MTP | undefined, H: MTP): boolean {
  return hConn !== undefined && Number.isFinite(hConn) && hConn <= H
}

/**
 * 浸水深 [m]。
 *
 * - `simple`          … **潮位 − 地盤高**。連結性を問わない。交通規制と
 *   `scripts/91` の書き出しで安全側の判定に使う
 * - `connected`       … 海から地表面をたどって到達できるときだけ深さを付ける
 *
 * どちらでも深さの式は同じ `max(0, H − 標高)` で、**`connected` が 0 に潰す
 * セルの集合が `simple` との差そのもの**（= 従来の「窪地」）である。
 * `domain/types.ts` の `FloodModel` に使い分けの経緯がある。
 */
export function depth(
  elev: MTP | undefined, hConn: MTP | undefined, H: MTP,
  model: FloodModel = 'simple',
): number {
  if (elev === undefined || !Number.isFinite(elev)) return 0
  // 色分けの規則（浸水深・床上/床下）は全モデルで共通にし、
  // simple 以外ではモデル固有の h_conn だけを浸水判定に使う。
  if (model !== 'simple' && !wet(hConn, H)) return 0
  return Math.max(0, H - elev)
}

export function featureDepth(
  a: FeatureAssertion, c: TerrainCondition, H: MTP, model: FloodModel = 'simple',
): number {
  return depth(a.groundElev[c], a.hConn[c], H, model)
}

export function featureWet(
  a: FeatureAssertion, c: TerrainCondition, H: MTP, model: FloodModel = 'simple',
): boolean {
  return featureDepth(a, c, H, model) > 0
}

/** 道路の通行支障クラス。閾値は catalog の road_depth_classes_m */
export function roadClass(d: number, thresholds: number[]): number {
  let c = 0
  for (let i = 0; i < thresholds.length; i++) if (d >= thresholds[i]) c = i + 1
  return c
}

/**
 * 市の 3 段の規制区分。**通行可否だけの深さ分類ではない。**
 *
 * - 塩害は「海水が路面に乗ること自体」を理由にする
 * - 走行波は沿道家屋の近さで裏取りする（`frontage_building_count_5m`）
 * - 0.15 m 以上は沿道建物によらず通行止め相当を優先する
 *
 * `scripts/91_traffic_regulation.py::regulation_of` と同一に保つ。
 * 浸水深は **simple の highres** で評価する（`scripts/91` の既定列）。
 */
export type RoadRegulation = 'none' | 'slow' | 'consider' | 'stop'

export const ROAD_STOP_DEPTH_M = 0.15

export function roadRegulation(
  depthSimple: number, frontage5m: number | undefined,
): RoadRegulation {
  if (!Number.isFinite(depthSimple) || depthSimple <= 0) return 'none'
  if (depthSimple >= ROAD_STOP_DEPTH_M) return 'stop'
  if (frontage5m !== undefined && Number.isFinite(frontage5m) && frontage5m >= 1) {
    return 'consider'
  }
  return 'slow'
}

export function featureRoadRegulation(
  a: FeatureAssertion, H: MTP,
): RoadRegulation {
  return roadRegulation(depth(a.groundElev.highres, a.hConn.highres, H, 'simple'),
                        a.frontageBuildingCount5m)
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
  model: FloodModel = 'simple',
): boolean {
  if (a.unreliable) return false
  if (pair.from === pair.to) return false        // 出発点そのものを見ているとき
  const df = featureDepth(a, pair.from, H, model)
  const dt = featureDepth(a, pair.to, H, model)
  // 片方の条件に値が無い地物（点群は歩いた帯にしか無い）は「変わった」と言えない
  if (a.hConn[pair.from] === undefined || a.hConn[pair.to] === undefined) return false
  if (a.featureType === 'tran:Road') {
    return roadClass(df, roadThresholds) !== roadClass(dt, roadThresholds)
  }
  return df > 0 !== dt > 0
}

/**
 * 判定が変わる水位帯 [lo, hi)。H がこの帯に入っているとき decision が割れる。
 *
 * **どの値の差かはモデルで変わる。** `connected` なら 2 条件の `h_conn` の差、
 * `simple` なら**地盤高そのものの差**（浸水し始める水位が地盤高だから）。
 */
export function changeBand(
  a: FeatureAssertion, pair: ComparisonPair, model: FloodModel = 'simple',
): [MTP, MTP] | undefined {
  const src = model === 'simple' ? a.groundElev : a.hConn
  const f = src[pair.from]
  const t = src[pair.to]
  if (f === undefined || t === undefined || !Number.isFinite(f) || !Number.isFinite(t)
      || f === t) return undefined
  return f < t ? [f, t] : [t, f]
}

/**
 * **標高は潮位以下だが、地表面では海とつながっていない窪地。**
 *
 * **`connected` モデルのときだけ存在する状態である。** `simple`
 * （潮位 − 地盤高）では窪地も浸水域に入るので、この関数は常に false を返す。
 * 以下は `connected` を選んでいるときの話。
 *
 * `wet` は「海から連結して到達できるか」（`h_conn <= H`）で判定するので、
 * 周囲より低い土地が護岸や堤内の天端に囲まれていると、標高が潮位を下回っていても
 * 浸水しないことになる。**それが本モデルの想定どおりの答えである。**
 *
 * ただし `docs/todo.md` 中 3 のとおり、排水路の吐口には**フラップゲートが無く**、
 * 潮位が上がれば管路を逆流しうる（市への照会、2026-08）。地表面の連結性しか
 * 見ていない本モデルは、この窪地のぶんだけ**内陸側を過小評価している**。
 *
 * 東舞鶴で実際に効いている [実測]:
 *   市街は海側の護岸天端 1.0〜1.3 m に囲まれた 0.8〜1.0 m の窪地で、潮位を
 *   0.45 → 0.95 m と 0.5 m ぶん上げても市街で新たに浸かるのは 1.37 ha だけ、
 *   次の 0.3 m（1.00 → 1.25）で 14.23 ha 増える。既往最高潮位 0.93 m では
 *   連結 15.75 ha に対し、この窪地が 10.57 ha（321 地物・建物 201 棟）ある。
 *
 * なので「浸水しない」と同じ色で潰さず、**別の色で出して数えられるようにする**。
 * 判定を混ぜないこと（`wet` はこれを含めない）。両者は根拠が違う。
 */
export function ponded(
  elev: MTP | undefined, hConn: MTP | undefined, H: MTP,
  model: FloodModel = 'simple',
): boolean {
  // **`simple` では窪地という状態が無い。** 連結性を問わず塗るので、
  // 窪地はそのまま浸水域に入る（区別する意味が消える）
  if (model === 'simple') return false
  if (elev === undefined || !Number.isFinite(elev)) return false
  if (wet(hConn, H)) return false          // 連結して浸水しているなら窪地ではない
  // **厳密不等号。** `depth()` が `max(0, H - 標高) > 0` を要求するのと揃える。
  // 標高 = 潮位ちょうどのセルは水深 0 なので、浸水でも窪地でもない。
  // 東舞鶴の DEM は 0.1 m 刻み [実測] なので、この一致は頻繁に起きる
  return elev < H
}

export function featurePonded(
  a: FeatureAssertion, c: TerrainCondition, H: MTP, model: FloodModel = 'simple',
): boolean {
  return ponded(a.groundElev[c], a.hConn[c], H, model)
}

/** 再生中に常に見せる「いまの水位での床上 / 床下」棟数。 */
export function floorCounts(
  assertions: Iterable<FeatureAssertion>,
  condition: TerrainCondition, H: MTP, floor: number,
  model: FloodModel,
): { under: number; above: number } {
  let under = 0
  let above = 0
  for (const a of assertions) {
    if (a.featureType !== 'bldg:Building' || a.unreliable) continue
    const d = featureDepth(a, condition, H, model)
    if (d >= floor) above++
    else if (d > 0) under++
  }
  return { under, above }
}

/** 再生中に常に見せる「いまの水位で規制対象になる道路」本数。 */
export function regulatedRoadCount(
  assertions: Iterable<FeatureAssertion>, H: MTP,
): number {
  let n = 0
  for (const a of assertions) {
    if (a.featureType !== 'tran:Road' || a.unreliable) continue
    if (featureRoadRegulation(a, H) !== 'none') n++
  }
  return n
}
