// 雨量シナリオと「簡易内水リスク」。**潮位・h_conn・海水浸水には一切触れない。**
//
// このモジュールが出すのは **相対的な危険度**であって、浸水深 [m] ではない。
// 現行の浸水モデル（`domain/flood.ts`）は潮位ベースで、降水量を考慮していない。
// 排水区・側溝・暗渠・排水管・吐口高・フラップゲート・ポンプ能力は揃っていない
// （`docs/data.md`「排水施設」「未確認: 排水路の吐口」）ので、下水管網を含む
// 本格的な内水氾濫解析はしない。
//
// できること: 既存の DEM・流向・集水解析（`catalog.flow` の水みちタイル。
// R = log 正規化した集水セル数、B = 窪地の充填深）を使い、
// **「雨量が増えたときに地形的に危険になりやすい場所」**を相対値で塗る。
//
// maplibre-gl / deck.gl / three.js / loaders.gl を import しない
// （`docs/web_design.md`「層の分け方」）。ここは純関数だけ。

/**
 * 雨量シナリオ 1 件。**後から足しやすいよう、ただの配列要素にしてある。**
 *
 * - `durationHours` … 継続時間 [h]（1 / 3 / 24 …）
 * - `rainfallMm`    … その時間に降る累積雨量 P [mm]
 * - `source`        … 観測値を使ったシナリオの出典 URL（定数コメントにも書く）
 */
export interface RainfallScenario {
  id: string
  label: string
  durationHours: number
  rainfallMm: number
  description?: string
  source?: string
}

/**
 * 舞鶴観測所（block_no 47750）の**観測史上の値**。
 * 出典: 気象庁「歴代全国ランキング」観測所別
 * <https://www.data.jma.go.jp/stats/etrn/view/rank_s.php?block_no=47750&day=&month=&prec_no=61&view=np0&year=>
 *
 * | 継続 | 記録 | 日付 |
 * |---|---|---|
 * | 最大 1 時間降水量  | 65.5 mm | 2018-07-07 |
 * | 最大 3 時間降水量  | 129.5 mm | 2018-07-07 |
 * | 最大 24 時間降水量 | 312.0 mm | 2017-10-23 |
 * | 最大 48 時間降水量 | 406.0 mm | 2018-07-07 |
 * | 最大 72 時間降水量 | 438.5 mm | 2018-07-08 |
 */
export const MAIZURU_JMA_RANK_URL =
  'https://www.data.jma.go.jp/stats/etrn/view/rank_s.php'
  + '?block_no=47750&day=&month=&prec_no=61&view=np0&year='

export const MAIZURU_RAINFALL_RECORDS = {
  h1: { mm: 65.5, when: '2018-07-07' },
  h3: { mm: 129.5, when: '2018-07-07' },
  h24: { mm: 312.0, when: '2017-10-23' },
  h48: { mm: 406.0, when: '2018-07-07' },
  h72: { mm: 438.5, when: '2018-07-08' },
} as const

/** カスタム雨量シナリオの id。この id のときだけ `RainfallState` の custom 値を使う */
export const CUSTOM_SCENARIO_ID = 'custom'
export const NO_RAIN_SCENARIO_ID = 'none'

/**
 * 既定の雨量シナリオ一覧。観測史上値を使うものは `source` を持つ。
 * **観測史上を上回る想定**（1h 80mm / 3h 100mm / 24h 200mm）は
 * `description` に「観測史上を上回る仮定」と明示する。
 */
