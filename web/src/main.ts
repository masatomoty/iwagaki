// アプリの組み立て。ここが唯一「全部を知っている」場所。
// 依存の向き: ui -> view/three -> pointcloud -> net -> assets -> domain
// （docs/WEB_DESIGN.md「層の分け方」）
//
// 描画は three.js。MapLibre + deck.gl は外した（docs/WEB_RESULTS.md「初期チャンクの内訳」）。
// net / domain / perf / state / pointcloud の index・LOD・decode は renderer に
// 依存しない設計だったので、そのまま再利用している。

import { Vector2 } from 'three'

import { sampleLine } from './assets/terrainSampler'
import { type CameraDescription, eyeInLocal, visibleBoxLocal } from './domain/camera'
import type { Catalog } from './domain/catalog'
import { resolveSurface } from './domain/terrain'
import type { BuildingColorMode, FeatureAssertion, SurfaceMode,
              TerrainCondition } from './domain/types'
import { Scheduler } from './net/scheduler'
import { PerfRecorder } from './perf/recorder'
import type { PcBundle } from './pointcloud/lazy'
import type { LodBudget, ViewState } from './pointcloud/types'
import { initialState, Store } from './state'
import { FLOOD_MODE } from './three/floodMaterial'
import { createLocalFrame, worldToLngLat } from './three/mercator'
import type { PlateauTiles } from './three/plateauTiles'
import type { SemanticsMesh } from './three/semanticsMesh'
import { TerrainTiles } from './three/terrainTiles'
import { FOV_Y_DEG, type Viewer } from './three/viewer'
import { EXAGGERATIONS, renderControls } from './ui/controls'
import { renderInspector } from './ui/inspector'
import { renderPerf } from './ui/perfPanel'
import { drawSection, type SectionSeries } from './ui/section'
import { createColorScheme, legendOf, type ColorScheme } from './view/buildingColor'
import { applyPreset, attachViewCube, bindCameraKeys, createViewer, INITIAL_ZOOM,
         showSectionLine } from './view/map'
import { SectionTool, type LonLat } from './view/sectionTool'
import { toAssertion, type RawFeature } from './view/semantics'

const COARSE_MAX_ZOOM = 15          // ここまでが terrain-coarse（first_meaningful_render の対象）

/**
 * 「点群が見えた」とみなす、LOD が選んだ点数に対する割合。
 * 絶対値（旧: 20 万点）は合成点群向けの値で、実点群では LOD の選択が
 * 17.3〜21.6 万点と閾値をまたぎ、同じ画面でも計測できたりできなかったりした。
 * 割合にすればデータ密度・LOD 予算を変えても同じものを指す（docs/WEB_RESULTS.md「計測の方針」）。
 */
const USEFUL_FRACTION = 0.5
/** 実測で決めた常駐点数の上限（docs/WEB_RESULTS.md「点群の配信」）。?maxpts= で上書きできる */
const PC_MAX_POINTS = Number(new URLSearchParams(location.search).get('maxpts')) || 600_000
/** LOD のバイト予算の上書き。計測専用（既定は帯域推定から決める） */
const PC_MAX_BYTES = Number(new URLSearchParams(location.search).get('maxbytes')) || undefined

/** 計測用のスイッチ。既定値を変えずに条件だけ切り替えられるようにする */
const qs = new URLSearchParams(location.search)
const OPT = {
  // coalescing は既定 ON。1 リクエスト内のストリーミングデコードを入れた結果、
  // 「束ねると最初の点が遅れる」不利が消えて速い側になった（docs/WEB_RESULTS.md「range coalescing」）
  coalesce: qs.get('coalesce') !== '0',
  // 点群は既定 OFF。?pc=1 で有効化
  pointcloud: qs.get('pc') === '1',
  /** ?ortho=1 で正射投影から始める */
  ortho: qs.get('ortho') === '1',
}

