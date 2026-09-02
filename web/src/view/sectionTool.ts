// 地図上で測線を引く操作。描画ライブラリに触るのはここだけにして、
// 断面の計算（assets/terrainSampler.ts）と描画（ui/section.ts）から分離する。
//
// 画面座標 -> 経緯度は `Viewer.unproject` に任せる（平面の高さは planeZ で渡す）。
// 旧実装は MapLibre の `map.on('click')` の `e.lngLat` で、これも terrain を
// 使わない z=0 交点だったので、**同じ点を指す**。

import type { Viewer } from '../three/viewer'

export type LonLat = [number, number]

export interface SectionToolOptions {
  viewer: Viewer
  /**
   * 測線を交える平面の高さ [m]。**ジオイド高を渡す。**
   * 0 のままだと z=0 平面と交わり、俯瞰で 47 m・軸方向で 352 m ずれる。
   * 市街の起伏 0〜3 m ぶんの残差（俯瞰で 4 m 弱）は無視する。
   */
  planeZ?: number
  /** 測線が確定した */
  onLine: (from: LonLat, to: LonLat) => void
  /** 作図中の状態が変わった（UI のボタン表示用） */
  onState: (s: { active: boolean; hasFirst: boolean }) => void
  /**
   * 仮の測線（`docs/todo.md` U4: 「1 点目を設定するところから」）。1 点目を置いた
   * 瞬間に `(from, null)`、カーソルが動くたびに `(from, cursor)`、2 点目確定・
   * Esc・停止で `(null, null)`。地図側は `null` で仮の測線を消す。
   */
  onPreview?: (from: LonLat | null, to: LonLat | null) => void
}

/** クリックとドラッグを分ける閾値 [px]。回転操作で測線を引いてしまわないため */
const DRAG_SLOP = 4

export class SectionTool {
  private active = false
  private first: LonLat | null = null
  private down: [number, number] | null = null

  constructor(private readonly o: SectionToolOptions) {
    const canvas = o.viewer.canvas
    // Viewer の操作はポインタで組んであり click は上がってこないことがある。
    // 押した位置と離した位置が近いときだけクリックとみなす
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
      // 地平線より上をクリックした。測線の端点にできない
      if (!p) return
      if (!this.first) {
        this.first = p
        this.o.onState({ active: true, hasFirst: true })
        this.o.onPreview?.(p, null)
        return
      }
      this.o.onLine(this.first, p)   // この中で確定リボンが描かれる
      this.stop()                    // stop() が仮の測線を消す
    })
    // 1 点目を置いたあと、カーソルに追従する仮の測線を出す
    canvas.addEventListener('pointermove', (e) => {
      if (!this.active || !this.first) return
      const r = canvas.getBoundingClientRect()
      const p = o.viewer.unproject(e.clientX - r.left, e.clientY - r.top, o.planeZ ?? 0)
      if (p) this.o.onPreview?.(this.first, p)
    })
    // 作図中は Esc で抜ける。地物クリックと取り合いになるので、抜け道を用意する
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active) this.stop()
    })
  }

  get isActive() { return this.active }

  start() {
    this.active = true
    this.first = null
    this.o.viewer.canvas.style.cursor = 'crosshair'
    this.o.onState({ active: true, hasFirst: false })
  }

  stop() {
    const hadFirst = this.first !== null
    this.active = false
    this.first = null
    this.o.viewer.canvas.style.cursor = ''
    this.o.onState({ active: false, hasFirst: false })
    if (hadFirst) this.o.onPreview?.(null, null)
  }

  toggle() { this.active ? this.stop() : this.start() }
}
