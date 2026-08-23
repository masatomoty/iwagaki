// PLATEAU 地物（建物・道路）の three.js 版。@deck.gl/layers GeoJsonLayer の置き換え。
//
// deck 版より 1 つ良くなっている点: **鉛直強調でジオメトリを作り直さない**。
// 旧実装は exaggeration が変わるたび全地物の座標を JS で作り直していた
// （main.ts の rebuildFeatureGeometry）。ここでは地盤高を頂点属性に持たせ、
// z = geoid + groundElev * k をシェーダで組むので uniform 1 個で済む。
//
// 色も同じ考えで、水位が変わったら**色属性だけ**書き換える（ジオメトリは不変）。

import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, Group, LineSegments,
  Mesh, Raycaster, ShaderMaterial, ShapeUtils, Vector2,
} from 'three'

import { decisionChanged, featureDepth } from '../domain/flood'
import type { FeatureAssertion, TerrainCondition } from '../domain/types'
import type { RawFeature } from '../view/semantics'
import { lngLatToWorld, type LocalFrame } from './mercator'

export interface SemanticsStyle {
  waterLevel: number
  condition: TerrainCondition
  roadThresholds: number[]
  changedOnly: boolean
}

const VS = /* glsl */ `
in vec3 aColor;
in float aGround;
uniform float uExaggeration;
uniform float uGeoid;
uniform float uZBias;
out vec3 vColor;
out float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = 1.0;
  vec3 p = position;
  p.z = uGeoid + aGround * uExaggeration + uZBias;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 fragColor;
uniform float uOpacity;
void main() {
  if (uOpacity <= 0.003) discard;
  fragColor = vec4(vColor, uOpacity);
}
`

/** 頂点色に α を持たせられないので、α が要る塗りは 2 パスに分ける */
interface Built {
  geometry: BufferGeometry
  /** 三角形 index -> features[] の添字 */
  faceFeature: Int32Array
  /** 頂点 -> features[] の添字 */
  vertFeature: Int32Array
}

function ringToWorld(f: LocalFrame, ring: number[][]): Vector2[] {
  return ring.map((c) => {
    const [x, y] = lngLatToWorld(f, c[0], c[1])
    return new Vector2(x, y)
  })
}

function buildFill(frame: LocalFrame, features: RawFeature[], grounds: number[]): Built {
  const pos: number[] = []
  const ground: number[] = []
  const vertFeature: number[] = []
  const faceFeature: number[] = []
  const index: number[] = []

  features.forEach((f, fi) => {
    const polys: number[][][][] =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]]
      : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][])
      : []
    for (const poly of polys) {
      if (!poly.length) continue
      const contour = ringToWorld(frame, poly[0])
      const holes = poly.slice(1).map((r) => ringToWorld(frame, r))
      if (contour.length < 3) continue
      const base = pos.length / 3
      const all = [contour, ...holes]
      for (const ring of all) {
        for (const p of ring) {
          pos.push(p.x, p.y, 0)
          ground.push(grounds[fi])
          vertFeature.push(fi)
        }
      }
      let tris: number[][]
      try {
        tris = ShapeUtils.triangulateShape(contour, holes)
      } catch {
        continue                       // 自己交差などで三角形化できないものは飛ばす
      }
      for (const t of tris) {
        index.push(base + t[0], base + t[1], base + t[2])
        faceFeature.push(fi)
      }
    }
  })

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aGround', new BufferAttribute(new Float32Array(ground), 1))
  g.setAttribute('aColor', new BufferAttribute(new Float32Array(pos.length), 3))
  g.setIndex(new BufferAttribute(new Uint32Array(index), 1))
  g.computeBoundingSphere()
  return {
    geometry: g,
    faceFeature: Int32Array.from(faceFeature),
    vertFeature: Int32Array.from(vertFeature),
  }
}

function buildOutline(frame: LocalFrame, features: RawFeature[], grounds: number[]): Built {
  const pos: number[] = []
  const ground: number[] = []
  const vertFeature: number[] = []
  features.forEach((f, fi) => {
    const polys: number[][][][] =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]]
      : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][])
      : []
    for (const poly of polys) {
      for (const ring of poly) {
        const w = ringToWorld(frame, ring)
        for (let i = 0; i < w.length; i++) {
          const a = w[i]
          const b = w[(i + 1) % w.length]
          pos.push(a.x, a.y, 0, b.x, b.y, 0)
          ground.push(grounds[fi], grounds[fi])
          vertFeature.push(fi, fi)
        }
      }
    }
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aGround', new BufferAttribute(new Float32Array(ground), 1))
  g.setAttribute('aColor', new BufferAttribute(new Float32Array(pos.length), 3))
  g.computeBoundingSphere()
  return { geometry: g, faceFeature: new Int32Array(0), vertFeature: Int32Array.from(vertFeature) }
}

function material(zBias: number, opacity: number): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uExaggeration: { value: 1 },
      uGeoid: { value: 0 },
      uZBias: { value: zBias },
      uOpacity: { value: opacity },
    },
  })
}

export class SemanticsMesh {
  readonly group = new Group()
  private fill: Built
  private outline: Built
  private fillMesh: Mesh
  private lineMesh: LineSegments
  private fillMat: ShaderMaterial
  private lineMat: ShaderMaterial
  private assertions: FeatureAssertion[]
  private raycaster = new Raycaster()

