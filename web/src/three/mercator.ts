// 座標系。ここは three も deck も import しない純関数（docs/web_design.md §1）。
//
// MapLibre / deck.gl を外すと「経緯度をそのまま渡せば投影してくれる層」が無くなるので、
// ワールド空間を自分で決める必要がある。
//
// **ワールド = AOI 中心を原点とするローカルメートル（右手系 / +Z 上）**
//   x = 東 [m], y = 北 [m], z = 標高 [m]
//
// Web メルカトルのメートルは緯度で 1/cos(lat) 倍に伸びている。XY をその生の値、
// Z を真のメートルにすると、吉原（lat 35.4）では地形が 1/1.227 に潰れる。
// AOI は 1 km 四方しかないので、**中心緯度のスケール係数 1 個で割れば足りる**
// （端での誤差は catalog.local_frame.max_residual_m_over_aoi と同オーダー）。

/** Web メルカトルの地球半径 [m] */
const R = 6378137

export interface LocalFrame {
  /** AOI 中心 [lon, lat] */
  centre: [number, number]
  /** 中心の Web メルカトル座標 [m] */
  originMx: number
  originMy: number
  /** メルカトルメートル -> 真のメートル。cos(centreLat) */
  scale: number
}

export function createLocalFrame(centre: [number, number]): LocalFrame {
  const [lon, lat] = centre
  return {
    centre,
    originMx: mercatorX(lon),
    originMy: mercatorY(lat),
    scale: Math.cos((lat * Math.PI) / 180),
  }
}

export function mercatorX(lon: number): number {
  return (R * lon * Math.PI) / 180
}

export function mercatorY(lat: number): number {
  const phi = (lat * Math.PI) / 180
  return R * Math.log(Math.tan(Math.PI / 4 + phi / 2))
}

export function mercatorToLon(mx: number): number {
  return (mx / R) * (180 / Math.PI)
}

export function mercatorToLat(my: number): number {
  return (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI)
}

/** 経緯度 -> ワールド XY [m] */
export function lngLatToWorld(f: LocalFrame, lon: number, lat: number): [number, number] {
  return [(mercatorX(lon) - f.originMx) * f.scale, (mercatorY(lat) - f.originMy) * f.scale]
}

/** ワールド XY [m] -> 経緯度 */
export function worldToLngLat(f: LocalFrame, x: number, y: number): [number, number] {
  return [
    mercatorToLon(x / f.scale + f.originMx),
    mercatorToLat(y / f.scale + f.originMy),
  ]
}

// ---- XYZ タイル -------------------------------------------------------------

export interface TileId { z: number; x: number; y: number }

/** タイルの経緯度境界 [west, south, east, north] */
export function tileBoundsLngLat(z: number, x: number, y: number):
  [number, number, number, number] {
  const n = 2 ** z
  const west = (x / n) * 360 - 180
  const east = ((x + 1) / n) * 360 - 180
  const lat = (yy: number) => {
    const t = Math.PI - (2 * Math.PI * yy) / n
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)))
  }
  return [west, lat(y + 1), east, lat(y)]
}

/** 経度・緯度 -> そのズームのタイル座標（小数） */
export function lngLatToTileFrac(z: number, lon: number, lat: number): [number, number] {
  const n = 2 ** z
  const phi = (lat * Math.PI) / 180
  return [
    ((lon + 180) / 360) * n,
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  ]
}

/**
 * そのズームでの 1 タイルのワールド幅 [m]。
 * メルカトルは経度方向が一様なので x から出せば足りる。
 */
export function tileWorldSize(f: LocalFrame, z: number): number {
  return ((2 * Math.PI * R) / 2 ** z) * f.scale
}

/**
 * bbox [w,s,e,n] を覆うタイルの範囲。
 * deck.gl TileLayer の可視タイル計算に相当する部分を自前で持つ。
 */
export function tilesInBounds(
  z: number, bbox: [number, number, number, number],
): TileId[] {
  const n = 2 ** z
  const [x0, y1] = lngLatToTileFrac(z, bbox[0], bbox[1])
  const [x1, y0] = lngLatToTileFrac(z, bbox[2], bbox[3])
  const xa = Math.max(0, Math.floor(Math.min(x0, x1)))
  const xb = Math.min(n - 1, Math.floor(Math.max(x0, x1)))
  const ya = Math.max(0, Math.floor(Math.min(y0, y1)))
  const yb = Math.min(n - 1, Math.floor(Math.max(y0, y1)))
  const out: TileId[] = []
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) out.push({ z, x, y })
  return out
}

/**
 * MapLibre の `map.getZoom()` に相当する値。
 * 「画面 1 px が何メートルか」から逆算する。タイル 1 枚 = 256 px を基準にする。
 */
export function zoomForMetresPerPixel(f: LocalFrame, mpp: number): number {
  const worldMetres = 2 * Math.PI * R * f.scale     // z0 のタイル 1 枚の実距離
  return Math.log2(worldMetres / (256 * Math.max(mpp, 1e-6)))
}

// ---- ECEF（3D Tiles 用）-----------------------------------------------------
//
// PLATEAU の b3dm は `rtcCenter`（ECEF）からの **ECEF オフセット**で頂点を持つ。
// tileset.json に `transform` が無く、standalone の parse では
// `cartographicOrigin` / `modelMatrix` も付いてこない（実測で確認）ので、
// ECEF -> ローカル ENU の変換をここで持つ。

const WGS84_A = 6378137.0
const WGS84_E2 = 6.69437999014e-3

/** 経緯度 + 楕円体高 -> ECEF [m] */
export function geodeticToEcef(lon: number, lat: number, h: number): [number, number, number] {
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  const sinLa = Math.sin(la)
  const cosLa = Math.cos(la)
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLa * sinLa)
  return [
    (N + h) * cosLa * Math.cos(lo),
    (N + h) * cosLa * Math.sin(lo),
    (N * (1 - WGS84_E2) + h) * sinLa,
  ]
}

export interface EcefFrame {
  /** 原点の ECEF（楕円体高 0） */
  origin: [number, number, number]
  /** ECEF -> ENU の回転（行優先 3x3）。列が east / north / up */
  rows: [number, number, number, number, number, number, number, number, number]
}

/**
 * AOI 中心での ENU 基底。up は楕円体法線なので、返る z は**楕円体高**になる。
 * 地形も z = geoid + 標高(T.P.) = 楕円体高 で描いているので同じ土俵に乗る。
 */
export function createEcefFrame(lon: number, lat: number): EcefFrame {
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  const sLa = Math.sin(la), cLa = Math.cos(la)
  const sLo = Math.sin(lo), cLo = Math.cos(lo)
  return {
    origin: geodeticToEcef(lon, lat, 0),
    // R^T の各行（= east, north, up の各基底ベクトル）
    rows: [
      -sLo, cLo, 0,
      -sLa * cLo, -sLa * sLo, cLa,
      cLa * cLo, cLa * sLo, sLa,
    ],
  }
}

/** ECEF -> ローカル [east, north, up]（メートル） */
export function ecefToLocal(f: EcefFrame, x: number, y: number, z: number):
  [number, number, number] {
  const dx = x - f.origin[0]
  const dy = y - f.origin[1]
  const dz = z - f.origin[2]
  const r = f.rows
  return [
    r[0] * dx + r[1] * dy + r[2] * dz,
    r[3] * dx + r[4] * dy + r[5] * dz,
    r[6] * dx + r[7] * dy + r[8] * dz,
  ]
}
