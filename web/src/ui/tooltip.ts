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
// - ホバーは「ポインタが止まってから」出す。トリガーに入っても、動いている間は
//   タイマを引き直し続け、~500ms 静止して初めて表示する。select やボタンへ
//   マウスを運ぶ途中でラベル帯をかすめただけでは出さない狙い（庁内で何度も
//   「選びたいのにツールチップがノイズ」と指摘された）。フォーカスは遅延なし。
//   非表示は即時（`#ui-tooltip` の hidden で display:none にするのでフェードしない）
// - ホバーの当たり判定は**見えている文字の上だけ**（`overOwnText`）。`data-tip` は
//   横幅いっぱいの見出し（`.subhead` など）やコントロールを囲むラベルに付くので、
//   文字右の余白やコントロールとの隙間まで拾うと「適応範囲が広い」と感じる。
//   フォーカス（キーボード）と、`data-tip` を直接持つボタン自身は絞らない
// - `prefers-reduced-motion: reduce` は CSS 側でフェードを消す
// - タッチは副次（庁内デスクトップ想定）。pointerover が来れば出る程度でよい

const TIP_ID = 'ui-tooltip'
/**
 * ホバーで出るまでの遅延 [ms]。フォーカスは遅延なし。
 * これは「ポインタが最後に動いてから」の時間。トリガーの上でも動いている間は
 * 引き直されるので、通り抜け・移動途中では出ない（`onPointerMove`）。
 */
const HOVER_DELAY_MS = 500
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
/** 表示待ち（ホバーでスケジュール済み・まだ出していない）トリガー */
let pendingTrigger: HTMLElement | null = null
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
  pendingTrigger = null
  showTimer = undefined
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
  pendingTrigger = trigger
  showTimer = window.setTimeout(() => render(trigger), HOVER_DELAY_MS)
}

/**
 * ホバー表示の主役。ポインタが**トリガーの文字の上で止まってから** ~`HOVER_DELAY_MS`
 * で出す。動いている間はタイマを引き直し続け、文字から外れたら待ちを捨てる。
 * pointermove は実際に動いたときだけ飛ぶので、静止すれば最後の引き直しから
 * タイマが満了して表示に至る（＝「通り抜け」では出ない）。
 */
function onPointerMove(e: PointerEvent): void {
  if (activeTrigger) return
  const t = triggerFrom(e.target, e)
  if (t && t.dataset.tip) {
    if (showTimer !== undefined) clearTimeout(showTimer)
    pendingTrigger = t
    showTimer = window.setTimeout(() => render(t), HOVER_DELAY_MS)
  } else if (pendingTrigger) {
    hide()
  }
}

function hide(): void {
  pendingTrigger = null
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

const CONTROL_SEL = 'button, input, select, textarea, option'

/**
 * ポインタ座標 `(x, y)` が `el` の**文字が実際に描かれている矩形**の中にあるか。
 * 見出し（`.subhead` など）は操作パネルの横幅いっぱいの `<p>` なので、素の
 * `contains` 判定だと文字の右側の余白でもツールチップが出てしまう（「適応範囲が
 * 広い」の主因）。文字が無い要素（ラッパ）は `true`＝ここでは絞らない。
 */
function overOwnText(el: Element, x: number, y: number): boolean {
  const range = document.createRange()
  range.selectNodeContents(el)
  const rects = range.getClientRects()
  if (rects.length === 0) return true
  const PAD = 3
  for (const r of rects) {
    if (x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD) {
      return true
    }
  }
  return false
}

const triggerFrom = (
  t: EventTarget | null,
  at?: { clientX: number; clientY: number },
): HTMLElement | null => {
  if (!(t instanceof Element)) return null
  const trigger = t.closest<HTMLElement>('[data-tip]')
  if (!trigger) return null

  // `data-tip` is often placed on a label or a control group so that its
  // visible description can explain the whole group. Do not let that parent
  // capture hover/focus from a native form control, though: opening or
  // changing a select (and moving a range/checkbox) should not produce a
  // large tooltip over the control being operated.
  if (trigger !== t && t.matches(CONTROL_SEL)) return null

  // ポインタ由来なら、当たり判定を**見えている文字の上だけ**に絞る。子要素
  // （`.colsel` の中の `.grouplabel` など）に乗っているならその子の文字、
  // トリガー自身に乗っているならトリガーの文字。余白・ラベルとコントロールの
  // 隙間では出さない。コントロール自体（`data-tip` を直接持つボタンなど）は
  // どこに乗っても出したいので絞らない。
  const onControl = t.matches(CONTROL_SEL) || !!t.closest(CONTROL_SEL)
  if (at && !onControl && !overOwnText(t, at.clientX, at.clientY)) return null

  return trigger
}

/** `main.ts` から 1 回だけ呼ぶ。document に委譲リスナを 1 組張る */
export function mountTooltip(): void {
  if (mounted) return
  mounted = true
  ensureEl()

  document.addEventListener('pointerover', (e) => {
    const t = triggerFrom(e.target, e)
    if (t) scheduleShow(t, false)
    else if (activeTrigger || pendingTrigger) hide()
  })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerout', (e) => {
    // ここは座標で絞らない（文字の外＝ラッパの余白へ出ただけでも「離れた」と
    // みなして消したいので、要素だけで判定する）
    const t = triggerFrom(e.target)
    // 表示中でも「表示待ち」でも、そのトリガーから出たら消す。ウィンドウ外へ
    // 抜けると pointermove / pointerover が来ないので、ここで待ちを捨てないと
    // ポインタが離れた後にタイマが満了して出てしまう
    if (!t || (t !== activeTrigger && t !== pendingTrigger)) return
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
    if (e.key === 'Escape' && (activeTrigger || pendingTrigger)) hide()
  })
  // クリックしたら消す（押した先のパネルに残さない）。表示待ちのタイマも捨てる
  // ＝ select を開いた直後に遅れて出てくるのを防ぐ
  document.addEventListener('pointerdown', () => {
    if (activeTrigger || pendingTrigger) hide()
  }, true)
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
}
