// 焼いた地形タイルから、任意の測線に沿って標高と h_conn を読む。
//
// **追加の通信は起きない。** 画面に出ている地形と同じタイルを Scheduler 経由で
// 取るので、既に取得済みならメモリキャッシュから返る。
//
// 断面図を「解析側で焼いて配信する」形にすると測線を動かせない。
// タイルは既にブラウザに来ているので、ここで読むほうが安い。

import { decodeElev, decodeHConn } from './packing'
import { decodeRgba8 } from './png'

export interface SamplePoint {
  /** 測線始点からの距離 [m] */
  d: number
  lon: number
  lat: number
  /** 標高 [m T.P.]。nodata は NaN */
  elev: number
  /** 連結浸水開始水位 [m T.P.]。どの水位でも浸水しないなら Infinity */
  hConn: number
}

/** lng/lat -> タイル座標と画素位置。タイルは 256 px、1 画素 = 1 セル */
function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z
  const xf = ((lon + 180) / 360) * n
  const rad = (lat * Math.PI) / 180
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  const x = Math.floor(xf)
  const y = Math.floor(yf)
  return {
    x, y,
    px: Math.min(255, Math.max(0, Math.floor((xf - x) * 256))),
    py: Math.min(255, Math.max(0, Math.floor((yf - y) * 256))),
  }
}

/** 2 点間の距離 [m]。AOI は 1 km 四方なので等距離近似で十分 */
function metres(a: [number, number], b: [number, number]): number {
  const mLat = 111132.92
  const mLon = 111412.84 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  return Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * mLat)
}

export interface SampleLineOptions {
  urlTemplate: string
  zoom: number
  hStep: number
  from: [number, number]
  to: [number, number]
  /** 標本の間隔 [m]。既定 1 m（z18 のセルは 0.49 m） */
  stepM?: number
  /** タイルのバイト列を取る。Scheduler を渡す側で包む */
  fetchTile: (url: string) => Promise<Uint8Array>
}

/**
 * 測線に沿って標本を返す。
 *
 * タイル 1 枚ごとにまとめて読む。1 画素ずつ `createImageBitmap` すると
 * 500 m の測線で数百回デコードすることになる。
 */
export async function sampleLine(o: SampleLineOptions): Promise<SamplePoint[]> {
  const total = metres(o.from, o.to)
  const step = o.stepM ?? 1
  const n = Math.max(2, Math.min(2000, Math.ceil(total / step) + 1))

  // まず全標本の位置とタイルを決める
  const pts = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    const lon = o.from[0] + (o.to[0] - o.from[0]) * t
    const lat = o.from[1] + (o.to[1] - o.from[1]) * t
    return { d: total * t, lon, lat, ...tileOf(lon, lat, o.zoom) }
  })

  // タイルごとにまとめる
  const byTile = new Map<string, typeof pts>()
  for (const p of pts) {
    const k = `${p.x}/${p.y}`
    const a = byTile.get(k)
    if (a) a.push(p)
    else byTile.set(k, [p])
  }

  const out: SamplePoint[] = pts.map((p) => ({
    d: p.d, lon: p.lon, lat: p.lat, elev: NaN, hConn: Infinity,
  }))
  const index = new Map(pts.map((p, i) => [p, i]))

  await Promise.all([...byTile.entries()].map(async ([, group]) => {
    const { x, y } = group[0]
    const url = o.urlTemplate
      .replace('{z}', String(o.zoom)).replace('{x}', String(x)).replace('{y}', String(y))
    let img
    try {
      // **canvas を通さない。** アルファ乗算で RGB が壊れる（assets/png.ts）
      img = await decodeRgba8(await o.fetchTile(url))
    } catch {
      return                                  // 焼かれていない区画。NaN のまま残す
    }
    const { data, width } = img
    for (const p of group) {
      const i = (p.py * width + p.px) * 4
      const s = out[index.get(p)!]
      s.elev = decodeElev(data[i], data[i + 1], data[i + 2])
      s.hConn = decodeHConn(data[i + 3], o.hStep)
    }
  }))

  return out
}
