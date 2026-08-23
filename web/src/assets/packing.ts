// RGBA タイルのデコード（docs/web_design.md「RGBA タイルのパッキング」）。
// GLSL 側（view/floodMeshLayer.ts）と同じ式。両者の一致は test/parity で検証する。

export const ELEV_BIAS = 32768

export function decodeElev(r: number, g: number, b: number): number {
  if (r === 0 && g === 0 && b === 0) return NaN     // nodata は R=G=B=0 を予約
  return r * 256 + g + b / 256 - ELEV_BIAS
}

export function decodeHConn(a: number, hStep: number): number {
  return a === 0 ? Infinity : (a - 1) * hStep       // A==0 はどの水位でも浸水しない
}

/**
 * premultiplyAlpha を必ず切る。
 * 既定のままだと A<255 の画素で RGB が壊れ、標高が静かに狂う（絵を見ても気づけない）。
 */
export async function decodeTileImage(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: 'image/png' })
  return createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}
