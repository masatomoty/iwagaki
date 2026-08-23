// PLATEAU 3D Tiles の three.js 版。@deck.gl/geo-layers Tile3DLayer の置き換え。
// b3dm のパースには @loaders.gl/3d-tiles をそのまま使うので、この module ごと遅延読み込みする。
//
// deck 版から変わった点が 2 つある。どちらも「luma.gl v9 の pbr の都合」が消えたため:
//
//  1. **primitive を色ごとに分割しない。**
//     luma の pbr は HAS_COLORS を立てても頂点色を読まず baseColorFactor しか見ないので、
//     deck 版は棟ごとの色を出すために primitive を分割していた（= draw call が色数だけ増える）。
//     three では自前のシェーダなので `_BATCHID` から頂点色を作れば 1 primitive で済む。
//  2. **tileset の traversal を持たない。**
//     この tileset は 22 タイルで AOI と同じ広さしかない。loaders.gl の Tileset3D は
//     自前の RequestScheduler を抱えていて choke point が二重になるので、
//     tileset.json を自分で歩いて、視野に交わるタイルだけ Scheduler に投げる。
//
// `_BATCHID` は size:1 の属性として来る（loaders.gl が CUSTOM_ATTRIBUTE_2 に改名する）。
// 色を作るのに使ったあとは three の BufferGeometry には載せない。

import { parse } from '@loaders.gl/core'
import { Tiles3DLoader } from '@loaders.gl/3d-tiles'
import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, Group, Mesh, ShaderMaterial,
} from 'three'

import type { Scheduler } from '../net/scheduler'
import { hexToRgb, UNKNOWN_HEX, type ColorScheme, type Rgb } from '../view/buildingColor'
import { createEcefFrame, ecefToLocal, type EcefFrame, type LocalFrame } from './mercator'
import type { Viewer } from './viewer'

const UNKNOWN_RGB = hexToRgb(UNKNOWN_HEX)

const VS = /* glsl */ `
in vec3 aColor;
out vec3 vColor;
out vec3 vNormal;
void main() {
  vColor = aColor;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const FS = /* glsl */ `
