// PLATEAU 3D Tiles。@loaders.gl/3d-tiles は重いので、この module ごと遅延読み込みする
// （first_meaningful_render を JS バンドルで押し出さないため: docs/WEB_DESIGN.md §9.3）。

import { Tile3DLayer } from '@deck.gl/geo-layers'
import { Tiles3DLoader } from '@loaders.gl/3d-tiles'

import type { Scheduler } from '../net/scheduler'
import { hexToRgb, UNKNOWN_HEX, type ColorScheme, type Rgb } from './buildingColor'

/**
 * PLATEAU の b3dm は `_BATCHID`（SCALAR / UNSIGNED_BYTE）を持っている。
 * luma.gl v9 は WebGPU の頂点フォーマットに落とすので 8bit スカラーを表現できず、
 * `size: 1` で ScenegraphLayer の初期化が落ちる = **その建物が描かれない**。
 *
 * loaders.gl の後処理で `_BATCHID` は `CUSTOM_ATTRIBUTE_2` に改名されるため、
 * 名前ではなく「スカラー属性」で落とす。POSITION / NORMAL / TEXCOORD / COLOR は
 * どれも 2 要素以上なので、size === 1 を消しても描画に必要なものは失われない。
 * 我々は地物の選択を GeoJSON 側でやっていて _BATCHID を使わない。
 */
function stripScalarAttributes(gltf: unknown): number {
  let removed = 0
  const meshes = (gltf as { meshes?: unknown[] })?.meshes
  if (!Array.isArray(meshes)) return 0
  for (const m of meshes) {
    for (const prim of (m as { primitives?: unknown[] }).primitives ?? []) {
      const attrs = (prim as { attributes?: Record<string, { size?: number }> }).attributes
      if (!attrs) continue
      for (const [k, v] of Object.entries(attrs)) {
        if (v?.size === 1) { delete attrs[k]; removed++ }
      }
    }
  }
  return removed
}

// ---- 属性による塗り分け ----------------------------------------------------
//
// b3dm に色は入っていない（materials は roughness=metallic=0 だけ、texture も
// COLOR_0 も baseColorFactor も無い）。色を与える手段は 3 つあり、使えるのは 3 番目だけ:
//
//   1. COLOR_0 を注入する → luma.gl v9 の pbr は HAS_COLORS define を立てるだけで
//      シェーダ本体が頂点色を読まない（baseColorFactor uniform しか見ない）。効かない。
//   2. Tile3DLayer の _getMeshColor → タイル単位、かつ SimpleMesh 経路（i3s）専用。
//      1 タイルに 17 棟入っているので棟ごとに塗れない。
//   3. primitive を色ごとに分割して material を与える → これを採る。
//
// 属性値は batchTableJson から取る。`_BATCHID`（頂点 -> 棟）と batch table の
// 並びは同じ添字なので、頂点から属性値を引ける。同じ色になる棟はまとめて 1 primitive
// にするので、draw call は「そのタイルに出現した色数」までしか増えない。

type Accessor = {
  value: { [i: number]: number; length: number; constructor: unknown }
  size?: number
  count?: number
  min?: number[]
  max?: number[]
}
type Primitive = {
  attributes: Record<string, Accessor | undefined>
  indices?: Accessor
  material?: { id?: string; pbrMetallicRoughness?: Record<string, unknown> }
  mode?: number
}
type Gltf = { meshes?: { primitives?: Primitive[] }[]; materials?: unknown[] }

const UNKNOWN_RGB = hexToRgb(UNKNOWN_HEX)
const TRIANGLES = 4

/**
 * sRGB -> linear。pbr シェーダは最後に pow(color, 1/2.2) を掛けて出すので、
 * baseColorFactor には linear で渡さないとパレットより明るく出る。
 * 変換の指数はシェーダ側の SRGBtoLINEAR（2.2 の近似）に合わせる。
 */
function toLinear(c: Rgb): [number, number, number, number] {
  const f = (v: number) => (v / 255) ** 2.2
  return [f(c[0]), f(c[1]), f(c[2]), 1]
}

