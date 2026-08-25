// PLATEAU 建物の属性による塗り分け。
//
// b3dm には色情報が一切入っていない（texture / COLOR_0 / baseColorFactor すべて無し、
// materials は roughness=metallic=0 のみ）。glTF 既定の白 [1,1,1,1] が陰影を受けて
// グレーに見えているだけなので、色は我々が属性から与える。
//
// 属性値は b3dm の batchTableJson から取る（objects.geojson ではない）。
// batch table は `bldg:class` / `bldg:usage` を **表示名で** 持っているうえ、
// 解析対象 930 棟の外にある建物にも付いている（3D Tiles の全 2,005 棟に付く）。
// 表示名 -> コード は catalog.semantics.codelists（CityGML 配布 zip 同梱の
// コードリスト由来）で引き、色はコードに対して固定する = 表示名の揺れに依存しない。

import { featureDepth, featurePonded } from '../domain/flood'
import type { Catalog } from '../domain/catalog'
import type { BuildingColorMode, FeatureAssertion, TerrainCondition } from '../domain/types'

export type Rgb = [number, number, number]

export const BUILDING_COLOR_MODES: { id: BuildingColorMode; label: string }[] = [
  { id: 'none', label: 'なし' },
  { id: 'usage', label: '用途' },
  { id: 'class', label: '分類' },
  { id: 'depth', label: '浸水深（床下・床上）' },
]

/**
 * 床上浸水とみなす浸水深 [m]。**閾値は地盤面からの水深**である。
 *
 * 外部からの要望（2026-08）が「浸水深 50cm を基準に床下浸水・床上浸水で
 * 建物の色を区別できないか」だったので 0.50 m を既定にしている。
 * catalog に `semantics.floor_above_depth_m` があればそちらを使う。
 *
 * **PLATEAU LOD1 は床高を持たない。** したがってこれは「地盤から 50 cm 浸かった」の
 * 意味であって、その建物の床面を超えたことの証明ではない。土間高は建物ごとに違う。
 * さらに `docs/results.md`「実際の被害記録との突き合わせ」の 2 点が効く:
 *   - 実測の被害記録は **床上 0 戸 / 床下 39・19 戸**、浸水位 1〜20 cm だった
 *     （潮位 0.68 / 0.67 m T.P.）。**要望の「そこまで上がる場所は少ない」は記録と一致する**
 *   - **「浸水位」の定義そのものが未確認**（地盤面からの水深か床面からの高さか）で、
 *     市に照会中（`docs/todo.md` 中 4）。定義が後者なら閾値の意味が変わる
 */
export const FLOOR_ABOVE_DEPTH_M = 0.5

/** 浸水深の区分。順序は凡例の並び */
/**
 * **非浸水は中間の灰。** 明るい灰（旧 `#c9cbd0`）にしていたら、
 * 一律の道路（ほぼ白）と明度が近すぎて寄ったときに区別できなかった（2026-08）。
 *
 * 無彩色は明度で 3 段に分ける。**地面（暗）< 建物（中間）< 道路（明）**。
 * 有彩色は 床下＝黄 / 床上＝赤 / 水＝青 で、無彩色とは当たらない。
 * **窪地は水の色相を薄めて借りる**（新しい色相を足さない）。
 */
export type DepthClass = 'dry' | 'ponded' | 'under' | 'above'

export const DEPTH_CLASSES: { id: DepthClass; label: string; hex: string }[] = [
  { id: 'dry', label: '非浸水', hex: '#9aa1a8' },
  // **窪地は床下・床上の手前に置く。** 「浸水しない」より弱い主張ではなく
  // 「この model では浸水しないが、標高は潮位以下」という別の状態である。
  // 色は地形側の窪地（`three/floodMaterial.ts` の PONDED = 0.44,0.75,0.80）と
  // 同じ水色にして、面と棟が同じものを指していることを見せる
  { id: 'ponded', label: '窪地', hex: '#70bfcc' },
  { id: 'under', label: '床下浸水', hex: '#f4c542' },
  { id: 'above', label: '床上浸水', hex: '#c62828' },
]

export const DEPTH_HEX: Record<DepthClass, string> =
  Object.fromEntries(DEPTH_CLASSES.map((c) => [c.id, c.hex])) as never

/**
 * 浸水深 [m] -> 区分。閾値は「以上」で床上（0.50 m ちょうどは床上）。
 *
 * `ponded` は**浸水深では決まらない**（浸水深は 0 である）。
 * 地盤高が潮位以下なのに `h_conn` が届いていない状態で、呼び側が
 * `featurePonded()` で判定して渡す。
 */
export function depthClass(depth: number, floor: number, ponded = false): DepthClass {
  if (depth <= 0) return ponded ? 'ponded' : 'dry'
  return depth >= floor ? 'above' : 'under'
}

/**
 * 浸水深の凡例。**属性ではなく水位から決まる**ので、
 * 用途の凡例（batch table の値を数える legendOf）とは別に作る。
 *
 * **数えるのは解析対象の全建物**（`objects.geojson` の assertion）で、
 * 画面に読み込めた b3dm タイルではない。3D Tiles は視野の外を取りに行かないので、
 * タイルを数えると **625 ha の範囲では数がパンするたびに変わる**（吉原 100 ha は
 * 22 枚が必ず全部届くので気づけなかった）。「この範囲で床上が何棟」は
 * 視野に依らない事実として出すべき値である。
 */
