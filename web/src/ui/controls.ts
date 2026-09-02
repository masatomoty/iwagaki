// 操作パネル。
//
// **メニューに出すのは「操作すると状態が変わるもの」だけにしてある。**
// 以前は 8 つの fieldset がフラットに並んでいて、入力（地形条件・水位）と
// 見せ方と道具と出典が同じ階層にあった。268 px × 56 % の枠では、主張の
// 2 変数（地形条件と水位 H）を同時に見ることすらできなかった。
//
// 分け方は 3 つ。
//
// | 種類 | 置き場所 |
// |---|---|
// | 変数（操作すると状態が変わる） | ここ。頭は固定、それ以外はスクロール |
// | 出力（変数から計算されて出る） | 変数の直下（凡例）か専用パネル（内訳・断面・計測） |
// | 定数（データに付いてくる事実） | 「このデータについて」に 1 か所。出典だけ画面下辺 |
//
// **状態そのものは削っていない。** `web/perf` の計測ハーネス 28 本が
// `setLayer('flood'|'ground'|'semantics'|'pcCoverage')` や `setBuildingColor('class')` を
// 叩いていて、`docs/web_results.md` の実測値はそこから出ている。
// メニューに出さないだけで、`__iwagaki` からは全部触れる。

import type { Area, AreaIndex } from '../domain/areas'
import type { Catalog } from '../domain/catalog'
import type { AreaFloodRow } from '../domain/flood'
import type { TideForecastState } from '../domain/tideForecast'
import type { TideSeries } from '../domain/tideSeries'
import type { WalkIsochroneInfo } from '../domain/walkIsochrone'
import { comparisonPair } from '../domain/terrain'
import type { BuildingColorMode, FloodModel, RoadColorMode, SurfaceMode,
              TerrainCondition, TerrainPaint } from '../domain/types'
import { nudgeWaterLevel, waterLevelRange } from '../domain/waterLevel'
import type { Store } from '../state'
import {
  BUILDING_COLOR_MODES, UNKNOWN_HEX, UNKNOWN_LABEL, type LegendEntry,
} from '../view/buildingColor'
import { ATTR_EMPTY_HINT } from './inspector'
import { getTidePlaybackHandle, mountTidePlayback, tidePlaybackHtml, updateTidePlayback,
         type PlaybackStats } from './tidePlayback'

/** `[` `]` キーが回る段。UI には出さない（`__iwagaki` かキー操作のみ） */
export const EXAGGERATIONS = [1, 2, 5, 10, 20] as const

/**
 * `data-tip="${hint}"` を innerHTML 文字列に埋めるとき用。現状の hint 群
 * （CONDITIONS / FLOOD_MODELS など）に引用符は無いが、将来 `"` が入っても
 * 属性が壊れないように通しておく（`ui/tooltip.ts` は `data-tip` を読むだけ）。
 */
const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * メニュー全体の説明ツールチップ。**`<select>`（現在値）ではなくメニュー名に張る。**
 * 選択肢を変えないと中身が分からないのを避けたいので、選べるもの全部を 1 行ずつ挙げる
 * （`ui/tooltip.ts` の `#ui-tooltip` は `white-space: pre-line` で改行を活かす）。
 */
const condMenuTip = (catalog: Catalog): string =>
  '地形の標高データ。選ぶと地図全体がその測り方に変わる。\n'
  + conditionsOf(catalog).map((c) => `${c.label}＝${c.hint}`).join('\n')

const areaMenuTip = (a: AreaChoice): string =>
  '舞鶴の対象範囲。切り替えるとページを読み直す。\n'
  + a.index.areas.map((x) =>
    `${x.label}＝${x.areaHa} ha${x.hasPointcloud ? '・地上点群あり' : '・0.5m DEM のみ'}`).join('\n')

const ROAD_COLOR_MENU_TIP =
  '道路レイヤの塗り分け。\n一律＝どこが道路かだけ（既定）\n'
  + '通行支障＝浸水深 0.1 / 0.3 / 0.5 m で 4 段\n交通規制＝徐行 / 通行規制検討 / 通行止め相当'

const BUILDING_COLOR_MENU_TIP =
  '建物レイヤの塗り分け。\n用途＝11 種の用途色\n'
  + '浸水深（床下・床上）＝地盤面から 0.50 m を境に（既定）'

const WATER_LEVEL_TIP =
  'T.P.（東京湾平均海面）基準の潮位。スライダ・−／＋ のほか、キーボードの ← → は '
  + '0.01 m 刻み、Shift ＋ ← → は 0.05 m 刻み。'
  + '動かしてもサーバ往復やタイルの再取得は起きない'

/**
 * 建物の塗り分けでメニューに出すもの。`class`（普通建物・堅ろう建物）は
 * 浸水の話に効かないので出さない（`__iwagaki.setBuildingColor('class')` で触れる。
 * `perf/bldgcolor.mjs` は全モードを回すので値そのものは残す）。
 */
const MENU_BUILDING_COLORS = BUILDING_COLOR_MODES.filter((m) => m.id !== 'class')

/**
 * 道路の塗り分け。**既定は「一律」。**
 *
 * 通行支障の色（クリーム〜琥珀〜赤）は建物の浸水深（灰/黄/赤）と色域が重なる。
 * 両方を同時に既定にすると町が一様な黄色の塊になり、**道路と建物の区別が
 * つかなくなった**（`src/state.ts` の roadColor）。見たい人だけが切り替える。
 */
const MENU_ROAD_COLORS: { id: RoadColorMode; label: string }[] = [
  { id: 'plain', label: '一律' },
  { id: 'trafficability', label: '通行支障（0.1 / 0.3 / 0.5 m）' },
  { id: 'regulation', label: '交通規制（徐行 / 検討 / 通行止め）' },
]

/**
 * 地形条件は 4 つ。**同時に 2 枚は描けない**（同じ場所の標高を 4 通りに測ったもので、
 * メッシュが数十 cm 差で交差する。`main.ts` が粗メッシュと細メッシュで
 * 同じ問題を避けているのと同じ理由）ので、チェックボックスではなく 1 つ選ぶ。
 *
 * 並びは作られ方の順。源を替える → 解像度を上げる → 地上観測を足す。
 * `5m 対照` は「4 つ目の選択肢」ではなく **源だけを替えた地点**なので、
 * `PLATEAU 5m` の隣に置かないとその意味が読めない。
 * ボタンを 4 つ並べるのはやめて `<select>` にしたが、**この順序は option の
 * 並びとして残る**（開けば梯子が見える）。
 */
const CONDITIONS: { id: TerrainCondition; label: string; hint: string }[] = [
  { id: 'baseline', label: 'PLATEAU 5m',
    hint: 'PLATEAU 地形モデル LOD1 TIN（5 m 格子）。ここが出発点' },
  { id: 'control', label: '5m 対照',
    hint: '0.5m DEM を 5 m に平均集約。源だけを替えて解像度は上げていない対照' },
  { id: 'highres', label: '0.5m',
    hint: '京都府 数値標高モデル 0.5 m（航空レーザ 2019-2023）' },
  { id: 'pointcloud', label: '0.5m ＋ 点群',
    hint: '0.5m DEM に地上点群（バックパック SLAM 2026-07）の地表面を融合' },
]

