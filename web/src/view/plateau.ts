// PLATEAU 3D Tiles。@loaders.gl/3d-tiles は重いので、この module ごと遅延読み込みする
// （first_meaningful_render を JS バンドルで押し出さないため: docs/WEB_DESIGN.md §9.3）。

import { Tile3DLayer } from '@deck.gl/geo-layers'
import { Tiles3DLoader } from '@loaders.gl/3d-tiles'

import type { Scheduler } from '../net/scheduler'

/**
 * PLATEAU の b3dm は `_BATCHID`（SCALAR / UNSIGNED_BYTE）を持っている。
 * luma.gl v9 は WebGPU の頂点フォーマットに落とすので 8bit スカラーを表現できず、
 * `size: 1` で ScenegraphLayer の初期化が落ちる = **その建物が描かれない**。
 *
 * loaders.gl の後処理で `_BATCHID` は `CUSTOM_ATTRIBUTE_2` に改名されるため、
 * 名前ではなく「スカラー属性」で落とす。POSITION / NORMAL / TEXCOORD / COLOR は
 * どれも 2 要素以上なので、size === 1 を消しても描画に必要なものは失われない。
 * 我々は地物の選択を GeoJSON 側でやっていて _BATCHID を使わない。
 */
function stripScalarAttributes(gltf: unknown): number {
  let removed = 0
  const meshes = (gltf as { meshes?: unknown[] })?.meshes
  if (!Array.isArray(meshes)) return 0
  for (const m of meshes) {
    for (const prim of (m as { primitives?: unknown[] }).primitives ?? []) {
      const attrs = (prim as { attributes?: Record<string, { size?: number }> }).attributes
      if (!attrs) continue
      for (const [k, v] of Object.entries(attrs)) {
        if (v?.size === 1) { delete attrs[k]; removed++ }
      }
    }
  }
  return removed
}

export interface PlateauOptions {
  url: string
  scheduler: Scheduler
  onTileLoad: () => void
  /** 現在の視野に必要なタイルが揃った瞬間。全タイルの取得完了ではない */
  onViewportLoaded: () => void
  onTileError: (t: unknown, e: unknown) => void
}

export function createPlateauLayer(o: PlateauOptions) {
  let tileset: { isLoaded?: () => boolean } | undefined
  return new Tile3DLayer({
    id: 'plateau-bldg',
    data: o.url,
    loader: Tiles3DLoader,
    loadOptions: {
      // loaders.gl 側の RequestScheduler を止めて、絞りを Scheduler に一本化する
      tileset: { throttleRequests: false, maxRequests: 0 },
      fetch: async (url: string, opts?: { signal?: AbortSignal }) => {
        const bytes = await o.scheduler.submit({
          key: url, url, cls: 'plateau', signal: opts?.signal,
        })
        const res = new Response(bytes as unknown as BodyInit, {
          headers: {
            'content-type': url.endsWith('.json')
              ? 'application/json' : 'application/octet-stream',
          },
        })
        // loaders.gl は response.url で loader を選ぶ。手で作った Response は url が
        // 空になり、tileset.json が b3dm として解釈されてしまう
        Object.defineProperty(res, 'url', { value: url })
        return res
      },
    },
    onTilesetLoad: (ts: unknown) => { tileset = ts as { isLoaded?: () => boolean } },
    onTileLoad: (tile: unknown) => {
      const content = (tile as { content?: { gltf?: unknown } })?.content
      if (content?.gltf) stripScalarAttributes(content.gltf)
      o.onTileLoad()
      // 「全 22 タイルの取得完了」を待つと、視野外のタイルが読まれるまで
      // 立たない指標になる（実測で 49 秒かかった）。視野が満たされた時点にする
      if (tileset?.isLoaded?.()) o.onViewportLoaded()
    },
    onTileError: o.onTileError,
    pickable: false,
    opacity: 1,
  })
}
