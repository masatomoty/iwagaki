// 地物クリック時の表示。値はすべてブラウザ側で h_conn から計算する（サーバ再計算なし）。
//
// **4 条件を横並びにするのをやめた。** 地図はいま 1 つの条件（か 1 組の差分）で
// 塗られているのに、パネルだけが 4 条件を等価に並べていたので、
// 「いま見ているのはどれか」が読めなかった。主にするのは
// `comparisonPair(surface)` の 2 条件で、4 条件の表は畳んで下に置く。

import type { Catalog } from '../domain/catalog'
import { changeBand, decisionChanged, featureDepth, roadClass } from '../domain/flood'
import { comparisonPair } from '../domain/terrain'
import type { ComparisonPair, TerrainCondition } from '../domain/types'
import { TERRAIN_CONDITIONS } from '../domain/types'
import type { Store } from '../state'

const ROAD_CLASS_LABEL = ['支障なし', '≥0.1 m', '≥0.3 m 通行困難', '≥0.5 m']

/** 条件の表示名。controls.ts と同じ語を使う（画面内で呼び名を変えない） */
export const CONDITION_LABEL: Record<TerrainCondition, string> = {
  baseline: 'PLATEAU 5m',
  control: '5m 対照',
  highres: '0.5m',
  pointcloud: '0.5m ＋ 点群',
}

const fmt = (v: number | undefined, u = ' m') =>
  v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}${u}`

const signed = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v) ? '—'
    : `${v > 0 ? '+' : ''}${v.toFixed(2)} m`

/** 4 条件の表。既定では畳んである。検算用に値そのものは残す */
function allConditionsTable(
  a: NonNullable<Store['state']['selected']>, H: number, th: number[], isRoad: boolean,
): string {
  const depthOf = (c: TerrainCondition) =>
    a.hConn[c] === undefined ? undefined : featureDepth(a, c, H)
  const cell = (c: TerrainCondition, v: string) => `<td class="num">${v}</td>`
  const row = (label: string, f: (c: TerrainCondition) => string) =>
    `<tr><td>${label}</td>${TERRAIN_CONDITIONS.map((c) => cell(c, f(c))).join('')}</tr>`
  return `
    <table>
      <tr><td></td>${TERRAIN_CONDITIONS.map((c) =>
        `<td class="num">${CONDITION_LABEL[c]}</td>`).join('')}</tr>
      ${row('地盤高', (c) => fmt(a.groundElev[c]))}
      ${row('h_conn', (c) => fmt(a.hConn[c]))}
      ${row('浸水深', (c) => fmt(depthOf(c)))}
      ${isRoad ? row('通行', (c) => {
        const d = depthOf(c)
        return d === undefined ? '—' : ROAD_CLASS_LABEL[roadClass(d, th)]
      }) : ''}
    </table>`
}

/** いま見ている条件の値。ここが主 */
function currentTable(
  a: NonNullable<Store['state']['selected']>, pair: ComparisonPair,
  H: number, th: number[], isRoad: boolean,
): string {
  const to = pair.to
  const from = pair.from
  const dTo = a.hConn[to] === undefined ? undefined : featureDepth(a, to, H)
  const dFrom = a.hConn[from] === undefined ? undefined : featureDepth(a, from, H)
  const dg = a.groundElev[to] !== undefined && a.groundElev[from] !== undefined
    ? a.groundElev[to]! - a.groundElev[from]! : undefined
  const dd = dTo !== undefined && dFrom !== undefined ? dTo - dFrom : undefined
  const same = from === to
  return `
    <table>
      <tr><td>地盤高</td><td class="num">${fmt(a.groundElev[to])}</td></tr>
      <tr><td>h_conn</td><td class="num">${fmt(a.hConn[to])}</td></tr>
      <tr><td>浸水深</td><td class="num">${fmt(dTo)}</td></tr>
      ${isRoad ? `<tr><td>通行</td><td class="num">${
        dTo === undefined ? '—' : ROAD_CLASS_LABEL[roadClass(dTo, th)]}</td></tr>` : ''}
    </table>
    ${same ? '' : `
      <p class="grouplabel">${CONDITION_LABEL[from]} との差</p>
      <table>
        <tr><td>地盤高</td><td class="num">${signed(dg)}</td></tr>
        <tr><td>浸水深</td><td class="num">${signed(dd)}</td></tr>
      </table>`}`
}

export function renderInspector(el: HTMLElement, store: Store, catalog: Catalog) {
  const a = store.state.selected
  if (!a) { el.style.display = 'none'; return }
  el.style.display = 'block'
  const H = store.state.waterLevel
  const th = catalog.semantics.road_depth_classes_m
  const pair = comparisonPair(store.state.surface)
  const changed = decisionChanged(a, H, th, pair)
  const band = changeBand(a, pair)
  const isRoad = a.featureType === 'tran:Road'
  const same = pair.from === pair.to

  el.innerHTML = `
    <div class="insp-head">
      <h1>${a.featureType === 'bldg:Building' ? '建築物' : isRoad ? '道路' : a.featureType}</h1>
      <button id="insp-close" type="button" title="選択を外す">×</button>
    </div>
    <p class="sub" style="word-break:break-all">${a.gmlId}</p>
    ${a.unreliable
      ? `<p><span class="tag warn">解析対象外</span> ${a.sectionTypeLabel ?? a.unreliableReason ?? ''}
           — 路面が地表面と一致しないため DTM 由来の地盤高は無意味</p>`
      : same
        ? `<p><span class="tag same">基準そのもの</span>
             <span class="sub"> ${CONDITION_LABEL[pair.to]} を単独で見ている</span></p>`
        : `<p><span class="tag ${changed ? 'chg' : 'same'}">${
             changed ? '判定が変わる' : '判定は同じ'}</span>
             <span class="sub"> ${CONDITION_LABEL[pair.from]} → ${CONDITION_LABEL[pair.to]}
             @ H = ${H.toFixed(2)} m T.P.</span></p>`}

    <p class="grouplabel">${CONDITION_LABEL[pair.to]}${same ? '' : '（いま見ている条件）'}</p>
    ${currentTable(a, pair, H, th, isRoad)}

    <table>
      ${band ? `<tr><td>判定が割れる水位帯</td><td class="num">
        ${band[0].toFixed(2)} 〜 ${band[1].toFixed(2)} m T.P.</td></tr>` : ''}
      ${a.areaM2 !== undefined
        ? `<tr><td>面積</td><td class="num">${a.areaM2.toFixed(1)} m²</td></tr>` : ''}
      ${a.sectionTypeLabel
        ? `<tr><td>区間種別</td><td class="num">${a.sectionTypeLabel}</td></tr>` : ''}
    </table>

    <details>
      <summary>全条件</summary>
      <div class="inner">${allConditionsTable(a, H, th, isRoad)}</div>
    </details>

    <div class="note">h_conn = 海側と連結して浸水し始める最小水位。
      水位を動かしてもサーバには問い合わせず、この値から即座に計算している。</div>
  `
}
