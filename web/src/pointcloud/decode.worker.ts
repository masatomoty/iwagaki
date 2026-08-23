/// <reference lib="webworker" />
// デコード専用。ネットワークは触らない。取得済みのバイト列だけを受け取る。
// copc.js の Getter を「もう持っているバイトを返すだけ」にすることで fetch と decode を分離する。

import { Copc, Las } from 'copc'
import { LazPerf } from 'laz-perf/lib/worker/index.js'
import wasmUrl from 'laz-perf/lib/worker/laz-perf.wasm?url'   // 型は src/assets.d.ts

interface DecodeMsg {
  id: number
  key: string
  header: Las.Header
  eb: Las.ExtraBytes[]
  node: { pointCount: number; pointDataOffset: number; pointDataLength: number }
  bytes: ArrayBuffer
  origin: [number, number]
  matrix: [number, number, number, number]
  geoid: number
}

let lazPerfPromise: Promise<Awaited<ReturnType<typeof LazPerf.create>>> | null = null
function getLazPerf() {
  lazPerfPromise ??= LazPerf.create({ locateFile: () => wasmUrl as string })
  return lazPerfPromise
}

self.onmessage = async (ev: MessageEvent<DecodeMsg>) => {
  const m = ev.data
  const t0 = performance.now()
  try {
    const lazPerf = await getLazPerf()
    const src = new Uint8Array(m.bytes)
    // node の byte range 内しか読まれないので、オフセットを 0 に読み替えた getter を渡す
    const getter = async (begin: number, end: number) =>
      src.slice(begin - m.node.pointDataOffset, end - m.node.pointDataOffset)

    const view = await Copc.loadPointDataView(
      getter,
      { header: m.header, vlrs: [], info: {} as never, eb: m.eb } as never,
      m.node as never,
      { lazPerf, include: ['X', 'Y', 'Z'] },
    )
    const n = view.pointCount
    const gx = view.getter('X')
    const gy = view.getter('Y')
    const gz = view.getter('Z')
    const positions = new Float32Array(n * 3)
    const elevations = new Float32Array(n)
    const colors = new Uint8Array(n * 3)
    const [ox, oy] = m.origin
    const [a, b, c, d] = m.matrix
    for (let i = 0; i < n; i++) {
      const dx = gx(i) - ox
      const dy = gy(i) - oy
      const z = gz(i)
      positions[i * 3] = a * dx + b * dy
      positions[i * 3 + 1] = c * dx + d * dy
      positions[i * 3 + 2] = z + m.geoid       // 3D Tiles(楕円体高) に合わせる
      elevations[i] = z
      // 標高で色付け。メインスレッドで回すと 300 万点でフリーズするのでここでやる
      const t = Math.min(Math.max(z / 12, 0), 1)
      colors[i * 3] = 40 + 200 * t
      colors[i * 3 + 1] = 90 + 130 * (1 - Math.abs(t * 2 - 1))
      colors[i * 3 + 2] = 200 - 150 * t
    }
    const decodeMs = performance.now() - t0
    ;(self as unknown as Worker).postMessage(
      { id: m.id, key: m.key, positions, elevations, colors, pointCount: n, decodeMs },
      [positions.buffer, elevations.buffer, colors.buffer],
    )
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id: m.id, key: m.key, error: String(e) })
  }
}
