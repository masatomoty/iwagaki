// アプリの組み立て。ここが唯一「全部を知っている」場所。
// 依存の向き: ui -> view/three -> pointcloud -> net -> assets -> domain
// （docs/web_design.md「層の分け方」）
//
// 描画は three.js。MapLibre + deck.gl は外した（docs/web_results.md「初期チャンクの内訳」）。
// net / domain / perf / state / pointcloud の index・LOD・decode は renderer に
// 依存しない設計だったので、そのまま再利用している。

import { Vector2 } from 'three'

import { sampleLine } from './assets/terrainSampler'
import { type CameraDescription, eyeInLocal, visibleBoxLocal,
         visiblePolygonLocal } from './domain/camera'
import { floorCounts, perAreaFloodCounts, regulatedRoadCount } from './domain/flood'
import type { Catalog } from './domain/catalog'
import type { TideSeries } from './domain/tideSeries'
import { parseAreaIndex, pickArea, SINGLE_AREA } from './domain/areas'
import { comparisonPair, resolveSurface } from './domain/terrain'
import {
  basinAt, catchmentOf, catchmentSummary, indexFlowBasins, resolveFlow,
  resolveFlowBasins, type FlowBasins,
} from './domain/flow'
import { parsePointBufferIndex, type PointBufferIndex } from './domain/pointBuffer'
import type { BuildingColorMode, FeatureAssertion, RoadColorMode, SurfaceMode,
              TerrainCondition } from './domain/types'
import type { WalkIsochroneGeoJSON } from './domain/walkIsochrone'
import { Scheduler } from './net/scheduler'
import { PerfRecorder } from './perf/recorder'
import type { PcBundle } from './pointcloud/lazy'
import type { LodBudget, ViewState } from './pointcloud/types'
import { initialState, Store } from './state'
import { FLOOD_MODE } from './three/floodMaterial'
import { createLocalFrame, worldToLngLat } from './three/mercator'
import type { PlateauTiles } from './three/plateauTiles'
import { createWalkIsochroneLayer, type WalkIsochroneLayer } from './three/walkIsochroneLayer'
// **地物メッシュは遅延しない。** 1.8 kB (br) を後回しにするために 1 往復払っていた。
// 高 RTT では往復のほうが 2 桁高い（fatpipe-highrtt 405 ms / slow-highrtt 568 ms、
// 対して JSON 解釈は 3〜7 ms・三角形化は 7〜9 ms。docs/web_results.md
// 「objects.geojson のパースコストは 3 ms、遅延ロードの往復が 568 ms」）
import { createRailwayLine, type RailwayLine } from './three/railwayLine'
import { createPourPoints, type PourPoints } from './three/pourPoints'
import { createCatchmentLayer, type CatchmentLayer } from './three/catchmentLayer'
import { createCoverageOutline, SemanticsMesh } from './three/semanticsMesh'
import { TerrainTiles } from './three/terrainTiles'
import { FOV_Y_DEG, type Viewer } from './three/viewer'
import { EXAGGERATIONS, renderControls } from './ui/controls'
import { renderInspector } from './ui/inspector'
import { renderPerf } from './ui/perfPanel'
import {
  initialPointBufferState, loadPointBufferResult, mountPointBufferPanel,
  updatePointBufferPanel, type PointBufferPanelState,
} from './ui/pointBufferPanel'
import { drawSection, drawSectionMessage, type SectionSeries } from './ui/section'
import {
  createColorScheme, depthLegend, FLOOR_ABOVE_DEPTH_M, legendOf, type ColorScheme,
} from './view/buildingColor'
import { applyPreset, attachViewCube, bindCameraKeys, createViewer, initialZoom,
         showSectionLine } from './view/map'
import { PointPickTool } from './view/pointPickTool'
import { SectionTool, type LonLat } from './view/sectionTool'
import { toAssertion, type RawFeature } from './view/semantics'

const COARSE_MAX_ZOOM = 15          // ここまでが terrain-coarse（first_meaningful_render の対象）

/**
 * 粗ピラミッドの上限。**範囲が広いほど 1 段粗くする。**
 *
 * FMR は「粗ピラミッドの可視集合が揃った時点」なので、**待つ枚数がそのまま
 * FMR になる**。上限を 15 で固定していたとき、625 ha の範囲では起動倍率 16.1 で
 * ビューポートが AOI をほぼ覆うため、z15 のタイルを**ほぼ全部**待っていた [実測]。
 *
 * | | 起動倍率 | FMR が待つ粗タイル | 粗のバイト | FMR |
 * |---|---:|---:|---:|---:|
 * | 吉原 100 ha | 17.2 | 4 枚 | 73 kB | 1,629 ms |
 * | 西舞鶴 625 ha | 16.1 | 12 枚 | 454 kB | 3,176 ms |
 * | 東舞鶴 625 ha | 16.1 | 16 枚 | 267 kB | 4,362 ms |
 *
 * **効いているのはバイトではなく枚数**である。西舞鶴は東舞鶴より 1.7 倍重いのに
 * 速い。fast4g は RTT 70 ms で並列上限もあるので、往復回数が支配する。
 *
 * z14 なら西舞鶴 4 枚 / 東舞鶴 6 枚で済む。細（z16 以上）は裏で降りてくるので
 * **最終的な絵は変わらない**。「範囲が広いほど最初は粗く出す」は素直な振る舞いでもある。
 *
 * **吉原は 15 のまま。** `docs/web_results.md` の実測値がこの倍率・この段で
 * 取ってあるので、変えると過去の数字と比べられなくなる。
 */
function coarseMaxZoom(catalog: Catalog): number {
  const [w, s, e, n] = catalog.aoi.bbox_wgs84
  const lat = (s + n) / 2
  const widthM = (e - w) * 111_320 * Math.cos((lat * Math.PI) / 180)
  const heightM = (n - s) * 110_950
  return Math.max(widthM, heightM) <= 1200 ? COARSE_MAX_ZOOM : COARSE_MAX_ZOOM - 1
}

/**
 * 「点群が見えた」とみなす、LOD が選んだ点数に対する割合。
 * 絶対値（旧: 20 万点）は合成点群向けの値で、実点群では LOD の選択が
 * 17.3〜21.6 万点と閾値をまたぎ、同じ画面でも計測できたりできなかったりした。
 * 割合にすればデータ密度・LOD 予算を変えても同じものを指す（docs/web_results.md「計測の方針」）。
 */
