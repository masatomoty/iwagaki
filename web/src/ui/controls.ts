// 操作パネル。
//
// **メニューに出すのは「操作すると状態が変わるもの」だけにしてある。**
// 以前は 8 つの fieldset がフラットに並んでいて、入力（地形条件・水位）と
// 見せ方と道具と出典が同じ階層にあった。268 px × 56 % の枠では、主張の
// 2 変数（地形条件と水位 H）を同時に見ることすらできなかった。
//
// 分け方は 3 つ。
//
// | 種類 | 置き場所 |
// |---|---|
// | 変数（操作すると状態が変わる） | ここ。頭は固定、それ以外はスクロール |
// | 出力（変数から計算されて出る） | 変数の直下（凡例）か専用パネル（内訳・断面・計測） |
// | 定数（データに付いてくる事実） | 「このデータについて」に 1 か所。出典だけ画面下辺 |
//
// **状態そのものは削っていない。** `web/perf` の計測ハーネス 28 本が
// `setLayer('flood'|'ground'|'semantics'|'pcCoverage')` や `setBuildingColor('class')` を
// 叩いていて、`docs/web_results.md` の実測値はそこから出ている。
// メニューに出さないだけで、`__iwagaki` からは全部触れる。

import type { Area, AreaIndex } from '../domain/areas'
import type { Catalog } from '../domain/catalog'
import { comparisonPair } from '../domain/terrain'
import type { BuildingColorMode, SurfaceMode, TerrainCondition } from '../domain/types'
import type { Store } from '../state'
import {
  BUILDING_COLOR_MODES, UNKNOWN_HEX, UNKNOWN_LABEL, type LegendEntry,
} from '../view/buildingColor'

/** `[` `]` キーが回る段。**キーは 5 段すべて**、メニューは 3 段だけ出す */
export const EXAGGERATIONS = [1, 2, 5, 10, 20] as const

/** メニューに出す段。×2 と ×10 を押し分ける判断が発生しないので落とした */
const MENU_EXAGGERATIONS = [1, 5, 20] as const

/**
 * 建物の塗り分けでメニューに出すもの。`class`（普通建物・堅ろう建物）は
 * 浸水の話に効かないので出さない（`__iwagaki.setBuildingColor('class')` で触れる。
 * `perf/bldgcolor.mjs` は全モードを回すので値そのものは残す）。
 */
const MENU_BUILDING_COLORS = BUILDING_COLOR_MODES.filter((m) => m.id !== 'class')

/**
 * 地形条件は 4 つ。**同時に 2 枚は描けない**（同じ場所の標高を 4 通りに測ったもので、
 * メッシュが数十 cm 差で交差する。`main.ts` が粗メッシュと細メッシュで
 * 同じ問題を避けているのと同じ理由）ので、チェックボックスではなく 1 つ選ぶ。
 *
 * 並びは作られ方の順。源を替える → 解像度を上げる → 地上観測を足す。
 * `5m 対照` は「4 つ目の選択肢」ではなく **源だけを替えた地点**なので、
 * `PLATEAU 5m` の隣に置かないとその意味が読めない。
 * ボタンを 4 つ並べるのはやめて `<select>` にしたが、**この順序は option の
 * 並びとして残る**（開けば梯子が見える）。
 */
const CONDITIONS: { id: TerrainCondition; label: string; hint: string }[] = [
  { id: 'baseline', label: 'PLATEAU 5m',
    hint: 'PLATEAU 地形モデル LOD1 TIN（5 m 格子）。ここが出発点' },
  { id: 'control', label: '5m 対照',
    hint: '0.5m DEM を 5 m に平均集約。源だけを替えて解像度は上げていない対照' },
  { id: 'highres', label: '0.5m',
    hint: '京都府 数値標高モデル 0.5 m（航空レーザ 2019-2023）' },
  { id: 'pointcloud', label: '0.5m ＋ 点群',
    hint: '0.5m DEM に地上点群（バックパック SLAM 2026-07）の地表面を融合' },
]

