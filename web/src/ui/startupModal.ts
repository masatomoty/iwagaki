// 初見者向けの起動時モーダル（`docs/todo.md` U6）。
//
// トップページを開いた最初に、**対象地域・浸水の決め方・潮位**の 3 つを選ばせる。
// ねらいは「単純に、地盤高が潮位より低いところが、その差だけ浸水する」という
// 一番素直な見方（`floodModel: 'simple'`）を**最初の選択肢として**前に出すこと。
// 既定の連結モデル（`connected`）は「海から地表面をたどって届くか」まで見るので、
// 初見だと「なぜここが着色されないのか」になりやすい（外部の指摘、2026-08）。
//
// - **依存は足さない。** `ui/tooltip.ts` と同じ素の DOM 実装。見た目は既存の
//   パネル（`var(--panel)`/`var(--line)`・角丸）に合わせて `web/index.html` に集約。
// - **毎回出す。** 「次回から表示しない」チェックで `localStorage` に伏せる
//   （庁内の常用者向け。指示 2026-09-02）。`?intro=1` で強制表示、`?intro=0` で抑止。
// - **自動化ブラウザ（Playwright）では出さない** — `navigator.webdriver` で判定。
//   `web/perf` のスクリーンショット 15 本超がモーダルに覆われるのを避ける。
// - **対象地域を替えるとページごと読み直す**（`ui/controls.ts` の `#area` と同じ理由:
//   ローカル座標系・タイル URL・地物・視点が全部入れ替わる）。読み直しをまたいで
//   モデル・潮位の選択を運ぶために `sessionStorage` に退避する。
// - 位置決め等の必要が無い代わり、**判断ロジック（読み直すか／その場で反映か、
//   表示するか、既定の潮位）を純関数に切り出して** `web/test/startupModal.test.mjs` で確認する。

import type { AreaIndex } from '../domain/areas'
import type { Catalog } from '../domain/catalog'
import type { FloodModel } from '../domain/types'
import type { Store } from '../state'

/**
 * モーダルに出す浸水モデルの説明。**操作パネル（`ui/controls.ts` の `FLOOD_MODELS`）
 * とは別の、初見者向けのやわらかい文面**にしてある（パネルの `connected` の hint は
 * `h_conn ≤ 潮位` で、初めて開いた人には通じない）。id と並び順はパネルに合わせる。
 */
const MODEL_COPY: { id: FloodModel; label: string; blurb: string }[] = [
  { id: 'simple', label: '単純（潮位 − 地盤高）',
    blurb: '地盤高が潮位より低いところを、その差だけ浸水として塗ります。海とつながっているかは問いません。舞鶴市の現場の経験則に沿った見方です。' },
  { id: 'connected', label: '海からつながる',
    blurb: '海面から地表をたどって水が届く範囲だけを浸水とします。堤防や高い縁に囲まれた低地は「浸水しない」側に出ます（既定）。' },
  { id: 'drainage', label: '仮想排水路',
    blurb: '排水路の吐口があると仮定して、そこから逆流して届く範囲まで含めます（東舞鶴・西舞鶴のみ）。' },
]

/**
 * 参照潮位のキーに添える通称。**パネル（`ui/controls.ts` の `REF_ALIAS`）より
 * 説明的にしてある** — モーダルは幅に余裕があり、初見者は生のキーで分からない。
 */
const REF_ALIAS: Record<string, string> = {
  MSL: '普段（平均海面）',
  '朔望平均満潮位(公表)': '朔望平均満潮位',
  '高潮想定の基準潮位': '高潮想定の基準潮位',
  '既往最高潮位': '既往最高潮位（1998）',
}

/**
 * モーダルに出す参照潮位。**初見者向けに 3 つだけ**に絞る（パネルの「参照潮位」は
 * 配信物の全キーを出す。指示 2026-09-02）。ふだん → 高潮想定 → 既往最高 の 3 段で
 * 「平常時 → 計画上の想定 → 実際に起きた最大」の筋が通る。配信物に無いキーは飛ばす。
 */
