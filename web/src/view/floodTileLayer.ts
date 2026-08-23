// 浸水・地形・差分のタイルレイヤ。描画実体は FloodMeshLayer（板ではなくメッシュ）。
// タイル取得は必ず net/Scheduler を通す（renderer は fetch を持たない: docs/WEB_DESIGN.md「層の分け方」）。

// NOTE: 深いパス（dist/tile-layer/tile-layer.js）から入れて @deck.gl/layers を
// 初期チャンクから外そうとしたが、package.json の exports に無く解決できない。
// 初期チャンクの内訳は docs/WEB_RESULTS.md「初期チャンクの内訳」を参照
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
    updateTriggers: {
      getTileData: [o.urlTemplate, o.diffUrlTemplate ?? ''],
      // **これが無いと水位スライダが効かない。**
      // TileLayer は renderSubLayers の結果をタイルごとにキャッシュし、
      // 親の props が変わっただけでは作り直さない。uniforms は
      // renderSubLayers のクロージャ越しにしか渡していないので、
      // 水位を変えてもサブレイヤは古い値を持ち続ける（実測: 28 レイヤ全部が
      // 初期値 1.0 のまま固定されていた）。
      //
      // 地形条件を変えたときはレイヤ id 自体が変わる（flood-coarse-<surface>）ので
      // 作り直され、そちらは動いていた。**だから気づけなかった。**
      renderSubLayers: [
        o.uniforms.waterLevel, o.uniforms.mode, o.uniforms.exaggeration,
        o.uniforms.floodOpacity, o.uniforms.groundOpacity, o.uniforms.showGround,
        o.uniforms.geoid, o.uniforms.hStep,
      ],
    },

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
      // 差分モードは「標高（メッシュ用）」と「2 条件の h_conn」で 2 枚必要。
      //
      // **差分タイルの欠損は許容する。** 差分ピラミッドは「両条件とも h_conn が
      // 無い区画」を焼かないので地形より枚数が少なく（131 対 101）、
      // Promise.all で待つと差分が 404 の区画は地形タイルごと落ちて画面に穴が開く。
      // 地形タイルの失敗は従来どおり落とす（それは本当に描けない）。
      const [image, diffImage] = await Promise.all([
        get(u),
        o.diffUrlTemplate
          ? get(url(o.diffUrlTemplate, tile.index)).catch(() => null)
          : Promise.resolve(null),
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
