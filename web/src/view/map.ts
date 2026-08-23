// MapLibre はカメラ・投影・basemap だけを持つ。データは全部 deck.gl 側。
// MapLibre の 3D terrain は使わない（deck.gl のレイヤが地形に貼り付かないため:
// docs/WEB_DESIGN.md「MapLibre の 3D terrain は使わない」）。起伏は FloodTileLayer のシェーダ内の陰影で出す。

import {
  Map as MlMap, AttributionControl,
  type StyleSpecification,
} from 'maplibre-gl'

// maplibre-gl は 5.x に固定している。6.x は `map.transform` を廃止しており、
// @deck.gl/mapbox 9.3 の interleaved 描画が毎フレーム例外で落ちる（docs/WEB_DESIGN.md「既知の制約」）。

import type { Catalog } from '../domain/catalog'
import { ViewCube } from './viewCube'

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
    // 真横から見られないと地形の起伏を確かめられない。MapLibre の上限まで開ける
    maxPitch: 85,
    maxBounds: [
      [catalog.aoi.bbox_wgs84[0] - 0.02, catalog.aoi.bbox_wgs84[1] - 0.02],
      [catalog.aoi.bbox_wgs84[2] + 0.02, catalog.aoi.bbox_wgs84[3] + 0.02],
    ],
    attributionControl: false,

  })
  // NavigationControl（+/- とコンパス）は付けない。
  // ズームはホイールとピンチで足り、向きはビューキューブが担う。
  // 小さいボタンが 3 つ並ぶより、押せる的が 1 つ大きいほうがよい。
  map.addControl(new AttributionControl({
    compact: true,
    customAttribution: catalog.attribution.join(' / '),
  }), 'bottom-right')
  return map
}

/**
 * 右上にビューキューブを置く。カメラに追従し、面/辺/角で整列、ドラッグで回転。
 * 実装は `view/viewCube.ts`（描画ライブラリに依存しない 2D canvas）。
 */
export function attachViewCube(map: MlMap): ViewCube {
  const cube = new ViewCube({
    size: 128,
    onPick: (o) => map.easeTo({ bearing: o.bearingDeg, pitch: o.pitchDeg, duration: 450 }),
    onDrag: (dx, dy) => {
      // 横は方位、縦は傾き。MapLibre の上限を超えないように丸める
      map.jumpTo({
        bearing: map.getBearing() + dx * 0.6,
        pitch: Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() - dy * 0.4)),
      })
    },
  })
  const host = document.createElement('div')
  host.id = 'viewcube'
  host.appendChild(cube.el)

  // ホーム。起動時の視点に戻す。**キューブは向きしか戻せない**
  // （面をクリックしても中心とズームは動かない）ので、別に要る
  const home0 = {
    center: map.getCenter(), zoom: map.getZoom(),
    bearing: map.getBearing(), pitch: map.getPitch(),
  }
  const home = document.createElement('button')
  home.id = 'viewcube-home'
  home.type = 'button'
  home.textContent = '⌂'
  home.title = 'ホーム（起動時の俯瞰に戻る）'
  home.addEventListener('click', () => map.easeTo({ ...home0, duration: 600 }))
  host.appendChild(home)

  map.getContainer().appendChild(host)
  const sync = () => cube.setOrientation({
    bearingDeg: map.getBearing(), pitchDeg: map.getPitch(),
  })
  map.on('move', sync)
  map.on('rotate', sync)
  map.on('pitch', sync)
  sync()
  return cube
}

/** CAD のように軸方向から見るためのプリセット。bearing はカメラが向く方位 */
export const CAMERA_PRESETS = [
  { key: '1', id: 'top', label: '平面', pitch: 0, bearing: 0 },
  { key: '2', id: 'south', label: '南↑', pitch: 84, bearing: 0 },
  { key: '3', id: 'west', label: '西→', pitch: 84, bearing: 90 },
  { key: '4', id: 'north', label: '北↓', pitch: 84, bearing: 180 },
  { key: '5', id: 'east', label: '東←', pitch: 84, bearing: 270 },
  { key: '6', id: 'iso', label: '俯瞰', pitch: 52, bearing: -28 },
] as const

export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id']

export function applyPreset(map: MlMap, id: CameraPresetId) {
  const p = CAMERA_PRESETS.find((x) => x.id === id)
  if (!p) return
  map.easeTo({ pitch: p.pitch, bearing: p.bearing, duration: 500 })
}

/** 1〜6 で視点、[ ] で鉛直強調 */
export function bindCameraKeys(map: MlMap, onExaggeration: (delta: number) => void) {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    const p = CAMERA_PRESETS.find((x) => x.key === e.key)
    if (p) { applyPreset(map, p.id); return }
    if (e.key === ']') onExaggeration(1)
    if (e.key === '[') onExaggeration(-1)
  })
}


/**
 * 断面の測線を地図に描く。**どこを切った断面なのかが分からないと読めない。**
 *
 * MapLibre の source + layer で足りるので deck.gl を持ち出さない
 * （遅延読み込みしているレイヤ群を、線 1 本のために起こすことになる）。
 */
export function showSectionLine(map: MlMap, from: [number, number], to: [number, number]) {
  // 起動直後はスタイルがまだ読めていない。addSource が例外を投げるので待つ
  if (!map.isStyleLoaded()) {
    map.once('load', () => showSectionLine(map, from, to))
    return
  }
  const data = {
    type: 'FeatureCollection' as const,
    features: [{
      type: 'Feature' as const, properties: {},
      geometry: { type: 'LineString' as const, coordinates: [from, to] },
    }],
  }
  const src = map.getSource('section-line') as { setData?: (d: unknown) => void } | undefined
  if (src?.setData) { src.setData(data); return }
  map.addSource('section-line', { type: 'geojson', data })
  map.addLayer({
    id: 'section-line-halo',
    type: 'line',
    source: 'section-line',
    paint: { 'line-color': '#0b1020', 'line-width': 6, 'line-opacity': 0.7 },
  })
  map.addLayer({
    id: 'section-line',
    type: 'line',
    source: 'section-line',
    paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [3, 2] },
  })
}
