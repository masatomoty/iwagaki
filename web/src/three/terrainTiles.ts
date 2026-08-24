// 地形タイルのピラミッド。@deck.gl/geo-layers TileLayer + view/floodTileLayer.ts の置き換え。
//
// TileLayer がやっていたのは (1) 可視タイルの決定 (2) 取得 (3) best-available の
// フォールバック描画 の 3 つ。(2) は元々 Scheduler に委ねていた（maxRequests: 0）ので、
// ここで書くのは (1) と (3) だけになる。
//
// choke point の規約は変えない: **このファイルは fetch を呼ばない**（docs/web_design.md §1）。

import { Group, Mesh, ShaderMaterial, type Texture } from 'three'

import { decodeTileImage } from '../assets/packing'
import type { Scheduler } from '../net/scheduler'
import type { RequestClass } from '../net/types'
import {
  applyFloodUniforms, createFloodMaterial, FLOOD_PASS, floodGeometry, makeTileTexture,
  type FloodUniformValues,
} from './floodMaterial'
import { lngLatToWorld, tileBoundsLngLat, tilesInBounds, type LocalFrame, type TileId } from './mercator'
import type { Viewer } from './viewer'

type Uniforms = Omit<FloodUniformValues, 'worldBounds' | 'metersPerTexel'>

export interface TerrainTilesOptions {
  viewer: Viewer
  frame: LocalFrame
  scheduler: Scheduler
  cls: RequestClass
  urlTemplate: string
  diffUrlTemplate?: string
  minZoom: number
  maxZoom: number
  /** [w, s, e, n]。AOI の外は要求しない */
  extent: [number, number, number, number]
  renderOrder: number
  onTileLoaded?: (z: number) => void
  /** そのズームの可視タイルが揃ったとき（deck.gl の onViewportLoad 相当） */
  onViewportLoad?: () => void
}

interface TileEntry {
  id: TileId
  mesh?: Mesh
  material?: ShaderMaterial
  /**
   * 水面。**同じジオメトリ・同じテクスチャを 2 枚目のメッシュで描く**
   * （`floodMaterial.ts` の FLOOD_PASS）。ネットワークは一切増えない
   */
  water?: Mesh
  waterMaterial?: ShaderMaterial
  elev?: Texture
  diff?: Texture
  state: 'loading' | 'ready' | 'failed'
  /** build() で埋める。ワールドメートルでのタイル境界 */
  worldBounds?: [number, number, number, number]
  metersPerTexel?: number
}

/** 常駐タイル数の上限。z18 で 1 枚 = 256KB テクスチャ × 2（diff 時）*/
const MAX_TILES = 160

const key = (t: TileId) => `${t.z}/${t.x}/${t.y}`

export class TerrainTiles {
  readonly group = new Group()
  private tiles = new Map<string, TileEntry>()
  private wanted = new Set<string>()
  private uniforms: Uniforms
  private visible = true
  /** update() のたびに立てる。可視集合が満たされた時点で 1 回だけ onViewportLoad を出す */
  private viewportPending = true
  private lastTargetZ = -1
  private o: TerrainTilesOptions

  constructor(o: TerrainTilesOptions, uniforms: Uniforms) {
    this.o = o
    this.uniforms = uniforms
    this.group.renderOrder = o.renderOrder
  }

  setVisible(v: boolean) {
    this.visible = v
    this.group.visible = v
    this.o.viewer.invalidate()
  }

  /** 水位・鉛直強調など。**ネットワークは一切発生しない**（uniform を書き換えるだけ）*/
  setUniforms(u: Uniforms) {
    this.uniforms = u
    for (const t of this.tiles.values()) {
      if (t.material) this.applyTo(t)
    }
    this.o.viewer.invalidate()
  }

  /** そのタイルがいまも視野に必要か。Scheduler のキャンセル判定に渡す */
  isTileNeeded = (z: number, x: number, y: number): boolean =>
    this.wanted.has(`${z}/${x}/${y}`)

