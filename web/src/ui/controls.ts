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
// 叩いていて、`docs/WEB_RESULTS.md` の実測値はそこから出ている。
// メニューに出さないだけで、`__iwagaki` からは全部触れる。

import type { Catalog } from '../domain/catalog'
import { comparisonPair } from '../domain/terrain'
import type { SurfaceMode, TerrainCondition } from '../domain/types'
import type { Store } from '../state'
import { UNKNOWN_HEX, UNKNOWN_LABEL, type LegendEntry } from '../view/buildingColor'

/** `[` `]` キーが回る段。**キーは 5 段すべて**、メニューは 3 段だけ出す */
export const EXAGGERATIONS = [1, 2, 5, 10, 20] as const

/** メニューに出す段。×2 と ×10 を押し分ける判断が発生しないので落とした */
const MENU_EXAGGERATIONS = [1, 5, 20] as const

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

/** 判定差の面（差分タイル）が配信されている条件だけ。2 本しか作っていない */
const DIFF_OF: Partial<Record<TerrainCondition, SurfaceMode>> = {
  highres: 'diff',
  pointcloud: 'diff_pc',
}

const surfaceCondition = (s: SurfaceMode): TerrainCondition => comparisonPair(s).to
const isDiff = (s: SurfaceMode) => s === 'diff' || s === 'diff_pc'

