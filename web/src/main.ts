// アプリの組み立て。ここが唯一「全部を知っている」場所。
// 依存の向き: ui -> view -> pointcloud -> net -> assets -> domain（docs/WEB_DESIGN.md §1）

import 'maplibre-gl/dist/maplibre-gl.css'

import { MapboxOverlay } from '@deck.gl/mapbox'
import type { Layer } from '@deck.gl/core'

import type { Catalog } from './domain/catalog'
import { resolveSurface } from './domain/terrain'
import type { BuildingColorMode, FeatureAssertion, SurfaceMode } from './domain/types'
import { Scheduler } from './net/scheduler'
import { PerfRecorder } from './perf/recorder'
import type { PcBundle } from './pointcloud/lazy'
import type { LodBudget, ViewState } from './pointcloud/types'
import { initialState, Store } from './state'
import { createFloodTileLayer, FLOOD_MODE } from './view/floodTileLayer'
import type { FloodMeshUniforms } from './view/floodMeshLayer'
import { createColorScheme, legendOf, type ColorScheme } from './view/buildingColor'
import { applyPreset, bindCameraKeys, createMap } from './view/map'
import { liftZ, toAssertion, type RawFeature } from './view/semantics'
import type { createPcCoverageLayer as CreatePcCoverageLayer,
              createSemanticsLayer as CreateSemanticsLayer } from './view/semanticsLayer'
import { EXAGGERATIONS, renderControls } from './ui/controls'
import { renderInspector } from './ui/inspector'
import { renderPerf } from './ui/perfPanel'

const COARSE_MAX_ZOOM = 15          // ここまでが terrain-coarse（first_meaningful_render の対象）

/**
 * 「点群が見えた」とみなす、LOD が選んだ点数に対する割合。
 * 絶対値（旧: 20 万点）は合成点群向けの値で、実点群では LOD の選択が
 * 17.3〜21.6 万点と閾値をまたぎ、同じ画面でも計測できたりできなかったりした。
 * 割合にすればデータ密度・LOD 予算を変えても同じものを指す（docs/WEB_RESULTS.md §6.3）。
 */
const USEFUL_FRACTION = 0.5
/** 実測で決めた常駐点数の上限（docs/WEB_RESULTS.md §6.2）。?maxpts= で上書きできる */
const PC_MAX_POINTS = Number(new URLSearchParams(location.search).get('maxpts')) || 600_000
/** LOD のバイト予算の上書き。計測専用（既定は帯域推定から決める） */
const PC_MAX_BYTES = Number(new URLSearchParams(location.search).get('maxbytes')) || undefined

