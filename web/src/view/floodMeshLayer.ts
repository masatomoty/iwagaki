// 地形を「板」ではなくメッシュとして描く。
//
// 板（BitmapLayer）のままだと真横から見ても平面のままで、CAD のように
// XYZ 方向から地形を確かめられない。吉原は起伏が 0〜3 m しかないので、
// 鉛直強調（exaggeration）とセットでないと微地形が読めない。
//
// タイルは既存の RGBA パッキングをそのまま使う（アセットの作り直し不要）:
//   RGB = Terrarium 標高, A = h_conn コード
// 標高は **頂点シェーダでテクスチャから読む**。自前で decode するので、
// 画像デコーダに premultiply されて標高が壊れる問題（docs/WEB_DESIGN.md §5.2）を踏まない。

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

const DECODE = /* glsl */ `
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

float sampleElev(vec2 uv) {
  return decodeElev(texture(elevTexture, clamp(uv, 0.0, 1.0)).rgb);
}

void main(void) {
  vUv = aUv;
  float e = sampleElev(aUv);
  vElev = e;
  // nodata フラグは補間させない。標高そのものを補間すると、有効セルと nodata を
  // またぐ三角形が -9999 から実標高までのランプになり、海側に平らな棚が生える
  vValid = e < -9000.0 ? 0.0 : 1.0;

  // 近傍差分で法線を作る。テクスチャ 1 テクセル分の実距離は uniform で渡す
  float d = 1.0 / 256.0;
  float hl = sampleElev(aUv - vec2(d, 0.0));
  float hr = sampleElev(aUv + vec2(d, 0.0));
  float hu = sampleElev(aUv - vec2(0.0, d));
  float hd = sampleElev(aUv + vec2(0.0, d));
  vNormal = normalize(vec3(
    (hl - hr) * fmesh.exaggeration,
    (hd - hu) * fmesh.exaggeration,
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
    vec4 d = texture(diffTexture, vUv);
    bool wb = decodeHConn(d.r) <= fmesh.waterLevel;
    bool wh = decodeHConn(d.g) <= fmesh.waterLevel;
    if (!wb && !wh) {
      if (fmesh.showGround < 0.5) discard;
      float g = clamp(0.30 + vElev * 0.010, 0.22, 0.72) * shade;
      outColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), fmesh.groundOpacity);
    } else if (wb && wh) outColor = vec4(vec3(0.16, 0.34, 0.58) * shade, fmesh.floodOpacity);
    else if (wh)         outColor = vec4(vec3(0.93, 0.22, 0.18) * shade, 0.95);
    else                 outColor = vec4(vec3(0.97, 0.82, 0.16) * shade, 0.95);
  } else {
    float hConn = decodeHConn(texture(elevTexture, vUv).a);
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
