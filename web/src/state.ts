import type { Catalog } from './domain/catalog'
import type { BuildingColorMode, FeatureAssertion, RoadColorMode,
              SurfaceMode } from './domain/types'

export interface LayerToggles {
  flood: boolean
  ground: boolean
  /**
   * **水平な水面**を潮位の高さに張るか（`three/floodMaterial.ts` の FLOOD_PASS）。
   * これが無かった間、浸水は地形の面に塗る色だけだったので
   * **潮位を動かしても水面の高さが変わらなかった**（外部からの指摘、2026-08）。
   * タイルは増えないので既定 ON にしてよい
   */
  waterSurface: boolean
  plateau: boolean
  pointcloud: boolean
  semantics: boolean
  /**
   * 道路（`tran:Road` 293 本）を描くか。**建物と別に切れる。**
   * 道路は前から読み込んでいたが建物と同じ配色だったので区別できなかった
   * （`three/semanticsMesh.ts` の ROAD_DRY / ROAD_WET）
   */
  roads: boolean
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
  /**
   * 道路の塗り分け。
   *
   * **既定は `plain`（一律）。** 市の要望は「道路がどこなのか分かるように
   * 表示してほしい」であって、通行支障の色分けはこちらで足したものだった。
   * 建物の既定を浸水深（灰/黄/赤）にしたところ、**通行支障の色（クリーム〜
   * 琥珀〜赤）と正面衝突して町が一様な黄色の塊になり、道路と建物の区別が
   * つかなくなった**（2026-08、再指摘）。
   *
   * 画面の色の枠は 地面＝暗い灰 / 建物＝灰・黄・赤 / 水＝青 で埋まっている。
   * 道路はそのどれとも当たらない明色（ほぼ白）を一律で持ち、
   * 通行支障は建物と同じく選択式に下げる。
   */
  roadColor: RoadColorMode
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
      flood: true, ground: true, waterSurface: true, plateau: true,
      // 点群は既定 OFF。合成データで地表面と重なり浸水色を隠すうえ、
      // GPU 44 MB / 転送 14 MB を使う（docs/web_results.md「点群の配信」）
      pointcloud: false, semantics: true, roads: true, changedOnly: false,
      // **点群が関わる条件を選んだときだけ出す。** これが無いと「点群で高精度に
      // 見た結果」が AOI 全域に効いているように読めてしまう（実際は 3.17 ha だけ）。
      // 既定の条件は highres なので、起動時は出さない。
      // 切り替えは main.ts の syncCoverageDefault()（条件が変わった瞬間だけ入れる）
      pcCoverage: false,
    },
    coalesceEnabled: true,
    /**
     * **既定は浸水深（床下・床上）。**
     *
     * 以前は `usage`（用途）だった。市の要望が「浸水深 50cm を基準に床下浸水・
     * 床上浸水で建物の色を区別できないか」だったのに、**既定が用途のままで
     * ドロップダウンに見出しも無かった**ため、開いた画面のどこにも
     * 床下/床上が出ておらず「入っていない」と受け取られた（2026-08）。
     *
     * このアプリの主題は浸水なので、建物の色も既定は浸水深にする。
     * 用途はドロップダウンで 1 クリック。凡例も用途 11 種より短くなる。
     */
    buildingColor: 'depth',
    roadColor: 'plain',
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
