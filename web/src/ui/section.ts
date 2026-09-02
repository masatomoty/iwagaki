// 断面図。測線に沿った地形と、いまの水位を横から見る。
//
// **3D の俯瞰では 0〜3 m の起伏が潰れて読めない。** このリポジトリの問いは
// 「護岸天端を水位が越えるか」なので、横から見て水平線を引くのが一番直接的である。
//
// 塗る区間は `state.floodModel` で決まる。**既定は単純モデル**（潮位 − 地盤高）で、
// 標高が水位より低い区間をそのまま塗る。`connected` を選ぶと `h_conn <= H` を
// 満たす区間だけになり、護岸天端の内側は塗られない（このリポジトリ本来の主張）。
// 断面図はその 2 つの違いが**いちばん直接見える場所**でもある。

import type { SamplePoint } from '../assets/terrainSampler'
import type { FloodModel, TerrainCondition } from '../domain/types'

export interface SectionSeries {
  condition: TerrainCondition
  label: string
  color: string
  points: SamplePoint[]
}

const PAD = { left: 54, right: 14, top: 16, bottom: 30 }

/** 軸と凡例の文字。パネル外に注記を持たないので、ここが読めないと何も分からない */
const FONT = { axis: '12.5px system-ui, sans-serif', legend: '600 13px system-ui, sans-serif' }

/** データが来る前の状態。**パネル下の注記をやめたので canvas に出す** */
export function drawSectionMessage(canvas: HTMLCanvasElement, text: string) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const dpr = devicePixelRatio || 1
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(226,232,240,.6)'
  ctx.font = FONT.axis
  ctx.textAlign = 'center'
  ctx.fillText(text, w / 2, h / 2)
}

/**
 * 縦軸の範囲。
 *
 * **全体に合わせると肝心のところが潰れる。** 吉原は市街地が 0〜3 m、背後が
 * 40 m 超なので、素直に min/max を取ると 3D の俯瞰と同じ「起伏が読めない絵」になる。
 * 断面を出す目的は「水位が天端を越えるか」を見ることなので、
 * **既定は水位のまわりに合わせ**、全体は切り替えで見せる。
 */
function zRange(
  series: SectionSeries[], waterLevel: number, fit: 'water' | 'all',
): [number, number] {
  const vals = series.flatMap((s) => s.points.map((p) => p.elev))
    .filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (vals.length === 0) return [waterLevel - 1, waterLevel + 1]
  const q = (t: number) => vals[Math.min(vals.length - 1, Math.floor(t * (vals.length - 1)))]
  let lo = Math.min(q(0.01), waterLevel)
  let hi = fit === 'all'
    ? Math.max(q(0.99), waterLevel)
    // 水位より 3 m 上まで。低地の起伏（数十 cm）が読める倍率になる
    : Math.max(waterLevel + 3, q(0.5) + 1)
  if (hi - lo < 2) { const c = (hi + lo) / 2; lo = c - 1; hi = c + 1 }
  const m = (hi - lo) * 0.1
  return [lo - m, hi + m]
}

/** 目盛り幅。5〜7 本に収まる「きりのいい」値を選ぶ */
function niceStep(span: number): number {
  const raw = span / 6
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p
  return 10 * p
}

