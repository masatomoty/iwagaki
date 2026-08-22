// アプリの組み立て。ここが唯一「全部を知っている」場所。
// 依存の向き: ui -> view -> pointcloud -> net -> assets -> domain（docs/WEB_DESIGN.md §1）

import 'maplibre-gl/dist/maplibre-gl.css'

import { MapboxOverlay } from '@deck.gl/mapbox'
import { GeoJsonLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'

import type { Catalog } from './domain/catalog'
import { decisionChanged, featureDepth } from './domain/flood'
import type { FeatureAssertion } from './domain/types'
import { Scheduler } from './net/scheduler'
import { PerfRecorder } from './perf/recorder'
import type { PcBundle } from './pointcloud/lazy'
import type { LodBudget, ViewState } from './pointcloud/types'
import { initialState, Store } from './state'
import { createFloodTileLayer, type FloodProps } from './view/floodTileLayer'
import { createMap } from './view/map'
import { liftZ, toAssertion, type RawFeature } from './view/semantics'
import { FLOOD_MODE } from './view/shaders/flood'
import { renderControls } from './ui/controls'
import { renderInspector } from './ui/inspector'
import { renderPerf } from './ui/perfPanel'

const COARSE_MAX_ZOOM = 15          // ここまでが terrain-coarse（first_meaningful_render の対象）
const USEFUL_POINTS = 200_000
/** 実測で決めた常駐点数の上限（docs/WEB_RESULTS.md §6.2）。?maxpts= で上書きできる */
const PC_MAX_POINTS = Number(new URLSearchParams(location.search).get('maxpts')) || 600_000

/** 計測用のスイッチ。既定値を変えずに条件だけ切り替えられるようにする */
const qs = new URLSearchParams(location.search)
const OPT = {
  // coalescing は既定 OFF。リクエスト数は減るが、束ねた range が全部届くまで
  // 中のノードが 1 つもデコードされないので最初の点が遅れる（docs/WEB_RESULTS.md §4）
  coalesce: qs.get('coalesce') === '1',
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
  let features: RawFeature[] = []
  let assertions = new Map<string, FeatureAssertion>()
  void (async () => {
    const b = await scheduler.submit({
      key: 'semantics', url: catalog.semantics.url, cls: 'semantics',
    })
    const fc = JSON.parse(new TextDecoder().decode(b)) as { features: RawFeature[] }
    features = fc.features.map((f) => ({ ...f, geometry: liftZ(f.geometry, geoid) }))
    for (const f of features) {
      const a = toAssertion(f.properties)
      assertions.set(a.gmlId, a)
      ;(f.properties as Record<string, unknown>).__a = a
    }
    perf.mark('semantics_loaded')
    refresh()
  })()

  // ---- 描画ループ -------------------------------------------------------
  const extent = catalog.aoi.bbox_wgs84
  let coarseDone = false
  let fineDone = false

  const floodProps = (): FloodProps => {
    const s = store.state
    const mpt = 156543.03392 * Math.cos((catalog.aoi.centre_wgs84[1] * Math.PI) / 180) /
      2 ** Math.round(map.getZoom()) / 256 * 256
    return {
      waterLevel: s.waterLevel,
      hStep: catalog.packing.h_step,
      mode: s.surface === 'diff' ? FLOOD_MODE.diff : FLOOD_MODE.terrain,
      floodOpacity: 0.82,
      groundOpacity: s.layers.ground ? 0.95 : 0,
      showGround: s.layers.ground ? 1 : 0,
      metersPerTexel: Math.max(mpt / 256, 0.1),
      texel: [1 / 256, 1 / 256],
    }
  }

  function terrainLayers() {
    const s = store.state
    const asset = catalog.terrain[s.surface]
    if (!asset || !s.layers.flood) return []
    const fp = floodProps()
    const common = {
      urlTemplate: asset.url, extent, scheduler, flood: fp,
      visible: true, opacity: 1, elevationOffset: geoid,
    }
    return [
      createFloodTileLayer({
        ...common,
        id: `flood-coarse-${s.surface}`,
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
        minZoom: COARSE_MAX_ZOOM + 1, maxZoom: asset.max_zoom,
        cls: 'terrainFine',
        onViewportLoad: () => {
          if (!fineDone) { fineDone = true; perf.mark('time_to_terrain') }
          perf.cameraSettled()
        },
      }),
    ]
  }

  let plateauLoaded = 0
  let plateauFailed = 0
  let plateauLayer: Layer | undefined
  let plateauLoading = false
  async function ensurePlateau() {
    const asset = catalog.plateau.bldg_lod1
    if (!asset || plateauLayer || plateauLoading) return
    plateauLoading = true
    const { createPlateauLayer } = await import('./view/plateau')
    plateauLayer = createPlateauLayer({
      url: asset.url,
      scheduler,
      onTileLoad: () => {
        plateauLoaded++
        if (plateauLoaded >= asset.b3dm_count) perf.mark('time_to_plateau')
      },
      onTileError: (t, e) => { plateauFailed++; console.warn('b3dm failed', t, e) },
    })
    perf.mark('plateau_module_loaded')
    refresh()
  }
  function plateauLayers() {
    return store.state.layers.plateau && plateauLayer ? [plateauLayer] : []
  }

  function semanticsLayer() {
    const s = store.state
    if (!s.layers.semantics || features.length === 0) return []
    const th = catalog.semantics.road_depth_classes_m
    return [new GeoJsonLayer({
      id: 'semantics',
      data: features as unknown as never,
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      updateTriggers: {
        getFillColor: [s.waterLevel, s.layers.changedOnly, s.surface],
        getLineColor: [s.waterLevel, s.layers.changedOnly],
      },
      getFillColor: (f: unknown) => {
        const a = (f as RawFeature).properties.__a as FeatureAssertion
        const changed = decisionChanged(a, s.waterLevel, th)
        if (s.layers.changedOnly && !changed) return [0, 0, 0, 0]
        if (a.unreliable) return [110, 110, 120, 70]
        if (changed) return [242, 68, 52, 190]
        const cond = s.surface === 'diff' ? 'highres' : s.surface
        return featureDepth(a, cond, s.waterLevel) > 0
          ? [70, 130, 200, 120]
          : [190, 195, 205, 55]
      },
      getLineColor: (f: unknown) => {
        const a = (f as RawFeature).properties.__a as FeatureAssertion
        return decisionChanged(a, s.waterLevel, th) ? [255, 220, 120, 230] : [20, 24, 32, 140]
      },
      onClick: (info: { object?: unknown }) => {
        const o = info.object as RawFeature | undefined
        store.set({ selected: o ? (o.properties.__a as FeatureAssertion) : undefined })
      },
    })]
  }

  function refresh() {
    overlay.setProps({
      layers: [
        ...terrainLayers(),
        ...semanticsLayer(),
        ...plateauLayers(),
        ...(pcb ? pcb.renderer.layers(store.state.layers.pointcloud) : []),
      ],
    })
    renderControls(document.getElementById('controls')!, store, catalog)
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
      // 帯域推定から毎回決める。遅い回線では自動的に浅い LOD で止まる
      maxBytes: Math.max(2e6, Math.min(20e6, bw * 6)),
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
        usefulPoints: USEFUL_POINTS,
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

  map.on('load', () => {
    map.addControl(overlay as unknown as Parameters<typeof map.addControl>[0])
    refresh()
  })
  store.subscribe((s) => {
    if (s.layers.pointcloud && !pcStarted) void startPointCloud()
    if (s.layers.plateau) void ensurePlateau()
    refresh()
  })

  const perfEl = document.getElementById('perf')!
  const drawPerf = () => renderPerf(perfEl, perf, scheduler, pcb?.controller, store)
  perf.onChange(drawPerf)
  setInterval(drawPerf, 500)
  drawPerf()

  // 計測ハーネスからの取り出し口
  ;(window as unknown as Record<string, unknown>).__iwagaki = {
    perf, scheduler, store,
    get pc() { return pcb?.controller },
    snapshot: () => ({
      ...perf.snapshot(),
      pointcloud: pcb?.controller.stats() ?? null,
      plateau: { loaded: plateauLoaded, failed: plateauFailed,
                 expected: catalog.plateau.bldg_lod1?.b3dm_count ?? 0 },
    }),
    setWaterLevel: (v: number) => store.set({ waterLevel: v }),
    setSurface: (v: 'baseline' | 'highres' | 'diff') => store.set({ surface: v }),
    setLayer: (k: string, v: boolean) => store.setLayer({ [k]: v } as never),
  }
}

void boot()