const STARTUP_TIDE_KEYS = ['MSL', '高潮想定の基準潮位', '既往最高潮位']

/** 各グループで既定選択の選択肢に添える印 */
const PICK_BADGE = ' <em>おすすめ</em>'

/** 「次回から表示しない」（永続） */
const LS_DISMISSED = 'iwagaki.intro.dismissed'
/** 対象地域を替えて読み直すとき、モデル・潮位の選択を運ぶ（そのセッションだけ） */
const SS_PENDING = 'iwagaki.intro.pending'

/**
 * モーダルで既定選択にする参照潮位。上から順に、配信物にあれば採る。
 * 「単純」を選んだ人がまっさらな地図を見ないように、**浸水が出る潮位**から始める。
 * 高潮想定の基準潮位（この道具の主題）→ 既往最高（1998 実績）の順。
 */
const PREFERRED_TIDE_KEYS = ['高潮想定の基準潮位', '既往最高潮位']

export interface StartupCarry {
  floodModel: FloodModel
  waterLevel: number
}

export interface StartupChoice extends StartupCarry {
  areaId: string
}

export interface StartupPlan {
  /** 対象地域が変わる → ページを読み直す。false ならその場で `patch` を反映 */
  reload: boolean
  /** `reload` のとき `?area=` に入れる id */
  areaId?: string
  /** `reload` のとき `sessionStorage` に退避して読み直し後に反映する */
  carry?: StartupCarry
  /** `reload` しないとき `store.set` する差分 */
  patch?: StartupCarry
}

/**
 * 選んだ条件をどう適用するか。対象地域が現在と違えば読み直し（＋選択の退避）、
 * 同じならその場で反映。
 */
export function planStartupApply(choice: StartupChoice, currentAreaId: string): StartupPlan {
  const carry: StartupCarry = { floodModel: choice.floodModel, waterLevel: choice.waterLevel }
  if (choice.areaId && choice.areaId !== currentAreaId) {
    return { reload: true, areaId: choice.areaId, carry }
  }
  return { reload: false, patch: carry }
}

/**
 * モーダルを出すか。`forced` が最優先（`?intro=1`→true / `?intro=0`→false /
 * 指定なし→null）。次に自動化ブラウザは常に出さない。最後に「次回から表示しない」。
 */
export function startupShouldShow(opts: {
  forced: boolean | null
  dismissed: boolean
  automated: boolean
}): boolean {
  if (opts.forced !== null) return opts.forced
  if (opts.automated) return false
  return !opts.dismissed
}

/**
 * 読み直し後に適用してよい浸水モデルへ丸める。**`drainage` は仮想排水路タイルの
 * ある範囲でしか出せない** — 西舞鶴/東舞鶴で `drainage` を選び、同じモーダルで
 * 対象地域を吉原へ替えると、吉原の配信物に `diff_drainage` が無いのに
 * `drainage` が適用され、シェーダだけ排水モードのまま土台が highres に落ちる
 * （描画が壊れる。codex review 2026-09-02）。使えなければ `connected` に落とす。
 */
export function resolveCarriedModel(model: FloodModel, hasDrainage: boolean): FloodModel {
  return model === 'drainage' && !hasDrainage ? 'connected' : model
}

/**
 * 既定で選んでおく潮位 [m T.P.]。`preferred` のキーが配信物の参照潮位にあれば
 * その値、無ければ `fallback`（＝ふだんの水位）。
 */
export function pickStartupTide(
  refs: [string, number][], preferred: string[], fallback: number,
): number {
  for (const key of preferred) {
    const hit = refs.find(([k]) => k === key)
    if (hit) return hit[1]
  }
  return fallback
}

// --- localStorage / sessionStorage は private モードで例外を投げる。全部 try/catch ---

