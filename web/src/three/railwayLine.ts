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
// 5. 幅 16 m・黒の縁・黒白の刻み・`depthTest` なし → **「浮いている」「紙の地図や
//    Google マップはこんなにはっきりさせない」と指摘。** そのとおりで、
//    見えなかった時期の埋め合わせで太く・強くしすぎていた
// 6. いま: **幅 7 m・低コントラスト・道路と同じ深度の扱い**
//
// ## 決めごと
//
// - **幅は 16 m。** 複線の路盤（9 m）より広いが、これは軌道の実寸ではなく
//   **参照線の太さ**である。4 km 幅の起動画面で 4 px あり、そこで消えないことを
//   実寸より優先した（鉄道用地としては法面・保安用地を含めた幅に近い）
// - **色は無彩色。** 一度マゼンタにしたが「ピンクは微妙」と指摘を受けた。
//   **色相を消費しない**のはむしろ望ましい（画面の色は 1 つの予算で、
//   地面＝灰 / 建物＝灰・黄・赤 / 水＝青 / 道路＝ほぼ白 / 窪地＝薄い水色 が
//   埋まっている。`docs/web_design.md`「画面の色は 1 つの予算である」）
// - **主張は弱くする。** 線路は主題（浸水）ではなく**基準線**である。
//   幅は実寸どおりの 7 m、色は純黒・純白ではなく濃灰と生成り。
//   **紙の地図と同じで、探せば読めるが目を引かない**強さに置く。
//   不透明度 0.92 は「引いたときに点が消えない」下限として決めた
//   （0.85 まで落とすと 4 km 幅の起動画面で見失う）
// - **道路と同じ深度の扱いにする。** `depthTest` を切って最前面に出していたので、
//   地形と建物の上を素通しで走って**浮いて見えた**。道路（`semanticsMesh` の
//   `material()`）と同じく `depthTest: true` / `depthWrite: false` にして、
//   z を +0.12 m だけ持ち上げる（道路の輪郭が +0.10 m。その少し上）
// - **刻みはフラグメントで作る。** 累積距離を varying で渡す。頂点属性で持つと
//   頂点間で補間されて縞の境目がぼける
// - **標高はここで引かない。** 各頂点の Z は `scripts/12` が 0.5m DEM から
//   焼き込んである。地形タイルを待たずに描け、鉛直強調は uniform 1 個で済む
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

/** リボンの幅 [m]。複線の路盤の実寸。**太くしない**（上の決めごと） */
const WIDTH_M = 7
/** 枕木の刻みの周期 [m] */
const TICK_M = 11
/** 1 周期のうち濃い側が占める割合 */
const TICK_DUTY = 0.38
/** 濃い側で締める縁の厚み（半幅に対する割合） */
const EDGE = 0.24
/** 地形メッシュ・道路と z-fight させないための持ち上げ [m]（道路の輪郭が 0.10） */
const Z_BIAS = 0.12

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
  // 道路（semanticsMesh）と同じ形。地形と z-fight させないぶんだけ持ち上げる
  vec3 p = vec3(position.xy, uGeoid + aElev * uExaggeration + ${Z_BIAS.toFixed(2)});
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
in float vDist;
in float vSide;
out vec4 c;
void main() {
  // **純黒・純白にしない。** 紙の地図の鉄道記号と同じで、探せば読めるが
  // 目を引かない濃さに置く（不透明度も道路の輪郭と同じ 0.85）
  const vec4 INK   = vec4(0.11, 0.13, 0.16, 0.92);
  const vec4 PAPER = vec4(0.90, 0.91, 0.94, 0.92);
  // 縁を締める。これが無いと明るい刻みが一律ほぼ白の道路と融ける
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
    // **道路と同じ扱い。** 切って最前面に出すと地形と建物の上を素通しで走り、
    // 「浮いている」と読まれる（`semanticsMesh.ts` の `material()` と同じ）
    depthTest: true,
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
