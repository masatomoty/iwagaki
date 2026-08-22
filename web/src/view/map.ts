// MapLibre はカメラ・投影・basemap だけを持つ。データは全部 deck.gl 側。
// MapLibre の 3D terrain は使わない（deck.gl のレイヤが地形に貼り付かないため:
// docs/WEB_DESIGN.md §2.2）。起伏は FloodTileLayer のシェーダ内の陰影で出す。

import {
  Map as MlMap, NavigationControl, AttributionControl,
  type StyleSpecification,
} from 'maplibre-gl'

// maplibre-gl は 5.x に固定している。6.x は `map.transform` を廃止しており、
// @deck.gl/mapbox 9.3 の interleaved 描画が毎フレーム例外で落ちる（docs/WEB_DESIGN.md §11）。

import type { Catalog } from '../domain/catalog'

/** 外部タイルサーバに依存しない最小ベースマップ。計測を汚さないため外部通信ゼロ */
const STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0d1017' } }],
}

export function createMap(container: HTMLElement, catalog: Catalog): MlMap {
  const [lon, lat] = catalog.aoi.centre_wgs84
  const map = new MlMap({
    container,
    style: STYLE,
    center: [lon, lat],
    zoom: 15.6,
    pitch: 52,
    bearing: -28,
    maxBounds: [
      [catalog.aoi.bbox_wgs84[0] - 0.02, catalog.aoi.bbox_wgs84[1] - 0.02],
      [catalog.aoi.bbox_wgs84[2] + 0.02, catalog.aoi.bbox_wgs84[3] + 0.02],
    ],
    attributionControl: false,

  })
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')
  map.addControl(new AttributionControl({
    compact: true,
    customAttribution: catalog.attribution.join(' / '),
  }), 'bottom-right')
  return map
}