const USEFUL_FRACTION = 0.5
/**
 * 常駐点数の上限。`?maxpts=` で上書きできる。
 *
 * 60 万点は deck.gl `PointCloudLayer`（1 点 = インスタンス化クアッド 6 頂点）での
 * 実測値だった。three.js の `Points` で測り直すと**桁が違う**: 6.0 M 点 /
 * draw call 132 / GPU 90 MB でもドラッグ中 p50 16.6 ms・p95 18.2 ms で 60 fps を保ち、
 * 崩れ始めるのは 9.9 M 点から（`docs/web_results.md`「点群の配信」）。
 *
 * **測った上限をそのまま入れない。** 計測は開発機（Apple Silicon）で、
 * 配信先の庁内 PC の GPU は分かっていない [未確認]。実測の 1/3 に当たる
 * 200 万点（GPU 30 MB）なら、3 倍遅い GPU でも 60 fps に収まる計算になる。
 *
 * なお**細い回線ではここは効かない**。既定の視点で LOD が要求するのは 12.5 万点で、
 * 効いているのは `maxBytes`（帯域推定）と screen-space error のほうである。
 */
const PC_MAX_POINTS = Number(new URLSearchParams(location.search).get('maxpts')) || 2_000_000
/** LOD のバイト予算の上書き。計測専用（既定は帯域推定から決める） */
const PC_MAX_BYTES = Number(new URLSearchParams(location.search).get('maxbytes')) || undefined
/**
 * 点間隔の下限 [px]。**これより細かいノードは取らない。**
 *
 * `?sse=` で上書きできる。値の意味は「画面上で点が何 px 離れているか」で、
 * 小さくするほど深い LOD まで取る。点の大きさが 1.4 px なので、
 * 2.0 だと点の間に必ず隙間が空く（`docs/web_results.md`「点間隔の下限」）。
 */
const PC_SSE = Number(new URLSearchParams(location.search).get('sse')) || 1.0

/** 計測用のスイッチ。既定値を変えずに条件だけ切り替えられるようにする */
const qs = new URLSearchParams(location.search)
const OPT = {
  // coalescing は既定 ON。1 リクエスト内のストリーミングデコードを入れた結果、
  // 「束ねると最初の点が遅れる」不利が消えて速い側になった（docs/web_results.md「range coalescing」）
  coalesce: qs.get('coalesce') !== '0',
  // 点群は既定 OFF。?pc=1 で有効化
  pointcloud: qs.get('pc') === '1',
  /** ?ortho=1 で正射投影から始める */
  ortho: qs.get('ortho') === '1',
  /**
   * 点の色に COPC の RGB を使うか。**計測専用**（`?rgb=0` で標高ランプに戻す）。
   * RGB を読む decode コストを `perf/ab.mjs` の形で交互に測るために置いてある
   * （単発だとこの機械の負荷と分離できなかった。docs/web_results.md）
   */
  rgb: qs.get('rgb') !== '0',
}

