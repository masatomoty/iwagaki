import type { Catalog } from '../domain/catalog'
import type { BuildingColorMode, SurfaceMode } from '../domain/types'
import type { Store } from '../state'
import { BUILDING_COLOR_MODES, UNKNOWN_HEX, UNKNOWN_LABEL,
         type LegendEntry } from '../view/buildingColor'
import { CAMERA_PRESETS, type CameraPresetId } from '../view/map'

export const EXAGGERATIONS = [1, 2, 5, 10, 20] as const

function legendHtml(surface: SurfaceMode): string {
  return surface === 'diff'
    ? `<div class="legend">
         <div><i style="background:#ed3830"></i>高解像度でのみ浸水</div>
         <div><i style="background:#f7d129"></i>PLATEAU でのみ浸水</div>
         <div><i style="background:#2a5794"></i>どちらも浸水</div>
       </div>`
    : `<div class="legend">
         <div><i style="background:#6bccf2"></i>浅い &nbsp;<i style="background:#0d2985"></i>深い（0〜3 m）</div>
         <div><i style="background:#f24434"></i>判定が変わる地物</div>
       </div>`
}

/** PLATEAU 建物の属性凡例。出現したコードだけ、多い順に並べる */
function buildingLegendHtml(mode: BuildingColorMode, entries: LegendEntry[]): string {
  if (mode === 'none' || entries.length === 0) return ''
  return `<div class="legend">${entries.map((e) =>
    `<div><i style="background:${e.hex}"></i>${e.label}
       <span class="sub">${e.count}</span></div>`).join('')}
    <div><i style="background:${UNKNOWN_HEX}"></i>${UNKNOWN_LABEL}</div></div>`
}

const SURFACES: { id: SurfaceMode; label: string }[] = [
  { id: 'baseline', label: 'PLATEAU 5m' },
  { id: 'highres', label: '高解像度 0.5m' },
  { id: 'diff', label: '差分' },
]

const LAYERS: { key: keyof Store['state']['layers']; label: string }[] = [
  { key: 'flood', label: '浸水' },
  { key: 'ground', label: '地形（陰影）' },
  { key: 'plateau', label: 'PLATEAU 建物' },
  { key: 'semantics', label: '建物・道路（解析値）' },
  { key: 'pointcloud', label: '点群' },
  { key: 'changedOnly', label: '判定が変わる地物のみ' },
]

/**
 * 初回だけ DOM を作り、以後は変わった箇所だけ書き換える。
 * 毎回 innerHTML を作り直すと、水位スライダを掴んでいる最中に
 * スライダ自身の DOM が消えて作り直される（掴み直しが必要になる）。
 */
