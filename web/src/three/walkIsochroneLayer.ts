// 徒歩圏（道路ネットワーク等時線 ＋ 単純バッファ）の表示。複数自治体からの要望 T2
// （`docs/todo.md`）のファイル出力（`scripts/94_walk_isochrone.py`）をそのまま
// 描くだけの層。**T1 の中心点 UI とは統合しない** — 起点は渡された GeoJSON の
// ものをそのまま使う、再利用可能な API として切り出す（統合は別 PR）。
//
// ## 決めごと（`three/catchmentLayer.ts` に倣う）
//
// - **ワールド座標の水平な板。** `scripts/94` の出力は EPSG:4326 の面ポリゴンで
//   標高を持たない（等時線は地表の起伏でなく道路網の距離で決まる）。catchmentLayer
//   と同じく z = ジオイド高 + わずかな持ち上げの水平面で足りる。
// - **ネットワーク等時線＝面＋縁、単純バッファ＝縁だけ。** 単純バッファは
//   「道でつながっていない土地まで含む過大な目安」であって主張したい実体は
//   ネットワーク側なので、面を塗らず輪郭だけに落として主張を弱める
//   （`docs/results.md`「徒歩10分圏」の比 ≈ 0.2 が示すとおり差は大きい）。
// - **色は暫定。** 画面の色予算（地面＝灰 / 建物＝灰・黄・赤 / 水＝青 /
//   道路＝ほぼ白 / 窪地＝薄い水色 / 集水域＝明度違いの生成り）にまだ調停していない
//   単独 PR のため、ネットワーク＝緑系の面、バッファ＝暖色系の輪郭で仮に分けた。
//   本体に統合する際は他レイヤとの同時表示を見て最終決定する。
// - **起点マーカーは線路・越流点と同じ無彩色の小さな輪＋点。** 新しい色相を増やさない。
// - **Group の renderOrder = 48**（集水域 47 の上）。2 面と起点マーカーは
//   個別の Group に分けて `setLayerVisible` で独立に切り替えられるようにする。
// - **表示文字列（起点・所要時間・「公式歩行者網ではない」）は 3D に焼かない。**
//   `domain/walkIsochrone.ts` の `walkIsochroneInfo` が返す値を `info` として
//   公開し、UI パネル側で描く（`three/railwayLine.ts` も注意書きは持たない）。

import {
  BufferGeometry, Float32BufferAttribute, GLSL3, Group, LineBasicMaterial,
  LineLoop, LineSegments, Mesh, Path, Shape, ShapeGeometry, ShaderMaterial,
} from 'three'

import type {
  WalkIsochroneFeature, WalkIsochroneGeoJSON, WalkIsochroneInfo, WalkIsochroneLayerKey,
} from '../domain/walkIsochrone'
import { hasReachablePolygon, pickWalkIsochroneLayer, walkIsochroneInfo } from '../domain/walkIsochrone'
import { lngLatToWorld, type LocalFrame } from './mercator'

/** 地形・地物と z-fight させないための持ち上げ [m]（集水域が 0.2） */
const Z_BIAS = 0.22
/** 起点マーカーの半径 [m] */
const ORIGIN_RADIUS_M = 5

const FILL_VS = /* glsl */ `
uniform float uZ;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, uZ, 1.0);
}
`
// ネットワーク等時線の面。緑系で「歩いて実際に届く範囲」を明るく塗る
const FILL_FS = /* glsl */ `
precision highp float;
out vec4 c;
void main() { c = vec4(0.30, 0.62, 0.45, 0.22); }
`

const NETWORK_LINE_COLOR = 0x1f4d38
/** 単純バッファは主張を弱める暖色の縁だけ（面は塗らない） */
const BUFFER_LINE_COLOR = 0x8a6a3d
/** 起点マーカー・無彩色（線路の INK と同じ） */
const ORIGIN_COLOR = 0x1c2126

export type { WalkIsochroneLayerKey } from '../domain/walkIsochrone'

export interface WalkIsochroneLayer {
  object: Group
  /** 直近の `setData` に渡した GeoJSON の要約（起点・所要時間・注意書き）。無ければ null */
  readonly info: WalkIsochroneInfo | null
  /** GeoJSON を差し替える。`null` で消す。 */
  setData(data: WalkIsochroneGeoJSON | null): void
  /** ネットワーク等時線 / 単純バッファを個別に表示・非表示できる。 */
  setLayerVisible(layer: WalkIsochroneLayerKey, visible: boolean): void
  isLayerVisible(layer: WalkIsochroneLayerKey): boolean
  dispose(): void
}

function polygonsOf(f: WalkIsochroneFeature): number[][][][] {
  const g = f.geometry
  if (!g) return []
  return g.type === 'Polygon'
    ? [g.coordinates as number[][][]]
    : (g.coordinates as number[][][][])
}

function ringPath<T extends Path>(p: T, frame: LocalFrame, ring: number[][]): T {
  const [x0, y0] = lngLatToWorld(frame, ring[0][0], ring[0][1])
  p.moveTo(x0, y0)
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = lngLatToWorld(frame, ring[i][0], ring[i][1])
    p.lineTo(x, y)
  }
  p.closePath()
  return p
}