/** メニューに出すレイヤ。`flood` / `ground` / `semantics` / `pcCoverage` は出さない */
const LAYERS: { key: 'plateau' | 'pointcloud'; label: string }[] = [
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
  // 判定が変わる地物は、比較のペアが決まっているときだけ出る
  if (pair.from !== pair.to) {
    rows.push(`<div><i style="background:#f24434"></i>判定が変わる地物`
      + `<span class="sub"> ${label[pair.from]} → ${label[pair.to]}</span></div>`)
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
  const top = entries.slice(0, 4)
  const rest = entries.length - top.length
  return `<div class="legend">${top.map((e) =>
    `<div><i style="background:${e.hex}"></i>${e.label}<span class="sub"> ${e.count}</span></div>`).join('')}
    ${rest > 0 ? `<div class="sub">ほか ${rest} 種 ＋ ${UNKNOWN_LABEL}`
      + `<i style="background:${UNKNOWN_HEX};margin-left:5px"></i></div>` : ''}</div>`
}

/** いま何を見ているか。**これが主張そのもの**なので muted の注記にはしない */
function nowLine(s: Store['state']): string {
  const cond = surfaceCondition(s.surface)
  const c = CONDITIONS.find((x) => x.id === cond)!
  const pair = comparisonPair(s.surface)
  const label = (id: TerrainCondition) => CONDITIONS.find((x) => x.id === id)!.label
  const head = isDiff(s.surface)
    ? `${label(pair.from)} と ${label(pair.to)} の判定差`
    : `${c.label} の浸水`
  return `<b>${head}</b> @ H = ${s.waterLevel.toFixed(2)} m T.P.
    <span class="why">${c.hint}</span>`
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
 * （`README.md` と `docs/RESULTS.md` が持っている）。出典表記だけは
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
export function renderControls(
  el: HTMLElement, store: Store, catalog: Catalog,
  buildingLegend: LegendEntry[] = [],
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
      const k = box.dataset.l as 'plateau' | 'pointcloud'
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
    const bcb = el.querySelector<HTMLInputElement>('#cb-bcol')
    if (bcb) bcb.checked = s.buildingColor !== 'none'
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
      <h1>舞鶴・吉原 高潮浸水</h1>

      <p class="grouplabel">地形データ</p>
      <div class="condrow">
        <select id="cond" aria-label="地形データ">${CONDITIONS.map((c) =>
          `<option value="${c.id}" ${cond === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <button id="diffbtn" type="button"
                aria-pressed="${isDiff(s.surface)}"
                ${DIFF_OF[cond] ? '' : 'disabled'}>判定差</button>
      </div>

      <p class="grouplabel" style="margin-top:9px">水位</p>
      <div class="wl"><b id="wlv">${s.waterLevel.toFixed(2)} m</b><span class="sub">T.P.</span></div>
      <input id="wl" type="range" min="${wl.min}" max="${wl.max}" step="${wl.step}"
             value="${s.waterLevel}" aria-label="水位 H（m T.P.）" />
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
      ${LAYERS.map((l) =>
        `<label class="row"><input type="checkbox" data-l="${l.key}"
          ${s.layers[l.key] ? 'checked' : ''}/>${l.label}</label>`).join('')}
      <div class="whyoff" id="why-plateau" ${s.exaggeration > 1 ? '' : 'hidden'}
        >高さを強調している間は隠す（建物は実高のまま）</div>
      <div class="nested" id="bcolwrap" ${s.layers.plateau && s.exaggeration === 1 ? '' : 'hidden'}>
        <label class="row"><input type="checkbox" id="cb-bcol"
          ${s.buildingColor !== 'none' ? 'checked' : ''}/>用途で塗る</label>
        <div id="bldglegend">${buildingLegendHtml(s, buildingLegend)}</div>
      </div>

      <details>
        <summary>見方</summary>
        <div class="inner">
          <p class="grouplabel">視点</p>
          <div class="seg">
            <button data-cam="west" type="button"
              title="汀線に沿って真横から・正射（キー 3）。起伏 0〜3 m はここでしか読めない">横から</button>
            <button data-cam="iso" type="button" title="起動時の俯瞰（キー 6）">ホーム</button>
          </div>
          <div class="keyrow">他の視点 <span>キー 1 2 4 5 ・ キューブ</span></div>
          <div class="keyrow">透視 / 正射 <span>キー O</span></div>
          <p class="srcnote"><b>上から見ても浸水域の輪郭しか分からない。</b>
            どこが水位より低いかは横から見る。汀線の方位は約 75°、
            「横から」はそれに沿った真横で、正射に切り替わる。</p>

          <p class="grouplabel" style="margin-top:9px">高さを強調</p>
          <div class="seg" id="exag">${MENU_EXAGGERATIONS.map((x) =>
            `<button data-x="${x}" type="button"
                     aria-pressed="${s.exaggeration === x}">×${x}</button>`).join('')}</div>
          <div class="keyrow">×2 ×10 <span>キー [ ]</span></div>
          <p class="srcnote">吉原は 1 km に対して起伏が 0〜3 m しかない。
            横から見るときは強調しないと読めない。判定そのものは変わらない。</p>

          <p class="grouplabel" style="margin-top:9px">断面</p>
          <button class="btnwide" id="secbtn" type="button">測線を引く</button>
          <p class="srcnote">地図を 2 点クリック。Esc で中止。</p>

          <div class="keyrow">計測パネル <span>キー P</span></div>
        </div>
      </details>

      <details>
        <summary>参照潮位</summary>
        <div class="inner">${refListHtml(refs)}</div>
      </details>
    </div>
  `
  el.dataset.built = '1'

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
    // 水位変更でネットワークは一切発生しない。シェーダの uniform が変わるだけ
    store.set({ waterLevel: Number(range.value) })
  })
  el.querySelector('#cb-changed')!.addEventListener('change', (e) => {
    store.setLayer({ changedOnly: (e.target as HTMLInputElement).checked })
  })
  el.querySelector('#cb-bcol')!.addEventListener('change', (e) => {
    // メニューに出すのは「用途」だけ。'class' は __iwagaki からのみ
    store.set({ buildingColor: (e.target as HTMLInputElement).checked ? 'usage' : 'none' })
  })
  for (const cb of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
    cb.addEventListener('change', () => store.setLayer({ [cb.dataset.l!]: cb.checked } as never))
  }
}
