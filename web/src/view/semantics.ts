// PLATEAU 地物 + assertion。ドメイン型に落としてから deck.gl に渡す。

import type { FeatureAssertion } from '../domain/types'

export interface RawFeature {
  type: 'Feature'
  properties: Record<string, unknown>
  geometry: { type: string; coordinates: unknown }
}

export function toAssertion(p: Record<string, unknown>): FeatureAssertion {
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined)
  return {
    gmlId: String(p.gml_id ?? ''),
    featureType: String(p.feature_type ?? ''),
    name: p.name ? String(p.name) : undefined,
    areaM2: num('area_m2'),
    sectionType: p.section_type ? String(p.section_type) : undefined,
    sectionTypeLabel: p.section_type_label ? String(p.section_type_label) : undefined,
    unreliable: p.unreliable === true,
    unreliableReason: p.unreliable_reason ? String(p.unreliable_reason) : undefined,
    // 4 条件すべて。属性が無い条件は undefined のまま（inspector が「—」を出す）
    groundElev: {
      baseline: num('ground_elev_baseline'), highres: num('ground_elev_highres'),
      control: num('ground_elev_control'), pointcloud: num('ground_elev_pointcloud'),
    },
    hConn: {
      baseline: num('h_conn_baseline'), highres: num('h_conn_highres'),
      control: num('h_conn_control'), pointcloud: num('h_conn_pointcloud'),
    },
  }
}

/** 3D Tiles は楕円体高なので、地物ポリゴンも同じ高さに上げて重ねる */
export function liftZ(geometry: RawFeature['geometry'], z: number): RawFeature['geometry'] {
  const lift = (ring: number[][]) => ring.map(([x, y]) => [x, y, z])
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: (geometry.coordinates as number[][][]).map(lift) }
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: (geometry.coordinates as number[][][][]).map((poly) => poly.map(lift)),
    }
  }
  return geometry
}