function outlinePositions(frame: LocalFrame, f: WalkIsochroneFeature, z: number): number[] {
  const pos: number[] = []
  for (const rings of polygonsOf(f)) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = lngLatToWorld(frame, ring[i][0], ring[i][1])
        const b = lngLatToWorld(frame, ring[(i + 1) % ring.length][0], ring[(i + 1) % ring.length][1])
        pos.push(a[0], a[1], z, b[0], b[1], z)
      }
    }
  }
  return pos
}

export function createWalkIsochroneLayer(
  frame: LocalFrame, geoid: number,
): WalkIsochroneLayer {
  const z = geoid + Z_BIAS
  const uZ = { value: z }

  const fillMat = new ShaderMaterial({
    glslVersion: GLSL3, vertexShader: FILL_VS, fragmentShader: FILL_FS,
    transparent: true, depthTest: false, depthWrite: false, uniforms: { uZ },
  })
  const networkLineMat = new LineBasicMaterial({
    color: NETWORK_LINE_COLOR, transparent: true, opacity: 0.9,
    depthTest: false, depthWrite: false,
  })
  const bufferLineMat = new LineBasicMaterial({
    color: BUFFER_LINE_COLOR, transparent: true, opacity: 0.75,
    depthTest: false, depthWrite: false,
  })
  const originMat = new LineBasicMaterial({
    color: ORIGIN_COLOR, transparent: true, opacity: 0.9,
    depthTest: false, depthWrite: false,
  })

  const group = new Group()
  group.renderOrder = 48
  group.visible = false

  const networkGroup = new Group()
  const bufferGroup = new Group()
  const originGroup = new Group()
  group.add(networkGroup, bufferGroup, originGroup)

  let networkVisible = true
  let bufferVisible = true
  let info: WalkIsochroneInfo | null = null

  function clearGroup(g: Group) {
    for (const child of [...g.children]) {
      g.remove(child)
      if (child instanceof Mesh || child instanceof LineSegments || child instanceof LineLoop) {
        child.geometry.dispose()
      }
    }
  }

  function clear() {
    clearGroup(networkGroup)
    clearGroup(bufferGroup)
    clearGroup(originGroup)
    group.visible = false
    info = null
  }

  function addOriginMarker(lon: number, lat: number) {
    const [x, y] = lngLatToWorld(frame, lon, lat)
    const segs = 24
    const pos: number[] = []
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2
      pos.push(x + Math.cos(a) * ORIGIN_RADIUS_M, y + Math.sin(a) * ORIGIN_RADIUS_M, z)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    const ring = new LineLoop(g, originMat)
    ring.frustumCulled = false
    originGroup.add(ring)

    const dotPos: number[] = []
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      dotPos.push(x + Math.cos(a) * (ORIGIN_RADIUS_M * 0.3), y + Math.sin(a) * (ORIGIN_RADIUS_M * 0.3), z)
    }
    const dg = new BufferGeometry()
    dg.setAttribute('position', new Float32BufferAttribute(dotPos, 3))
    const dot = new LineLoop(dg, originMat)
    dot.frustumCulled = false
    originGroup.add(dot)
  }

  function addFeature(g: Group, f: WalkIsochroneFeature, fill: boolean, lineMat: LineBasicMaterial) {
    if (!hasReachablePolygon(f)) return
    if (fill) {
      const shapes: Shape[] = []
      for (const rings of polygonsOf(f)) {
        const shape = ringPath(new Shape(), frame, rings[0])
        for (let h = 1; h < rings.length; h++) {
          shape.holes.push(ringPath(new Path(), frame, rings[h]))
        }
        shapes.push(shape)
      }
      const mesh = new Mesh(new ShapeGeometry(shapes), fillMat)
      mesh.frustumCulled = false
      g.add(mesh)
    }
    const linePos = outlinePositions(frame, f, z)
    if (linePos.length === 0) return
    const lg = new BufferGeometry()
    lg.setAttribute('position', new Float32BufferAttribute(linePos, 3))
    const outline = new LineSegments(lg, lineMat)
    outline.frustumCulled = false
    g.add(outline)
  }

  function setData(data: WalkIsochroneGeoJSON | null) {
    clear()
    if (!data) return
    info = walkIsochroneInfo(data)

    const net = pickWalkIsochroneLayer(data, 'network_isochrone')
    const buf = pickWalkIsochroneLayer(data, 'simple_buffer')
    if (net) addFeature(networkGroup, net, true, networkLineMat)
    if (buf) addFeature(bufferGroup, buf, false, bufferLineMat)
    addOriginMarker(data.metadata.origin_lon, data.metadata.origin_lat)

    networkGroup.visible = networkVisible
    bufferGroup.visible = bufferVisible
    group.visible = true
  }

  function setLayerVisible(layer: WalkIsochroneLayerKey, visible: boolean) {
    if (layer === 'network_isochrone') {
      networkVisible = visible
      networkGroup.visible = visible
    } else {
      bufferVisible = visible
      bufferGroup.visible = visible
    }
  }

  function isLayerVisible(layer: WalkIsochroneLayerKey): boolean {
    return layer === 'network_isochrone' ? networkVisible : bufferVisible
  }

  return {
    object: group,
    get info() { return info },
    setData,
    setLayerVisible,
    isLayerVisible,
    dispose() {
      clear()
      fillMat.dispose()
      networkLineMat.dispose()
      bufferLineMat.dispose()
      originMat.dispose()
    },
  }
}
