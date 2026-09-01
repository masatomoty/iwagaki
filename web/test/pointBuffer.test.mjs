// 任意地点＋徒歩圏の集計（`docs/todo.md` T1、`scripts/93_point_buffer_agg.py`）。
//
// pair.test.mjs / flow.test.mjs と同じ方針で **TS を import せず式を二重化**し、
// scripts/93 が実際に書き出す JSON 形（読み取り済み）を模したリテラルに対して検査する。
// 配信物（`catalog.point_buffer`）はまだ焼いていない世代もあるので、実データではなく
// 固定フィクスチャで見る。

import assert from 'node:assert/strict'
import test from 'node:test'

// --- domain/pointBuffer.ts と同じ式（parsePointBufferIndex）----------------
function parsePointBufferIndex(json) {
  const entries = (json.points ?? []).map((p) => ({
    id: String(p.id ?? ''),
    label: String(p.label ?? p.id ?? ''),
    centerWgs84: p.center_wgs84 ?? [0, 0],
    aoi: String(p.aoi ?? ''),
    radiiM: p.radii_m ?? [],
    generatedAt: String(p.generated_at ?? ''),
    url: String(p.url ?? ''),
  })).filter((e) => e.id && e.url)
  return { entries }
}

// --- metersBetween / nearestIndexEntry --------------------------------------
function metersBetween(lon0, lat0, lon1, lat1) {
  const lat = (lat0 + lat1) / 2
  const dx = (lon1 - lon0) * 111_320 * Math.cos((lat * Math.PI) / 180)
  const dy = (lat1 - lat0) * 110_950
  return Math.hypot(dx, dy)
}
function nearestIndexEntry(index, lon, lat, maxDistanceM = 120) {
  let best
  for (const entry of index.entries) {
    const d = metersBetween(lon, lat, entry.centerWgs84[0], entry.centerWgs84[1])
    if (d > maxDistanceM) continue
    if (!best || d < best.distanceM) best = { entry, distanceM: d }
  }
  return best
}

// --- parsePointBufferResult（scripts/93 の run_point() の出力形）-----------
function isUnavailableRaw(v) { return !!v && typeof v === 'object' && 'status' in v }
function parseUnavailable(v) {
  const j = v ?? {}
  return { status: String(j.status ?? '未取得'), note: String(j.note ?? '') }
}
function parsePopulation(v) {
  const j = v ?? {}
  const age = j.age_distribution ?? {}
  const bucket = (k) => {
    const a = age[k] ?? {}
    return { count: Number(a.count ?? 0), share: a.share ?? null, label: String(a.label ?? k) }
  }
  return {
    method: j.method ?? 'areal',
    populationEstimate: Number(j.population_estimate ?? 0),
    ageDistribution: {
      age_0_14: bucket('age_0_14'), age_15_64: bucket('age_15_64'),
      age_65_plus: bucket('age_65_plus'), age_unknown: bucket('age_unknown'),
    },
    agingRate65Plus: j.aging_rate_65plus ?? null,
    boundaryCoverageFraction: Number(j.boundary_coverage_fraction ?? 0),
    coverageComplete: j.coverage_complete === true,
  }
}
function parseBuildingUsage(v) {
  if (isUnavailableRaw(v)) return parseUnavailable(v)
  const j = v ?? {}
  const rows = j.by_usage ?? []
  return {
    totalBuildings: Number(j.total_buildings ?? 0),
    byUsage: rows.map((r) => ({ code: String(r.code ?? ''), label: String(r.label ?? ''), count: Number(r.count ?? 0) })),
  }
}
function parseTransport(v) {
  if (isUnavailableRaw(v)) return parseUnavailable(v)
  const j = v ?? {}
  return {
    plateauRoadSegments: Number(j.plateau_road_segments ?? 0),
    roadAreaRatio: Number(j.road_area_ratio ?? 0),
  }
}
function parsePointBufferResult(json) {
  const j = json
  const center = j.center_wgs84_ish ?? {}
  const byRadiusRaw = j.by_radius ?? {}
  const byRadius = {}
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
    centerWgs84: [center.lon ?? 0, center.lat ?? 0],
    aoi: String(j.aoi ?? ''),
    radiiM: j.radii_m ?? [],
    byRadius,
  }
}
function isUnavailable(s) { return 'status' in s }
function sectionAt(result, radius) { return result.byRadius[String(radius)] }

