// 「地域別の浸水建物」表（現場運用向けの出力、report discussion.md 5.3）の
// ダウンロード用シリアライズ。**画面にいま出ている値をそのまま書き出すだけ**で、
// サーバ往復も追加のモデル計算もしない（`perAreaFloodCounts` の結果を使う）。
//
// ここは three / @loaders.gl / maplibre-gl を import しない（`docs/web_design.md`「層の分け方」）。

import type { AreaFloodRow } from './flood'
import type { FloodModel, TerrainCondition } from './types'

/** 集計時点の条件。ファイル名・メタデータの両方に埋め込む（固定潮位ファイルとの混同を防ぐ）。*/
export interface AreaFloodContext {
  waterLevelMTp: number
  floodModel: FloodModel
  condition: TerrainCondition
  floorAboveDepthM: number
}

/** `scripts/92_area_aggregate.py` と同じ注記（モデル由来であり公式統計ではない）。 */
const VALUE_KIND_NOTE = '推計棟数（モデル由来。国勢調査の公式統計値ではない）'

function csvField(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvRow(fields: (string | number)[]): string {
  return `${fields.map(csvField).join(',')}\r\n`
}

const CSV_HEADER = [
  'area_code', 'area_name', 'total_bldg', 'flooded_bldg',
  'floor_above_bldg', 'floor_under_bldg', 'flood_rate',
  'target_tide_m_tp', 'flood_model', 'terrain_condition',
  'floor_above_depth_m', 'value_kind',
]

/**
 * 「地域別の浸水建物」表（`ui/controls.ts::areaFloodHtml`）と同じ行・同じ並びの CSV。
 * `(小地域外)` の行も含む（表と数字を一致させるため）。
 */
export function areaFloodToCsv(rows: AreaFloodRow[], ctx: AreaFloodContext): string {
  const ctxFields: (string | number)[] = [
    ctx.waterLevelMTp.toFixed(2), ctx.floodModel, ctx.condition,
    ctx.floorAboveDepthM, VALUE_KIND_NOTE,
  ]
  let out = csvRow(CSV_HEADER)
  for (const r of rows) {
    out += csvRow([
      r.areaCode ?? '(小地域外)', r.areaName, r.total, r.flooded,
      r.above, r.under, Number(r.floodRate.toFixed(4)),
      ...ctxFields,
    ])
  }
  return out
}

/** `catalog.small_areas.url` が指す軽量ポリゴン GeoJSON の最小限の形。 */
export interface SmallAreaFeature {
  type: 'Feature'
  geometry: unknown
  properties: { area_code: string; area_name: string; total_bldg: number }
}
export interface SmallAreaFeatureCollection {
  type: 'FeatureCollection'
  features: SmallAreaFeature[]
}

export interface AreaFloodGeoJsonProperties {
  area_code: string
  area_name: string
  total_bldg: number
  flooded_bldg: number
  floor_above_bldg: number
  floor_under_bldg: number
  flood_rate: number
}

export interface AreaFloodFeatureCollection {
  type: 'FeatureCollection'
  metadata: {
    target_tide_m_tp: number
    flood_model: FloodModel
    terrain_condition: TerrainCondition
    floor_above_depth_m: number
    value_kind: string
    generated_at: string
    /**
     * 小地域ポリゴンを持たない `(小地域外)` の建物。ポリゴンが無いので feature には
     * できない（`scripts/92_area_aggregate.py::write_geojson` と同じ扱い）。
     */
    outside_small_area?: {
      total_bldg: number; flooded_bldg: number
      floor_above_bldg: number; floor_under_bldg: number
    }
  }
  features: { type: 'Feature'; geometry: unknown; properties: AreaFloodGeoJsonProperties }[]
}

/**
 * 表の行 ＋ `catalog.small_areas` のポリゴンを `area_code` で突き合わせて GeoJSON にする。
 * ポリゴンが無い小地域（境界データの版差・0 棟の小地域など）は落ちる — 表の合計とは
 * 一致しないことがあるため、`(小地域外)` と同じく `metadata` 側に別掲する設計にはしていない
 * （境界の欠落は基本的に起きない想定。起きた場合は features の数が `rows` より少なくなる）。
 */
export function areaFloodToGeoJson(
  rows: AreaFloodRow[], smallAreas: SmallAreaFeatureCollection, ctx: AreaFloodContext,
): AreaFloodFeatureCollection {
  const byCode = new Map(
    rows.filter((r): r is AreaFloodRow & { areaCode: string } => r.areaCode !== undefined)
      .map((r) => [r.areaCode, r]))
  const outside = rows.find((r) => r.areaCode === undefined && r.total > 0)
  const features = smallAreas.features.flatMap((f) => {
    const r = byCode.get(f.properties.area_code)
    if (!r) return []
    return [{
      type: 'Feature' as const,
      geometry: f.geometry,
      properties: {
        area_code: f.properties.area_code, area_name: r.areaName, total_bldg: r.total,
        flooded_bldg: r.flooded, floor_above_bldg: r.above, floor_under_bldg: r.under,
        flood_rate: Number(r.floodRate.toFixed(4)),
      },
    }]
  })
  return {
    type: 'FeatureCollection',
    metadata: {
      target_tide_m_tp: ctx.waterLevelMTp, flood_model: ctx.floodModel,
      terrain_condition: ctx.condition, floor_above_depth_m: ctx.floorAboveDepthM,
      value_kind: VALUE_KIND_NOTE, generated_at: new Date().toISOString(),
      ...(outside ? {
        outside_small_area: {
          total_bldg: outside.total, flooded_bldg: outside.flooded,
          floor_above_bldg: outside.above, floor_under_bldg: outside.under,
        },
      } : {}),
    },
    features,
  }
}

/** ファイル名に使える形の潮位表記（例 `H1.20`）。負値・小数は `-` `p` に置換しない
 *  — ブラウザのダウンロードファイル名はここでは記号を許すため、`scripts/88` の
 *  `H0p93` 形式には合わせない（あちらはファイルシステム上の資産名の制約）。*/
export function areaFloodFileBase(ctx: AreaFloodContext): string {
  return `area_flood_H${ctx.waterLevelMTp.toFixed(2)}_${ctx.floodModel}_${ctx.condition}`
}
