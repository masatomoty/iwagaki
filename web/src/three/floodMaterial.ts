// FloodMeshLayer（deck.gl + luma.gl）の three.js への移植。
// 判定式は src/domain/flood.ts と一致していること（test/parity で検証）。
//
// 元実装からの変更は 3 点だけで、判定・標高デコード・補間規則は 1 行も変えていない:
//   1. project_position_to_clipspace -> 自前のワールド座標（src/three/mercator.ts）
//   2. UBO (layout std140) -> three の個別 uniform
//   3. **テクスチャ v の反転**（下記）
//
// ## テクスチャの向き（実データで確認済み）
// タイル PNG は `scripts/80_build_web_tiles.py` が rasterio の
// `from_bounds(west, south, east, north, 256, 256)` で焼くので **row 0 = 北**。
//   z17/114808/51713 の実測: row0 平均 78.4 m / row255 平均 36.5 m
//   同じ緯度の dtm_highres_050.tif: 北端 80.4 m / 南端 28.0 m
// three は flipY を明示 false で上げるので t=0 が row 0 = 北を指す。
// 一方 aUv.y=0 は bounds の南側なので、**サンプルは 1-v で引く**。
//
// 移植時に「luma.gl が暗黙に上下反転して上げているから元実装は素の uv で
// 合っていたのだろう」と書いたが、**それは誤りだった**。luma.gl も
// UNPACK_FLIP_Y_WEBGL を立てない。元実装は本当に南北が反転しており、
// 独立に見つかって main で直された（`docs/web_results.md` §6.8 / commit b6b45d7）。
// 結論の式 `vec2(uv.x, 1.0 - uv.y)` は両者で一致している。

import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, NearestFilter,
  NoColorSpace, ShaderMaterial, Texture, Vector4,
} from 'three'

/** タイルあたりのメッシュ分割数。z18 で 124 m / 128 ≈ 1 m */
const GRID = 128
/** タイル境界のひび割れを隠すスカート（メートル、鉛直強調前） */
const SKIRT_M = 3
const TEX = 256

export const FLOOD_MODE = { terrain: 0, diff: 1 } as const

export interface FloodUniformValues {
  /** ワールドメートルでのタイル境界 [xWest, ySouth, xEast, yNorth] */
  worldBounds: [number, number, number, number]
  waterLevel: number
  hStep: number
  /** 0 = 地形, 1 = 差分 */
  mode: number
  exaggeration: number
  geoid: number
  metersPerTexel: number
  floodOpacity: number
  groundOpacity: number
  showGround: number
  /** 平常時に水がある範囲の閾値 [m T.P.]。MSL を渡す */
  waterBase: number
}

const DECODE = /* glsl */ `
const float TEX = ${TEX}.0;

/**
 * aUv (y=0 が南) -> テクスチャ座標 (t=0 が北)。上記のとおり v を反転する。
 * area-registered なので、さらに最寄りセル中心へ 0.5 ずらす。
 */
vec2 flipV(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }

vec2 cellUv(vec2 uv) {
  vec2 v = flipV(clamp(uv, 0.0, 1.0));
  return (clamp(floor(v * TEX), 0.0, TEX - 1.0) + 0.5) / TEX;
}

float decodeElev(vec3 c) {
  if (c.r == 0.0 && c.g == 0.0 && c.b == 0.0) return -9999.0;   // nodata
  return (c.r * 255.0) * 256.0 + (c.g * 255.0) + (c.b * 255.0) / 256.0 - 32768.0;
}
float decodeHConn(float a) {
  float code = floor(a * 255.0 + 0.5);
  return code < 0.5 ? 1e9 : (code - 1.0) * uHStep;
}
`

