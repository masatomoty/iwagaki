import type { Catalog } from './domain/catalog'
import type { BuildingColorMode, FeatureAssertion, SurfaceMode } from './domain/types'

export interface LayerToggles {
  flood: boolean
  ground: boolean
  plateau: boolean
  pointcloud: boolean
  semantics: boolean
  changedOnly: boolean
}

export interface AppState {
  catalog: Catalog
  surface: SurfaceMode
  waterLevel: number
  layers: LayerToggles
  selected?: FeatureAssertion
  coalesceEnabled: boolean
  /** PLATEAU 建物の塗り分け。b3dm には色が無いので属性から与える */
  buildingColor: BuildingColorMode
  /** 鉛直強調。吉原は起伏が 0〜3 m しかないので、真横から見るには必須 */
  exaggeration: number
}

export function initialState(catalog: Catalog): AppState {
  return {
    catalog,
    surface: 'highres',
    waterLevel: catalog.water_level.representative[0] ?? 1.0,
    layers: {
      flood: true, ground: true, plateau: true,
      // 点群は既定 OFF。合成データで地表面と重なり浸水色を隠すうえ、
      // GPU 44 MB / 転送 14 MB を使う（docs/WEB_RESULTS.md §6）
      pointcloud: false, semantics: true, changedOnly: false,
    },
    coalesceEnabled: true,
    buildingColor: 'usage',
    exaggeration: 1,
  }
}

export class Store {
  private listeners = new Set<(s: AppState) => void>()
  constructor(public state: AppState) {}
  subscribe(fn: (s: AppState) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch }
    for (const f of this.listeners) f(this.state)
  }
  setLayer(patch: Partial<LayerToggles>) {
    this.set({ layers: { ...this.state.layers, ...patch } })
  }
}