  constructor(
    private readonly frame: LocalFrame,
    private readonly features: RawFeature[],
    private readonly geoid: number,
  ) {
    this.assertions = features.map((f) => f.properties.__a as FeatureAssertion)
    const grounds = this.assertions.map((a) => a?.groundElev.highres ?? 0)
    this.fill = buildFill(frame, features, grounds)
    this.outline = buildOutline(frame, features, grounds)
    // 地形メッシュと同じ高さに置くと z-fight する。少しだけ持ち上げる
    this.fillMat = material(0.05, 0.55)
    this.lineMat = material(0.10, 0.85)
    this.fillMat.uniforms.uGeoid.value = geoid
    this.lineMat.uniforms.uGeoid.value = geoid
    this.fillMesh = new Mesh(this.fill.geometry, this.fillMat)
    this.lineMesh = new LineSegments(this.outline.geometry, this.lineMat)
    this.fillMesh.renderOrder = 10
    this.lineMesh.renderOrder = 11
    this.group.add(this.fillMesh, this.lineMesh)
  }

  setVisible(v: boolean) { this.group.visible = v }

  setExaggeration(k: number) {
    this.fillMat.uniforms.uExaggeration.value = k
    this.lineMat.uniforms.uExaggeration.value = k
  }

  /** 水位・条件が変わったら色属性だけ書き換える。ジオメトリは触らない */
  setStyle(s: SemanticsStyle) {
    const fillCol = this.fill.geometry.getAttribute('aColor') as BufferAttribute
    const lineCol = this.outline.geometry.getAttribute('aColor') as BufferAttribute
    const fa = fillCol.array as Float32Array
    const la = lineCol.array as Float32Array

    // 地物ごとに 1 回だけ判定する（頂点ごとに呼ぶと 3 万頂点で効く）
    const rgb = new Float32Array(this.assertions.length * 3)
    const hide = new Uint8Array(this.assertions.length)
    const lrgb = new Float32Array(this.assertions.length * 3)
    this.assertions.forEach((a, i) => {
      const changed = a ? decisionChanged(a, s.waterLevel, s.roadThresholds) : false
      let c: [number, number, number]
      if (s.changedOnly && !changed) { hide[i] = 1; c = [0, 0, 0] }
      else if (a?.unreliable) c = [0.43, 0.43, 0.47]
      else if (changed) c = [0.95, 0.27, 0.20]
      else if (a && featureDepth(a, s.condition, s.waterLevel) > 0) c = [0.27, 0.51, 0.78]
      else c = [0.75, 0.76, 0.80]
      rgb.set(c, i * 3)
      lrgb.set(changed ? [1.0, 0.86, 0.47] : [0.08, 0.09, 0.13], i * 3)
    })

    // changedOnly で隠すものは色を落とすのではなく、原点に潰して描画から外す
    for (let v = 0; v < this.fill.vertFeature.length; v++) {
      const fi = this.fill.vertFeature[v]
      fa[v * 3] = rgb[fi * 3]
      fa[v * 3 + 1] = rgb[fi * 3 + 1]
      fa[v * 3 + 2] = rgb[fi * 3 + 2]
    }
    for (let v = 0; v < this.outline.vertFeature.length; v++) {
      const fi = this.outline.vertFeature[v]
      la[v * 3] = lrgb[fi * 3]
      la[v * 3 + 1] = lrgb[fi * 3 + 1]
      la[v * 3 + 2] = lrgb[fi * 3 + 2]
    }
    fillCol.needsUpdate = true
    lineCol.needsUpdate = true
    this.hidden = hide
  }

  private hidden = new Uint8Array(0)

  /**
   * 画面クリック -> 地物。deck.gl の pickable の置き換え。
   * @param ndc 正規化デバイス座標 [-1,1]
   */
  pick(ndc: Vector2, camera: Parameters<Raycaster['setFromCamera']>[1]): FeatureAssertion | undefined {
    this.raycaster.setFromCamera(ndc, camera)
    const hits = this.raycaster.intersectObject(this.fillMesh, false)
    for (const h of hits) {
      if (h.faceIndex === undefined || h.faceIndex === null) continue
      const fi = this.fill.faceFeature[h.faceIndex]
      if (fi === undefined || fi < 0) continue
      if (this.hidden[fi]) continue
      return this.assertions[fi]
    }
    return undefined
  }

  dispose() {
    this.fill.geometry.dispose()
    this.outline.geometry.dispose()
    this.fillMat.dispose()
    this.lineMat.dispose()
  }
}

/**
 * 点群が地表面として効いている範囲の輪郭。
 * AOI 100 ha に対し点群は 3.17 ha しかない（docs/RESULTS.md）ので、
 * 境界が無いと「点群で見た結果」が全域に効いているように読める。
 */
export function createCoverageOutline(
  frame: LocalFrame, data: { features?: RawFeature[] }, z: number,
): LineSegments {
  const pos: number[] = []
  for (const f of data.features ?? []) {
    const polys: number[][][][] =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]]
      : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][])
      : []
    for (const poly of polys) {
      for (const ring of poly) {
        const w = ringToWorld(frame, ring)
        for (let i = 0; i < w.length; i++) {
          const a = w[i]; const b = w[(i + 1) % w.length]
          pos.push(a.x, a.y, z, b.x, b.y, z)
        }
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.computeBoundingSphere()
  const m = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `precision highp float; out vec4 c; void main(){ c = vec4(1.0,0.84,0.25,0.86); }`,
    transparent: true,
    // 地形メッシュの上に線を置く。深度で負けると帯の内側で線が消える
    depthTest: false,
    depthWrite: false,
  })
  const l = new LineSegments(g, m)
  l.renderOrder = 20
  l.frustumCulled = false
  return l
}