/**
 * 条件を選んだときに `判定差` が出す差分。
 *
 * - `control`    源だけを替えた差（`diff_src`）
 * - `highres`    源 ＋ 解像度の合計（`diff`）。**README と docs/results.md の見出しの図**
 * - `pointcloud` 地上観測が足した分（`diff_pc`）
 *
 * `diff_res`（解像度だけ）も焼いてあるが、ここには載せていない。`highres` に
 * 割り当てると「0.5m の判定差」の意味が合計 12.7 % から解像度だけの 3.4 % に
 * 変わり、公表済みの見出しと食い違うため。`setSurface('diff_res')` で触れる。
 */
const DIFF_OF: Partial<Record<TerrainCondition, SurfaceMode>> = {
  control: 'diff_src',
  highres: 'diff',
  pointcloud: 'diff_pc',
}

/**
 * **その範囲が配信している条件だけを出す。** 面的表示用の 2 範囲は
 * `baseline` と `highres` しか焼いていない（点群が無く、`control` はタイルを
 * 焼いていない）。出してしまうと選んでもタイルが 404 になる。
 */
function conditionsOf(catalog: Catalog) {
  // drainage は地形データの選択肢ではなく、浸水判定モデルとして下段に出す。
  const have = CONDITIONS.filter((c) => c.id !== 'drainage' && catalog.terrain[c.id])
  return have.length ? have : CONDITIONS
}

/**
 * **浸水の決め方。** 単純 → 連結 → 仮想排水路の 3 択で、**既定は連結**。
 *
 * `simple`（潮位 − 地盤高）は舞鶴市の回答（2026-08）
 * > 現場にいる経験則として、市内全域的に、排水路などを通じて、潮位よりも
 * > 地盤高が低い箇所は、その差だけ浸水している状況です。
 * > 現時点では、単純に「潮位ー地盤高＝浸水深」として可視化することで問題ない
 * に対応する比較用のトグル。連結モデル（`h_conn`）を既定に据えたまま、
 * 経験則側の見え方も切り替えられるようにしてある。**排水路の吐口高・
 * フラップゲートの有無が手に入ったら、精緻化するのは仮想排水路側**である。
 */
const FLOOD_MODELS: { id: FloodModel; label: string; hint: string }[] = [
  { id: 'simple', label: '潮位-地盤高',
    hint: '標高が潮位より低い場所を、その差だけ浸水とみなす。海からの連結性を問わない。舞鶴市の経験則に対応' },
  { id: 'connected', label: '海からつながる',
    hint: 'h_conn ≤ 潮位' },
  { id: 'drainage', label: '仮想排水路',
    hint: '仮想吐口の陸側端から逆流する h_conn を使う' },
]

/** 地形の面を何で塗るか。地盤高は「浸水深を見せる前に」という市の提案（2026-08） */
const TERRAIN_PAINTS: { id: TerrainPaint; label: string; hint: string }[] = [
  { id: 'flood', label: '浸水深', hint: '潮位に対する浸水の深さ（と、判定差）' },
  { id: 'elevation', label: '地盤高',
    hint: 'どこの地盤が低いかを 0〜3 m のグラデーションで塗る。'
      + '浸水の色は出さず、いまの潮位の等高線だけを白い線で重ねる' },
  { id: 'catchment', label: '水みち',
    hint: '一様降雨で地表流がどこに集まるか（集水セル数の log）。'
      + '潮位は使わない。地形のみで、浸透・管路・実際の降雨分布は含まない。'
      + '窪地は水色で出る。地図をクリックするとその地点の集水域を面で出す（FARR 取り込み）' },
]

/**
 * その範囲に無いレイヤのチェックは出さない（押しても何も出ないので）。
 * 点群は吉原だけ、線路は逆に**吉原だけ無い**（100 ha に線路が掛からない）。
 */
function layersOf(catalog: Catalog) {
  return LAYERS.filter((l) =>
    (l.key !== 'pointcloud' || !!catalog.pointcloud?.url)
    && (l.key !== 'railway' || !!catalog.railway?.url)
    && (l.key !== 'pourPoints' || !!catalog.flow?.pits?.url)
    && (l.key !== 'walkIsochrone' || !!catalog.walk_isochrones?.length))
}

const surfaceCondition = (s: SurfaceMode): TerrainCondition => comparisonPair(s).to
const isDiff = (s: SurfaceMode) =>
  s === 'diff' || s === 'diff_src' || s === 'diff_res' || s === 'diff_pc'
  || s === 'diff_drainage'

/**
 * **仮定の段階は「2 条件の差」ではない。** 同じ地形の上で、その土地が浸かると
 * 言うのにどこまで仮定を置いているかを見ている（`domain/types.ts` の
 * `ASSUMPTION_STEPS`）。凡例も見出しも差分とは別に書く
 */
const isAssumption = (s: SurfaceMode) => s === 'assumption'

/**
 * **仮想排水路が絵に効いているときは必ず出す注意書き。**
 * 吐口の位置・敷高・逆流防止施設の有無は市も把握できておらず
 * （`docs/todo.md` 中 3）、こちらが置いた仮定である。
 * 仕様（`docs/flood_simulation_spec.md` §1）が画面表示を必須にしている
 */
const SYNTHETIC_NOTE =
  '<div class="sub">仮想排水路は実在施設ではない。吐口の位置・敷高・'
  + '逆流防止施設の有無はこちらが置いた仮定</div>'

/**
 * メニューに出すレイヤ。`flood` / `ground` / `semantics` / `pcCoverage` は出さない。
 *
 * `waterSurface` と `roads` は外部からの要望で足した（2026-08）。
 * どちらも**配信物が増えないので既定 ON にできる**（水面は同じタイルを 2 回描くだけ、
 * 道路は前から objects.geojson に入っていて描いてもいた）。
 */
type LayerKey = 'waterSurface' | 'ponded' | 'pourPoints' | 'roads' | 'railway'
  | 'plateau' | 'pointcloud' | 'walkIsochrone'
const LAYERS: { key: LayerKey; label: string; hint?: string }[] = [
  { key: 'waterSurface', label: '水面',
    hint: '潮位の高さに水平な水面を張る。切ると浸水域を地面の色だけで見る' },
  { key: 'ponded', label: '窪地',
    hint: '標高は潮位より低いが、地表面をたどると海に出ない土地。'
      + '排水路の吐口にフラップゲートが無いので、管路を逆流して浸水しうる。'
      + '逆流はモデルに含まないので、印だけを重ねている' },
  { key: 'pourPoints', label: '窪地の越流点',
    hint: 'DEM だけで決まる、海に通じない窪地とその鞍部（越流点）。'
      + '潮位を使わない原理版で、上の「窪地」（潮位依存の印）とは別物。'
      + '「地形の色」を水みちにすると窪地が水色で出る。面積の大きい順に上位のみ' },
  { key: 'roads', label: '道路（PLATEAU）',
    hint: '浸かると通行支障クラスで塗る。閾値は解析側の 0.1 / 0.3 / 0.5 m' },
  { key: 'railway', label: 'JR 線路',
    hint: 'PLATEAU に鉄道は入っていないので国土数値情報（鉄道データ）から取った。'
      + '市が「表示範囲の東側をここまで」と指した基準線そのもの' },
  { key: 'plateau', label: 'PLATEAU 建物' },
  { key: 'pointcloud', label: '点群' },
  { key: 'walkIsochrone', label: '徒歩圏（等時線）',
    hint: '複数自治体からの要望 T2。事前生成済みの起点から、道路ネットワーク上の'
      + '到達圏と同じ距離の単純バッファを併置する。公式歩行者網ではない' },
]

