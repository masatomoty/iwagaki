// catalog.json の型。ローカル配信と Cloudflare 配信の唯一の境界（docs/web_design.md「配信の境界」）。

export interface TerrainAsset {
  url: string
  tiles: number
  bytes: number
  min_zoom: number
  max_zoom: number
  label: string
  packing?: string
}

export interface Catalog {
  version: number
  aoi: {
    name: string
    bounds_epsg6674: [number, number, number, number]
    bbox_wgs84: [number, number, number, number]
    centre_wgs84: [number, number]
    local_origin_wgs84: [number, number]
    /**
     * 起動時の注視点。**AOI の矩形の中心ではない**（625 ha だと港と山に落ちて
     * 市街が画面に入らない）。標高 5 m 以下の建物の位置の中央値を解析側が入れる。
     * 古い配信物には無いので optional
     */
    focus_wgs84?: [number, number]
  }
  local_frame: {
    origin_epsg6674: [number, number]
    origin_wgs84: [number, number]
    /** [east, north] = M * [x - x0, y - y0]。子午線収差の回転を含む */
    matrix_2x2_row_major: [number, number, number, number]
    usage: string
    max_residual_m_over_aoi: number
  }
  vertical: {
    datum: string
    geoid_undulation_m: number
    geoid_source: string
    note: string
  }
  water_level: {
    min: number; max: number; step: number
    representative: number[]
    reference_levels_m_tp: Record<string, number>
    reference_levels_detail?: unknown
    /**
     * 潮位の毎時時系列。**取得できたものだけ**解析側が載せる。
     * 古い配信物や取得失敗時には鍵ごと無い。再生は時間発展ではなく
     * 各時刻を静水位で解いたパラメータ掃引として扱う
     */
    tide_series?: {
      default: string
      series: {
        id: string
        label: string
        kind: 'observed' | 'computed'
        url: string
        bytes: number
        peak_time: string
        peak_value_m_tp: number
      }[]
    }
  }
  packing: { scheme: string; elev: string; hconn: string; h_step: number; note: string }
  terrain: Record<string, TerrainAsset>
  plateau: Record<string, { url: string; b3dm_count: number; bytes: number
                            region_min_height_ellipsoidal_m: number }>
  pointcloud: { url: string; synthetic: boolean; provenance: string
                bytes: number; point_count: number; bytes_per_point: number
                /** COPC の範囲 [EPSG:6674 m]。既定視点をここから決める */
                bounds?: { minx: number; miny: number; minz: number
                           maxx: number; maxy: number; maxz: number } }
  /**
   * 起動時に出す断面線。**どこを切るべきかは解析側が知っている**ので、
   * 座標を viewer に埋め込まず catalog 経由で受け取る（scripts/87）。
   */
  default_section?: { from: [number, number]; to: [number, number]
                      length_m: number; why: string }
  /**
   * JR 線路（国土数値情報 N02）。**PLATEAU 舞鶴市に鉄道は無い**ので別データ由来
   * （`scripts/12_fetch_railway.py`）。市が「東側をここまで」と指した基準線そのもの。
   * **線路が AOI に掛からない範囲（吉原 100 ha）では鍵ごと無い。**
   */
  railway?: { url: string; bytes: number; length_m: number
              lines: string[]; source: string }
  /** 点群が地表面として効いている範囲の輪郭。無い配信物もあるので optional */
  pointcloud_coverage?: { url: string; bytes: number
                          area_ha_cells: number; area_ha_outline: number
                          cells: number; resolution_m: number; note: string }
  semantics: { url: string; bytes: number; feature_count: number
               road_depth_classes_m: number[]
               /**
                * 床上浸水とみなす浸水深 [m]。**地盤面からの水深**の閾値で、
                * PLATEAU LOD1 は床高を持たないので床面を超えた証明ではない
                * （`view/buildingColor.ts` の FLOOR_ABOVE_DEPTH_M）。
                * 古い配信物には無いので optional
                */
               floor_above_depth_m?: number
               /** 属性コード -> 表示名。CityGML 配布 zip 同梱のコードリスト由来 */
               codelists?: Record<string, Record<string, string>> }
  totals_bytes: Record<string, number>
  analysis_summary: unknown
  attribution: string[]
}
