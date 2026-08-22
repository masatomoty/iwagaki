// ドメイン型。ここは maplibre-gl / deck.gl / loaders.gl を import しない。
// （docs/WEB_DESIGN.md §1 の依存ルール）

/** 標高・水位 [m T.P.] */
export type MTP = number

export type TerrainCondition = 'baseline' | 'highres'
/** 画面に出す地形レイヤの種類。diff は 2 条件の判定差 */
export type SurfaceMode = TerrainCondition | 'diff'

export const TERRAIN_CONDITIONS: TerrainCondition[] = ['baseline', 'highres']

/** 地物ごとの derived assertion（docs/DESIGN.md §1.1） */
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