// --- フィクスチャ: scripts/93 の実出力の形をそのまま模す --------------------
const SAMPLE_RESULT = {
  label: '西舞鶴駅前',
  center_wgs84_ish: { lon: 135.3822, lat: 35.4536, crs: 'EPSG:6668' },
  aoi: 'nishi_maizuru',
  aoi_selection: '指定',
  radii_m: [500, 800, 1000],
  generated_at: '2026-09-01T00:00:00+00:00',
  by_radius: {
    500: {
      '1_population_and_age': {
        method: 'areal', population_estimate: 2500.4,
        age_distribution: {
          age_0_14: { count: 300.1, share: 0.12, label: '年少人口（0〜14歳）' },
          age_15_64: { count: 1500.2, share: 0.6, label: '生産年齢人口（15〜64歳）' },
          age_65_plus: { count: 700.1, share: 0.28, label: '老年人口（65歳以上）' },
          age_unknown: { count: 0, share: 0, label: '年齢不詳' },
        },
        aging_rate_65plus: 0.28, boundary_coverage_fraction: 0.99, coverage_complete: true,
      },
      '2_building_usage': {
        total_buildings: 120,
        by_usage: [{ code: '411', label: '住宅', count: 80 }, { code: '402', label: '商業施設', count: 40 }],
      },
      '3_establishments': { status: '未取得', note: '経済センサス（事業所数）。別データ取得・別 PR' },
      '4_land_use_regulation': { status: '未取得', note: '用途地域等の都市計画制限。別データ取得・別 PR' },
      '5_transport': { plateau_road_segments: 30, road_area_ratio: 0.12 },
    },
    800: {
      '1_population_and_age': {
        method: 'areal', population_estimate: 4110.0,
        age_distribution: {
          age_0_14: { count: 500, share: 0.12, label: '年少人口（0〜14歳）' },
          age_15_64: { count: 2200, share: 0.54, label: '生産年齢人口（15〜64歳）' },
          age_65_plus: { count: 1400, share: 0.34, label: '老年人口（65歳以上）' },
          age_unknown: { count: 10, share: 0, label: '年齢不詳' },
        },
        aging_rate_65plus: 0.34, boundary_coverage_fraction: 1.0, coverage_complete: true,
      },
      // ② ⑤ は objects.geojson が無い AOI を想定した「データなし」の形
      '2_building_usage': { status: 'データなし', note: "AOI 'x' に objects.geojson が無い" },
      '3_establishments': { status: '未取得', note: '' },
      '4_land_use_regulation': { status: '未取得', note: '' },
      '5_transport': { status: 'データなし', note: "AOI 'x' に objects.geojson が無い" },
    },
  },
}

const SAMPLE_INDEX = {
  version: 1,
  points: [
    {
      id: 'nishimaizuru_ekimae', label: '西舞鶴駅前', center_wgs84: [135.3822, 35.4536],
      aoi: 'nishi_maizuru', radii_m: [500, 800, 1000],
      generated_at: '2026-09-01T00:00:00+00:00', url: 'point_buffer_nishimaizuru_ekimae.json',
    },
    // id か url を欠いた壊れたエントリは黙って捨てる
    { id: '', label: '欠損', center_wgs84: [0, 0], aoi: '', radii_m: [], generated_at: '', url: '' },
  ],
}

test('parsePointBufferIndex: 不完全なエントリを捨てる', () => {
  const idx = parsePointBufferIndex(SAMPLE_INDEX)
  assert.equal(idx.entries.length, 1)
  assert.equal(idx.entries[0].id, 'nishimaizuru_ekimae')
  assert.equal(idx.entries[0].url, 'point_buffer_nishimaizuru_ekimae.json')
})

test('metersBetween: 緯度 0.001 度 ≈ 111 m', () => {
  const d = metersBetween(135.0, 35.0, 135.0, 35.001)
  assert.ok(Math.abs(d - 110.95) < 1, `got ${d}`)
})

test('nearestIndexEntry: 許容距離内の最寄りだけ拾う', () => {
  const idx = parsePointBufferIndex(SAMPLE_INDEX)
  const near = nearestIndexEntry(idx, 135.3822, 35.4536, 120)
  assert.ok(near)
  assert.equal(near.entry.id, 'nishimaizuru_ekimae')
  assert.ok(near.distanceM < 1)

  // 遠い点では許容距離を超えて undefined
  const far = nearestIndexEntry(idx, 135.5, 35.6, 120)
  assert.equal(far, undefined)
})

test('nearestIndexEntry: 複数候補から最短を選ぶ', () => {
  const idx = {
    entries: [
      { id: 'a', centerWgs84: [135.0, 35.0], url: 'a.json' },
      { id: 'b', centerWgs84: [135.0005, 35.0], url: 'b.json' },
    ],
  }
  const hit = nearestIndexEntry(idx, 135.0004, 35.0, 200)
  assert.equal(hit.entry.id, 'b')
})

test('parsePointBufferResult: 人口・年齢の合計が整合する（西舞鶴駅前 800m ≈ docs/results.md の実測）', () => {
  const r = parsePointBufferResult(SAMPLE_RESULT)
  const sec800 = sectionAt(r, 800)
  const pop = sec800['1_population_and_age']
  assert.equal(pop.populationEstimate, 4110.0)
  assert.equal(pop.agingRate65Plus, 0.34)
  const sum = Object.values(pop.ageDistribution).reduce((a, b) => a + b.count, 0)
  assert.ok(Math.abs(sum - pop.populationEstimate) < 1e-6)
})

test('parsePointBufferResult: ② ⑤ が「データなし」のとき isUnavailable が立つ', () => {
  const r = parsePointBufferResult(SAMPLE_RESULT)
  const sec800 = sectionAt(r, 800)
  assert.equal(isUnavailable(sec800['2_building_usage']), true)
  assert.equal(isUnavailable(sec800['5_transport']), true)
  const sec500 = sectionAt(r, 500)
  assert.equal(isUnavailable(sec500['2_building_usage']), false)
  assert.equal(sec500['2_building_usage'].totalBuildings, 120)
  assert.equal(sec500['5_transport'].plateauRoadSegments, 30)
})

test('parsePointBufferResult: ③ ④ は常に未取得（経済センサス・用途地域は実装しない）', () => {
  const r = parsePointBufferResult(SAMPLE_RESULT)
  for (const radius of [500, 800]) {
    const sec = sectionAt(r, radius)
    assert.equal(isUnavailable(sec['3_establishments']), true)
    assert.equal(isUnavailable(sec['4_land_use_regulation']), true)
  }
})

test('sectionAt: 無い半径は undefined', () => {
  const r = parsePointBufferResult(SAMPLE_RESULT)
  assert.equal(sectionAt(r, 1000), undefined)
})
