// ドメイン型。ここは maplibre-gl / deck.gl / loaders.gl を import しない。
// （docs/web_design.md「層の分け方」の依存ルール）

/** 標高・水位 [m T.P.] */
export type MTP = number

/**
 * 解析が持っている地形条件（docs/design.md「地形の生成」）。
 *
 * - `baseline`   PLATEAU 地形モデル LOD1 TIN（5 m 格子）
 * - `highres`    京都府 数値標高モデル 0.5 m（航空レーザ 2019-2023）
 * - `control`    highres を 5 m に平均集約。**解像度効果だけを切り離すための対照**
 * - `pointcloud` 0.5m DEM に地上点群（バックパック SLAM 2026-07）の地表面を融合
 *
 * 以前は baseline / highres の 2 つしか配信していなかった。
 * control は `docs/design.md`「ブラウザ側への要求」に挙がっていたのに実装されておらず、
 * pointcloud は解析結果が出ているのに画面から見られなかった（docs/todo.md A1・A4）。
 */
export type TerrainCondition = 'baseline' | 'highres' | 'control' | 'pointcloud'

/**
 * 画面に出す地形レイヤの種類。
 *
 * `diff` 系は 2 条件の h_conn を R/G に詰めた専用ピラミッドで、判定差だけを出す。
 *
 * 条件は 1 段ごとに 1 要素だけ変えた鎖なので、**辺がそのまま差分**になる。
 * - `diff_src` baseline -> control（**データ源だけ**。どちらも 5 m 格子）
 * - `diff_res` control -> highres（**解像度だけ**。どちらも航空レーザ源）
 * - `diff_pc`  highres -> pointcloud（地上観測が足した分）
 * - `diff`     baseline -> highres（上 2 段をまとめたもの。README の見出しの図）
 */
export type SurfaceMode = TerrainCondition | 'diff' | 'diff_src' | 'diff_res' | 'diff_pc'

export const TERRAIN_CONDITIONS: TerrainCondition[] =
  ['baseline', 'highres', 'control', 'pointcloud']

/** 差分モードごとに、幾何をどの条件から取るか。差分タイルは色だけを与える */
export const DIFF_GEOMETRY:
  Record<'diff' | 'diff_src' | 'diff_res' | 'diff_pc', TerrainCondition> = {
  diff: 'highres',
  diff_src: 'control',
  diff_res: 'highres',
  diff_pc: 'pointcloud',
}

/**
 * 判定を比べる 2 条件。`from` が基準（出発点）で `to` がいま見ている条件。
 *
 * **判定が変わるかどうかは、常にこのペアに対して決まる。** 以前は
 * `domain/flood.ts` が baseline と highres をハードコードしていて、
 * 「差分 0.5m↔点群」を選んでいても地物の赤は 5m↔0.5m のままだった
 * （地形の色と地物の色が別の比較を示していた）。
 */
export interface ComparisonPair {
  from: TerrainCondition
  to: TerrainCondition
}

/**
 * PLATEAU 建物をどの属性で塗り分けるか。コード -> 色 は view/buildingColor.ts。
 *
 * `depth` だけは**属性ではなく水位から決まる**。地物 assertion の
 * `groundElev` / `hConn` を gml_id で b3dm の batch table に結合し、
 * `depth = H - 地盤高` を床上閾値（既定 0.50 m）で切る。
 * 潮位を動かしても再取得も作り直しも起きない（uniform が変わるだけ）。
 */
export type BuildingColorMode = 'none' | 'class' | 'usage' | 'depth'

/** 地物ごとの derived assertion（docs/design.md「PLATEAU を書き換えない」） */
export interface FeatureAssertion {
  gmlId: string
  featureType: 'bldg:Building' | 'tran:Road' | string
  name?: string
  areaM2?: number
  sectionType?: string
  sectionTypeLabel?: string
  /** 橋梁・高架橋・トンネル等、DTM 由来の地盤高が意味を持たない地物 */
  unreliable: boolean
  unreliableReason?: string
  groundElev: Record<TerrainCondition, MTP | undefined>
  hConn: Record<TerrainCondition, MTP | undefined>
}

export interface LonLat { lon: number; lat: number }

export interface Aoi {
  name: string
  bboxWgs84: [number, number, number, number]
  centre: LonLat
}
