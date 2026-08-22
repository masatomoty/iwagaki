// PLATEAU 3D Tiles。@loaders.gl/3d-tiles は重いので、この module ごと遅延読み込みする
// （first_meaningful_render を JS バンドルで押し出さないため: docs/WEB_DESIGN.md §9.3）。

import { Tile3DLayer } from '@deck.gl/geo-layers'
import { Tiles3DLoader } from '@loaders.gl/3d-tiles'

import type { Scheduler } from '../net/scheduler'

export interface PlateauOptions {
  url: string
  scheduler: Scheduler
  onTileLoad: () => void
  onTileError: (t: unknown, e: unknown) => void
}

export function createPlateauLayer(o: PlateauOptions) {
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
    onTileLoad: o.onTileLoad,
    onTileError: o.onTileError,
    pickable: false,
    opacity: 1,
  })
}