/**
 * 凡例は 1 か所にまとめる。**画面に出ている色は 1 セットなのに、
 * 以前は読む場所が 3 つあった**（Legend / 建物の色 / 地形の凡例に混ざった赤）。
 */
/**
 * 徒歩圏（T2）の注記行。**面積・比・「公式歩行者網ではない」の実測値**は
 * 読み込んだ GeoJSON からしか分からないので、`main.ts` が読んで渡す
 * （`walkIsochroneLayer.info`）。まだ読み込み中なら省く。
 */
function walkIsochroneLegend(info: WalkIsochroneInfo | null): string {
  if (!info) return ''
  const ratio = info.networkOverBufferRatio
  return '<div><i style="background:#4d9e73"></i>徒歩圏（ネットワーク） &nbsp;'
    + '<i style="background:#8a6a3d"></i>同距離の単純バッファ（縁のみ）'
    + `<span class="sub"> ${info.minutes} 分・分速 ${info.walkSpeedMPerMin} m`
    + (ratio !== undefined ? `・面積比 ${ratio.toFixed(2)}` : '') + '</span></div>'
    + `<div class="sub">${info.notOfficialNote}</div>`
}

/**
 * 道路の凡例。**塗り分けモードで変わる**（`three/semanticsMesh.ts` の
 * ROAD_PLAIN / ROAD_WET と同じ色）。地形の色が浸水深でも地盤高でも水みちでも、
 * 道路レイヤが出ていれば同じ形で添える（以前は地盤高・浸水系にしか無かった）。
 */
function roadsLegend(s: Store['state']): string {
  if (!s.layers.roads) return ''
  if (s.roadColor === 'trafficability') {
    return '<div><i style="background:#ffe699"></i>道路 &nbsp;'
      + ['#a1cce6', '#f5c740', '#e68529', '#943d30']
        .map((h) => `<i style="background:${h}"></i>`).join('')
      + '<span class="sub"> 通行支障 0.1 / 0.3 / 0.5 m</span></div>'
  }
  if (s.roadColor === 'regulation') {
    return '<div><i style="background:#c9a3e0"></i>徐行</div>'
      + '<div><i style="background:#995cd6"></i>通行規制検討</div>'
      + '<div><i style="background:#5b2a86"></i>通行止め相当</div>'
  }
  return '<div><i style="background:#f0f5fa"></i>道路（PLATEAU）</div>'
}

function legendHtml(
  s: Store['state'], buildingLegend: LegendEntry[], walkIsochroneInfo: WalkIsochroneInfo | null,
): string {
  const pair = comparisonPair(s.surface)
  const label: Record<TerrainCondition, string> =
    Object.fromEntries(CONDITIONS.map((c) => [c.id, c.label])) as never
  const rows: string[] = []

  // **地盤高で塗っているときは浸水の凡例を出さない。** 画面に浸水の色が
  // 1 つも無いのに凡例だけ残ると、出ていない色を探すことになる
  if (s.terrainPaint === 'elevation') {
    rows.push('<div><i style="width:36px;background:'
      + 'linear-gradient(90deg,#2f6fa3,#4da66f 33%,#f0d34f 66%,#a86632)'
      + '"></i>地盤高<span class="sub"> 0 m 〜 3 m ／ それ以上は灰</span></div>',
      '<div><i style="background:#ffffff"></i>いまの潮位の等高線'
      + `<span class="sub"> ${s.waterLevel.toFixed(2)} m T.P.</span></div>`)
    // 浸水を読む画面ではないので、以降の浸水系の行は足さずに返す
    rows.push(roadsLegend(s))
    return `<div class="legend">${rows.join('')}</div>`
  }

  // **水みちも浸水の凡例を出さない**（潮位を使わない面。地盤高モードと同じ）。
  if (s.terrainPaint === 'catchment') {
    rows.push('<div><i style="width:36px;background:'
      + 'linear-gradient(90deg,#d9dbd1,#61b0bd 40%,#174a87 75%,#081538)'
      + '"></i>地表流の集中</div>',
      '<div><i style="background:#70bfcc"></i>窪地</div>')
    if (s.layers.pourPoints && s.catalog.flow?.pits) {
      rows.push('<div><i style="background:#70bfcc"></i>▽ 越流点</div>')
    }
    if (s.catalog.flow?.basins) {
      rows.push('<div><i style="background:#5ab7c9"></i>集水域</div>')
    }
    rows.push(roadsLegend(s))
    return `<div class="legend">${rows.join('')}</div>`
  }

  if (isAssumption(s.surface)) {
    rows.push(
      '<div><i style="background:#295794"></i>仮定なし'
      + '<span class="sub"> 海から地表面をたどって届く</span></div>',
      '<div><i style="background:#4d8fc2"></i>吐口があれば'
      + '<span class="sub"> 仮想排水路を逆流して届く</span></div>',
      '<div><i style="background:#8cbddb"></i>経路を示せない'
      + '<span class="sub"> 潮位以下だが到達経路が無い</span></div>',
      '<div class="sub">下の 2 段は斜線。3 段は入れ子（連結 ⊆ 仮想排水 ⊆ 潮位以下）で、'
      + '仮定の深さであって浸水確率ではない</div>',
      SYNTHETIC_NOTE)
  } else if (isDiff(s.surface)) {
    if (s.surface === 'diff_drainage') {
      rows.push(
        '<div><i style="background:#ed3830"></i>仮想排水モデルでのみ到達</div>',
        '<div><i style="background:#f7d129"></i>地表連結モデルでのみ到達</div>',
        '<div><i style="background:#2a5794"></i>両モデルで到達</div>',
        '<div class="sub">地形タイルの差分のみ。建物・道路の判定差は未配信</div>',
        SYNTHETIC_NOTE)
    } else {
      rows.push(
        `<div><i style="background:#ed3830"></i>${label[pair.to]} でのみ浸水</div>`,
        `<div><i style="background:#f7d129"></i>${label[pair.from]} でのみ浸水</div>`,
        `<div><i style="background:#2a5794"></i>どちらも浸水</div>`)
    }
  } else {
    rows.push(
      '<div><i style="background:#6bccf2"></i>浅い</div>',
      '<div><i style="background:#0d2985"></i>深い<span class="sub"> 0〜3 m</span></div>')
  }
  // **水深が分からない水域は別に出す。** 航空レーザは水面から反射が返らないので
  // 港と湾は 0.5m DEM では nodata である。水面は張れる（連結しているかは
  // h_conn が知っている）が、深さは知らない。ランプの色で塗ると嘘になる
  if (s.layers.waterSurface) {
    rows.push('<div><i style="background:#174c8c"></i>水深不明の水域</div>')
  }
  // **窪地は浸水域と並べない。** 根拠が違う（浸水 = 海から連結して到達する /
  // 窪地 = 標高が潮位以下なだけ）ので、色も斜線にして 1 段弱く出している。
  // 差分モードでは出さない（2 条件の h_conn を比べる画面で、
  // どちらの条件の窪地なのかを色 1 つで表せない）
  if (s.layers.ponded && s.floodModel === 'connected'
      && !isDiff(s.surface) && !isAssumption(s.surface)) {
    rows.push('<div><i style="background:'
      + 'repeating-linear-gradient(135deg,#70bfcc 0 2px,#4c6068 2px 5px)"></i>窪地</div>')
  }
  // 越流点マーカー。潮位非依存の別レイヤなので、どの塗りモードでも出る
  if (s.layers.pourPoints && s.catalog.flow?.pits) {
    rows.push('<div><i style="background:#70bfcc"></i>▽ 窪地の越流点</div>')
  }
  // 判定が変わる地物は、比較のペアが決まっているときだけ出る
  if (pair.from !== pair.to) {
    rows.push(`<div><i style="background:#f24434"></i>判定が変わる地物</div>`)
  }
  rows.push(roadsLegend(s))
  // 線路。**catalog に無い範囲（吉原 100 ha）では出さない**
  if (s.layers.railway && s.catalog.railway) {
    // 濃灰の縁 ＋ 濃灰/生成りの刻み（`three/railwayLine.ts` と同じ濃さ）。
    // 路線名は凡例に出すと折り返すので title だけ（事業者名の括弧は落とす）
    const lines = s.catalog.railway.lines.map((n) => n.replace(/（[^（）]*）\s*$/, '')).join(' / ')
    rows.push('<div title="JR 線路（' + lines + '）"><i style="background:'
      + 'repeating-linear-gradient(90deg,#242830 0 2px,#e0e3e9 2px 5px);'
      + 'box-shadow:inset 0 0 0 1px #242830"></i>JR 線路</div>')
  }
  // 徒歩圏（T2）。潮位非依存の別レイヤなので、浸水系の色とは独立に出す
  if (s.layers.walkIsochrone && s.catalog.walk_isochrones?.length) {
    rows.push(walkIsochroneLegend(walkIsochroneInfo))
  }
  return `<div class="legend">${rows.join('')}</div>`
}

