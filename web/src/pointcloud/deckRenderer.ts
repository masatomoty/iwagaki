// v1 の renderer。deck.gl PointCloudLayer をノード 1 つにつき 1 レイヤ作る。
// この「ノード = レイヤ」の対応が破綻したら custom renderer に移る（§10 条件 2）。

import { COORDINATE_SYSTEM } from '@deck.gl/core'
import { PointCloudLayer } from '@deck.gl/layers'

import type { PointCloudRenderer, PointStyle } from './renderer'
import type { DecodedChunk, NodeKey } from './types'

export class DeckPointCloudRenderer implements PointCloudRenderer {
  readonly kind = 'deck' as const
  private chunks = new Map<NodeKey, DecodedChunk>()
  private style: PointStyle = { pointSize: 1.4, opacity: 1 }
  private dirty = true

  constructor(
    private readonly origin: [number, number],
    private readonly onChange: () => void,
  ) {}

  upsert(chunks: DecodedChunk[]) {
    for (const c of chunks) this.chunks.set(c.key, c)
    this.dirty = true
    this.onChange()
  }

  evict(keys: NodeKey[]) {
    let n = 0
    for (const k of keys) if (this.chunks.delete(k)) n++
    if (n) { this.dirty = true; this.onChange() }
  }

  setStyle(s: PointStyle) { this.style = s; this.dirty = true; this.onChange() }

  layers(visible: boolean) {
    this.dirty = false
    if (!visible) return []
    return [...this.chunks.values()].map((c) =>
      new PointCloudLayer({
        id: `pc-${c.key}`,
        // バイナリ属性で渡す。1 点ずつ JS を回すと 300 万点で破綻する
        data: {
          length: c.pointCount,
          attributes: {
            getPosition: { value: c.positions, size: 3 },
            getColor: { value: c.colors, size: 3, normalized: true },
          },
        },
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: [this.origin[0], this.origin[1], 0],
        pointSize: this.style.pointSize,
        opacity: this.style.opacity,
        sizeUnits: 'pixels',
        pickable: false,
      }))
  }

  stats() {
    let pts = 0
    let bytes = 0
    for (const c of this.chunks.values()) {
      pts += c.pointCount
      bytes += c.positions.byteLength + c.colors.byteLength
    }
    return { residentPoints: pts, drawCalls: this.chunks.size, gpuBytes: bytes }
  }

  get residentKeys(): NodeKey[] { return [...this.chunks.keys()] }
  dispose() { this.chunks.clear() }
}
