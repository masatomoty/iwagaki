// カメラのプリセットと操作。**MapLibre は使わない**（three.js 実体は src/three/viewer.ts）。
//
// MapLibre がここで担っていたのはカメラ・投影・ギズモだけで、ベースマップは
// 1 枚も描いていなかった（style の sources が空だった）。それに初期チャンクの
// 約 1/3 を払っていたので外した（docs/web_results.md §8.1）。
//
// 外向きの export 名は変えていない。src/ui/controls.ts がこのモジュールから
// CAMERA_PRESETS / CameraPresetId を読んでいるため。

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'

import type { Catalog } from '../domain/catalog'
import { createLocalFrame, lngLatToWorld, type LocalFrame } from '../three/mercator'
import { Viewer, type ProjectionMode } from '../three/viewer'
import { easeOutCubic, lerp, prefersReducedMotion } from './anim'
import { ViewCube } from './viewCube'

/**
 * 既定の注視点。**点群が取れている帯の中心**を見る。
 *
 * AOI の中心（100 ha の真ん中）は背後の山を含むので、起動直後の画面が
 * 「山と海」になっていた。見せたいのは吉原の市街で、**そこは点群と PLATEAU 建物が
 * 両方ある唯一の場所**である（点群は歩いた線に沿った 3.17 ha だけ）。
 *
 * 座標は埋め込まない。`catalog.pointcloud.bounds`（EPSG:6674）を
 * `local_frame` の行列でローカル ENU に直す。**`pointcloud/decode.worker.ts` が
 * 点そのものに使っているのと同じ変換**なので、必ず点群の上に来る。
 * 点群が無い範囲では **catalog の `aoi.focus_wgs84`**（標高 5 m 以下の建物の
 * 位置の中央値。`scripts/83` が入れる）を見る。625 ha の矩形の中心だと
 * 港と山に落ちて、起動直後の画面に市街が入らない [実測]。
 * それも無い配信物では AOI の中心に落ちる。
 */
function defaultTarget(catalog: Catalog, frame: LocalFrame): [number, number] {
  const b = catalog.pointcloud?.bounds
  if (!b) {
    const [lon, lat] = catalog.aoi.focus_wgs84 ?? catalog.aoi.centre_wgs84
    return lngLatToWorld(frame, lon, lat)
  }
  const [ox, oy] = catalog.local_frame.origin_epsg6674
  const [m0, m1, m2, m3] = catalog.local_frame.matrix_2x2_row_major
  const dx = (b.minx + b.maxx) / 2 - ox
  const dy = (b.miny + b.maxy) / 2 - oy
  return [m0 * dx + m1 * dy, m2 * dx + m3 * dy]
}

export function createViewer(container: HTMLElement, catalog: Catalog): Viewer {
  const [lon, lat] = catalog.aoi.centre_wgs84
  const frame = createLocalFrame([lon, lat])
  const b = catalog.aoi.bbox_wgs84
  return new Viewer({
    container,
    frame,
    // 注視点を AOI から大きく離さない（旧 maxBounds 相当）
    maxBoundsLngLat: [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02],
    initial: {
      target: defaultTarget(catalog, frame),
      // 距離はこのあと setZoom(INITIAL_ZOOM) で上書きする（ビューポート高に依存するため）
      distance: 3456,
      pitch: 52,
      bearing: -28,
    },
  })
}