/**
 * 建物の用途の凡例。**頭ではなく「用途で塗る」の直下に置く。**
 * 凡例は独立した節ではなく、それを出している変数の子である。
 * 頭に混ぜると 11 種で頭が倍の高さになり、肝心の入力が押し出される。
 */
function buildingLegendHtml(s: Store['state'], entries: LegendEntry[]): string {
  if (s.buildingColor === 'none' || s.exaggeration > 1
      || !s.layers.plateau || entries.length === 0) return ''
  // 浸水深モードは**属性ではなく潮位から決まる**（床上 = 地盤面から 0.50 m 以上、
  // PLATEAU LOD1 は床高を持たないので「地盤から」の意味）。詳細は docs 側に置く
  if (s.buildingColor === 'depth') {
    return `<div class="legend">${entries.map((e) =>
      `<div><i style="background:${e.hex}"></i>${e.label}<span class="sub"> ${e.count} 棟</span></div>`)
      .join('')}</div>`
  }
  const top = entries.slice(0, 4)
  const rest = entries.length - top.length
  return `<div class="legend">${top.map((e) =>
    `<div><i style="background:${e.hex}"></i>${e.label}<span class="sub"> ${e.count}</span></div>`).join('')}
    ${rest > 0 ? `<div class="sub">ほか ${rest} 種 ＋ ${UNKNOWN_LABEL}`
      + `<i style="background:${UNKNOWN_HEX};margin-left:5px"></i></div>` : ''}</div>`
}

/**
 * **地域別の浸水建物**（上田氏の要望③）。潮位再生パネルのすぐ下に置く。
 *
 * 表を主にする。**主眼が地域比較**なので、まずランキング。現在の水位・モデルで
 * `domain/flood.ts::perAreaFloodCounts` が数えた行をそのまま出す
 * （潮位を動かしても再計算はクライアント内で、サーバ往復なし）。
 * 上位 `AREA_TABLE_TOP` 件 ＋「ほか N 地域」＋「(小地域外)」＋「合計」。
 * 合計は頭の全体棟数（`floorCounts`）と一致する。
 */
const AREA_TABLE_TOP = 10

function areaFloodHtml(rows: AreaFloodRow[]): string {
  if (rows.length === 0) return ''
  const outside = rows.find((r) => r.areaCode === undefined && r.total > 0)
  const flooded = rows.filter((r) => r.areaCode !== undefined && r.flooded > 0)
  const shown = flooded.slice(0, AREA_TABLE_TOP)
  const restAreas = flooded.length - shown.length
  const restFlooded = flooded.slice(AREA_TABLE_TOP)
    .reduce((a, r) => a + r.flooded, 0)
  const sum = rows.reduce((a, r) => ({
    under: a.under + r.under, above: a.above + r.above,
    flooded: a.flooded + r.flooded,
  }), { under: 0, above: 0, flooded: 0 })
  const pct = (r: AreaFloodRow) => (r.total ? `${Math.round(r.floodRate * 100)}%` : '—')
  const cells = (flood: number | string, above: number | string,
                 under: number | string, rate = '') =>
    `<td class="num">${flood}</td><td class="num">${above}</td>`
    + `<td class="num">${under}</td><td class="num">${rate}</td>`

  const head = '<tr><td>小地域</td><td class="num">浸水</td><td class="num">床上</td>'
    + '<td class="num">床下</td><td class="num">率</td></tr>'
  if (flooded.length === 0) {
    return `<table class="areatab"><thead>${head}</thead><tbody>`
      + `<tr><td class="sub" colspan="5">この水位・モデルで浸水する建物は無い</td></tr>`
      + `<tr class="at"><td>合計</td>${cells(sum.flooded, sum.above, sum.under)}</tr>`
      + '</tbody></table>'
  }
  const body = shown.map((r) =>
    `<tr><td class="an" title="${r.areaCode ?? ''} ${r.total} 棟">${r.areaName}</td>`
    + cells(r.flooded, r.above, r.under, pct(r)) + '</tr>').join('')
  const rest = restAreas > 0
    ? `<tr class="ar"><td>ほか ${restAreas} 地域</td>${cells(restFlooded, '', '')}</tr>` : ''
  const out = outside
    ? `<tr class="ar"><td>(小地域外)</td>`
      + cells(outside.flooded, outside.above, outside.under, pct(outside)) + '</tr>' : ''
  return `<table class="areatab"><thead>${head}</thead><tbody>${body}${rest}${out}`
    + `<tr class="at"><td>合計</td>${cells(sum.flooded, sum.above, sum.under)}</tr>`
    + '</tbody></table>'
}

/**
 * 参照潮位のキーに添える通称。生のキー（MSL 等）だけだと庁内で伝わらないため。
 * 無いキーはそのまま出す。
 */
const REF_ALIAS: Record<string, string> = {
  MSL: '普段（平均海面）',
  '高潮想定の基準潮位': '高潮想定',
  '既往最高潮位': '既往最高',
}

/**
 * 参照潮位に添える「由来の一行」。特に**台風がらみ**（高潮想定・既往最高）が
 * どこから来た数字なのかを、押す前にツールチップで読めるようにする（U3）。
 * `reference_levels_detail` は古い配信物には無いので、鍵ごとに存在を確かめる。
 */
function refOriginTip(key: string, detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>
  const o = d.official as Record<string, unknown> | undefined
  const r = d.record_high as Record<string, unknown> | undefined
  const a = d.astronomical as Record<string, unknown> | undefined
  if (key === '高潮想定の基準潮位' && o) {
    return `\n＝朔望平均満潮位 ${o.spring_high_water_m_tp} m ＋ 異常潮位 ${o.anomaly_m} m。`
      + `京都府の高潮浸水想定はここに潮位偏差を足す。想定台風は ${o.assumed_typhoon}`
  }
  if (key === '既往最高潮位' && r) {
    return `\n＝${r.when} ${r.cause}（${r.source}）`
  }
  if (key === '天文潮最高' && a) {
    return `\n＝${a.year} 年の天文潮（気象擾乱を含まない）の最高値`
  }
  return ''
}

