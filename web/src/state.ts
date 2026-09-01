import type { Catalog } from './domain/catalog'
import type { BuildingColorMode, FeatureAssertion, FloodModel, RoadColorMode,
              SurfaceMode, TerrainPaint } from './domain/types'

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
  /**
   * **窪地**（標高は潮位以下だが `h_conn > 潮位` = 地表面では海とつながっていない）
   * を印で出すか。`domain/flood.ts` の `ponded()`。
   *
   * **`floodModel === 'connected'` のときだけ意味を持つ。** 既定の `simple`
   * （潮位 − 地盤高）では窪地は浸水域そのものなので、この印は出ない
   * （メニューにも出さない）。以下は `connected` を選んでいるときの話。
   *
   * 既定 ON。外部からの指摘（2026-08、東舞鶴）が
   * **「0.8 m の潮位でも浸水する範囲があるはずなのに着色されない」**
   * 「地盤高 0.8 m のところで潮位 0.9 m にしても浸水深が 0 のまま」だった。
   * 調べると東舞鶴の市街は海側の護岸天端 1.0〜1.3 m に囲まれた 0.8〜1.0 m の
   * 窪地で、**潮位を 0.45 → 0.95 m と 0.5 m ぶん上げても市街で新たに浸かるのは
   * 1.37 ha だけ**（次の 0.3 m で 14.23 ha）だった [実測]。
   * モデルとしては正しいが、吐口にフラップゲートが無い以上
   * （`docs/todo.md` 中 3）**内陸側を過小評価している**ので、
   * 「浸水しない」と同じ灰で潰さずに出す。切れるようにはしてある。
   *
   * **その後、市の回答（2026-08）で `simple` が既定になった。** 「排水路などを
   * 通じて、潮位よりも地盤高が低い箇所は、その差だけ浸水している」が現場の
   * 経験則で、逆流を判定に入れないこと自体が過小評価だったため
   * （`domain/types.ts` の `FloodModel`）
   */
  ponded: boolean
  /**
   * **窪地の越流点**（DEM だけで決まる、海に通じない窪地の鞍部）のマーカーを出すか。
   * 既定 OFF。潮位非依存の原理版（`three/pourPoints.ts`、`catalog.flow.pits`）で、
   * 上の `ponded`（潮位依存の斜線）とは別物。catalog に `flow.pits` が無い配信物では
   * 選択肢ごと出さない。
   */
  pourPoints: boolean
  /**
   * JR 線路（国土数値情報 N02）を出すか。既定 ON。
   *
   * 市の要望（2026-08）が **JR 線路を赤破線で示して「表示範囲の東側をここまで」**
   * だったので、**その基準線が画面に無いと「どこまで広げたのか」が読めない**。
   * catalog に `railway` が無い範囲（吉原 100 ha）では選択肢ごと出さない。
   */
  railway: boolean
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
  /**
   * 「水みち」モードで地図をクリックして選んだ**集水域**（クリックしたリーフ流域＋
   * その上流の全リーフを union したもの。`domain/flow.ts` の `catchmentOf` /
   * `catchmentSummary`、`catalog.flow.basins`）。**潮位非依存の別オーバーレイ**で
   * 浸水判定には混ぜない。水みちモードを外すとクリアする（`main.ts`）。
   */
  selectedCatchment?: {
    basinId: number
    /**
     * union した全リーフの**面積合計** [ha]（セル数由来の厳密値。インスペクタが出す値）。
     * `edgeTruncated` のとき AOI 内に入っているぶんだけ。
     */
    areaHa: number
    /**
     * 集水域の吐口の D-infinity 集水セル数 / m²。**面積（`areaHa`）とは別物** —
     * 主 receiver で切った流域境界を D-inf の分流が跨いで出入りするため。
     * インスペクタには出さない（`domain/flow.ts` のコメント）。`__iwagaki` 用に保持。
     */
    maxAccumCells: number
    maxAccumM2: number
    /** 集水域が AOI / collar の外へ延びている（切れている）か */
    edgeTruncated: boolean
    /** 流出先が海に通じない窪地なら、その越流点 */
    pit?: { pitId: number; spillElev: number }
  }
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
  /**
   * 浸水の決め方。**既定は `connected`（海からつながる）。**
   * `simple` は旧データ・互換用に型と判定関数へ残すが、UIでは選択肢に出さない。
   */
  floodModel: FloodModel
  /**
   * 地形の面の塗り。**既定は `flood`（浸水深）。**
   * `elevation` は「浸水深を見せる前に、どの場所の地盤が低いのかを
   * グラデーションで」という市の提案（2026-08）。`domain/types.ts` の `TerrainPaint`。
   */
  terrainPaint: TerrainPaint
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
      flood: true, ground: true, waterSurface: true, ponded: true,
      // 越流点は既定 OFF（水みちモードと一緒に見るための detail オーバーレイ）
      pourPoints: false,
      railway: true, plateau: true,
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
    // 「地盤高」は表示方法として独立させたため、浸水の既定は地表連結モデルにする。
    floodModel: 'connected',
    terrainPaint: 'flood',
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