async function boot() {
  const scheduler = new Scheduler()
  const perf = new PerfRecorder(scheduler)

  // **入口は範囲の索引。** 範囲は 3 つあり（`domain/areas.ts`）、それぞれに
  // catalog が 1 枚ある。索引が無い配信物（`areas.json` を焼く前の世代）では
  // `data/catalog.json` 1 枚の単一範囲として動く = 旧配信物と互換。
  const text = (b: ArrayBuffer | Uint8Array) =>
    new TextDecoder().decode(b as ArrayBuffer)
  let areaIndex = SINGLE_AREA
  try {
    areaIndex = parseAreaIndex(JSON.parse(text(await scheduler.submit({
      key: 'areas', url: 'data/areas.json', cls: 'catalog',
    }))))
  } catch {
    // 404 も壊れた JSON もここに来る。単一範囲として続ける
  }
  const area = pickArea(areaIndex, qs.get('area'))

  // catalog は範囲ごとの入口。URL を差し替えれば配信先が変わる
  const catalogBytes = await scheduler.submit({
    key: 'catalog', url: area.catalog, cls: 'catalog',
  })
  const catalog: Catalog = JSON.parse(text(catalogBytes))
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
  viewer.setZoom(Number(qs.get('z')) || initialZoom(catalog))
  // 操作系（トップバー・断面ツール・左サイドバー）を左上に固めたので、既定の注視点を
  // 画面の右下寄りへ送って市街が隠れないようにする（?z 指定時も同じ）
  if (!qs.has('target')) {
    viewer.panByPixels(viewer.canvas.clientWidth * 0.17, viewer.canvas.clientHeight * 0.12)
  }
  if (OPT.ortho) viewer.setProjection('orthographic')
  attachViewCube(viewer)

  // 地物の属性は左サイドバーの「属性情報」タブに出す（旧・右上の浮きパネルは廃止）

  // 出典はトップバー右端の「出典」に畳んで置く（`ui/controls.ts::topbarHtml`）。
  // ラベルは常に見え、ホバー／フォーカスで全文に到達できる

  // ---- 地形 -------------------------------------------------------------
  const extent = catalog.aoi.bbox_wgs84
  let coarseDone = false
  let fineDone = false

  const floodUniforms = () => {
    const s = store.state
    return {
      waterLevel: s.waterLevel,
      hStep: catalog.packing.h_step,
      mode: s.surface === 'assumption' ? FLOOD_MODE.assumption
        : resolveSurface(catalog.terrain, s.surface)?.isDiff
          ? FLOOD_MODE.diff : FLOOD_MODE.terrain,
      exaggeration: s.exaggeration,
      geoid,
      floodOpacity: 0.82,
      groundOpacity: s.layers.ground ? 0.95 : 0,
      showGround: s.layers.ground ? 1 : 0,
      // 平常時に水がある範囲の下地。潮位を MSL より下げても川が消えないようにする
      waterBase: catalog.water_level.reference_levels_m_tp?.['MSL'] ?? 0,
      // 水面メッシュの可視。uniform ではなく TerrainTiles が visible に使う
      waterSurface: s.layers.waterSurface,
      // 窪地（標高 ≤ 潮位 だが海と地表面ではつながっていない）。タイルは増えない。
      // **単純モデルでは窪地という状態が無い**ので出さない（domain/flood.ts の ponded()）
      ponded: s.layers.ponded && s.floodModel === 'connected',
      // 潮位 − 地盤高だけで浸水を決めるか（domain/types.ts の FloodModel）
      // 排水差分は h_conn(highres) と h_conn(drainage) の比較なので、
      // 既定の simple モデル設定に関係なくシェーダへ連結判定を渡す。
      simple: s.floodModel === 'simple' && s.surface !== 'diff_drainage'
        && s.surface !== 'assumption',
      drainage: s.floodModel === 'drainage',
      // 地形の面を地盤高のグラデーションで塗るか（同 TerrainPaint）
      elevPaint: s.terrainPaint === 'elevation',
      // 地形の面を水みち（flow accumulation）で塗るか。潮位非依存（同 TerrainPaint）
      catchmentPaint: s.terrainPaint === 'catchment',
    }
  }

  /** 地形条件が変わるとタイルの URL ごと変わるので、ピラミッドを作り直す */
  let coarse: TerrainTiles | undefined
  let fine: TerrainTiles | undefined
  let builtSurface: string | undefined

  function buildTerrain() {
    const s = store.state
    // 水みちタイルは水みちモードのときだけ引く（highres で 1.3 MB）ので、
    // 塗りモードが変わったら作り直す（`elevation ⇄ flood` は uniform だけで済むが、
    // `catchment` はタイル取得が要る）
    const wantFlow = s.terrainPaint === 'catchment'
    const buildKey = `${s.surface}:${s.floodModel}:${wantFlow ? 'flow' : ''}`
    if (builtSurface === buildKey) return
    builtSurface = buildKey
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
    // **仮定の段階は 3 段を差分タイルから引く**ので、浸水モデルの選択に関わらず
    // 地形は元条件（highres）のまま、色タイルは必ず差分タイルを使う
    const isAssumption = s.surface === 'assumption'
    const geomAsset = s.floodModel === 'drainage' && !isAssumption
      ? catalog.terrain.drainage ?? resolved.geom : resolved.geom
    const { diffUrl } = resolved
    const drainageDiff = s.floodModel === 'drainage'
      ? catalog.terrain.diff_drainage?.url : undefined
    // 水みちタイルは「いま形を取っている条件」に合わせて引く（domain/flow.ts が
    // 条件欠損を highres にフォールバックさせる）。潮位非依存なので diff とは無関係
    const flow = wantFlow ? resolveFlow(catalog.flow, resolved.condition) : undefined
    const flowUrlTemplate = flow?.url
    const common = {
      viewer, frame, scheduler, extent,
      urlTemplate: geomAsset.url,
      diffUrlTemplate: isAssumption ? diffUrl
        : s.floodModel === 'drainage' ? undefined : diffUrl ?? drainageDiff,
      flowUrlTemplate,
    }
    // 粗の上限は範囲の広さで決まる（coarseMaxZoom）。細はその 1 段上から。
    // **水みちモードでは細の上限を水みちタイルの上限に合わせる**（広い範囲は z16）。
    // 揃えないと z17+ で elev だけ来て水みちが穴になる（`three/pourPoints.ts` の
    // マーカーは残る）。地形も 1 段粗くなるが、俯瞰で見るオーバーレイなので許容
    const coarseMax = coarseMaxZoom(catalog)
    const fineMax = flow ? Math.min(geomAsset.max_zoom, flow.max_zoom) : geomAsset.max_zoom
    coarse = new TerrainTiles({
      ...common, cls: 'terrainCoarse', renderOrder: 0,
      minZoom: geomAsset.min_zoom, maxZoom: coarseMax,
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
      minZoom: coarseMax + 1, maxZoom: Math.max(fineMax, coarseMax + 1),
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
  /**
   * ホバー中の地物の gml_id。**store に置かない。**
   * マウス移動ごとに store.set すると購読側の refresh()（地形 uniform の更新と
   * 断面の再描画まで）が毎フレーム走る。強調は色属性だけで済む
   */
  let hovered: string | undefined
  const assertions = new Map<string, FeatureAssertion>()
  const tideCurves = new Map<string, TideSeries>()
  if (catalog.water_level.tide_series) {
    void (async () => {
      await Promise.all(catalog.water_level.tide_series!.series.map(async (entry) => {
        const b = await scheduler.submit({
          key: `tide-${entry.id}`, url: entry.url, cls: 'catalog',
        })
        tideCurves.set(entry.id, JSON.parse(new TextDecoder().decode(b)) as TideSeries)
      }))
      refresh()
    })()
  }

  void (async () => {
    const b = await scheduler.submit({
      key: 'semantics', url: catalog.semantics.url, cls: 'semantics',
    })
    perf.mark('semantics_loaded')
    // **取得・JSON 解釈・三角形化は費用の質が違う。** 分けて測る
    const fc = JSON.parse(new TextDecoder().decode(b)) as { features: RawFeature[] }
    rawFeatures = fc.features
    for (const f of rawFeatures) {
      const a = toAssertion(f.properties)
      assertions.set(a.gmlId, a)
      ;(f.properties as Record<string, unknown>).__a = a
    }
    perf.mark('semantics_parsed')
    semantics = new SemanticsMesh(frame, rawFeatures, geoid)
    perf.mark('semantics_mesh_built')
    viewer.world.add(semantics.group)
    refresh()
    void loadPcCoverage()
    void loadRailway()
    void loadPourPoints()
  })()

  // ---- PLATEAU ----------------------------------------------------------
  let plateau: PlateauTiles | undefined
  let plateauLoading = false
  let plateauMode: BuildingColorMode | undefined
  /** 浸水深モードのとき、地盤高を取った条件。変わったら焼き直しが要る */
  let plateauCondition = ''
  let plateauFailed = 0
  let scheme: ColorScheme | undefined
  /**
   * 属性で塗るモードだけが ColorScheme を要る。`depth` は**属性ではなく水位**から
   * 決まるので scheme を持たない（色は buildingColor.ts の DEPTH_CLASSES 固定）。
   */
  function schemeFor(mode: BuildingColorMode): ColorScheme | undefined {
    if (mode !== 'class' && mode !== 'usage') return undefined
    if (scheme?.mode !== mode) scheme = createColorScheme(catalog, mode)
    return scheme
  }
  /** 床上とみなす浸水深。配信物にあればそれを使う（無い世代の catalog もある） */
  const floorDepth = catalog.semantics.floor_above_depth_m ?? FLOOR_ABOVE_DEPTH_M
  const plateauValues = new Map<string, string>()
  let legendTimer: number | undefined

  async function ensurePlateau() {
    const asset = catalog.plateau.bldg_lod1
    const mode = store.state.buildingColor
    // 浸水深で塗るときだけ、地盤高と h_conn を**どの条件から取るか**が効く。
    // 属性で塗っているときは条件が変わっても色は変わらないので作り直さない
    const depthMode = mode === 'depth'
    const cond = store.state.floodModel === 'drainage' ? 'drainage'
      : resolveSurface(catalog.terrain, store.state.surface)?.condition ?? 'highres'
    const condKey = depthMode ? cond : ''
    if (!asset || plateauLoading) return
    if (plateau && plateauMode === mode && plateauCondition === condKey) return
    plateauLoading = true
    try {
      const { PlateauTiles } = await import('./three/plateauTiles')
      const first = plateauMode === undefined
      if (first) perf.mark('plateau_module_loaded')
      plateauMode = mode
      plateauCondition = condKey
      if (plateau) { viewer.world.remove(plateau.group); plateau.dispose() }
      plateauValues.clear()
      plateau = new PlateauTiles({
        url: asset.url, scheduler, viewer, frame, geoid,
        scheme: schemeFor(mode),
        // **潮位はここに渡さない。** 渡すとスライダを動かすたびに b3dm を
        // 作り直すことになる。水位は setWaterLevel で uniform だけ書き換える
        depthMode, condition: cond, floorDepth,
        assertionOf: (id) => assertions.get(id),
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
   * AOI 100 ha に対し点群は 3.17 ha しかない（docs/results.md）。
   */
  let coverage: import('three').LineSegments | undefined
  async function loadPcCoverage() {
    const a = catalog.pointcloud_coverage
    if (!a?.url || coverage) return
    try {
      const b = await scheduler.submit({ key: 'pc-coverage', url: a.url, cls: 'prefetch' })
      const data = JSON.parse(new TextDecoder().decode(b))
      coverage = createCoverageOutline(frame, data, geoid)
      viewer.world.add(coverage)
      refresh()
    } catch {
      // 表示の補助なので、取れなくても地図は動かす
    }
  }

  // ---- JR 線路 ------------------------------------------------------------
  /**
   * 市が「表示範囲の東側をここまで」と赤破線で指した基準線そのもの（19 kB）。
   * **クラスは prefetch。** 無くても地図は成立する種類の情報なので、何も待たせない。
   * 標高は `scripts/12` が 0.5m DEM から焼き込んであるので、地形タイルを待たない。
   */
  let railway: RailwayLine | undefined
  async function loadRailway() {
    const a = catalog.railway
    if (!a?.url || railway) return
    try {
      const b = await scheduler.submit({ key: 'railway', url: a.url, cls: 'prefetch' })
      railway = createRailwayLine(frame, JSON.parse(new TextDecoder().decode(b)), geoid)
      viewer.world.add(railway.object)
      refresh()
    } catch {
      // 表示の補助なので、取れなくても地図は動かす
    }
  }

  /**
   * 窪地の越流点マーカー（`catalog.flow.pits`、13 kB 程度）。**潮位非依存の別レイヤ。**
   * railway と同じく prefetch・標高は GeoJSON に焼き込み済み・無くても地図は成立する。
   */
  let pourPoints: PourPoints | undefined
  async function loadPourPoints() {
    const a = catalog.flow?.pits
    if (!a?.url || pourPoints) return
    try {
      const b = await scheduler.submit({ key: 'flow-pits', url: a.url, cls: 'prefetch' })
      pourPoints = createPourPoints(frame, JSON.parse(new TextDecoder().decode(b)), geoid)
      viewer.world.add(pourPoints.object)
      refresh()
    } catch {
      // 表示の補助なので、取れなくても地図は動かす
    }
  }

  /**
   * 部分流域ポリゴン（`catalog.flow.basins`、highres 150 kB 程度）。
   * **水みちモードに入って初めて引く**（普段は要らない）。クリックすると
   * その地点の集水域（当たったリーフ＋上流の全リーフ）をハイライトする。
   */
  let catchment: CatchmentLayer | undefined
  let flowBasins: FlowBasins | undefined
  let flowBasinsLoading = false
  async function loadFlowBasins() {
    const a = resolveFlowBasins(catalog.flow)
    if (!a?.url || flowBasins || flowBasinsLoading) return
    flowBasinsLoading = true
    try {
      const b = await scheduler.submit({ key: 'flow-basins', url: a.url, cls: 'prefetch' })
      flowBasins = indexFlowBasins(JSON.parse(new TextDecoder().decode(b)))
      catchment = createCatchmentLayer(frame, geoid)
      viewer.world.add(catchment.object)
      // 既に流域が選ばれていれば（モード復帰など）描き直す
      applyCatchment(store.state.selectedCatchment?.basinId)
      refresh()
    } catch {
      // 表示の補助。取れなければクリックは地物選択にフォールバックする
    } finally {
      flowBasinsLoading = false
    }
  }

  /**
   * 流域の主流路（`catalog.flow.channels`、highres 数十 kB 程度）。断面ツールの
   * 自動測線用。`flowBasins` と同じタイミングで読む（`basin_id` で対応付く）。
   * `Map<basin_id, [lon,lat][]>`（先頭=吐口・末尾=源流。GeoJSON の座標列そのまま）。
   */
  let flowChannels: Map<number, LonLat[]> | undefined
  let flowChannelsLoading = false
  async function loadFlowChannels() {
    const a = catalog.flow?.channels
    if (!a?.url || flowChannels || flowChannelsLoading) return
    flowChannelsLoading = true
    try {
      const b = await scheduler.submit({ key: 'flow-channels', url: a.url, cls: 'prefetch' })
      const fc = JSON.parse(new TextDecoder().decode(b)) as {
        features: { properties: { basin_id: number }
                   geometry: { coordinates: LonLat[] } }[]
      }
      flowChannels = new Map(fc.features.map((f) => [f.properties.basin_id, f.geometry.coordinates]))
      // 読み込みが終わる前に流域を選んでいた場合はここで追いつく（`applyCatchment`
      // と同じ「復帰時に描き直す」流儀）。ただし **その間に手動断面を引く／別の
      // 流域を選ぶ／パネルを閉じるなど、何か新しいことが起きていたら retry しない**
      // （`sectionSeq` が pending 登録時から変わっていないことで判定する。
      // でないと後から解決したこの retry が、ユーザーが既に見ている新しい断面を
      // 黙って上書きしてしまう）
      const pending = pendingChannelRetry
      pendingChannelRetry = undefined
      if (pending && pending.seq === sectionSeq
          && document.body.classList.contains('section-open')) {
        void buildSectionAlongChannel(pending.basinId)
      }
    } catch {
      // 主流路が無くても手動の 2 点断面は変わらず使える
    } finally {
      flowChannelsLoading = false
    }
  }

  /**
   * 徒歩圏（`catalog.walk_isochrones[]`、複数自治体からの要望 T2）。**T1 の中心点 UI
   * とは統合しない** — 起点は解析側が焼いた固定点の一覧から選ぶだけで、地図を
   * クリックしても新しい等時線は作らない（`ui/controls.ts` の `#wisel`）。
   * レイヤは「重ねる」で ON にして初めて引く（`flowBasins` と同じ遅延ロード）。
   */
  let walkIsochroneLayer: WalkIsochroneLayer | undefined
  let walkIsochroneLoadedUrl: string | undefined
  let walkIsochroneLoading = false
  async function ensureWalkIsochrone() {
    const assets = catalog.walk_isochrones
    if (!assets?.length) return
    const idx = Math.min(Math.max(store.state.walkIsochroneIndex ?? 0, 0), assets.length - 1)
    const asset = assets[idx]
    if (!walkIsochroneLayer) {
      walkIsochroneLayer = createWalkIsochroneLayer(frame, geoid)
      viewer.world.add(walkIsochroneLayer.object)
    }
    if (walkIsochroneLoadedUrl === asset.url || walkIsochroneLoading) return
    walkIsochroneLoading = true
    try {
      const b = await scheduler.submit({ key: `walk-iso-${asset.url}`, url: asset.url, cls: 'prefetch' })
      const data = JSON.parse(new TextDecoder().decode(b)) as WalkIsochroneGeoJSON
      walkIsochroneLayer.setData(data)
      walkIsochroneLoadedUrl = asset.url
      refresh()
    } catch {
      // 表示の補助。取れなくても地図は動かす
    } finally {
      walkIsochroneLoading = false
    }
  }

  /** basin id からハイライトを張り直す（`flowBasins` 未ロードなら何もしない）。 */
  function applyCatchment(rootId: number | undefined) {
    if (!catchment || !flowBasins) return
    if (rootId === undefined) { catchment.setCatchment(null); return }
    const feats = [...catchmentOf(flowBasins, rootId)]
      .map((id) => flowBasins!.byId.get(id))
      .filter((f): f is NonNullable<typeof f> => !!f)
    catchment.setCatchment(feats)
  }

  /** 「水みち」モードでの地図クリック → 集水域を選ぶ。当たらなければ false。 */
  function pickCatchment(clientX: number, clientY: number): boolean {
    if (!flowBasins) return false
    const r = viewer.canvas.getBoundingClientRect()
    // 地面を **ジオイド面**（標高 0）で交える（`sectionTool` と同じ規約）。地表は
    // 実際には `geoid + 標高 * 鉛直強調` に描かれるので、鉛直強調 > 1 かつ俯角の
    // 付いた視点では山側で経緯度がずれ、隣の流域を拾いうる。標高の掛からない定数
    // なので海際は正確で、水みちは俯瞰で見るオーバーレイ（`docs/web_design.md`）・
    // 既定の鉛直強調 ×1 では真下に交わるため誤差 0。地形を実際に raycast する
    // 厳密版は別 PR（`sectionTool` も同じ課題を「残差は無視」で受けている）。
    const p = viewer.unproject(clientX - r.left, clientY - r.top, geoid)
    if (!p) return false
    const id = basinAt(flowBasins, p[0], p[1])
    if (id === undefined) {
      // 流域に当たらなかった（水面・AOI 外など）。集水域の選択は畳んだうえで
      // `false` を返し、クリックは地物選択にフォールバックさせる
      if (store.state.selectedCatchment) store.set({ selectedCatchment: undefined })
      applyCatchment(undefined)
      return false
    }
    const ids = catchmentOf(flowBasins, id)
    const s = catchmentSummary(flowBasins, ids)
    store.set({
      selected: undefined,
      selectedCatchment: {
        basinId: id, areaHa: s.areaHa, maxAccumCells: s.maxAccumCells,
        maxAccumM2: s.maxAccumM2, edgeTruncated: s.edgeTruncated, pit: s.pit,
      },
    })
    applyCatchment(id)
    // 断面パネルが既に開いていれば、選んだ流域の主流路へ追従させる。
    // **パネルを新たに開きはしない** — 集水域の選択は面積・最大集水を見るのが
    // 主目的で、毎回パネルが画面下半分を覆うのは押し付けが強すぎる
    if (document.body.classList.contains('section-open')) void buildSectionAlongChannel(id)
    return true
  }

  // ---- 断面 ---------------------------------------------------------------
  //
  // 3D の俯瞰では起伏 0〜3 m が潰れて読めない。測線に沿って横から見る。
  // 標高は**画面に出ているのと同じタイル**から読むので、追加の通信は起きない。
  // **4 条件すべて重ねる。** 断面は線なので z-fight せず、地形メッシュと違って
  // 複数条件を同時に描ける唯一の場所である。`control`（源だけを替えた 5 m）を
  // 入れると、源の効果と解像度の効果を横から読み分けられる。
  // 代償は測線ごとにもう 1 条件ぶんタイルを引くこと（docs/todo.md 低 7 で測った）
  const SECTION_SERIES: { condition: TerrainCondition; label: string; color: string }[] = [
    { condition: 'highres', label: '0.5m', color: '#e2e8f0' },
    { condition: 'baseline', label: 'PLATEAU 5m', color: '#f7d129' },
    { condition: 'control', label: '5m 対照', color: '#fb923c' },
    { condition: 'pointcloud', label: '0.5m ＋ 点群', color: '#4ade80' },
  ]
  const secEl = document.getElementById('section')!
  const secCanvas = document.getElementById('sec-canvas') as HTMLCanvasElement
  let secSeries: SectionSeries[] = []
  let secLine: [LonLat, LonLat] | null = null
  // 既定は水位まわり。全体に合わせると市街地の 0〜3 m が背後の 40 m に潰される
  let secFit: 'water' | 'all' = 'water'
  /**
   * `buildSection` / `buildSectionAlongChannel` はどちらも折れ線の頂点ごとに
   * `sampleLine` を待つ非同期処理で、前の呼び出しの取得が終わる前に次（手動断面・
   * 別の流域のどちらでも）を始められる。素直に await するだけだと**後から解決した
   * 方が勝ち**、新しい `secLine` に古い断面が乗ってしまう。呼ぶたびに増やす通し
   * 番号で「自分が最新の呼び出しか」を確認し、追い越されていたら結果を捨てる
   * （両方の関数・水みちモードを抜けるとき・パネルを閉じるときに増やす）。
   */
  let sectionSeq = 0
  /**
   * `catalog.flow.channels` の読み込みが終わる前に流域を選んだときの「積み残し」。
   * `loadFlowChannels` はこれを見て読み込み完了後に retry するが、登録した時点の
   * `sectionSeq` から変わっていれば（手動断面・別の流域・パネルを閉じるなど、何か
   * 新しいことが起きていれば）retry しない
   */
  let pendingChannelRetry: { basinId: number; seq: number } | undefined

  const redrawSection = () => {
    if (secSeries.length === 0) return
    // いま選んでいる条件を先頭にする。塗り（連結して浸水する区間）はそれで判定する
    const cur = resolveSurface(catalog.terrain, store.state.surface)?.condition ?? 'highres'
    const ordered = [...secSeries].sort((a, b) =>
      (a.condition === cur ? -1 : 0) - (b.condition === cur ? -1 : 0))
    drawSection(secCanvas, ordered, store.state.waterLevel, secFit, store.state.floodModel)
  }

  async function buildSection(from: LonLat, to: LonLat) {
    const seq = ++sectionSeq
    secLine = [from, to]
    showSectionLine(viewer, from, to)
    secEl.style.display = 'flex'
    document.body.classList.add('section-open')
    // 注記の div をやめたので、読み込み中は canvas に出す
    drawSectionMessage(secCanvas, '読み込み中…')
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
    if (seq !== sectionSeq) return   // 待っている間に別の断面（手動・流域）が始まった
    secSeries = got.filter((x): x is SectionSeries => x !== null)
    const n = secSeries[0]?.points.length ?? 0
    const len = secSeries[0]?.points.at(-1)?.d ?? 0
    const why = catalog.default_section?.from && secLine
      && secLine[0][0] === catalog.default_section.from[0]
      ? `${catalog.default_section.why}。` : ''
    redrawSection()
  }

  /**
   * 選んだ流域の**主流路**（`catalog.flow.channels`）に沿って断面を組み立てる。
   *
   * 主流路は折れ線（`main_channel_from_outlet`、`src/iwagaki/flow.py`）なので、
   * 頂点ごとの区間を `sampleLine`（直線 2 点間）で辿り、距離を積み上げて 1 本の
   * 断面にする。**地形タイルの取得は増えない**（`buildSection` と同じ scheduler・
   * 同じキャッシュ経由）。3D 上の測線表示は既存のリボン（吐口→源流の直線）のまま
   * — 折れ線そのものの描画は別 PR（`view/map.ts` の対象）。
   *
   * 手動の 2 点断面（`sectionTool` の `onLine` → `buildSection`）はこの関数を
   * 経由しないので、既存の操作はそのまま動く（`pickCatchment` から呼ぶだけ）。
   * 古い呼び出しの結果を捨てる仕組み（`sectionSeq`）は `buildSection` と共有する。
   */
  async function buildSectionAlongChannel(basinId: number) {
    const line = flowChannels?.get(basinId)
    if (!line || line.length < 2) {
      // `catalog.flow.channels` がまだ読み込み中で使えなかった。読み込み完了後の
      // retry 用に、いまの `sectionSeq` と一緒に覚えておく（`loadFlowChannels`）
      if (!flowChannels) pendingChannelRetry = { basinId, seq: sectionSeq }
      return
    }
    pendingChannelRetry = undefined
    const seq = ++sectionSeq
    const from = line[0]
    const to = line[line.length - 1]
    secLine = [from, to]
    showSectionLine(viewer, from, to)
    secEl.style.display = 'flex'
    document.body.classList.add('section-open')
    drawSectionMessage(secCanvas, '読み込み中…')
    const zoom = catalog.terrain.highres?.max_zoom ?? 18
    const got = await Promise.all(SECTION_SERIES.map(async (s) => {
      const asset = catalog.terrain[s.condition]
      if (!asset) return null
      const points: SectionSeries['points'] = []
      let dOffset = 0
      for (let i = 0; i < line.length - 1; i++) {
        const seg = await sampleLine({
          urlTemplate: asset.url, zoom, hStep: catalog.packing.h_step,
          from: line[i], to: line[i + 1],
          fetchTile: (url) => scheduler.submit({ key: url, url, cls: 'terrainFine' }),
        })
        // 区間の継ぎ目は前の区間の終点と同じ点なので、2 本目以降は 1 点落として重複を消す
        for (let j = (i === 0 ? 0 : 1); j < seg.length; j++) {
          points.push({ ...seg[j], d: seg[j].d + dOffset })
        }
        dOffset += seg.at(-1)?.d ?? 0
      }
      return { ...s, points } as SectionSeries
    }))
    if (seq !== sectionSeq) return   // 待っている間に別の流域が選ばれた
    secSeries = got.filter((x): x is SectionSeries => x !== null)
    redrawSection()
  }

  // 断面は**起動時には出さない**（2026-09 指示）。ユーザーが「測線を引く」を
  // 押してから開く。`catalog.default_section` は残しておく（今は未使用）

  const sectionTool = new SectionTool({
    viewer,
    // 地表は z = geoid + 標高 * 鉛直強調 に描かれる。0 で交えると 2 点目が外れる
    planeZ: geoid,
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
  // ---- 地点＋徒歩圏（複数自治体からの要望 T1） -----------------------------
  //
  // 地図を 1 点クリックして中心を指定し、事前生成済みの索引（`catalog.point_buffer`）
  // から最寄りの集計を引く。**新しい外部 API・サーバ計算は足さない**
  // （`docs/todo.md` T1）ので、任意点をクリックしても新規に計算はしない。
  // パネル自体は `ui/pointBufferPanel.ts` が状態・DOM 更新を完結して持つ
  // （main.ts は「クリック -> lon/lat」と「索引の取得」の 2 つだけを担う）。
  let pointBufferIndex: PointBufferIndex | undefined
  let pbState: PointBufferPanelState = initialPointBufferState()
  const pbEl = document.getElementById('point-buffer') as HTMLElement | null
  const refreshPbPanel = () => { if (pbEl?.dataset.built === '1') updatePointBufferPanel(pbEl, pbState) }
  /** 地点を確定したクリックが、そのまま地物選択・集水域クリックへ落ちないようにする一回限りの蓋 */
  let ignoreNextClick = false

  const pointPickTool = new PointPickTool({
    viewer, planeZ: geoid,
    onPick: (p) => {
      ignoreNextClick = true
      pbState = { ...pbState, picked: p, loading: true, error: undefined, match: undefined, result: undefined }
      refreshPbPanel()
      const idxUrl = catalog.point_buffer?.url
      if (!pointBufferIndex || !idxUrl) { pbState = { ...pbState, loading: false }; refreshPbPanel(); return }
      void loadPointBufferResult(pointBufferIndex, idxUrl, p, {
        fetchJson: async (url) => JSON.parse(new TextDecoder().decode(
          await scheduler.submit({ key: `pb-${url}`, url, cls: 'prefetch' }))),
      }).then((res) => {
        pbState = { ...pbState, loading: false, ...res }
        refreshPbPanel()
      })
    },
    onState: ({ active }) => {
      pbState = { ...pbState, pickActive: active }
      refreshPbPanel()
    },
  })

  async function loadPointBufferIndex() {
    const a = catalog.point_buffer
    if (!a?.url || pointBufferIndex) return
    try {
      const b = await scheduler.submit({ key: 'point-buffer-index', url: a.url, cls: 'prefetch' })
      pointBufferIndex = parsePointBufferIndex(JSON.parse(new TextDecoder().decode(b)))
      if (pbEl && pointBufferIndex.entries.length) {
        pbEl.style.display = 'block'
        mountPointBufferPanel(pbEl, pbState, {
          onTogglePick: () => {
            if (sectionTool.isActive) sectionTool.stop()
            pointPickTool.toggle()
          },
          onSelectRadius: (r) => { pbState = { ...pbState, radius: r }; refreshPbPanel() },
        })
      }
    } catch {
      // 表示の補助。取れなくても地図は動かす
    }
  }
  void loadPointBufferIndex()

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.id === 'secbtn') {
      if (pointPickTool.isActive) pointPickTool.stop()
      sectionTool.toggle()
    }
    if (t.id === 'sec-close') {
      sectionSeq++   // 進行中の断面リクエスト（手動・流域とも）があれば無効化する
      secEl.style.display = 'none'
      document.body.classList.remove('section-open')
      secSeries = []; secLine = null
    }
    // 選択を外す。地図の強調も一緒に消える
    if (t.id === 'insp-close') {
      store.set({ selected: undefined, selectedCatchment: undefined })
      applyCatchment(undefined)
    }
    // 視点はメニューに出さない。キー 1-6 とビューキューブが担う
    //（`bindCameraKeys` と `attachViewCube`）
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
   * から、60 fps を保てる上限として 60 万点に置いた（docs/web_results.md「点群の配信」）。
   * three.js の Points に替えた影響は再計測が要る（docs/todo.md）。
   */
  const budget = (): LodBudget => {
    // **推定がまだ無いときは下限から始める。** 以前は 2 MB/s と仮定していて、
    // 起動直後の 1 回目だけ 6 MB の予算が出ていた。あとから小さく評価し直しても
    // **先に発行したぶんは戻らない**ので、細い回線では取り切れない量を掴んだままになる。
    // 足りなければ watchBudget() が 1 秒ごとに引き上げる。上げるのは安全、下げるのは遅い
    const bw = scheduler.bandwidthBps || 0
    return {
      maxPoints: PC_MAX_POINTS,
      // 帯域推定から毎回決める。遅い回線では自動的に浅い LOD で止まる。
      // ?maxbytes= で上書きできる。**キャンセル経路の検証に必要**で、
      // 絞った回線ではこの予算が pcFine の発行そのものを止めてしまい、
      // 「キャンセルすべき飛行中の要求」が作れない（docs/web_results.md「キャンセル」）。
      //
      // **係数 2 = 「点群に使ってよいのは 12 秒の窓のうち 2 秒ぶん」。**
      // 12 秒で切るのは計測の窓と同じ（docs/web_results.md）。残りは地形・建物・地物に要る。
      //
      // 以前は係数 6 / 下限 2 MB だったが、帯域推定が実効の 1/5 しか出ておらず
      // **下限がそのまま予算になっていた**（推定は net/scheduler.ts で直した）。
      // 直した推定で測り直して係数を決めた。`fast4g` の 12 秒窓で
      // **建物 20/22 は変えずに常駐点数が 56,448 -> 68,622 に増える**。
      maxBytes: PC_MAX_BYTES ?? Math.max(1e6, Math.min(20e6, bw * 2)),
      screenSpaceError: PC_SSE,
      coarseDepth: 1,
    }
  }
  /**
   * カメラを LOD が使える形（ローカル ENU メートル）に直す。
   *
   * 換算そのものは `domain/camera.ts` に置いてある（レンダラに依らないため）。
   * **旧実装は `eye: [0, 0, cameraToCenterDistance / 8]` で視点が定数**になっており、
   * LOD が働いていなかった（docs/web_results.md「キャンセル」）。three.js 移行時に
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
      // 正射では SSE が距離に依らない（pointcloud/lod.ts）
      orthographic: viewer.projectionMode === 'orthographic',
      metresPerPixel: viewer.metresPerPixel(),
      // **地面に落とした視錐台そのもの（台形）**で絞る。
      // 外接矩形は傾けた視野で実際の 2 倍近い面積を「見えている」と答える。
      // 余白 50 m はノード側の箱を広げて取る（domain/camera.ts）
      visiblePoly: visiblePolygonLocal(viewer.getGroundPolygonLngLat(), localOrigin),
      visibleMarginM: 50,
      // 多角形を読めない経路のための保険。外接矩形も一緒に渡す
      visible: visibleBoxLocal(viewer.getBoundsLngLat(), localOrigin, 50),
    }
  }

  /**
   * 直近に点群 LOD へ渡した予算。**推定が落ち着いたら評価し直す**ために覚えておく。
   *
   * `budget()` を評価していたのは点群の起動時とカメラ移動時だけで、
   * カメラを動かさなければ**起動直後の推定が最後まで残っていた**。
   * 帯域推定は最初の数リクエストでは当てにならないので、
   * 大きく変わったときだけ組み直す（`docs/web_results.md`「点群 LOD の予算」）。
   */
  let appliedMaxBytes = 0
  /** 予算がこの比率を超えて**増えた**ら LOD を組み直す */
  const BUDGET_RETRY_RATIO = 1.5
  let budgetTimer: number | undefined
  function watchBudget() {
    window.clearInterval(budgetTimer)
    budgetTimer = window.setInterval(() => {
      if (!pcb?.controller.ready || !store.state.layers.pointcloud) return
      const b = budget()
      // **増えたときだけ組み直す。** 減らす方向に組み直すと、選び直しで
      // 常駐していたノードが捨てられ、取得済みのバイトが無駄になる。
      // 実測（fast4g・12 秒窓）で、下げ直すと転送は 2.88 -> 3.29 MB に増えるのに
      // 常駐点数は 68,622 -> 56,448 に減った。**払って減らしている。**
      // 視野が変わったときは別で、カメラ移動の経路が改めて評価する
      if (b.maxBytes < appliedMaxBytes * BUDGET_RETRY_RATIO) return
      appliedMaxBytes = b.maxBytes
      void pcb.controller.update(viewState(), b).then(() => scheduler.reap())
    }, 1000)
    // 推定が落ち着いたあとまで回し続ける理由が無い。窓は計測と同じ 12 秒の倍を見る
    window.setTimeout(() => window.clearInterval(budgetTimer), 25_000)
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
        matrix, geoid, useRgb: OPT.rgb,
        coalesceGap: OPT.coalesce ? 64 * 1024 : 0,
        usefulFraction: USEFUL_FRACTION,
        onChange: () => { viewer.invalidate(); refresh() },
      })
      viewer.world.add(pcb.renderer.group)
      await pcb.controller.open()
      const b0 = budget()
      appliedMaxBytes = b0.maxBytes
      await pcb.controller.update(viewState(), b0)
      watchBudget()
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
        condition: s.floodModel === 'drainage' ? 'drainage'
          : resolveSurface(catalog.terrain, s.surface)?.condition ?? 'highres',
        roadThresholds: catalog.semantics.road_depth_classes_m,
        changedOnly: s.layers.changedOnly,
        // **判定が変わるかは選んでいる条件に対して決める。** 以前は
        // domain/flood.ts が baseline/highres を固定していたので、
        // 「判定差 0.5m↔点群」でも赤い地物は 5m↔0.5m のままだった
        pair: comparisonPair(s.surface),
        roads: s.layers.roads,
        roadColor: s.roadColor,
        model: s.floodModel,
      })
      semantics.setHighlight({ selected: s.selected?.gmlId, hovered })
    }
    // 3D Tiles は実高のままなので、地形を鉛直強調すると噛み合わない
    if (coverage) coverage.visible = s.layers.pcCoverage
    if (railway) {
      railway.object.visible = s.layers.railway
      // 標高は頂点に焼いてあるので、鉛直強調は uniform 1 個で済む
      railway.setExaggeration(s.exaggeration)
    }
    if (pourPoints) {
      pourPoints.object.visible = s.layers.pourPoints
      pourPoints.setExaggeration(s.exaggeration)
    }
    if (catchment) {
      catchment.object.visible = s.terrainPaint === 'catchment' && !!s.selectedCatchment
    }
    if (walkIsochroneLayer) walkIsochroneLayer.object.visible = s.layers.walkIsochrone
    plateau?.setVisible(s.layers.plateau && s.exaggeration === 1)
    // 浸水深で塗っているときの潮位。**uniform 1 個**で、再取得も作り直しも起きない
    plateau?.setWaterLevel(s.waterLevel)
    plateau?.setPonded(s.layers.ponded && s.floodModel === 'connected')
    plateau?.setSimple(s.floodModel === 'simple')
    pcb?.renderer.setVisible(s.layers.pointcloud)
    pcb?.renderer.setExaggeration(s.exaggeration, geoid)

    redrawSection()
    const sch = schemeFor(s.buildingColor)
    const bldgLegend = s.buildingColor === 'depth'
      ? depthLegend(assertions.values(),
          resolveSurface(catalog.terrain, s.surface)?.condition ?? 'highres',
          s.waterLevel, floorDepth, s.layers.ponded, s.floodModel)
      : sch ? legendOf(plateauValues, sch) : []
    const countCondition = resolveSurface(catalog.terrain, s.surface)?.condition ?? 'highres'
    const counts = floorCounts(assertions.values(), countCondition,
      s.waterLevel, floorDepth, s.floodModel)
    // 小地域ごとの浸水建物（要望③）。合計は counts と一致する
    const areaFlood = perAreaFloodCounts(assertions.values(), countCondition,
      s.waterLevel, floorDepth, s.floodModel)
    const playbackStats = {
      under: counts.under,
      above: counts.above,
      regulatedRoads: regulatedRoadCount(assertions.values(), s.waterLevel),
    }
    renderControls(document.getElementById('controls')!, store, catalog, bldgLegend,
      { index: areaIndex, current: area }, [...tideCurves.values()], playbackStats,
      areaFlood, walkIsochroneLayer?.info ?? null)
    const attrPanel = document.getElementById('panel-attr')
    if (attrPanel) renderInspector(attrPanel, store, catalog)
    viewer.invalidate()
  }

  // ---- カメラ連動 --------------------------------------------------------
  // カメラは 60ms デバウンス。毎フレーム epoch を進めるとキャンセル暴走する
  // （docs/web_design.md「キャンセルの規則」）
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
        // （docs/web_results.md「キャンセル」）。
        const b = budget()
        appliedMaxBytes = b.maxBytes
        void pcb.controller.update(viewState(), b).then(() => scheduler.reap())
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
    if (sectionTool.isActive || pointPickTool.isActive) return
    // **地点を確定したその同じクリックを、続けて地物選択に使わない。**
    // `PointPickTool` は 1 クリックで完了するので、`click` が届く時点では
    // 既に `isActive` が false に戻っている（`sectionTool` の 2 点目と同じ構造）
    if (ignoreNextClick) { ignoreNextClick = false; return }
    // 「水みち」モードのクリックは集水域の抽出に寄せる（`catalog.flow.basins` が
    // 当たれば）。当たらなかった場合だけ地物選択にフォールバックする
    if (store.state.terrainPaint === 'catchment' && pickCatchment(e.clientX, e.clientY)) {
      return
    }
    if (!semantics || !store.state.layers.semantics) return
    const r = viewer.canvas.getBoundingClientRect()
    const ndc = new Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    )
    const hit = semantics.pick(ndc, viewer.camera)
    store.set({ selected: hit })
    // 地物を選んだら「属性情報」タブへ切り替えて中身を見せる
    if (hit) document.getElementById('tab-attr')?.click()
  })

  /**
   * 点群の有効範囲は「点群が関わる条件を選んだとき」に出す。
   *
   * **毎回の refresh で計算してはいけない。** `perf/waterlevel.mjs` は
   * `setLayer('pcCoverage', false)` で切ってから計測しているので、
   * 毎回上書きすると計測条件が勝手に戻る。**条件が変わった瞬間だけ**既定値を入れて、
   * そのあとの setLayer は生かす（UI から変えられない ≠ 値が固定）。
   */
  let pcRelevant: boolean | undefined
  function syncCoverageDefault() {
    const pair = comparisonPair(store.state.surface)
    const rel = pair.to === 'pointcloud' || pair.from === 'pointcloud'
    if (rel === pcRelevant) return
    pcRelevant = rel
    if (store.state.layers.pcCoverage !== rel) store.setLayer({ pcCoverage: rel })
  }

  // 地物のホバー。**カーソルが変わらないと「押せる」ことが分からない。**
  // pointermove ごとに raycast すると jank.mjs が測るフレーム時間に乗るので、
  // rAF で 1 フレーム 1 回に間引き、ポインタが止まっている間は走らせない
  let hoverPending: { x: number; y: number } | null = null
  let hoverQueued = false
  const runHover = () => {
    hoverQueued = false
    const pt = hoverPending
    hoverPending = null
    if (!pt || !semantics || !store.state.layers.semantics
        || sectionTool.isActive || pointPickTool.isActive) return
    const r = viewer.canvas.getBoundingClientRect()
    const ndc = new Vector2(
      ((pt.x - r.left) / r.width) * 2 - 1,
      -((pt.y - r.top) / r.height) * 2 + 1,
    )
    const hit = semantics.pick(ndc, viewer.camera)
    const id = hit?.gmlId
    if (id === hovered) return
    hovered = id
    viewer.canvas.style.cursor = id ? 'pointer' : ''
    semantics.setHighlight({ selected: store.state.selected?.gmlId, hovered })
  }
  viewer.canvas.addEventListener('pointermove', (e) => {
    hoverPending = { x: e.clientX, y: e.clientY }
    if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(runHover) }
  })
  viewer.canvas.addEventListener('pointerleave', () => {
    hoverPending = null
    if (hovered === undefined) return
    hovered = undefined
    viewer.canvas.style.cursor = ''
    semantics?.setHighlight({ selected: store.state.selected?.gmlId, hovered })
  })

  let catchmentMode = false
  store.subscribe((s) => {
    if (s.layers.pointcloud && !pcStarted) void startPointCloud()
    if (s.layers.plateau) void ensurePlateau()
    syncCoverageDefault()
    // 徒歩圏レイヤを ON にした・起点を替えたときだけ引く（既定は OFF、`state.ts`）
    if (s.layers.walkIsochrone) void ensureWalkIsochrone()
    // 「水みち」モードに入ったら流域ポリゴンを引く。外れたら選択と面を片づける
    const wantCatchment = s.terrainPaint === 'catchment'
    if (wantCatchment !== catchmentMode) {
      catchmentMode = wantCatchment
      if (wantCatchment) {
        void loadFlowBasins()
        void loadFlowChannels()
        applyCatchment(s.selectedCatchment?.basinId)
      } else {
        sectionSeq++   // 進行中の流域の主流路リクエストがあれば無効化する
        applyCatchment(undefined)
        if (s.selectedCatchment) store.set({ selectedCatchment: undefined })
      }
    }
    refresh()
  })

  buildTerrain()
  refresh()

  // ---- 計測パネル --------------------------------------------------------
  // PerfRecorder は常時走らせるが、パネルは既定で隠す。内訳を読むのは開発者だけで、
  // 浸水を見に来た人には要らない。?perf=1 か P キーで出す
  // （docs/web_design.md「FPS は指標にしない」）
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
    setRoadColor: (v: RoadColorMode) => store.set({ roadColor: v }),
    setPerfVisible,
  }
}

void boot()
