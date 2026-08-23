import type { Catalog } from './domain/catalog'
import type { BuildingColorMode, FeatureAssertion, SurfaceMode } from './domain/types'

export interface LayerToggles {
  flood: boolean
  ground: boolean
  plateau: boolean
  pointcloud: boolean
  semantics: boolean
  changedOnly: boolean
  /** 点群が地表面として効いている範囲の輪郭。AOI 100 ha に対し 3 ha しかない */
  pcCoverage: boolean
}

export interface AppState {
  catalog: Catalog
  surface: SurfaceMode
  waterLevel: number
  layers: LayerToggles
  selected?: FeatureAssertion
  /**
   * ホバー中の地物は **ここに置かない。** マウス移動ごとに store.set すると
   * 購読側の refresh()（地形 uniform・断面の再描画まで）が毎フレーム走る。
   * 強調は `SemanticsMesh.setHighlight()` が色属性だけ書き換えて担う。
   */
  coalesceEnabled: boolean
  /** PLATEAU 建物の塗り分け。b3dm には色が無いので属性から与える */
  buildingColor: BuildingColorMode
  /** 鉛直強調。吉原は起伏が 0〜3 m しかないので、真横から見るには必須 */
  exaggeration: number
}

export function initialState(catalog: Catalog): AppState {
  return {
    catalog,
    surface: 'highres',
    // 既定は**普段の海面**（気象庁 公表の平均水面 0.124 m T.P.）。ここから上げていく。
    // 以前は representative[0] = 1.0 m だったが、これは出典の無い丸い数字で、しかも
    // **既往最高潮位 0.93 m より高い**。起動直後の画面が「記録されたどの潮位でもない
    // 水位」になっていた（`docs/results.md` 自身が「当初は根拠のない代表値」と書いている）。
    // 代表水位 (1.0, 1.5, 2.0) は解析の集計とファイル名に使うので config.py 側は触らない。
    waterLevel: catalog.water_level.reference_levels_m_tp?.['MSL']
      ?? catalog.water_level.representative[0] ?? 1.0,
    layers: {
      flood: true, ground: true, plateau: true,
      // 点群は既定 OFF。合成データで地表面と重なり浸水色を隠すうえ、
      // GPU 44 MB / 転送 14 MB を使う（docs/web_results.md「点群の配信」）
      pointcloud: false, semantics: true, changedOnly: false,
      // **点群が関わる条件を選んだときだけ出す。** これが無いと「点群で高精度に
      // 見た結果」が AOI 全域に効いているように読めてしまう（実際は 3.17 ha だけ）。
      // 既定の条件は highres なので、起動時は出さない。
      // 切り替えは main.ts の syncCoverageDefault()（条件が変わった瞬間だけ入れる）
      pcCoverage: false,
    },
    coalesceEnabled: true,
    buildingColor: 'usage',
    exaggeration: 1,
  }
}

export class Store {
  private listeners = new Set<(s: AppState) => void>()
  constructor(public state: AppState) {}
  subscribe(fn: (s: AppState) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch }
    for (const f of this.listeners) f(this.state)
  }
  setLayer(patch: Partial<LayerToggles>) {
    this.set({ layers: { ...this.state.layers, ...patch } })
  }
}
