// 地図のカメラを「AOI ローカル(メートル, ENU)」に直す。純関数。
// maplibre-gl / deck.gl / three.js を import しない（docs/WEB_DESIGN.md「層の分け方」）。
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
// 「近くは細かく遠くは粗く」が効いていなかった（docs/WEB_RESULTS.md「キャンセル」）。

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

/** Web メルカトルの 1 CSS ピクセルあたりの距離 [m]（タイルサイズ 512 の maplibre 系） */
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
 * キャンセルが原理的に発火しない**（docs/WEB_RESULTS.md「キャンセル」）。
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

/** 2 つの軸並行矩形が重なるか。[minX, minY, maxX, maxY] */
export function boxesOverlap(
  a: [number, number, number, number], b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}
