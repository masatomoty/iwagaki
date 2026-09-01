// 「いま形を取っている地形条件に対して、水みちタイルをどれから引くか」だけを決める。
// `domain/terrain.ts` と同じ役割で、描画側（three）に分岐を置かないための 1 か所。
// maplibre-gl / deck.gl / three.js を import しない（docs/web_design.md「層の分け方」）。

import type {
  Catalog, FlowAsset, FlowBasinsAsset, FlowPitsAsset,
} from './catalog'
import type { TerrainCondition } from './types'

/**
 * `catalog.flow` は `{ baseline, control, highres, pointcloud, pits }` の混在なので、
 * 条件キーだけを `FlowAsset` として取り出す。`pits` は別（`resolveFlowPits`）。
 */
function isFlowAsset(
  v: FlowAsset | FlowPitsAsset | FlowBasinsAsset | undefined,
): v is FlowAsset {
  return !!v && 'accum_max_cells' in v
}

/**
 * その地形条件の水みちタイル。**`drainage` 条件は `highres` と同じ地形**なので
 * flow タイルを焼いておらず、その場合は `highres` にフォールバックする
 * （`src/iwagaki/config.py` の `FLOW_TILE_CONDITIONS_BY_AOI`）。
 * 面的表示用の範囲では `control` / `pointcloud` も無いので同様に `highres` へ。
 */
export function resolveFlow(
  flow: Catalog['flow'], condition: TerrainCondition,
): FlowAsset | undefined {
  if (!flow) return undefined
  const direct = flow[condition]
  if (isFlowAsset(direct)) return direct
  const hr = flow.highres
  return isFlowAsset(hr) ? hr : undefined
}

/** 窪地の越流点マーカー（あれば）。条件に依らず 1 本。 */
export function resolveFlowPits(flow: Catalog['flow']): FlowPitsAsset | undefined {
  return flow?.pits
}

/** 部分流域ポリゴン（あれば）。条件に依らず 1 本（「クリックで集水域抽出」用）。 */
export function resolveFlowBasins(flow: Catalog['flow']): FlowBasinsAsset | undefined {
  return flow?.basins
}

// --- 部分流域 → 集水域（クリックで抽出）----------------------------------------
//
// `scripts/33` の `flow_basins` が主 receiver の流下木を本流の合流点で切った
// リーフ流域を配信する（`catalog.flow.basins`）。各 feature は下流のリーフ id
// （`downstream_basin_id`、AOI 内の終端は -1）を持つ。クリックした地点の集水域 =
// 「当たったリーフ ＋ downstream を逆にたどった上流の全リーフ」。
// **three/deck/maplibre は import しない**（`docs/web_design.md`「層の分け方」）。

export interface FlowBasinProps {
  basin_id: number
  downstream_basin_id: number
  area_ha: number
  max_accum_cells: number
  max_accum_m2: number
  edge_truncated: boolean
  outlet?: [number, number]
  pit_id?: number
  spill_elev_m_tp?: number
}

export interface FlowBasinFeature {
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: number[][][] | number[][][][]
  }
  properties: FlowBasinProps
}

export interface FlowBasins {
  features: FlowBasinFeature[]
  /** basin_id -> feature */
  byId: Map<number, FlowBasinFeature>
  /** basin_id -> 直接の上流リーフ id 群（`downstream_basin_id` の逆引き）*/
  upstream: Map<number, number[]>
}

/** 配信 GeoJSON を `basinAt` / `catchmentOf` が使える形に整える。 */
export function indexFlowBasins(fc: { features?: FlowBasinFeature[] }): FlowBasins {
  const features = fc.features ?? []
  const byId = new Map<number, FlowBasinFeature>()
  const upstream = new Map<number, number[]>()
  for (const f of features) byId.set(f.properties.basin_id, f)
  for (const f of features) {
    const d = f.properties.downstream_basin_id
    if (d < 0) continue
    const arr = upstream.get(d)
    if (arr) arr.push(f.properties.basin_id)
    else upstream.set(d, [f.properties.basin_id])
  }
  return { features, byId, upstream }
}

/** クリック地点 `[lon, lat]` を含むリーフ流域の id（無ければ undefined）。 */
export function basinAt(basins: FlowBasins, lon: number, lat: number): number | undefined {
  for (const f of basins.features) {
    const g = f.geometry
    const polys = g.type === 'Polygon'
      ? [g.coordinates as number[][][]]
      : (g.coordinates as number[][][][])
    for (const rings of polys) {
      if (!pointInRing(rings[0], lon, lat)) continue
      let inHole = false
      for (let h = 1; h < rings.length; h++) {
        if (pointInRing(rings[h], lon, lat)) { inHole = true; break }
      }
      if (!inHole) return f.properties.basin_id
    }
  }
  return undefined
}

/**
 * `rootId` の集水域 = `rootId` とその上流の全リーフ id（`downstream` を逆にたどる）。
 * `flow_basins` の木は非循環なので終端する。
 */
export function catchmentOf(basins: FlowBasins, rootId: number): Set<number> {
  const out = new Set<number>()
  const stack = [rootId]
  while (stack.length) {
    const b = stack.pop()!
    if (out.has(b)) continue
    out.add(b)
    for (const u of basins.upstream.get(b) ?? []) stack.push(u)
  }
  return out
}

/** 集水域全体の集計（面積の合計、最大集水、端で切れているか）。 */
export function catchmentSummary(basins: FlowBasins, ids: Iterable<number>) {
  let areaHa = 0
  let maxAccumCells = 0
  let maxAccumM2 = 0
  let edgeTruncated = false
  let pit: { pitId: number; spillElev: number } | undefined
  for (const id of ids) {
    const p = basins.byId.get(id)?.properties
    if (!p) continue
    areaHa += p.area_ha
    if (p.max_accum_cells > maxAccumCells) {
      maxAccumCells = p.max_accum_cells
      maxAccumM2 = p.max_accum_m2
    }
    edgeTruncated ||= p.edge_truncated
    if (p.pit_id !== undefined && (!pit || (p.spill_elev_m_tp ?? 0) < pit.spillElev)) {
      pit = { pitId: p.pit_id, spillElev: p.spill_elev_m_tp ?? 0 }
    }
  }
  return { areaHa, maxAccumCells, maxAccumM2, edgeTruncated, pit }
}

/** 奇遇則の点包含（ring は `[lon, lat]` の並び、閉じていなくてよい）。 */
function pointInRing(ring: number[][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > y) !== (yj > y)
        && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
