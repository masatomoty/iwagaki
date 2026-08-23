// カメラのプリセットと操作。**MapLibre は使わない**（three.js 実体は src/three/viewer.ts）。
//
// MapLibre がここで担っていたのはカメラ・投影・ギズモだけで、ベースマップは
// 1 枚も描いていなかった（style の sources が空だった）。それに初期チャンクの
// 約 1/3 を払っていたので外した（docs/WEB_RESULTS.md §8.1）。
//
// 外向きの export 名は変えていない。src/ui/controls.ts がこのモジュールから
// CAMERA_PRESETS / CameraPresetId を読んでいるため。

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'

import type { Catalog } from '../domain/catalog'
import { createLocalFrame, lngLatToWorld } from '../three/mercator'
import { Viewer, type ProjectionMode } from '../three/viewer'
import { ViewCube } from './viewCube'

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

/**
 * 起動時のスケール。**タイル 1 枚 = 256 px 基準**（`Viewer.setZoom` の規約）。
 *
 * 旧実装の MapLibre は zoom 15.6 で起動していたが、MapLibre の zoom は
 * タイル 512 px 基準なので、同じ景色は 256 px 基準では **16.6** になる。
 * 移行直後はここに 15.6 をそのまま書いていて、**実測で m/px が 1.282 対 2.567
 * （ちょうど 2 倍）、可視範囲が 4 倍**になっていた。要求するタイルも
 * z17 が 25 枚 -> z16 が 9 枚と 1 段粗く、配信性能の比較が成立していなかった。
 * ここを変えると `docs/WEB_RESULTS.md` の数字と比べられなくなる。
 */
export const INITIAL_ZOOM = 16.6

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


/**
 * 右上にビューキューブを置く。カメラに追従し、面/辺/角で整列、ドラッグで回転。
 * 実装は `view/viewCube.ts`（描画ライブラリに依存しない 2D canvas）。
 */
export function attachViewCube(v: Viewer): ViewCube {
  const cube = new ViewCube({
    size: 128,
    onPick: (o) => v.easeTo({ bearing: o.bearingDeg, pitch: o.pitchDeg }, 450),
    onDrag: (dx, dy) => {
      // 横は方位、縦は傾き。上限は Viewer.setCamera が丸める
      const c = v.cameraState
      v.setCamera({ bearing: c.bearing + dx * 0.6, pitch: c.pitch - dy * 0.4 })
    },
  })
  const host = document.createElement('div')
  host.id = 'viewcube'
  host.appendChild(cube.el)

  // ホーム。起動時の視点に戻す。**キューブは向きしか戻せない**
  // （面をクリックしても中心とズームは動かない）ので、別に要る
  const home0 = { ...v.cameraState, target: [...v.cameraState.target] as [number, number] }
  const home = document.createElement('button')
  home.id = 'viewcube-home'
  home.type = 'button'
  home.textContent = '⌂'
  home.title = 'ホーム（起動時の俯瞰に戻る）'
  home.addEventListener('click', () => {
    // 軸方向プリセットで正射に切り替わっていることがある。俯瞰は透視で見る
    v.setProjection('perspective')
    v.easeTo(home0, 600)
  })
  host.appendChild(home)

  v.canvas.parentElement!.appendChild(host)
  const sync = () => cube.setOrientation({
    bearingDeg: v.cameraState.bearing, pitchDeg: v.cameraState.pitch,
  })
  v.on('move', sync)
  sync()
  return cube
}

/**
 * 断面の測線を地図に描く。**どこを切った断面なのかが分からないと読めない。**
 *
 * WebGL の `LineBasicMaterial` は `linewidth` を無視して必ず 1 px になるので、
 * 板（三角形 2 枚）で引く。太さは画面上の px で決めたいが、板はワールド座標なので
 * カメラが動くたびに `metresPerPixel()` から作り直す。
 *
 * `depthTest: false` で常に手前に出す。地形メッシュは測線の真上を横切るので、
 * 深度で素直に比べると天端の向こう側が隠れて「どこを切ったか」が読めない。
 */
export function showSectionLine(
  v: Viewer, from: [number, number], to: [number, number],
): void {
  const [ax, ay] = lngLatToWorld(v.frame, from[0], from[1])
  const [bx, by] = lngLatToWorld(v.frame, to[0], to[1])

  let g = v.world.getObjectByName(SECTION_LINE) as Group | undefined
  if (!g) {
    g = new Group()
    g.name = SECTION_LINE
    g.renderOrder = 900
    // 縁取り -> 本体の順に重ねる。地形の明暗どちらの上でも読めるようにする
    for (const [colour, opacity] of [[0x0b1020, 0.75], [0xf59e0b, 0.95]] as const) {
      const mesh = new Mesh(ribbonGeometry(), new MeshBasicMaterial({
        color: colour, depthTest: false, transparent: true, opacity,
      }))
      mesh.frustumCulled = false
      g.add(mesh)
    }
    v.world.add(g)
    // カメラが動いたら太さを引き直す。**引いた測線を覚えておかないとできない**
    v.on('move', () => {
      const cur = sectionEnds
      if (cur) redrawRibbons(v, cur[0], cur[1], cur[2], cur[3])
    })
  }
  sectionEnds = [ax, ay, bx, by]
  redrawRibbons(v, ax, ay, bx, by)
}

const SECTION_LINE = 'section-line'
/** 直近に引いた測線のワールド座標 [ax, ay, bx, by]。太さの引き直しに要る */
let sectionEnds: [number, number, number, number] | null = null
/** 画面上の太さ [px]。縁取りと本体 */
const RIBBON_PX = [7, 3]
/** 地形より十分上。depthTest を切っているので見えかたには影響しない */
const RIBBON_Z = 300

function ribbonGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(4 * 3), 3))
  g.setIndex([0, 1, 2, 2, 1, 3])
  return g
}

function redrawRibbons(
  v: Viewer, ax: number, ay: number, bx: number, by: number,
): void {
  const g = v.world.getObjectByName(SECTION_LINE) as Group | undefined
  if (!g) return
  const len = Math.hypot(bx - ax, by - ay) || 1
  const nx = -(by - ay) / len          // 線に直交する単位ベクトル
  const ny = (bx - ax) / len
  const mpp = v.metresPerPixel()
  g.children.forEach((child, i) => {
    const half = (RIBBON_PX[i] * mpp) / 2
    const pos = ((child as Mesh).geometry.getAttribute('position') as BufferAttribute)
    pos.copyArray(new Float32Array([
      ax + nx * half, ay + ny * half, RIBBON_Z,
      ax - nx * half, ay - ny * half, RIBBON_Z,
      bx + nx * half, by + ny * half, RIBBON_Z,
      bx - nx * half, by - ny * half, RIBBON_Z,
    ]))
    pos.needsUpdate = true
  })
  v.invalidate()
}
