// 海に通じない窪地の**越流点**（水が溢れ出す鞍部）のマーカー。
// 潮位非依存の原理版（`scripts/33_flow_accum.py` / `src/iwagaki/flow.py`、
// `docs/todo.md`「FARR のロジックを取り込む」）。**既存の「窪地（逆流で…）」
// レイヤとは別物** — あちらは `標高 < 潮位 かつ h_conn > 潮位` の潮位依存の斜線
// （`three/floodMaterial.ts` の pondedFill）で、こちらは DEM だけで決まる。
//
// ## 決めごと（`three/railwayLine.ts` に倣う）
//
// - **ワールド座標の下向き三角（▽）。** 画面座標の billboard も試せるが、
//   railway で「頂点シェーダで画面サイズを持たせる」案が潰れた経緯があるので、
//   確実に描けるワールド座標の板にする。充填深で 3 段の大きさ。
// - **色は窪地の水色（`#70bfcc` 系。pondedFill と同系）＋濃灰の縁。** 新しい色相は
//   足さない（画面の色は 1 つの予算。`docs/web_design.md`）。線路と同じく主張は弱め。
// - **標高は頂点属性。** `scripts/33` の GeoJSON が各点の第 3 座標に越流点標高を
//   焼いてある（`catalog.flow.pits`）。地形タイルを待たずに置ける（railway と同じ）。
// - **Group の renderOrder = 46**（線路 45 の上。地物 Group = 30）。
// - **縁取りは重心座標。** 各頂点に (1,0,0)/(0,1,0)/(0,0,1) を持たせ、FS で
//   min(bary) が小さいところを濃灰で締める（ワイヤフレームの定石）。

import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, Group, Mesh, ShaderMaterial,
} from 'three'

import { lngLatToWorld, type LocalFrame } from './mercator'

/** マーカーの外接半径 [m]（鉛直強調前）。充填深で small/mid/large に振る */
const SIZE_M = { small: 7, mid: 10, large: 13 } as const
/** 充填深の段の閾値 [m] */
const FILL_MID_M = 0.3
const FILL_LARGE_M = 1.0
/** 地形・地物と z-fight させないための持ち上げ [m]（線路が 0.12） */
const Z_BIAS = 0.15

export interface PourPointFeature {
  geometry: { type: string; coordinates: number[] }
  properties?: {
    max_fill_depth_m?: number
    volume_m3?: number
    spill_elev_m_tp?: number
    edge_truncated?: boolean
  }
}

const VS = /* glsl */ `
in vec3 aBary;
in float aElev;
uniform float uGeoid;
uniform float uExaggeration;
out vec3 vBary;
void main() {
  vBary = aBary;
  vec3 p = vec3(position.xy, uGeoid + aElev * uExaggeration + ${Z_BIAS.toFixed(2)});
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;
in vec3 vBary;
out vec4 c;
void main() {
  // 窪地の水色 ＋ 濃灰の細い縁（線路の INK と同じ）。純黒・純白にしない
  const vec3 FILL = vec3(0.44, 0.75, 0.80);
  const vec3 INK  = vec3(0.11, 0.13, 0.16);
  float edge = min(min(vBary.x, vBary.y), vBary.z);
  c = vec4(edge < 0.10 ? INK : FILL, edge < 0.10 ? 0.95 : 0.85);
}
`

export interface PourPoints {
  object: Group
  setExaggeration(k: number): void
  dispose(): void
}

/**
 * `catalog.flow.pits` の GeoJSON（`[lon, lat, 越流点標高]` の Point）からマーカー群を作る。
 */
export function createPourPoints(
  frame: LocalFrame, data: { features?: PourPointFeature[] }, geoid: number,
): PourPoints {
  const pos: number[] = []
  const bary: number[] = []
  const elev: number[] = []
  const idx: number[] = []

  // 下向き三角の 3 頂点（重心原点。上辺が水平、下に尖る）
  const TRI: [number, number][] = [[-0.87, 0.5], [0.87, 0.5], [0, -1]]
  const BARY: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

  for (const f of data.features ?? []) {
    if (f.geometry?.type !== 'Point') continue
    const [lon, lat, z] = f.geometry.coordinates
    const [wx, wy] = lngLatToWorld(frame, lon, lat)
    const fill = f.properties?.max_fill_depth_m ?? 0
    const r = fill >= FILL_LARGE_M ? SIZE_M.large
      : fill >= FILL_MID_M ? SIZE_M.mid : SIZE_M.small

    const base = pos.length / 3
    for (let k = 0; k < 3; k++) {
      pos.push(wx + TRI[k][0] * r, wy - TRI[k][1] * r, 0)
      bary.push(...BARY[k])
      elev.push(z ?? 0)
    }
    idx.push(base, base + 1, base + 2)
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aBary', new BufferAttribute(new Float32Array(bary), 3))
  g.setAttribute('aElev', new BufferAttribute(new Float32Array(elev), 1))
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1))
  g.computeBoundingSphere()

  const m = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: { uGeoid: { value: geoid }, uExaggeration: { value: 1 } },
  })

  const mesh = new Mesh(g, m)
  mesh.frustumCulled = false
  const group = new Group()
  group.renderOrder = 46
  group.add(mesh)

  return {
    object: group,
    setExaggeration(k: number) { m.uniforms.uExaggeration.value = k },
    dispose() { g.dispose(); m.dispose() },
  }
}
