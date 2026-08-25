// JR 線路（国土数値情報 N02）。**PLATEAU 舞鶴市に鉄道は入っていない**ので、
// これだけ別データセット由来である（`scripts/12_fetch_railway.py`）。
//
// なぜ線路だけ足したか: 市の要望（2026-08）が **JR 線路を赤破線で示して
// 「表示範囲の東側をここまで」** というものだった。範囲をそこまで広げたのに
// **基準線そのものが画面に無い**と、「どこまで広げたのか」が絵から読めない。
//
// ## 決めごと
//
// - **標高はここで引かない。** 各頂点の Z は `scripts/12` が 0.5m DEM から
//   焼き込んである。地形タイルを待たずに描け、鉛直強調を掛けても地面から浮かない
// - **1 px の線ではなくワールド座標のリボンにする。** 最初 `LineSegments` で
//   出したら、**一律ほぼ白の道路に紛れて読めなかった** [実測]。GL の線幅は
//   WebGL では 1 px 固定なので、道路（ポリゴン）と同じくジオメトリに幅を持たせる。
//   幅は複線の路盤におおよそ相当する 9 m
// - **色は地図記号の慣例（黒白の交互）にする。** 画面の色は 1 つの予算で、
//   地面＝灰 / 建物＝灰・黄・赤 / 水＝青 / 道路＝ほぼ白 / 窪地＝薄い水色 が
//   埋まっている（`docs/web_design.md`「画面の色は 1 つの予算である」）。
//   線路に新しい色相を割ると必ずどこかとぶつかるので、**無彩色の交互**にする。
//   道路との区別は色ではなく**刻みがあること**が担う
// - **刻みはフラグメントで作る。** 距離を varying で渡して縞を計算する。
//   頂点属性で持つと、頂点間で補間されて縞の境目がぼける
// - **`depthTest` は切る。** 参照線なので、山や建物の裏に隠れると用を成さない
//   （点群の被覆輪郭と同じ扱い。`semanticsMesh.ts` の `createCoverageOutline`）

import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, Mesh, ShaderMaterial,
} from 'three'

import { lngLatToWorld, type LocalFrame } from './mercator'

/** 路盤の幅 [m]。複線のおおよその幅 */
const WIDTH_M = 9
/** 交互に色を変える刻みの長さ [m]。地図記号の枕木にあたる */
const TICK_M = 18

export interface RailwayFeature {
  properties?: { line?: string; operator?: string }
  geometry: { type: string; coordinates: number[][] }
}

const VS = /* glsl */ `
in float aDist;
in float aElev;
uniform float uGeoid;
uniform float uExaggeration;
out float vDist;
void main() {
  vDist = aDist;
  vec3 p = vec3(position.xy, uGeoid + aElev * uExaggeration);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
in float vDist;
out vec4 c;
void main() {
  // 黒白の交互。**縁は付けない**（幅 9 m を縁で食うと刻みが読めなくなる）
  float t = mod(vDist / ${TICK_M}.0, 2.0);
  c = t < 1.0 ? vec4(0.07, 0.08, 0.10, 0.95) : vec4(0.96, 0.97, 0.99, 0.95);
}
`

export interface RailwayLine {
  object: Mesh
  setExaggeration(k: number): void
  dispose(): void
}

/**
 * `scripts/12` が書いた GeoJSON（`[lon, lat, 標高]` の LineString）からリボンを作る。
 * 頂点は 5 m 間隔に割ってあるので、そのまま帯に落とす。
 */
export function createRailwayLine(
  frame: LocalFrame, data: { features?: RailwayFeature[] }, geoid: number,
): RailwayLine {
  const pos: number[] = []
  const dist: number[] = []
  const elev: number[] = []
  const idx: number[] = []

  for (const f of data.features ?? []) {
    if (f.geometry?.type !== 'LineString') continue
    const c = f.geometry.coordinates
    const w = c.map((p) => lngLatToWorld(frame, p[0], p[1]))
    if (w.length < 2) continue

    // 累積距離。刻みの位相をここで決める
    const d: number[] = [0]
    for (let i = 1; i < w.length; i++) {
      d.push(d[i - 1] + Math.hypot(w[i][0] - w[i - 1][0], w[i][1] - w[i - 1][1]))
    }

    const base = pos.length / 3
    for (let i = 0; i < w.length; i++) {
      // 接線は前後の線分の平均。端は片側だけ
      const a = w[Math.max(0, i - 1)]
      const b = w[Math.min(w.length - 1, i + 1)]
      let tx = b[0] - a[0]
      let ty = b[1] - a[1]
      const len = Math.hypot(tx, ty) || 1
      tx /= len; ty /= len
      // 法線は接線を 90° 回したもの
      const nx = -ty * (WIDTH_M / 2)
      const ny = tx * (WIDTH_M / 2)
      pos.push(w[i][0] - nx, w[i][1] - ny, 0, w[i][0] + nx, w[i][1] + ny, 0)
      elev.push(c[i][2] ?? 0, c[i][2] ?? 0)
      dist.push(d[i], d[i])
    }
    for (let i = 0; i + 1 < w.length; i++) {
      const k = base + i * 2
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aDist', new BufferAttribute(new Float32Array(dist), 1))
  g.setAttribute('aElev', new BufferAttribute(new Float32Array(elev), 1))
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1))
  g.computeBoundingSphere()

  const m = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    uniforms: { uGeoid: { value: geoid }, uExaggeration: { value: 1 } },
  })

  const mesh = new Mesh(g, m)
  // 地物（`semanticsMesh` の Group が 30）より後。参照線なので一番上に置く
  mesh.renderOrder = 40
  mesh.frustumCulled = false

  return {
    object: mesh,
    setExaggeration(k: number) { m.uniforms.uExaggeration.value = k },
    dispose() { g.dispose(); m.dispose() },
  }
}
