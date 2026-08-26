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
 * - `diff_drainage` highres -> S2仮想排水モデル
 */
export type SurfaceMode = TerrainCondition | 'diff' | 'diff_src' | 'diff_res' | 'diff_pc' | 'diff_drainage'

export const TERRAIN_CONDITIONS: TerrainCondition[] =
  ['baseline', 'highres', 'control', 'pointcloud']

/** 差分モードごとに、幾何をどの条件から取るか。差分タイルは色だけを与える */
export const DIFF_GEOMETRY:
  Record<'diff' | 'diff_src' | 'diff_res' | 'diff_pc' | 'diff_drainage', TerrainCondition> = {
  diff: 'highres',
  diff_src: 'control',
  diff_res: 'highres',
  diff_pc: 'pointcloud',
  diff_drainage: 'highres',
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

/**
 * 道路の塗り分け。
 *
 * - `plain`          一律。**どこが道路かを見せることだけ**をする
 * - `trafficability` 通行支障クラス（閾値は catalog の `road_depth_classes_m`）
 *
 * 既定は `plain`。通行支障の色は建物の浸水深（灰/黄/赤）と色域が重なるので、
 * 両方を同時に既定にすると道路と建物の区別がつかない（`state.ts`）。
 */
export type RoadColorMode = 'plain' | 'trafficability'

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

/**
 * **浸水をどう決めるか。** 2 つある。
 *
 * - `connected` … `h_conn <= H`。**海から地表面をたどって到達できるか**を解く
 *   （docs/design.md）。護岸天端に囲まれた低地は「浸水しない」になる
 * - `simple`    … **潮位 − 地盤高**。連結性を問わない。標高が潮位を下回れば
 *   その差だけ浸かっているものとして塗る
 *
 * **既定は `simple`。** `connected` はモデルとしては正しいが、地表面の連結しか
 * 見ておらず、側溝・暗渠・排水管を通る逆流を含まない。舞鶴市からは
 *
 * > 現場にいる経験則として、市内全域的に、排水路などを通じて、潮位よりも
 * > 地盤高が低い箇所は、その差だけ浸水している状況です。
 * > 現時点では、単純に「潮位ー地盤高＝浸水深」として可視化することで問題ない
 *
 * との回答があった（2026-08、東舞鶴。排水区・側溝底高・フラップゲートの有無は
 * **市も整理できていない**ので、連結性を補正するデータが無い）。
 * 現場の観測に合う方を既定にし、`connected` は切り替えで残す。
 * 排水路の吐口高やフラップゲートが入手できたら `connected` 側を精緻化する。
 */
export type FloodModel = 'simple' | 'connected'

/**
 * 地形の面を何で塗るか。
 *
 * - `flood`     … 浸水深（従来）。差分モードでは 2 条件の判定差
 * - `elevation` … **地盤高そのもの**をグラデーションで塗る
 *
 * `elevation` は市の
 * > 浸水深を見せる前に、どの場所の地盤が低いのか、地盤高を色のグラデーションで
 * > 見せていくのもあり
 * という提案（2026-08）。**配信物は 1 バイトも増えない**（標高はもともと
 * タイルの RGB に入っている。`assets/packing.ts`）。
 */
export type TerrainPaint = 'flood' | 'elevation'
