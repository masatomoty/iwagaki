// L1: メモリ LRU（バイト単位で上限）。L2 は HTTP キャッシュに任せる。
// cold cache 計測時は Playwright 側で HTTP キャッシュを消す。

export class ByteLru<V extends { byteLength: number }> {
  private map = new Map<string, V>()
  private bytes = 0
  constructor(private readonly limit: number) {}

  get(k: string): V | undefined {
    const v = this.map.get(k)
    if (v === undefined) return undefined
    this.map.delete(k)
    this.map.set(k, v)     // LRU: 触ったら末尾へ
    return v
  }

  has(k: string) { return this.map.has(k) }

  set(k: string, v: V) {
    if (this.map.has(k)) this.bytes -= this.map.get(k)!.byteLength
    this.map.set(k, v)
    this.bytes += v.byteLength
    while (this.bytes > this.limit && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string
      this.bytes -= this.map.get(oldest)!.byteLength
      this.map.delete(oldest)
    }
  }

  get size() { return this.map.size }
  get byteSize() { return this.bytes }
  clear() { this.map.clear(); this.bytes = 0 }
}