  /** カメラが動いたら呼ぶ。可視集合を決め直して不足分を要求する */
  update() {
    if (!this.visible) return
    const { viewer, minZoom, maxZoom, extent } = this.o
    const z = Math.max(minZoom, Math.min(maxZoom, Math.round(viewer.getZoom())))
    const view = viewer.getBoundsLngLat()
    const bbox: [number, number, number, number] = [
      Math.max(view[0], extent[0]), Math.max(view[1], extent[1]),
      Math.min(view[2], extent[2]), Math.min(view[3], extent[3]),
    ]
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) { this.wanted.clear(); return }

    const ids = tilesInBounds(z, bbox)
    this.lastTargetZ = z

    this.wanted = new Set(ids.map(key))
    for (const id of ids) {
      const k = key(id)
      if (!this.tiles.has(k)) {
        this.tiles.set(k, { id, state: 'loading' })
        void this.load(id)
      }
    }
    this.viewportPending = true
    this.refreshVisibility(ids)
    this.evict()
  }

  private async load(id: TileId) {
    const k = key(id)
    const url = (tpl: string) => tpl
      .replace('{z}', String(id.z)).replace('{x}', String(id.x)).replace('{y}', String(id.y))
    const get = async (target: string) => decodeTileImage(await this.o.scheduler.submit({
      key: target, url: target, cls: this.o.cls, rank: id.z,
      epoch: this.o.scheduler.currentEpoch,
      stillNeeded: () => this.isTileNeeded(id.z, id.x, id.y),
    }))
    try {
      // 差分ピラミッドは疎（実測 101 枚 / 地形 131 枚）。差分タイルが無い場所で
      // タイルごと落とすと地形に穴が開くので、**欠損は許容して地形だけ描く**。
      // 「差分の情報が無い」と「判定差が無い」は別物なので、色は
      // シェーダ側で地面だけにする（floodMaterial.ts の uHasDiff < 0.5 の枝）。
      const [image, diffImage] = await Promise.all([
        get(url(this.o.urlTemplate)),
        this.o.diffUrlTemplate
          ? get(url(this.o.diffUrlTemplate)).catch(() => null)
          : Promise.resolve(null),
      ])
      const entry = this.tiles.get(k)
      if (!entry) return                       // 待っている間に捨てられた
      this.build(entry, image, diffImage)
      entry.state = 'ready'
      this.o.onTileLoaded?.(id.z)
      this.refreshVisibility()
      this.o.viewer.invalidate()
    } catch (e) {
      const entry = this.tiles.get(k)
      if (!entry) return
      if ((e as Error)?.name === 'AbortError') this.tiles.delete(k)
      else entry.state = 'failed'
    }
  }

  private build(entry: TileEntry, image: ImageBitmap, diffImage: ImageBitmap | null) {
    const { z, x, y } = entry.id
    const [w, s, e, n] = tileBoundsLngLat(z, x, y)
    const [xw, ys] = lngLatToWorld(this.o.frame, w, s)
    const [xe, yn] = lngLatToWorld(this.o.frame, e, n)

    const material = createFloodMaterial(FLOOD_PASS.ground)
    const waterMaterial = createFloodMaterial(FLOOD_PASS.water)
    entry.elev = makeTileTexture(image)
    entry.diff = diffImage ? makeTileTexture(diffImage) : undefined
    for (const m of [material, waterMaterial]) {
      m.uniforms.elevTexture.value = entry.elev
      m.uniforms.diffTexture.value = entry.diff ?? entry.elev
      m.uniforms.uHasDiff.value = entry.diff ? 1 : 0
    }
    entry.material = material
    entry.waterMaterial = waterMaterial
    entry.worldBounds = [xw, ys, xe, yn]
    // タイル 1 テクセルの実距離。法線計算に使う
    entry.metersPerTexel = Math.abs(yn - ys) / 256

    const mesh = new Mesh(floodGeometry(), material)
    mesh.frustumCulled = false      // 頂点で標高を引くので CPU 側に境界が無い
    mesh.renderOrder = this.o.renderOrder
    mesh.visible = false
    entry.mesh = mesh
    this.group.add(mesh)

    // 水面は地形の後・地物の前に描く（地物 = renderOrder 10）。
    // 深度は書かないので、後から描かれる地物ポリゴンと PLATEAU 建物は水面に隠れない
    const water = new Mesh(floodGeometry(), waterMaterial)
    water.frustumCulled = false
    water.renderOrder = this.o.renderOrder + 5
    water.visible = false
    entry.water = water
    this.group.add(water)

    this.applyTo(entry)
  }

  private applyTo(t: TileEntry) {
    if (!t.worldBounds) return
    const v = {
      ...this.uniforms,
      worldBounds: t.worldBounds,
      metersPerTexel: t.metersPerTexel ?? 1,
    }
    if (t.material) applyFloodUniforms(t.material, v)
    if (t.waterMaterial) applyFloodUniforms(t.waterMaterial, v)
    // 水面は地形メッシュが見えているタイルにだけ張る（best-available の祖先も含む）
    if (t.water) t.water.visible = this.uniforms.waterSurface && !!t.mesh?.visible
  }

  /**
   * best-available: 欲しいタイルがまだなら、読み終わっている祖先で埋める。
   * 何も無いところは描かない（黒い穴より、粗い地形の方が読める）。
   */
  private refreshVisibility(ids?: TileId[]) {
    const show = new Set<string>()
    let missing = 0
    const list = ids ?? [...this.wanted].map((k) => {
      const [z, x, y] = k.split('/').map(Number)
      return { z, x, y }
    })
    for (const id of list) {
      const k = key(id)
      const own = this.tiles.get(k)
      if (own?.state === 'ready') { show.add(k); continue }
      if (own?.state !== 'failed') missing++
      // 祖先をたどる
      let { z, x, y } = id
      while (z > this.o.minZoom) {
        z--; x >>= 1; y >>= 1
        const ak = `${z}/${x}/${y}`
        if (this.tiles.get(ak)?.state === 'ready') { show.add(ak); break }
      }
    }
    for (const [k, t] of this.tiles) {
      if (t.mesh) t.mesh.visible = show.has(k)
      if (t.water) t.water.visible = show.has(k) && this.uniforms.waterSurface
    }
    // deck.gl の TileLayer は viewport が変わるたびに「満たされた」を報告する。
    // 「欠けてから揃った」を条件にすると発火しない: AOI は z16 で 2x2 しかなく、
    // パンしても可視集合が変わらないので新規タイルが要らない。
    // その結果 perf.cameraSettled() が呼ばれず、計測の camera ms が空になっていた。
    // update() ごとに 1 回、満たされた時点で出す。
    if (list.length === 0 || missing > 0 || !this.viewportPending) return
    this.viewportPending = false
    this.o.onViewportLoad?.()
  }

  /** 視野から外れて久しいタイルを捨てる。テクスチャは明示的に開放する */
  private evict() {
    if (this.tiles.size <= MAX_TILES) return
    const drop: string[] = []
    for (const [k, t] of this.tiles) {
      if (this.wanted.has(k)) continue
      if (t.mesh?.visible) continue          // 祖先として使われている
      drop.push(k)
      if (this.tiles.size - drop.length <= MAX_TILES) break
    }
    for (const k of drop) this.destroy(k)
  }

  private destroy(k: string) {
    const t = this.tiles.get(k)
    if (!t) return
    if (t.mesh) this.group.remove(t.mesh)
    if (t.water) this.group.remove(t.water)
    t.material?.dispose()
    t.waterMaterial?.dispose()
    t.elev?.dispose()
    t.diff?.dispose()
    this.tiles.delete(k)
  }

  dispose() {
    for (const k of [...this.tiles.keys()]) this.destroy(k)
  }
}
