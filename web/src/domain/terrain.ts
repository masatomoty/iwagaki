// 「いま選ばれている surface に対して、幾何をどのタイルから取り、
// 色をどのタイルから取るか」だけを決める。maplibre-gl / deck.gl / three.js を
// import しない（docs/WEB_DESIGN.md §1 の依存ルール）。
//
// 描画側にこの分岐を置くと、レンダラを差し替えるたびに書き写すことになる。
// 配信物の構造（catalog.terrain のキーと差分タイルの意味）はレンダラに依らないので、
// ここに 1 か所だけ置く。

import type { SurfaceMode, TerrainCondition } from './types'
import { DIFF_GEOMETRY } from './types'

/** catalog.terrain の 1 エントリ。必要な分だけを構造として要求する */
export interface TerrainAsset {
  url: string
  min_zoom: number
  max_zoom: number
  label?: string
}

export interface ResolvedSurface {
  /** 標高（= メッシュの形）を取るタイル */
  geom: TerrainAsset
  /** 差分の色を取るタイル。地形モードでは undefined */
  diffUrl?: string
  /** 差分モードかどうか。シェーダの mode 切り替えに使う */
  isDiff: boolean
  /** 幾何をどの条件から取ったか。inspector の見出しに使う */
  condition: TerrainCondition
}

/**
 * 差分モードは「判定差の色」しか持たないので、メッシュの形は元の条件から取る。
 *
 * - `diff`    PLATEAU 5m と 0.5m DEM の差 → 形は `highres`
 * - `diff_pc` 0.5m DEM と点群融合地形の差 → 形は `pointcloud`
 *
 * 形をどちらから取るかは任意ではない。`diff_pc` の形を `highres` から取ると
 * 「点群で変わった場所」を点群の形の上に描けず、何を見ているのか分からなくなる。
 */
export function resolveSurface(
  terrain: Partial<Record<string, TerrainAsset>>, surface: SurfaceMode,
): ResolvedSurface | undefined {
  if (surface === 'diff' || surface === 'diff_pc') {
    const condition = DIFF_GEOMETRY[surface]
    const geom = terrain[condition]
    const diff = terrain[surface]
    // 差分タイルか元条件のどちらかが配信物に無ければ、差分は出せない
    if (!geom || !diff) return undefined
    return { geom, diffUrl: diff.url, isDiff: true, condition }
  }
  const geom = terrain[surface]
  return geom ? { geom, isDiff: false, condition: surface } : undefined
}
