// 直方体ベースのビューキューブ（右上）。Fusion の ViewCube 風。
//
// **描画ライブラリに依存しない。** 2D canvas に 8 頂点を自前で投影して描く。
// three.js の小さな WebGL レンダラを別に立てる手もあるが、本リポジトリの
// 実測結論は「細い回線で効くのは初期チャンクのサイズだけ」（docs/web_results.md）
// なので、ギズモのためにレンダラを 1 つ増やすのは自分の結論と矛盾する。
// カメラの向きを受け取って向きを返すだけなので、
// メインが MapLibre でも three.js でもそのまま動く。
//
// 面 / 辺 / 角の 26 方向をクリックで選べる。ドラッグで自由回転。

/** カメラの向き。bearing はカメラが向く方位[deg]、pitch は真下からの傾き[deg] */
export interface CubeOrientation { bearingDeg: number; pitchDeg: number }

/** ローカル ENU（x=東, y=北, z=上）での視点方向。長さは 1 に正規化しない */
type Dir = [number, number, number]

export interface ViewCubeOptions {
  /** キューブの一辺の描画サイズ [px] */
  size?: number
  /** 面/辺/角がクリックされた。カメラをその向きへ動かす */
  onPick: (o: CubeOrientation) => void
  /** ドラッグ量 [px]。メインビューを自由回転させる */
  onDrag: (dx: number, dy: number) => void
}

const FACES: { dir: Dir; label: string }[] = [
  { dir: [0, -1, 0], label: '南' },
  { dir: [0, 1, 0], label: '北' },
  { dir: [1, 0, 0], label: '東' },
  { dir: [-1, 0, 0], label: '西' },
  { dir: [0, 0, 1], label: '平面' },
  { dir: [0, 0, -1], label: '底' },
]

/** 面 6 + 辺 12 + 角 8 = 26 方向。成分が 0 でないものの組み合わせ */
function allDirections(): Dir[] {
  const out: Dir[] = []
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (x || y || z) out.push([x, y, z])
      }
    }
  }
  return out
}

/**
 * 視点方向 → カメラの向き。
 *
 * `dir` は「カメラが対象から見てどちら側にいるか」。カメラは `-dir` を向く。
 * MapLibre の pitch は 0 が真上から見下ろし、bearing はカメラが向く方位。
 */
