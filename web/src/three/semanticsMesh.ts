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

import { decisionChanged, featureDepth, roadClass } from '../domain/flood'
import type { ComparisonPair, FeatureAssertion, RoadColorMode,
              TerrainCondition } from '../domain/types'
import type { RawFeature } from '../view/semantics'
import { lngLatToWorld, type LocalFrame } from './mercator'

export interface SemanticsStyle {
  waterLevel: number
  condition: TerrainCondition
  roadThresholds: number[]
  changedOnly: boolean
  /** 判定を比べる 2 条件。`domain/terrain.ts` の comparisonPair() から来る */
  pair: ComparisonPair
  /** 道路（`tran:Road`）を描くか。建物と別に切れる */
  roads: boolean
  /** 道路の塗り分け。既定は一律（`domain/types.ts` の RoadColorMode） */
  roadColor: RoadColorMode
}

/**
 * **道路は建物と別の配色にする。**
 *
 * 道路 293 本は前から読み込んで描いていたのに、建物とまったく同じ
 * 「乾 = 灰 / 浸水 = 青 / 判定変化 = 赤」で塗っていたので、
 * **画面上で道路がどれなのか区別できなかった**（外部から「道路がどこなのか
 * 分かるように表示してほしい」と要望が来た。2026-08）。
 *
 * 乾いているときは暖色の淡色（建物の冷たい灰と分かれる）、浸かったら
 * **通行支障クラス**で塗る。閾値は解析側が持っている
 * `config.py` の `ROAD_DEPTH_CLASSES = (0.1, 0.3, 0.5)` がそのまま
 * catalog 経由で来るので、ここに数字は書かない。
 *
 * 判定が変わる地物の赤は道路でも赤のまま残す（`docs/results.md` の
 * 「道路の通行支障クラスのみ変化」の列と読み合わせるため）。
 * 通行支障クラスの一番上（0.5 m 以上）はその赤と混ざらない暗い煉瓦色にしてある。
 */
// 塗りメッシュの不透明度は 0.55 なので、地面（灰）に負けない彩度が要る。
// 最初 [0.90, 0.85, 0.72] にしたら**平面視で道路が輪郭線しか見えなかった**
/**
 * **一律のときの道路の色。ほぼ白。**
 *
 * 画面で使える色の枠は 地面＝暗い灰 / 建物＝灰・黄・赤（浸水深）/ 水＝青 で
 * 埋まっている。道路をそのどれとも当たらない色にするには明色しか残らない。
 * 白なら暗い地面の上でも、青い水面の上でも、黄・赤の建物の隣でも読める。
 *
 * **最初は暖色の淡色（クリーム）にしていた。** 建物の既定が用途（青・緑・桃）
 * だったころは分かれていたが、既定を浸水深にした瞬間に床下浸水の黄と
 * 同じ色域になり、**町が一様な黄色の塊になって道路が消えた**（2026-08）。
 */
const ROAD_PLAIN: [number, number, number] = [0.94, 0.96, 0.98]
const ROAD_DRY: [number, number, number] = [1.00, 0.90, 0.60]
/**
 * 浸かった道路。**水と混ざらない暖色〜赤の一本道**にしてある。
 * 最初は class0 を水色にしていたが、水面（水色）の下に置くと消えた。
 */
const ROAD_WET: [number, number, number][] = [
  [0.98, 0.95, 0.76],   // 0     〜0.1 m
  [1.00, 0.78, 0.15],   // 0.1 m 〜0.3 m
  [0.97, 0.48, 0.08],   // 0.3 m 〜0.5 m
  [0.85, 0.15, 0.12],   // 0.5 m 以上
]
/**
 * 道路の塗りだけ不透明度を上げる倍率（`uOpacity` 0.55 に掛かる）。
 * 水面を張ると水深に応じて 0.46〜0.84 の青が上から乗るので、
 * **0.55 のままでは水の下で道路が消える**（実測）。
 */
const ROAD_ALPHA = 1.75
/**
 * 道路の輪郭（縁石）。**塗りが何色でも網としての形が読めるようにする。**
 * 暗くしておけば、明色の一律でも通行支障の暖色でも縁が立つ。
 */
