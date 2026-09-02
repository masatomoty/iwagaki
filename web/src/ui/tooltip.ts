// ボタン／トグル／select の説明を出す自前ツールチップ（`docs/todo.md` U2）。
//
// **依存は足さない。** デジタル庁デザインシステム（DADS）を参考にした自前実装で、
// 見た目は既存の唯一の自前ポップオーバー `#topbar .tb-src-pop`（出典）に合わせてある
// （同じ var(--panel)/var(--line)・角丸 8px・box-shadow・小さいフォント）。
// CSS は `web/index.html` に集約（`#ui-tooltip`）。
//
// - ホバー **と** キーボードフォーカスの両方で出る。Esc・blur・mouseleave で消える
// - `role="tooltip"` ＋ `aria-describedby` で支援技術につなぐ
// - ツールチップ DOM は**単一ノードを body 直下に置いて使い回す**。サイドバー
//   （`#controls-tabs`）は overflow スクロールコンテナなので、その中に
//   position:absolute で出すとクリップされる。`position: fixed` ＋ JS 位置決めで
//   body にポータルする
// - 位置決め（`placeTip`）は描画に依存しない純関数に切り出してテストする
//   （`web/test/tooltip.test.mjs`）
// - 表示遅延はホバー ~400ms・フォーカスは遅延なし。非表示は即時
//   （`#ui-tooltip` の hidden で display:none にするのでフェードしない）
// - `prefers-reduced-motion: reduce` は CSS 側でフェードを消す
// - タッチは副次（庁内デスクトップ想定）。pointerover が来れば出る程度でよい

const TIP_ID = 'ui-tooltip'
/** ホバーで出るまでの遅延 [ms]。フォーカスは遅延なし */
const HOVER_DELAY_MS = 400
/** トリガーとツールチップの間隔 [px] */
const GAP = 8
/** viewport 端からの最小マージン [px] */
const MARGIN = 6

export type Placement = 'top' | 'bottom'

/** `DOMRect` のうち位置決めに要る分だけ。テストから DOM 無しで渡せるように */
export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

/**
 * viewport 端から空けたい余白。既定は四辺 `MARGIN`。
 * **上辺は固定ヘッダ（`#topbar`）のぶん広げる** — トリガーが帯の直下にあると、
 * ツールチップを上に出したとき帯に潜ってしまう（浸水深ボタンなど）。
 */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

const DEFAULT_INSETS: Insets = { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }

/**
 * ツールチップの左上座標と、トリガーの上下どちらに出したか。
 *
 * 既定はトリガーの上。上に収まらない（＝ `insets.top` より上、多くは `#topbar` と
 * 重なる位置）で、かつ下には収まるなら下へフリップする。
 * 左右はトリガー中央を狙い、viewport からはみ出す分だけ寄せてクランプする。
 * 上下どちらでも収まらないときは、少なくとも上端で切れない位置に置く。
 */
export function placeTip(
  trigger: RectLike,
  tip: { w: number; h: number },
  viewport: { w: number; h: number },
  insets: Insets = DEFAULT_INSETS,
): { x: number; y: number; placement: Placement } {
  const cx = trigger.left + trigger.width / 2
  let x = cx - tip.w / 2
  x = Math.max(insets.left, Math.min(x, viewport.w - tip.w - insets.right))

  const above = trigger.top - GAP - tip.h
  const below = trigger.top + trigger.height + GAP
  let placement: Placement = 'top'
  let y = above
  if (above < insets.top && below + tip.h <= viewport.h - insets.bottom) {
    placement = 'bottom'
    y = below
  }
  y = Math.max(insets.top, Math.min(y, viewport.h - tip.h - insets.bottom))
  return { x, y, placement }
}

let tipEl: HTMLElement | null = null
let activeTrigger: HTMLElement | null = null
let showTimer: number | undefined
let mounted = false

function ensureEl(): HTMLElement {
  if (tipEl) return tipEl
  const el = document.createElement('div')
  el.id = TIP_ID
  el.setAttribute('role', 'tooltip')
  el.hidden = true
  document.body.appendChild(el)
  tipEl = el
  return el
}