export function depthLegend(
  assertions: Iterable<FeatureAssertion>,
  condition: TerrainCondition, waterLevel: number, floor: number,
  showPonded = true,
): LegendEntry[] {
  const counts: Record<DepthClass, number> = { dry: 0, ponded: 0, under: 0, above: 0 }
  let unreliable = 0
  let n = 0
  for (const a of assertions) {
    if (a.featureType !== 'bldg:Building') continue
    n++
    // 橋梁・高架などは地盤高が意味を持たない。塗りでも別色にしてあるので分けて出す
    if (a.unreliable) { unreliable++; continue }
    counts[depthClass(featureDepth(a, condition, waterLevel), floor,
                      showPonded && featurePonded(a, condition, waterLevel))]++
  }
  if (n === 0) return []
  const rows: LegendEntry[] = DEPTH_CLASSES
    .map((c) => ({ label: c.label, hex: c.hex, count: counts[c.id] }))
    // 非浸水は常に出す（0 件でも「0 棟」に意味がある）。ほかは出たときだけ
    .filter((r, i) => i === 0 || r.count > 0)
  if (unreliable > 0) rows.push({ label: '地盤高が不定', hex: UNKNOWN_HEX, count: unreliable })
  return rows
}

/** 属性値が空の建物。塗ったものと区別できる中間グレー */
export const UNKNOWN_HEX = '#9aa0a6'
export const UNKNOWN_LABEL = '属性なし'

/** batch table の属性名。3D Tiles 変換後もこの名前で残っている */
export const ATTRIBUTE: Record<'class' | 'usage', string> = {
  class: 'bldg:class',
  usage: 'bldg:usage',
}

/**
 * コードごとの色。出現しないコードにも与えておく（他都市に向けたときに落ちないため）。
 * 面積で支配的なコード（住宅 411 / 普通建物 3001）は彩度を落とし、
 * 少数だが読みたいコード（官公庁・文教厚生・工場）に彩度を回す。
 */
const HEX: Record<string, Record<string, string>> = {
  'bldg:usage': {
    '401': '#4477aa', // 業務施設
    '402': '#ee6677', // 商業施設
    '403': '#cc6677', // 宿泊施設
    '404': '#aa3377', // 商業系複合施設
    '411': '#d9cbb2', // 住宅（最多。ここは背景色に近い扱いにする）
    '412': '#c7a76c', // 共同住宅
    '413': '#e8a33d', // 店舗等併用住宅
    '414': '#d2762a', // 店舗等併用共同住宅
    '415': '#b07aa1', // 作業所併用住宅
    '421': '#882255', // 官公庁施設
    '422': '#44aa99', // 文教厚生施設
    '431': '#117733', // 運輸倉庫施設
    '441': '#999933', // 工場
    '451': '#a6761d', // 農林漁業用施設
    '452': '#6699cc', // 供給処理施設
    '453': '#666666', // 防衛施設
    '454': '#bbbbbb', // その他
    '461': '#7f8489', // 不明（コードとしての「不明」。属性なしとは別）
  },
  'bldg:class': {
    '3000': '#7f8489', // 分類しない建物
    '3001': '#c9cbd0', // 普通建物
    '3002': '#4477aa', // 堅ろう建物
    '3003': '#e8a33d', // 普通無壁舎
    '3004': '#882255', // 堅ろう無壁舎
  },
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export interface ColorScheme {
  mode: 'class' | 'usage'
  /** batch table の属性名 */
  attribute: string
  /** 属性値（表示名でもコードでも可）-> 色。空値・未知の値は undefined */
  colorOf: (value: unknown) => Rgb | undefined
  hexOf: (label: string) => string
}

/**
 * 表示名 -> コード -> 色。コードで入ってくる経路（objects.geojson の属性）も
 * そのまま引けるようにしておく。
 */
export function createColorScheme(catalog: Catalog, mode: 'class' | 'usage'): ColorScheme {
  const attribute = ATTRIBUTE[mode]
  const labels = catalog.semantics.codelists?.[attribute] ?? {}
  const hexes = HEX[attribute] ?? {}
  const byValue = new Map<string, string>()
  for (const [code, hex] of Object.entries(hexes)) byValue.set(code, hex)
  for (const [code, label] of Object.entries(labels)) {
    if (hexes[code]) byValue.set(label, hexes[code])
  }
  return {
    mode,
    attribute,
    hexOf: (label) => byValue.get(label) ?? UNKNOWN_HEX,
    colorOf: (value) => {
      if (value === null || value === undefined || value === '') return undefined
      const hex = byValue.get(String(value))
      return hex ? hexToRgb(hex) : undefined
    },
  }
}

export interface LegendEntry {
  label: string
  hex: string
  count: number
}

/**
 * 凡例。実際に描かれた建物を数える（タイル読み込み時に集めた gml_id -> 属性値）。
 * gml_id で持つのは、同じ建物が複数タイルに出てくる分を二重に数えないため。
 */
export function legendOf(seen: Map<string, string>, scheme: ColorScheme): LegendEntry[] {
  const counts = new Map<string, number>()
  let unknown = 0
  for (const v of seen.values()) {
    if (!v) { unknown++; continue }
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const entries = [...counts.entries()]
    .map(([label, count]) => ({ label, hex: scheme.hexOf(label), count }))
    .sort((a, b) => b.count - a.count)
  if (unknown > 0) entries.push({ label: UNKNOWN_LABEL, hex: UNKNOWN_HEX, count: unknown })
  return entries
}