/** 計測用のスイッチ。既定値を変えずに条件だけ切り替えられるようにする */
const qs = new URLSearchParams(location.search)
const OPT = {
  // coalescing は既定 ON。1 リクエスト内のストリーミングデコードを入れた結果、
  // 「束ねると最初の点が遅れる」不利が消えて速い側になった（docs/WEB_RESULTS.md §4）
  coalesce: qs.get('coalesce') !== '0',
  // 点群は既定 OFF。?pc=1 で有効化
  pointcloud: qs.get('pc') === '1',
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

  const map = createMap(document.getElementById('map')!, catalog)
  const overlay = new MapboxOverlay({ interleaved: true, layers: [] })

  // ---- 点群（遅延ロード。初回描画のバンドルに入れない）--------------------
  let pcb: PcBundle | undefined

  // ---- 地物 -------------------------------------------------------------
  let rawFeatures: RawFeature[] = []
  let features: RawFeature[] = []
  let makeSemantics: typeof CreateSemanticsLayer | undefined
  let makePcCoverage: typeof CreatePcCoverageLayer | undefined
  /** 診断用。tileset の内部状態を __iwagaki から見るために持つ */
  let plateauTileset: unknown
  let pcCoverageData: unknown
  const assertions = new Map<string, FeatureAssertion>()
  let featureExaggeration = -1
  /** 地物ポリゴンを地面の高さに載せる。鉛直強調を変えたら作り直す */
  function rebuildFeatureGeometry() {
    const k = store.state.exaggeration
    if (k === featureExaggeration) return
    featureExaggeration = k
    features = rawFeatures.map((f) => {
      const a = f.properties.__a as FeatureAssertion
      const g = a?.groundElev.highres ?? 0
      return { ...f, geometry: liftZ(f.geometry, geoid + g * k) }
    })
  }
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
    rebuildFeatureGeometry()
    perf.mark('semantics_loaded')
    // GeoJsonLayer もここで初めて読む
    const mod = await import('./view/semanticsLayer')
    makeSemantics = mod.createSemanticsLayer
    makePcCoverage = mod.createPcCoverageLayer
    perf.mark('semantics_module_loaded')
    refresh()
    void loadPcCoverage()
  })()

  /**
   * 点群の被覆輪郭（118 kB）。**クラスは prefetch** で、
   * 何かを待たせることが無いようにする。無くても地図は成立し、
   * 有ると「点群がどこに効いているか」が分かる、という性質の情報。
   */
  async function loadPcCoverage() {
    const a = catalog.pointcloud_coverage
    if (!a?.url || pcCoverageData) return
    try {
      const b = await scheduler.submit({ key: 'pc-coverage', url: a.url, cls: 'prefetch' })
      pcCoverageData = JSON.parse(new TextDecoder().decode(b))
      refresh()
    } catch {
      // 表示の補助なので、取れなくても地図は動かす
    }
  }

  // ---- 描画ループ -------------------------------------------------------
  const extent = catalog.aoi.bbox_wgs84
  let coarseDone = false
  let fineDone = false

  type MeshUniforms = Omit<FloodMeshUniforms, 'bounds' | 'metersPerTexel' | 'hasDiff'>
  const floodProps = (): MeshUniforms => {
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

  /**
   * そのタイルがいまも視野に必要か。scheduler のキャンセル判定に渡す。
   * これが無いと「epoch が古い」だけでは切らない規則（§4.5）に引っかかって
   * 地形タイルは一度もキャンセルされない。
   */
  function isTileNeeded(z: number, x: number, y: number): boolean {
    const zc = Math.floor(map.getZoom())
    if (z < zc - 2 || z > zc + 1) return false
    const b = map.getBounds()
    const n = 2 ** z
    const west = (x / n) * 360 - 180
    const east = ((x + 1) / n) * 360 - 180
    const lat = (yy: number) => {
      const t = Math.PI - (2 * Math.PI * yy) / n
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)))
    }
    const north = lat(y)
    const south = lat(y + 1)
    return !(east < b.getWest() || west > b.getEast() ||
             north < b.getSouth() || south > b.getNorth())
  }

  function terrainLayers() {
    const s = store.state
    if (!s.layers.flood) return []
    // 差分モードでも地形メッシュは必要なので、元条件の標高タイルを土台に使い、
    // 判定だけ差分タイル（2 条件の h_conn）から取る。
    // どの条件を土台にするかは domain/terrain.ts が決める（描画側に分岐を置かない）
    const resolved = resolveSurface(catalog.terrain, s.surface)
    if (!resolved) return []
    const { geom: geomAsset, diffUrl } = resolved
    const common = {
      urlTemplate: geomAsset.url, diffUrlTemplate: diffUrl, extent, scheduler,
      uniforms: floodProps(), opacity: 1, isTileNeeded,
    }
    const asset = geomAsset
    return [
      createFloodTileLayer({
        ...common,
        id: `flood-coarse-${s.surface}`,
        // 板なら重ねて描けたが、メッシュ同士だと z-fight する。
        // 粗メッシュは first_meaningful_render 用と割り切り、細が出たら隠す
        visible: !fineDone,
        minZoom: asset.min_zoom, maxZoom: COARSE_MAX_ZOOM,
        cls: 'terrainCoarse',
        onViewportLoad: () => {
          if (coarseDone) return
          coarseDone = true
          // 1 フレーム描かれてから立てる。「読み終わった」ではなく「見えた」を測る
          requestAnimationFrame(() => requestAnimationFrame(() => {
            perf.mark('first_meaningful_render')
            scheduler.openGate()
            // 重い module は初回描画のあとで初めて読む
            void ensurePlateau()
            void startPointCloud()
          }))
        },
      }),
      createFloodTileLayer({
        ...common,
        id: `flood-fine-${s.surface}`,
        visible: true,
        minZoom: COARSE_MAX_ZOOM + 1, maxZoom: asset.max_zoom,
        cls: 'terrainFine',
        onViewportLoad: () => {
          if (!fineDone) { fineDone = true; perf.mark('time_to_terrain'); refresh() }
          perf.cameraSettled()
        },
      }),
    ]
  }

  let plateauFailed = 0
  let plateauLayer: Layer | undefined
  let plateauLoading = false
  let plateauMode: BuildingColorMode | undefined
  let plateauStats = { tiles: 0, primitives: 0, coloured: 0, buildings: 0 }

  /** 属性 -> 色。モードごとに 1 回だけ組む */
  let scheme: ColorScheme | undefined
  function schemeFor(mode: BuildingColorMode): ColorScheme | undefined {
    if (mode === 'none') return undefined
    if (scheme?.mode !== mode) scheme = createColorScheme(catalog, mode)
    return scheme
  }
  /** 描かれた建物の gml_id -> 属性値。凡例の件数はここから数える */
  const plateauValues = new Map<string, string>()
  let legendTimer: number | undefined

  /**
   * 色は b3dm の glTF に焼き込む（属性ごとに primitive を分ける）ので、
   * 塗り分けを変えたらレイヤを作り直す。b3dm は Scheduler の LRU に載っているため
   * 切り替えでネットワークは基本発生しない。
   */
  async function ensurePlateau() {
    const asset = catalog.plateau.bldg_lod1
    const mode = store.state.buildingColor
    if (!asset || plateauLoading || (plateauLayer && plateauMode === mode)) return
    plateauLoading = true
    try {
      const { createPlateauLayer } = await import('./view/plateau')
      const first = plateauMode === undefined
      plateauMode = mode
      plateauStats = { tiles: 0, primitives: 0, coloured: 0, buildings: 0 }
      plateauValues.clear()
      plateauLayer = createPlateauLayer({
        id: `plateau-bldg-${mode}`,
        url: asset.url,
        scheduler,
        scheme: schemeFor(mode),
        onTileLoad: (r) => {
          plateauStats.tiles++
          plateauStats.primitives += r.primitives
          plateauStats.coloured += r.coloured
          plateauStats.buildings += r.buildings
          // 同じ建物が複数タイルに出てくるので gml_id で潰す
          for (const [id, v] of r.values) plateauValues.set(id, v)
          // 凡例の件数はタイルが届くたびに増える。タイル 1 枚ごとに
          // 再描画すると 22 回作り直すことになるので束ねる
          if (r.values.length && legendTimer === undefined) {
            legendTimer = window.setTimeout(() => { legendTimer = undefined; refresh() }, 250)
          }
        },
        // 塗り替えでは測り直さない。time_to_plateau は初回描画の指標
        onViewportLoaded: () => { if (first) perf.mark('time_to_plateau') },
        onTileError: (t, e) => { plateauFailed++; console.warn('b3dm failed', t, e) },
        onTileset: (ts) => { plateauTileset = ts },
      })
      if (first) perf.mark('plateau_module_loaded')
    } finally {
      plateauLoading = false
    }
    refresh()
  }
  function plateauLayers() {
    if (!plateauLayer) return []
    // 3D Tiles は実高のままなので、地形を鉛直強調すると噛み合わない。
    // レイヤ自体は外さず visible で切る（外して戻すと deck.gl が assertion で落ちる）
    const show = store.state.layers.plateau && store.state.exaggeration === 1
    return [plateauLayer.clone({ visible: show })]
  }

  function pcCoverageLayer() {
    if (!store.state.layers.pcCoverage || !pcCoverageData || !makePcCoverage) return []
    return [makePcCoverage(pcCoverageData)]
  }

  function semanticsLayer() {
    const s = store.state
    if (!s.layers.semantics || features.length === 0 || !makeSemantics) return []
    return [makeSemantics({
      features,
      waterLevel: s.waterLevel,
      // 地物の色は「いま見ている条件」で塗る。差分モードでは土台にした条件を使う
      condition: resolveSurface(catalog.terrain, s.surface)?.condition ?? 'highres',
      roadThresholds: catalog.semantics.road_depth_classes_m,
      changedOnly: s.layers.changedOnly,
      onClick: (a) => store.set({ selected: a }),
    })]
  }

  function refresh() {
    rebuildFeatureGeometry()
    overlay.setProps({
      layers: [
        ...terrainLayers(),
        ...pcCoverageLayer(),
        ...semanticsLayer(),
        ...plateauLayers(),
        ...(pcb ? pcb.renderer.layers(store.state.layers.pointcloud,
              store.state.exaggeration, geoid) : []),
      ],
    })
    const sch = schemeFor(store.state.buildingColor)
    renderControls(document.getElementById('controls')!, store, catalog,
      (id) => applyPreset(map, id),
      sch ? legendOf(plateauValues, sch) : [])
    renderInspector(document.getElementById('inspector')!, store, catalog)
  }

  // ---- 点群の起動とカメラ連動 -------------------------------------------
  /**
   * LOD 予算。当初 maxPoints を 3,000,000 と根拠なく置いていたが、実測すると
   * deck.gl PointCloudLayer の描画コストは点数にほぼ線形で約 23 ns/点/frame。
   * 300 万点ではドラッグ中 68 ms/frame（15 fps）になる。
   * 60 fps を保てる上限として 60 万点に置く（docs/WEB_RESULTS.md §6.2）。
   */
  const budget = (): LodBudget => {
    const bw = scheduler.bandwidthBps || 2e6
    return {
      maxPoints: PC_MAX_POINTS,
      // 帯域推定から毎回決める。遅い回線では自動的に浅い LOD で止まる。
      // ?maxbytes= で上書きできる。**キャンセル経路の検証に必要**で、
      // 絞った回線ではこの予算が pcFine の発行そのものを止めてしまい、
      // 「キャンセルすべき飛行中の要求」が作れない（docs/WEB_RESULTS.md §5）
      maxBytes: PC_MAX_BYTES ?? Math.max(2e6, Math.min(20e6, bw * 6)),
      screenSpaceError: 2.0,
      coarseDepth: 1,
    }
  }
  const viewState = (): ViewState => {
    // ローカル原点は AOI 中心なので、視点は中心の真上として扱えば十分（AOI は 1 km 四方）
    const alt = ((map as unknown as { transform?: { cameraToCenterDistance?: number } })
      .transform?.cameraToCenterDistance) ?? 1000
    return {
      eye: [0, 0, Math.max(alt / 8, 60)],
      viewportHeight: map.getCanvas().clientHeight,
      fovY: (Math.PI / 180) * 36.87,
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
        onChange: () => refresh(),
      })
      await pcb.controller.open()
      await pcb.controller.update(viewState(), budget())
      refresh()
    } catch (e) {
      console.warn('point cloud unavailable', e)
    }
  }

  // カメラは 60ms デバウンス。毎フレーム epoch を進めるとキャンセル暴走する（§4.5）
  let moveTimer: number | undefined
  map.on('movestart', () => perf.cameraMoveStart())
  map.on('move', () => {
    window.clearTimeout(moveTimer)
    moveTimer = window.setTimeout(() => {
      scheduler.setEpoch(scheduler.currentEpoch + 1)
      scheduler.reap()
      if (pcb?.controller.ready && store.state.layers.pointcloud) {
        void pcb.controller.update(viewState(), budget())
      }
    }, 60)
  })

  bindCameraKeys(map, (d) => {
    const i = EXAGGERATIONS.indexOf(store.state.exaggeration as never)
    const next = EXAGGERATIONS[Math.min(EXAGGERATIONS.length - 1, Math.max(0, i + d))]
    store.set({ exaggeration: next })
  })

  map.on('load', () => {
    map.addControl(overlay as unknown as Parameters<typeof map.addControl>[0])
    refresh()
  })
  store.subscribe((s) => {
    if (s.layers.pointcloud && !pcStarted) void startPointCloud()
    if (s.layers.plateau) void ensurePlateau()
    refresh()
  })

  // PerfRecorder は常時走らせるが、パネルは既定で隠す。内訳を読むのは開発者だけで、
  // 浸水を見に来た人には要らない。?perf=1 か P キーで出す（docs/WEB_DESIGN.md §8.1）
  const perfEl = document.getElementById('perf')!
  let perfVisible = new URLSearchParams(location.search).get('perf') === '1'
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
    perf, scheduler, store, map,
    get pc() { return pcb?.controller },
    plateauTileset: () => plateauTileset,
    snapshot: () => ({
      ...perf.snapshot(),
      pointcloud: pcb?.controller.stats() ?? null,
      plateau: { loaded: plateauStats.tiles, failed: plateauFailed,
                 expected: catalog.plateau.bldg_lod1?.b3dm_count ?? 0,
                 // 属性色は primitive 分割で入れているので draw call が増える。実測用
                 colorMode: plateauMode ?? 'none',
                 primitives: plateauStats.primitives,
                 coloured: plateauStats.coloured, buildings: plateauStats.buildings },
    }),
    setWaterLevel: (v: number) => store.set({ waterLevel: v }),
    setSurface: (v: SurfaceMode) => store.set({ surface: v }),
    setExaggeration: (v: number) => store.set({ exaggeration: v }),
    setCamera: (id: string) => applyPreset(map, id as never),
    setLayer: (k: string, v: boolean) => store.setLayer({ [k]: v } as never),
    setBuildingColor: (v: BuildingColorMode) => store.set({ buildingColor: v }),
    setPerfVisible,
  }
}

void boot()