export const RAINFALL_SCENARIOS: RainfallScenario[] = [
  { id: NO_RAIN_SCENARIO_ID, label: '雨量なし', durationHours: 0, rainfallMm: 0 },
  { id: 'h1_50', label: '1時間 50 mm', durationHours: 1, rainfallMm: 50,
    description: '気象庁の「非常に激しい雨」（滝のように降る）相当' },
  { id: 'h1_max', label: '1時間 65.5 mm', durationHours: 1,
    rainfallMm: MAIZURU_RAINFALL_RECORDS.h1.mm,
    description: `舞鶴観測所 観測史上1位（${MAIZURU_RAINFALL_RECORDS.h1.when}）`,
    source: MAIZURU_JMA_RANK_URL },
  { id: 'h1_80', label: '1時間 80 mm', durationHours: 1, rainfallMm: 80,
    description: '観測史上を上回る仮定' },
  { id: 'h3_100', label: '3時間 100 mm', durationHours: 3, rainfallMm: 100,
    description: '観測史上を上回る仮定' },
  { id: 'h3_max', label: '3時間 129.5 mm', durationHours: 3,
    rainfallMm: MAIZURU_RAINFALL_RECORDS.h3.mm,
    description: `舞鶴観測所 観測史上1位（${MAIZURU_RAINFALL_RECORDS.h3.when}）`,
    source: MAIZURU_JMA_RANK_URL },
  { id: 'h24_200', label: '24時間 200 mm', durationHours: 24, rainfallMm: 200,
    description: '観測史上を上回る仮定' },
  { id: 'h24_max', label: '24時間 312 mm', durationHours: 24,
    rainfallMm: MAIZURU_RAINFALL_RECORDS.h24.mm,
    description: `舞鶴観測所 観測史上1位（${MAIZURU_RAINFALL_RECORDS.h24.when}）`,
    source: MAIZURU_JMA_RANK_URL },
  { id: CUSTOM_SCENARIO_ID, label: 'カスタム', durationHours: 1, rainfallMm: 0 },
]

export const DEFAULT_RAINFALL_SCENARIO_ID = NO_RAIN_SCENARIO_ID

/**
 * 「雨量リスク」モードに切り替えたとき、シナリオが「雨量なし」なら
 * ここまで引き上げる（画面に何も出ないのを避ける）。観測史上1位。
 */
export const RAINFALL_PAINT_FALLBACK_SCENARIO_ID = 'h3_max'

// --- 流出率 --------------------------------------------------------------

/**
 * **流出率プリセット。** 合理式（rational method）の C に相当する係数で、
 * 地表被覆から機械的に置いた**仮定値**。土地利用ポリゴンごとの厳密な配分は
 * していない（`docs/design.md`「やらないこと」の範囲。土地利用データは未整備）。
 */
export interface RunoffPreset {
  id: string
  label: string
  coefficient: number
  hint: string
}

export const RUNOFF_PRESETS: RunoffPreset[] = [
  { id: 'mixed', label: '市街地（混在）', coefficient: 0.65,
    hint: '住宅・道路・空地が混在する市街地の代表値' },
  { id: 'dense', label: '密集市街地', coefficient: 0.85,
    hint: '建物・舗装が卓越し、浸透がほとんど無い' },
  { id: 'green', label: '緑地・農地混在', coefficient: 0.40,
    hint: '浸透域が多く、表面流出が小さい' },
]

export const DEFAULT_RUNOFF_COEFFICIENT = 0.65
export const RUNOFF_MIN = 0.1
export const RUNOFF_MAX = 1.0

// --- カスタム雨量のバリデーション ---------------------------------------

export const CUSTOM_RAINFALL_MAX_MM = 600
export const CUSTOM_DURATION_MIN_HOURS = 1
export const CUSTOM_DURATION_MAX_HOURS = 72

export interface CustomRainfallInput {
  rainfallMm: number
  durationHours: number
}

export interface CustomRainfallValidation {
  ok: boolean
  errors: string[]
  /** 範囲内にクランプ・丸めた採用値。`ok` が false でも描画を壊さない値を返す */
  value: CustomRainfallInput
}

