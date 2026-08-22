import type { Catalog } from '../domain/catalog'
import type { SurfaceMode } from '../domain/types'
import type { Store } from '../state'

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
export function renderControls(el: HTMLElement, store: Store, catalog: Catalog) {
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
    const lg = el.querySelector<HTMLElement>('#legend')
    if (lg) lg.innerHTML = legendHtml(s.surface)
    return
  }
  const wl = catalog.water_level
  const msl = catalog.water_level.reference_levels_m_tp.MSL_maizuru
  const pcNote = catalog.pointcloud.synthetic
    ? '<div class="note">点群は <b>DTM から生成した合成データ</b>（配信検証用）。観測値ではない。</div>'
    : ''

  el.innerHTML = `
    <h1>舞鶴・吉原 高潮浸水</h1>
    <p class="sub">PLATEAU 5m 地形 vs 0.5m 高解像度地形</p>

    <fieldset><legend>Terrain</legend>
      <div class="seg" id="surf">${SURFACES.map((x) =>
        `<button data-s="${x.id}" aria-pressed="${s.surface === x.id}">${x.label}</button>`).join('')}</div>
    </fieldset>

    <fieldset><legend>Water level</legend>
      <div class="wl"><b id="wlv">${s.waterLevel.toFixed(2)} m</b><span class="sub">T.P.</span></div>
      <input id="wl" type="range" min="${wl.min}" max="${wl.max}" step="${wl.step}" value="${s.waterLevel}" />
      <div class="ticks"><span>${wl.min.toFixed(1)}</span><span>MSL ${msl.toFixed(2)}</span><span>${wl.max.toFixed(1)}</span></div>
    </fieldset>

    <fieldset><legend>Layers</legend>
      ${LAYERS.map((l) =>
        `<label class="row"><input type="checkbox" data-l="${l.key}" ${s.layers[l.key] ? 'checked' : ''}/>${l.label}</label>`).join('')}
    </fieldset>

    <fieldset><legend>Legend</legend><div id="legend">${legendHtml(s.surface)}</div></fieldset>
    ${pcNote}
  `
  el.dataset.built = '1'

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
