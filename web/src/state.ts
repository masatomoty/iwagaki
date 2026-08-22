import type { Catalog } from './domain/catalog'
import type { FeatureAssertion, SurfaceMode } from './domain/types'

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
}

export function initialState(catalog: Catalog): AppState {
  return {
    catalog,
    surface: 'highres',
    waterLevel: catalog.water_level.representative[0] ?? 1.0,
    layers: {
      flood: true, ground: true, plateau: true,
      pointcloud: true, semantics: true, changedOnly: false,
    },
    coalesceEnabled: true,
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
