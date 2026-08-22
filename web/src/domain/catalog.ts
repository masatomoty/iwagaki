// catalog.json の型。ローカル配信と Cloudflare 配信の唯一の境界（docs/WEB_DESIGN.md §6）。

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
  }
  packing: { scheme: string; elev: string; hconn: string; h_step: number; note: string }
  terrain: Record<string, TerrainAsset>
  plateau: Record<string, { url: string; b3dm_count: number; bytes: number
                            region_min_height_ellipsoidal_m: number }>
  pointcloud: { url: string; synthetic: boolean; provenance: string
                bytes: number; point_count: number; bytes_per_point: number }
  semantics: { url: string; bytes: number; feature_count: number
               road_depth_classes_m: number[] }
  totals_bytes: Record<string, number>
  analysis_summary: unknown
  attribution: string[]
}