/**
 * 条件を選んだときに `判定差` が出す差分。
 *
 * - `control`    源だけを替えた差（`diff_src`）
 * - `highres`    源 ＋ 解像度の合計（`diff`）。**README と docs/results.md の見出しの図**
 * - `pointcloud` 地上観測が足した分（`diff_pc`）
 *
 * `diff_res`（解像度だけ）も焼いてあるが、ここには載せていない。`highres` に
 * 割り当てると「0.5m の判定差」の意味が合計 12.7 % から解像度だけの 3.4 % に
 * 変わり、公表済みの見出しと食い違うため。`setSurface('diff_res')` で触れる。
 */
const DIFF_OF: Partial<Record<TerrainCondition, SurfaceMode>> = {
  control: 'diff_src',
  highres: 'diff',
  pointcloud: 'diff_pc',
}

/**
 * **その範囲が配信している条件だけを出す。** 面的表示用の 2 範囲は
 * `baseline` と `highres` しか焼いていない（点群が無く、`control` はタイルを
 * 焼いていない）。出してしまうと選んでもタイルが 404 になる。
 */
function conditionsOf(catalog: Catalog) {
  const have = CONDITIONS.filter((c) => catalog.terrain[c.id])
  return have.length ? have : CONDITIONS
}

/** 点群が無い範囲では「点群」のチェックを出さない（押しても何も出ない） */
function layersOf(catalog: Catalog) {
  return LAYERS.filter((l) => l.key !== 'pointcloud' || !!catalog.pointcloud?.url)
}

const surfaceCondition = (s: SurfaceMode): TerrainCondition => comparisonPair(s).to
const isDiff = (s: SurfaceMode) =>
  s === 'diff' || s === 'diff_src' || s === 'diff_res' || s === 'diff_pc'

/**
 * メニューに出すレイヤ。`flood` / `ground` / `semantics` / `pcCoverage` は出さない。
 *
 * `waterSurface` と `roads` は外部からの要望で足した（2026-08）。
 * どちらも**配信物が増えないので既定 ON にできる**（水面は同じタイルを 2 回描くだけ、
 * 道路は前から objects.geojson に入っていて描いてもいた）。
 */
type LayerKey = 'waterSurface' | 'roads' | 'plateau' | 'pointcloud'
const LAYERS: { key: LayerKey; label: string; hint?: string }[] = [
  { key: 'waterSurface', label: '水面',
    hint: '潮位の高さに水平な水面を張る。切ると浸水域を地面の色だけで見る' },
  { key: 'roads', label: '道路（PLATEAU）',
    hint: '浸かると通行支障クラスで塗る。閾値は解析側の 0.1 / 0.3 / 0.5 m' },
  { key: 'plateau', label: 'PLATEAU 建物' },
  { key: 'pointcloud', label: '点群' },
]

/**
 * 凡例は 1 か所にまとめる。**画面に出ている色は 1 セットなのに、
 * 以前は読む場所が 3 つあった**（Legend / 建物の色 / 地形の凡例に混ざった赤）。
 */
function legendHtml(
  s: Store['state'], buildingLegend: LegendEntry[],
): string {
  const pair = comparisonPair(s.surface)
  const label: Record<TerrainCondition, string> =
    Object.fromEntries(CONDITIONS.map((c) => [c.id, c.label])) as never
  const rows: string[] = []

  if (isDiff(s.surface)) {
    rows.push(
      `<div><i style="background:#ed3830"></i>${label[pair.to]} でのみ浸水</div>`,
      `<div><i style="background:#f7d129"></i>${label[pair.from]} でのみ浸水</div>`,
      `<div><i style="background:#2a5794"></i>どちらも浸水</div>`)
  } else {
    rows.push('<div><i style="background:#6bccf2"></i>浅い &nbsp;'
      + '<i style="background:#0d2985"></i>深い（0〜3 m）</div>')
  }
  // **水深が分からない水域は別に出す。** 航空レーザは水面から反射が返らないので
  // 港と湾は 0.5m DEM では nodata である。水面は張れる（連結しているかは
  // h_conn が知っている）が、深さは知らない。ランプの色で塗ると嘘になる
  if (s.layers.waterSurface) {
    rows.push('<div><i style="background:#174c8c"></i>水深不明の水域'
      + '<span class="sub"> 航空レーザが水面を計測しない</span></div>')
  }
  // 判定が変わる地物は、比較のペアが決まっているときだけ出る
  if (pair.from !== pair.to) {
    rows.push(`<div><i style="background:#f24434"></i>判定が変わる地物`
      + `<span class="sub"> ${label[pair.from]} → ${label[pair.to]}</span></div>`)
  }
  // 道路。**建物と別の配色**にしてあるので、凡例も別に 1 行出す
  // （`three/semanticsMesh.ts` の ROAD_DRY / ROAD_WET と同じ色）
  if (s.layers.roads) {
    rows.push('<div><i style="background:#ffe699"></i>道路 &nbsp;'
      + ['#a1cce6', '#f5c740', '#e68529', '#943d30']
        .map((h) => `<i style="background:${h}"></i>`).join('')
      + '<span class="sub"> 通行支障 0.1 / 0.3 / 0.5 m</span></div>')
  }
  return `<div class="legend">${rows.join('')}</div>`
}