/**
 * 起動時のスケール。**タイル 1 枚 = 256 px 基準**（`Viewer.setZoom` の規約）。
 *
 * 旧実装の MapLibre は zoom 15.6 で起動していたが、MapLibre の zoom は
 * タイル 512 px 基準なので、同じ景色は 256 px 基準では **16.6** になる。
 * 移行直後はここに 15.6 をそのまま書いていて、**実測で m/px が 1.282 対 2.567
 * （ちょうど 2 倍）、可視範囲が 4 倍**になっていた。要求するタイルも
 * z17 が 25 枚 -> z16 が 9 枚と 1 段粗く、配信性能の比較が成立していなかった。
 * ここを変えると `docs/web_results.md` の数字と比べられなくなる。
 *
 * **16.6 から 17.2 に寄せた** [実測]。既定の注視点を点群の帯にしたので、
 * 帯（426 × 799 m）が画面幅（17.2 で 843 m）に収まる倍率にしてある。
 * 17.6 まで寄せると `Math.round` で要求する z が 17 -> 18 に上がり、
 * **細タイルが 4 倍になって PLATEAU も視界に入る**。実測（localhost, 1400x900）:
 *
 * | z | FMR | time_to_terrain | 要求 | 転送 |
 * |---|---|---|---|---|
 * | 16.6（旧既定） | 906 ms | 2,323 ms | 64 | 4.84 MB |
 * | 17.2（新既定） | 733 ms | 1,468 ms | 64 | 4.84 MB |
 * | 17.6 | 1,090 ms | **13,348 ms** | **126** | **6.40 MB** |
 *
 * 要求本数と転送量は 16.6 と同じなので、`docs/web_results.md` の枚数・バイト数は
 * そのまま比較できる。変わるのは時刻だけ。
 */
export const INITIAL_ZOOM = 17.2

/**
 * その範囲での起動倍率。
 *
 * **吉原（100 ha）は 17.2 のまま**にしてある。`docs/web_results.md` の実測値
 * （要求 64 本 / 転送 4.84 MB / FMR 733 ms など）はこの倍率で取ったもので、
 * ここを変えると過去の数字と比べられなくなる。
 *
 * 面的表示用の 2 範囲は 2.5 km 角あり、17.2（画面幅 843 m）では
 * **6 分の 1 しか見えない**。範囲の幅が画面に収まる倍率を計算して使う。
 *
 * **合わせるのは幅だけ。** 高さにも合わせると、操作パネルと断面パネルで
 * 実際に見えているのは横長の帯なので 15.4 まで引く必要が出て、
 * 起動直後が z15（粗メッシュ）になる。幅合わせなら 15.8 で細メッシュに乗る。
 * 縦は切れるが、そこはパンとズームで足りる。
 */
const AOI_FIT = 1.02
export function initialZoom(catalog: Catalog): number {
  const [w, s, e, n] = catalog.aoi.bbox_wgs84
  const lat = (s + n) / 2
  const widthM = (e - w) * 111_320 * Math.cos((lat * Math.PI) / 180)
  const heightM = (n - s) * 110_950
  const px = { w: window.innerWidth || 1400, h: window.innerHeight || 900 }
  const need = (widthM * AOI_FIT) / px.w
  // 1 km 四方までは従来の倍率をそのまま使う（吉原）
  if (Math.max(widthM, heightM) <= 1200) return INITIAL_ZOOM
  // metresPerPixel(lat, z) = 156543.034 * cos(lat) / 2^z（256 px 基準）
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / need)
  return Math.round(z * 10) / 10
}

/**
 * CAD のように軸方向から見るためのプリセット。bearing はカメラが向く方位。
 *
 * `ortho` は正射投影に切り替えるもの（docs/todo.md B1）。MapLibre は透視投影しか
 * 持たないので、6 方向のプリセットを入れても「断面のように」は見えていなかった。
 * three.js の OrthographicCamera でようやく要求を満たす。
 */
export const CAMERA_PRESETS = [
  { key: '1', id: 'top', label: '平面', pitch: 0, bearing: 0, ortho: true },
  { key: '2', id: 'south', label: '南↑', pitch: 84, bearing: 0, ortho: true },
  { key: '3', id: 'west', label: '西→', pitch: 84, bearing: 90, ortho: true },
  { key: '4', id: 'north', label: '北↓', pitch: 84, bearing: 180, ortho: true },
  { key: '5', id: 'east', label: '東←', pitch: 84, bearing: 270, ortho: true },
  { key: '6', id: 'iso', label: '俯瞰', pitch: 52, bearing: -28, ortho: false },
] as const

export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id']

export function applyPreset(v: Viewer, id: CameraPresetId) {
  const p = CAMERA_PRESETS.find((x) => x.id === id)
  if (!p) return
  // 軸方向のプリセットは正射に切り替える。断面として読めないと意味が無い
  v.setProjection(p.ortho ? 'orthographic' : 'perspective')
  v.easeTo({ pitch: p.pitch, bearing: p.bearing }, 500)
}

