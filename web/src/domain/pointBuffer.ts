// 任意地点＋徒歩圏（半径 500/800/1000 m）の集計（`docs/todo.md` T1）。
//
// `scripts/93_point_buffer_agg.py` が書き出す JSON（`point_buffer_<slug>.json`）
// と、その索引（`index.json` -> `catalog.point_buffer`）をそのまま読む。
//
// **新しい外部 API・サーバ計算は足さない。** viewer は地図をクリックしても
// 新規に集計を作れないので、索引に載っている地点だけを引ける。地図でクリックした
// 座標に一番近い索引の地点を許容距離内で探すのが `nearestIndexEntry`。見つからなければ
// 「この地点はまだ集計していない」と明確に出す（呼び側の役目、`ui/pointBufferPanel.ts`）。
//
// ここは three / @loaders.gl / maplibre-gl を import しない（`docs/web_design.md`「層の分け方」）。

/** 徒歩圏として選べる半径 [m]。`scripts/93` の `RADII` と揃える */
export const POINT_BUFFER_RADII = [500, 800, 1000] as const
export type PointBufferRadius = (typeof POINT_BUFFER_RADII)[number]

export interface PointBufferIndexEntry {
  id: string
  label: string
  centerWgs84: [number, number]
  aoi: string
  radiiM: number[]
  generatedAt: string
  /** `index.json` と同じディレクトリからの相対 URL */
  url: string
}

export interface PointBufferIndex {
  entries: PointBufferIndexEntry[]
}

/** ①人口・年齢の年齢区分 1 つぶん */
export interface PointBufferAgeBucket {
  count: number
  share: number | null
  label: string
}

export interface PointBufferPopulationSection {
  method: 'areal' | 'centroid'
  methodNote: string
  populationEstimate: number
  ageDistribution: Record<'age_0_14' | 'age_15_64' | 'age_65_plus' | 'age_unknown', PointBufferAgeBucket>
  agingRate65Plus: number | null
  nSmallAreasIntersecting: number
  nSmallAreasCounted: number
  nSmallAreasMissingStatsInCircle: number
  nSmallAreasSuppressedInCircle: number
  /** 円のうち小地域境界データで覆われている割合。1 未満なら人口が欠落し得る */
  boundaryCoverageFraction: number
  coverageComplete: boolean
  valueKind: string
}

export interface PointBufferUsageRow { code: string; label: string; count: number }

export interface PointBufferBuildingUsageSection {
  totalBuildings: number
  byUsage: PointBufferUsageRow[]
  valueKind: string
}

export interface PointBufferTransportSection {
  plateauRoadSegments: number
  plateauRoadAreaM2InCircle: number
  roadAreaRatio: number
  valueKind: string
  note: string
}

/** ③事業所数・④用途地域など、**未取得のまま**のセクション（`docs/todo.md` T1） */
export interface PointBufferUnavailableSection {
  status: string
  note: string
}

export interface PointBufferRadiusSections {
  '1_population_and_age': PointBufferPopulationSection
  '2_building_usage': PointBufferBuildingUsageSection | PointBufferUnavailableSection
  '3_establishments': PointBufferUnavailableSection
  '4_land_use_regulation': PointBufferUnavailableSection
  '5_transport': PointBufferTransportSection | PointBufferUnavailableSection
}

export interface PointBufferResult {
  label: string
  centerWgs84: [number, number]
  aoi: string
  aoiSelection: string
  pointToAoiEdgeM: number | null
  radiiM: number[]
  generatedAt: string
  byRadius: Record<string, PointBufferRadiusSections>
  caveats: string[]
}

function isUnavailableRaw(v: unknown): v is { status: string; note: string } {
  return !!v && typeof v === 'object' && 'status' in (v as Record<string, unknown>)
}

/** `index.json`（`catalog.point_buffer.url` の中身）を domain 型に直す */
export function parsePointBufferIndex(json: unknown): PointBufferIndex {
  const j = json as { points?: Record<string, unknown>[] }
  const entries = (j.points ?? []).map((p): PointBufferIndexEntry => ({
    id: String(p.id ?? ''),
    label: String(p.label ?? p.id ?? ''),
    centerWgs84: (p.center_wgs84 as [number, number]) ?? [0, 0],
    aoi: String(p.aoi ?? ''),
    radiiM: (p.radii_m as number[]) ?? [],
    generatedAt: String(p.generated_at ?? ''),
    url: String(p.url ?? ''),
  })).filter((e) => e.id && e.url)
  return { entries }
}

/** `point_buffer_<slug>.json`（索引の各エントリの `url`）を domain 型に直す */
export function parsePointBufferResult(json: unknown): PointBufferResult {
  const j = json as Record<string, unknown>
  const center = j.center_wgs84_ish as { lon?: number; lat?: number } | undefined
  const byRadiusRaw = (j.by_radius ?? {}) as Record<string, Record<string, unknown>>
  const byRadius: Record<string, PointBufferRadiusSections> = {}
  for (const [r, sec] of Object.entries(byRadiusRaw)) {
    byRadius[r] = {
      '1_population_and_age': parsePopulation(sec['1_population_and_age']),
      '2_building_usage': parseBuildingUsage(sec['2_building_usage']),
      '3_establishments': parseUnavailable(sec['3_establishments']),
      '4_land_use_regulation': parseUnavailable(sec['4_land_use_regulation']),
      '5_transport': parseTransport(sec['5_transport']),
    }
  }
  return {
    label: String(j.label ?? ''),
    centerWgs84: [center?.lon ?? 0, center?.lat ?? 0],
    aoi: String(j.aoi ?? ''),
    aoiSelection: String(j.aoi_selection ?? ''),
    pointToAoiEdgeM: (j.point_to_aoi_edge_m as number | null) ?? null,
    radiiM: (j.radii_m as number[]) ?? [],
    generatedAt: String(j.generated_at ?? ''),
    byRadius,
    caveats: (j.caveats as string[]) ?? [],
  }
}

