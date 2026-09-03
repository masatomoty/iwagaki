// 操作設定モーダル（画面上部「操作設定」ボタンから開く）。
//
// ドラッグでの回転・パンの感じ方は人によって逆が自然だったり、素のドラッグに
// 回転とパンのどちらを割り当てたいかも割れる（2026-09 要望）。地形データ等の
// `AppState`（`state.ts`）には乗せない個人の操作感の好みなので、`localStorage`
// にだけ持つ（`ui/startupModal.ts` と同じ try/catch の書き方）。
//
// 変更は選んだ瞬間に `Viewer` へ即時反映する（`intro` モーダルと違い、
// 読み込み直しも「適用」ボタンも要らない小さな設定なので）。

import { DEFAULT_DRAG_SETTINGS, type DragSettings, type Viewer } from '../three/viewer'

const LS_DRAG_SETTINGS = 'iwagaki.dragSettings'

/** private モード等で `localStorage` が例外を投げても既定値で続行する */
export function loadDragSettings(): DragSettings {
  try {
    const raw = localStorage.getItem(LS_DRAG_SETTINGS)
    if (!raw) return { ...DEFAULT_DRAG_SETTINGS }
    const j = JSON.parse(raw) as Partial<DragSettings>
    return {
      rotateReversed: typeof j.rotateReversed === 'boolean'
        ? j.rotateReversed : DEFAULT_DRAG_SETTINGS.rotateReversed,
      primaryDrag: j.primaryDrag === 'pan' ? 'pan' : DEFAULT_DRAG_SETTINGS.primaryDrag,
      rotateSensitivity: typeof j.rotateSensitivity === 'number' && Number.isFinite(j.rotateSensitivity)
        ? Math.max(0.25, Math.min(4, j.rotateSensitivity))
        : DEFAULT_DRAG_SETTINGS.rotateSensitivity,
    }
  } catch { return { ...DEFAULT_DRAG_SETTINGS } }
}

function saveDragSettings(s: DragSettings): void {
  try { localStorage.setItem(LS_DRAG_SETTINGS, JSON.stringify(s)) } catch { /* private モード */ }
}

/** 起動時に一度だけ呼ぶ。保存済みの操作感を `Viewer` に反映する */
export function applyStoredDragSettings(viewer: Viewer): void {
  viewer.setDragSettings(loadDragSettings())
}

/**
 * 操作設定モーダルを開く。画面上部の「操作設定」ボタン（`ui/controls.ts` の
 * `#tb-opset`）から呼ぶ。二重に開かないよう、既にあれば何もしない。
 */
export function openOperationSettingsModal(viewer: Viewer): void {
  if (document.getElementById('opsettings-modal')) return

  const s = viewer.dragSettings

  const overlay = document.createElement('div')
  overlay.id = 'opsettings-modal'
  overlay.innerHTML = `
    <div class="intro-card" role="dialog" aria-modal="true" aria-labelledby="opset-title">
      <h2 id="opset-title">操作設定</h2>
      <p class="intro-lead">ドラッグでの回転・パンの感じ方を、好みに合わせて変えられます。</p>
      <form id="opset-form">
        <fieldset>
          <legend>ドラッグの回転方向</legend>
          <label class="opt">
            <input type="radio" name="opset-dir" value="reversed" ${s.rotateReversed ? 'checked' : ''}/>
            <span class="opt-t">反転 <em>既定</em></span>
            <span class="opt-d">地形をつかんで動かすように、ドラッグした向きと逆へ景色が回る</span>
          </label>
          <label class="opt">
            <input type="radio" name="opset-dir" value="normal" ${s.rotateReversed ? '' : 'checked'}/>
            <span class="opt-t">そのまま</span>
            <span class="opt-d">ドラッグした向きと同じ向きに景色が回る</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>ドラッグの役割</legend>
          <label class="opt">
            <input type="radio" name="opset-btn" value="rotate" ${s.primaryDrag === 'rotate' ? 'checked' : ''}/>
            <span class="opt-t">素のドラッグ＝回転 <em>既定</em></span>
            <span class="opt-d">右ドラッグ／Shift＋ドラッグでパン</span>
          </label>
          <label class="opt">
            <input type="radio" name="opset-btn" value="pan" ${s.primaryDrag === 'pan' ? 'checked' : ''}/>
            <span class="opt-t">素のドラッグ＝パン</span>
            <span class="opt-d">右ドラッグ／Shift＋ドラッグで回転</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>回転の感度</legend>
          <div class="opset-sens">
            <input type="range" id="opset-sens" min="0.5" max="2" step="0.25" value="${s.rotateSensitivity}"/>
            <span id="opset-sens-v">${s.rotateSensitivity.toFixed(2)}×</span>
          </div>
        </fieldset>
        <div class="intro-foot">
          <button type="button" id="opset-reset" class="intro-secondary">既定に戻す</button>
          <div class="intro-btns">
            <button type="button" id="opset-close" class="intro-primary">閉じる</button>
          </div>
        </div>
      </form>
    </div>`
  document.body.appendChild(overlay)

  const prevFocus = document.activeElement as HTMLElement | null
  const form = overlay.querySelector<HTMLFormElement>('#opset-form')!
  const sens = overlay.querySelector<HTMLInputElement>('#opset-sens')!
  const sensLabel = overlay.querySelector<HTMLElement>('#opset-sens-v')!

  function current(): DragSettings {
    const dir = form.querySelector<HTMLInputElement>('input[name="opset-dir"]:checked')?.value
    const btn = form.querySelector<HTMLInputElement>('input[name="opset-btn"]:checked')?.value
    return {
      rotateReversed: dir !== 'normal',
      primaryDrag: btn === 'pan' ? 'pan' : 'rotate',
      rotateSensitivity: Number(sens.value) || 1,
    }
  }

  function apply(): void {
    const next = current()
    sensLabel.textContent = `${next.rotateSensitivity.toFixed(2)}×`
    viewer.setDragSettings(next)
    saveDragSettings(next)
  }

  function close(): void {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    prevFocus?.focus?.()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }

  form.addEventListener('change', apply)
  sens.addEventListener('input', apply)
  overlay.querySelector('#opset-reset')!.addEventListener('click', () => {
    form.querySelector<HTMLInputElement>(
      `input[name="opset-dir"][value="${DEFAULT_DRAG_SETTINGS.rotateReversed ? 'reversed' : 'normal'}"]`)!.checked = true
    form.querySelector<HTMLInputElement>(
      `input[name="opset-btn"][value="${DEFAULT_DRAG_SETTINGS.primaryDrag}"]`)!.checked = true
    sens.value = String(DEFAULT_DRAG_SETTINGS.rotateSensitivity)
    apply()
  })
  overlay.querySelector('#opset-close')!.addEventListener('click', close)
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close() })
  document.addEventListener('keydown', onKey, true)

  overlay.querySelector<HTMLInputElement>('input[name="opset-dir"]:checked')?.focus()
}
