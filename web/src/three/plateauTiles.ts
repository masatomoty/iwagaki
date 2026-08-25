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
// Draco の実体を**自分のオリジンから**配る。既定では loaders.gl が
// unpkg.com と www.gstatic.com から取りに行く（DRACO_LOCAL 参照）。
// `?url` なので中身はバンドルに入らず、内容ハッシュ付きで dist/assets に出る
// （= `_headers` の `/assets/*` で immutable になる）。
import dracoWorkerUrl from '@loaders.gl/draco/draco-worker.js?url'
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, GLSL3, Group, Mesh, ShaderMaterial,
} from 'three'

import type { Scheduler } from '../net/scheduler'
import type { FeatureAssertion, TerrainCondition } from '../domain/types'
import {
  DEPTH_HEX, hexToRgb, UNKNOWN_HEX, type ColorScheme, type Rgb,
} from '../view/buildingColor'
import { createEcefFrame, ecefToLocal, type EcefFrame, type LocalFrame } from './mercator'
import type { Viewer } from './viewer'

const UNKNOWN_RGB = hexToRgb(UNKNOWN_HEX)

/**
 * Draco を外部 CDN から取らせないための設定。**PLATEAU の b3dm は 44 枚すべて
 * `KHR_draco_mesh_compression` 付き**なので、Draco は必須である（一時期
 * `docs/todo.md` に「発火しない」と書いていたが誤り）。
 *
 * 既定のままだと cold load ごとに
 * `unpkg.com/@loaders.gl/draco/dist/draco-worker.js`（38 kB）と
 * `www.gstatic.com/draco/.../draco_decoder.wasm`（286 kB）+ `draco_wasm_wrapper.js`（59 kB）を
 * **worker 3 本ぶん、計 1.15 MB** 取りに行く。1 Mbps なら 9 秒分で、しかも
 * **クロスオリジンでは `transferSize` が 0 になるのでこちらの転送量計測に映らない**
 * （`docs/web_results.md`「Draco を毎回 unpkg と gstatic から取っていた」）。
 *
 * `useLocalLibraries` を立てないと `modules` を見てくれない
 * （loaders.gl の `getLoadableLibraryUrl` は http で始まる既定 URL をそのまま返す）。
 * URL は絶対化しておく。worker の中では blob URL が基準になるため。
 */
const abs = (u: string) => new URL(u, location.href).href
const DRACO_LOCAL = {
  useLocalLibraries: true,
  CDN: abs('vendor'),
  draco: { workerUrl: abs(dracoWorkerUrl) },
}

const VS = /* glsl */ `
in vec3 aColor;
in float aGround;
in float aHConn;
in float aHas;
out vec3 vColor;
out vec3 vNormal;
out float vGround;
out float vHConn;
out float vHas;
void main() {
  vColor = aColor;
  vGround = aGround;
  vHConn = aHConn;
  vHas = aHas;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const FS = /* glsl */ `
precision highp float;
in vec3 vColor;
in vec3 vNormal;
in float vGround;
in float vHConn;
in float vHas;
out vec4 fragColor;
uniform float uOpacity;
uniform float uDepthMode;
uniform float uWaterLevel;
uniform float uFloorDepth;
uniform vec3 uDry;
uniform vec3 uPondedC;
uniform vec3 uUnder;
uniform vec3 uAbove;
uniform vec3 uUnknown;
uniform float uPonded;

/**
 * 床下 / 床上。**判定式は src/domain/flood.ts と同一**
 * （h_conn <= H で連結、depth = max(0, H - 地盤高) ）。
 * 潮位が変わっても uniform 1 個で済むので、b3dm の作り直しは起きない。
 */