function parseUnavailable(v: unknown): PointBufferUnavailableSection {
  const j = (v ?? {}) as Record<string, unknown>
  return { status: String(j.status ?? '未取得'), note: String(j.note ?? '') }
}

function parsePopulation(v: unknown): PointBufferPopulationSection {
  const j = (v ?? {}) as Record<string, unknown>
  const age = (j.age_distribution ?? {}) as Record<string, Record<string, unknown>>
  const bucket = (k: string): PointBufferAgeBucket => {
    const a = age[k] ?? {}
    return {
      count: Number(a.count ?? 0),
      share: (a.share as number | null | undefined) ?? null,
      label: String(a.label ?? k),
    }
  }
  return {
    method: (j.method as 'areal' | 'centroid') ?? 'areal',
    methodNote: String(j.method_note ?? ''),
    populationEstimate: Number(j.population_estimate ?? 0),
    ageDistribution: {
      age_0_14: bucket('age_0_14'),
      age_15_64: bucket('age_15_64'),
      age_65_plus: bucket('age_65_plus'),
      age_unknown: bucket('age_unknown'),
    },
    agingRate65Plus: (j.aging_rate_65plus as number | null | undefined) ?? null,
    nSmallAreasIntersecting: Number(j.n_small_areas_intersecting ?? 0),
    nSmallAreasCounted: Number(j.n_small_areas_counted ?? 0),
    nSmallAreasMissingStatsInCircle: Number(j.n_small_areas_missing_stats_in_circle ?? 0),
    nSmallAreasSuppressedInCircle: Number(j.n_small_areas_suppressed_in_circle ?? 0),
    boundaryCoverageFraction: Number(j.boundary_coverage_fraction ?? 0),
    coverageComplete: j.coverage_complete === true,
    valueKind: String(j.value_kind ?? ''),
  }
}

function parseBuildingUsage(
  v: unknown,
): PointBufferBuildingUsageSection | PointBufferUnavailableSection {
  if (isUnavailableRaw(v)) return parseUnavailable(v)
  const j = (v ?? {}) as Record<string, unknown>
  const rows = (j.by_usage as Record<string, unknown>[] | undefined) ?? []
  return {
    totalBuildings: Number(j.total_buildings ?? 0),
    byUsage: rows.map((r) => ({
      code: String(r.code ?? ''), label: String(r.label ?? ''), count: Number(r.count ?? 0),
    })),
    valueKind: String(j.value_kind ?? ''),
  }
}

function parseTransport(
  v: unknown,
): PointBufferTransportSection | PointBufferUnavailableSection {
  if (isUnavailableRaw(v)) return parseUnavailable(v)
  const j = (v ?? {}) as Record<string, unknown>
  return {
    plateauRoadSegments: Number(j.plateau_road_segments ?? 0),
    plateauRoadAreaM2InCircle: Number(j.plateau_road_area_m2_in_circle ?? 0),
    roadAreaRatio: Number(j.road_area_ratio ?? 0),
    valueKind: String(j.value_kind ?? ''),
    note: String(j.note ?? ''),
  }
}

/** そのセクションが「未取得／データなし」で中身を持たないか */
export function isUnavailable(
  s: PointBufferRadiusSections[keyof PointBufferRadiusSections],
): s is PointBufferUnavailableSection {
  return 'status' in s
}

/** 半径（500/800/1000）でセクションを引く。無ければ undefined */
export function sectionAt(
  result: PointBufferResult, radius: number,
): PointBufferRadiusSections | undefined {
  return result.byRadius[String(radius)]
}

/**
 * 2 点間の距離 [m]（WGS84 の簡易平面近似）。
 * `main.ts` の `coarseMaxZoom` / `initialZoom` と同じ近似（AOI が数 km 四方な
 * ので十分）。ここでは「索引の地点とどれだけ離れているか」の判定にしか使わない。
 */
export function metersBetween(
  lon0: number, lat0: number, lon1: number, lat1: number,
): number {
  const lat = (lat0 + lat1) / 2
  const dx = (lon1 - lon0) * 111_320 * Math.cos((lat * Math.PI) / 180)
  const dy = (lat1 - lat0) * 110_950
  return Math.hypot(dx, dy)
}

/**
 * クリック地点に一番近い、事前生成済みの地点。**`maxDistanceM` を超えたら
 * 「無い」として扱う**（遠くの既存地点を誤って出さないため）。
 */
export function nearestIndexEntry(
  index: PointBufferIndex, lon: number, lat: number, maxDistanceM = 120,
): { entry: PointBufferIndexEntry; distanceM: number } | undefined {
  let best: { entry: PointBufferIndexEntry; distanceM: number } | undefined
  for (const entry of index.entries) {
    const d = metersBetween(lon, lat, entry.centerWgs84[0], entry.centerWgs84[1])
    if (d > maxDistanceM) continue
    if (!best || d < best.distanceM) best = { entry, distanceM: d }
  }
  return best
}
