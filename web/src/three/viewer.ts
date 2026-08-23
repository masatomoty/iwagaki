// カメラと描画ループ。MapLibre + @deck.gl/mapbox の置き換え。
//
// MapLibre がやっていたのは (1) 透視カメラ (2) メルカトル投影 (3) 操作 (4) ギズモ の 4 つで、
// **ベースマップは 1 枚も描いていなかった**（旧 view/map.ts の style は sources: {}）。
// その 4 つのために初期チャンクの約 1/3 を払っていたので、ここで自前に置き換える。
//
// ついでに **正射投影**（docs/TODO.md B1）を入れる。MapLibre は透視しか持たないため
// 「CAD のように断面で見る」が積み残しになっていた。

import {
  AmbientLight, Group, OrthographicCamera, PerspectiveCamera, Scene,
  Vector3, WebGLRenderer,
} from 'three'

import { lngLatToWorld, worldToLngLat, zoomForMetresPerPixel, type LocalFrame } from './mercator'

export type ProjectionMode = 'perspective' | 'orthographic'

export interface CameraState {
  /** 注視点のワールド XY [m] */
  target: [number, number]
  /** 注視点からの距離 [m] */
  distance: number
  /** 0 = 真上から, 85 = ほぼ真横 [deg] */
  pitch: number
  /** カメラが向く方位 [deg] */
  bearing: number
}

/** 旧 view/map.ts と同じ視野角。点群 LOD の screenSpaceError がこれを前提にしている */
export const FOV_Y_DEG = 36.87

const MIN_DISTANCE = 30
const MAX_DISTANCE = 20_000
const MAX_PITCH = 85

export interface ViewerOptions {
  container: HTMLElement
  frame: LocalFrame
  /** [w, s, e, n]。注視点をこの外に出さない */
  maxBoundsLngLat: [number, number, number, number]
  initial: Partial<CameraState>
}

type Handler = () => void

export class Viewer {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  /** レイヤはここにぶら下げる。deck.gl の layers 配列に相当 */
  readonly world = new Group()
  readonly frame: LocalFrame

  private persp: PerspectiveCamera
  private ortho: OrthographicCamera
  private projection: ProjectionMode = 'perspective'
  private cam: CameraState
  private bounds: [number, number, number, number]
  private handlers: Record<string, Set<Handler>> = {}
  private needsRender = true
  private disposed = false
  private renderCbs = new Set<Handler>()

  constructor(o: ViewerOptions) {
    this.frame = o.frame
    this.bounds = o.maxBoundsLngLat
    this.cam = {
      target: o.initial.target ?? [0, 0],
      distance: o.initial.distance ?? 900,
      pitch: o.initial.pitch ?? 52,
      bearing: o.initial.bearing ?? -28,
    }

    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none'
    o.container.appendChild(canvas)

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      // 標高テクスチャを自前でデコードするので、色空間の変換は一切させない
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setClearColor(0x0d1017, 1)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

    // Z 軸を上にする。地形も点群も標高が Z なので、three の既定 (Y up) は使わない
    this.persp = new PerspectiveCamera(FOV_Y_DEG, 1, 1, 200_000)
    this.persp.up.set(0, 0, 1)
    this.ortho = new OrthographicCamera(-1, 1, 1, -1, -100_000, 200_000)
    this.ortho.up.set(0, 0, 1)

    this.scene.add(this.world)
    this.scene.add(new AmbientLight(0xffffff, 1))

    this.bindInput(canvas)
    this.resize()
    new ResizeObserver(() => this.resize()).observe(o.container)
    this.applyCamera()
    this.loop()
  }

  // ---- 外部 API（旧 main.ts が map に対して呼んでいたもの）--------------------

  get canvas(): HTMLCanvasElement { return this.renderer.domElement }

  /**
   * MapLibre の zoom と同じ意味の値でカメラ距離を決める。
   * zoom は「画面 1 px が何メートルか」の指標なので、距離はビューポート高に比例する。
   * 初期視点を旧実装（zoom 15.6）と一致させるために要る。
   */
  setZoom(z: number) {
    const worldMetres = 2 * Math.PI * 6378137 * this.frame.scale
    const mpp = worldMetres / (256 * 2 ** z)
    const h = this.canvas.clientHeight || 1
    this.setCamera({ distance: (mpp * h) / (2 * Math.tan((FOV_Y_DEG * Math.PI) / 360)) }, false)
  }

  /** MapLibre の map.getZoom() 相当 */
  getZoom(): number {
    return zoomForMetresPerPixel(this.frame, this.metresPerPixel())
  }