export function renderControls(
  el: HTMLElement, store: Store, catalog: Catalog,
  onPreset: (id: CameraPresetId) => void,
  buildingLegend: LegendEntry[] = [],
) {
  const s = store.state
  if (el.dataset.built === '1') {
    const v = el.querySelector<HTMLElement>('#wlv')
    if (v) v.textContent = `${s.waterLevel.toFixed(2)} m`
    const range = el.querySelector<HTMLInputElement>('#wl')
    if (range && document.activeElement !== range && range.value !== String(s.waterLevel)) {
      range.value = String(s.waterLevel)
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('#surf button')) {
      b.setAttribute('aria-pressed', String(s.surface === b.dataset.s))
    }
    for (const cb of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
      const k = cb.dataset.l as keyof typeof s.layers
      if (cb.checked !== s.layers[k]) cb.checked = s.layers[k]
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('#exag button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.x) === s.exaggeration))
    }
    const warn = el.querySelector<HTMLElement>('#exagwarn')
    if (warn) warn.style.display = s.exaggeration > 1 ? 'block' : 'none'
    const lg = el.querySelector<HTMLElement>('#legend')
    if (lg) lg.innerHTML = legendHtml(s.surface)
    for (const b of el.querySelectorAll<HTMLButtonElement>('#bcol button')) {
      b.setAttribute('aria-pressed', String(s.buildingColor === b.dataset.b))
    }
    const blg = el.querySelector<HTMLElement>('#bldglegend')
    if (blg) blg.innerHTML = buildingLegendHtml(s.buildingColor, buildingLegend)
    return
  }
  const wl = catalog.water_level
  const refs = Object.entries(wl.reference_levels_m_tp).sort((a, b) => a[1] - b[1])
  // 点群が合成か実測かで意味がまるで違うので、必ず明示する
  const pc = catalog.pointcloud
  const pcNote = pc.synthetic
    ? '<div class="note">点群は <b>DTM から生成した合成データ</b>（配信検証用）。観測値ではない。</div>'
    : `<div class="note">点群は <b>2026-07 取得のバックパック SLAM 実測</b>
        （${(pc.point_count / 1e6).toFixed(1)} M 点 / ${(pc.bytes / 1e6).toFixed(0)} MB）。
        <b>表示専用</b>で、浸水解析には点群を融合した地形ラスタを使っている。
        歩いた線に沿った帯しか無い点に注意。</div>`

  el.innerHTML = `
    <h1>舞鶴・吉原 高潮浸水</h1>
    <p class="sub">PLATEAU 5m 地形 vs 0.5m 高解像度地形</p>

    <fieldset><legend>Terrain</legend>
      <div class="seg" id="surf">${SURFACES.map((x) =>
        `<button data-s="${x.id}" aria-pressed="${s.surface === x.id}">${x.label}</button>`).join('')}</div>
    </fieldset>

    <fieldset><legend>PLATEAU 建物の色</legend>
      <div class="seg" id="bcol">${BUILDING_COLOR_MODES.map((x) =>
        `<button data-b="${x.id}" aria-pressed="${s.buildingColor === x.id}">${x.label}</button>`).join('')}</div>
      <div id="bldglegend">${buildingLegendHtml(s.buildingColor, buildingLegend)}</div>
      <div class="note">b3dm に色は入っていない（texture・頂点色・baseColorFactor すべて無し）。
        属性コードの表示名は CityGML 配布 zip 同梱のコードリスト。</div>
    </fieldset>

    <fieldset><legend>View（1〜6 キー）</legend>
      <div class="seg" id="cam">${CAMERA_PRESETS.map((p) =>
        `<button data-c="${p.id}" title="${p.key}">${p.label}</button>`).join('')}</div>
    </fieldset>

    <fieldset><legend>鉛直強調（[ ] キー）</legend>
      <div class="seg" id="exag">${EXAGGERATIONS.map((x) =>
        `<button data-x="${x}" aria-pressed="${s.exaggeration === x}">×${x}</button>`).join('')}</div>
      <div class="note" id="exagwarn" style="display:${s.exaggeration > 1 ? 'block' : 'none'}">
        鉛直強調中は PLATEAU 建物を非表示にしている。建物は実高のままなので地形とずれるため。
      </div>
    </fieldset>

    <fieldset><legend>Water level</legend>
      <div class="wl"><b id="wlv">${s.waterLevel.toFixed(2)} m</b><span class="sub">T.P.</span></div>
      <input id="wl" type="range" min="${wl.min}" max="${wl.max}" step="${wl.step}" value="${s.waterLevel}" />
      <div class="tickbar">${refs.map(([, v]) =>
        `<i style="left:${((v - wl.min) / (wl.max - wl.min)) * 100}%"></i>`).join('')}</div>
      <div class="ticks"><span>${wl.min.toFixed(1)}</span><span>${wl.max.toFixed(1)}</span></div>
      <div class="seg wrap" id="refs">${refs.map(([k, v]) =>
        `<button data-h="${v}" title="T.P. ${v.toFixed(3)} m">${k}<br><span class="sub">${v.toFixed(2)}</span></button>`).join('')}</div>
      <div class="note">舞鶴の実際の潮位。既往最高潮位は 1998-09-22 の台風7号（京都府 丹後沿岸海岸保全基本計画）。
        天文潮は気象庁の推算潮位表から計算（年平均が公表 MSL と一致することで検算）。</div>
    </fieldset>

    <fieldset><legend>Layers</legend>
      ${LAYERS.map((l) =>
        `<label class="row"><input type="checkbox" data-l="${l.key}" ${s.layers[l.key] ? 'checked' : ''}/>${l.label}</label>`).join('')}
    </fieldset>

    <fieldset><legend>Legend</legend><div id="legend">${legendHtml(s.surface)}</div></fieldset>
    ${pcNote}
  `
  el.dataset.built = '1'

  el.querySelector('#refs')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ waterLevel: Number(b.dataset.h) })
  })
  el.querySelector('#cam')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) onPreset(b.dataset.c as CameraPresetId)
  })
  el.querySelector('#exag')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ exaggeration: Number(b.dataset.x) })
  })
  el.querySelector('#bcol')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ buildingColor: b.dataset.b as BuildingColorMode })
  })
  el.querySelector('#surf')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ surface: b.dataset.s as SurfaceMode })
  })
  const range = el.querySelector<HTMLInputElement>('#wl')!
  range.addEventListener('input', () => {
    // 水位変更でネットワークは一切発生しない。シェーダの uniform が変わるだけ
    store.set({ waterLevel: Number(range.value) })
  })
  for (const cb of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
    cb.addEventListener('change', () => store.setLayer({ [cb.dataset.l!]: cb.checked } as never))
  }
}