const ROAD_LINE: [number, number, number] = [0.09, 0.10, 0.12]

/** 選択中・ホバー中の地物。強調は色属性だけで表す（ジオメトリは不変） */
export interface SemanticsHighlight {
  selected?: string
  hovered?: string
}

const VS = /* glsl */ `
in vec3 aColor;
in float aGround;
in float aAlpha;
uniform float uExaggeration;
uniform float uGeoid;
uniform float uZBias;
out vec3 vColor;
out float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec3 p = position;
  p.z = uGeoid + aGround * uExaggeration + uZBias;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 fragColor;
uniform float uOpacity;
void main() {
  // **地物ごとの不透明度。** 塗りは 0.55 で建物にはそれで足りるが、
  // 道路は水面（水深に応じて 0.46〜0.84）の下に置くと消えてしまう。
  // vAlpha は地物ごとの倍率で、1.0 を超えると 1.0 に飽和する
  float a = min(1.0, uOpacity * vAlpha);
  if (a <= 0.003) discard;
  fragColor = vec4(vColor, a);
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
  // 既定は 1.0。recolor() が地物ごとに書き換える（道路だけ上げる）
  g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1))
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
  g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1))
  g.computeBoundingSphere()
  return { geometry: g, faceFeature: new Int32Array(0), vertFeature: Int32Array.from(vertFeature) }
}

/**
 * 選択・ホバーの枠線を 1 地物ぶんだけ作る。**線ではなく帯（三角形）で作る。**
 *
 * 理由が 2 つある。
 *  1. **WebGL の `linewidth` はほとんどの実装で 1 px に固定される。** 太い線は
 *     引けないので、1 px の輪郭では俯瞰で「どれを選んだか」が読めなかった
 *  2. 地物ポリゴンは地面の高さにあり、PLATEAU 建物（3D Tiles）の箱がその上に
 *     立つので、色属性を書き換えるだけでは箱に隠れる
 *
 * 幅はメートルで与える（ズームに追従しないので、寄れば太く見える）。
 * 角は辺ごとの矩形だけでは隙間が開くので、頂点に正方形を置いて埋める。
 * 描くときは `depthTest: false` で必ず手前に出す。
 */
/**
 * 当たり判定用のリング（ワールド XY）と AABB。
 *
 * **`Raycaster` でメッシュを撃ってはいけない。** 地物ポリゴンの
 * `position.z` は 0 で、実際の高さは頂点シェーダが
 * `z = geoid + aGround * exaggeration` で与えている。レイキャスタは CPU 側の
 * ジオメトリしか見ないので z=0 の平面と交わり、**画面上でカーソルより
 * 奥（上）の地物が当たる**（実測: pitch 52° で地上 47 m ≈ 79 px のずれ）。
 *
 * なので地物ごとに「その地物が描かれている高さの水平面」とレイを交え、
 * ワールド XY で内外判定する。穴のあるポリゴンも扱えるよう even-odd で数える。
 */
interface PickShape {
  /** リングごとの [x0,y0, x1,y1, ...] */
  rings: Float32Array[]
  minx: number; miny: number; maxx: number; maxy: number
  ground: number
}

function buildPickShape(
  frame: LocalFrame, feature: RawFeature, ground: number,
): PickShape | undefined {
  const polys: number[][][][] =
    feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates as number[][][]]
    : feature.geometry.type === 'MultiPolygon' ? (feature.geometry.coordinates as number[][][][])
    : []
  const rings: Float32Array[] = []
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const poly of polys) {
    for (const ring of poly) {
      const w = ringToWorld(frame, ring)
      if (w.length < 3) continue
      const a = new Float32Array(w.length * 2)
      for (let i = 0; i < w.length; i++) {
        a[i * 2] = w[i].x
        a[i * 2 + 1] = w[i].y
        if (w[i].x < minx) minx = w[i].x
        if (w[i].x > maxx) maxx = w[i].x
        if (w[i].y < miny) miny = w[i].y
        if (w[i].y > maxy) maxy = w[i].y
      }
      rings.push(a)
    }
  }
  return rings.length ? { rings, minx, miny, maxx, maxy, ground } : undefined
}

/** even-odd。穴（内側リング）を持つ footprint でも正しく外になる */
function pointInShape(sh: PickShape, x: number, y: number): boolean {
  let inside = false
  for (const r of sh.rings) {
    const n = r.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2], yi = r[i * 2 + 1]
      const xj = r[j * 2], yj = r[j * 2 + 1]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
  }
  return inside
}

function buildOutlineBand(
  frame: LocalFrame, feature: RawFeature, ground: number, widthM: number,
): BufferGeometry {
  const pos: number[] = []
  const g: number[] = []
  const hw = widthM / 2
  const quad = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
  ) => {
    pos.push(ax, ay, 0, bx, by, 0, cx, cy, 0, ax, ay, 0, cx, cy, 0, dx, dy, 0)
    for (let k = 0; k < 6; k++) g.push(ground)
  }
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
        const ex = b.x - a.x
        const ey = b.y - a.y
        const len = Math.hypot(ex, ey)
        if (len > 1e-6) {
          // 辺に垂直な向きへ hw だけ広げた矩形
          const px = (-ey / len) * hw
          const py = (ex / len) * hw
          quad(a.x + px, a.y + py, b.x + px, b.y + py,
               b.x - px, b.y - py, a.x - px, a.y - py)
        }
        // 角の隙間埋め（辺の向きに依らない正方形）
        quad(a.x - hw, a.y - hw, a.x + hw, a.y - hw,
             a.x + hw, a.y + hw, a.x - hw, a.y + hw)
      }
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('aGround', new BufferAttribute(new Float32Array(g), 1))
  geo.setAttribute('aColor', new BufferAttribute(new Float32Array(pos.length), 3))
  // 強調の輪郭は常に不透明側。**属性が無いと WebGL2 は 0 を渡すので必ず持たせる**
  geo.setAttribute('aAlpha', new BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1))
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
  private pickShapes: (PickShape | undefined)[] = []
  private exaggeration = 1
  /** 選択・ホバーの枠線。1 地物ぶんだけ作り直す（建物の箱より手前に描く） */
  private selLine: Mesh
  private hovLine: Mesh
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
    this.pickShapes = features.map((f, i) => buildPickShape(frame, f, grounds[i]))
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
    this.selLine = new Mesh(new BufferGeometry(), this.selMat)
    this.hovLine = new Mesh(new BufferGeometry(), this.hovMat)
    this.selLine.renderOrder = 20
    this.hovLine.renderOrder = 19
    this.selLine.visible = this.hovLine.visible = false
    this.group.add(this.fillMesh, this.lineMesh, this.hovLine, this.selLine)
    // **Group の renderOrder は子の renderOrder より先に比較される**
    // （three の projectObject が Group の renderOrder を groupOrder にして、
    //  sort が groupOrder -> renderOrder の順で見る）。
    // 地形タイルのピラミッドは Group の renderOrder が 0（粗）と 1（細）なので、
    // ここを 0 のままにすると **細タイルとその水面が地物より後に描かれる**。
    // 水面を張った瞬間に浸水域の道路と建物のポリゴンが消えたのはこれが原因だった [実測]。
    this.group.renderOrder = 30
  }

  setVisible(v: boolean) { this.group.visible = v }

  setExaggeration(k: number) {
    this.exaggeration = k
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
    // 選択は 2.4 m 幅の白。ホバーは 1.2 m 幅の水色（選択より控える）
    this.rebuildOutline(this.selLine, h.selected, [1, 1, 1], 2.4)
    this.rebuildOutline(this.hovLine, h.hovered === h.selected ? undefined : h.hovered,
      [0.6, 0.82, 1], 1.2)
    if (this.style) this.recolor()
  }

  private rebuildOutline(
    line: Mesh, gmlId: string | undefined, rgb: [number, number, number], widthM: number,
  ) {
    line.geometry.dispose()
    const fi = gmlId ? this.byGmlId.get(gmlId) : undefined
    if (fi === undefined) {
      line.geometry = new BufferGeometry()
      line.visible = false
      return
    }
    const geo = buildOutlineBand(this.frame, this.features[fi], this.grounds[fi], widthM)
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
    const fillAlpha = this.fill.geometry.getAttribute('aAlpha') as BufferAttribute
    const fa = fillCol.array as Float32Array
    const la = lineCol.array as Float32Array
    const faa = fillAlpha.array as Float32Array

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
    const alpha = new Float32Array(this.assertions.length).fill(1)
    this.assertions.forEach((a, i) => {
      const changed = a ? decisionChanged(a, s.waterLevel, s.roadThresholds, s.pair) : false
      const isRoad = a?.featureType === 'tran:Road'
      const depth = a ? featureDepth(a, s.condition, s.waterLevel) : 0
      let c: [number, number, number]
      if (s.changedOnly && !changed) { hide[i] = 1; c = [0, 0, 0] }
      else if (isRoad && !s.roads) { hide[i] = 1; c = [0, 0, 0] }
      else if (a?.unreliable) c = [0.43, 0.43, 0.47]
      // **道路の塗りは道路の話だけを表す。** 判定が変わったことは輪郭（黄）が担う。
      // 塗りに 2 つの意味（判定変化の赤 / 通行支障）を載せると、
      // どちらを見ているのか画面から決められない
      else if (isRoad) {
        c = s.roadColor === 'trafficability'
          ? (depth > 0 ? ROAD_WET[roadClass(depth, s.roadThresholds)] : ROAD_DRY)
          : ROAD_PLAIN
      }
      else if (changed) c = [0.95, 0.27, 0.20]
      else if (depth > 0) c = [0.27, 0.51, 0.78]
      // 建物の非浸水。3D の箱（view/buildingColor.ts の DEPTH_CLASSES.dry）と
      // 同じ中間の灰にする。明るくすると一律の道路（ほぼ白）と分からなくなる
      else c = [0.60, 0.63, 0.66]
      alpha[i] = isRoad ? ROAD_ALPHA : 1
      let l: [number, number, number] = changed ? [1.0, 0.86, 0.47]
        : isRoad ? ROAD_LINE : [0.08, 0.09, 0.13]

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
      faa[v] = alpha[fi]
    }
    for (let v = 0; v < this.outline.vertFeature.length; v++) {
      const fi = this.outline.vertFeature[v]
      la[v * 3] = lrgb[fi * 3]
      la[v * 3 + 1] = lrgb[fi * 3 + 1]
      la[v * 3 + 2] = lrgb[fi * 3 + 2]
    }
    fillCol.needsUpdate = true
    lineCol.needsUpdate = true
    fillAlpha.needsUpdate = true
    this.hidden = hide
  }

  private hidden = new Uint8Array(0)

  /**
   * 画面クリック -> 地物。deck.gl の pickable の置き換え。
   *
   * **メッシュへのレイキャストはしない。** 高さは頂点シェーダが与えていて
   * CPU 側のジオメトリは z=0 なので、`Raycaster.intersectObject` は
   * カーソルより奥（画面では上）の地物を返す。地物ごとに
   * 「描かれている高さの水平面」とレイを交えて XY で内外判定する。
   *
   * @param ndc 正規化デバイス座標 [-1,1]
   */
  pick(ndc: Vector2, camera: Parameters<Raycaster['setFromCamera']>[1]): FeatureAssertion | undefined {
    this.raycaster.setFromCamera(ndc, camera)
    const o = this.raycaster.ray.origin
    const d = this.raycaster.ray.direction
    if (Math.abs(d.z) < 1e-9) return undefined
    let bestT = Infinity
    let bestI = -1
    for (let i = 0; i < this.pickShapes.length; i++) {
      const sh = this.pickShapes[i]
      if (!sh || this.hidden[i]) continue
      // 塗りメッシュと同じ高さ（material の zBias 0.05 を含む）
      const z = this.geoid + sh.ground * this.exaggeration + 0.05
      const t = (z - o.z) / d.z
      if (t <= 0 || t >= bestT) continue
      const x = o.x + d.x * t
      const y = o.y + d.y * t
      if (x < sh.minx || x > sh.maxx || y < sh.miny || y > sh.maxy) continue
      if (!pointInShape(sh, x, y)) continue
      bestT = t
      bestI = i
    }
    return bestI >= 0 ? this.assertions[bestI] : undefined
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
 * AOI 100 ha に対し点群は 3.17 ha しかない（docs/results.md）ので、
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

