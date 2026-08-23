// 地図のカメラを「AOI ローカル(メートル, ENU)」に直す。純関数。
// maplibre-gl / deck.gl / three.js を import しない（docs/web_design.md「層の分け方」）。
//
// なぜドメイン側に置くか: 点群 LOD は「カメラからノードまでの距離」で
// 詳細度を決める。この変換を描画層に置くと、レンダラを差し替えるたびに
// 書き写すことになり、そのたびに間違える。実際、旧実装は
//
//     eye = [0, 0, cameraToCenterDistance / 8]
//
// と**水平成分を AOI 中心の真上に固定**していた。しかも
// `cameraToCenterDistance` はキャンバス高さと fov だけで決まり
// **ズームに依存しない**ので、視点は事実上の定数だった。
// 結果、LOD が選ぶノードはカメラをどう動かしても変わらず
// （実測: zoom 18.4 と 12.5 で wantedPoints が完全に同一）、
// 「近くは細かく遠くは粗く」が効いていなかった（docs/web_results.md「キャンセル」）。

/** 緯度 1 度あたりの距離 [m]。WGS84 の子午線曲率から */
export function metresPerDegreeLat(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p)
}

/** 経度 1 度あたりの距離 [m]。WGS84 の卯酉線曲率から */
export function metresPerDegreeLon(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p)
}

/**
 * Web メルカトルの 1 CSS ピクセルあたりの距離 [m]。**タイル 1 枚 = 256 px 基準。**
 *
 * 定数 156543.03392 = 2πR / 256 で、256 px タイルの式である。**ここに MapLibre の
 * `map.getZoom()`（512 px 基準）を渡すと 2 倍の値が返る。** 旧実装はまさにそれで、
 * `eyeInLocal` のカメラ距離が常に 2 倍になっていた。結果、既定の視点でも
 * 点群 LOD は最粗のノード集合しか選ばず（実測 `wantedPoints` = 12,174 = 引き切ったときと同値）、
 * 「近くは細かく」が既定視点で効いていなかった。three.js の `Viewer.getZoom()` は
 * 256 px 基準なので、そのまま渡してよい（docs/web_design.md「ズームの規約」）。
 */