const VS = /* glsl */ `
in vec2 aUv;
in float aSkirt;

uniform sampler2D elevTexture;
uniform vec4 uWorldBounds;
uniform float uHStep;
uniform float uExaggeration;
uniform float uGeoid;
uniform float uMetersPerTexel;

out vec2 vUv;
out float vElev;
out float vValid;
out vec3 vNormal;

${DECODE}

/** 最寄りセルの値。nodata 判定にはこちらを使う（補間すると nodata が混ざる） */
float sampleElevNearest(vec2 uv) {
  return decodeElev(texture(elevTexture, cellUv(uv)).rgb);
}

/**
 * セル中心を格子点とみなした双線形補間。**デコードしてから混ぜる**
 * （パックされた RGB を線形補間すると別の標高になるので GPU の LINEAR は使えない）。
 * 4 点のどれかが nodata なら補間せず最寄りセルに落とす。混ぜると
 * -9999 と実標高のランプができ、海際に平らな棚が生える。
 */
float sampleElev(vec2 uv) {
  vec2 t = clamp(flipV(clamp(uv, 0.0, 1.0)) * TEX - 0.5, vec2(0.0), vec2(TEX - 1.0));
  vec2 b = floor(t);
  vec2 f = t - b;
  vec2 b1 = min(b + 1.0, TEX - 1.0);
  float e00 = decodeElev(texture(elevTexture, (b + 0.5) / TEX).rgb);
  float e10 = decodeElev(texture(elevTexture, (vec2(b1.x, b.y) + 0.5) / TEX).rgb);
  float e01 = decodeElev(texture(elevTexture, (vec2(b.x, b1.y) + 0.5) / TEX).rgb);
  float e11 = decodeElev(texture(elevTexture, (b1 + 0.5) / TEX).rgb);
  float lo = min(min(e00, e10), min(e01, e11));
  if (lo < -9000.0) return sampleElevNearest(uv);
  return mix(mix(e00, e10, f.x), mix(e01, e11, f.x), f.y);
}

void main() {
  vUv = aUv;
  float e = sampleElev(aUv);
  vElev = e;
  vValid = sampleElevNearest(aUv) < -9000.0 ? 0.0 : 1.0;

  float d = 1.0 / TEX;
  float hl = sampleElev(aUv - vec2(d, 0.0));
  float hr = sampleElev(aUv + vec2(d, 0.0));
  float hu = sampleElev(aUv - vec2(0.0, d));
  float hd = sampleElev(aUv + vec2(0.0, d));
  // aUv.y は北向きなので、hu が南・hd が北。法線の y 成分は (hu - hd) になる
  vNormal = normalize(vec3(
    (hl - hr) * uExaggeration,
    (hu - hd) * uExaggeration,
    2.0 * uMetersPerTexel));

  float base = e < -9000.0 ? 0.0 : e;
  float z = uGeoid + (base - aSkirt * ${SKIRT_M}.0) * uExaggeration;

  // XYZ タイルは Web メルカトル上で正方なので、ワールド（= メルカトルの線形変換）で
  // 線形補間してよい。経緯度で補間すると緯度方向が非線形になる
  vec2 xy = mix(uWorldBounds.xy, uWorldBounds.zw, aUv);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, z, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;

uniform sampler2D elevTexture;
uniform sampler2D diffTexture;
uniform float uHStep;
uniform float uWaterLevel;
uniform float uMode;
uniform float uFloodOpacity;
uniform float uGroundOpacity;
uniform float uShowGround;
uniform float uWaterBase;
uniform float uHasDiff;

in vec2 vUv;
in float vElev;
in float vValid;
in vec3 vNormal;
out vec4 fragColor;

${DECODE}

vec3 depthRamp(float d) {
  vec3 c0 = vec3(0.42, 0.80, 0.95);
  vec3 c1 = vec3(0.15, 0.50, 0.90);
  vec3 c2 = vec3(0.05, 0.16, 0.52);
  float t = clamp(d / 3.0, 0.0, 1.0);
  return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
  if (vValid < 0.999) discard;   // 少しでも nodata が混ざった三角形は捨てる
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(vec3(-0.6, 0.7, 0.75));
  float shade = clamp(0.45 + 0.75 * dot(n, sun), 0.25, 1.35);

  // h_conn は判定値なので絶対に補間しない。必ず最寄りセルで引く
  vec2 cu = cellUv(vUv);

  vec4 outColor;

  // **平常時に水がある範囲**の下地。
  //
  // 潮位を下げると海と川が「乾いた地面」として描かれ、地形が読めなくなっていた。
  // 原因は 2 つの実測事実の組み合わせ [実測]:
  //   - h_conn = 0.00 の画素が **19.26 %** ある（= 海と川。z17 の 25 枚で計測）
  //   - **標高は 0 m にクリップされている**（同計測の最小値が 0.0 m）
  // したがって潮位 0 では h_conn <= H は真だが depth = H - elev = 0 になり、
  // 浸水色の条件（depth > 0）を外れて地面の分岐に落ちていた。
  //
  // なので「濡れているか」ではなく **「平常時の海面より低いか」** で下地を決める。
  // 閾値は catalog の MSL（気象庁 公表・天文潮の年平均と一致で検算済み）。

  if (uMode > 0.5 && uHasDiff < 0.5) {
    // 差分モードだが差分タイルが無い区画。判定差が「無い」のではなく
    // 「分からない」ので、浸水色は出さず地面だけ描く
    if (uShowGround < 0.5) discard;
    float g = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
    fragColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), uGroundOpacity);
    return;
  }
  if (uMode > 0.5 && uHasDiff > 0.5) {
    vec4 d = texture(diffTexture, cu);
    bool wb = decodeHConn(d.r) <= uWaterLevel;
    bool wh = decodeHConn(d.g) <= uWaterLevel;
    // 平常時の水域で、まだ水深が付かない潮位のときは下地を出す。
    // ここを先に見ないと、潮位 0 で海が「どちらも浸水」の青になる
    bool permWater = min(decodeHConn(d.r), decodeHConn(d.g)) <= uWaterBase;
    if (permWater && max(0.0, uWaterLevel - vElev) <= 0.0) {
      outColor = vec4(vec3(0.20, 0.31, 0.40) * shade, uGroundOpacity);
    } else if (!wb && !wh) {
      if (uShowGround < 0.5) discard;
      float g = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
      outColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), uGroundOpacity);
    } else if (wb && wh) outColor = vec4(vec3(0.16, 0.34, 0.58) * shade, uFloodOpacity);
    else if (wh)         outColor = vec4(vec3(0.93, 0.22, 0.18) * shade, 0.95);
    else                 outColor = vec4(vec3(0.97, 0.82, 0.16) * shade, 0.95);
  } else {
    float a = texture(elevTexture, cu).a;
    float hConn = decodeHConn(a);
    bool isWet = hConn <= uWaterLevel;
    bool baseWater = a > 0.0 && hConn <= uWaterBase;
    float depth = isWet ? max(0.0, uWaterLevel - vElev) : 0.0;
    if (isWet && depth > 0.0) {
      outColor = vec4(depthRamp(depth) * mix(1.0, shade, 0.35), uFloodOpacity);
    } else if (baseWater) {
      // 判定の色（浸水深ランプ = 鮮やかな水色〜紺）とは別に、**彩度を落とした鋼色**。
      // 「我々の判定」ではなく「普段から水域」であることを色で分ける。
      // 暗くしすぎると地面に見えるので、水面として読める明るさに置く
      outColor = vec4(vec3(0.20, 0.31, 0.40) * shade, uGroundOpacity);
    } else if (uShowGround > 0.5) {
      float g = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
      outColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), uGroundOpacity);
    } else {
      discard;
    }
  }
  fragColor = outColor;
}
`

