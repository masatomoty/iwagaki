// 「いま形を取っている地形条件に対して、水みちタイルをどれから引くか」だけを決める。
// `domain/terrain.ts` と同じ役割で、描画側（three）に分岐を置かないための 1 か所。
// maplibre-gl / deck.gl / three.js を import しない（docs/web_design.md「層の分け方」）。

import type { Catalog, FlowAsset, FlowPitsAsset } from './catalog'
import type { TerrainCondition } from './types'

/**
 * `catalog.flow` は `{ baseline, control, highres, pointcloud, pits }` の混在なので、
 * 条件キーだけを `FlowAsset` として取り出す。`pits` は別（`resolveFlowPits`）。
 */
function isFlowAsset(v: FlowAsset | FlowPitsAsset | undefined): v is FlowAsset {
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