function materialFor(gltf: Gltf, base: Primitive['material'], colour: Rgb) {
  const id = `iwagaki-${colour.join('-')}`
  const materials = (gltf.materials ??= [])
  const found = materials.find((m) => (m as { id?: string }).id === id)
  if (found) return found as Primitive['material']
  const mat = {
    ...(base ?? {}),
    id,
    name: id,
    pbrMetallicRoughness: {
      ...(base?.pbrMetallicRoughness ?? {}),
      baseColorFactor: toLinear(colour),
    },
  }
  materials.push(mat)
  return mat
}

/** 頂点を詰め直した accessor を作る。頂点は必ず 1 棟にしか属さないので複製は増えない */
function compact(a: Accessor, verts: number[]): Accessor {
  const size = a.size ?? 3
  const Ctor = a.value.constructor as new (n: number) => Accessor['value']
  const out = new Ctor(verts.length * size)
  for (let i = 0; i < verts.length; i++) {
    const src = verts[i] * size
    for (let k = 0; k < size; k++) out[i * size + k] = a.value[src + k]
  }
  const next: Accessor = { ...a, value: out, count: verts.length }
  if (a.min && a.max && size === 3) {
    // POSITION の min/max は ScenegraphLayer が node の bounds に使う。詰め直したら取り直す
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < out.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], out[i + k])
        max[k] = Math.max(max[k], out[i + k])
      }
    }
    next.min = min
    next.max = max
  }
  return next
}

export interface ColorizeResult {
  /** この b3dm に含まれる建物のうち、属性値があった棟数 */
  coloured: number
  buildings: number
  /** 分割後の primitive 数（= このタイルの draw call 数） */
  primitives: number
  /** gml_id -> 属性値（空なら ''）。凡例の数え上げ用。複数タイルの重複は呼び出し側で潰す */
  values: [string, string][]
}

/**
 * 1 タイルを属性色で塗る。glTF を直接書き換える（deck.gl に渡る前）。
 * 属性値が無い / パレットに無い値の棟は「属性なし」のグレーにする。
 */
export function colorizeTile(content: unknown, scheme: ColorScheme): ColorizeResult {
  const c = content as { batchTableJson?: Record<string, unknown>; gltf?: Gltf }
  const bt = c?.batchTableJson
  const ids = bt?.gml_id
  const attr = bt?.[scheme.attribute]
  const meshes = c?.gltf?.meshes
  const out: ColorizeResult = { coloured: 0, buildings: 0, primitives: 0, values: [] }
  // 属性が binary body 側（byteOffset 参照）に入っている型では塗らない。
  // bldg:class / bldg:usage は JSON 配列で入っている（実測）
  if (!Array.isArray(ids) || !Array.isArray(attr) || !Array.isArray(meshes)) return out

  const byBatch: (Rgb | undefined)[] = attr.map((v) => scheme.colorOf(v))
  out.buildings = ids.length
  out.coloured = byBatch.filter(Boolean).length
  out.values = ids.map((id, i) => [String(id), attr[i] == null ? '' : String(attr[i])])

  for (const mesh of meshes) {
    const next: Primitive[] = []
    for (const prim of mesh.primitives ?? []) {
      const attrs = prim.attributes ?? {}
      const batchName = Object.keys(attrs).find((k) => attrs[k]?.size === 1 && attrs[k]?.value)
      const batch = batchName ? attrs[batchName]!.value : undefined
      if (!batch || (prim.mode !== undefined && prim.mode !== TRIANGLES)) {
        next.push(prim)                     // 三角形でない / batch が無いものは触らない
        continue
      }
      const idx = prim.indices?.value
      const nTri = Math.floor((idx ? idx.length : batch.length) / 3)

      interface Group { colour: Rgb; remap: Map<number, number>; verts: number[]; idx: number[] }
      const groups = new Map<string, Group>()
      for (let t = 0; t < nTri; t++) {
        const v = [0, 1, 2].map((k) => (idx ? idx[t * 3 + k] : t * 3 + k))
        const colour = byBatch[batch[v[0]]] ?? UNKNOWN_RGB
        const key = colour.join(',')
        let g = groups.get(key)
        if (!g) groups.set(key, g = { colour, remap: new Map(), verts: [], idx: [] })
        for (const vi of v) {
          let local = g.remap.get(vi)
          if (local === undefined) {
            local = g.verts.length
            g.remap.set(vi, local)
            g.verts.push(vi)
          }
          g.idx.push(local)
        }
      }

      // 単色のタイルは幾何を触らない（material だけ差し替える）
      if (groups.size === 1) {
        const [g] = [...groups.values()]
        next.push({ ...prim, material: materialFor(c.gltf!, prim.material, g.colour) })
        continue
      }
      for (const g of groups.values()) {
        const attributes: Record<string, Accessor> = {}
        for (const [name, a] of Object.entries(attrs)) {
          if (!a?.value || a.size === 1) continue   // _BATCHID は落とす（上のコメント参照）
          attributes[name] = compact(a, g.verts)
        }
        const IdxCtor = g.verts.length > 65535 ? Uint32Array : Uint16Array
        next.push({
          ...prim,
          attributes,
          indices: { value: new IdxCtor(g.idx), size: 1, count: g.idx.length },
          material: materialFor(c.gltf!, prim.material, g.colour),
        })
      }
    }
    mesh.primitives = next
    out.primitives += next.length
  }
  return out
}

