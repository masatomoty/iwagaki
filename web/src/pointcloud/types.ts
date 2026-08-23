export type NodeKey = string   // 'd-x-y-z'

export interface PcNode {
  key: NodeKey
  depth: number
  pointCount: number
  byteOffset: number
  byteLength: number
  /** EPSG:6674 の AABB [minx, miny, minz, maxx, maxy, maxz] */
  bounds: [number, number, number, number, number, number]
}

export interface PcInfo {
  cube: [number, number, number, number, number, number]
  spacing: number
  pointCount: number
  pointDataRecordFormat: number
  pointDataRecordLength: number
}

export interface ViewState {
  /** AOI ローカル(メートル)でのカメラ位置 */
  eye: [number, number, number]
  /** 画面高さ [px] */
  viewportHeight: number
  fovY: number
  /**
   * 正射投影か。**SSE の式が変わる。**
   * 透視は距離で割るが、正射は 1 px が何メートルかが画面中どこでも同じなので
   * 距離に依らない（`pointcloud/lod.ts`）
   */
  orthographic?: boolean
  /** 画面中心 1 px が何メートルか。正射の SSE に使う */
  metresPerPixel?: number
  /**
   * 画面に入っている範囲 [minE, minN, maxE, maxN]（ローカル メートル）。
   * これを渡さないと視野外のノードが `wanted` に残り続け、
   * キャンセルが原理的に発火しない（docs/web_results.md「キャンセル」）。
   *
   * `visiblePoly` があるならそちらを使う。これは外接矩形なので、
   * 傾けた視野では実際より広く出る
   */
  visible?: [number, number, number, number]
  /**
   * 同じものを**凸多角形**で持ったもの（ローカル メートル）。
   * 地面に落とした視錐台そのものなので、傾けた視野で外接矩形より締まる。
   */
  visiblePoly?: [number, number][]
  /** 視野の外へどれだけ余裕を持たせるか [m]。判定はノード側の箱を広げて行う */
  visibleMarginM?: number
}

export interface LodBudget {
  maxPoints: number
  maxBytes: number
  screenSpaceError: number
  coarseDepth: number
}

export interface NodeRequest {
  key: NodeKey
  byteRange: [number, number]   // [begin, end) 
  pointCount: number
  depth: number
  sse: number
  coarse: boolean
}

export interface DecodedChunk {
  key: NodeKey
  /** AOI ローカル原点からの [east, north, up]。up は z_TP + geoid */
  positions: Float32Array
  pointCount: number
  decodeMs: number
  /** 色付けに使う標高 (T.P.) */
  elevations: Float32Array
  colors: Uint8Array
}