/**
 * 建物の用途の凡例。**頭ではなく「用途で塗る」の直下に置く。**
 * 凡例は独立した節ではなく、それを出している変数の子である。
 * 頭に混ぜると 11 種で頭が倍の高さになり、肝心の入力が押し出される。
 */
function buildingLegendHtml(s: Store['state'], entries: LegendEntry[]): string {
  if (s.buildingColor === 'none' || s.exaggeration > 1
      || !s.layers.plateau || entries.length === 0) return ''
  // 浸水深モードは**属性ではなく潮位から決まる**ので、閾値を凡例に添える。
  // PLATEAU LOD1 は床高を持たないため「地盤から 50 cm」の意味であることも書く
  if (s.buildingColor === 'depth') {
    return `<div class="legend">${entries.map((e) =>
      `<div><i style="background:${e.hex}"></i>${e.label}<span class="sub"> ${e.count} 棟</span></div>`)
      .join('')}<div class="sub">床上 = 地盤面から 0.50 m 以上（床高は考慮しない）</div></div>`
  }
  const top = entries.slice(0, 4)
  const rest = entries.length - top.length
  return `<div class="legend">${top.map((e) =>
    `<div><i style="background:${e.hex}"></i>${e.label}<span class="sub"> ${e.count}</span></div>`).join('')}
    ${rest > 0 ? `<div class="sub">ほか ${rest} 種 ＋ ${UNKNOWN_LABEL}`
      + `<i style="background:${UNKNOWN_HEX};margin-left:5px"></i></div>` : ''}</div>`
}

/**
 * いま何を見ているか。1 行だけ。
 * データの由来（`CONDITIONS[].hint`）は画面に出さない。select の title に残す。
 */
function nowLine(s: Store['state']): string {
  const cond = surfaceCondition(s.surface)
  const c = CONDITIONS.find((x) => x.id === cond)!
  const pair = comparisonPair(s.surface)
  const label = (id: TerrainCondition) => CONDITIONS.find((x) => x.id === id)!.label
  const head = isDiff(s.surface)
    ? `${label(pair.from)} と ${label(pair.to)} の判定差`
    : `${c.label} の浸水`
  return `<b>${head}</b> @ H = ${s.waterLevel.toFixed(2)} m T.P.`
}

/**
 * 頭に出す参照潮位。**既定は「普段」（平均水面）**なので、上げたあと戻れるように
 * それも 1 つ置く。6 件全部と出典は「このデータについて」に置く。
 */
const CHIPS: { key: string; label: string }[] = [
  { key: 'MSL', label: '普段' },
  { key: '高潮想定の基準潮位', label: '高潮想定' },
  { key: '既往最高潮位', label: '既往最高' },
]

function pickChips(refs: [string, number][]): [string, number, string][] {
  const out: [string, number, string][] = []
  for (const c of CHIPS) {
    const hit = refs.find(([n]) => n === c.key)
    if (hit) out.push([hit[0], hit[1], c.label])
  }
  // 名前が違う配信物でも黙って空にはしない。低い方と高い方を出す
  if (out.length === 0 && refs.length >= 2) {
    return [[refs[0][0], refs[0][1], refs[0][0]],
            [refs[refs.length - 1][0], refs[refs.length - 1][1], refs[refs.length - 1][0]]]
  }
  return out
}

/**
 * 参照潮位の一覧。押すと水位が動く。
 * 頭のチップに出す 3 つ（普段・高潮想定・既往最高）以外もここから選べる。
 *
 * 出典と既知の限界の文章はここに置いていた。**画面には出さない**
 * （`README.md` と `docs/results.md` が持っている）。出典表記だけは
 * ライセンス上の要求なので画面下辺（`#attrib`）に常時出る。
 */
