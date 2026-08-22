// PLATEAU 地物（建物・道路）+ assertion のレイヤ。
// @deck.gl/layers の GeoJsonLayer は PolygonLayer / PathLayer / TextLayer を
// 引き連れてくるので、初回描画のバンドルに入れず遅延読み込みする
// （FMR を決めているのはバンドルだった: docs/WEB_RESULTS.md §1）。

import { GeoJsonLayer } from '@deck.gl/layers'

import { decisionChanged, featureDepth } from '../domain/flood'
import type { FeatureAssertion, TerrainCondition } from '../domain/types'
import type { RawFeature } from './semantics'

export interface SemanticsOptions {
  features: RawFeature[]
  waterLevel: number
  condition: TerrainCondition
  roadThresholds: number[]
  changedOnly: boolean
  onClick: (a: FeatureAssertion | undefined) => void
}

export function createSemanticsLayer(o: SemanticsOptions) {
  return new GeoJsonLayer({
    id: 'semantics',
    data: o.features as unknown as never,
    pickable: true,
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    updateTriggers: {
      getFillColor: [o.waterLevel, o.changedOnly, o.condition],
      getLineColor: [o.waterLevel, o.changedOnly],
    },
    getFillColor: (f: unknown) => {
      const a = (f as RawFeature).properties.__a as FeatureAssertion
      const changed = decisionChanged(a, o.waterLevel, o.roadThresholds)
      if (o.changedOnly && !changed) return [0, 0, 0, 0]
      if (a.unreliable) return [110, 110, 120, 70]
      if (changed) return [242, 68, 52, 190]
      return featureDepth(a, o.condition, o.waterLevel) > 0
        ? [70, 130, 200, 120]
        : [190, 195, 205, 55]
    },
    getLineColor: (f: unknown) => {
      const a = (f as RawFeature).properties.__a as FeatureAssertion
      return decisionChanged(a, o.waterLevel, o.roadThresholds)
        ? [255, 220, 120, 230] : [20, 24, 32, 140]
    },
    onClick: (info: { object?: unknown }) => {
      const f = info.object as RawFeature | undefined
      o.onClick(f ? (f.properties.__a as FeatureAssertion) : undefined)
    },
  })
}
