// 汎用の「エクスポート」モーダル。形式（と必要なら潮位など）をラジオで選び、
// 1 つの「ダウンロード」ボタンで確定する。中身は `ui/operationSettingsModal.ts` と
// 同じ骨組み（overlay + intro-card + Escape/クリックアウトで閉じる）。
//
// ボタンを個々に並べる代わりにここへ寄せているのは、選択肢が増えても画面上の
// ボタン数を増やさないため（巡回対象リストは 潮位 × 形式 で 4 通りある）。

export interface ExportOption {
  value: string
  label: string
  /** 選択肢の下に添える短い説明（任意） */
  hint?: string
  default?: boolean
}

export interface ExportFieldset {
  legend: string
  name: string
  options: ExportOption[]
}

export interface ExportModalConfig {
  title: string
  lead?: string
  fieldsets: ExportFieldset[]
  /** 「ダウンロード」を押したときに呼ぶ。`selected` は `fieldset.name -> 選んだ value`。
   *  呼び出し後にモーダルを閉じる（非同期でも待たない — ダウンロード自体は
   *  `triggerDownload` 側で完結させる） */
  onConfirm: (selected: Record<string, string>) => void
}

/**
 * エクスポートモーダルを開く。呼び出しのたびに新しい overlay を作る
 * （`opsettings-modal` と違い、地域別集計・巡回対象リストなど複数箇所から呼ばれ、
 * 同時に 2 つ開くことは無い運用だが、念のため既存があれば閉じてから開く）。
 */
export function openExportModal(config: ExportModalConfig): void {
  document.getElementById('export-modal')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'export-modal'
  const fieldsetsHtml = config.fieldsets.map((fs) => {
    const hasDefault = fs.options.some((o) => o.default)
    return `<fieldset>
      <legend>${fs.legend}</legend>
      ${fs.options.map((o, oi) => `
        <label class="opt">
          <input type="radio" name="${fs.name}" value="${o.value}"
                 ${o.default || (!hasDefault && oi === 0) ? 'checked' : ''}/>
          <span class="opt-t">${o.label}</span>
          ${o.hint ? `<span class="opt-d">${o.hint}</span>` : ''}
        </label>`).join('')}
    </fieldset>`
  }).join('')
  overlay.innerHTML = `
    <div class="intro-card" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <h2 id="export-title">${config.title}</h2>
      ${config.lead ? `<p class="intro-lead">${config.lead}</p>` : ''}
      <form id="export-form">
        ${fieldsetsHtml}
        <div class="intro-foot">
          <div class="intro-btns">
            <button type="button" id="export-cancel" class="intro-secondary">キャンセル</button>
            <button type="button" id="export-go" class="intro-primary">ダウンロード</button>
          </div>
        </div>
      </form>
    </div>`
  document.body.appendChild(overlay)

  const prevFocus = document.activeElement as HTMLElement | null
  const form = overlay.querySelector<HTMLFormElement>('#export-form')!

  function close(): void {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    prevFocus?.focus?.()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }

  overlay.querySelector('#export-go')!.addEventListener('click', () => {
    const selected: Record<string, string> = {}
    for (const fs of config.fieldsets) {
      selected[fs.name] = form.querySelector<HTMLInputElement>(
        `input[name="${fs.name}"]:checked`)?.value ?? fs.options[0].value
    }
    close()
    config.onConfirm(selected)
  })
  overlay.querySelector('#export-cancel')!.addEventListener('click', close)
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close() })
  document.addEventListener('keydown', onKey, true)

  overlay.querySelector<HTMLInputElement>('input:checked')?.focus()
}