precision highp float;
in vec3 vColor;
in vec3 vNormal;
out vec4 fragColor;
uniform float uOpacity;
void main() {
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(vec3(-0.4, 0.5, 0.75));
  float shade = clamp(0.55 + 0.55 * abs(dot(n, sun)), 0.35, 1.25);
  fragColor = vec4(vColor * shade, uOpacity);
}
`

export interface PlateauStats {
  tiles: number
  primitives: number
  coloured: number
  buildings: number
}

export interface PlateauOptions {
  url: string
  scheduler: Scheduler
  viewer: Viewer
  frame: LocalFrame
  geoid: number
  scheme?: ColorScheme
  /** gml_id -> 属性値。凡例の数え上げ用 */
  onValues: (values: [string, string][]) => void
  /** 現在の視野に必要なタイルが揃った瞬間 */
  onLoaded: () => void
  onError: (tile: string, e: unknown) => void
}

interface TileRef {
  /** tileset.json からの相対 URL を解決したもの */
  url: string
  /** [west, south, east, north] ラジアン -> 度に直したもの */
  bbox: [number, number, number, number]
  state: 'idle' | 'loading' | 'ready' | 'failed'
  group?: Group
}

/** region は [west, south, east, north, minH, maxH]（ラジアン） */
function regionToBbox(r: number[]): [number, number, number, number] {
  const d = (x: number) => (x * 180) / Math.PI
  return [d(r[0]), d(r[1]), d(r[2]), d(r[3])]
}

function collectTiles(node: unknown, baseUrl: string, out: TileRef[]) {
  const n = node as {
    boundingVolume?: { region?: number[] }
    content?: { uri?: string; url?: string }
    children?: unknown[]
  }
  if (!n) return
  const uri = n.content?.uri ?? n.content?.url
  if (uri && n.boundingVolume?.region) {
    out.push({
      url: new URL(uri, baseUrl).href,
      bbox: regionToBbox(n.boundingVolume.region),
      state: 'idle',
    })
  }
  for (const c of n.children ?? []) collectTiles(c, baseUrl, out)
}

export class PlateauTiles {
  readonly group = new Group()
  private tiles: TileRef[] = []
  private material: ShaderMaterial
  private stat: PlateauStats = { tiles: 0, primitives: 0, coloured: 0, buildings: 0 }
  private firedLoaded = false
  private ecef: EcefFrame

  constructor(private readonly o: PlateauOptions) {
    this.ecef = createEcefFrame(o.frame.centre[0], o.frame.centre[1])
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VS,
      fragmentShader: FS,
      side: DoubleSide,
      transparent: false,
      uniforms: { uOpacity: { value: 1 } },
    })
  }

  setVisible(v: boolean) {
    this.group.visible = v
    this.o.viewer.invalidate()
  }

  stats(): PlateauStats { return this.stat }

  async open() {
    const bytes = await this.o.scheduler.submit({
      key: this.o.url, url: this.o.url, cls: 'plateau',
    })
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { root?: unknown }
    this.tiles = []
    collectTiles(json.root, new URL(this.o.url, location.href).href, this.tiles)
  }

  /** 視野に交わる未取得タイルを要求する。カメラが動いたら呼ぶ */
  update() {
    if (!this.group.visible) return
    const view = this.o.viewer.getBoundsLngLat()
    let pending = 0
    for (const t of this.tiles) {
      const hit = !(t.bbox[2] < view[0] || t.bbox[0] > view[2] ||
                    t.bbox[3] < view[1] || t.bbox[1] > view[3])
      if (!hit) continue
      if (t.state === 'idle') { t.state = 'loading'; void this.load(t) }
      if (t.state === 'loading') pending++
    }
    if (pending === 0 && !this.firedLoaded && this.stat.tiles > 0) {
      this.firedLoaded = true
      this.o.onLoaded()
    }
  }

  private async load(t: TileRef) {
    try {
      const bytes = await this.o.scheduler.submit({ key: t.url, url: t.url, cls: 'plateau' })
      const content = await parse(
        // parse は ArrayBuffer を取る。Uint8Array の view をそのまま渡すと
        // byteOffset を無視して先頭から読まれることがあるので、範囲を切り出す
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        Tiles3DLoader,
        { '3d-tiles': { loadGLTF: true }, gltf: { postProcess: true } } as never,
      ) as {
        gltf?: { meshes?: { primitives?: unknown[] }[] }
        batchTableJson?: Record<string, unknown>
        rtcCenter?: number[]
        rotateYtoZ?: boolean
      }
      this.build(t, content)
      t.state = 'ready'
      this.stat.tiles++
      this.o.viewer.invalidate()
      this.update()
    } catch (e) {
      t.state = 'failed'
      this.o.onError(t.url, e)
      this.update()
    }
  }

  private build(t: TileRef, content: {
    gltf?: { meshes?: { primitives?: unknown[] }[] }
    batchTableJson?: Record<string, unknown>
    rtcCenter?: number[]
    rotateYtoZ?: boolean
  }) {
    const meshes = content.gltf?.meshes
    if (!Array.isArray(meshes)) return

    // 棟 -> 色。batchTableJson は JSON 配列で入っている（bldg:class / bldg:usage は実測済み）
    const bt = content.batchTableJson
    const ids = Array.isArray(bt?.gml_id) ? (bt!.gml_id as unknown[]) : undefined
    const attr = this.o.scheme && Array.isArray(bt?.[this.o.scheme.attribute])
      ? (bt![this.o.scheme.attribute] as unknown[]) : undefined
    const byBatch: Rgb[] = attr
      ? attr.map((v) => this.o.scheme!.colorOf(v) ?? UNKNOWN_RGB)
      : []
    if (ids && attr) {
      this.stat.buildings += ids.length
      this.stat.coloured += attr.filter((v) => this.o.scheme!.colorOf(v) != null).length
      this.o.onValues(ids.map((id, i) => [String(id), attr[i] == null ? '' : String(attr[i])]))
    }

    // 頂点は rtcCenter（ECEF）からの ECEF オフセット。ワールドへは
    // ECEF -> ENU の 1 回の線形変換で足りるので、読み込み時に CPU で焼いてしまう。
    // 毎フレームの行列合成より単純で、視錐台カリングも普通に効く。
    const rtc = content.rtcCenter ?? [0, 0, 0]
    // glTF は Y-up、3D Tiles は Z-up。loaders.gl は変換せず rotateYtoZ を立てて渡してくる。
    // 実測で確認: 回転を掛けると up が 33〜84 m（tileset の region が宣言する 37.25〜79.26 m
    // と一致）、掛けないと ±4,900 m になって壊れる。
    const rot = content.rotateYtoZ !== false
    const g = new Group()

    for (const mesh of meshes) {
      for (const prim of mesh.primitives ?? []) {
        const p = prim as {
          attributes?: Record<string, { value?: ArrayLike<number>; size?: number }>
          indices?: { value?: ArrayLike<number> }
          mode?: number
        }
        const attrs = p.attributes ?? {}
        const pos = attrs.POSITION?.value
        if (!pos) continue
        if (p.mode !== undefined && p.mode !== 4) continue      // TRIANGLES 以外は描かない

        const n = pos.length / 3
        const local = new Float32Array(n * 3)
        for (let i = 0; i < n; i++) {
          const a = pos[i * 3], b = pos[i * 3 + 1], c = pos[i * 3 + 2]
          const px = a
          const py = rot ? -c : b
          const pz = rot ? b : c
          const [e, no, u] = ecefToLocal(this.ecef, rtc[0] + px, rtc[1] + py, rtc[2] + pz)
          local[i * 3] = e
          local[i * 3 + 1] = no
          local[i * 3 + 2] = u
        }

        const geom = new BufferGeometry()
        geom.setAttribute('position', new BufferAttribute(local, 3))
        // 法線も同じ回転を掛ける（平行移動は掛けない）
        const nrm = attrs.NORMAL?.value
        if (nrm) {
          const ln = new Float32Array(nrm.length)
          const r = this.ecef.rows
          for (let i = 0; i < nrm.length; i += 3) {
            const a0 = nrm[i], b0 = nrm[i + 1], c0 = nrm[i + 2]
            // 頂点と同じ Y-up -> Z-up を先に掛ける（平行移動は掛けない）
            const a = a0
            const b = rot ? -c0 : b0
            const c = rot ? b0 : c0
            ln[i] = r[0] * a + r[1] * b + r[2] * c
            ln[i + 1] = r[3] * a + r[4] * b + r[5] * c
            ln[i + 2] = r[6] * a + r[7] * b + r[8] * c
          }
          geom.setAttribute('normal', new BufferAttribute(ln, 3))
        }
        if (p.indices?.value) {
          const idx = p.indices.value
          const arr = n > 65535 ? new Uint32Array(idx.length) : new Uint16Array(idx.length)
          for (let i = 0; i < idx.length; i++) arr[i] = idx[i]
          geom.setIndex(new BufferAttribute(arr, 1))
        }

        // 頂点色。deck 版はここで primitive を分割していたが、three では不要
        const colors = new Float32Array(n * 3)
        const batchName = Object.keys(attrs).find((k) => attrs[k]?.size === 1 && attrs[k]?.value)
        const batch = batchName ? attrs[batchName]!.value : undefined
        for (let v = 0; v < n; v++) {
          const c = batch && byBatch.length ? (byBatch[batch[v]] ?? UNKNOWN_RGB) : UNKNOWN_RGB
          colors[v * 3] = c[0] / 255
          colors[v * 3 + 1] = c[1] / 255
          colors[v * 3 + 2] = c[2] / 255
        }
        geom.setAttribute('aColor', new BufferAttribute(colors, 3))
        if (!nrm) geom.computeVertexNormals()
        geom.computeBoundingSphere()

        g.add(new Mesh(geom, this.material))
        this.stat.primitives++
      }
    }
    t.group = g
    this.group.add(g)
  }

  dispose() {
    for (const t of this.tiles) {
      if (!t.group) continue
      t.group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose()
      })
      this.group.remove(t.group)
    }
    this.material.dispose()
    this.tiles = []
  }
}
