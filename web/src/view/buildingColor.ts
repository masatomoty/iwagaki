// PLATEAU 建物の属性による塗り分け。
//
// b3dm には色情報が一切入っていない（texture / COLOR_0 / baseColorFactor すべて無し、
// materials は roughness=metallic=0 のみ）。glTF 既定の白 [1,1,1,1] が陰影を受けて
// グレーに見えているだけなので、色は我々が属性から与える。
//
// 属性値は b3dm の batchTableJson から取る（objects.geojson ではない）。
// batch table は `bldg:class` / `bldg:usage` を **表示名で** 持っているうえ、
// 解析対象 694 棟の外にある建物にも付いている（3D Tiles の全 2,005 棟に付く）。
// 表示名 -> コード は catalog.semantics.codelists（CityGML 配布 zip 同梱の
// コードリスト由来）で引き、色はコードに対して固定する = 表示名の揺れに依存しない。

import type { Catalog } from '../domain/catalog'
import type { BuildingColorMode } from '../domain/types'

export type Rgb = [number, number, number]

export const BUILDING_COLOR_MODES: { id: BuildingColorMode; label: string }[] = [
  { id: 'none', label: 'なし' },
  { id: 'usage', label: '用途' },
  { id: 'class', label: '分類' },
]

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