function refListHtml(refs: [string, number][]): string {
  return `<div class="reflist" id="refs">${refs.map(([k, v]) =>
    `<button data-h="${v}" type="button" title="T.P. ${v.toFixed(3)} m"
    >${k}<b>${v.toFixed(2)}</b></button>`).join('')}</div>`
}

/**
 * 初回だけ DOM を作り、以後は変わった箇所だけ書き換える。
 * 毎回 innerHTML を作り直すと、水位スライダを掴んでいる最中に
 * スライダ自身の DOM が消えて作り直される（掴み直しが必要になる）。
 */
/**
 * 対象範囲。**範囲を替えるとページごと読み直す。**
 *
 * 範囲が変わると `local_frame`（ローカル ENU の原点と回転）・タイルの URL・
 * 地物・3D Tiles・既定の視点が**すべて**入れ替わる。差分で入れ替える経路を
 * 用意すると `main.ts` の組み立てが二重になるので、`?area=<id>` を付けて
 * 読み直す。庁内で「範囲を行き来しながら見る」使い方は聞いていない [未確認]。
 */
export interface AreaChoice {
  index: AreaIndex
  current: Area
}

function areaHtml(a: AreaChoice | undefined): string {
  if (!a || a.index.areas.length < 2) return ''
  return `
      <p class="grouplabel">対象範囲</p>
      <select id="area" aria-label="対象範囲">${a.index.areas.map((x) =>
        `<option value="${x.id}" ${x.id === a.current.id ? 'selected' : ''}
                 title="${x.areaHa} ha${x.hasPointcloud ? '・地上点群あり' : '・0.5m DEM のみ'}"
        >${x.label}</option>`).join('')}</select>`
}