/** 1〜6 で視点、[ ] で鉛直強調、O で投影切り替え */
export function bindCameraKeys(
  v: Viewer,
  onExaggeration: (delta: number) => void,
  onProjection?: (mode: ProjectionMode) => void,
) {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const p = CAMERA_PRESETS.find((x) => x.key === e.key)
    if (p) { applyPreset(v, p.id); onProjection?.(v.projectionMode); return }
    if (e.key === ']') onExaggeration(1)
    if (e.key === '[') onExaggeration(-1)
    if (e.key === 'o' || e.key === 'O') {
      const next: ProjectionMode =
        v.projectionMode === 'perspective' ? 'orthographic' : 'perspective'
      v.setProjection(next)
      onProjection?.(next)
    }
  })
}


/**
 * 右上にビューキューブを置く。カメラに追従し、面/辺/角で整列、ドラッグで回転。
 * 実装は `view/viewCube.ts`（描画ライブラリに依存しない 2D canvas）。
 */
export function attachViewCube(v: Viewer): ViewCube {
  const cube = new ViewCube({
    size: 128,
    onPick: (o) => v.easeTo({ bearing: o.bearingDeg, pitch: o.pitchDeg }, 450),
    onDrag: (dx, dy) => {
      // 横は方位、縦は傾き。上限は Viewer.setCamera が丸める
      const c = v.cameraState
      v.setCamera({ bearing: c.bearing + dx * 0.6, pitch: c.pitch - dy * 0.4 })
    },
  })
  const host = document.createElement('div')
  host.id = 'viewcube'
  host.appendChild(cube.el)

  // ホーム。起動時の視点に戻す。**キューブは向きしか戻せない**
  // （面をクリックしても中心とズームは動かない）ので、別に要る
  const home0 = { ...v.cameraState, target: [...v.cameraState.target] as [number, number] }
  const home = document.createElement('button')
  home.id = 'viewcube-home'
  home.type = 'button'
  home.textContent = '⌂'
  home.title = 'ホーム（起動時の俯瞰に戻る）'
  home.addEventListener('click', () => {
    // 軸方向プリセットで正射に切り替わっていることがある。俯瞰は透視で見る
    v.setProjection('perspective')
    v.easeTo(home0, 600)
  })
  host.appendChild(home)

  v.canvas.parentElement!.appendChild(host)
  const sync = () => cube.setOrientation({
    bearingDeg: v.cameraState.bearing, pitchDeg: v.cameraState.pitch,
  })
  v.on('move', sync)
  sync()
  return cube
}

/**
 * 断面の測線を地図に描く。**どこを切った断面なのかが分からないと読めない。**
 *
 * WebGL の `LineBasicMaterial` は `linewidth` を無視して必ず 1 px になるので、
 * 板（三角形 2 枚）で引く。太さは画面上の px で決めたいが、板はワールド座標なので
 * カメラが動くたびに `metresPerPixel()` から作り直す。
 *
 * `depthTest: false` で常に手前に出す。地形メッシュは測線の真上を横切るので、
 * 深度で素直に比べると天端の向こう側が隠れて「どこを切ったか」が読めない。
 *
 * `grow`（`docs/todo.md` U4）: true のとき from→to へリボンが伸びる。手動 2 点は
 * 1 点目から仮の測線（`showSectionPreview`）がカーソルに追従して既にそこにあるので
 * `false` で即出し、主流路の自動測線（クリック無し）は `true` で伸ばす。
 */
export function showSectionLine(
  v: Viewer, from: [number, number], to: [number, number], grow = true,
): void {
  hideSectionPreview(v)
  const [ax, ay] = lngLatToWorld(v.frame, from[0], from[1])
  const [bx, by] = lngLatToWorld(v.frame, to[0], to[1])

  let g = v.world.getObjectByName(SECTION_LINE) as Group | undefined
  if (!g) {
    g = new Group()
    g.name = SECTION_LINE
    g.renderOrder = 900
    // 縁取り -> 本体の順に重ねる。地形の明暗どちらの上でも読めるようにする
    for (const [colour, opacity] of [[0x0b1020, 0.75], [0xf59e0b, 0.95]] as const) {
      const mesh = new Mesh(ribbonGeometry(), new MeshBasicMaterial({
        color: colour, depthTest: false, transparent: true, opacity,
      }))
      mesh.frustumCulled = false
      g.add(mesh)
    }
    v.world.add(g)
    // カメラが動いたら太さを引き直す。**引いた測線を覚えておかないとできない**
    v.on('move', () => {
      const cur = sectionEnds
      if (cur) redrawRibbons(v, cur[0], cur[1], cur[2], cur[3])
    })
  }
  g.visible = true
  sectionEnds = [ax, ay, bx, by]
  if (grow) {
    startRibbonReveal(v)
  } else {
    if (ribbonRaf !== null) { cancelAnimationFrame(ribbonRaf); ribbonRaf = null }
    ribbonReveal = 1
    redrawRibbons(v, ax, ay, bx, by)
  }
}

