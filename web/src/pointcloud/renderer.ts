// renderer は差し替え前提。移行条件は docs/web_design.md「レンダラを差し替える条件」。
// index / LOD / scheduler / decode はここに依存しないので、そのまま再利用できる。

import type { DecodedChunk, NodeKey } from './types'

export interface PointStyle {
  pointSize: number
  opacity: number
}

export interface PointCloudRenderer {
  readonly kind: 'deck' | 'custom'
  upsert(chunks: DecodedChunk[]): void
  evict(keys: NodeKey[]): void
  setStyle(s: PointStyle): void
  stats(): { residentPoints: number; drawCalls: number; gpuBytes: number }
  readonly residentKeys: NodeKey[]
  dispose(): void
}
