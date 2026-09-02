// 「地点＋徒歩圏」パネル（`docs/todo.md` T1）。地図で 1 点を指定し、
// 半径 500/800/1000 m を切り替えて、事前生成済みの ①人口・年齢 ②建物用途 ⑤交通 を出す。
//
// **既存のメニュー（`ui/controls.ts`）とは独立した小さな部品にしてある。**
// main.ts が持つべきなのは「地図クリック -> lon/lat」と「catalog.point_buffer の
// 索引を取得する」の 2 つだけで、それ以外（半径の状態・索引から最寄り地点を探す・
// 結果 JSON の取得と表示）はここで完結する（統合の当たり面を小さくするため）。
//
// `mountPointBufferPanel` は最初の 1 回だけ骨格 DOM を作り、以後は
// `updatePointBufferPanel` が中身だけ書き換える（`ui/controls.ts` の legend / areaflood
// と同じ規約）。three / maplibre-gl は import しない。

import {
  isUnavailable, metersBetween, nearestIndexEntry, parsePointBufferResult,
  POINT_BUFFER_RADII, sectionAt,
  type PointBufferIndex, type PointBufferRadius, type PointBufferResult,
} from '../domain/pointBuffer'

export type LonLat = [number, number]

export interface PointBufferPanelDeps {
  /** 相対 URL を取って中身の JSON を返す（`Scheduler.submit` を main.ts 側で包む） */
  fetchJson: (url: string) => Promise<unknown>
}

export interface PointBufferPanelCallbacks {
  /** 「地点を選ぶ」ボタンが押された。地図の pick モードを切り替えるのは呼び側 */
  onTogglePick: () => void
  /** 半径セグメントを押した */
  onSelectRadius: (r: PointBufferRadius) => void
}

/** 索引の `url` を基準に、同じディレクトリのファイル名を解決する */
function siblingUrl(indexUrl: string, filename: string): string {
  const i = indexUrl.lastIndexOf('/')
  return i === -1 ? filename : `${indexUrl.slice(0, i + 1)}${filename}`
}

