// 地形を「板」ではなくメッシュとして描く。
//
// 板（BitmapLayer）のままだと真横から見ても平面のままで、CAD のように
// XYZ 方向から地形を確かめられない。吉原は起伏が 0〜3 m しかないので、
// 鉛直強調（exaggeration）とセットでないと微地形が読めない。
//
// タイルは既存の RGBA パッキングをそのまま使う（アセットの作り直し不要）:
//   RGB = Terrarium 標高, A = h_conn コード
// 標高は **頂点シェーダでテクスチャから読む**。自前で decode するので、
// 画像デコーダに premultiply されて標高が壊れる問題（docs/WEB_DESIGN.md「RGBA タイルのパッキング」）を踏まない。

import { Layer, project32, picking, type LayerProps, type UpdateParameters } from '@deck.gl/core'
import { Geometry, Model } from '@luma.gl/engine'
import type { ShaderModule } from '@luma.gl/shadertools'

/** タイルあたりのメッシュ分割数。z18 で 124 m / 128 ≈ 1 m */
const GRID = 128
/** タイル境界のひび割れを隠すスカート（メートル、鉛直強調前） */
const SKIRT_M = 3

const uniformBlock = `\
layout(std140) uniform fmeshUniforms {
  vec4 bounds;
  float waterLevel;
  float hStep;
  float mode;
  float exaggeration;
  float geoid;
  float metersPerTexel;
  float floodOpacity;
  float groundOpacity;
  float showGround;
  float hasDiff;
} fmesh;
`

export interface FloodMeshUniforms {
  /** [west, south, east, north] */
  bounds: [number, number, number, number]
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
  hasDiff: number
}

const fmeshUniforms = {
  name: 'fmesh',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    bounds: 'vec4<f32>', waterLevel: 'f32', hStep: 'f32', mode: 'f32',
    exaggeration: 'f32', geoid: 'f32', metersPerTexel: 'f32',
    floodOpacity: 'f32', groundOpacity: 'f32', showGround: 'f32', hasDiff: 'f32',
  },
} as const satisfies ShaderModule<FloodMeshUniforms>

/**
 * タイルは **area-registered**（1 画素 = 1 セル）である。
 * `scripts/80_build_web_tiles.py` が `from_bounds(...tile_bounds, 256, 256)` で焼いており、
 * セル k は uv [k/256, (k+1)/256) を占め、**中心は (k+0.5)/256** にある。
 *
 * これを point-registered として `texture(tex, uv)` で引くと、値が半セル分ずれた位置の
 * ものになる。半セルの実距離はズームで変わる（z15 1.95 m / z17 0.49 m / z18 0.24 m）ので、
 * **粗メッシュ(z14-15)と細メッシュ(z16-18)で地形が別の場所に出る**。
 * 俯瞰視では z15 と z17 が同時に描かれるため（実測）、細タイルが揃った瞬間に
 * 地形と浸水色が 1.5 m ほど動いて見えていた。
 */
const TEX = 256

const DECODE = /* glsl */ `
const float TEX = ${TEX}.0;

/**
 * uv（v=0 が南）-> テクスチャ座標（t=0 が北）。
 *
 * タイル画像は **1 行目が北**（scripts/80_build_web_tiles.py が north-up の
 * dst_transform で焼き、createImageBitmap も premultiply 以外は素通し）。
 * luma.gl は UNPACK_FLIP_Y_WEBGL を立てないので、t=0 が画像 1 行目 = 北辺になる。
 * 一方この層の uv は mix(bounds.xy, bounds.zw, aUv) で使う都合上 **v=0 が南**。
 * 反転せずに引くと **タイル 1 枚の中で南北がひっくり返る**（deck.gl の
 * BitmapLayer が texCoords に 1-v を入れているのと同じ理由:
 * @deck.gl/layers の bitmap-layer/create-mesh.js）。
 *
 * ずれ量はタイルの高さそのもの（z15 で 1.2 km, z18 で 150 m）で、しかも
 * ズームによらず同じ向きに間違うので、粗→細の平行移動を見る perf/tileshift.mjs
 * では捕まらない。perf/tileorient.mjs が焼いたタイルと画面を直接照合する。
 */
vec2 texUv(vec2 uv) {
  return vec2(uv.x, 1.0 - uv.y);
}

/** uv -> 最寄りセル中心のテクスチャ座標。area-registered なので 0.5 ずらす */
vec2 cellUv(vec2 uv) {
  return (clamp(floor(uv * TEX), 0.0, TEX - 1.0) + 0.5) / TEX;
}

float decodeElev(vec3 c) {
  if (c.r == 0.0 && c.g == 0.0 && c.b == 0.0) return -9999.0;   // nodata
  return (c.r * 255.0) * 256.0 + (c.g * 255.0) + (c.b * 255.0) / 256.0 - 32768.0;
}
float decodeHConn(float a) {
  float code = floor(a * 255.0 + 0.5);
  return code < 0.5 ? 1e9 : (code - 1.0) * fmesh.hStep;
}
`