function readDismissed(): boolean {
  try { return localStorage.getItem(LS_DISMISSED) === '1' } catch { return false }
}

function writeDismissed(on: boolean): void {
  try {
    if (on) localStorage.setItem(LS_DISMISSED, '1')
    else localStorage.removeItem(LS_DISMISSED)
  } catch { /* private モード */ }
}

/**
 * 読み直しをまたいで運ばれたモデル・潮位の選択を 1 度だけ取り出す（取り出したら消す）。
 * `main.ts` が `store` を作った直後に呼ぶ。戻り値が非 null なら、この読み込みでは
 * モーダルを出さない（利用者はもう選び終えている）。
 */
export function takePendingStartup(): StartupCarry | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(SS_PENDING)
    if (raw) sessionStorage.removeItem(SS_PENDING)
  } catch { return null }
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as Partial<StartupCarry>
    if (typeof j.waterLevel === 'number' && Number.isFinite(j.waterLevel)
        && typeof j.floodModel === 'string') {
      return { floodModel: j.floodModel as FloodModel, waterLevel: j.waterLevel }
    }
  } catch { /* 壊れた JSON */ }
  return null
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface MountOpts {
  store: Store
  catalog: Catalog
  areaIndex: AreaIndex
  currentAreaId: string
}

/**
 * `main.ts` から 1 回だけ呼ぶ。出す条件を満たさなければ何もしない。
 * `takePendingStartup()` が値を返した読み込みでは呼ばないこと。
 */