/**
 * 断面パネルを閉じたときに呼ぶ。伸びかけのリボンを止めて確定形に落とす
 * （閉じたあとにリボンが伸び続けるのを防ぐ。`docs/todo.md` U4 のレビュー指摘）。
 */
export function cancelSectionLineReveal(v: Viewer): void {
  if (ribbonRaf !== null) { cancelAnimationFrame(ribbonRaf); ribbonRaf = null }
  ribbonReveal = 1
  if (sectionEnds) redrawRibbons(v, sectionEnds[0], sectionEnds[1], sectionEnds[2], sectionEnds[3])
}

const SECTION_LINE = 'section-line'
const SECTION_PREVIEW = 'section-preview'
/** 直近に引いた測線のワールド座標 [ax, ay, bx, by]。太さの引き直しに要る */
let sectionEnds: [number, number, number, number] | null = null
/** 仮の測線（1 点目〜2 点目）のワールド座標。'move' 再描画に要る */
let previewEnds: [number, number, number, number] | null = null
/** 画面上の太さ [px]。縁取りと本体 */
const RIBBON_PX = [7, 3]
/** 仮の測線の太さ [px] と 1 点目マーカーの一辺 [px] */
const PREVIEW_PX = 2
const MARKER_PX = 9
/** 地形より十分上。depthTest を切っているので見えかたには影響しない */
const RIBBON_Z = 300

/**
 * 測線が確定してからリボンを from→to へ伸ばすアニメーション（`docs/todo.md` U4）。
 *
 * **クリック無しの経路（主流路の自動測線）専用。** 手動 2 点は 1 点目から
 * `showSectionPreview` の仮測線がカーソルに追従して既に描かれているので、確定時は
 * 伸ばさず即出しする（`showSectionLine(…, false)`）。ここが補間するのはリボンの
 * 板だけ（`redrawRibbons` が `metresPerPixel` から毎フレーム作り直しているのと
 * 同じ処理）で、断面データ（地形サンプリング）は要らない。
 *
 * 進捗 `ribbonReveal`（0〜1）だけ持ち、終点の lerp は `redrawRibbons` 側でやる。
 * こうしておくとアニメ中にカメラの 'move' 再描画が走っても、そのフレームの進捗の
 * まま正しく引き直される（喧嘩しない）。
 */
const RIBBON_REVEAL_MS = 320
/** いま描くべき from→to の割合。1 = 全体。'move' 再描画もこれを見る */
let ribbonReveal = 1
let ribbonRaf: number | null = null

function startRibbonReveal(v: Viewer): void {
  if (ribbonRaf !== null) { cancelAnimationFrame(ribbonRaf); ribbonRaf = null }
  const draw = () => {
    const e = sectionEnds
    if (e) redrawRibbons(v, e[0], e[1], e[2], e[3])
  }
  if (prefersReducedMotion()) { ribbonReveal = 1; draw(); return }
  ribbonReveal = 0
  draw()   // 前の測線を残さず、まず起点だけの状態から始める
  const t0 = performance.now()
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / RIBBON_REVEAL_MS)
    ribbonReveal = easeOutCubic(k)
    draw()
    ribbonRaf = k < 1 ? requestAnimationFrame(tick) : null
  }
  ribbonRaf = requestAnimationFrame(tick)
}

function ribbonGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(4 * 3), 3))
  g.setIndex([0, 1, 2, 2, 1, 3])
  return g
}