/**
 * 参照潮位の一覧。押すと水位がその値に飛ぶ。**旧「チップ」（普段・高潮想定・
 * 既往最高）と内容が被っていたのでここに一本化した**（2026-09）。
 * 配信物の `reference_levels_m_tp` を低い順に全部。
 *
 * 出典と既知の限界の文章は画面に出さない（`README.md` / `docs/results.md`）。
 * 出典表記はトップバー右端の「出典」（`topbarHtml`）に畳んである。
 */
function tideRefListHtml(refs: [string, number][], detail?: unknown): string {
  return `<div class="reflist" id="refs">${refs.map(([k, v]) =>
    `<button data-h="${v}" type="button"
    data-tip="${escAttr(`押すと潮位を ${k}（T.P. ${v.toFixed(3)} m）に合わせる` + refOriginTip(k, detail))}"
    >${REF_ALIAS[k] ?? k}<b>${v.toFixed(2)}</b></button>`).join('')}</div>`
}

/**
 * 初回だけ DOM を作り、以後は変わった箇所だけ書き換える。
 * 毎回 innerHTML を作り直すと、水位スライダを掴んでいる最中に
 * スライダ自身の DOM が消えて作り直される（掴み直しが必要になる）。
 */
/**
 * 対象範囲。**範囲を替えるとページごと読み直す。**
 *
 * 範囲が変わると `local_frame`（ローカル ENU の原点と回転）・タイルの URL・
 * 地物・3D Tiles・既定の視点が**すべて**入れ替わる。差分で入れ替える経路を
 * 用意すると `main.ts` の組み立てが二重になるので、`?area=<id>` を付けて
 * 読み直す。庁内で「範囲を行き来しながら見る」使い方は聞いていない [未確認]。
 */
export interface AreaChoice {
  index: AreaIndex
  current: Area
}

/**
 * 画面上部の細い帯（`#topbar`）。見出しと「何の上の何を見ているか」の 2 択＝
 * 対象範囲と地形データだけを置く。サイドバー（`#controls`）の外にあるので、
 * どのタブを開いていても、サイドバーをスクロールしても常に見える（2026-09）。
 * 1 範囲だけの配信物では対象範囲は消え、地形データだけが残る。
 */
