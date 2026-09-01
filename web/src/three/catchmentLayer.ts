// 「クリックで集水域抽出」のハイライト。クリックしたリーフ流域＋その上流の全リーフ
// （`domain/flow.ts` の `catchmentOf`）を **薄い面＋縁取り**で地形の上に出す。
// 潮位非依存の別オーバーレイ（`catalog.flow.basins`、`docs/web_design.md`
// 「クリックで集水域を抽出する」）。**浸水判定には混ぜない。**
//
// ## 決めごと（`three/pourPoints.ts` に倣う）
//
// - **ワールド座標の水平な板**（z = ジオイド高 + わずかな持ち上げ）。AOI の起伏は
//   0〜3 m なので水平な面で十分。地形との z-fight を避けるため深度テストを切って
//   常に前に出す（俯瞰で見るオーバーレイ）。
// - **色は水みちと同系の青緑。** 面は薄く（α 0.22）、縁は濃く。新しい色相は足さない
//   （`docs/web_design.md`「画面の色は 1 つの予算」）。
// - **Group の renderOrder = 47**（越流点 46 の上）。
// - 面の三角形化は three の `ShapeGeometry`（穴も `Path` で渡せる）。

import {
  BufferGeometry, Float32BufferAttribute, GLSL3, Group, LineBasicMaterial,
  LineSegments, Mesh, Path, Shape, ShapeGeometry, ShaderMaterial,
} from 'three'

import type { FlowBasinFeature } from '../domain/flow'
import { lngLatToWorld, type LocalFrame } from './mercator'

/** 地形・地物と z-fight させないための持ち上げ [m] */
const Z_BIAS = 0.2

const FILL_VS = /* glsl */ `
uniform float uZ;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, uZ, 1.0);
}
`
// 水みちの面はすでに青緑なので、集水域は **明るいクリーム寄りの白** で洗って
// 選択されていることを出す（新しい色相は足さず、明度で分ける）。
const FILL_FS = /* glsl */ `
precision highp float;
out vec4 c;
void main() { c = vec4(0.96, 0.97, 0.92, 0.30); }
`

export interface CatchmentLayer {
  object: Group
  /** ハイライトする流域の feature 群（空／null で消す） */
  setCatchment(features: FlowBasinFeature[] | null): void
  dispose(): void
}

function polygonsOf(f: FlowBasinFeature): number[][][][] {
  const g = f.geometry
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

export function createCatchmentLayer(
  frame: LocalFrame, geoid: number,
): CatchmentLayer {
  const uZ = { value: geoid + Z_BIAS }
  const fillMat = new ShaderMaterial({
    glslVersion: GLSL3, vertexShader: FILL_VS, fragmentShader: FILL_FS,
    transparent: true, depthTest: false, depthWrite: false, uniforms: { uZ },
  })
  const lineMat = new LineBasicMaterial({
    color: 0x0c3b45, transparent: true, opacity: 0.95,
    depthTest: false, depthWrite: false,
  })

  const group = new Group()
  group.renderOrder = 47
  group.visible = false
  let fillMesh: Mesh | undefined
  let outline: LineSegments | undefined

  function clear() {
    if (fillMesh) { group.remove(fillMesh); fillMesh.geometry.dispose(); fillMesh = undefined }
    if (outline) { group.remove(outline); outline.geometry.dispose(); outline = undefined }
  }

  function setCatchment(features: FlowBasinFeature[] | null) {
    clear()
    if (!features || features.length === 0) { group.visible = false; return }

    const shapes: Shape[] = []
    const linePos: number[] = []
    const z = geoid + Z_BIAS
    for (const f of features) {
      for (const rings of polygonsOf(f)) {
        const shape = ringPath(new Shape(), frame, rings[0])
        for (let h = 1; h < rings.length; h++) {
          shape.holes.push(ringPath(new Path(), frame, rings[h]))
        }
        shapes.push(shape)
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const a = lngLatToWorld(frame, ring[i][0], ring[i][1])
            const b = lngLatToWorld(frame, ring[(i + 1) % ring.length][0],
              ring[(i + 1) % ring.length][1])
            linePos.push(a[0], a[1], z, b[0], b[1], z)
          }
        }
      }
    }

    fillMesh = new Mesh(new ShapeGeometry(shapes), fillMat)
    fillMesh.frustumCulled = false
    group.add(fillMesh)

    const lg = new BufferGeometry()
    lg.setAttribute('position', new Float32BufferAttribute(linePos, 3))
    outline = new LineSegments(lg, lineMat)
    outline.frustumCulled = false
    group.add(outline)

    group.visible = true
  }

  return {
    object: group,
    setCatchment,
    dispose() { clear(); fillMat.dispose(); lineMat.dispose() },
  }
}