/** 索引に対して許容する「最寄り」の距離 [m]。これを超えたら別地点として扱う */
const MATCH_TOLERANCE_M = 120

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`
}

function usageRows(section: PointBufferResult['byRadius'][string]['2_building_usage']): string {
  if (isUnavailable(section)) return `<div class="sub">${section.note}</div>`
  if (section.totalBuildings === 0) return '<div class="sub">円内に建物が無い</div>'
  const top = section.byUsage.slice(0, 6)
  const rest = section.byUsage.length - top.length
  const restCount = section.byUsage.slice(6).reduce((a, r) => a + r.count, 0)
  return `<table class="areatab"><tbody>${top.map((r) =>
    `<tr><td>${r.label}</td><td class="num">${r.count}</td></tr>`).join('')}
    ${rest > 0 ? `<tr class="ar"><td>ほか ${rest} 種</td><td class="num">${restCount}</td></tr>` : ''}
    <tr class="at"><td>合計</td><td class="num">${section.totalBuildings}</td></tr>
    </tbody></table>`
}

function transportHtml(section: PointBufferResult['byRadius'][string]['5_transport']): string {
  if (isUnavailable(section)) return `<div class="sub">${section.note}</div>`
  return `<div>道路 <b>${section.plateauRoadSegments}</b> 本`
    + `<span class="sub"> 円内の面積 ${Math.round(section.plateauRoadAreaM2InCircle).toLocaleString()} m²`
    + `（円の ${pct(section.roadAreaRatio)}）</span></div>`
    + `<div class="sub">${section.note}</div>`
}

function radiusSectionHtml(sections: PointBufferResult['byRadius'][string]): string {
  const pop = sections['1_population_and_age']
  const covWarn = pop.coverageComplete ? '' : '<div class="sub">'
    + `円の一部（被覆 ${pct(pop.boundaryCoverageFraction)}）が小地域境界の外。人口は過小評価側</div>`
  const ages = pop.ageDistribution
  return `
    <p class="grouplabel" style="margin-top:11px">① 人口・年齢</p>
    <div>推計人口 <b>${Math.round(pop.populationEstimate).toLocaleString()}</b> 人
      <span class="sub"> 高齢化率 ${pct(pop.agingRate65Plus)}</span></div>
    <div class="sub">${ages.age_0_14.label} ${Math.round(ages.age_0_14.count)}
      ／ ${ages.age_15_64.label} ${Math.round(ages.age_15_64.count)}
      ／ ${ages.age_65_plus.label} ${Math.round(ages.age_65_plus.count)}</div>
    ${covWarn}
    <p class="grouplabel" style="margin-top:11px">② 建物用途</p>
    ${usageRows(sections['2_building_usage'])}
    <p class="grouplabel" style="margin-top:11px">⑤ 交通</p>
    ${transportHtml(sections['5_transport'])}
    <p class="grouplabel" style="margin-top:11px">③ 事業所数 ／ ④ 用途地域</p>
    <div class="sub">${sections['3_establishments'].note}</div>`
}

function resultHtml(state: PointBufferPanelState): string {
  if (!state.picked) {
    return '<div class="sub">「地点を選ぶ」を押して地図をクリックすると、'
      + 'その付近で事前に集計済みの地点があれば表示する</div>'
  }
  if (state.loading) return '<div class="sub">読み込み中…</div>'
  if (state.error) return `<div class="sub">${state.error}</div>`
  if (!state.match || !state.result) {
    return '<div class="sub"><b>この地点の集計はまだ生成されていない。</b>'
      + '任意の地点をその場で計算する仕組みは無く（新しい外部 API・サーバ計算は'
      + '追加しない方針）、事前に生成した地点だけを表示できる。'
      + '別の地点を試すか、地点の追加は解析側に依頼する</div>'
  }
  const sections = sectionAt(state.result, state.radius)
  if (!sections) return `<div class="sub">半径 ${state.radius} m の集計が無い</div>`
  const nearNote = state.match.distanceM > 1
    ? `<div class="sub">クリック地点から ${Math.round(state.match.distanceM)} m の`
      + `既存地点「${state.result.label}」の集計を表示</div>`
    : ''
  return `<div><b>${state.result.label}</b></div>${nearNote}${radiusSectionHtml(sections)}`
}

export interface PointBufferPanelState {
  radius: PointBufferRadius
  pickActive: boolean
  picked?: LonLat
  loading: boolean
  error?: string
  match?: { distanceM: number }
  result?: PointBufferResult
}

export function initialPointBufferState(): PointBufferPanelState {
  return { radius: 800, pickActive: false, loading: false }
}

/** 初回だけ呼ぶ。骨格 DOM を作り、イベントを配線する */
export function mountPointBufferPanel(
  el: HTMLElement, state: PointBufferPanelState, cb: PointBufferPanelCallbacks,
): void {
  el.innerHTML = `
    <p class="subhead" style="margin-top:0">地点＋徒歩圏</p>
    <button class="btnwide" id="pbbtn" type="button" aria-pressed="${state.pickActive}"
            data-tip="地図を 1 点クリックして集計の中心を指定する。Esc で中止">地点を選ぶ</button>
    <p class="grouplabel" style="margin-top:9px">半径</p>
    <div class="seg" id="pbradius">${POINT_BUFFER_RADII.map((r) =>
      `<button data-r="${r}" type="button"
               aria-pressed="${r === state.radius}">${r} m</button>`).join('')}</div>
    <div id="pbresult">${resultHtml(state)}</div>
  `
  el.dataset.built = '1'
  el.querySelector('#pbbtn')!.addEventListener('click', () => cb.onTogglePick())
  el.querySelector('#pbradius')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-r]')
    if (b) cb.onSelectRadius(Number(b.dataset.r) as PointBufferRadius)
  })
}

/** 状態が変わるたびに呼ぶ。ボタンの見た目と結果欄だけを書き換える */
export function updatePointBufferPanel(el: HTMLElement, state: PointBufferPanelState): void {
  const pb = el.querySelector<HTMLButtonElement>('#pbbtn')
  if (pb) {
    pb.setAttribute('aria-pressed', String(state.pickActive))
    pb.textContent = state.pickActive ? '地図をクリック（Esc で中止）' : '地点を選ぶ'
  }
  for (const b of el.querySelectorAll<HTMLButtonElement>('#pbradius button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.r) === state.radius))
  }
  const out = el.querySelector('#pbresult')
  if (out) out.innerHTML = resultHtml(state)
}

/**
 * クリック地点から、索引の最寄り地点の結果を取得する。
 * `MATCH_TOLERANCE_M` を超えたら「データなし」（`state.match` が undefined のまま）。
 */
export async function loadPointBufferResult(
  index: PointBufferIndex, indexUrl: string, picked: LonLat, deps: PointBufferPanelDeps,
): Promise<{ match?: { distanceM: number }; result?: PointBufferResult; error?: string }> {
  const hit = nearestIndexEntry(index, picked[0], picked[1], MATCH_TOLERANCE_M)
  if (!hit) return {}
  try {
    const json = await deps.fetchJson(siblingUrl(indexUrl, hit.entry.url))
    return { match: { distanceM: hit.distanceM }, result: parsePointBufferResult(json) }
  } catch {
    return { match: { distanceM: hit.distanceM }, error: '集計データの取得に失敗した' }
  }
}

/** デバッグ・テスト用に露出（`metersBetween` を使う UI 側の距離表示ロジックの検証） */
export const _internal = { siblingUrl, metersBetween }
