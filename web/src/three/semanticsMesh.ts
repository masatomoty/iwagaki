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
import type { ComparisonPair, FeatureAssertion, TerrainCondition } from '../domain/types'
import type { RawFeature } from '../view/semantics'
import { lngLatToWorld, type LocalFrame } from './mercator'

export interface SemanticsStyle {
  waterLevel: number
  condition: TerrainCondition
  roadThresholds: number[]
  changedOnly: boolean
  /** 判定を比べる 2 条件。`domain/terrain.ts` の comparisonPair() から来る */
  pair: ComparisonPair
}

/** 選択中・ホバー中の地物。強調は色属性だけで表す（ジオメトリは不変） */
export interface SemanticsHighlight {
  selected?: string
  hovered?: string
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

/**
 * 選択・ホバーの輪郭は 1 地物ぶんだけ別に作る。
 *
 * **色属性を書き換えるだけでは強調が見えない。** 地物ポリゴンは地面の高さにあり、
 * PLATEAU 建物（3D Tiles）の箱がその上に立つので、真上から見ると箱に隠れる。
 * ここだけ `depthTest: false` にして、必ず手前に描く。
 */
function buildOneOutline(
  frame: LocalFrame, feature: RawFeature, ground: number,
): BufferGeometry {
  const pos: number[] = []
  const g: number[] = []
  const polys: number[][][][] =
    feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates as number[][][]]
    : feature.geometry.type === 'MultiPolygon' ? (feature.geometry.coordinates as number[][][][])
    : []
  for (const poly of polys) {
    for (const ring of poly) {
      const w = ringToWorld(frame, ring)
      for (let i = 0; i < w.length; i++) {
        const a = w[i]
        const b = w[(i + 1) % w.length]
        pos.push(a.x, a.y, 0, b.x, b.y, 0)
        g.push(ground, ground)
      }
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('aGround', new BufferAttribute(new Float32Array(g), 1))
  const col = new Float32Array(pos.length)
  geo.setAttribute('aColor', new BufferAttribute(col, 3))
  geo.computeBoundingSphere()
  return geo
}

function material(zBias: number, opacity: number, alwaysOnTop = false): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    depthTest: !alwaysOnTop,
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
  private byGmlId = new Map<string, number>()
  private style?: SemanticsStyle
  private highlight: SemanticsHighlight = {}
  private grounds: number[] = []
  /** 選択・ホバーの輪郭。1 地物ぶんだけ作り直す（建物の箱より手前に描く） */
  private selLine: LineSegments
  private hovLine: LineSegments
  private selMat: ShaderMaterial
  private hovMat: ShaderMaterial

  constructor(
    private readonly frame: LocalFrame,
    private readonly features: RawFeature[],
    private readonly geoid: number,
  ) {
    this.assertions = features.map((f) => f.properties.__a as FeatureAssertion)
    this.assertions.forEach((a, i) => { if (a?.gmlId) this.byGmlId.set(a.gmlId, i) })
    const grounds = this.assertions.map((a) => a?.groundElev.highres ?? 0)
    this.grounds = grounds
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
    // 強調の輪郭。深度テストを切って必ず手前に出す
    this.selMat = material(0.12, 1, true)
    this.hovMat = material(0.12, 0.9, true)
    this.selMat.uniforms.uGeoid.value = geoid
    this.hovMat.uniforms.uGeoid.value = geoid
    this.selLine = new LineSegments(new BufferGeometry(), this.selMat)
    this.hovLine = new LineSegments(new BufferGeometry(), this.hovMat)
    this.selLine.renderOrder = 20
    this.hovLine.renderOrder = 19
    this.selLine.visible = this.hovLine.visible = false
    this.group.add(this.fillMesh, this.lineMesh, this.hovLine, this.selLine)
  }

  setVisible(v: boolean) { this.group.visible = v }

  setExaggeration(k: number) {
    this.fillMat.uniforms.uExaggeration.value = k
    this.lineMat.uniforms.uExaggeration.value = k
    this.selMat.uniforms.uExaggeration.value = k
    this.hovMat.uniforms.uExaggeration.value = k
  }

  /** 水位・条件が変わったら色属性だけ書き換える。ジオメトリは触らない */
  setStyle(s: SemanticsStyle) {
    this.style = s
    this.recolor()
  }

  /**
   * 選択とホバーの強調。**`setStyle` とは別の入口にしている。**
   * ホバーはマウス移動ごとに変わるので、store 経由で全体を refresh すると
   * 地形の uniform 更新と断面の再描画まで毎フレーム走る。ここは色属性だけ触る。
   */
  setHighlight(h: SemanticsHighlight) {
    if (h.selected === this.highlight.selected && h.hovered === this.highlight.hovered) return
    this.highlight = { ...h }
    this.rebuildOutline(this.selLine, h.selected, [1, 1, 1])
    this.rebuildOutline(this.hovLine, h.hovered === h.selected ? undefined : h.hovered,
      [0.55, 0.78, 1])
    if (this.style) this.recolor()
  }

  private rebuildOutline(
    line: LineSegments, gmlId: string | undefined, rgb: [number, number, number],
  ) {
    line.geometry.dispose()
    const fi = gmlId ? this.byGmlId.get(gmlId) : undefined
    if (fi === undefined) {
      line.geometry = new BufferGeometry()
      line.visible = false
      return
    }
    const geo = buildOneOutline(this.frame, this.features[fi], this.grounds[fi])
    const col = geo.getAttribute('aColor') as BufferAttribute
    const arr = col.array as Float32Array
    for (let v = 0; v < arr.length; v += 3) { arr[v] = rgb[0]; arr[v + 1] = rgb[1]; arr[v + 2] = rgb[2] }
    col.needsUpdate = true
    line.geometry = geo
    line.visible = true
  }

  /** gml_id -> features[] の添字。強調の対象を引くのに使う */
  indexOf(gmlId: string): number | undefined { return this.byGmlId.get(gmlId) }

  private recolor() {
    const s = this.style
    if (!s) return
    const fillCol = this.fill.geometry.getAttribute('aColor') as BufferAttribute
    const lineCol = this.outline.geometry.getAttribute('aColor') as BufferAttribute
    const fa = fillCol.array as Float32Array
    const la = lineCol.array as Float32Array

    // **絞り込みが先、強調が後。** changedOnly で残ったものの中で選択を目立たせる
    const sel = this.highlight.selected
      ? this.byGmlId.get(this.highlight.selected) : undefined
    const hov = this.highlight.hovered ? this.byGmlId.get(this.highlight.hovered) : undefined
    // 選択中は周りを落とす。**落とすのは色だけ**で、隠しはしない
    // （何が選ばれているかを見せるためで、他を消したいわけではない）
    const dim = sel !== undefined ? 0.42 : 1

    // 地物ごとに 1 回だけ判定する（頂点ごとに呼ぶと 3 万頂点で効く）
    const rgb = new Float32Array(this.assertions.length * 3)
    const hide = new Uint8Array(this.assertions.length)
    const lrgb = new Float32Array(this.assertions.length * 3)
    this.assertions.forEach((a, i) => {
      const changed = a ? decisionChanged(a, s.waterLevel, s.roadThresholds, s.pair) : false
      let c: [number, number, number]
      if (s.changedOnly && !changed) { hide[i] = 1; c = [0, 0, 0] }
      else if (a?.unreliable) c = [0.43, 0.43, 0.47]
      else if (changed) c = [0.95, 0.27, 0.20]
      else if (a && featureDepth(a, s.condition, s.waterLevel) > 0) c = [0.27, 0.51, 0.78]
      else c = [0.75, 0.76, 0.80]
      let l: [number, number, number] = changed ? [1.0, 0.86, 0.47] : [0.08, 0.09, 0.13]

      if (i === sel) {
        // 選択中だけは減光を掛けず、輪郭を白にして最前面に見せる
        c = [Math.min(1, c[0] * 1.35 + 0.1), Math.min(1, c[1] * 1.35 + 0.1),
             Math.min(1, c[2] * 1.35 + 0.1)]
        l = [1, 1, 1]
      } else if (i === hov) {
        l = [0.75, 0.85, 1.0]
        c = [c[0] * dim * 1.4, c[1] * dim * 1.4, c[2] * dim * 1.4]
      } else if (dim !== 1) {
        c = [c[0] * dim, c[1] * dim, c[2] * dim]
        l = [l[0] * dim, l[1] * dim, l[2] * dim]
      }
      rgb.set(c, i * 3)
      lrgb.set(l, i * 3)
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
    this.selLine.geometry.dispose()
    this.hovLine.geometry.dispose()
    this.fillMat.dispose()
    this.lineMat.dispose()
    this.selMat.dispose()
    this.hovMat.dispose()
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

