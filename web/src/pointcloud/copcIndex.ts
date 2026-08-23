// COPC の octree インデックス。IO は必ず Scheduler 経由（docs/web_design.md「4 つに割る」）。
// copc.js の Getter は (begin, end) => Promise<Uint8Array> なので、そこに差し込むだけで
// 優先度・キャンセル・キャッシュがすべて効く。

import { Copc, type Getter } from 'copc'

import type { Scheduler } from '../net/scheduler'
import type { RequestClass } from '../net/types'
import type { NodeKey, PcInfo, PcNode } from './types'

/** EVLR ヘッダの固定長（reserved 2 + user_id 16 + record_id 2 + length 8 + description 32） */
const EVLR_HEADER_BYTES = 60
/** COPC 仕様で hierarchy を入れる EVLR */
const COPC_EVLR_USER_ID = 'copc'
const COPC_EVLR_RECORD_ID = 1000
/**
 * 一括取得を諦める閾値。これを超えたら従来どおりページ単位で辿る。
 * 「往復を減らすために巨大な塊を落とす」のは本末転倒なので上限を置く。
 */
const MAX_HIERARCHY_BYTES = 8 * 1024 * 1024

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
  /** hierarchy EVLR を丸ごと持てたか。false なら従来のページ単位取得にフォールバックしている */
  hierarchyPrefetched = false
  private copc!: Awaited<ReturnType<typeof Copc.create>>
  private pages = new Map<NodeKey, { pageOffset: number; pageLength: number }>()
  private loadedPages = new Set<NodeKey>()
  private hier?: { begin: number; end: number; buf: Uint8Array }

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
    await this.prefetchHierarchy()
    await this.loadPage('0-0-0-0', this.copc.info.rootHierarchyPage)
  }

  /**
   * hierarchy 全ページを 1 リクエストで取る。
   *
   * COPC の hierarchy は「1 ページ読む → 子ページの位置が分かる → また読む」という
   * 依存チェーンで、往復回数がそのまま待ち時間になる。Cloudflare 実配信で測ると
   * 33 リクエスト・合計 0.20 MB で 13〜31 秒かかり、帯域 20 Mbps・RTT 400 ms の
   * 回線でも 22.2 秒だった（docs/web_results.md）。バイト数ではなく往復回数が支配的で、
   * 「COPC を採用したから Range で必要な分だけ取れている」では済んでいなかった。
   *
   * 仕様上、全ページは user_id='copc' / record_id=1000 の EVLR 1 個に連続して入っている。
   * ここを丸ごと取ってしまえば、以後のページ読みはメモリからの切り出しで済む。
   *
   * 代償は「浅い階層しか見なくても hierarchy 全体を落とす」こと。実測では
   * どのプロファイルでも結局 33 ページ全部を読んでいたので、実質的な増分は無い。
   * 想定より大きい場合（MAX_HIERARCHY_BYTES 超）は諦めて従来経路に戻す。
   */
  private async prefetchHierarchy(): Promise<void> {
    const { evlrOffset, evlrCount } = this.copc.header
    if (!evlrOffset || !evlrCount) return
    try {
      let at = evlrOffset
      for (let i = 0; i < evlrCount; i++) {
        const head = await this.getter(at, at + EVLR_HEADER_BYTES)
        if (head.length < EVLR_HEADER_BYTES) return
        const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
        const userId = new TextDecoder()
          .decode(head.subarray(2, 18)).replace(/\0.*$/s, '')
        const recordId = dv.getUint16(18, true)
        const length = Number(dv.getBigUint64(20, true))
        const dataStart = at + EVLR_HEADER_BYTES
        if (userId === COPC_EVLR_USER_ID && recordId === COPC_EVLR_RECORD_ID) {
          if (length <= 0 || length > MAX_HIERARCHY_BYTES) return
          const buf = await this.getter(dataStart, dataStart + length)
          if (buf.length !== length) return
          this.hier = { begin: dataStart, end: dataStart + length, buf }
          this.hierarchyPrefetched = true
          return
        }
        at = dataStart + length
      }
    } catch {
      // 一括取得は最適化でしかない。失敗してもページ単位で辿れば動く
    }
  }

  /** hierarchy EVLR を持っていればメモリから返す。無ければ従来どおりネットワークへ */
  private readonly pageGetter: Getter = async (begin, end) => {
    const h = this.hier
    if (h && begin >= h.begin && end <= h.end) {
      return h.buf.subarray(begin - h.begin, end - h.begin)
    }
    return this.getter(begin, end)
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
    const sub = await Copc.loadHierarchyPage(this.pageGetter, page)
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
    for (;;) {
      const todo = [...this.pages].filter(([k]) =>
        !this.loadedPages.has(k) && Number(k.split('-')[0]) <= maxDepth)
      if (todo.length === 0) break
      const before = this.nodes.size
      // 同じ深さのページ同士に依存関係は無いので、直列 await にしない。
      // 一括取得できていれば往復ゼロ、できていなくても Scheduler が同時実行数を絞る
      await Promise.all(todo.map(([k, p]) => this.loadPage(k, p)))
      added += this.nodes.size - before
      // ページ単位取得のときは 1 段ずつに留め、呼び出し側の LOD 判断を挟ませる
      if (!this.hier) break
    }
    return added
  }

  get allNodes(): PcNode[] { return [...this.nodes.values()] }
  get sourceUrl() { return this.url }
}