function topbarHtml(
  a: AreaChoice | undefined, catalog: Catalog, cond: TerrainCondition,
  waterLevel: number,
): string {
  // **ツールチップは `<select>`（現在値）ではなくメニュー名（label）に張る。**
  // `<option>` には出せないうえ、選択肢を変えないと中身が分からないのは微妙なので、
  // メニュー名にホバー／フォーカスすると選べるもの全部が出る（2026-09-02 指示）
  const areaSel = a && a.index.areas.length >= 2
    ? `<label class="tbsel" data-tip="${escAttr(areaMenuTip(a))}">対象地域<select id="area" aria-label="対象地域">${
        a.index.areas.map((x) =>
          `<option value="${x.id}" ${x.id === a.current.id ? 'selected' : ''}
          >${x.label}</option>`).join('')}</select></label>`
    : ''
  const condSel = `<label class="tbsel" data-tip="${escAttr(condMenuTip(catalog))}">地形データ<select id="cond" aria-label="地形データ">${
    conditionsOf(catalog).map((c) =>
      `<option value="${c.id}" ${cond === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>`
  // いま解いている潮位。**このアプリの主変数**なので、タブを開いていなくても
  // トップバーに出す。値は `syncTopbar` が refresh ごとに書き換える。
  // ← → キーで動かせることはキー操作案内にも足す（刻みの詳細は data-tip に）
  const wlv = `<span class="tb-wl" data-tip="${escAttr(WATER_LEVEL_TIP)}">潮位`
    + ` <b id="tb-wl-v">${waterLevel.toFixed(2)}</b> m<span class="tb-wl-u"> T.P.</span></span>`
  // キー操作案内。右端の「出典」の左に、縦線を挟んで並べる
  const keys = '<span class="tb-keys">潮位 <kbd>←</kbd><kbd>→</kbd>　'
    + '視点 <kbd>0</kbd><kbd>1–6</kbd>　計測パネル <kbd>P</kbd></span>'
  // 出典は**常時は畳む**。ラベルは常に見える形で残し、ホバー／フォーカス／
  // クリックで全文を出す（MapLibre の畳んだ AttributionControl と同じ扱い。
  // PLATEAU・京都府 DEM・気象庁はいずれも表示を求めているが、到達可能なら可）
  const src = `<span class="tb-src" tabindex="0" role="button" aria-label="出典を表示">`
    + `<span class="tb-src-lbl">出典</span>`
    + `<span class="tb-src-pop">${catalog.attribution.join(' ／ ')}</span></span>`
  return `<h1>舞鶴 高潮浸水</h1>${areaSel}${condSel}${wlv}${keys}${src}`
}

/**
 * `#topbar` は `#controls` とは別の DOM。初回に組み、以後は select の値だけ同期。
 * 対象範囲・地形データの change はここで拾う（`#controls` の外に出たため）。
 */
function syncTopbar(store: Store, catalog: Catalog, area: AreaChoice | undefined) {
  const topbar = document.getElementById('topbar')
  if (!topbar) return
  if (topbar.dataset.pointerBlurBound !== '1') {
    // クリック後に select のフォーカスが残ると、←→が select の操作に使われて
    // 潮位変更へ届かない。ポインター操作だけ解除し、キーボード操作時の
    // フォーカス（タブ移動など）はアクセシビリティのため維持する。
    //
    // **select は pointerup では blur しない。** select を開くクリックそのものが
    // 先に pointerup を発火するため、ここで blur すると開いた直後のネイティブ
    // ドロップダウンが閉じてしまい、他の選択肢を選べなくなる（実機で再現・確認した
    // 不具合）。select は「値が確定した」change の後に blur する
    topbar.addEventListener('pointerup', (e) => {
      const target = e.target
      if (target instanceof HTMLButtonElement) target.blur()
    })
    topbar.addEventListener('change', (e) => {
      const target = e.target
      if (target instanceof HTMLSelectElement) target.blur()
    })
    topbar.dataset.pointerBlurBound = '1'
  }
  const cond = surfaceCondition(store.state.surface)
  if (topbar.dataset.built === '1') {
    const sel = topbar.querySelector<HTMLSelectElement>('#cond')
    if (sel && sel.value !== cond) sel.value = cond
    const ar = topbar.querySelector<HTMLSelectElement>('#area')
    if (ar && area && ar.value !== area.current.id) ar.value = area.current.id
    const wlv = topbar.querySelector<HTMLElement>('#tb-wl-v')
    const wlText = store.state.waterLevel.toFixed(2)
    if (wlv && wlv.textContent !== wlText) wlv.textContent = wlText
    return
  }
  topbar.innerHTML = topbarHtml(area, catalog, cond, store.state.waterLevel)
  topbar.dataset.built = '1'
  topbar.querySelector('#area')?.addEventListener('change', (e) => {
    // 範囲を替えるとローカル座標系から配信物まで全部変わるので、読み直す
    const u = new URL(location.href)
    u.searchParams.set('area', (e.target as HTMLSelectElement).value)
    location.href = u.toString()
  })
  topbar.querySelector('#cond')!.addEventListener('change', (e) => {
    const c = (e.target as HTMLSelectElement).value as TerrainCondition
    // 判定差を見ていたら、条件を替えてもその条件の判定差に移る（見方を保つ）
    const next = isDiff(store.state.surface) && DIFF_OF[c] ? DIFF_OF[c]! : (c as SurfaceMode)
    store.set({ surface: next })
  })
}

/**
 * 断面ツール（`#toolbar` の上段 `#toolbar-row`）。サイドバーとビューキューブの間に置く。
 * 「測線を引く」は画面の主操作なのでタブに埋めない。線を引くと `#toolbar` 内の
 * `#section` にグラフが開く（`main.ts`。パネル高さは左の `#controls-top` と揃う）。
 * `#secbtn` の click は `main.ts` の委譲ハンドラが拾う（DOM 位置に依存しない）。
 */
function syncToolbar() {
  const row = document.getElementById('toolbar-row')
  if (!row || row.dataset.built === '1') return
  row.innerHTML = '<b data-tip="地図を 2 点クリックして測線を引くと、その線の地形・浸水の断面図が下に開く。Esc で中止">断面</b>'
    + '<button id="secbtn" type="button" aria-pressed="false">測線を引く</button>'
  row.dataset.built = '1'
}

export function renderControls(
  el: HTMLElement, store: Store, catalog: Catalog,
  buildingLegend: LegendEntry[] = [],
  area?: AreaChoice,
  tideCurves: TideSeries[] = [], playbackStats?: PlaybackStats,
  areaFlood: AreaFloodRow[] = [],
  walkIsochroneInfo: WalkIsochroneInfo | null = null,
  tideForecast: TideForecastState = { status: 'idle' },
  onRefreshForecast: () => void = () => {},
) {
  const s = store.state
  const cond = surfaceCondition(s.surface)

  syncTopbar(store, catalog, area)
  syncToolbar()
  if (el.dataset.pointerBlurBound !== '1') {
    // タブ・ボタン・select のクリック後は、直後の潮位キー操作を使えるよう
    // ポインター操作時だけフォーカスを外す。キー操作のフォーカスは残す。
    //
    // **select は pointerup では blur しない**（`syncTopbar` と同じ理由）。
    // select を開くクリック自体が先に pointerup を発火するため、ここで blur すると
    // 開いた直後のネイティブドロップダウンが閉じ、他の選択肢（潮位の記録の
    // 台風イベントなど）を選べなくなる。select は change の後に blur する
    el.addEventListener('pointerup', (e) => {
      const target = e.target
      if (target instanceof HTMLButtonElement) target.blur()
    })
    el.addEventListener('change', (e) => {
      const target = e.target
      if (target instanceof HTMLSelectElement) target.blur()
    })
    el.dataset.pointerBlurBound = '1'
  }

  if (el.dataset.built === '1') {
    const v = el.querySelector<HTMLElement>('#wlv')
    if (v) v.textContent = `${s.waterLevel.toFixed(2)} m`
    const range = el.querySelector<HTMLInputElement>('#wl')
    if (range && document.activeElement !== range && range.value !== String(s.waterLevel)) {
      range.value = String(s.waterLevel)
    }
    // 判定差は差分タイルがある条件だけ。無い条件では押せないことがそのまま出る
    const diffBtn = el.querySelector<HTMLButtonElement>('#diffbtn')
    if (diffBtn) {
      const target = DIFF_OF[cond]
      diffBtn.disabled = !target
      diffBtn.setAttribute('aria-pressed', String(isDiff(s.surface) && s.surface !== 'diff_drainage'))
      diffBtn.dataset.tip = target
        ? 'いま見ている地形データと基準（PLATEAU 5m）で、浸水するかどうかの判定が割れる場所を塗り分ける'
        : 'この条件の差分タイルは配信していないので出せない'
    }
    const assumBtn = el.querySelector<HTMLButtonElement>('#assumbtn')
    if (assumBtn) {
      assumBtn.hidden = !catalog.terrain.diff_drainage
      assumBtn.setAttribute('aria-pressed', String(s.surface === 'assumption'))
    }
    const drainageBtn = el.querySelector<HTMLButtonElement>('#drainagebtn')
    if (drainageBtn) {
      drainageBtn.hidden = !catalog.terrain.diff_drainage
      drainageBtn.setAttribute('aria-pressed', String(s.surface === 'diff_drainage'))
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('#tpaint button')) {
      b.setAttribute('aria-pressed', String(b.dataset.p === s.terrainPaint))
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('#fmodel button')) {
      b.setAttribute('aria-pressed', String(b.dataset.f === s.floodModel))
    }
    // **窪地は連結モデルのときだけの状態。** 単純モデルでは窪地も浸水域なので、
    // チェックが残っていると押しても何も変わらない項目になる
    const pond = el.querySelector<HTMLInputElement>('input[data-l="ponded"]')
    const pondRow = pond?.closest('label') as HTMLElement | null
    if (pondRow) pondRow.hidden = s.floodModel !== 'connected'
    const lgMain = el.querySelector<HTMLElement>('#legend-main')
    if (lgMain) lgMain.innerHTML = legendHtml(s, buildingLegend, walkIsochroneInfo)
    const lgBldg = el.querySelector<HTMLElement>('#legend-bldg')
    if (lgBldg) lgBldg.innerHTML = buildingLegendHtml(s, buildingLegend)
    // 地域別の浸水建物。水位・モデル・地形条件の変更にその場で追従する
    const ag = el.querySelector<HTMLElement>('#areagroup')
    if (ag) ag.hidden = areaFlood.length === 0
    const af = el.querySelector<HTMLElement>('#areaflood')
    if (af) af.innerHTML = areaFloodHtml(areaFlood)
    const cb = el.querySelector<HTMLInputElement>('#cb-changed')
    if (cb && cb.checked !== s.layers.changedOnly) cb.checked = s.layers.changedOnly
    for (const box of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
      const k = box.dataset.l as LayerKey
      if (box.checked !== s.layers[k]) box.checked = s.layers[k]
    }
    // 鉛直強調中は PLATEAU 建物を隠している。チェックが嘘をつかないように無効化する
    const hidden = s.exaggeration > 1
    const pl = el.querySelector<HTMLInputElement>('input[data-l="plateau"]')
    if (pl) {
      pl.disabled = hidden
      pl.closest('label')?.classList.toggle('off', hidden)
    }
    // 道路の色・建物の色の select は常時表示（チェックボックスに追従させない）
    const bcb = el.querySelector<HTMLSelectElement>('#bcol')
    if (bcb && bcb.value !== s.buildingColor) bcb.value = s.buildingColor
    const rcb = el.querySelector<HTMLSelectElement>('#rcol')
    if (rcb && rcb.value !== s.roadColor) rcb.value = s.roadColor
    const wiwrap = el.querySelector<HTMLElement>('#wiwrap')
    if (wiwrap) wiwrap.hidden = !s.layers.walkIsochrone
    const wisel = el.querySelector<HTMLSelectElement>('#wisel')
    if (wisel && wisel.value !== String(s.walkIsochroneIndex ?? 0)) {
      wisel.value = String(s.walkIsochroneIndex ?? 0)
    }
    if (tideCurves.length && !el.querySelector('#playback')) {
      const initialSelected = catalog.water_level.tide_series?.default ?? tideCurves[0].id
      el.querySelector('#playbackslot')?.insertAdjacentHTML('beforeend',
        tidePlaybackHtml(tideCurves, initialSelected, tideForecast))
      mountTidePlayback(el, tideCurves, initialSelected, store, onRefreshForecast, tideForecast)
    } else {
      // 潮位再生パネルは初回構築後に作り直さない。更新ボタン・状態行だけ反映する
      // （曲線そのものの追加/差し替えは main.ts が handle.upsertCurve で直接行う）
      getTidePlaybackHandle(el)?.setForecastStatus(tideForecast)
    }
    updateTidePlayback(el, playbackStats)
    return
  }

  // 潮位スライダの値域・刻み（`domain/waterLevel.ts`）。上限は 2.0 m T.P. で
  // 頭打ち（配信物の max は 3.0 だが、既往最高 0.93・高潮想定 0.69 に対して
  // 3 m は目盛りが間延びしすぎる）
  const wl = waterLevelRange(catalog)
  const refs = Object.entries(catalog.water_level.reference_levels_m_tp)
    .sort((a, b) => a[1] - b[1])

  el.innerHTML = `
    <!-- サイドバーは 2 枚のパネルに分ける。1 枚目＝地形の色（今どの面を見ているか）
         ＋凡例。見出しは付けない（3 ボタンで自明）。旧 nowline は廃止 -->
    <div class="panel" id="controls-top">
      <div class="seg" id="tpaint" aria-label="地形の色">${TERRAIN_PAINTS.map((m) =>
          `<button data-p="${m.id}" type="button" data-tip="${escAttr(m.hint)}"
                   aria-pressed="${s.terrainPaint === m.id}">${m.label}</button>`).join('')}</div>
      <!-- 凡例は 2 列。左＝画面の色（地形＋レイヤ）、右＝建物の色の内訳（棟数）。
           右列は「建物の色」を none 以外にしたときだけ中央固定の縦線を挟んで出る -->
      <div id="legend">
        <div id="legend-main">${legendHtml(s, buildingLegend, walkIsochroneInfo)}</div>
        <div id="legend-bldg">${buildingLegendHtml(s, buildingLegend)}</div>
      </div>
    </div>

    <!-- 2 枚目＝タブ。「基本設定＝表示対象・比較表示・絞り込む（何をどう見るか）」
         「浸水条件＝シミュレーション条件・潮位・参照潮位・潮位再生・地域別集計
         （何を動かして数字で調べるか）」。対象範囲と地形データはトップバー、
         断面ツールは #toolbar、分析タブは畳んだ。高さを強調は UI から落とし
         キー操作のみ（キー [ ]）。中身が長いタブはこのパネルの中だけがスクロールする -->
    <div class="panel" id="controls-tabs">
    <div class="tabs" id="ctabs">
      <div class="tablist" role="tablist">
        <button class="tab" id="tab-basic" type="button" role="tab"
                aria-selected="true" aria-controls="panel-basic">基本設定</button>
        <button class="tab" id="tab-display" type="button" role="tab"
                aria-selected="false" aria-controls="panel-display" tabindex="-1">浸水条件</button>
        <button class="tab" id="tab-attr" type="button" role="tab"
                aria-selected="false" aria-controls="panel-attr" tabindex="-1">属性情報</button>
      </div>

      <div class="tabpanels">
      <div class="tabpanel" id="panel-basic" role="tabpanel" aria-labelledby="tab-basic">
        <p class="subhead" data-tip="地図に重ねるレイヤの ON/OFF。その範囲に無いレイヤ（点群・線路など）は出ない">表示対象</p>
        <div class="layergrid">
        ${layersOf(catalog).map((l) =>
          `<label class="row"${l.hint ? ` data-tip="${escAttr(l.hint)}"` : ''}
            ${l.key === 'ponded' && s.floodModel !== 'connected' ? 'hidden' : ''}
            ><input type="checkbox" data-l="${l.key}"
            ${s.layers[l.key] ? 'checked' : ''}/>${l.label}</label>`).join('')}
        </div>
        <!-- 道路の色・建物の色は**チェックボックスの ON/OFF に関わらず常時出す**。
             入れ子（.nested）にはしない＝表示対象と同じ左端に揃える（2026-09 指示） -->
        <div class="colsel" id="rcolwrap" data-tip="${escAttr(ROAD_COLOR_MENU_TIP)}">
          <p class="grouplabel">道路の色</p>
          <select id="rcol" aria-label="道路の色">${MENU_ROAD_COLORS.map((m) =>
            `<option value="${m.id}" ${s.roadColor === m.id ? 'selected' : ''}
            >${m.label}</option>`).join('')}</select>
        </div>
        ${(catalog.walk_isochrones?.length ?? 0) > 1 ? `
        <div class="nested" id="wiwrap" ${s.layers.walkIsochrone ? '' : 'hidden'}>
          <p class="grouplabel">徒歩圏の起点</p>
          <select id="wisel" aria-label="徒歩圏の起点">${catalog.walk_isochrones!.map((w, i) =>
            `<option value="${i}" ${(s.walkIsochroneIndex ?? 0) === i ? 'selected' : ''}
            >${w.label ?? `${w.minutes} 分（${i}）`}</option>`).join('')}</select>
        </div>` : ''}
        <div class="colsel" id="bcolwrap" data-tip="${escAttr(BUILDING_COLOR_MENU_TIP)}">
          <!-- **チェックボックスから select にした。** 塗り分けが 3 通りになり、
               浸水深（床下・床上）は「用途で塗る」の on/off では表せない。
               **見出しを付ける。** 無いと「用途」とだけ書かれた裸のドロップダウンに
               なり、中に浸水深があることが画面から分からない（実際に
               「床下/床上の色分けが入っていない」と受け取られた。2026-08） -->
          <p class="grouplabel">建物の色</p>
          <select id="bcol" aria-label="建物の色">${MENU_BUILDING_COLORS.map((m) =>
            `<option value="${m.id}" ${s.buildingColor === m.id ? 'selected' : ''}
            >${m.id === 'none' ? '塗り分けない' : m.label}</option>`).join('')}</select>
        </div>

        <p class="subhead" data-tip="地図の塗り方を『浸水するか』から『地形データや排水モデルで判定がどう割れるか』に替える。ボタンごとの説明は各ボタンに">比較表示</p>
        <div class="compare-row">
          <button id="diffbtn" type="button" aria-pressed="${isDiff(s.surface) && s.surface !== 'diff_drainage'}"
                  ${DIFF_OF[cond] ? '' : 'disabled'}
                  data-tip="いま見ている地形データと基準（PLATEAU 5m）で、浸水するかどうかの判定が割れる場所を塗り分ける">地形条件の判定差</button>
          <button id="drainagebtn" type="button" aria-pressed="${s.surface === 'diff_drainage'}"
                  ${catalog.terrain.diff_drainage ? '' : 'hidden'}
                  data-tip="海から地表面をたどって届く浸水と、仮想排水路を逆流して届く浸水の差を塗り分ける">排水モデルの差</button>
          <button id="assumbtn" type="button" aria-pressed="${s.surface === 'assumption'}"
                  ${catalog.terrain.diff_drainage ? '' : 'hidden'}
                  data-tip="その土地が浸かると言うのに、どこまで仮定を置いているか（連結 ⊆ 仮想排水 ⊆ 潮位以下）。配信物は増えない"
          >仮定の段階</button>
        </div>

        <p class="subhead" data-tip="判定が変わる地物だけを残して、ほかを減光する">絞り込む</p>
        <label class="row" data-tip="判定が変わる地物だけを残して、ほかを減光する"><input type="checkbox" id="cb-changed"
          ${s.layers.changedOnly ? 'checked' : ''}/>判定が変わる地物のみ</label>
      </div>

      <div class="tabpanel" id="panel-display" role="tabpanel" aria-labelledby="tab-display" hidden>
        <p class="grouplabel" data-tip="${escAttr('浸水をどう決めるか。単純（潮位−地盤高）／海からつながる（既定）／仮想排水路の 3 択。選択肢ごとの説明は各ボタンに')}">シミュレーション条件</p>
        <div class="seg models" id="fmodel">${FLOOD_MODELS
          .filter((m) => m.id !== 'drainage' || !!catalog.terrain.diff_drainage)
          .map((m) =>
          `<button data-f="${m.id}" type="button" data-tip="${escAttr(m.hint)}"
                   aria-pressed="${s.floodModel === m.id}">${m.label}</button>`).join('')}</div>

        <p class="grouplabel" data-tip="${escAttr(WATER_LEVEL_TIP)}">潮位</p>
        <div class="wl"><b id="wlv">${s.waterLevel.toFixed(2)} m</b><span class="sub">T.P.</span></div>
        <div class="wlrow" data-tip="${escAttr(WATER_LEVEL_TIP)}">
          <button class="stepbtn" id="wl-down" type="button"
                  aria-label="潮位を ${wl.step} m 下げる">−</button>
          <input id="wl" type="range" min="${wl.min}" max="${wl.max}" step="${wl.step}"
                 value="${s.waterLevel}" aria-label="潮位（m T.P.）" />
          <button class="stepbtn" id="wl-up" type="button"
                  aria-label="潮位を ${wl.step} m 上げる">＋</button>
        </div>
        <div class="tickbar">${refs.map(([k, v]) =>
          `<i style="left:${((v - wl.min) / (wl.max - wl.min)) * 100}%" title="${k} ${v.toFixed(3)} m"></i>`).join('')}</div>
        <div class="ticks"><span>${wl.min.toFixed(1)}</span><span>${wl.max.toFixed(1)}</span></div>

        <p class="subhead" data-tip="押すと潮位をその値（平均海面・朔望平均満潮位・高潮想定・既往最高など）に合わせる。高潮想定・既往最高は台風由来（各項目にホバーで内訳）">参照潮位</p>
        ${tideRefListHtml(refs, catalog.water_level.reference_levels_detail)}

        <div id="playbackslot">${tideCurves.length ? tidePlaybackHtml(tideCurves,
          catalog.water_level.tide_series?.default ?? tideCurves[0].id, tideForecast) : ''}</div>

        <div id="areagroup" ${areaFlood.length ? '' : 'hidden'}>
          <p class="subhead" data-tip="いまの潮位・モデルで浸水する建物を、国勢調査の小地域（町丁・字等）ごとに集計。浸水棟数の多い順">地域別の浸水建物</p>
          <div id="areaflood">${areaFloodHtml(areaFlood)}</div>
        </div>
      </div>

      <!-- 属性情報。地図で地物をクリックすると中身が入る（renderInspector）。
           以前は右上に浮くパネルだった。既定は「選択してください」だけ -->
      <div class="tabpanel" id="panel-attr" role="tabpanel" aria-labelledby="tab-attr" hidden>
        ${ATTR_EMPTY_HINT}
      </div>
      </div>
      </div>
    </div>
  `
  el.dataset.built = '1'
  if (tideCurves.length) {
    mountTidePlayback(el, tideCurves,
      catalog.water_level.tide_series?.default ?? tideCurves[0].id, store, onRefreshForecast, tideForecast)
    updateTidePlayback(el, playbackStats)
  }

  // タブ切り替え。role=tablist・矢印キーでの移動に対応した最小実装。
  // パネルの hidden 切り替えだけで中身は再構築しない
  const tabs = [...el.querySelectorAll<HTMLButtonElement>('.tabs .tab')]
  const selectTab = (tab: HTMLButtonElement, focus = true) => {
    for (const t of tabs) {
      const on = t === tab
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
      const panel = el.querySelector<HTMLElement>(`#${t.getAttribute('aria-controls')}`)
      if (panel) panel.hidden = !on
    }
    if (focus) tab.focus()
  }
  el.querySelector('.tablist')?.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('.tab')
    if (t) selectTab(t, false)
  })
  el.querySelector('.tablist')?.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key
    if (key !== 'ArrowRight' && key !== 'ArrowLeft') return
    e.preventDefault()
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (i === -1) return
    selectTab(tabs[(i + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length])
  })

  el.querySelector('#diffbtn')!.addEventListener('click', () => {
    const c = surfaceCondition(store.state.surface)
    store.set({ surface: isDiff(store.state.surface) ? c : (DIFF_OF[c] ?? c) })
  })
  el.querySelector('#drainagebtn')?.addEventListener('click', () => {
    if (catalog.terrain.diff_drainage) store.set({ surface: 'diff_drainage' })
  })
  el.querySelector('#assumbtn')?.addEventListener('click', () => {
    // 3 段はすべて diff_drainage タイルに入っている（domain/terrain.ts）
    if (catalog.terrain.diff_drainage) store.set({ surface: 'assumption' })
  })
  el.querySelector('#refs')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ waterLevel: Number(b.dataset.h) })
  })
  el.querySelector('#tpaint')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ terrainPaint: b.dataset.p as TerrainPaint })
  })
  el.querySelector('#fmodel')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b) store.set({ floodModel: b.dataset.f as FloodModel })
  })
  const range = el.querySelector<HTMLInputElement>('#wl')!
  range.addEventListener('input', () => {
    // 潮位変更でネットワークは一切発生しない。シェーダの uniform が変わるだけ
    store.set({ waterLevel: Number(range.value) })
  })
  // **ドラッグだけでは 0.05 m 刻みを合わせにくい。** 1 段ずつ動かせるようにする
  // （左右キーも `main.ts` で同じ `nudgeWaterLevel` を呼ぶ。刻みはキー側が持つ）
  const nudge = (d: -1 | 1) => {
    store.set({ waterLevel: nudgeWaterLevel(store.state.waterLevel, d * wl.step, wl) })
  }
  el.querySelector('#wl-down')!.addEventListener('click', () => nudge(-1))
  el.querySelector('#wl-up')!.addEventListener('click', () => nudge(1))
  el.querySelector('#cb-changed')!.addEventListener('change', (e) => {
    store.setLayer({ changedOnly: (e.target as HTMLInputElement).checked })
  })
  el.querySelector('#rcol')!.addEventListener('change', (e) => {
    store.set({ roadColor: (e.target as HTMLSelectElement).value as RoadColorMode })
  })
  el.querySelector('#wisel')?.addEventListener('change', (e) => {
    store.set({ walkIsochroneIndex: Number((e.target as HTMLSelectElement).value) })
  })
  el.querySelector('#bcol')!.addEventListener('change', (e) => {
    // メニューに出すのは なし / 用途 / 浸水深。'class'（普通建物・堅ろう建物）は
    // 浸水の話に効かないので __iwagaki からのみ
    store.set({ buildingColor: (e.target as HTMLSelectElement).value as BuildingColorMode })
  })
  for (const cb of el.querySelectorAll<HTMLInputElement>('input[data-l]')) {
    cb.addEventListener('change', () => store.setLayer({ [cb.dataset.l!]: cb.checked } as never))
  }
}
