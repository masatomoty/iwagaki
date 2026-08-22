// COPC の octree インデックス。IO は必ず Scheduler 経由（docs/WEB_DESIGN.md §3.2）。
// copc.js の Getter は (begin, end) => Promise<Uint8Array> なので、そこに差し込むだけで
// 優先度・キャンセル・キャッシュがすべて効く。

import { Copc, type Getter } from 'copc'

import type { Scheduler } from '../net/scheduler'
import type { RequestClass } from '../net/types'
import type { NodeKey, PcInfo, PcNode } from './types'

export function schedulerGetter(
  scheduler: Scheduler, url: string, cls: RequestClass,
): Getter {
  return async (begin: number, end: number) =>
    scheduler.submit({
      key: `${url}#${begin}-${end}`,
      url,
      range: [begin, end - 1],       // copc.js は end exclusive、HTTP は inclusive
      cls,
      estBytes: end - begin,
    })
}

export class CopcIndex {
  readonly nodes = new Map<NodeKey, PcNode>()
  info!: PcInfo
  header!: Awaited<ReturnType<typeof Copc.create>>['header']
  eb!: Awaited<ReturnType<typeof Copc.create>>['eb']
  private copc!: Awaited<ReturnType<typeof Copc.create>>
  private pages = new Map<NodeKey, { pageOffset: number; pageLength: number }>()
  private loadedPages = new Set<NodeKey>()

  constructor(private readonly url: string, private readonly getter: Getter) {}

  async open(): Promise<void> {
    this.copc = await Copc.create(this.getter)
    this.header = this.copc.header
    this.eb = this.copc.eb
    this.info = {
      cube: this.copc.info.cube as PcInfo['cube'],
      spacing: this.copc.info.spacing,
      pointCount: this.copc.header.pointCount,
      pointDataRecordFormat: this.copc.header.pointDataRecordFormat,
      pointDataRecordLength: this.copc.header.pointDataRecordLength,
    }
    await this.loadPage('0-0-0-0', this.copc.info.rootHierarchyPage)
  }

  /** COPC のノードキーは cube の八分木。キーから AABB を復元する */
  boundsOf(key: NodeKey): PcNode['bounds'] {
    const [d, x, y, z] = key.split('-').map(Number)
    const c = this.info.cube
    const n = 2 ** d
    const sx = (c[3] - c[0]) / n
    const sy = (c[4] - c[1]) / n
    const sz = (c[5] - c[2]) / n
    return [c[0] + x * sx, c[1] + y * sy, c[2] + z * sz,
            c[0] + (x + 1) * sx, c[1] + (y + 1) * sy, c[2] + (z + 1) * sz]
  }

  private async loadPage(key: NodeKey, page: { pageOffset: number; pageLength: number }) {
    if (this.loadedPages.has(key)) return
    this.loadedPages.add(key)
    const sub = await Copc.loadHierarchyPage(this.getter, page)
    for (const [k, n] of Object.entries(sub.nodes)) {
      if (!n) continue
      this.nodes.set(k, {
        key: k,
        depth: Number(k.split('-')[0]),
        pointCount: n.pointCount,
        byteOffset: n.pointDataOffset,
        byteLength: n.pointDataLength,
        bounds: this.boundsOf(k),
      })
    }
    for (const [k, p] of Object.entries(sub.pages)) if (p) this.pages.set(k, p)
  }

  /** 未展開の子ページを必要な分だけ読む */
  async expand(maxDepth: number): Promise<number> {
    let added = 0
    for (const [k, p] of [...this.pages]) {
      if (this.loadedPages.has(k)) continue
      if (Number(k.split('-')[0]) > maxDepth) continue
      const before = this.nodes.size
      await this.loadPage(k, p)
      added += this.nodes.size - before
    }
    return added
  }

  get allNodes(): PcNode[] { return [...this.nodes.values()] }
  get sourceUrl() { return this.url }
}
