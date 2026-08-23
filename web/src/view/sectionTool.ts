// 地図上で測線を引く操作。地図ライブラリに触るのはここだけにして、
// 断面の計算（assets/terrainSampler.ts）と描画（ui/section.ts）から分離する。

import type { Map as MlMap } from 'maplibre-gl'

export type LonLat = [number, number]

export interface SectionToolOptions {
  map: MlMap
  /** 測線が確定した */
  onLine: (from: LonLat, to: LonLat) => void
  /** 作図中の状態が変わった（UI のボタン表示用） */
  onState: (s: { active: boolean; hasFirst: boolean }) => void
}

export class SectionTool {
  private active = false
  private first: LonLat | null = null
  private marker?: HTMLElement

  constructor(private readonly o: SectionToolOptions) {
    o.map.on('click', (e) => {
      if (!this.active) return
      const p: LonLat = [e.lngLat.lng, e.lngLat.lat]
      if (!this.first) {
        this.first = p
        this.o.onState({ active: true, hasFirst: true })
        return
      }
      this.o.onLine(this.first, p)
      this.stop()
    })
    // 作図中は Esc で抜ける。地物クリックと取り合いになるので、抜け道を用意する
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active) this.stop()
    })
  }

  get isActive() { return this.active }

  start() {
    this.active = true
    this.first = null
    this.o.map.getCanvas().style.cursor = 'crosshair'
    this.o.onState({ active: true, hasFirst: false })
  }

  stop() {
    this.active = false
    this.first = null
    this.o.map.getCanvas().style.cursor = ''
    this.o.onState({ active: false, hasFirst: false })
    this.marker?.remove()
  }

  toggle() { this.active ? this.stop() : this.start() }
}

/** 測線を地図に描くための GeoJSON。deck.gl のレイヤに渡す */
export function lineFeature(from: LonLat, to: LonLat) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: [from, to] },
    properties: {},
  }
}
