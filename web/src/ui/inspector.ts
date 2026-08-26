// 地物クリック時の表示。値はすべてブラウザ側で h_conn から計算する（サーバ再計算なし）。
//
// **4 条件を横並びにするのをやめた。** 地図はいま 1 つの条件（か 1 組の差分）で
// 塗られているのに、パネルだけが 4 条件を等価に並べていたので、
// 「いま見ているのはどれか」が読めなかった。出すのは
// `comparisonPair(surface)` の 2 条件だけにしてある。
// 4 条件ぶんの値は `FeatureAssertion` が持っているので、要るときは
// `__iwagaki.store.state.selected` から引ける（画面には出さない）。

import type { Catalog } from '../domain/catalog'
import { changeBand, decisionChanged, featureDepth, featurePonded, roadClass } from '../domain/flood'
import { comparisonPair } from '../domain/terrain'
import type { ComparisonPair, FloodModel, TerrainCondition } from '../domain/types'
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

/** いま見ている条件の値。ここが主 */
function currentTable(
  a: NonNullable<Store['state']['selected']>, pair: ComparisonPair,
  H: number, th: number[], isRoad: boolean, model: FloodModel,
): string {
  const to = pair.to
  const from = pair.from
  const dTo = a.hConn[to] === undefined ? undefined : featureDepth(a, to, H, model)
  const dFrom = a.hConn[from] === undefined ? undefined : featureDepth(a, from, H, model)
  const dg = a.groundElev[to] !== undefined && a.groundElev[from] !== undefined
    ? a.groundElev[to]! - a.groundElev[from]! : undefined
  const dd = dTo !== undefined && dFrom !== undefined ? dTo - dFrom : undefined
  const same = from === to
  // **窪地のときは「浸水深 0」で終わらせない。**
  // 「地盤高 0.8 m のところで潮位 0.9 m にしても浸水深が 0 のまま」という
  // 指摘（2026-08、東舞鶴）に、パネルが何も答えていなかった。
  // 0 なのは標高が足りているからではなく、**地表面で海とつながらない**からで、
  // その差（潮位 − 地盤高）と h_conn を並べれば理由がその場で読める
  const pond = featurePonded(a, to, H, model)
  const below = pond ? H - a.groundElev[to]! : undefined
  return `
    <table>
      <tr><td>地盤高</td><td class="num">${fmt(a.groundElev[to])}</td></tr>
      ${model === 'connected'
        ? `<tr><td>h_conn</td><td class="num">${fmt(a.hConn[to])}</td></tr>` : ''}
      <tr><td>浸水深</td><td class="num">${fmt(dTo)}</td></tr>
      ${pond ? `<tr><td>潮位より低い</td><td class="num">${fmt(below)}</td></tr>` : ''}
      ${isRoad ? `<tr><td>通行</td><td class="num">${
        dTo === undefined ? '—' : ROAD_CLASS_LABEL[roadClass(dTo, th)]}</td></tr>` : ''}
    </table>
    ${model === 'simple' && dTo !== undefined && dTo > 0
      ? `<div class="note">浸水深 = 潮位 ${H.toFixed(2)} − 地盤高
          ${a.groundElev[to]!.toFixed(2)} = <b>${dTo.toFixed(2)} m</b>。
          <b>連結性は問うていない</b>（排水路などを通じて、潮位より地盤高が低い箇所は
          その差だけ浸水しているという現場の経験則に合わせた。舞鶴市、2026-08）。
          海側から地表面をたどって到達するのは潮位 ${fmt(a.hConn[to])} から</div>` : ''}
    ${pond ? `<div class="note"><b>窪地。</b>標高は潮位より
      ${below!.toFixed(2)} m 低いが、地表面をたどると海に出ないので
      本モデルでは浸水深 0 になる（海側からつながるのは潮位
      ${fmt(a.hConn[to])} から）。<b>排水路の吐口にフラップゲートが無い</b>ので、
      実際には管路を逆流して浸水しうる。逆流は本モデルに含まない</div>` : ''}
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
  const model = store.state.floodModel
  const changed = decisionChanged(a, H, th, pair, model)
  const band = changeBand(a, pair, model)
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
    ${currentTable(a, pair, H, th, isRoad, model)}

    <table>
      ${band ? `<tr><td>判定が割れる水位帯</td><td class="num">
        ${band[0].toFixed(2)} 〜 ${band[1].toFixed(2)} m T.P.</td></tr>` : ''}
      ${a.areaM2 !== undefined
        ? `<tr><td>面積</td><td class="num">${a.areaM2.toFixed(1)} m²</td></tr>` : ''}
      ${a.sectionTypeLabel
        ? `<tr><td>区間種別</td><td class="num">${a.sectionTypeLabel}</td></tr>` : ''}
    </table>

    <div class="note">${model === 'connected'
      ? `h_conn = 海側と連結して浸水し始める最小水位。`
      : `浸水深 = 潮位 − 地盤高（単純モデル）。`}
      水位を動かしてもサーバには問い合わせず、その場で計算している。</div>
  `
}
