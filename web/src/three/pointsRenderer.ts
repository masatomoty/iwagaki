// 点群レンダラの three.js 版。deck.gl PointCloudLayer の置き換え。
//
// index / LOD / scheduler / decode は renderer に依存していないので（docs/WEB_DESIGN.md §10）、
// PointCloudRenderer インタフェースを満たすだけで差し替わる。
//
// deck 版で踏んだ罠は同じ形で避ける: **チャンクごとに Points を使い回す**。
// 毎フレーム作り直すと属性が GPU へ再アップロードされ、カメラ操作中
// 16.7 ms -> 81.3 ms/frame になっていた（docs/WEB_RESULTS.md §6.2）。

import {
  BufferAttribute, BufferGeometry, Group, Points, PointsMaterial,
} from 'three'

import type { PointCloudRenderer, PointStyle } from '../pointcloud/renderer'
import type { DecodedChunk, NodeKey } from '../pointcloud/types'

interface Resident {
  chunk: DecodedChunk
  points: Points
  geometry: BufferGeometry
}

export class ThreePointCloudRenderer implements PointCloudRenderer {
  readonly kind = 'custom' as const
  readonly group = new Group()

  private resident = new Map<NodeKey, Resident>()
  private material: PointsMaterial
  private style: PointStyle = { pointSize: 1.4, opacity: 1 }
  private exaggeration = 1
  private geoid = 0

  constructor(private readonly onChange: () => void) {
    this.material = new PointsMaterial({
      size: this.style.pointSize,
      // deck の sizeUnits:'pixels' と揃える。距離で大きさを変えない
      sizeAttenuation: false,
      vertexColors: true,
      transparent: false,
      opacity: 1,
    })
    this.group.matrixAutoUpdate = false
    this.applyTransform()
  }

  upsert(chunks: DecodedChunk[]) {
    for (const c of chunks) {
      this.destroy(c.key)
      const g = new BufferGeometry()
      // 点の座標は decode 時に AOI 中心からの [east, north, up] メートルになっている。
      // ワールド（= AOI 中心原点の真メートル）とそのまま一致するので変換は要らない
      g.setAttribute('position', new BufferAttribute(c.positions, 3))
      g.setAttribute('color', new BufferAttribute(c.colors, 3, true))
      // ノードの境界は COPC の bounds で分かっているが、three に再計算させると
      // 69.7 M 点で無視できない。視錐台カリングは LOD 側が済ませている
      g.boundingSphere = null
      const p = new Points(g, this.material)
      p.frustumCulled = false
      this.group.add(p)
      this.resident.set(c.key, { chunk: c, points: p, geometry: g })
    }
    this.onChange()
  }

  evict(keys: NodeKey[]) {
    let n = 0
    for (const k of keys) if (this.destroy(k)) n++
    if (n) this.onChange()
  }

  setStyle(s: PointStyle) {
    this.style = s
    this.material.size = s.pointSize
    this.material.opacity = s.opacity
    this.material.transparent = s.opacity < 1
    this.material.needsUpdate = true
    this.onChange()
  }

  setVisible(v: boolean) {
    this.group.visible = v
    this.onChange()
  }

  /**
   * 鉛直強調。点の z は decode 時に (標高 + geoid) なので、
   * z' = geoid + k * (z - geoid) になるよう スケール + 平行移動 を掛ける。
   */
  setExaggeration(k: number, geoid: number) {
    if (k === this.exaggeration && geoid === this.geoid) return
    this.exaggeration = k
    this.geoid = geoid
    this.applyTransform()
    this.onChange()
  }

  private applyTransform() {
    const k = this.exaggeration
    this.group.scale.set(1, 1, k)
    this.group.position.set(0, 0, this.geoid * (1 - k))
    this.group.updateMatrix()
    this.group.updateMatrixWorld(true)
  }

  private destroy(k: NodeKey): boolean {
    const r = this.resident.get(k)
    if (!r) return false
    this.group.remove(r.points)
    r.geometry.dispose()
    this.resident.delete(k)
    return true
  }

  stats() {
    let pts = 0
    let bytes = 0
    for (const r of this.resident.values()) {
      pts += r.chunk.pointCount
      bytes += r.chunk.positions.byteLength + r.chunk.colors.byteLength
    }
    return { residentPoints: pts, drawCalls: this.resident.size, gpuBytes: bytes }
  }

  get residentKeys(): NodeKey[] { return [...this.resident.keys()] }

  dispose() {
    for (const k of [...this.resident.keys()]) this.destroy(k)
    this.material.dispose()
  }
}
