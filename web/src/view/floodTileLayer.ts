// 浸水・地形・差分を 1 枚のテクスチャから描く。
// タイル取得は必ず net/Scheduler を通す（renderer は fetch を持たない: docs/WEB_DESIGN.md §1）。

import { BitmapLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import type { ShaderModule } from '@luma.gl/shadertools'

import { decodeTileImage } from '../assets/packing'
import type { Scheduler } from '../net/scheduler'
import type { RequestClass } from '../net/types'
import { floodDecl, floodMain } from './shaders/flood'

const uniformBlock = `\
layout(std140) uniform floodUniforms {
  float waterLevel;
  float hStep;
  float mode;
  float floodOpacity;
  float groundOpacity;
  float showGround;
  float metersPerTexel;
  vec2 texel;
} flood;
`

export interface FloodProps {
  waterLevel: number
  hStep: number
  mode: number
  floodOpacity: number
  groundOpacity: number
  showGround: number
  metersPerTexel: number
  texel: [number, number]
}

const floodUniforms = {
  name: 'flood',
  fs: uniformBlock,
  uniformTypes: {
    waterLevel: 'f32', hStep: 'f32', mode: 'f32',
    floodOpacity: 'f32', groundOpacity: 'f32', showGround: 'f32',
    metersPerTexel: 'f32', texel: 'vec2<f32>',
  },
} as const satisfies ShaderModule<FloodProps>

/** BitmapLayer の fs を丸ごと差し替える。色の作り方以外は本家と同じ */
const FS = `\
#version 300 es
#define SHADER_NAME iwagaki-flood-fragment-shader
#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D bitmapTexture;
in vec2 vTexCoord;
in vec2 vTexPos;
out vec4 fragColor;

const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / PI / 2.0;

vec2 lnglat_to_mercator(vec2 lnglat) {
  float x = lnglat.x;
  float y = clamp(lnglat.y, -89.9, 89.9);
  return vec2(radians(x) + PI, PI + log(tan(PI * 0.25 + radians(y) * 0.5))) * WORLD_SCALE;
}
vec2 mercator_to_lnglat(vec2 xy) {
  xy /= WORLD_SCALE;
  return degrees(vec2(xy.x - PI, atan(exp(xy.y - PI)) * 2.0 - PI * 0.5));
}
vec2 getUV(vec2 pos) {
  return vec2(
    (pos.x - bitmap.bounds[0]) / (bitmap.bounds[2] - bitmap.bounds[0]),
    (pos.y - bitmap.bounds[3]) / (bitmap.bounds[1] - bitmap.bounds[3]));
}

${floodDecl}

void main(void) {
  vec2 uv = vTexCoord;
  if (bitmap.coordinateConversion < -0.5) {
    uv = getUV(mercator_to_lnglat(vTexPos));
  } else if (bitmap.coordinateConversion > 0.5) {
    uv = getUV(lnglat_to_mercator(vTexPos));
  }
${floodMain}
  fragColor.a *= layer.opacity;
  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`

export class FloodBitmapLayer extends BitmapLayer<{ flood: FloodProps }> {
  static layerName = 'FloodBitmapLayer'

  getShaders() {
    const s = super.getShaders()
    return { ...s, fs: FS, modules: [...s.modules, floodUniforms] }
  }

  draw(opts: Parameters<BitmapLayer['draw']>[0]) {
    const model = (this.state as { model?: { shaderInputs: { setProps: (p: unknown) => void } } }).model
    if (model) model.shaderInputs.setProps({ flood: this.props.flood })
    super.draw(opts)
  }
}

export interface FloodTileLayerOptions {
  id: string
  urlTemplate: string
  minZoom: number
  maxZoom: number
  extent: [number, number, number, number]
  scheduler: Scheduler
  cls: RequestClass
  flood: FloodProps
  visible: boolean
  opacity: number
  /** 3D Tiles が楕円体高なので、地形面もジオイド高だけ持ち上げて高さ基準を合わせる */
  elevationOffset: number
  onTileLoaded?: (z: number) => void
  onViewportLoad?: () => void
  refinementStrategy?: 'best-available' | 'no-overlap' | 'never'
}

/**
 * パックされた値を線形補間すると標高がまったく別の値になる。
 * ミップマップも同じ理由で禁止。ブロックに見えるのは実際の解像度そのもの。
 */
const TEXTURE_PARAMS = {
  minFilter: 'nearest', magFilter: 'nearest',
  addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
} as const

export function createFloodTileLayer(o: FloodTileLayerOptions) {
  return new TileLayer({
    id: o.id,
    data: o.urlTemplate,
    minZoom: o.minZoom,
    maxZoom: o.maxZoom,
    extent: o.extent,
    tileSize: 256,
    visible: o.visible,
    opacity: o.opacity,
    maxRequests: 0,                 // 絞りは Scheduler 側で行う。ここでは絞らない
    refinementStrategy: o.refinementStrategy ?? 'best-available',
    updateTriggers: { getTileData: [o.urlTemplate] },

    getTileData: async (tile: {
      index: { x: number; y: number; z: number }
      url?: string | null
      signal?: AbortSignal
    }) => {
      const url = (o.urlTemplate
        .replace('{z}', String(tile.index.z))
        .replace('{x}', String(tile.index.x))
        .replace('{y}', String(tile.index.y)))
      const bytes = await o.scheduler.submit({
        key: url,
        url,
        cls: o.cls,
        rank: tile.index.z,
        signal: tile.signal,
      })
      const img = await decodeTileImage(bytes)
      o.onTileLoaded?.(tile.index.z)
      return img
    },

    onViewportLoad: o.onViewportLoad,

    renderSubLayers: (props: any) => {
      if (!props.data) return null
      const [[west, south], [east, north]] = props.tile.boundingBox as
        [[number, number], [number, number]]
      const z = o.elevationOffset
      return new FloodBitmapLayer({
        id: props.id,
        image: props.data,
        // [左下, 左上, 右上, 右下]。z を入れて 3D Tiles と同じ高さ基準に載せる
        bounds: [[west, south, z], [west, north, z], [east, north, z], [east, south, z]],
        textureParameters: TEXTURE_PARAMS,
        flood: o.flood,
        pickable: false,
      })
    },
  })
}
