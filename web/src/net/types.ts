// scheduler の公開型。描画ライブラリを一切知らない（docs/web_design.md「層の分け方」）。

/** 小さいほど先。docs/web_design.md「優先度クラス」 */
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
   * （docs/web_results.md「スケジューリング」）。
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
  /** デコード後のバイト数 */
  bytes: number
  /**
   * 回線を流れたバイト数。圧縮が効くアセットでは bytes と大きくずれる
   * （objects.geojson: decode 569,699 B / wire 92,301 B）。
   * **ネットワークの話をするときはこちらを使う。**
   */
  wireBytes: number
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
  /** デコード後の合計 */
  bytes: number
  /** 回線を流れた合計。圧縮を戻さない、比較に使ってよい方の値 */
  wireBytes: number
  wastedBytes: number
  peakConcurrent: number
  concurrentNow: number
  byClass: Record<string, { issued: number; bytes: number; wireBytes: number
                            cancelled: number; wasted: number }>
  coalesced: { groups: number; members: number; extraBytes: number }
  bandwidthBps: number
  protocol: string
}