/** uv グリッド + 外周スカート。全タイルで共有できるので 1 度だけ作る */
let sharedGeometry: BufferGeometry | undefined

export function floodGeometry(): BufferGeometry {
  if (sharedGeometry) return sharedGeometry
  const n = GRID
  const side = n + 1
  const uv: number[] = []
  const skirt: number[] = []
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) { uv.push(i / n, j / n); skirt.push(0) }
  }
  const indices: number[] = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i
      indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side)
    }
  }
  // 外周をもう 1 周ぶん複製して下げる（タイル境界のひび割れ隠し）
  const ringStart = uv.length / 2
  const edge: number[] = []
  for (let i = 0; i <= n; i++) edge.push(i)
  for (let j = 1; j <= n; j++) edge.push(j * side + n)
  for (let i = n - 1; i >= 0; i--) edge.push(n * side + i)
  for (let j = n - 1; j >= 1; j--) edge.push(j * side)
  for (const idx of edge) { uv.push(uv[idx * 2], uv[idx * 2 + 1]); skirt.push(1) }
  for (let k = 0; k < edge.length; k++) {
    const a = edge[k]
    const b = edge[(k + 1) % edge.length]
    const a2 = ringStart + k
    const b2 = ringStart + ((k + 1) % edge.length)
    indices.push(a, b, a2, b, b2, a2)
  }
  const g = new BufferGeometry()
  g.setAttribute('aUv', new BufferAttribute(new Float32Array(uv), 2))
  g.setAttribute('aSkirt', new BufferAttribute(new Float32Array(skirt), 1))
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1))
  // 頂点で標高を引くので CPU 側に position が無い。three の視錐台カリングは使わない
  g.boundingSphere = null
  sharedGeometry = g
  return g
}

/**
 * パックした値を線形補間すると標高が別の値になる。ミップマップも同じ理由で作らない。
 * premultiplyAlpha は decodeTileImage 側で切ってある（docs/web_design.md §5.2）。
 */
export function makeTileTexture(img: ImageBitmap): Texture {
  const t = new Texture(img)
  t.magFilter = NearestFilter
  t.minFilter = NearestFilter
  t.generateMipmaps = false
  t.flipY = false               // 暗黙の反転を禁止する。向きはシェーダ側で決める
  t.premultiplyAlpha = false
  t.colorSpace = NoColorSpace   // sRGB 変換が入ると標高が静かに狂う
  t.needsUpdate = true
  return t
}

export function createFloodMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: true,
    side: DoubleSide,       // CAD 視点では裏からスカートを見ることがある
    uniforms: {
      elevTexture: { value: null },
      diffTexture: { value: null },
      uWorldBounds: { value: new Vector4() },
      uWaterLevel: { value: 0 },
      uHStep: { value: 0.05 },
      uMode: { value: 0 },
      uExaggeration: { value: 1 },
      uGeoid: { value: 0 },
      uMetersPerTexel: { value: 1 },
      uFloodOpacity: { value: 0.82 },
      uGroundOpacity: { value: 0.95 },
      uShowGround: { value: 1 },
      uWaterBase: { value: 0 },
      uHasDiff: { value: 0 },
    },
  })
}

export function applyFloodUniforms(m: ShaderMaterial, v: FloodUniformValues) {
  const u = m.uniforms
  ;(u.uWorldBounds.value as Vector4).set(...v.worldBounds)
  u.uWaterLevel.value = v.waterLevel
  u.uHStep.value = v.hStep
  u.uMode.value = v.mode
  u.uExaggeration.value = v.exaggeration
  u.uGeoid.value = v.geoid
  u.uMetersPerTexel.value = v.metersPerTexel
  u.uFloodOpacity.value = v.floodOpacity
  u.uGroundOpacity.value = v.groundOpacity
  u.uShowGround.value = v.showGround
  u.uWaterBase.value = v.waterBase
}