export function mountStartupModal(opts: MountOpts): void {
  const { store, catalog, areaIndex, currentAreaId } = opts
  const qs = new URLSearchParams(location.search)
  const introParam = qs.get('intro')
  const forced = introParam === null ? null : introParam !== '0'
  const automated = typeof navigator !== 'undefined' && navigator.webdriver === true
  if (!startupShouldShow({ forced, dismissed: readDismissed(), automated })) return
  if (document.getElementById('startup-modal')) return

  const areas = areaIndex.areas
  const showArea = areas.length >= 2
  const models = MODEL_COPY.filter(
    (m) => m.id !== 'drainage' || !!catalog.terrain.diff_drainage)
  const allRefs = Object.entries(catalog.water_level.reference_levels_m_tp ?? {})
    .sort((a, b) => a[1] - b[1]) as [string, number][]
  // モーダルは 3 つだけ（`STARTUP_TIDE_KEYS`）。絞った結果 0 件なら全部に戻す
  const picked = allRefs.filter(([k]) => STARTUP_TIDE_KEYS.includes(k))
  const refs = picked.length ? picked : allRefs
  const defaultTide = pickStartupTide(refs, PREFERRED_TIDE_KEYS, store.state.waterLevel)

  const areaField = showArea ? `
    <fieldset>
      <legend>対象地域</legend>
      ${areas.map((a) => `
        <label class="opt">
          <input type="radio" name="intro-area" value="${esc(a.id)}"
                 ${a.id === currentAreaId ? 'checked' : ''}/>
          <span class="opt-t">${esc(a.label)}${a.id === currentAreaId ? PICK_BADGE : ''}</span>
          <span class="opt-d">${a.areaHa} ha・${a.hasPointcloud ? '地上点群あり（0.5m DEM＋点群）' : '0.5m DEM のみ'}</span>
        </label>`).join('')}
    </fieldset>` : ''

  const modelField = `
    <fieldset>
      <legend>浸水の決め方</legend>
      ${models.map((m) => `
        <label class="opt">
          <input type="radio" name="intro-model" value="${esc(m.id)}"
                 ${m.id === 'simple' ? 'checked' : ''}/>
          <span class="opt-t">${esc(m.label)}${m.id === 'simple' ? PICK_BADGE : ''}</span>
          <span class="opt-d">${esc(m.blurb)}</span>
        </label>`).join('')}
    </fieldset>`

  const tideField = refs.length ? `
    <fieldset>
      <legend>潮位（T.P.）</legend>
      <div class="intro-tides">
        ${refs.map(([k, v]) => `
          <label class="opt opt-inline">
            <input type="radio" name="intro-tide" value="${v}"
                   ${v === defaultTide ? 'checked' : ''}/>
            <span class="opt-t">${esc(REF_ALIAS[k] ?? k)}${v === defaultTide ? PICK_BADGE : ''}</span>
            <span class="opt-v">${v.toFixed(2)} m</span>
          </label>`).join('')}
      </div>
    </fieldset>` : ''

  // 横長レイアウト: 左に主役の「浸水の決め方」、右に「対象地域＋潮位」を畳む。
  // 右に出すものが無ければ 1 カラムに落とす
  const sideInner = `${areaField}${tideField}`
  const body = sideInner
    ? `<div class="intro-cols">
         <div class="intro-main">${modelField}</div>
         <div class="intro-side">${sideInner}</div>
       </div>`
    : modelField

  const overlay = document.createElement('div')
  overlay.id = 'startup-modal'
  overlay.innerHTML = `
    <div class="intro-card" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <h2 id="intro-title">舞鶴 高潮浸水ビューア</h2>
      <p class="intro-lead">
        潮位を上げると、地盤の低いところがその差だけ浸かる様子を見る道具です。
        まずは一番素直な「単純」から。あとから操作パネルでいつでも変えられます。
      </p>
      <form id="intro-form">
        ${body}
        <div class="intro-foot">
          <label class="intro-hide">
            <input type="checkbox" id="intro-hide"/>次回から表示しない
          </label>
          <div class="intro-btns">
            <button type="button" id="intro-skip" class="intro-secondary">スキップ</button>
            <button type="submit" id="intro-go" class="intro-primary">この条件で見る</button>
          </div>
        </div>
      </form>
    </div>`
  document.body.appendChild(overlay)

  const prevFocus = document.activeElement as HTMLElement | null
  const form = overlay.querySelector<HTMLFormElement>('#intro-form')!
  const hideBox = overlay.querySelector<HTMLInputElement>('#intro-hide')!

  function close(): void {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    prevFocus?.focus?.()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss() }
  }

  /** スキップ / Esc / 背景クリック。状態は変えない（チェックだけは尊重） */
  function dismiss(): void {
    writeDismissed(hideBox.checked)
    close()
  }

  function apply(): void {
    const areaId = showArea
      ? (form.querySelector<HTMLInputElement>('input[name="intro-area"]:checked')?.value
          ?? currentAreaId)
      : currentAreaId
    const floodModel = (form.querySelector<HTMLInputElement>(
      'input[name="intro-model"]:checked')?.value ?? 'simple') as FloodModel
    const tideRaw = form.querySelector<HTMLInputElement>('input[name="intro-tide"]:checked')?.value
    const waterLevel = tideRaw !== undefined ? Number(tideRaw) : store.state.waterLevel

    writeDismissed(hideBox.checked)
    const plan = planStartupApply({ areaId, floodModel, waterLevel }, currentAreaId)
    if (plan.reload) {
      try {
        if (plan.carry) sessionStorage.setItem(SS_PENDING, JSON.stringify(plan.carry))
      } catch { /* private モード: 読み直し後は既定で始まる */ }
      const u = new URL(location.href)
      u.searchParams.set('area', plan.areaId!)
      location.href = u.toString()
      return
    }
    if (plan.patch) store.set(plan.patch)
    close()
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); apply() })
  overlay.querySelector('#intro-skip')!.addEventListener('click', dismiss)
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) dismiss() })
  document.addEventListener('keydown', onKey, true)

  // 最初のラジオへフォーカス（「浸水の決め方」= 単純）
  overlay.querySelector<HTMLInputElement>('input[name="intro-model"]')?.focus()
}
