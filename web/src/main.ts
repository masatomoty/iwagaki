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
import type { Catalog } from './domain/catalog'
import { parseAreaIndex, pickArea, SINGLE_AREA } from './domain/areas'
import { comparisonPair, resolveSurface } from './domain/terrain'
import type { BuildingColorMode, FeatureAssertion, RoadColorMode, SurfaceMode,
              TerrainCondition } from './domain/types'
import { Scheduler } from './net/scheduler'
import { PerfRecorder } from './perf/recorder'
import type { PcBundle } from './pointcloud/lazy'
import type { LodBudget, ViewState } from './pointcloud/types'
import { initialState, Store } from './state'
import { FLOOD_MODE } from './three/floodMaterial'
import { createLocalFrame, worldToLngLat } from './three/mercator'
import type { PlateauTiles } from './three/plateauTiles'
// **地物メッシュは遅延しない。** 1.8 kB (br) を後回しにするために 1 往復払っていた。
// 高 RTT では往復のほうが 2 桁高い（fatpipe-highrtt 405 ms / slow-highrtt 568 ms、
// 対して JSON 解釈は 3〜7 ms・三角形化は 7〜9 ms。docs/web_results.md
// 「objects.geojson のパースコストは 3 ms、遅延ロードの往復が 568 ms」）
import { createRailwayLine, type RailwayLine } from './three/railwayLine'
import { createCoverageOutline, SemanticsMesh } from './three/semanticsMesh'
import { TerrainTiles } from './three/terrainTiles'
import { FOV_Y_DEG, type Viewer } from './three/viewer'
import { EXAGGERATIONS, renderControls } from './ui/controls'
import { renderInspector } from './ui/inspector'
import { renderPerf } from './ui/perfPanel'
import { drawSection, drawSectionMessage, type SectionSeries } from './ui/section'
import {
  createColorScheme, depthLegend, FLOOR_ABOVE_DEPTH_M, legendOf, type ColorScheme,
} from './view/buildingColor'
import { applyPreset, attachViewCube, bindCameraKeys, createViewer, initialZoom,
         showSectionLine } from './view/map'
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
  if (OPT.ortho) viewer.setProjection('orthographic')
  attachViewCube(viewer)

  // インスペクタはビューキューブの下に置く。**高さを決め打ちにしない。**
  // ViewCube には size: 128 を渡しているのに host の矩形は 152x158 px で、
  // CSS の top: 146px では 20 px 重なっていた（実測）。キューブから測って置く
  const placeInspector = () => {
    const cube = document.getElementById('viewcube')?.getBoundingClientRect()
    const el = document.getElementById('inspector')
    if (el) el.style.top = `${Math.round((cube?.bottom ?? 166) + 12)}px`
  }
  placeInspector()
  window.addEventListener('resize', placeInspector)

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
      simple: s.floodModel === 'simple' && s.surface !== 'diff_drainage',
      // 地形の面を地盤高のグラデーションで塗るか（同 TerrainPaint）
      elevPaint: s.terrainPaint === 'elevation',
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
    // 粗の上限は範囲の広さで決まる（coarseMaxZoom）。細はその 1 段上から
    const coarseMax = coarseMaxZoom(catalog)
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
      minZoom: coarseMax + 1, maxZoom: geomAsset.max_zoom,
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
    const cond = resolveSurface(catalog.terrain, store.state.surface)?.condition ?? 'highres'
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

  const redrawSection = () => {
    if (secSeries.length === 0) return
    // いま選んでいる条件を先頭にする。塗り（連結して浸水する区間）はそれで判定する
    const cur = resolveSurface(catalog.terrain, store.state.surface)?.condition ?? 'highres'
    const ordered = [...secSeries].sort((a, b) =>
      (a.condition === cur ? -1 : 0) - (b.condition === cur ? -1 : 0))
    drawSection(secCanvas, ordered, store.state.waterLevel, secFit, store.state.floodModel)
  }

  async function buildSection(from: LonLat, to: LonLat) {
    secLine = [from, to]
    showSectionLine(viewer, from, to)
    secEl.style.display = 'block'
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
    secSeries = got.filter((x): x is SectionSeries => x !== null)
    const n = secSeries[0]?.points.length ?? 0
    const len = secSeries[0]?.points.at(-1)?.d ?? 0
    const why = catalog.default_section?.from && secLine
      && secLine[0][0] === catalog.default_section.from[0]
      ? `${catalog.default_section.why}。` : ''
    redrawSection()
  }

  // 起動時に既定の断面を出す。**測線を引かせる前に、一番読む価値のある断面を見せる。**
  // 天端を横切る線で、3D では潰れて見えない 0〜3 m の起伏がここで読める
  // **`from` / `to` の有無まで見る。** 以前は `catalog.default_section` の
  // truthy だけを見ていて、`{}`（= 天端の解析を回していない範囲）で
  // `ds.from[0]` を読んで落ちていた
  const ds = catalog.default_section
  if (ds?.from && ds?.to) void buildSection(ds.from as LonLat, ds.to as LonLat)

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
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.id === 'secbtn') sectionTool.toggle()
    if (t.id === 'sec-close') {
      secEl.style.display = 'none'
      document.body.classList.remove('section-open')
      secSeries = []; secLine = null
    }
    // 選択を外す。地図の強調も一緒に消える
    if (t.id === 'insp-close') store.set({ selected: undefined })
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
        condition: resolveSurface(catalog.terrain, s.surface)?.condition ?? 'highres',
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
    renderControls(document.getElementById('controls')!, store, catalog, bldgLegend,
      { index: areaIndex, current: area })
    renderInspector(document.getElementById('inspector')!, store, catalog)
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
    if (!semantics || !store.state.layers.semantics || sectionTool.isActive) return
    const r = viewer.canvas.getBoundingClientRect()
    const ndc = new Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    )
    store.set({ selected: semantics.pick(ndc, viewer.camera) })
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
    if (!pt || !semantics || !store.state.layers.semantics || sectionTool.isActive) return
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

  store.subscribe((s) => {
    if (s.layers.pointcloud && !pcStarted) void startPointCloud()
    if (s.layers.plateau) void ensurePlateau()
    syncCoverageDefault()
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