export function metresPerPixel(latDeg: number, zoom: number): number {
  return (156543.03392 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom
}

/** 地図が今どこを見ているか。maplibre / three どちらからでも埋められる形にする */
export interface CameraDescription {
  /** 注視点 [lon, lat] */
  centre: [number, number]
  zoom: number
  pitchDeg: number
  /** 真北からの時計回り [deg] */
  bearingDeg: number
  /** 画面高さ [px] */
  viewportHeight: number
  /** 垂直画角 [rad] */
  fovY: number
  /**
   * カメラから注視点までの距離 [px]。maplibre の `transform.cameraToCenterDistance`。
   * **これ自体はズームに依存しない**（キャンバス高さと fov で決まる）ので、
   * メートルに直すときに必ず metresPerPixel を掛けること。
   */
  cameraToCentrePx: number
}

/** ローカル ENU の原点 [lon, lat]（catalog.local_frame.origin_wgs84） */
export type LocalOrigin = [number, number]

/** [lon, lat] -> ローカル ENU [east, north] メートル。AOI 1 km 四方では等距離近似で十分 */
export function lonLatToLocal(
  lonLat: [number, number], origin: LocalOrigin,
): [number, number] {
  const mLat = metresPerDegreeLat(origin[1])
  const mLon = metresPerDegreeLon(origin[1])
  return [(lonLat[0] - origin[0]) * mLon, (lonLat[1] - origin[1]) * mLat]
}

/**
 * カメラの位置をローカル ENU [east, north, up] メートルで返す。
 *
 * pitch=0 なら注視点の真上。pitch を倒すほど、視線と逆向き（手前）に下がりながら低くなる。
 * bearing は「画面上方向が指す方位」なので、カメラは注視点から
 * bearing の逆方向にずれる。
 */
export function eyeInLocal(cam: CameraDescription, origin: LocalOrigin): [number, number, number] {
  const mpp = metresPerPixel(cam.centre[1], cam.zoom)
  const d = cam.cameraToCentrePx * mpp               // カメラ〜注視点 [m]
  const pitch = (cam.pitchDeg * Math.PI) / 180
  const bearing = (cam.bearingDeg * Math.PI) / 180
  const up = d * Math.cos(pitch)
  const back = d * Math.sin(pitch)                   // 地面上での後退量
  const [cx, cy] = lonLatToLocal(cam.centre, origin)
  return [cx - back * Math.sin(bearing), cy - back * Math.cos(bearing), up]
}

/**
 * 画面に入っている範囲をローカル ENU の矩形で返す [minE, minN, maxE, maxN]。
 *
 * 厳密な視錐台ではなく、地図の可視 bbox の外接矩形。
 * **これが無いと、視野から外れたノードが `wanted` に残り続け、
 * キャンセルが原理的に発火しない**（docs/web_results.md「キャンセル」）。
 * 傾けた視野は台形なので外接矩形は広めに出るが、
 * 「不要になったものを落とす」目的には十分で、落としすぎるより安全。
 */
export function visibleBoxLocal(
  boundsLonLat: [number, number, number, number], origin: LocalOrigin, marginM = 0,
): [number, number, number, number] {
  const [w, s, e, n] = boundsLonLat
  const [minE, minN] = lonLatToLocal([w, s], origin)
  const [maxE, maxN] = lonLatToLocal([e, n], origin)
  return [
    Math.min(minE, maxE) - marginM, Math.min(minN, maxN) - marginM,
    Math.max(minE, maxE) + marginM, Math.max(minN, maxN) + marginM,
  ]
}

/**
 * 画面に入っている範囲を**ローカル ENU の凸多角形**で返す。
 *
 * `visibleBoxLocal` はこの多角形の外接矩形で、傾けた視野では実際の 2 倍近い
 * 面積を「見えている」と答える（台形を軸並行矩形で包むため）。
 * 落としすぎるより安全な側ではあるが、細い回線では取りすぎが効く。
 *
 * 4 点の凸包を取るのは、視点が寝ているときに描画側が隅を個別に丸めることがあり、
 * **凸とは限らない 4 点**が来るため。凸包は元の四角形を含むので、
 * 判定は必ず「広めに残る」側に倒れる。
 */
export function visiblePolygonLocal(
  cornersLonLat: readonly (readonly [number, number])[], origin: LocalOrigin,
): [number, number][] {
  const pts = cornersLonLat.map((c) => lonLatToLocal([c[0], c[1]], origin))
  return convexHull(pts)
}

/** 凸包（Andrew's monotone chain）。点数は 4 なので素直に書く */
function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src: [number, number][]) => {
    const out: [number, number][] = []
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

/**
 * 軸並行矩形と凸多角形が重なるか（分離軸判定）。
 * `marginM` は矩形を外側へ広げる量。**多角形ではなく矩形を広げる**ほうが、
 * 「多角形から m 以内」を素直に表せる。
 */
export function boxIntersectsPolygon(
  box: readonly [number, number, number, number],
  poly: readonly (readonly [number, number])[],
  marginM = 0,
): boolean {
  if (poly.length < 3) return true          // 多角形が作れなければ落とさない
  const b: [number, number, number, number] = [
    box[0] - marginM, box[1] - marginM, box[2] + marginM, box[3] + marginM,
  ]
  const corners: [number, number][] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
  // 軸並行矩形の法線 = x 軸と y 軸
  let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity
  for (const q of poly) {
    if (q[0] < pMinX) pMinX = q[0]
    if (q[0] > pMaxX) pMaxX = q[0]
    if (q[1] < pMinY) pMinY = q[1]
    if (q[1] > pMaxY) pMaxY = q[1]
  }
  if (pMaxX < b[0] || pMinX > b[2] || pMaxY < b[1] || pMinY > b[3]) return false
  // 多角形の各辺の法線
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const c = poly[(i + 1) % poly.length]!
    const nx = -(c[1] - a[1])
    const ny = c[0] - a[0]
    if (nx === 0 && ny === 0) continue
    let aMin = Infinity, aMax = -Infinity
    for (const q of poly) {
      const v = q[0] * nx + q[1] * ny
      if (v < aMin) aMin = v
      if (v > aMax) aMax = v
    }
    let bMin = Infinity, bMax = -Infinity
    for (const q of corners) {
      const v = q[0] * nx + q[1] * ny
      if (v < bMin) bMin = v
      if (v > bMax) bMax = v
    }
    if (aMax < bMin || bMax < aMin) return false
  }
  return true
}

/** 2 つの軸並行矩形が重なるか。[minX, minY, maxX, maxY] */
export function boxesOverlap(
  a: [number, number, number, number], b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}