/**
 * 1 点目を置いてから 2 点目までの仮の測線（`docs/todo.md` U4: 「1 点目を設定する
 * ところから」）。確定リボン（`SECTION_LINE`）とは別グループ・別スタイル
 * （細い半透明の線＋起点マーカー）で、「まだ確定していない」と読めるようにする。
 * `to` が null（カーソルがまだ動いていない）ときは起点マーカーだけ出す。
 */
export function showSectionPreview(
  v: Viewer, from: [number, number], to: [number, number] | null,
): void {
  const [ax, ay] = lngLatToWorld(v.frame, from[0], from[1])
  const [ex, ey] = to ? lngLatToWorld(v.frame, to[0], to[1]) : [ax, ay]

  let g = v.world.getObjectByName(SECTION_PREVIEW) as Group | undefined
  if (!g) {
    g = new Group()
    g.name = SECTION_PREVIEW
    g.renderOrder = 899   // 確定リボンの下
    const mat = () => new MeshBasicMaterial({
      color: 0xf59e0b, depthTest: false, transparent: true, opacity: 0.55,
    })
    const line = new Mesh(ribbonGeometry(), mat()); line.name = 'line'
    const marker = new Mesh(ribbonGeometry(), mat()); marker.name = 'marker'
    for (const m of [line, marker]) { m.frustumCulled = false; g.add(m) }
    v.world.add(g)
    v.on('move', () => { if (previewEnds) redrawPreview(v) })
  }
  g.visible = true
  previewEnds = [ax, ay, ex, ey]
  redrawPreview(v)
}

/** 仮の測線を消す（2 点目確定・Esc・ツール停止時）。 */
export function hideSectionPreview(v: Viewer): void {
  const g = v.world.getObjectByName(SECTION_PREVIEW) as Group | undefined
  if (!g || !g.visible) return
  g.visible = false
  previewEnds = null
  v.invalidate()
}

function redrawPreview(v: Viewer): void {
  const g = v.world.getObjectByName(SECTION_PREVIEW) as Group | undefined
  if (!g || !previewEnds) return
  const [ax, ay, ex, ey] = previewEnds
  const mpp = v.metresPerPixel()
  const line = g.getObjectByName('line') as Mesh
  const marker = g.getObjectByName('marker') as Mesh
  writeRibbon(line, ax, ay, ex, ey, (PREVIEW_PX * mpp) / 2)
  // 起点マーカーは向きを持たない小さな正方形
  const h = (MARKER_PX * mpp) / 2
  ;((marker.geometry.getAttribute('position')) as BufferAttribute).copyArray(new Float32Array([
    ax - h, ay - h, RIBBON_Z, ax + h, ay - h, RIBBON_Z,
    ax - h, ay + h, RIBBON_Z, ax + h, ay + h, RIBBON_Z,
  ]))
  ;(marker.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
  v.invalidate()
}

/** 板 1 枚を (ax,ay)→(ex,ey)・半幅 half[m] で書き換える */
function writeRibbon(
  mesh: Mesh, ax: number, ay: number, ex: number, ey: number, half: number,
): void {
  const len = Math.hypot(ex - ax, ey - ay) || 1
  const nx = -(ey - ay) / len
  const ny = (ex - ax) / len
  const pos = mesh.geometry.getAttribute('position') as BufferAttribute
  pos.copyArray(new Float32Array([
    ax + nx * half, ay + ny * half, RIBBON_Z,
    ax - nx * half, ay - ny * half, RIBBON_Z,
    ex + nx * half, ey + ny * half, RIBBON_Z,
    ex - nx * half, ey - ny * half, RIBBON_Z,
  ]))
  pos.needsUpdate = true
}

function redrawRibbons(
  v: Viewer, ax: number, ay: number, bx: number, by: number,
): void {
  const g = v.world.getObjectByName(SECTION_LINE) as Group | undefined
  if (!g) return
  // アニメ中は終点を from→to の途中まで lerp する（`startRibbonReveal`）
  const ex = lerp(ax, bx, ribbonReveal)
  const ey = lerp(ay, by, ribbonReveal)
  const mpp = v.metresPerPixel()
  g.children.forEach((child, i) => {
    writeRibbon(child as Mesh, ax, ay, ex, ey, (RIBBON_PX[i] * mpp) / 2)
  })
  v.invalidate()
}