export function drawSection(
  canvas: HTMLCanvasElement, series: SectionSeries[], waterLevel: number,
  fit: 'water' | 'all' = 'water', model: FloodModel = 'simple',
  /**
   * 測線を引いた直後の立ち上がり（`docs/todo.md` U4）。0〜1 で、地形ライン・
   * 浸水塗り・水位線を左から `reveal` の割合だけ見せる。**目盛りと凡例は
   * 動かさない**（読む足場なので即座に出す）。1 = 通常の即時描画。
   */
  reveal = 1,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const dpr = devicePixelRatio || 1
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const withData = series.filter((s) => s.points.some((p) => Number.isFinite(p.elev)))
  if (withData.length === 0) {
    // 測線が丸ごと水域（航空レーザは水面から反射が返らない）か、タイル範囲の外。
    // 空の canvas を出すのではなく、水位線と理由を描く（`docs/web_design.md`
    // 「海が一枚も描かれていなかった」と同じ扱い）。陸側から引き直せば断面は出る。
    const anyWet = series.some((s) => s.points.some((p) => p.hConn <= waterLevel))
    const yW = h * 0.5
    ctx.strokeStyle = 'rgba(96,165,250,.9)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.beginPath(); ctx.moveTo(PAD.left, yW); ctx.lineTo(w - PAD.right, yW); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(96,165,250,.95)'
    ctx.font = FONT.legend
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
    ctx.fillText(`H = ${waterLevel.toFixed(2)} m T.P.`, PAD.left + 4, yW - 3)
    ctx.fillStyle = 'rgba(226,232,240,.6)'
    ctx.font = FONT.axis
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(
      anyWet ? '水域 — 水面から下の地形データはありません（陸側から引き直してください）'
             : 'この測線には地形データがありません（タイル範囲の外）',
      w / 2, yW + 10,
    )
    return
  }

  const dMax = Math.max(...withData.map((s) => s.points.at(-1)?.d ?? 0), 1)
  const [zLo, zHi] = zRange(withData, waterLevel, fit)
  const X = (d: number) => PAD.left + (d / dMax) * (w - PAD.left - PAD.right)
  const Y = (z: number) => h - PAD.bottom - ((z - zLo) / (zHi - zLo)) * (h - PAD.top - PAD.bottom)

  // 目盛り
  ctx.strokeStyle = 'rgba(148,163,184,.18)'
  ctx.fillStyle = 'rgba(148,163,184,.75)'
  ctx.font = FONT.axis
  ctx.lineWidth = 1
  const zStep = niceStep(zHi - zLo)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let z = Math.ceil(zLo / zStep) * zStep; z <= zHi; z += zStep) {
    const y = Y(z)
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(w - PAD.right, y); ctx.stroke()
    ctx.fillText(zStep < 1 ? z.toFixed(1) : z.toFixed(0), PAD.left - 6, y)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const dStep = dMax > 800 ? 200 : dMax > 300 ? 100 : 50
  for (let d = 0; d <= dMax; d += dStep) {
    const x = X(d)
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, h - PAD.bottom); ctx.stroke()
    ctx.fillText(`${d.toFixed(0)}`, x, h - PAD.bottom + 5)
  }
  ctx.textAlign = 'left'
  ctx.fillText('m', PAD.left - 40, PAD.top - 2)
  ctx.textAlign = 'right'
  ctx.fillText('距離 m', w - PAD.right, h - PAD.bottom + 5)

  // ここから下（塗り・水位線・地形ライン）は測線を引いた直後だけ左から現れる。
  // 目盛りは上で描き終えているので clip の外側で、立ち上がっても動かない
  const revealing = reveal < 1
  if (revealing) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, PAD.left + reveal * (w - PAD.left - PAD.right), h)
    ctx.clip()
  }

  // 浸水する区間を塗る。**先頭の条件（いま画面に出ているもの）で判定する**
  const main = withData[0]
  ctx.fillStyle = 'rgba(56,132,222,.30)'
  let run: SamplePoint[] = []
  const flush = () => {
    if (run.length > 1) {
      ctx.beginPath()
      ctx.moveTo(X(run[0].d), Y(waterLevel))
      for (const p of run) ctx.lineTo(X(p.d), Y(Math.min(p.elev, waterLevel)))
      ctx.lineTo(X(run.at(-1)!.d), Y(waterLevel))
      ctx.closePath()
      ctx.fill()
    }
    run = []
  }
  for (const p of main.points) {
    // 単純モデル（既定）は連結性を問わない。domain/flood.ts の depth() と同じ形
    const wet = Number.isFinite(p.elev) && p.elev < waterLevel
      && (model === 'simple' || p.hConn <= waterLevel)
    if (wet) run.push(p)
    else flush()
  }
  flush()

  // 水位線
  ctx.strokeStyle = 'rgba(96,165,250,.95)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.beginPath(); ctx.moveTo(PAD.left, Y(waterLevel)); ctx.lineTo(w - PAD.right, Y(waterLevel))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(96,165,250,.95)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.font = FONT.legend
  ctx.fillText(`H = ${waterLevel.toFixed(2)} m T.P.`, PAD.left + 4, Y(waterLevel) - 3)

  // 地形。条件ごとに 1 本
  for (const s of withData) {
    ctx.strokeStyle = s.color
    ctx.lineWidth = s === main ? 2 : 1.3
    ctx.beginPath()
    let started = false
    for (const p of s.points) {
      if (!Number.isFinite(p.elev)) { started = false; continue }
      const x = X(p.d)
      const y = Math.max(PAD.top, Math.min(h - PAD.bottom, Y(p.elev)))
      if (started) ctx.lineTo(x, y)
      else { ctx.moveTo(x, y); started = true }
    }
    ctx.stroke()
  }

  if (revealing) ctx.restore()

  // 凡例
  ctx.font = FONT.axis
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let lx = PAD.left + 4
  for (const s of withData) {
    ctx.fillStyle = s.color
    ctx.fillRect(lx, PAD.top + 1, 10, 3)
    ctx.fillStyle = 'rgba(226,232,240,.85)'
    ctx.fillText(s.label, lx + 14, PAD.top - 3)
    lx += 14 + ctx.measureText(s.label).width + 12
  }
}