export function renderControls(
  el: HTMLElement, store: Store, catalog: Catalog,
  buildingLegend: LegendEntry[] = [],
  area?: AreaChoice,
) {
  const s = store.state
  const cond = surfaceCondition(s.surface)

  if (el.dataset.built === '1') {
    const v = el.querySelector<HTMLElement>('#wlv')
    if (v) v.textContent = `${s.waterLevel.toFixed(2)} m`
    const range = el.querySelector<HTMLInputElement>('#wl')
    if (range && document.activeElement !== range && range.value !== String(s.waterLevel)) {
      range.value = String(s.waterLevel)
    }
    const sel = el.querySelector<HTMLSelectElement>('#cond')
    if (sel && sel.value !== cond) sel.value = cond
    const ar = el.querySelector<HTMLSelectElement>('#area')
    if (ar && area && ar.value !== area.current.id) ar.value = area.current.id
    // 判定差は差分タイルがある条件だけ。無い条件では押せないことがそのまま出る
    const diffBtn = el.querySelector<HTMLButtonElement>('#diffbtn')
    if (diffBtn) {
      const target = DIFF_OF[cond]
      diffBtn.disabled = !target
      diffBtn.setAttribute('aria-pressed', String(isDiff(s.surface)))
      diffBtn.title = target ? '2 条件の判定差で塗る'
        : 'この条件の差分タイルは配信していないので出せない'
    }
    const nl = el.querySelector<HTMLElement>('#nowline')
    if (nl) nl.innerHTML = nowLine(s)
    const lg = el.querySelector<HTMLElement>('#legend')
    if (lg) lg.innerHTML = legendHtml(s, buildingLegend)
    const cb = el.querySelector<HTMLInputElement>('#cb-changed')
    if (cb && cb.checked !== s.layers.changedOnly) cb.checked = s.layers.changedOnly
    for (const box of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
      const k = box.dataset.l as LayerKey
      if (box.checked !== s.layers[k]) box.checked = s.layers[k]
    }
    // 鉛直強調中は PLATEAU 建物を隠している。チェックが嘘をつかないように無効化する
    const hidden = s.exaggeration > 1
    const pl = el.querySelector<HTMLInputElement>('input[data-l="plateau"]')
    if (pl) {
      pl.disabled = hidden
      pl.closest('label')?.classList.toggle('off', hidden)
    }
    const why = el.querySelector<HTMLElement>('#why-plateau')
    if (why) why.hidden = !hidden
    const bwrap = el.querySelector<HTMLElement>('#bcolwrap')
    if (bwrap) bwrap.hidden = hidden || !s.layers.plateau
    const bcb = el.querySelector<HTMLSelectElement>('#bcol')
    if (bcb && bcb.value !== s.buildingColor) bcb.value = s.buildingColor
    const blg = el.querySelector<HTMLElement>('#bldglegend')
    if (blg) blg.innerHTML = buildingLegendHtml(s, buildingLegend)
    for (const b of el.querySelectorAll<HTMLButtonElement>('#exag button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.x) === s.exaggeration))
    }
    return
  }

  const wl = catalog.water_level
  const refs = Object.entries(wl.reference_levels_m_tp).sort((a, b) => a[1] - b[1])
  const chips = pickChips(refs)

  el.innerHTML = `
    <!-- 固定の頭。ここがこのアプリの入力で、スクロールで消えてはいけない -->
    <div class="head">
      <h1>舞鶴 高潮浸水</h1>
      ${areaHtml(area)}

      <p class="grouplabel" style="margin-top:11px">地形データ</p>
      <div class="condrow">
        <select id="cond" aria-label="地形データ">${conditionsOf(catalog).map((c) =>
          `<option value="${c.id}" title="${c.hint}"
                   ${cond === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <button id="diffbtn" type="button"
                aria-pressed="${isDiff(s.surface)}"
                ${DIFF_OF[cond] ? '' : 'disabled'}>判定差</button>
      </div>

      <p class="grouplabel" style="margin-top:11px">潮位</p>
      <div class="wl"><b id="wlv">${s.waterLevel.toFixed(2)} m</b><span class="sub">T.P.</span></div>
      <div class="wlrow">
        <button class="stepbtn" id="wl-down" type="button"
                aria-label="潮位を ${wl.step} m 下げる">−</button>
        <input id="wl" type="range" min="${wl.min}" max="${wl.max}" step="${wl.step}"
               value="${s.waterLevel}" aria-label="潮位（m T.P.）" />
        <button class="stepbtn" id="wl-up" type="button"
                aria-label="潮位を ${wl.step} m 上げる">＋</button>
      </div>
      <div class="tickbar">${refs.map(([k, v]) =>
        `<i style="left:${((v - wl.min) / (wl.max - wl.min)) * 100}%" title="${k} ${v.toFixed(3)} m"></i>`).join('')}</div>
      <div class="ticks"><span>${wl.min.toFixed(1)}</span><span>${wl.max.toFixed(1)}</span></div>
      <div class="chips" id="chips">${chips.map(([k, v, label]) =>
        `<button data-h="${v}" type="button" title="${k} — T.P. ${v.toFixed(3)} m"
        >${label}<b>${v.toFixed(2)}</b></button>`).join('')}</div>

      <div class="nowline" id="nowline">${nowLine(s)}</div>
      <div id="legend">${legendHtml(s, buildingLegend)}</div>
    </div>

    <div class="body">
      <p class="subhead">絞り込む</p>
      <label class="row"><input type="checkbox" id="cb-changed"
        ${s.layers.changedOnly ? 'checked' : ''}/>判定が変わる地物のみ</label>

      <p class="subhead">重ねる</p>
      ${layersOf(catalog).map((l) =>
        `<label class="row"${l.hint ? ` title="${l.hint}"` : ''}
          ><input type="checkbox" data-l="${l.key}"
          ${s.layers[l.key] ? 'checked' : ''}/>${l.label}</label>`).join('')}
      <div class="whyoff" id="why-plateau" ${s.exaggeration > 1 ? '' : 'hidden'}
        >高さを強調している間は隠す（建物は実高のまま）</div>
      <div class="nested" id="bcolwrap" ${s.layers.plateau && s.exaggeration === 1 ? '' : 'hidden'}>
        <!-- **チェックボックスから select にした。** 塗り分けが 3 通りになり、
             浸水深（床下・床上）は「用途で塗る」の on/off では表せない。
             **見出しを付ける。** 無いと「用途」とだけ書かれた裸のドロップダウンに
             なり、中に浸水深があることが画面から分からない（実際に
             「床下/床上の色分けが入っていない」と受け取られた。2026-08） -->
        <p class="grouplabel">建物の色</p>
        <select id="bcol" aria-label="建物の色">${MENU_BUILDING_COLORS.map((m) =>
          `<option value="${m.id}" ${s.buildingColor === m.id ? 'selected' : ''}
          >${m.id === 'none' ? '塗り分けない' : m.label}</option>`).join('')}</select>
        <div id="bldglegend">${buildingLegendHtml(s, buildingLegend)}</div>
      </div>

      <p class="subhead">見方</p>
      <div class="group">
          <p class="grouplabel">高さを強調</p>
          <div class="seg" id="exag">${MENU_EXAGGERATIONS.map((x) =>
            `<button data-x="${x}" type="button"
                     aria-pressed="${s.exaggeration === x}">×${x}</button>`).join('')}</div>
          <div class="keyrow">×2 ×10 <span>キー [ ]</span></div>

          <p class="grouplabel" style="margin-top:11px">断面</p>
          <button class="btnwide" id="secbtn" type="button"
                  title="地図を 2 点クリックして測線を引く。Esc で中止">測線を引く</button>

          <div class="keyrow" style="margin-top:11px">投影 <span>キー O</span></div>
          <div class="keyrow">視点 <span>キー 1–6 ・ ビューキューブ</span></div>
          <div class="keyrow">計測パネル <span>キー P</span></div>
      </div>

      <p class="subhead">参照潮位</p>
      ${refListHtml(refs)}
    </div>
  `
  el.dataset.built = '1'

  el.querySelector('#area')?.addEventListener('change', (e) => {
    // 範囲を替えるとローカル座標系から配信物まで全部変わるので、読み直す
    const u = new URL(location.href)
    u.searchParams.set('area', (e.target as HTMLSelectElement).value)
    location.href = u.toString()
  })
  el.querySelector('#cond')!.addEventListener('change', (e) => {
    const c = (e.target as HTMLSelectElement).value as TerrainCondition
    // 判定差を見ていたら、条件を替えてもその条件の判定差に移る（見方を保つ）
    const next = isDiff(store.state.surface) && DIFF_OF[c] ? DIFF_OF[c]! : (c as SurfaceMode)
    store.set({ surface: next })
  })
  el.querySelector('#diffbtn')!.addEventListener('click', () => {
    const c = surfaceCondition(store.state.surface)
    store.set({ surface: isDiff(store.state.surface) ? c : (DIFF_OF[c] ?? c) })
  })
  for (const id of ['#chips', '#refs']) {
    el.querySelector(id)!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button')
      if (b) store.set({ waterLevel: Number(b.dataset.h) })
    })
  }
  el.querySelector('#exag')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ exaggeration: Number(b.dataset.x) })
  })
  const range = el.querySelector<HTMLInputElement>('#wl')!
  range.addEventListener('input', () => {
    // 潮位変更でネットワークは一切発生しない。シェーダの uniform が変わるだけ
    store.set({ waterLevel: Number(range.value) })
  })
  // **ドラッグだけでは 0.05 m 刻みを合わせにくい。** 1 段ずつ動かせるようにする
  const nudge = (d: number) => {
    const v = Math.min(wl.max, Math.max(wl.min, store.state.waterLevel + d * wl.step))
    // 端で刻みからずれた値（既定は MSL 0.124）でも、刻みの格子に乗せ直さない。
    // 参照潮位はそのままの値で意味があるので、丸めると出典と合わなくなる
    store.set({ waterLevel: Math.round(v * 1000) / 1000 })
  }
  el.querySelector('#wl-down')!.addEventListener('click', () => nudge(-1))
  el.querySelector('#wl-up')!.addEventListener('click', () => nudge(1))
  el.querySelector('#cb-changed')!.addEventListener('change', (e) => {
    store.setLayer({ changedOnly: (e.target as HTMLInputElement).checked })
  })
  el.querySelector('#bcol')!.addEventListener('change', (e) => {
    // メニューに出すのは なし / 用途 / 浸水深。'class'（普通建物・堅ろう建物）は
    // 浸水の話に効かないので __iwagaki からのみ
    store.set({ buildingColor: (e.target as HTMLSelectElement).value as BuildingColorMode })
  })
  for (const cb of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
    cb.addEventListener('change', () => store.setLayer({ [cb.dataset.l!]: cb.checked } as never))
  }
}
