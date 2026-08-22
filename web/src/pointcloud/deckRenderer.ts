// v1 の renderer。deck.gl PointCloudLayer をノード 1 つにつき 1 レイヤ作る。
// この「ノード = レイヤ」の対応が破綻したら custom renderer に移る（§10 条件 2）。

import { COORDINATE_SYSTEM } from '@deck.gl/core'
import { Matrix4 } from '@math.gl/core'
import { PointCloudLayer } from '@deck.gl/layers'

import type { PointCloudRenderer, PointStyle } from './renderer'
import type { DecodedChunk, NodeKey } from './types'

export class DeckPointCloudRenderer implements PointCloudRenderer {
  readonly kind = 'deck' as const
  private chunks = new Map<NodeKey, DecodedChunk>()
  /**
   * レイヤ実体をキャッシュする。毎回 new すると deck.gl から見て「別のレイヤ」になり、
   * カメラを動かすたびに全ノードの属性が GPU へ再アップロードされる。
   * 実測でカメラ操作中 16.7 ms -> 81.3 ms/frame になっていた原因がこれ。
   */
  private layerCache = new Map<NodeKey, PointCloudLayer>()
  private style: PointStyle = { pointSize: 1.4, opacity: 1 }
  private exaggeration = 1

  constructor(
    private readonly origin: [number, number],
    private readonly onChange: () => void,
  ) {}

  upsert(chunks: DecodedChunk[]) {
    for (const c of chunks) {
      this.chunks.set(c.key, c)
      this.layerCache.delete(c.key)     // 中身が変わったものだけ作り直す
    }
    this.onChange()
  }

  evict(keys: NodeKey[]) {
    let n = 0
    for (const k of keys) {
      if (this.chunks.delete(k)) n++
      this.layerCache.delete(k)
    }
    if (n) this.onChange()
  }

  setStyle(s: PointStyle) {
    this.style = s
    this.layerCache.clear()             // スタイル変更のときだけ全再構築
    this.onChange()
  }

  /**
   * 鉛直強調は modelMatrix で掛ける。点の z は decode 時に (標高 + geoid) にしてあるので、
   * z' = geoid + k * (z - geoid) になるよう平行移動を足す。
   */
  private modelMatrix(k: number, geoid: number): Matrix4 | undefined {
    if (k === 1) return undefined
    return new Matrix4().translate([0, 0, geoid * (1 - k)]).scale([1, 1, k])
  }

  layers(visible: boolean, exaggeration = 1, geoid = 0) {
    if (!visible) return []
    if (exaggeration !== this.exaggeration) {
      this.exaggeration = exaggeration
      this.layerCache.clear()
    }
    const mm = this.modelMatrix(exaggeration, geoid)
    const out: PointCloudLayer[] = []
    for (const c of this.chunks.values()) {
      let l = this.layerCache.get(c.key)
      if (!l) {
        l = new PointCloudLayer({
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
          modelMatrix: mm,
          pointSize: this.style.pointSize,
          opacity: this.style.opacity,
          sizeUnits: 'pixels',
          pickable: false,
        })
        this.layerCache.set(c.key, l)
      }
      out.push(l)
    }
    return out
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
  dispose() { this.chunks.clear(); this.layerCache.clear() }
}
