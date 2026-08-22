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
