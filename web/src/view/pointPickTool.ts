// 地図上で 1 点を指定する操作（`docs/todo.md` T1「任意地点＋徒歩圏」の中心点 UI）。
//
// `view/sectionTool.ts`（測線を 2 点クリックで引く）と同じ組み立てで、
// クリックとドラッグ（カメラ回転）を取り合わないための pointerdown/up の
// 距離判定もそのまま踏襲する。1 点だけを確定する分、状態機械は単純。

import type { Viewer } from '../three/viewer'

export type LonLat = [number, number]

export interface PointPickToolOptions {
  viewer: Viewer
  /** クリックを交える平面の高さ [m]。`sectionTool` と同じくジオイド高を渡す */
  planeZ?: number
  /** 1 点が確定した */
  onPick: (p: LonLat) => void
  /** 作図中の状態が変わった（UI のボタン表示用） */
  onState: (s: { active: boolean }) => void
}

/** クリックとドラッグを分ける閾値 [px]。回転操作で誤確定しないため */
const DRAG_SLOP = 4

export class PointPickTool {
  private active = false
  private down: [number, number] | null = null

  constructor(private readonly o: PointPickToolOptions) {
    const canvas = o.viewer.canvas
    canvas.addEventListener('pointerdown', (e) => {
      this.down = [e.clientX, e.clientY]
    })
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down
      this.down = null
      if (!this.active || !d) return
      if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > DRAG_SLOP) return
      const r = canvas.getBoundingClientRect()
      const p = o.viewer.unproject(e.clientX - r.left, e.clientY - r.top, o.planeZ ?? 0)
      if (!p) return                      // 地平線より上をクリックした
      this.o.onPick(p)
      this.stop()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active) this.stop()
    })
  }

  get isActive() { return this.active }

  start() {
    this.active = true
    this.o.viewer.canvas.style.cursor = 'crosshair'
    this.o.onState({ active: true })
  }

  stop() {
    this.active = false
    this.o.viewer.canvas.style.cursor = ''
    this.o.onState({ active: false })
  }

  toggle() { this.active ? this.stop() : this.start() }
}
