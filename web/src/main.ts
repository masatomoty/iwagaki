// アプリの組み立て。ここが唯一「全部を知っている」場所。
// 依存の向き: ui -> view/three -> pointcloud -> net -> assets -> domain（docs/WEB_DESIGN.md §1）
//
// 描画は three.js。MapLibre + deck.gl は外した（docs/WEB_RESULTS.md §8.1）。
// net / domain / perf / state / pointcloud の index・LOD・decode は renderer に
// 依存しない設計だったので、そのまま再利用している。

import { Vector2 } from 'three'

import type { Catalog } from './domain/catalog'
import { resolveSurface } from './domain/terrain'
import type { BuildingColorMode, FeatureAssertion, SurfaceMode } from './domain/types'
import { Scheduler } from './net/scheduler'
import { PerfRecorder } from './perf/recorder'
import type { PcBundle } from './pointcloud/lazy'
import type { LodBudget, ViewState } from './pointcloud/types'
import { initialState, Store } from './state'
import { FLOOD_MODE } from './three/floodMaterial'
import { createLocalFrame } from './three/mercator'
import type { SemanticsMesh } from './three/semanticsMesh'
import { TerrainTiles } from './three/terrainTiles'
import { FOV_Y_DEG, type Viewer } from './three/viewer'
import { createColorScheme, legendOf, type ColorScheme } from './view/buildingColor'
import { applyPreset, bindCameraKeys, createViewer, INITIAL_ZOOM } from './view/map'
import { toAssertion, type RawFeature } from './view/semantics'
import type { PlateauTiles } from './three/plateauTiles'
import { EXAGGERATIONS, renderControls } from './ui/controls'
import { renderInspector } from './ui/inspector'
import { renderPerf } from './ui/perfPanel'

const COARSE_MAX_ZOOM = 15          // ここまでが terrain-coarse（first_meaningful_render の対象）
const USEFUL_FRACTION = 0.25
/** 実測で決めた常駐点数の上限（docs/WEB_RESULTS.md §6.2）。?maxpts= で上書きできる */
const PC_MAX_POINTS = Number(new URLSearchParams(location.search).get('maxpts')) || 600_000

/** 計測用のスイッチ。既定値を変えずに条件だけ切り替えられるようにする */
const qs = new URLSearchParams(location.search)
const OPT = {
  coalesce: qs.get('coalesce') !== '0',
  pointcloud: qs.get('pc') === '1',
  /** ?ortho=1 で正射投影から始める（docs/TODO.md B1） */
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
  const [ox, oy] = catalog.local_frame.origin_epsg6674
  const matrix = catalog.local_frame.matrix_2x2_row_major as [number, number, number, number]
  const frame = createLocalFrame(catalog.aoi.centre_wgs84)

  const viewer: Viewer = createViewer(document.getElementById('map')!, catalog)
  // 旧実装の MapLibre zoom 15.6 に合わせる。ビューポート高が要るので canvas 生成後に呼ぶ
  viewer.setZoom(Number(qs.get('z')) || INITIAL_ZOOM)
  if (OPT.ortho) viewer.setProjection('orthographic')

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

  // ---- 点群 --------------------------------------------------------------
  let pcb: PcBundle | undefined
  /**
   * LOD 予算。deck.gl PointCloudLayer の描画コストは点数にほぼ線形で約 23 ns/点/frame、
   * 60 fps を保てる上限として 60 万点に置いた（docs/WEB_RESULTS.md §6.2）。
   * three.js の Points に替えた影響は再計測が要る（§8.1 の TODO）。
   */
  const budget = (): LodBudget => {
    const bw = scheduler.bandwidthBps || 2e6
    return {
      maxPoints: PC_MAX_POINTS,
      maxBytes: Math.max(2e6, Math.min(20e6, bw * 6)),
      screenSpaceError: 2.0,
      coarseDepth: 1,
    }
  }
  const viewState = (): ViewState => ({
    // ローカル原点は AOI 中心なので、視点は中心の真上として扱えば十分（AOI は 1 km 四方）
    eye: [0, 0, Math.max(viewer.cameraToCenterDistance / 8, 60)],
    viewportHeight: viewer.canvas.clientHeight,
    fovY: (Math.PI / 180) * FOV_Y_DEG,
  })

  let pcStarted = false
  async function startPointCloud() {
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

    const sch = schemeFor(s.buildingColor)
    renderControls(document.getElementById('controls')!, store, catalog,
      (id) => applyPreset(viewer, id),
      sch ? legendOf(plateauValues, sch) : [])
    renderInspector(document.getElementById('inspector')!, store, catalog)
    viewer.invalidate()
  }

  // ---- カメラ連動 --------------------------------------------------------
  // カメラは 60ms デバウンス。毎フレーム epoch を進めるとキャンセル暴走する（§4.5）
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
        void pcb.controller.update(viewState(), budget())
      }
    }, 60)
  })

  bindCameraKeys(viewer, (d) => {
    const i = EXAGGERATIONS.indexOf(store.state.exaggeration as never)
    const next = EXAGGERATIONS[Math.min(EXAGGERATIONS.length - 1, Math.max(0, i + d))]
    store.set({ exaggeration: next })
  }, () => refresh())

  // 地物のクリック選択（deck.gl の pickable の置き換え）
  viewer.canvas.addEventListener('click', (e) => {
    if (!semantics || !store.state.layers.semantics) return
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
  // PerfRecorder は常時走らせるが、パネルは既定で隠す（docs/WEB_DESIGN.md §8.1）
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
    snapshot: () => ({
      ...perf.snapshot(),
      pointcloud: pcb?.controller.stats() ?? null,
      plateau: {
        loaded: plateau?.stats().tiles ?? 0, failed: plateauFailed,
        expected: catalog.plateau.bldg_lod1?.b3dm_count ?? 0,
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
