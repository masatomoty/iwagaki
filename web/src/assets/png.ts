// 8bit RGBA / 非インタレースの PNG を、canvas を通さずに復号する。
//
// **canvas を経由してはいけない。** タイルは RGB に標高、A に h_conn コードを
// 詰めている（docs/WEB_DESIGN.md「RGBA タイルのパッキング」）。2D canvas はアルファ乗算した状態で
// 画素を保持するので、`drawImage` → `getImageData` の往復で **A < 255 の画素の
// RGB が壊れる**。h_conn コードはほぼ常に 255 未満なので、ほぼ全画素が壊れる。
// 実際、標高 1.5 m のはずの画素が 1536 m や 32512 m として読めた。
//
// `createImageBitmap(..., {premultiplyAlpha:'none'})` で作った ImageBitmap でも、
// canvas に描いた時点で同じことが起きる。**GPU に上げて描く分には問題ない**
// （テクスチャは非乗算のまま渡せる）ので、壊れるのは CPU 側で読み戻す経路だけ。
//
// 展開はブラウザ内蔵の `DecompressionStream('deflate')` を使う。依存は増やさない。

export interface Rgba8 { width: number; height: number; data: Uint8Array }

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export async function decodeRgba8(bytes: Uint8Array): Promise<Rgba8> {
  for (let i = 0; i < SIG.length; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('PNG ではない')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Uint8Array[] = []

  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const body = off + 8
    if (type === 'IHDR') {
      width = dv.getUint32(body)
      height = dv.getUint32(body + 4)
      bitDepth = bytes[body + 8]
      colorType = bytes[body + 9]
      interlace = bytes[body + 12]
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(body, body + len))
    } else if (type === 'IEND') {
      break
    }
    off = body + len + 4      // データ + CRC
  }

  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} は未対応`)
  if (interlace !== 0) throw new Error('インタレース PNG は未対応')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`colorType ${colorType} は未対応`)

  // IDAT を連結して zlib 展開
  let total = 0
  for (const c of idat) total += c.length
  const z = new Uint8Array(total)
  let at = 0
  for (const c of idat) { z.set(c, at); at += c.length }
  const raw = new Uint8Array(await new Response(
    new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer())

  // スキャンラインのフィルタを外す（PNG 仕様 9.2）
  const bpp = channels
  const stride = width * bpp
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    cur.set(raw.subarray(src, src + stride))
    src += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = cur[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    // RGBA へ詰め替え（RGB のときは A=255）
    const dst = y * width * 4
    if (channels === 4) {
      out.set(cur, dst)
    } else {
      for (let x = 0; x < width; x++) {
        out[dst + x * 4] = cur[x * 3]
        out[dst + x * 4 + 1] = cur[x * 3 + 1]
        out[dst + x * 4 + 2] = cur[x * 3 + 2]
        out[dst + x * 4 + 3] = 255
      }
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}
