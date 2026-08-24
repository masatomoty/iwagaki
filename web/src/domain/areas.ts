// 対象範囲の索引（`data/areas.json`）。
//
// **範囲は 3 つある**（`src/iwagaki/config.py` の `AOIS`）。
//   - `yoshiwara`        100 ha。4 条件・地上点群あり。README と docs/results.md の数字はこれ
//   - `nishi_maizuru`    625 ha。0.5m と PLATEAU 5m だけ
//   - `higashi_maizuru`  625 ha。同上
//
// 後ろの 2 つは市の要望（2026-08、`高潮表示範囲.pdf` の 2 つの〇）で足した
// 面的表示用の範囲で、**点群が無い**。
//
// ここは three / @loaders.gl を import しない（`docs/web_design.md` の依存ルール）。

export interface Area {
  id: string
  label: string
  /** catalog の URL。範囲ごとに 1 枚 */
  catalog: string
  bboxWgs84: [number, number, number, number]
  centreWgs84: [number, number]
  areaHa: number
  conditions: string[]
  hasPointcloud: boolean
}

export interface AreaIndex {
  default: string
  areas: Area[]
}

/** 単一範囲の配信物（`areas.json` が無い旧世代）向けの索引 */
export const SINGLE_AREA: AreaIndex = {
  default: 'yoshiwara',
  areas: [{
    id: 'yoshiwara', label: '吉原', catalog: 'data/catalog.json',
    bboxWgs84: [0, 0, 0, 0], centreWgs84: [0, 0], areaHa: 100,
    conditions: [], hasPointcloud: true,
  }],
}

export function parseAreaIndex(json: unknown): AreaIndex {
  const j = json as {
    default?: string
    areas?: {
      id: string; label?: string; catalog: string
      bbox_wgs84?: number[]; centre_wgs84?: number[]
      area_ha?: number; conditions?: string[]; has_pointcloud?: boolean
    }[]
  }
  const areas: Area[] = (j.areas ?? []).map((a) => ({
    id: a.id,
    label: a.label ?? a.id,
    catalog: a.catalog,
    bboxWgs84: (a.bbox_wgs84 ?? [0, 0, 0, 0]) as [number, number, number, number],
    centreWgs84: (a.centre_wgs84 ?? [0, 0]) as [number, number],
    areaHa: a.area_ha ?? 0,
    conditions: a.conditions ?? [],
    hasPointcloud: a.has_pointcloud === true,
  }))
  if (areas.length === 0) return SINGLE_AREA
  return { default: j.default ?? areas[0].id, areas }
}

/**
 * どの範囲を出すか。`?area=<id>` が最優先で、無ければ索引の既定。
 * **知らない id は既定に落とす**（URL を手で書き替えても壊れない）。
 */
export function pickArea(index: AreaIndex, requested: string | null): Area {
  const byId = new Map(index.areas.map((a) => [a.id, a]))
  return byId.get(requested ?? '')
    ?? byId.get(index.default)
    ?? index.areas[0]
}
