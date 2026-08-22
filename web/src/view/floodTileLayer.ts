// 浸水・地形・差分のタイルレイヤ。描画実体は FloodMeshLayer（板ではなくメッシュ）。
// タイル取得は必ず net/Scheduler を通す（renderer は fetch を持たない: docs/WEB_DESIGN.md §1）。

// NOTE: 深いパス（dist/tile-layer/tile-layer.js）から入れて @deck.gl/layers を
// 初期チャンクから外そうとしたが、package.json の exports に無く解決できない。
// 初期チャンクの内訳は docs/WEB_RESULTS.md §8.1 を参照
import { TileLayer } from '@deck.gl/geo-layers'

import { decodeTileImage } from '../assets/packing'
import type { Scheduler } from '../net/scheduler'
import type { RequestClass } from '../net/types'
import { FloodMeshLayer, type FloodMeshUniforms } from './floodMeshLayer'

export const FLOOD_MODE = { terrain: 0, diff: 1 } as const

export interface FloodTileLayerOptions {
  id: string
  /** 地形（RGB=標高, A=h_conn）のタイル URL */
  urlTemplate: string
  /** 差分モードのときだけ。R=h_conn(baseline), G=h_conn(highres) */
  diffUrlTemplate?: string
  minZoom: number
  maxZoom: number
  extent: [number, number, number, number]
  scheduler: Scheduler
  cls: RequestClass
  uniforms: Omit<FloodMeshUniforms, 'bounds' | 'metersPerTexel' | 'hasDiff'>
  visible: boolean
  opacity: number
  /** そのタイルがいまも視野に必要か。付けないとキャンセル対象にならない */
  isTileNeeded?: (z: number, x: number, y: number) => boolean
  onTileLoaded?: (z: number) => void
  onViewportLoad?: () => void
  refinementStrategy?: 'best-available' | 'no-overlap' | 'never'
}

const url = (tpl: string, t: { x: number; y: number; z: number }) =>
  tpl.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y))

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
    maxRequests: 0,                 // 絞りは Scheduler 側で行う
    refinementStrategy: o.refinementStrategy ?? 'best-available',
    updateTriggers: { getTileData: [o.urlTemplate, o.diffUrlTemplate ?? ''] },

    getTileData: async (tile: {
      index: { x: number; y: number; z: number }
      signal?: AbortSignal
    }) => {
      const u = url(o.urlTemplate, tile.index)
      const { x, y, z } = tile.index
      const get = async (target: string) =>
        decodeTileImage(await o.scheduler.submit({
          key: target, url: target, cls: o.cls, rank: z, signal: tile.signal,
          epoch: o.scheduler.currentEpoch,
          stillNeeded: o.isTileNeeded ? () => o.isTileNeeded!(z, x, y) : undefined,
        }))
      // 差分モードは「標高（メッシュ用）」と「2 条件の h_conn」で 2 枚必要
      const [image, diffImage] = await Promise.all([
        get(u),
        o.diffUrlTemplate ? get(url(o.diffUrlTemplate, tile.index)) : Promise.resolve(null),
      ])
      o.onTileLoaded?.(tile.index.z)
      return { image, diffImage }
    },

    onViewportLoad: o.onViewportLoad,

    renderSubLayers: (props: any) => {
      const d = props.data as { image: ImageBitmap; diffImage: ImageBitmap | null } | null
      if (!d?.image) return null
      const [[west, south], [east, north]] = props.tile.boundingBox as
        [[number, number], [number, number]]
      // タイル 1 テクセルの実距離。法線計算に使う
      const mLat = 111_132.0
      const heightM = (north - south) * mLat
      return new FloodMeshLayer({
        id: props.id,
        image: d.image,
        diffImage: d.diffImage,
        fmesh: {
          ...o.uniforms,
          bounds: [west, south, east, north],
          metersPerTexel: heightM / 256,
          hasDiff: d.diffImage ? 1 : 0,
        },
        pickable: false,
      })
    },
  })
}