/**
 * カスタム雨量の検証。**無効な入力でも描画が壊れない値**を `value` で返す
 * （UI 側はエラーを見せつつ、地図は安全側の値で塗り続ける）。
 *
 * - `rainfallMm`   … 有限・0 以上・`CUSTOM_RAINFALL_MAX_MM` 以下
 * - `durationHours`… 有限・1 以上・`CUSTOM_DURATION_MAX_HOURS` 以下
 */
export function validateCustomRainfall(i: CustomRainfallInput): CustomRainfallValidation {
  const errors: string[] = []
  let mm = i.rainfallMm
  let hours = i.durationHours

  if (!Number.isFinite(mm)) { errors.push('雨量は数値で入力してください'); mm = 0 }
  else if (mm < 0) { errors.push('雨量は 0 以上にしてください'); mm = 0 }
  else if (mm > CUSTOM_RAINFALL_MAX_MM) {
    errors.push(`雨量は ${CUSTOM_RAINFALL_MAX_MM} mm 以下にしてください`)
    mm = CUSTOM_RAINFALL_MAX_MM
  }

  if (!Number.isFinite(hours)) {
    errors.push('継続時間は数値で入力してください'); hours = CUSTOM_DURATION_MIN_HOURS
  } else if (hours < CUSTOM_DURATION_MIN_HOURS) {
    errors.push(`継続時間は ${CUSTOM_DURATION_MIN_HOURS} 時間以上にしてください`)
    hours = CUSTOM_DURATION_MIN_HOURS
  } else if (hours > CUSTOM_DURATION_MAX_HOURS) {
    errors.push(`継続時間は ${CUSTOM_DURATION_MAX_HOURS} 時間以下にしてください`)
    hours = CUSTOM_DURATION_MAX_HOURS
  }

  return {
    ok: errors.length === 0,
    errors,
    value: { rainfallMm: Math.round(mm * 10) / 10, durationHours: Math.round(hours) },
  }
}

// --- AppState が持つ雨量シナリオの状態 ----------------------------------

/**
 * `AppState.rainfall`。**現在の雨量シナリオ**。潮位（`AppState.waterLevel`）
 * とは独立で、同時に表示できる。ここを変えても地形タイルの再取得・
 * 再構築は起きない（`main.ts` の `buildTerrain` の buildKey に含めない。
 * uniform だけが変わる）。
 */
export interface RainfallState {
  /** `RAINFALL_SCENARIOS` の id、または `'custom'` */
  scenarioId: string
  /** `scenarioId === 'custom'` のときの累積雨量 [mm] */
  customMm: number
  /** `scenarioId === 'custom'` のときの継続時間 [h] */
  customHours: number
  /** 流出率 C（`RUNOFF_MIN`〜`RUNOFF_MAX`） */
  runoffCoefficient: number
}

export function initialRainfallState(): RainfallState {
  return {
    scenarioId: DEFAULT_RAINFALL_SCENARIO_ID,
    customMm: MAIZURU_RAINFALL_RECORDS.h1.mm,
    customHours: 1,
    runoffCoefficient: DEFAULT_RUNOFF_COEFFICIENT,
  }
}

/** `RainfallState` から、いま効いているシナリオを 1 件に解決する。 */
export function resolveRainfallScenario(st: RainfallState): RainfallScenario {
  if (st.scenarioId === CUSTOM_SCENARIO_ID) {
    const v = validateCustomRainfall({
      rainfallMm: st.customMm, durationHours: st.customHours,
    }).value
    return {
      id: CUSTOM_SCENARIO_ID, label: 'カスタム',
      durationHours: v.durationHours, rainfallMm: v.rainfallMm,
      description: '手入力（仮定）',
    }
  }
  return RAINFALL_SCENARIOS.find((s) => s.id === st.scenarioId)
    ?? RAINFALL_SCENARIOS[0]
}

