// 地物クリック時の表示。値はすべてブラウザ側で h_conn から計算する（サーバ再計算なし）。

import type { Catalog } from '../domain/catalog'
import { changeBand, decisionChanged, featureDepth, roadClass } from '../domain/flood'
import type { TerrainCondition } from '../domain/types'
import type { Store } from '../state'

const ROAD_CLASS_LABEL = ['支障なし', '≥0.1 m', '≥0.3 m 通行困難', '≥0.5 m']

const fmt = (v: number | undefined, u = ' m') =>
  v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}${u}`

export function renderInspector(el: HTMLElement, store: Store, catalog: Catalog) {
  const a = store.state.selected
  if (!a) { el.style.display = 'none'; return }
  el.style.display = 'block'
  const H = store.state.waterLevel
  const th = catalog.semantics.road_depth_classes_m
  const db = featureDepth(a, 'baseline', H)
  const dh = featureDepth(a, 'highres', H)
  // control / pointcloud は属性が無い地物もある（点群は歩いた帯にしか無い）。
  // その場合 featureDepth は 0 を返すので、h_conn が未定義なら「—」を出す
  const depthOf = (c: TerrainCondition) =>
    a.hConn[c] === undefined ? undefined : featureDepth(a, c, H)
  const roadLabel = (d: number | undefined) =>
    d === undefined ? '—' : ROAD_CLASS_LABEL[roadClass(d, th)]
  const changed = decisionChanged(a, H, th)
  const band = changeBand(a)
  const isRoad = a.featureType === 'tran:Road'

  el.innerHTML = `
    <h1>${a.featureType === 'bldg:Building' ? '建築物' : isRoad ? '道路' : a.featureType}</h1>
    <p class="sub" style="word-break:break-all">${a.gmlId}</p>
    ${a.unreliable
      ? `<p><span class="tag warn">解析対象外</span> ${a.sectionTypeLabel ?? a.unreliableReason ?? ''}
           — 路面が地表面と一致しないため DTM 由来の地盤高は無意味</p>`
      : `<p><span class="tag ${changed ? 'chg' : 'same'}">${changed ? '判定が変わる' : '判定は同じ'}</span>
           <span class="sub"> @ H = ${H.toFixed(2)} m T.P.</span></p>`}
    <table>
      <tr><td></td><td class="num">PLATEAU 5m</td><td class="num">0.5m</td>
          <td class="num">5m 対照</td><td class="num">点群融合</td></tr>
      <tr><td>地盤高</td><td class="num">${fmt(a.groundElev.baseline)}</td><td class="num">${fmt(a.groundElev.highres)}</td>
          <td class="num">${fmt(a.groundElev.control)}</td><td class="num">${fmt(a.groundElev.pointcloud)}</td></tr>
      <tr><td>h_conn</td><td class="num">${fmt(a.hConn.baseline)}</td><td class="num">${fmt(a.hConn.highres)}</td>
          <td class="num">${fmt(a.hConn.control)}</td><td class="num">${fmt(a.hConn.pointcloud)}</td></tr>
      <tr><td>浸水深</td><td class="num">${fmt(db)}</td><td class="num">${fmt(dh)}</td>
          <td class="num">${fmt(depthOf('control'))}</td><td class="num">${fmt(depthOf('pointcloud'))}</td></tr>
      ${isRoad ? `<tr><td>通行</td><td class="num">${ROAD_CLASS_LABEL[roadClass(db, th)]}</td>
                      <td class="num">${ROAD_CLASS_LABEL[roadClass(dh, th)]}</td>
                      <td class="num">${roadLabel(depthOf('control'))}</td>
                      <td class="num">${roadLabel(depthOf('pointcloud'))}</td></tr>` : ''}
      <tr><td>差 (0.5m − 5m)</td><td class="num" colspan="4">
        地盤高 ${fmt(a.groundElev.highres !== undefined && a.groundElev.baseline !== undefined
          ? a.groundElev.highres - a.groundElev.baseline : undefined)} /
        浸水深 ${fmt(dh - db)}</td></tr>
      ${band ? `<tr><td>判定が割れる水位帯</td><td class="num" colspan="4">
        ${band[0].toFixed(2)} 〜 ${band[1].toFixed(2)} m T.P.</td></tr>` : ''}
      ${a.areaM2 !== undefined ? `<tr><td>面積</td><td class="num" colspan="4">${a.areaM2.toFixed(1)} m²</td></tr>` : ''}
      ${a.sectionTypeLabel ? `<tr><td>区間種別</td><td class="num" colspan="4">${a.sectionTypeLabel}</td></tr>` : ''}
    </table>
    <div class="note">h_conn = 海側と連結して浸水し始める最小水位。
      水位を動かしてもサーバには問い合わせず、この値から即座に計算している。</div>
  `
}
