// 徒歩圏（道路ネットワーク等時線 ＋ 単純バッファ）の配信物の読み方。
// `scripts/94_walk_isochrone.py` が起点ごとに焼く 1 GeoJSON（EPSG:4326、2 面）を
// `three/walkIsochroneLayer.ts` と UI パネルの両方が使える形に整える。
// `domain/flow.ts` と同じ役割で、ここは three / maplibre / deck.gl を import しない
// （docs/web_design.md「層の分け方」）。
//
// **T1（任意地点＋徒歩圏半径）の中心点 UI とは未統合。** 起点は解析側が焼いた
// 固定点のまま。統合は catalog に複数起点を並べる別 PR で行う（`domain/catalog.ts`
// の `walk_isochrones` を参照）。

export type WalkIsochroneLayerKey = 'network_isochrone' | 'simple_buffer'

export interface WalkIsochroneFeature {
  type: 'Feature'
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: number[][][] | number[][][][]
  } | null
  properties: {
    layer: WalkIsochroneLayerKey
    status: string
    area_m2?: number
    radius_m?: number
    reached_node_count?: number
    snap_distance_m?: number
  }
}

/** `scripts/94` の `metadata`。起点・条件・注意書きはここに乗る。 */
export interface WalkIsochroneMetadata {
  aoi: string
  aoi_label: string
  origin_lon: number
  origin_lat: number
  minutes: number
  walk_speed_m_per_min: number
  reach_distance_m: number
  not_official_pedestrian_network: string
  valid_in_aoi_only: string
  model?: string
  edge_buffer_m?: number
  snap_distance_m?: number
  network_over_buffer_ratio?: number
  graph_components?: number
  network_fragmentation_note?: string
}

export interface WalkIsochroneGeoJSON {
  type: 'FeatureCollection'
  metadata: WalkIsochroneMetadata
  features: WalkIsochroneFeature[]
}

/** 指定レイヤの feature（無ければ undefined）。 */
export function pickWalkIsochroneLayer(
  fc: WalkIsochroneGeoJSON, layer: WalkIsochroneLayerKey,
): WalkIsochroneFeature | undefined {
  return fc.features.find((f) => f.properties.layer === layer)
}

/** 面を持っている（起点が AOI 内かつ道路が近くにあった）か。 */
export function hasReachablePolygon(f: WalkIsochroneFeature | undefined): boolean {
  return !!f?.geometry && f.properties.status === 'ok'
}

/**
 * UI パネルに出すための要約。**起点・所要時間・「公式歩行者網ではない」旨**を
 * 3D シーンに焼き込まず、ここから文字列として引けるようにする
 * （`three/railwayLine.ts` は標高付き線を描くだけで注意書きは持たない設計に倣う）。
 */
export interface WalkIsochroneInfo {
  aoi: string
  aoiLabel: string
  originLon: number
  originLat: number
  minutes: number
  walkSpeedMPerMin: number
  reachDistanceM: number
  notOfficialNote: string
  aoiOnlyNote: string
  networkStatus: string
  networkAreaM2?: number
  bufferAreaM2?: number
  /** ネットワーク等時線 / 単純バッファの面積比。1 に近いほど道路が密。 */
  networkOverBufferRatio?: number
  networkFragmentationNote?: string
}

export function walkIsochroneInfo(fc: WalkIsochroneGeoJSON): WalkIsochroneInfo {
  const m = fc.metadata
  const net = pickWalkIsochroneLayer(fc, 'network_isochrone')
  const buf = pickWalkIsochroneLayer(fc, 'simple_buffer')
  return {
    aoi: m.aoi,
    aoiLabel: m.aoi_label,
    originLon: m.origin_lon,
    originLat: m.origin_lat,
    minutes: m.minutes,
    walkSpeedMPerMin: m.walk_speed_m_per_min,
    reachDistanceM: m.reach_distance_m,
    notOfficialNote: m.not_official_pedestrian_network,
    aoiOnlyNote: m.valid_in_aoi_only,
    networkStatus: net?.properties.status ?? 'outside_aoi',
    networkAreaM2: net?.properties.area_m2,
    bufferAreaM2: buf?.properties.area_m2,
    networkOverBufferRatio: m.network_over_buffer_ratio,
    networkFragmentationNote: m.network_fragmentation_note,
  }
}