async function boot() {
  const scheduler = new Scheduler()
  const perf = new PerfRecorder(scheduler)

  // catalog は唯一の入口。URL を差し替えれば配信先が変わる
  const catalogBytes = await scheduler.submit({
    key: 'catalog', url: 'data/catalog.json', cls: 'catalog',
  })
  const catalog: Catalog = JSON.parse(new TextDecoder().decode(catalogBytes))
  perf.mark('catalog_loaded')
  scheduler.detectProtocol()

  const store = new Store(initialState(catalog))
  if (OPT.pointcloud) store.setLayer({ pointcloud: true })
  const geoid = catalog.vertical.geoid_undulation_m
  /** ローカル ENU の原点 [lon, lat]。カメラの換算に使う */
  const localOrigin = catalog.local_frame.origin_wgs84
  const [ox, oy] = catalog.local_frame.origin_epsg6674
  const matrix = catalog.local_frame.matrix_2x2_row_major as [number, number, number, number]
  const frame = createLocalFrame(catalog.aoi.centre_wgs84)

  const viewer: Viewer = createViewer(document.getElementById('map')!, catalog)
  // 旧実装（MapLibre zoom 15.6）と同じ景色にする。規約の違いは INITIAL_ZOOM を見ること
  viewer.setZoom(Number(qs.get('z')) || INITIAL_ZOOM)
  if (OPT.ortho) viewer.setProjection('orthographic')
  attachViewCube(viewer)

  // 出典。**必ず出す。** MapLibre の AttributionControl が担っていた分で、
  // PLATEAU / 京都府 DEM / 気象庁はいずれも表示を求めている
  document.getElementById('attrib')!.textContent = catalog.attribution.join(' / ')

  // ---- 地形 -------------------------------------------------------------
  const extent = catalog.aoi.bbox_wgs84
  let coarseDone = false
  let fineDone = false

  const floodUniforms = () => {
    const s = store.state
    return {
      waterLevel: s.waterLevel,
      hStep: catalog.packing.h_step,
      mode: resolveSurface(catalog.terrain, s.surface)?.isDiff
        ? FLOOD_MODE.diff : FLOOD_MODE.terrain,
      exaggeration: s.exaggeration,
      geoid,
      floodOpacity: 0.82,
      groundOpacity: s.layers.ground ? 0.95 : 0,
      showGround: s.layers.ground ? 1 : 0,
    }
  }

  /** 地形条件が変わるとタイルの URL ごと変わるので、ピラミッドを作り直す */
  let coarse: TerrainTiles | undefined
  let fine: TerrainTiles | undefined
  let builtSurface: string | undefined

  function buildTerrain() {
    const s = store.state
    if (builtSurface === s.surface) return
    builtSurface = s.surface
    coarse?.dispose(); fine?.dispose()
    if (coarse) viewer.world.remove(coarse.group)
    if (fine) viewer.world.remove(fine.group)
    coarse = fine = undefined
    if (!s.layers.flood) return

    // 差分モードでも地形メッシュは必要なので、元条件の標高タイルを土台に使い、
    // 判定だけ差分タイル（2 条件の h_conn）から取る。
    // どの条件を土台にするかは domain/terrain.ts が決める（描画側に分岐を置かない）
    const resolved = resolveSurface(catalog.terrain, s.surface)
    if (!resolved) return
    const { geom: geomAsset, diffUrl } = resolved
    const common = {
      viewer, frame, scheduler, extent,
      urlTemplate: geomAsset.url, diffUrlTemplate: diffUrl,
    }
    coarse = new TerrainTiles({
      ...common, cls: 'terrainCoarse', renderOrder: 0,
      minZoom: geomAsset.min_zoom, maxZoom: COARSE_MAX_ZOOM,
      onViewportLoad: () => {
        if (coarseDone) return
        coarseDone = true
        // 1 フレーム描かれてから立てる。「読み終わった」ではなく「見えた」を測る
        requestAnimationFrame(() => requestAnimationFrame(() => {
          perf.mark('first_meaningful_render')
          scheduler.openGate()
          void ensurePlateau()
          void startPointCloud()
        }))
      },
    }, floodUniforms())
    fine = new TerrainTiles({
      ...common, cls: 'terrainFine', renderOrder: 1,
      minZoom: COARSE_MAX_ZOOM + 1, maxZoom: geomAsset.max_zoom,
      onViewportLoad: () => {
        if (!fineDone) { fineDone = true; perf.mark('time_to_terrain') }
        // 粗メッシュは FMR 用と割り切る。細が出たら隠す（メッシュ同士は z-fight する）
        coarse?.setVisible(false)
        perf.cameraSettled()
      },
    }, floodUniforms())
    viewer.world.add(coarse.group, fine.group)
    coarse.update(); fine.update()
  }

  // ---- 地物 -------------------------------------------------------------
  let semantics: SemanticsMesh | undefined
  let rawFeatures: RawFeature[] = []
  const assertions = new Map<string, FeatureAssertion>()

  void (async () => {
    const b = await scheduler.submit({
      key: 'semantics', url: catalog.semantics.url, cls: 'semantics',
    })
    const fc = JSON.parse(new TextDecoder().decode(b)) as { features: RawFeature[] }
    rawFeatures = fc.features
    for (const f of rawFeatures) {
      const a = toAssertion(f.properties)
      assertions.set(a.gmlId, a)
      ;(f.properties as Record<string, unknown>).__a = a
    }
    perf.mark('semantics_loaded')
    // 三角形化とジオメトリ構築はここで初めて読む
    const { SemanticsMesh: SM } = await import('./three/semanticsMesh')
    perf.mark('semantics_module_loaded')
    semantics = new SM(frame, rawFeatures, geoid)
    viewer.world.add(semantics.group)
    refresh()
    void loadPcCoverage()
  })()

  // ---- PLATEAU ----------------------------------------------------------
  let plateau: PlateauTiles | undefined
  let plateauLoading = false
  let plateauMode: BuildingColorMode | undefined
  let plateauFailed = 0
  let scheme: ColorScheme | undefined
  function schemeFor(mode: BuildingColorMode): ColorScheme | undefined {
    if (mode === 'none') return undefined
    if (scheme?.mode !== mode) scheme = createColorScheme(catalog, mode)
    return scheme
  }
  const plateauValues = new Map<string, string>()
  let legendTimer: number | undefined

  async function ensurePlateau() {
    const asset = catalog.plateau.bldg_lod1
    const mode = store.state.buildingColor
    if (!asset || plateauLoading) return
    if (plateau && plateauMode === mode) return
    plateauLoading = true
    try {
      const { PlateauTiles } = await import('./three/plateauTiles')
      const first = plateauMode === undefined
      if (first) perf.mark('plateau_module_loaded')
      plateauMode = mode
      if (plateau) { viewer.world.remove(plateau.group); plateau.dispose() }
      plateauValues.clear()
      plateau = new PlateauTiles({
        url: asset.url, scheduler, viewer, frame, geoid,
        scheme: schemeFor(mode),
        onValues: (vals) => {
          for (const [id, v] of vals) plateauValues.set(id, v)
          // 凡例の件数はタイルが届くたびに増える。タイル 1 枚ごとに
          // 再描画すると 22 回作り直すことになるので束ねる
          if (vals.length && legendTimer === undefined) {
            legendTimer = window.setTimeout(() => { legendTimer = undefined; refresh() }, 250)
          }
        },
        // 塗り替えでは測り直さない。time_to_plateau は初回描画の指標
        onLoaded: () => { if (first) perf.mark('time_to_plateau') },
        onError: (t, e) => { plateauFailed++; console.warn('b3dm failed', t, e) },
      })
      viewer.world.add(plateau.group)
      await plateau.open()
      plateau.update()
    } catch (e) {
      console.warn('plateau unavailable', e)
    } finally {
      plateauLoading = false
    }
    refresh()
  }

  // ---- 点群が効いている範囲の輪郭 ----------------------------------------
  /**
   * 点群の被覆輪郭（118 kB）。**クラスは prefetch** で、何かを待たせることが無いようにする。
   * 無くても地図は成立し、有ると「点群がどこに効いているか」が分かる、という性質の情報。
   * AOI 100 ha に対し点群は 3.17 ha しかない（docs/RESULTS.md）。
   */
  let coverage: import('three').LineSegments | undefined
  async function loadPcCoverage() {
    const a = catalog.pointcloud_coverage
    if (!a?.url || coverage) return
    try {
      const b = await scheduler.submit({ key: 'pc-coverage', url: a.url, cls: 'prefetch' })
      const data = JSON.parse(new TextDecoder().decode(b))
      const { createCoverageOutline } = await import('./three/semanticsMesh')
      coverage = createCoverageOutline(frame, data, geoid)
      viewer.world.add(coverage)
      refresh()
    } catch {
      // 表示の補助なので、取れなくても地図は動かす
    }
  }

  // ---- 断面 ---------------------------------------------------------------
  //
  // 3D の俯瞰では起伏 0〜3 m が潰れて読めない。測線に沿って横から見る。
  // 標高は**画面に出ているのと同じタイル**から読むので、追加の通信は起きない。
  const SECTION_SERIES: { condition: TerrainCondition; label: string; color: string }[] = [
    { condition: 'highres', label: '0.5m', color: '#e2e8f0' },
    { condition: 'baseline', label: 'PLATEAU 5m', color: '#f7d129' },
    { condition: 'pointcloud', label: '点群融合', color: '#4ade80' },
  ]
  const secEl = document.getElementById('section')!
  const secCanvas = document.getElementById('sec-canvas') as HTMLCanvasElement
  const secNote = document.getElementById('sec-note')!
  let secSeries: SectionSeries[] = []
  let secLine: [LonLat, LonLat] | null = null
  // 既定は水位まわり。全体に合わせると市街地の 0〜3 m が背後の 40 m に潰される
  let secFit: 'water' | 'all' = 'water'

  const redrawSection = () => {
    if (secSeries.length === 0) return
    // いま選んでいる条件を先頭にする。塗り（連結して浸水する区間）はそれで判定する
    const cur = resolveSurface(catalog.terrain, store.state.surface)?.condition ?? 'highres'
    const ordered = [...secSeries].sort((a, b) =>
      (a.condition === cur ? -1 : 0) - (b.condition === cur ? -1 : 0))
    drawSection(secCanvas, ordered, store.state.waterLevel, secFit)
  }

  async function buildSection(from: LonLat, to: LonLat) {
    secLine = [from, to]
    showSectionLine(viewer, from, to)
    secEl.style.display = 'block'
    secNote.textContent = '読み込み中…'
    const zoom = catalog.terrain.highres?.max_zoom ?? 18
    const got = await Promise.all(SECTION_SERIES.map(async (s) => {
      const asset = catalog.terrain[s.condition]
      if (!asset) return null
      const points = await sampleLine({
        urlTemplate: asset.url, zoom, hStep: catalog.packing.h_step,
        from, to,
        fetchTile: (url) => scheduler.submit({ key: url, url, cls: 'terrainFine' }),
      })
      return { ...s, points } as SectionSeries
    }))
    secSeries = got.filter((x): x is SectionSeries => x !== null)
    const n = secSeries[0]?.points.length ?? 0
    const len = secSeries[0]?.points.at(-1)?.d ?? 0
    const why = catalog.default_section && secLine
      && secLine[0][0] === catalog.default_section.from[0]
      ? `${catalog.default_section.why}。` : ''
    secNote.textContent =
      `${why}測線 ${len.toFixed(0)} m / ${n} 点。標高は配信中のタイル（${zoom} ズーム、`
      + `1 セル ${(len / Math.max(1, n - 1)).toFixed(2)} m 相当）から読んでいる。`
      + '水色は「海と連結して浸水する」区間で、標高が水位より低いだけでは塗らない。'
    redrawSection()
  }

  // 起動時に既定の断面を出す。**測線を引かせる前に、一番読む価値のある断面を見せる。**
  // 天端を横切る線で、3D では潰れて見えない 0〜3 m の起伏がここで読める
  const ds = catalog.default_section
  if (ds) {
    secNote.textContent = ds.why
    void buildSection(ds.from as LonLat, ds.to as LonLat)
  }

  const sectionTool = new SectionTool({
    viewer,
    onLine: (a, b) => void buildSection(a, b),
    onState: ({ active, hasFirst }) => {
      // **作図中はパネルがクリックを飲まないようにする。**
      // 既定の断面を出すようにしてから、断面パネルが画面の下半分を覆っている。
      // 測線の 2 点目がそこに来ると `elementFromPoint` がパネルを返し、
      // canvas に届かない（実測で 2 点目が無視されていた）
      secEl.style.pointerEvents = active ? 'none' : ''
      const btn = document.getElementById('secbtn')
      if (btn) {
        btn.textContent = active ? (hasFirst ? '2 点目をクリック' : '1 点目をクリック') : '測線を引く'
        btn.setAttribute('aria-pressed', String(active))
      }
    },
  })
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.id === 'secbtn') sectionTool.toggle()
    if (t.id === 'sec-close') { secEl.style.display = 'none'; secSeries = []; secLine = null }
    if (t.id === 'sec-fit') {
      secFit = secFit === 'water' ? 'all' : 'water'
      t.textContent = secFit === 'water' ? '全体を見る' : '水位まわり'
      redrawSection()
    }
  })
  window.addEventListener('resize', redrawSection)

  // ---- 点群 --------------------------------------------------------------
  let pcb: PcBundle | undefined
  /**
   * LOD 予算。点数にほぼ線形な描画コスト（deck.gl PointCloudLayer で約 23 ns/点/frame）
   * から、60 fps を保てる上限として 60 万点に置いた（docs/WEB_RESULTS.md「点群の配信」）。
   * three.js の Points に替えた影響は再計測が要る（docs/TODO.md）。
   */
  const budget = (): LodBudget => {
    const bw = scheduler.bandwidthBps || 2e6
    return {
      maxPoints: PC_MAX_POINTS,
      // 帯域推定から毎回決める。遅い回線では自動的に浅い LOD で止まる。
      // ?maxbytes= で上書きできる。**キャンセル経路の検証に必要**で、
      // 絞った回線ではこの予算が pcFine の発行そのものを止めてしまい、
      // 「キャンセルすべき飛行中の要求」が作れない（docs/WEB_RESULTS.md「キャンセル」）
      maxBytes: PC_MAX_BYTES ?? Math.max(2e6, Math.min(20e6, bw * 6)),
      screenSpaceError: 2.0,
      coarseDepth: 1,
    }
  }
  /**
   * カメラを LOD が使える形（ローカル ENU メートル）に直す。
   *
   * 換算そのものは `domain/camera.ts` に置いてある（レンダラに依らないため）。
   * **旧実装は `eye: [0, 0, cameraToCenterDistance / 8]` で視点が定数**になっており、
   * LOD が働いていなかった（docs/WEB_RESULTS.md「キャンセル」）。three.js 移行時に
   * その定数版へ戻っていたので、`domain/camera.ts` 経由に直してある。
   */
  const viewState = (): ViewState => {
    const cs = viewer.cameraState
    const centre = worldToLngLat(frame, cs.target[0], cs.target[1])
    const cam: CameraDescription = {
      centre,
      zoom: viewer.getZoom(),
      pitchDeg: cs.pitch,
      bearingDeg: cs.bearing,
      viewportHeight: viewer.canvas.clientHeight,
      fovY: (Math.PI / 180) * FOV_Y_DEG,
      // domain/camera は「px 距離 x metresPerPixel」でメートルに直す。
      // three 側は距離をメートルで持っているので、px に戻して渡す
      cameraToCentrePx: cs.distance / viewer.metresPerPixel(),
    }
    return {
      eye: eyeInLocal(cam, localOrigin),
      viewportHeight: cam.viewportHeight,
      fovY: cam.fovY,
      // 余白を少し取る。傾けた視野の外接矩形なので厳密ではないが、
      // 落としすぎるより広めに残すほうが安全
      visible: visibleBoxLocal(viewer.getBoundsLngLat(), localOrigin, 50),
    }
  }

  let pcStarted = false
  async function startPointCloud() {
    // 点群を表示しないなら module ごと取りに行かない
    if (!store.state.layers.pointcloud || pcStarted) return
    pcStarted = true
    try {
      const { createPointCloud } = await import('./pointcloud/lazy')
      perf.mark('pc_module_loaded')
      pcb = createPointCloud({
        url: catalog.pointcloud.url, scheduler, perf,
        origin6674: [ox, oy], originWgs84: catalog.aoi.centre_wgs84,
        matrix, geoid,
        coalesceGap: OPT.coalesce ? 64 * 1024 : 0,
        usefulFraction: USEFUL_FRACTION,
        onChange: () => { viewer.invalidate(); refresh() },
      })
      viewer.world.add(pcb.renderer.group)
      await pcb.controller.open()
      await pcb.controller.update(viewState(), budget())
      refresh()
    } catch (e) {
      console.warn('point cloud unavailable', e)
    }
  }

  // ---- 状態の反映 --------------------------------------------------------
  function refresh() {
    const s = store.state
    buildTerrain()
    const u = floodUniforms()
    coarse?.setUniforms(u)
    fine?.setUniforms(u)
    coarse?.setVisible(s.layers.flood && !fineDone)
    fine?.setVisible(s.layers.flood)

    if (semantics) {
      semantics.setVisible(s.layers.semantics && rawFeatures.length > 0)
      semantics.setExaggeration(s.exaggeration)
      semantics.setStyle({
        waterLevel: s.waterLevel,
        // 地物の色は「いま見ている条件」で塗る。差分モードでは土台にした条件を使う
        condition: resolveSurface(catalog.terrain, s.surface)?.condition ?? 'highres',
        roadThresholds: catalog.semantics.road_depth_classes_m,
        changedOnly: s.layers.changedOnly,
      })
    }
    // 3D Tiles は実高のままなので、地形を鉛直強調すると噛み合わない
    if (coverage) coverage.visible = s.layers.pcCoverage
    plateau?.setVisible(s.layers.plateau && s.exaggeration === 1)
    pcb?.renderer.setVisible(s.layers.pointcloud)
    pcb?.renderer.setExaggeration(s.exaggeration, geoid)

    redrawSection()
    const sch = schemeFor(s.buildingColor)
    renderControls(document.getElementById('controls')!, store, catalog,
      sch ? legendOf(plateauValues, sch) : [])
    renderInspector(document.getElementById('inspector')!, store, catalog)
    viewer.invalidate()
  }

  // ---- カメラ連動 --------------------------------------------------------
  // カメラは 60ms デバウンス。毎フレーム epoch を進めるとキャンセル暴走する
  // （docs/WEB_DESIGN.md「キャンセルの規則」）
  let moveTimer: number | undefined
  viewer.on('movestart', () => perf.cameraMoveStart())
  viewer.on('move', () => {
    window.clearTimeout(moveTimer)
    moveTimer = window.setTimeout(() => {
      scheduler.setEpoch(scheduler.currentEpoch + 1)
      coarse?.update()
      fine?.update()
      plateau?.update()
      scheduler.reap()
      if (pcb?.controller.ready && store.state.layers.pointcloud) {
        // **点群は update() の後にもう一度 reap する。**
        // 点群の stillNeeded は controller の `wanted` を見るが、
        // それが書き換わるのは update() の中である。先に reap すると
        // 古い `wanted` を見て「まだ必要」と答えてしまい、
        // **視野から外れたノードが一度もキャンセルされない**
        // （docs/WEB_RESULTS.md「キャンセル」）。
        void pcb.controller.update(viewState(), budget()).then(() => scheduler.reap())
      }
    }, 60)
  })

  bindCameraKeys(viewer, (d) => {
    const i = EXAGGERATIONS.indexOf(store.state.exaggeration as never)
    const next = EXAGGERATIONS[Math.min(EXAGGERATIONS.length - 1, Math.max(0, i + d))]
    store.set({ exaggeration: next })
  }, () => refresh())

  // 地物のクリック選択（deck.gl の pickable の置き換え）。
  // 断面の作図中は測線の端点を取りに来ているので、選択には使わない
  viewer.canvas.addEventListener('click', (e) => {
    if (!semantics || !store.state.layers.semantics || sectionTool.isActive) return
    const r = viewer.canvas.getBoundingClientRect()
    const ndc = new Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    )
    store.set({ selected: semantics.pick(ndc, viewer.camera) })
  })

  store.subscribe((s) => {
    if (s.layers.pointcloud && !pcStarted) void startPointCloud()
    if (s.layers.plateau) void ensurePlateau()
    refresh()
  })

  buildTerrain()
  refresh()

  // ---- 計測パネル --------------------------------------------------------
  // PerfRecorder は常時走らせるが、パネルは既定で隠す。内訳を読むのは開発者だけで、
  // 浸水を見に来た人には要らない。?perf=1 か P キーで出す
  // （docs/WEB_DESIGN.md「FPS は指標にしない」）
  const perfEl = document.getElementById('perf')!
  let perfVisible = qs.get('perf') === '1'
  const drawPerf = () => {
    if (!perfVisible) return
    renderPerf(perfEl, perf, scheduler, pcb?.controller, store)
  }
  const setPerfVisible = (v: boolean) => {
    perfVisible = v
    perfEl.style.display = v ? 'block' : 'none'
    drawPerf()
  }
  perf.onChange(drawPerf)
  setInterval(drawPerf, 500)
  setPerfVisible(perfVisible)
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key !== 'p' && e.key !== 'P') return
    setPerfVisible(!perfVisible)
  })

  // 計測ハーネスからの取り出し口
  ;(window as unknown as Record<string, unknown>).__iwagaki = {
    perf, scheduler, store, viewer,
    get pc() { return pcb?.controller },
    get section() { return secSeries },
    snapshot: () => ({
      ...perf.snapshot(),
      pointcloud: pcb?.controller.stats() ?? null,
      plateau: {
        loaded: plateau?.stats().tiles ?? 0, failed: plateauFailed,
        expected: catalog.plateau.bldg_lod1?.b3dm_count ?? 0,
        // 属性色は primitive 分割で入れているので draw call が増える。実測用
        colorMode: plateauMode ?? 'none',
        primitives: plateau?.stats().primitives ?? 0,
        coloured: plateau?.stats().coloured ?? 0,
        buildings: plateau?.stats().buildings ?? 0,
      },
      projection: viewer.projectionMode,
    }),
    setWaterLevel: (v: number) => store.set({ waterLevel: v }),
    setSurface: (v: SurfaceMode) => store.set({ surface: v }),
    setExaggeration: (v: number) => store.set({ exaggeration: v }),
    setCamera: (id: string) => applyPreset(viewer, id as never),
    setProjection: (m: 'perspective' | 'orthographic') => { viewer.setProjection(m); refresh() },
    setLayer: (k: string, v: boolean) => store.setLayer({ [k]: v } as never),
    setBuildingColor: (v: BuildingColorMode) => store.set({ buildingColor: v }),
    setPerfVisible,
  }
}

void boot()
