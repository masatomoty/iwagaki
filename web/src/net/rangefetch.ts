// ストリーム読みして「実際に受信したバイト」を数える fetch。
// Content-Length を丸ごと wasted と数えるのは過大評価なので、必ず逐次カウントする。

export interface RawResult {
  bytes: Uint8Array
  status: number
  ttfbMs: number
  received: number
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

export async function rangeFetch(
  url: string,
  range: [number, number] | undefined,
  signal: AbortSignal,
  onProgress?: ProgressSink,
): Promise<RawResult> {
  const t0 = performance.now()
  const headers: Record<string, string> = {}
  if (range) headers['Range'] = `bytes=${range[0]}-${range[1]}`
  const res = await fetch(url, { headers, signal })
  const ttfbMs = performance.now() - t0
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  if (range && res.status !== 206) throw new RangeNotHonoured(url)

  const chunks: Uint8Array[] = []
  let received = 0
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    onProgress?.(buf.length)
    return { bytes: buf, status: res.status, ttfbMs, received: buf.length }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      onProgress?.(received)
    }
  } catch (e) {
    // abort されたときも「ここまで受信した量」は呼び出し側に伝える
    ;(e as { received?: number }).received = received
    throw e
  }
  if (chunks.length === 1) return { bytes: chunks[0], status: res.status, ttfbMs, received }
  // content-encoding があると content-length（圧縮後）と受信量（展開後）が食い違うので、
  // 事前確保はせず必ず実測長で結合する
  const merged = new Uint8Array(received)
  let o = 0
  for (const c of chunks) { merged.set(c, o); o += c.length }
  return { bytes: merged, status: res.status, ttfbMs, received }
}
