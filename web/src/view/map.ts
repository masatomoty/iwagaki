// カメラのプリセットと操作。**MapLibre は使わない**（three.js 実体は src/three/viewer.ts）。
//
// MapLibre がここで担っていたのはカメラ・投影・ギズモだけで、ベースマップは
// 1 枚も描いていなかった（style の sources が空だった）。それに初期チャンクの
// 約 1/3 を払っていたので外した（docs/WEB_RESULTS.md §8.1）。
//
// 外向きの export 名は変えていない。src/ui/controls.ts がこのモジュールから
// CAMERA_PRESETS / CameraPresetId を読んでいるため。

import type { Catalog } from '../domain/catalog'
import { createLocalFrame, lngLatToWorld } from '../three/mercator'
import { Viewer, type ProjectionMode } from '../three/viewer'

export function createViewer(container: HTMLElement, catalog: Catalog): Viewer {
  const [lon, lat] = catalog.aoi.centre_wgs84
  const frame = createLocalFrame([lon, lat])
  const b = catalog.aoi.bbox_wgs84
  return new Viewer({
    container,
    frame,
    // 注視点を AOI から大きく離さない（旧 maxBounds 相当）
    maxBoundsLngLat: [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02],
    initial: {
      target: lngLatToWorld(frame, lon, lat),
      // 距離はこのあと setZoom(INITIAL_ZOOM) で上書きする（ビューポート高に依存するため）
      distance: 3456,
      pitch: 52,
      bearing: -28,
    },
  })
}

/** 旧実装の MapLibre 初期 zoom。ここを変えると FMR の比較が成立しなくなる */
export const INITIAL_ZOOM = 15.6

/**
 * CAD のように軸方向から見るためのプリセット。bearing はカメラが向く方位。
 *
 * `ortho` は正射投影に切り替えるもの（docs/TODO.md B1）。MapLibre は透視投影しか
 * 持たないので、6 方向のプリセットを入れても「断面のように」は見えていなかった。
 * three.js の OrthographicCamera でようやく要求を満たす。
 */
export const CAMERA_PRESETS = [
  { key: '1', id: 'top', label: '平面', pitch: 0, bearing: 0, ortho: true },
  { key: '2', id: 'south', label: '南↑', pitch: 84, bearing: 0, ortho: true },
  { key: '3', id: 'west', label: '西→', pitch: 84, bearing: 90, ortho: true },
  { key: '4', id: 'north', label: '北↓', pitch: 84, bearing: 180, ortho: true },
  { key: '5', id: 'east', label: '東←', pitch: 84, bearing: 270, ortho: true },
  { key: '6', id: 'iso', label: '俯瞰', pitch: 52, bearing: -28, ortho: false },
] as const

export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id']

export function applyPreset(v: Viewer, id: CameraPresetId) {
  const p = CAMERA_PRESETS.find((x) => x.id === id)
  if (!p) return
  // 軸方向のプリセットは正射に切り替える。断面として読めないと意味が無い
  v.setProjection(p.ortho ? 'orthographic' : 'perspective')
  v.easeTo({ pitch: p.pitch, bearing: p.bearing }, 500)
}

/** 1〜6 で視点、[ ] で鉛直強調、O で投影切り替え */
export function bindCameraKeys(
  v: Viewer,
  onExaggeration: (delta: number) => void,
  onProjection?: (mode: ProjectionMode) => void,
) {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const p = CAMERA_PRESETS.find((x) => x.key === e.key)
    if (p) { applyPreset(v, p.id); onProjection?.(v.projectionMode); return }
    if (e.key === ']') onExaggeration(1)
    if (e.key === '[') onExaggeration(-1)
    if (e.key === 'o' || e.key === 'O') {
      const next: ProjectionMode =
        v.projectionMode === 'perspective' ? 'orthographic' : 'perspective'
      v.setProjection(next)
      onProjection?.(next)
    }
  })
}
