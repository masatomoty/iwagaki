// ストリーム読みして「実際に受信したバイト」を数える fetch。
// Content-Length を丸ごと wasted と数えるのは過大評価なので、必ず逐次カウントする。

export interface RawResult {
  bytes: Uint8Array
  status: number
  ttfbMs: number
  /** デコード後のバイト数。呼び出し側が実際に受け取る長さ */
  received: number
  /**
   * 応答が content-encoding で圧縮されていたか。
   * 圧縮されていれば received（デコード後）は wire の長さではないので、
   * Scheduler が PerformanceResourceTiming から引き当て直す。
   */
  encoded: boolean
}

export class RangeNotHonoured extends Error {
  constructor(url: string) {
    // Range を要求したのに 200 が返る配信（Cloudflare Pages 等）はここで落とす。
    // 黙って全体を落とすと、それが最大のネットワーク事故になる。
    super(`server ignored Range and returned 200: ${url}`)
    this.name = 'RangeNotHonoured'
  }
}

export interface ProgressSink { (received: number): void }

/**
 * チャンクが届くたびに呼ばれる。`buf` は先頭から `received` バイトまでが有効。
 * Range 要求で長さが確定しているときだけ渡される（= 逐次デコードできるのはその場合だけ）。
 */
export interface StreamSink { (buf: Uint8Array, received: number): void }

export async function rangeFetch(
  url: string,
  range: [number, number] | undefined,
  signal: AbortSignal,
  onProgress?: ProgressSink,
  onData?: StreamSink,
): Promise<RawResult> {
  const t0 = performance.now()
  const headers: Record<string, string> = {}
  if (range) headers['Range'] = `bytes=${range[0]}-${range[1]}`
  const res = await fetch(url, { headers, signal })
  const ttfbMs = performance.now() - t0
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  if (range && res.status !== 206) throw new RangeNotHonoured(url)
  // Cloudflare は br 応答に content-length を付けないので、ここでは
  // 「圧縮されていたか」だけ分かる。wire の長さは Scheduler が
  // PerformanceResourceTiming.encodedBodySize から引き当てる
  const encoded = !!res.headers.get('content-encoding')

  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    onProgress?.(buf.length)
    onData?.(buf, buf.length)
    return { bytes: buf, status: res.status, ttfbMs, received: buf.length,
             encoded }
  }

  // Range 要求なら長さが確定しているので事前確保できる。
  // こうすると「届いた分までのバッファ」をそのまま呼び出し側に渡せて、
  // 1 リクエストの完了を待たずに部分ごとのデコードを始められる。
  let out: Uint8Array | null = range ? new Uint8Array(range[1] - range[0] + 1) : null
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (out) {
        if (received + value.length > out.length) {
          // content-encoding などで受信量が Range 長を超えた。事前確保をやめて積み直す
          chunks.push(out.slice(0, received))
          out = null
          chunks.push(value)
        } else {
          out.set(value, received)
        }
      } else {
        chunks.push(value)
      }
      received += value.length
      onProgress?.(received)
      if (out) onData?.(out, received)
    }
  } catch (e) {
    // abort されたときも「ここまで受信した量」は呼び出し側に伝える
    ;(e as { received?: number }).received = received
    throw e
  }
  if (out) {
    const bytes = received === out.length ? out : out.subarray(0, received)
    return { bytes, status: res.status, ttfbMs, received, encoded }
  }
  if (chunks.length === 1) {
    return { bytes: chunks[0], status: res.status, ttfbMs, received, encoded }
  }
  const merged = new Uint8Array(received)
  let o = 0
  for (const c of chunks) { merged.set(c, o); o += c.length }
  return { bytes: merged, status: res.status, ttfbMs, received, encoded }
}