vec3 depthColor() {
  if (vHas < 0.5) return uUnknown;               // 解析範囲外の棟（assertion が無い）
  if (vHConn > uWaterLevel) {
    // **窪地。** 海と連結して到達しないが、地盤高は潮位以下。
    // 判定式は domain/flood.ts の ponded() と同一で、
    // 地形の面（three/floodMaterial.ts の pondedFill）と同じ色を持つ
    return (uPonded > 0.5 && vGround < uWaterLevel) ? uPondedC : uDry;
  }
  float d = max(0.0, uWaterLevel - vGround);
  if (d <= 0.0) return uDry;
  return d >= uFloorDepth ? uAbove : uUnder;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(vec3(-0.4, 0.5, 0.75));
  float shade = clamp(0.55 + 0.55 * abs(dot(n, sun)), 0.35, 1.25);
  vec3 base = uDepthMode > 0.5 ? depthColor() : vColor;
  fragColor = vec4(base * shade, uOpacity);
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
  /**
   * 浸水深で塗るとき（`buildingColor: 'depth'`）に使う。
   * gml_id で assertion を引き、地盤高と h_conn を頂点属性に焼く。
   * **潮位はここに入らない**（uniform で渡す）ので、水位を動かしても作り直さない。
   */
  depthMode?: boolean
  /** 地盤高・h_conn をどの条件から取るか。**変わったら作り直しが必要** */
  condition?: TerrainCondition
  /** 床上とみなす浸水深 [m] */
  floorDepth?: number
  assertionOf?: (gmlId: string) => FeatureAssertion | undefined
  /** gml_id -> 属性値。凡例の数え上げ用。浸水深モードでは値が空文字で来る */
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
    // **色空間の変換は掛けない。** 頂点色 `aColor` は hexToRgb を 255 で割った
    // 生の値をそのまま渡していて、レンダラ側でも変換していない。ここで
    // convertSRGBToLinear を掛けると属性で塗った棟と浸水深で塗った棟の明るさが揃わない
    const rgb = (hex: string) => {
      const [r, g, b] = hexToRgb(hex)
      return new Color(r / 255, g / 255, b / 255)
    }
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VS,
      fragmentShader: FS,
      side: DoubleSide,
      transparent: false,
      uniforms: {
        uOpacity: { value: 1 },
        uDepthMode: { value: o.depthMode ? 1 : 0 },
        uWaterLevel: { value: 0 },
        uFloorDepth: { value: o.floorDepth ?? 0.5 },
        uDry: { value: rgb(DEPTH_HEX.dry) },
        uPondedC: { value: rgb(DEPTH_HEX.ponded) },
        uPonded: { value: 1 },
        uUnder: { value: rgb(DEPTH_HEX.under) },
        uAbove: { value: rgb(DEPTH_HEX.above) },
        uUnknown: { value: rgb(UNKNOWN_HEX) },
      },
    })
  }

  /**
   * 潮位。**浸水深モードでもタイルは作り直さない**（uniform を書き換えるだけ）。
   * 地形タイルの水位スライダと同じ性質で、`h_conn` を頂点属性に持っているから成り立つ。
   */
  setWaterLevel(h: number) {
    if (this.material.uniforms.uWaterLevel.value === h) return
    this.material.uniforms.uWaterLevel.value = h
    this.o.viewer.invalidate()
  }

  setVisible(v: boolean) {
    this.group.visible = v
    this.o.viewer.invalidate()
  }

  /** 窪地を別色で出すか（`state.layers.ponded`）。これも uniform 1 個 */
  setPonded(v: boolean) {
    const next = v ? 1 : 0
    if (this.material.uniforms.uPonded.value === next) return
    this.material.uniforms.uPonded.value = next
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
        { '3d-tiles': { loadGLTF: true }, gltf: { postProcess: true }, ...DRACO_LOCAL } as never,
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
    } else if (ids) {
      // 属性で塗っていないとき（none / depth）も、**どの棟が描かれたかは要る**。
      // 浸水深の凡例は「いま画面にある棟」を数えるので、gml_id だけ流す
      this.stat.buildings += ids.length
      this.o.onValues(ids.map((id) => [String(id), '']))
    }

    // 棟 -> 地盤高・h_conn。**assertion が無い棟（解析 AOI の外）は aHas = 0** で、
    // 「非浸水」ではなく「解析範囲外」として別の色にする。
    // 3D Tiles は AOI より広く 2,005 棟を持つので、これを混ぜてはいけない。
    const cond = this.o.condition ?? 'highres'
    const batchGround = new Float32Array(ids?.length ?? 0)
    const batchHConn = new Float32Array(ids?.length ?? 0)
    const batchHas = new Float32Array(ids?.length ?? 0)
    if (ids && this.o.assertionOf) {
      for (let i = 0; i < ids.length; i++) {
        const a = this.o.assertionOf(String(ids[i]))
        const g = a?.groundElev[cond]
        const h = a?.hConn[cond]
        // 橋梁・高架は地盤高が意味を持たない（unreliable）。色でも区別しない方が
        // 嘘が少ないので、解析範囲外と同じ扱いにする
        if (a && !a.unreliable && g !== undefined && Number.isFinite(g)) {
          batchGround[i] = g
          batchHConn[i] = h !== undefined && Number.isFinite(h) ? h : 1e9
          batchHas[i] = 1
        } else {
          batchHConn[i] = 1e9
        }
      }
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

        // 浸水深モード用。**水位は入れない**（uniform）ので、
        // 潮位を動かしてもここは作り直さない
        const ground = new Float32Array(n)
        const hconn = new Float32Array(n)
        const has = new Float32Array(n)
        for (let v = 0; v < n; v++) {
          const b = batch ? batch[v] : 0
          ground[v] = batchGround[b] ?? 0
          hconn[v] = batchHConn[b] ?? 1e9
          has[v] = batchHas[b] ?? 0
        }
        geom.setAttribute('aGround', new BufferAttribute(ground, 1))
        geom.setAttribute('aHConn', new BufferAttribute(hconn, 1))
        geom.setAttribute('aHas', new BufferAttribute(has, 1))
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
