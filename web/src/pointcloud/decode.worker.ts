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
      // 標高で色付け。メインスレッドで回すと 300 万点でフリーズするのでここでやる。
      //
      // **単一色相（紫）にしてある。** 以前は 0〜12 m を青→緑→橙に振る虹だったが、
      // 2 つ問題があった。
      //   1. 吉原の市街は T.P. 0〜3 m しか無いので、**肝心の帯がランプの下 1/4 に潰れる**。
      //      12 m 以上は全部同じ色で、街の中はほぼ単色の青だった
      //   2. 青は浸水深、赤と黄は判定差、黄は点群の被覆線が使っている。
      //      **虹はそのどれとも衝突する**ので、点群と主張の区別が付かない
      // 紫はどの主張も使っていない色なので、「これは観測であって判定ではない」が
      // 色だけで分かる。明るさだけを標高に振る（0〜8 m、低い側にランプを寄せる）。
      // 上端は白に寄せない。白にすると紫という手掛かりが消えて、陰影の地形と
      // 見分けが付かなくなる（かつ眩しい）。全域で紫のままにする
      const t = Math.pow(Math.min(Math.max(z / 8, 0), 1), 0.6)
      colors[i * 3] = 100 + 106 * t
      colors[i * 3 + 1] = 80 + 106 * t
      colors[i * 3 + 2] = 140 + 110 * t
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