// --- 簡易内水リスクのモデル式 -------------------------------------------
//
// **精密な水理計算は装わない。** 次の 3 段だけ:
//
//   1. 実効雨量  E [mm] = P [mm] × 流出率 C
//   2. 雨の強さ  intensity = E / RAINFALL_RISK_REFERENCE_MM   （0 mm → 0、単調増加）
//   3. 相対リスク risk = intensity × ( W_accum × accumNorm
//                                    + W_pond  × min(1, fillDepth × POND_DEPTH_SCALE) )
//
// - `accumNorm`  … 水みちタイル R チャネル（log 正規化した上流集水セル数、[0,1]）。
//   「一様降雨時に地表流がどれだけ集まるか」。**catchment 表示と同じ生データ**だが、
//   catchment 表示はこの値をそのまま色にするだけ（潮位も雨量も掛けない）。
//   こちらは **intensity を掛けて雨量で振る**ので、両者は別の量である。
// - `fillDepth`  … 水みちタイル B チャネル（窪地の充填深 [m]）。窪地は抜けないので上乗せ。
// - **海からの連結性・h_conn・潮位は式に出てこない。** 海水浸水（`domain/flood.ts`）
//   と雨水の内水リスクを同じものとして扱わないため（`h_conn` を雨量で書き換えない）。
//
// GLSL 側（`three/floodMaterial.ts` の `rainRiskRamp` 前の計算）と同じ式であること。

/** 実効雨量 E = P × C の基準値 [mm]。E がこの値で intensity = 1。24h 312mm（観測史上1位）に対応 */
export const RAINFALL_RISK_REFERENCE_MM = 300

/** 集水（accumNorm）のリスク寄与の重み */
export const RAINFALL_RISK_ACCUM_WEIGHT = 1.0
/** 窪地（充填深）のリスク寄与の重み */
export const RAINFALL_RISK_POND_WEIGHT = 0.6
/** 充填深 [m] を [0,1] 寄与へ写すスケール [1/m]。0.5 m で寄与が飽和 */
export const RAINFALL_RISK_POND_DEPTH_SCALE = 2.0

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

/** 実効雨量 E [mm] = 累積雨量 P × 流出率 C。負値は 0 に、C は [0,1] にクランプ。 */
export function effectiveRainfallMm(
  scenario: RainfallScenario, runoffCoefficient: number,
): number {
  return Math.max(0, scenario.rainfallMm) * clamp(runoffCoefficient, 0, 1)
}

/**
 * 実効雨量を無次元の「雨の強さ」に写す。**0 mm で必ず 0、E について厳密に単調増加。**
 * 上側はクランプしない（相対比較が潰れないように）。
 */
export function rainfallIntensity(effectiveMm: number): number {
  return Math.max(0, effectiveMm) / RAINFALL_RISK_REFERENCE_MM
}

/**
 * 地形の集水・窪地に基づく**相対的な内水リスク**。**浸水深 [m] ではない。**
 *
 * 性質（テストで固定）:
 * - `intensity <= 0`（= 雨量 0）なら、集水・窪地がどうであれ **0**
 * - `intensity` について厳密に単調増加
 * - `accumNorm` / `fillDepthM` について単調増加
 * - 潮位・h_conn・海水浸水を参照しない（引数に無い）
 *
 * @param accumNorm  水みちタイル R（log 正規化した上流集水、[0,1]）
 * @param fillDepthM 水みちタイル B（窪地の充填深 [m]、窪地でなければ 0）
 * @param intensity  `rainfallIntensity(effectiveRainfallMm(...))`
 */
export function rainfallRelativeRisk(
  accumNorm: number, fillDepthM: number, intensity: number,
): number {
  if (!(intensity > 0)) return 0
  const a = clamp(accumNorm, 0, 1)
  const pond = clamp(Math.max(0, fillDepthM) * RAINFALL_RISK_POND_DEPTH_SCALE, 0, 1)
  return intensity * (RAINFALL_RISK_ACCUM_WEIGHT * a + RAINFALL_RISK_POND_WEIGHT * pond)
}