const VS = /* glsl */ `#version 300 es
#define SHADER_NAME flood-mesh-vs
in vec2 aUv;
in float aSkirt;

uniform sampler2D elevTexture;

out vec2 vUv;
out float vElev;
out float vValid;
out vec3 vNormal;

${DECODE}

/** 最寄りセルの値。nodata 判定にはこちらを使う（補間すると nodata が混ざる） */
float sampleElevNearest(vec2 uv) {
  return decodeElev(texture(elevTexture, cellUv(texUv(clamp(uv, 0.0, 1.0)))).rgb);
}

/**
 * セル中心を格子点とみなした双線形補間。**デコードしてから混ぜる**
 * （パックされた RGB を線形補間すると別の標高になるので、GPU の LINEAR は使えない）。
 *
 * 4 点のどれかが nodata なら補間せず最寄りセルに落とす。混ぜると
 * -9999 と実標高のランプができ、海際に平らな棚が生える（既知の症状）。
 */
float sampleElev(vec2 uv) {
  vec2 t = clamp(texUv(uv) * TEX - 0.5, vec2(0.0), vec2(TEX - 1.0));
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

void main(void) {
  vUv = aUv;
  float e = sampleElev(aUv);
  vElev = e;
  // nodata フラグは補間させない。標高そのものを補間すると、有効セルと nodata を
  // またぐ三角形が -9999 から実標高までのランプになり、海側に平らな棚が生える
  // 判定は最寄りセルで行う（補間側は nodata を含む時点で最寄りに落ちている）
  vValid = sampleElevNearest(aUv) < -9000.0 ? 0.0 : 1.0;

  // 近傍差分で法線を作る。テクスチャ 1 テクセル分の実距離は uniform で渡す。
  // 面 z = f(x, y) の法線は (-fx, -fy, 1) なので、y も x と同じ向き
  // （引いた側 - 足した側）でなければならない。uv.y は北向きなので「南 - 北」。
  // 以前は y だけ逆で、南北が反転したサンプルと打ち消し合って陰影だけは
  // それらしく見えていた（だから向きの誤りに気づけなかった）。
  float d = 1.0 / 256.0;
  float hw = sampleElev(aUv - vec2(d, 0.0));   // 西
  float he = sampleElev(aUv + vec2(d, 0.0));   // 東
  float hs = sampleElev(aUv - vec2(0.0, d));   // 南
  float hn = sampleElev(aUv + vec2(0.0, d));   // 北
  vNormal = normalize(vec3(
    (hw - he) * fmesh.exaggeration,
    (hs - hn) * fmesh.exaggeration,
    2.0 * fmesh.metersPerTexel));

  float base = e < -9000.0 ? 0.0 : e;
  float z = fmesh.geoid + (base - aSkirt * ${SKIRT_M}.0) * fmesh.exaggeration;

  vec2 lnglat = mix(fmesh.bounds.xy, fmesh.bounds.zw, aUv);
  vec4 commonPos;
  gl_Position = project_position_to_clipspace(
    vec3(lnglat, z), vec3(0.0), vec3(0.0), commonPos);
  geometry.position = commonPos;
  geometry.uv = aUv;
  geometry.worldPosition = vec3(lnglat, z);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}
`

