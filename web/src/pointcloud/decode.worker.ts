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
  /** false なら RGB を読まず標高ランプで塗る（計測用。既定は true） */
  useRgb?: boolean
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
      // **RGB も読む。** バイト列は既に取得・展開してあるので追加の通信は 0 で、
      // 増えるのは getter 3 本ぶんの CPU だけ。
      // `?rgb=0` のときは読まない（A/B 計測用。docs/web_results.md）
      { lazPerf, include: m.useRgb === false
          ? ['X', 'Y', 'Z'] : ['X', 'Y', 'Z', 'Red', 'Green', 'Blue'] },
    )
    const n = view.pointCount
    const gx = view.getter('X')
    const gy = view.getter('Y')
    const gz = view.getter('Z')
    // 合成点群など RGB を持たない配信物もあるので、無ければ標高ランプに落ちる
    const hasRgb = m.useRgb !== false
      && ['Red', 'Green', 'Blue'].every((d) => d in view.dimensions)
    const gr = hasRgb ? view.getter('Red') : undefined
    const gg = hasRgb ? view.getter('Green') : undefined
    const gb = hasRgb ? view.getter('Blue') : undefined
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
      // **色は点群自身の RGB を使う。** バックパック SLAM（LiBackpack）は
      // カメラ付きで、配信している COPC は PDRF 7 / 36 バイトで
      // Red/Green/Blue を実データとして持っている（min 2〜255・mean 126〜140）。
      // 標高ランプで塗り直すと、その実測色を捨てて別の意味を被せることになる。
      //
      // ランプをやめた理由は 3 つ。
      //   1. **絶対標高は点群の役に立たない。** 市街は T.P. 0〜3 m しか無いので
      //      どんなランプでも肝心の帯が潰れる。地面と 3 m 先の壁が別色になるだけ
      //   2. **どの色相を選んでも主張と衝突する。** 青は浸水深、赤と黄は判定差、
      //      黄は点群の被覆線、緑は断面の系列が使っている
      //   3. 実測色なら **「これは現況の観測、青いのは我々の判定」** が
      //      説明なしで分かる（`README.md`「役割を分けて突き合わせる」）
      //
      // LAS の RGB は 16 bit 幅だが、この配信物は 0〜255 に収まっている
      // （実測 max 255）ので 8 bit としてそのまま使う。16 bit で入っている
      // 配信物に当たったら 8 bit に落とす。
      if (gr && gg && gb) {
        const r = gr(i), g = gg(i), bl = gb(i)
        const k = r > 255 || g > 255 || bl > 255 ? 1 / 257 : 1
        // **彩度は触らない。** 起こすと見た目はほとんど変わらないのに
        // decode が 3 倍になる [実測]（`docs/web_results.md`「点群の色を実測 RGB に」）:
        //   RGB を読まない（標高ランプ）      p50 38.5 ms
        //   RGB を読む・彩度そのまま          p50 42.9 ms  ← これ
        //   RGB を読む・彩度 1.15 倍          p50 117.7 ms
        // 1 点あたり輝度 + 3 回の補間 + 6 回の clamp が 3,700 万点に掛かる。
        // 実測色を作り変えないという方針にも合う
        colors[i * 3] = r * k
        colors[i * 3 + 1] = g * k
        colors[i * 3 + 2] = bl * k
      } else {
        // RGB を持たない配信物（DTM から作った合成点群）向けの退避。
        // 紫にしてあるのは、主張が使っていない唯一の色相だから
        const t = Math.pow(Math.min(Math.max(z / 8, 0), 1), 0.6)
        colors[i * 3] = 100 + 106 * t
        colors[i * 3 + 1] = 80 + 106 * t
        colors[i * 3 + 2] = 140 + 110 * t
      }
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