export function dirToOrientation(dir: Dir, maxPitch = 85): CubeOrientation {
  const [x, y, z] = dir
  const len = Math.hypot(x, y, z) || 1
  const uz = z / len
  const pitch = Math.min(maxPitch, (Math.acos(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI)
  // 真上/真下からは方位が定まらないので、いまの方位を保つ意味で 0 にする
  const flat = Math.hypot(x, y)
  const bearing = flat < 1e-9 ? 0 : (Math.atan2(-x, -y) * 180) / Math.PI
  return { bearingDeg: (bearing + 360) % 360, pitchDeg: pitch }
}

/** ENU のベクトルを画面座標へ。bearing/pitch はカメラの向き */
function project(v: Dir, o: CubeOrientation, scale: number): [number, number, number] {
  const b = (o.bearingDeg * Math.PI) / 180
  const p = (o.pitchDeg * Math.PI) / 180
  // カメラの方位ぶん回す（画面上方向が bearing の向きになるように）
  const cx = v[0] * Math.cos(b) - v[1] * Math.sin(b)
  const cy = v[0] * Math.sin(b) + v[1] * Math.cos(b)
  const cz = v[2]
  // pitch を倒す。pitch=0 なら真上から見るので z が奥行きになる
  const sy = cy * Math.cos(p) - cz * Math.sin(p)
  const sz = cy * Math.sin(p) + cz * Math.cos(p)
  return [cx * scale, -sy * scale, sz]
}

export class ViewCube {
  readonly el: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size: number
  private orient: CubeOrientation = { bearingDeg: 0, pitchDeg: 0 }
  private hover: Dir | null = null
  private downAt: [number, number] | null = null
  private last: [number, number] = [0, 0]
  private dragging = false
  private readonly dirs = allDirections()

  constructor(private readonly o: ViewCubeOptions) {
    this.size = o.size ?? 128
    const px = this.size + 24
    this.el = document.createElement('canvas')
    this.el.width = px * devicePixelRatio
    this.el.height = px * devicePixelRatio
    Object.assign(this.el.style, {
      width: `${px}px`, height: `${px}px`, cursor: 'pointer', touchAction: 'none',
    } as CSSStyleDeclaration)
    this.el.title = 'ビューキューブ: 面・辺・角をクリックで整列 / ドラッグで回転'
    const c = this.el.getContext('2d')
    if (!c) throw new Error('2d context を取得できない')
    this.ctx = c
    this.ctx.scale(devicePixelRatio, devicePixelRatio)

    this.el.addEventListener('pointerdown', (e) => {
      this.downAt = [e.clientX, e.clientY]
      this.last = [e.clientX, e.clientY]
      this.dragging = false
      this.el.setPointerCapture(e.pointerId)
    })
    this.el.addEventListener('pointermove', (e) => {
      if (this.downAt) {
        // 少し動くまでは回転しない。クリック時の微小移動で視点が動くのを防ぐ
        if (!this.dragging &&
            Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) < 4) return
        this.dragging = true
        this.o.onDrag(e.clientX - this.last[0], e.clientY - this.last[1])
        this.last = [e.clientX, e.clientY]
        return
      }
      const h = this.pick(e)
      if (h !== this.hover) { this.hover = h; this.draw() }
    })
    const end = (e: PointerEvent) => {
      if (this.downAt && !this.dragging) {
        const d = this.pick(e)
        if (d) this.o.onPick(dirToOrientation(d))
      }
      this.downAt = null
      this.dragging = false
    }
    this.el.addEventListener('pointerup', end)
    this.el.addEventListener('pointercancel', () => { this.downAt = null; this.dragging = false })
    this.el.addEventListener('pointerleave', () => {
      if (this.hover) { this.hover = null; this.draw() }
    })
  }

  /** カメラが動いたら呼ぶ */
  setOrientation(o: CubeOrientation) {
    if (o.bearingDeg === this.orient.bearingDeg && o.pitchDeg === this.orient.pitchDeg) return
    this.orient = o
    this.draw()
  }

  private centre(): [number, number] {
    const px = this.size + 24
    return [px / 2, px / 2]
  }

  /** クリック位置に最も近い「手前を向いている」方向を返す */
  private pick(e: PointerEvent): Dir | null {
    const r = this.el.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const [cx, cy] = this.centre()
    const scale = this.size / 2.6
    let best: Dir | null = null
    let bestD = Infinity
    for (const d of this.dirs) {
      const [x, y, z] = project(d, this.orient, scale)
      if (z < -0.05) continue                    // 奥を向いている
      const dist = Math.hypot(cx + x - mx, cy + y - my)
      // 角・辺は面より小さい当たり判定にする（面の中央を押しやすくする）
      const rank = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2])
      const limit = rank === 1 ? this.size * 0.26 : this.size * 0.17
      if (dist < limit && dist < bestD) { bestD = dist; best = d }
    }
    return best
  }

  draw() {
    const px = this.size + 24
    const ctx = this.ctx
    ctx.clearRect(0, 0, px, px)
    const [cx, cy] = this.centre()
    const scale = this.size / 2.6
    const h = 1

    // 面を奥から手前へ塗る（painter）
    const faces = FACES.map((f) => {
      const [, , z] = project(f.dir, this.orient, scale)
      return { ...f, z }
    }).sort((a, b) => a.z - b.z)

    for (const f of faces) {
      if (f.z < 0.02) continue
      const corners = cornersOf(f.dir, h)
      ctx.beginPath()
      corners.forEach((v, i) => {
        const [x, y] = project(v, this.orient, scale)
        if (i === 0) ctx.moveTo(cx + x, cy + y)
        else ctx.lineTo(cx + x, cy + y)
      })
      ctx.closePath()
      const hovered = this.hover && sameDir(this.hover, f.dir)
      // 手前ほど明るく。正対している面が一番明るい
      const t = Math.max(0, Math.min(1, f.z))
      ctx.fillStyle = hovered
        ? 'rgba(96,165,250,0.92)'
        : `rgba(${34 + t * 26}, ${40 + t * 30}, ${52 + t * 34}, 0.94)`
      ctx.fill()
      ctx.strokeStyle = 'rgba(160,180,205,0.55)'
      ctx.lineWidth = 1
      ctx.stroke()

      // ラベルは正対に近い面だけ
      if (f.z > 0.55) {
        const [lx, ly] = project(f.dir.map((v) => v * h * 0.92) as Dir, this.orient, scale)
        ctx.fillStyle = hovered ? '#0b1020' : 'rgba(226,232,240,0.92)'
        ctx.font = `600 ${Math.round(this.size * 0.13)}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(f.label, cx + lx, cy + ly)
      }
    }

    // ホバー中が辺・角なら小さな印を出す（面はハイライト済み）
    if (this.hover) {
      const rank = Math.abs(this.hover[0]) + Math.abs(this.hover[1]) + Math.abs(this.hover[2])
      if (rank > 1) {
        const [x, y] = project(this.hover.map((v) => v * h) as Dir, this.orient, scale)
        ctx.beginPath()
        ctx.arc(cx + x, cy + y, this.size * 0.055, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(96,165,250,0.95)'
        ctx.fill()
      }
    }

    // 北を指す小さな目印。回転しても方位が分かるように
    const [nx, ny] = project([0, 1.42, 0], this.orient, scale)
    ctx.fillStyle = 'rgba(248,113,113,0.95)'
    ctx.font = `700 ${Math.round(this.size * 0.11)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', cx + nx, cy + ny)
  }
}

function sameDir(a: Dir, b: Dir) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }

/** その面の 4 隅（法線方向 dir の面）。dir は軸に平行な単位ベクトル */
function cornersOf(dir: Dir, h: number): Dir[] {
  const axis = dir.findIndex((v) => v !== 0)
  const sign = dir[axis]
  const other = [0, 1, 2].filter((i) => i !== axis)
  const mk = (s1: number, s2: number): Dir => {
    const v: Dir = [0, 0, 0]
    v[axis] = sign * h
    v[other[0]] = s1 * h
    v[other[1]] = s2 * h
    return v
  }
  return [mk(-1, -1), mk(1, -1), mk(1, 1), mk(-1, 1)]
}