function reposition(): void {
  if (!activeTrigger || !tipEl) return
  const r = activeTrigger.getBoundingClientRect()
  // トリガーがスクロールで画面外へ消えたら引っ込める（fixed なので追従しない）
  if (r.bottom < 0 || r.top > window.innerHeight
      || r.right < 0 || r.left > window.innerWidth) {
    hide()
    return
  }
  // 上辺は固定ヘッダ（`#topbar`）の下端まで空ける。トリガーが帯の直下にあると
  // 上に出したとき帯へ潜るので（浸水深ボタンなど）、そのぶん下へフリップさせる
  const headerBottom = document.getElementById('topbar')?.getBoundingClientRect().bottom ?? 0
  const { x, y, placement } = placeTip(
    r,
    { w: tipEl.offsetWidth, h: tipEl.offsetHeight },
    { w: window.innerWidth, h: window.innerHeight },
    { top: Math.max(MARGIN, headerBottom + MARGIN), right: MARGIN, bottom: MARGIN, left: MARGIN },
  )
  tipEl.style.left = `${Math.round(x)}px`
  tipEl.style.top = `${Math.round(y)}px`
  tipEl.dataset.placement = placement
}

function render(trigger: HTMLElement): void {
  const text = trigger.dataset.tip
  if (!text) return
  const el = ensureEl()
  el.textContent = text
  // いったん不可視のまま出してサイズを測り、位置を決めてから見せる（チラつき防止）
  el.style.visibility = 'hidden'
  el.hidden = false
  activeTrigger = trigger
  reposition()
  el.style.visibility = ''
  el.classList.add('is-shown')
  trigger.setAttribute('aria-describedby', TIP_ID)
}

function scheduleShow(trigger: HTMLElement, immediate: boolean): void {
  if (trigger === activeTrigger) return
  hide()
  if (!trigger.dataset.tip) return
  if (immediate) { render(trigger); return }
  showTimer = window.setTimeout(() => render(trigger), HOVER_DELAY_MS)
}

function hide(): void {
  if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined }
  if (activeTrigger?.getAttribute('aria-describedby') === TIP_ID) {
    activeTrigger.removeAttribute('aria-describedby')
  }
  activeTrigger = null
  if (tipEl) {
    tipEl.hidden = true
    tipEl.classList.remove('is-shown')
  }
}

const triggerFrom = (t: EventTarget | null): HTMLElement | null => {
  if (!(t instanceof Element)) return null
  const trigger = t.closest<HTMLElement>('[data-tip]')
  if (!trigger) return null

  // `data-tip` is often placed on a label or a control group so that its
  // visible description can explain the whole group. Do not let that parent
  // capture hover/focus from a native form control, though: opening or
  // changing a select (and moving a range/checkbox) should not produce a
  // large tooltip over the control being operated.
  if (trigger !== t && t.matches('button, input, select, textarea, option')) return null
  return trigger
}

/** `main.ts` から 1 回だけ呼ぶ。document に委譲リスナを 1 組張る */
export function mountTooltip(): void {
  if (mounted) return
  mounted = true
  ensureEl()

  document.addEventListener('pointerover', (e) => {
    const t = triggerFrom(e.target)
    if (t) scheduleShow(t, false)
    else if (activeTrigger) hide()
  })
  document.addEventListener('pointerout', (e) => {
    const t = triggerFrom(e.target)
    if (!t || t !== activeTrigger) return
    // トリガーの中（label 内の checkbox 等）へ移っただけなら消さない
    if (e.relatedTarget instanceof Node && t.contains(e.relatedTarget)) return
    hide()
  })
  document.addEventListener('focusin', (e) => {
    const t = triggerFrom(e.target)
    if (t) scheduleShow(t, true)
    else if (activeTrigger) hide()
  })
  document.addEventListener('focusout', () => {
    if (activeTrigger) hide()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeTrigger) hide()
  })
  // クリックしたら消す（押した先のパネルに残さない）
  document.addEventListener('pointerdown', () => { if (activeTrigger) hide() }, true)
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
}