  /** 画面中心 1 px が何メートルか */
  metresPerPixel(): number {
    const h = this.canvas.clientHeight || 1
    const worldH = 2 * this.cam.distance * Math.tan((FOV_Y_DEG * Math.PI) / 360)
    return worldH / h
  }

  /** MapLibre の transform.cameraToCenterDistance 相当（点群 LOD が使う） */
  get cameraToCenterDistance(): number { return this.cam.distance }

  /** 画面に映っている経緯度の範囲 [w, s, e, n] */
  getBoundsLngLat(): [number, number, number, number] {
    const pts = this.groundCorners()
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const [x, y] of pts) {
      const [lon, lat] = worldToLngLat(this.frame, x, y)
      w = Math.min(w, lon); e = Math.max(e, lon)
      s = Math.min(s, lat); n = Math.max(n, lat)
    }
    return [w, s, e, n]
  }

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.projection === 'perspective' ? this.persp : this.ortho
  }

  get cameraState(): Readonly<CameraState> { return this.cam }

  get projectionMode(): ProjectionMode { return this.projection }

  setProjection(mode: ProjectionMode) {
    if (this.projection === mode) return
    this.projection = mode
    this.applyCamera()
    this.emit('move')
    this.emit('moveend')
  }

  /** MapLibre の easeTo 相当。プリセット切り替えに使う */
  easeTo(patch: Partial<CameraState>, durationMs = 500) {
    const from = { ...this.cam }
    const to = { ...this.cam, ...patch }
    // 方位は近い方に回す
    if (patch.bearing !== undefined) {
      let d = ((to.bearing - from.bearing + 540) % 360) - 180
      to.bearing = from.bearing + d
    }
    if (durationMs <= 0) { this.setCamera(to); return }
    const t0 = performance.now()
    this.emit('movestart')
    const step = () => {
      if (this.disposed) return
      const k = Math.min(1, (performance.now() - t0) / durationMs)
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2   // easeInOutQuad
      this.setCamera({
        target: [
          from.target[0] + (to.target[0] - from.target[0]) * e,
          from.target[1] + (to.target[1] - from.target[1]) * e,
        ],
        distance: from.distance + (to.distance - from.distance) * e,
        pitch: from.pitch + (to.pitch - from.pitch) * e,
        bearing: from.bearing + (to.bearing - from.bearing) * e,
      }, false)
      if (k < 1) requestAnimationFrame(step)
      else this.emit('moveend')
    }
    requestAnimationFrame(step)
  }

  setCamera(patch: Partial<CameraState>, emitStart = true) {
    if (emitStart) this.emit('movestart')
    this.cam = { ...this.cam, ...patch }
    this.cam.pitch = Math.max(0, Math.min(MAX_PITCH, this.cam.pitch))
    this.cam.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.cam.distance))
    this.clampTarget()
    this.applyCamera()
    this.emit('move')
  }

  on(event: 'movestart' | 'move' | 'moveend' | 'render', fn: Handler) {
    if (event === 'render') { this.renderCbs.add(fn); return }
    ;(this.handlers[event] ??= new Set()).add(fn)
  }

  /** 次のフレームで描き直す。レイヤ側が内容を変えたときに呼ぶ */
  invalidate() { this.needsRender = true }

  dispose() {
    this.disposed = true
    this.renderer.dispose()
  }

  // ---- 内部 -----------------------------------------------------------------

  private emit(event: string) {
    this.needsRender = true
    for (const f of this.handlers[event] ?? []) f()
  }

  private clampTarget() {
    const [w, s, e, n] = this.bounds
    const [x0, y0] = lngLatToWorld(this.frame, w, s)
    const [x1, y1] = lngLatToWorld(this.frame, e, n)
    this.cam.target[0] = Math.max(Math.min(x0, x1), Math.min(Math.max(x0, x1), this.cam.target[0]))
    this.cam.target[1] = Math.max(Math.min(y0, y1), Math.min(Math.max(y0, y1), this.cam.target[1]))
  }

  /** 注視点まわりの球面座標からカメラ位置を作る */
  private eyePosition(): Vector3 {
    const p = (this.cam.pitch * Math.PI) / 180
    const b = (this.cam.bearing * Math.PI) / 180
    const d = this.cam.distance
    // pitch 0 = 真上。bearing はカメラが「向く」方位なので、視点はその逆側に置く
    const horiz = d * Math.sin(p)
    return new Vector3(
      this.cam.target[0] - horiz * Math.sin(b),
      this.cam.target[1] - horiz * Math.cos(b),
      d * Math.cos(p),
    )
  }

  private applyCamera() {
    const eye = this.eyePosition()
    const target = new Vector3(this.cam.target[0], this.cam.target[1], 0)
    const cam = this.camera
    cam.position.copy(eye)
    cam.up.set(0, 0, 1)
    cam.lookAt(target)
    if (cam instanceof OrthographicCamera) {
      // 透視と同じ画角を覆う正射ボリューム。切り替えても見えている範囲が変わらない
      const halfH = this.cam.distance * Math.tan((FOV_Y_DEG * Math.PI) / 360)
      const aspect = this.aspect()
      cam.top = halfH; cam.bottom = -halfH
      cam.left = -halfH * aspect; cam.right = halfH * aspect
    }
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    this.needsRender = true
  }

  private aspect(): number {
    const c = this.canvas
    return (c.clientWidth || 1) / (c.clientHeight || 1)
  }

  private resize() {
    const c = this.canvas
    const w = c.clientWidth || 1
    const h = c.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.persp.aspect = w / h
    this.applyCamera()
  }

  /**
   * 画面 4 隅を地面 (z=0) に落としたワールド座標。
   *
   * pitch が寝ていると上側の隅は地平線を向き、交点が無限遠に飛ぶ。素直に伸ばすと
   * 可視 bbox が数十 km になり、**視野に無いタイルまで要求してしまう**
   * （実測で @10s が 0.69 -> 3.75 MB に膨らんだ原因がこれ）。
   * レイの長さと bbox の広がりの両方で頭を押さえる。
   */
  private groundCorners(): [number, number][] {
    const cam = this.camera
    const out: [number, number][] = []
    const far = this.cam.distance * 4
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const near = new Vector3(nx, ny, -1).unproject(cam)
      const dir = new Vector3(nx, ny, 1).unproject(cam).sub(near).normalize()
      let t: number
      if (Math.abs(dir.z) < 1e-6) t = far
      else {
        t = -near.z / dir.z
        if (t < 0 || t > far) t = far          // 地平線の上を向いている隅
      }
      out.push([near.x + dir.x * t, near.y + dir.y * t])
    }
    // 注視点まわりに収める。真上から見たときの可視半径は distance * tan(fov/2) * aspect
    // なので、pitch が寝ている分を見込んでも 2.5 倍あれば取りこぼさない
    const lim = this.cam.distance * 2.5
    return out.map(([x, y]) => [
      Math.max(this.cam.target[0] - lim, Math.min(this.cam.target[0] + lim, x)),
      Math.max(this.cam.target[1] - lim, Math.min(this.cam.target[1] + lim, y)),
    ])
  }

  private bindInput(canvas: HTMLCanvasElement) {
    let mode: 'none' | 'pan' | 'rotate' = 'none'
    let lastX = 0, lastY = 0

    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      mode = e.button === 2 || e.shiftKey ? 'rotate' : 'pan'
      lastX = e.clientX; lastY = e.clientY
      this.emit('movestart')
    })
    canvas.addEventListener('pointermove', (e) => {
      if (mode === 'none') return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      if (mode === 'rotate') {
        this.setCamera({
          bearing: this.cam.bearing - dx * 0.3,
          pitch: this.cam.pitch - dy * 0.3,
        }, false)
      } else {
        // 画面上の移動量を地面のメートルに直す。pitch が寝るほど 1 px が遠くなる
        const mpp = this.metresPerPixel()
        const b = (this.cam.bearing * Math.PI) / 180
        const sx = -dx * mpp
        const sy = dy * mpp / Math.max(0.25, Math.cos((this.cam.pitch * Math.PI) / 180))
        this.setCamera({
          target: [
            this.cam.target[0] + sx * Math.cos(b) + sy * Math.sin(b),
            this.cam.target[1] - sx * Math.sin(b) + sy * Math.cos(b),
          ],
        }, false)
      }
    })
    const end = (e: PointerEvent) => {
      if (mode === 'none') return
      mode = 'none'
      try { canvas.releasePointerCapture(e.pointerId) } catch { /* 既に外れている */ }
      this.emit('moveend')
    }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const k = Math.exp(e.deltaY * 0.0015)
      this.emit('movestart')
      this.setCamera({ distance: this.cam.distance * k }, false)
      this.emit('moveend')
    }, { passive: false })
  }

  private loop = () => {
    if (this.disposed) return
    requestAnimationFrame(this.loop)
    for (const f of this.renderCbs) f()
    if (!this.needsRender) return
    this.needsRender = false
    this.renderer.render(this.scene, this.camera)
  }
}
