// JR 線路（国土数値情報 N02）。**PLATEAU 舞鶴市に鉄道は入っていない**ので、
// これだけ別データセット由来である（`scripts/12_fetch_railway.py`）。
//
// なぜ線路だけ足したか: 市の要望（2026-08）が **JR 線路を赤破線で示して
// 「表示範囲の東側をここまで」** というものだった。範囲をそこまで広げたのに
// **基準線そのものが画面に無い**と、「どこまで広げたのか」が絵から読めない。
//
// ## 見え方は 3 回作り直した **[実測]**
//
// 1. `LineSegments`（1 px の線・黒白の交互）→ **読めない。** WebGL の線幅は
//    1 px 固定で、道路が一律のほぼ白なので無彩色の 1 px は紛れる
// 2. ワールド座標のリボン 9 m・黒白の交互 → **まだ読めない。** 起動時の広域
//    （4 km 幅）では 9 m = 2.4 px しかなく、灰色の地形・白い道路・灰色の建物の
//    中で無彩色は沈む。破線にすると実質 1 px になってさらに悪化した
// 3. 頂点シェーダで画面座標の最小太さを持たせる案 → **やめた。**
//    中心線を 2 回置いてシェーダで左右に開く形にしたら、**ジオメトリがほぼ潰れて
//    1.3 km の線が画面に 80 px しか出なかった** [実測]。原因を追う価値より、
//    確実に描ける形で太さと色を決める方が早いと判断した
// 4. ワールド 16 m のリボン ＋ マゼンタ → **描画順を直したら読めた。**
//    ただし「ピンクは微妙」と再指摘。原因が色でなかった以上、
//    色は素直に地図の慣例へ戻してよい
// 5. いま: **黒の縁 ＋ 黒白の刻み**（地形図・Google マップの鉄道記号）
//
// ## 決めごと
//
// - **幅は 16 m。** 複線の路盤（9 m）より広いが、これは軌道の実寸ではなく
//   **参照線の太さ**である。4 km 幅の起動画面で 4 px あり、そこで消えないことを
//   実寸より優先した（鉄道用地としては法面・保安用地を含めた幅に近い）
// - **色は無彩色に戻した。** 一度マゼンタにしたが「ピンクは微妙」と指摘を受けた。
//   **色相を消費しない**のはむしろ望ましい（画面の色は 1 つの予算で、
//   地面＝灰 / 建物＝灰・黄・赤 / 水＝青 / 道路＝ほぼ白 / 窪地＝薄い水色 が
//   埋まっている。`docs/web_design.md`「画面の色は 1 つの予算である」）。
//   最初に無彩色で読めなかったのは色のせいではなく描画順のせいだったので、
//   そこを直した今は**地図の慣例（地形図・Google マップの鉄道記号）**で成立する
// - **縁は黒、中は黒白の刻み。** 縁を黒で締めるのが要点で、これが無いと
//   一律ほぼ白の道路と白の刻みが融ける。刻みは 14 m 周期
// - **刻みはフラグメントで作る。** 累積距離を varying で渡す。頂点属性で持つと
//   頂点間で補間されて縞の境目がぼける
// - **標高はここで引かない。** 各頂点の Z は `scripts/12` が 0.5m DEM から
//   焼き込んである。地形タイルを待たずに描け、鉛直強調は uniform 1 個で済む
// - **`depthTest` は切る。** 参照線なので、山や建物の裏に隠れると用を成さない
//   （点群の被覆輪郭と同じ扱い。`semanticsMesh.ts` の `createCoverageOutline`）
// - **Group に入れて Group 側の `renderOrder` を上げる。** これを知らずに
//   Mesh の `renderOrder` だけ 40 にしていたので、**道路と建物に上塗りされて
//   ほとんど見えていなかった**（1.3 km の線が画面に 100 px しか残らなかった [実測]）。
//   three は Group の `renderOrder` を `groupOrder` にして
//   `groupOrder -> renderOrder` の順で並べるので、**Group の値が先に効く**
//   （`semanticsMesh.ts` の同じ注記）。地物の Group が 30 なので、こちらは 45

import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, Group, Mesh, ShaderMaterial,
} from 'three'

import { lngLatToWorld, type LocalFrame } from './mercator'

/** リボンの幅 [m]。軌道の実寸ではなく**参照線の太さ**（上の決めごと） */
const WIDTH_M = 16
/** 枕木の刻みの周期 [m] */
const TICK_M = 14
/** 1 周期のうち黒が占める割合 */
const TICK_DUTY = 0.5
/** 黒で締める縁の厚み（半幅に対する割合）。**道路の白と融けないための要** */
const EDGE = 0.34

export interface RailwayFeature {
  properties?: { line?: string; operator?: string }
  geometry: { type: string; coordinates: number[][] }
}

const VS = /* glsl */ `
in float aDist;
in float aElev;
in float aSide;
uniform float uGeoid;
uniform float uExaggeration;
out float vDist;
out float vSide;
void main() {
  vDist = aDist;
  vSide = aSide;
  vec3 p = vec3(position.xy, uGeoid + aElev * uExaggeration);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
in float vDist;
in float vSide;
out vec4 c;
void main() {
  const vec4 INK  = vec4(0.05, 0.06, 0.08, 0.98);   // 黒
  const vec4 PAPER = vec4(0.98, 0.98, 1.00, 0.98);  // 白
  // 縁は黒で締める。これが無いと白の刻みが一律ほぼ白の道路と融ける
  if (abs(vSide) > ${(1.0 - EDGE).toFixed(2)}) { c = INK; return; }
  c = fract(vDist / ${TICK_M}.0) < ${TICK_DUTY.toFixed(2)} ? INK : PAPER;
}
`

export interface RailwayLine {
  object: Group
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
  const side: number[] = []
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
      const tx = b[0] - a[0]
      const ty = b[1] - a[1]
      const len = Math.hypot(tx, ty) || 1
      // 法線は接線を 90° 回して半幅を掛けたもの
      const nx = (-ty / len) * (WIDTH_M / 2)
      const ny = (tx / len) * (WIDTH_M / 2)
      pos.push(w[i][0] - nx, w[i][1] - ny, 0, w[i][0] + nx, w[i][1] + ny, 0)
      elev.push(c[i][2] ?? 0, c[i][2] ?? 0)
      dist.push(d[i], d[i])
      side.push(-1, 1)
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
  g.setAttribute('aSide', new BufferAttribute(new Float32Array(side), 1))
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
  mesh.frustumCulled = false
  // **Group の renderOrder が先に効く**（上の決めごと）。Mesh 側に値を置いても
  // 地物（Group = 30）に上塗りされる
  const group = new Group()
  group.renderOrder = 45
  group.add(mesh)

  return {
    object: group,
    setExaggeration(k: number) { m.uniforms.uExaggeration.value = k },
    dispose() { g.dispose(); m.dispose() },
  }
}