/** 塗り分け無しのときも primitive 数は数える（増分を比べられるようにするため） */
function countPrimitives(gltf: unknown): number {
  const meshes = (gltf as Gltf)?.meshes
  if (!Array.isArray(meshes)) return 0
  return meshes.reduce((n, m) => n + (m.primitives?.length ?? 0), 0)
}

export interface PlateauOptions {
  /** 色分けを切り替えたら別 id にする。deck.gl に作り直させるため */
  id: string
  url: string
  scheduler: Scheduler
  /** 属性 -> 色。省略すると b3dm のまま（= グレー） */
  scheme?: ColorScheme
  onTileLoad: (r: ColorizeResult) => void
  /** 現在の視野に必要なタイルが揃った瞬間。全タイルの取得完了ではない */
  onViewportLoaded: () => void
  onTileError: (t: unknown, e: unknown) => void
  /** 診断用。tileset の内部状態を外から見られるようにする（perf/plateauprobe.mjs） */
  onTileset?: (ts: unknown) => void
}

export function createPlateauLayer(o: PlateauOptions) {
  let tileset: { isLoaded?: () => boolean } | undefined
  return new Tile3DLayer({
    id: o.id,
    data: o.url,
    loader: Tiles3DLoader,
    loadOptions: {
      // loaders.gl 側の RequestScheduler を止めて、絞りを Scheduler に一本化する
      tileset: { throttleRequests: false, maxRequests: 0 },
      fetch: async (url: string, opts?: { signal?: AbortSignal }) => {
        const bytes = await o.scheduler.submit({
          key: url, url, cls: 'plateau', signal: opts?.signal,
        })
        const res = new Response(bytes as unknown as BodyInit, {
          headers: {
            'content-type': url.endsWith('.json')
              ? 'application/json' : 'application/octet-stream',
          },
        })
        // loaders.gl は response.url で loader を選ぶ。手で作った Response は url が
        // 空になり、tileset.json が b3dm として解釈されてしまう
        Object.defineProperty(res, 'url', { value: url })
        return res
      },
    },
    onTilesetLoad: (ts: unknown) => {
      tileset = ts as { isLoaded?: () => boolean }
      o.onTileset?.(ts)
    },
    onTileLoad: (tile: unknown) => {
      const content = (tile as { content?: { gltf?: unknown } })?.content
      let r: ColorizeResult = { coloured: 0, buildings: 0, primitives: 0, values: [] }
      if (content?.gltf) {
        if (o.scheme) r = colorizeTile(content, o.scheme)
        else r.primitives = countPrimitives(content.gltf)
        stripScalarAttributes(content.gltf)
      }
      o.onTileLoad(r)
      // 「全 22 タイルの取得完了」を待つと、視野外のタイルが読まれるまで
      // 立たない指標になる（実測で 49 秒かかった）。視野が満たされた時点にする。
      //
      // ここで一度だけ見るのでは足りない。**最後のタイルの onTileLoad の時点では
      // tileset.isLoaded() がまだ false** で、その後に更新される。以降タイルは
      // 読まれないので、同期チェックだけだと指標が永久に立たない（実測: 9/22 で
      // time_to_plateau が None のまま）。次フレームでもう一度見る。
      const check = () => { if (tileset?.isLoaded?.()) o.onViewportLoaded() }
      check()
      requestAnimationFrame(check)
    },
    onTileError: o.onTileError,
    pickable: false,
    opacity: 1,
  })
}