const FS = /* glsl */ `#version 300 es
#define SHADER_NAME flood-mesh-fs
precision highp float;

uniform sampler2D elevTexture;
uniform sampler2D diffTexture;

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

void main(void) {
  if (vValid < 0.999) discard;   // 少しでも nodata が混ざった三角形は捨てる
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(vec3(-0.6, 0.7, 0.75));
  float shade = clamp(0.45 + 0.75 * dot(n, sun), 0.25, 1.35);

  vec4 outColor;
  if (fmesh.mode > 0.5 && fmesh.hasDiff > 0.5) {
    vec4 d = texture(diffTexture, cellUv(texUv(vUv)));
    bool wb = decodeHConn(d.r) <= fmesh.waterLevel;
    bool wh = decodeHConn(d.g) <= fmesh.waterLevel;
    if (!wb && !wh) {
      if (fmesh.showGround < 0.5) discard;
      float g = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
      outColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), fmesh.groundOpacity);
    } else if (wb && wh) outColor = vec4(vec3(0.16, 0.34, 0.58) * shade, fmesh.floodOpacity);
    else if (wh)         outColor = vec4(vec3(0.93, 0.22, 0.18) * shade, 0.95);
    else                 outColor = vec4(vec3(0.97, 0.82, 0.16) * shade, 0.95);
  } else if (fmesh.mode > 0.5) {
    // 差分モードなのに差分タイルが無い区画。**単一条件の浸水色を出してはいけない。**
    // 「判定差が無い」ではなく「分からない」ので、色を付けると誤読させる。
    // 差分ピラミッドは両条件とも h_conn が無い区画を焼かないので地形より疎で、
    // ここは必ず出る（131 対 101 枚）。地面だけ描いて判断材料が無いことを示す
    if (fmesh.showGround < 0.5) discard;
    float gu = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
    outColor = vec4(vec3(gu) * vec3(1.00, 0.99, 0.95), fmesh.groundOpacity);
  } else {
    float hConn = decodeHConn(texture(elevTexture, cellUv(texUv(vUv))).a);
    bool isWet = hConn <= fmesh.waterLevel;
    float depth = isWet ? max(0.0, fmesh.waterLevel - vElev) : 0.0;
    if (isWet && depth > 0.0) {
      outColor = vec4(depthRamp(depth) * mix(1.0, shade, 0.35), fmesh.floodOpacity);
    } else if (fmesh.showGround > 0.5) {
      float g = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
      outColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), fmesh.groundOpacity);
    } else {
      discard;
    }
  }
  fragColor = outColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`

/** uv グリッド + 外周スカート。全タイルで共有できるので 1 度だけ作る */
let sharedGeometry: Geometry | undefined
function getGeometry(): Geometry {
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
  for (let i = 0; i <= n; i++) edge.push(i)                       // 上辺
  for (let j = 1; j <= n; j++) edge.push(j * side + n)            // 右辺
  for (let i = n - 1; i >= 0; i--) edge.push(n * side + i)        // 下辺
  for (let j = n - 1; j >= 1; j--) edge.push(j * side)            // 左辺
  for (const idx of edge) { uv.push(uv[idx * 2], uv[idx * 2 + 1]); skirt.push(1) }
  for (let k = 0; k < edge.length; k++) {
    const a = edge[k]
    const b = edge[(k + 1) % edge.length]
    const a2 = ringStart + k
    const b2 = ringStart + ((k + 1) % edge.length)
    indices.push(a, b, a2, b, b2, a2)
  }
  sharedGeometry = new Geometry({
    topology: 'triangle-list',
    attributes: {
      aUv: { size: 2, value: new Float32Array(uv) },
      aSkirt: { size: 1, value: new Float32Array(skirt) },
    },
    indices: new Uint32Array(indices),
  })
  return sharedGeometry
}

export type FloodMeshLayerProps = LayerProps & {
  image: ImageBitmap
  diffImage?: ImageBitmap | null
  fmesh: FloodMeshUniforms
}

export class FloodMeshLayer extends Layer<FloodMeshLayerProps> {
  static layerName = 'FloodMeshLayer'
  declare state: { model?: Model; elevTexture?: unknown; diffTexture?: unknown }

  getShaders() {
    return super.getShaders({ vs: VS, fs: FS, modules: [project32, picking, fmeshUniforms] })
  }

  initializeState() {
    const geometry = getGeometry()
    this.setState({
      model: new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        geometry,
        isInstanced: false,
      }),
    })
  }

  /** パックした値を線形補間すると標高が別の値になる。ミップマップも同じ理由で作らない */
  private makeTexture(img: ImageBitmap) {
    return this.context.device.createTexture({
      data: img,
      width: img.width,
      height: img.height,
      mipmaps: false,
      sampler: { minFilter: 'nearest', magFilter: 'nearest',
                 addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
    } as never)
  }

  updateState(params: UpdateParameters<this>) {
    super.updateState(params)
    const { props, oldProps } = params
    if (props.image !== oldProps.image) {
      this.state.elevTexture = this.makeTexture(props.image)
    }
    if (props.diffImage !== oldProps.diffImage) {
      this.state.diffTexture = props.diffImage ? this.makeTexture(props.diffImage) : undefined
    }
  }

  draw() {
    const { model, elevTexture, diffTexture } = this.state
    if (!model || !elevTexture) return
    model.shaderInputs.setProps({
      fmesh: {
        ...this.props.fmesh,
        hasDiff: diffTexture ? 1 : 0,
      },
    })
    model.setBindings({
      elevTexture: elevTexture as never,
      diffTexture: (diffTexture ?? elevTexture) as never,
    })
    model.draw(this.context.renderPass)
  }

  finalizeState(context: unknown) {
    super.finalizeState(context as never)
    ;(this.state.elevTexture as { destroy?: () => void } | undefined)?.destroy?.()
    ;(this.state.diffTexture as { destroy?: () => void } | undefined)?.destroy?.()
  }
}
