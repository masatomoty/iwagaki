// scheduler の公開型。描画ライブラリを一切知らない（docs/WEB_DESIGN.md §1）。

/** 小さいほど先。docs/WEB_DESIGN.md §4.1 */
export const P = {
  catalog: 0,
  terrainCoarse: 0,
  terrainFine: 1,
  pcIndex: 1,
  semantics: 2,
  plateau: 2,
  pcCoarse: 3,
  pcFine: 4,
  prefetch: 5,
} as const

export type RequestClass = keyof typeof P

export interface FetchTask {
  /** キャッシュキー。url + range で一意 */
  key: string
  url: string
  /** [begin, end] inclusive。省略で全体 */
  range?: [number, number]
  cls: RequestClass
  /** 同一クラス内の順序。小さいほど先 */
  rank?: number
  /** カメラ epoch。古くなり、かつ不要になったらキャンセル対象 */
  epoch?: number
  /** キャンセル判定に使う。false を返すと不要とみなす */
  stillNeeded?: () => boolean
  estBytes?: number
  signal?: AbortSignal
  /**
   * 1 本の Range にまとめた中の各部分。届いた分から順に `onPart` へ払い出す。
   * これが無いと、まとめた range は全部届くまで 1 つもデコードできない
   * （docs/WEB_RESULTS.md §4.2）。
   * begin/end はファイル先頭からの絶対オフセット、end は排他。
   */
  parts?: { key: string; begin: number; end: number }[]
  onPart?: (key: string, bytes: Uint8Array) => void
}

export interface RequestRecord {
  key: string
  cls: RequestClass
  url: string
  ranged: boolean
  startedAt: number
  endedAt?: number
  ttfbMs?: number
  bytes: number
  status?: number
  cancelled: boolean
  /** キャンセル時に既に受信していたバイト。捨てた分だけを数える */
  wastedBytes: number
  error?: string
  retries: number
  fromCache?: 'memory' | 'http'
}

export interface SchedulerStats {
  issued: number
  completed: number
  cancelled: number
  failed: number
  bytes: number
  wastedBytes: number
  peakConcurrent: number
  concurrentNow: number
  byClass: Record<string, { issued: number; bytes: number; cancelled: number; wasted: number }>
  coalesced: { groups: number; members: number; extraBytes: number }
  bandwidthBps: number
  protocol: string
}
