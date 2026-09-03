// 雨量シナリオと「簡易内水リスク」（`src/domain/rainfall.ts`）。
// `waterLevel.test.mjs` と同じく、src の TS を Node の型除去でそのまま読む。
//
//   node --test test/rainfall.test.mjs
//
// 押さえるもの（依頼の「テスト」節）:
//  - 雨量シナリオの定義・選択
//  - カスタム雨量のバリデーション
//  - 雨量 0 でリスクが発生しないこと
//  - 雨量が増えるとリスク値が単調に増えること
//  - catchment（水みち）と雨量リスクの計算を混同していないこと
//  - 既存の高潮浸水判定（`domain/flood.ts`）が変わらないこと

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CUSTOM_DURATION_MAX_HOURS, CUSTOM_RAINFALL_MAX_MM, CUSTOM_SCENARIO_ID,
  DEFAULT_RUNOFF_COEFFICIENT, MAIZURU_RAINFALL_RECORDS, NO_RAIN_SCENARIO_ID,
  RAINFALL_RISK_POND_DEPTH_SCALE, RAINFALL_RISK_POND_WEIGHT, RAINFALL_SCENARIOS,
  RUNOFF_PRESETS, effectiveRainRateMmPerH, effectiveRainfallMm, initialRainfallState,
  rainfallIntensity, rainfallRelativeRisk, resolveRainfallScenario, validateCustomRainfall,
} from '../src/domain/rainfall.ts'
import { depth, ponded, wet } from '../src/domain/flood.ts'

// --- 1. シナリオの定義 ---------------------------------------------------

test('RAINFALL_SCENARIOS: none / custom を含み、id は一意', () => {
  const ids = RAINFALL_SCENARIOS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'id が重複している')
  assert.ok(ids.includes(NO_RAIN_SCENARIO_ID))
  assert.ok(ids.includes(CUSTOM_SCENARIO_ID))
  for (const s of RAINFALL_SCENARIOS) {
    assert.ok(Number.isFinite(s.rainfallMm) && s.rainfallMm >= 0, `${s.id}: rainfallMm`)
    assert.ok(Number.isFinite(s.durationHours) && s.durationHours >= 0, `${s.id}: durationHours`)
    assert.equal(typeof s.label, 'string')
  }
  assert.equal(RAINFALL_SCENARIOS.find((s) => s.id === NO_RAIN_SCENARIO_ID).rainfallMm, 0)
})

test('観測史上値のシナリオは舞鶴観測所の記録と一致し、出典を持つ', () => {
  const by = (id) => RAINFALL_SCENARIOS.find((s) => s.id === id)
  assert.equal(by('h1_max').rainfallMm, MAIZURU_RAINFALL_RECORDS.h1.mm)   // 65.5
  assert.equal(by('h3_max').rainfallMm, MAIZURU_RAINFALL_RECORDS.h3.mm)   // 129.5
  assert.equal(by('h24_max').rainfallMm, MAIZURU_RAINFALL_RECORDS.h24.mm) // 312.0
  for (const id of ['h1_max', 'h3_max', 'h24_max']) {
    assert.match(by(id).source ?? '', /jma\.go\.jp/, `${id}: 出典 URL`)
  }
})

test('「観測史上を上回る」と説明するのは実際に記録を超えるシナリオだけ', () => {
  const rec = { 1: MAIZURU_RAINFALL_RECORDS.h1.mm, 3: MAIZURU_RAINFALL_RECORDS.h3.mm,
    24: MAIZURU_RAINFALL_RECORDS.h24.mm }
  for (const s of RAINFALL_SCENARIOS) {
    if (!s.description || !/上回る/.test(s.description)) continue
    const r = rec[s.durationHours]
    assert.ok(r !== undefined && s.rainfallMm > r,
      `${s.id}: 「上回る」と書いてあるが ${s.rainfallMm}mm ≤ 記録 ${r}mm`)
  }
  // h3_100 / h24_200 は記録未満なので「上回る」と書いていない
  assert.doesNotMatch(RAINFALL_SCENARIOS.find((s) => s.id === 'h3_100').description, /上回る/)
  assert.doesNotMatch(RAINFALL_SCENARIOS.find((s) => s.id === 'h24_200').description, /上回る/)
})

// --- 2. シナリオの選択 -------------------------------------------------

test('resolveRainfallScenario: 既知 id はその定義、未知 id は先頭（雨量なし）', () => {
  const st = initialRainfallState()
  assert.equal(resolveRainfallScenario({ ...st, scenarioId: 'h3_max' }).rainfallMm, 129.5)
  assert.equal(resolveRainfallScenario({ ...st, scenarioId: 'bogus' }).id, RAINFALL_SCENARIOS[0].id)
})

test('resolveRainfallScenario: custom は state の値を検証して使う', () => {
  const sc = resolveRainfallScenario({
    scenarioId: CUSTOM_SCENARIO_ID, customMm: 123.4, customHours: 6,
    runoffCoefficient: 0.5,
  })
  assert.equal(sc.id, CUSTOM_SCENARIO_ID)
  assert.equal(sc.rainfallMm, 123.4)
  assert.equal(sc.durationHours, 6)
  // 範囲外の custom は安全側にクランプされる
  const clamped = resolveRainfallScenario({
    scenarioId: CUSTOM_SCENARIO_ID, customMm: -5, customHours: 999,
    runoffCoefficient: 0.5,
  })
  assert.equal(clamped.rainfallMm, 0)
  assert.equal(clamped.durationHours, CUSTOM_DURATION_MAX_HOURS)
})

test('RUNOFF_PRESETS と既定値', () => {
  assert.ok(RUNOFF_PRESETS.length >= 2)
  for (const p of RUNOFF_PRESETS) {
    assert.ok(p.coefficient > 0 && p.coefficient <= 1, `${p.id}: coefficient`)
  }
  assert.ok(RUNOFF_PRESETS.some((p) => p.coefficient === DEFAULT_RUNOFF_COEFFICIENT))
})

// --- 3. カスタム雨量のバリデーション ---------------------------------

test('validateCustomRainfall: 正常値は ok、丸めた採用値を返す', () => {
  const r = validateCustomRainfall({ rainfallMm: 80.25, durationHours: 3 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
  assert.equal(r.value.rainfallMm, 80.3)   // 0.1 mm 丸め
  assert.equal(r.value.durationHours, 3)
})

test('validateCustomRainfall: 異常値はエラー＋安全側の値', () => {
  const neg = validateCustomRainfall({ rainfallMm: -1, durationHours: 1 })
  assert.equal(neg.ok, false)
  assert.equal(neg.value.rainfallMm, 0)

  const nan = validateCustomRainfall({ rainfallMm: Number.NaN, durationHours: 1 })
  assert.equal(nan.ok, false)
  assert.equal(nan.value.rainfallMm, 0)

  const over = validateCustomRainfall({ rainfallMm: 9999, durationHours: 1 })
  assert.equal(over.ok, false)
  assert.equal(over.value.rainfallMm, CUSTOM_RAINFALL_MAX_MM)

  const zeroH = validateCustomRainfall({ rainfallMm: 50, durationHours: 0 })
  assert.equal(zeroH.ok, false)
  assert.equal(zeroH.value.durationHours, 1)

  const longH = validateCustomRainfall({ rainfallMm: 50, durationHours: 500 })
  assert.equal(longH.ok, false)
  assert.equal(longH.value.durationHours, CUSTOM_DURATION_MAX_HOURS)
})

// --- 4. 実効雨量と強さ ------------------------------------------------

test('effectiveRainfallMm = 雨量 × 流出率（C は [0,1]、負の雨量は 0）', () => {
  const sc = (mm) => ({ id: 'x', label: 'x', durationHours: 1, rainfallMm: mm })
  assert.equal(effectiveRainfallMm(sc(100), 0.7), 70)
  assert.equal(effectiveRainfallMm(sc(100), 0), 0)
  assert.equal(effectiveRainfallMm(sc(100), 5), 100)   // C > 1 は 1 に
  assert.equal(effectiveRainfallMm(sc(-100), 0.7), 0)
})

test('effectiveRainRateMmPerH = 実効雨量 / 継続時間（D<=0 は 0）', () => {
  assert.equal(effectiveRainRateMmPerH(60, 3), 20)
  assert.equal(effectiveRainRateMmPerH(60, 0), 0)   // 雨量なし（D=0）
  assert.equal(effectiveRainRateMmPerH(0, 24), 0)
})

test('rainfallIntensity: E=0 で 0、E について厳密単調増加（継続時間固定）', () => {
  assert.equal(rainfallIntensity(0, 1), 0)
  assert.equal(rainfallIntensity(0, 24), 0)
  let prev = -1
  for (const mm of [0, 10, 50, 100, 200, 300, 400]) {
    const v = rainfallIntensity(mm, 3)
    assert.ok(v > prev, `intensity(${mm}mm/3h) が増えていない`)
    prev = v
  }
})

test('rainfallIntensity: 同じ実効雨量なら継続時間が短いほど大きい', () => {
  const E = 90
  const short = rainfallIntensity(E, 1)
  const mid = rainfallIntensity(E, 3)
  const long = rainfallIntensity(E, 24)
  assert.ok(short > mid && mid > long, `${short} > ${mid} > ${long} でない`)
  // 継続時間はゼロ寄与にはならない（総量の項は残る）
  assert.ok(long > 0)
})

// --- 5. 雨量 0 でリスクが発生しない ----------------------------------

const intensityOf = (scenario, runoff) =>
  rainfallIntensity(effectiveRainfallMm(scenario, runoff), scenario.durationHours)

test('雨量 0（intensity 0）なら、集水・窪地がどうであれリスクは 0', () => {
  const none = resolveRainfallScenario(initialRainfallState())
  const intensity = intensityOf(none, DEFAULT_RUNOFF_COEFFICIENT)
  assert.equal(intensity, 0)
  for (const accum of [0, 0.5, 1]) {
    for (const fill of [0, 0.3, 1]) {
      assert.equal(rainfallRelativeRisk(accum, fill, intensity), 0,
        `accum=${accum} fill=${fill} でリスクが出た`)
    }
  }
  // 流出率 0 でも同じ
  assert.equal(
    rainfallRelativeRisk(1, 1, intensityOf(
      { id: 'x', label: 'x', durationHours: 1, rainfallMm: 100 }, 0)),
    0)
})

// --- 6. 雨量が増えるとリスクが単調に増える -------------------------

test('リスクは雨量について単調増加（同じ継続時間で雨量だけ増やす）', () => {
  // 固定した地形（集水 0.6・窪地 0.2 m）の 1 セル、継続 3 時間・流出率 0.65 固定で
  // 雨量だけ 0 → 300 mm と増やす
  const ACCUM = 0.6
  const FILL = 0.2
  const C = 0.65
  let prev = -1
  for (const mm of [0, 10, 30, 60, 100, 150, 220, 300]) {
    const sc = { id: 'x', label: 'x', durationHours: 3, rainfallMm: mm }
    const risk = rainfallRelativeRisk(ACCUM, FILL, intensityOf(sc, C))
    if (mm === 0) assert.equal(risk, 0)
    else assert.ok(risk > prev, `雨量 ${mm}mm でリスクが増えていない: ${risk} <= ${prev}`)
    prev = risk
  }
})

test('リスクは「雨の強さ」について単調（既定シナリオを intensity 順に並べて確認）', () => {
  const st = initialRainfallState()
  const ordered = RAINFALL_SCENARIOS
    .filter((s) => s.id !== CUSTOM_SCENARIO_ID)
    .map((s) => ({ s, i: intensityOf(s, st.runoffCoefficient) }))
    .sort((a, b) => a.i - b.i)
  const ACCUM = 0.6
  const FILL = 0.2
  let prev = -1
  for (const { s, i } of ordered) {
    const risk = rainfallRelativeRisk(ACCUM, FILL, i)
    if (i === 0) assert.equal(risk, 0)
    else assert.ok(risk >= prev, `${s.id}（intensity ${i.toFixed(3)}）で減った: ${risk} < ${prev}`)
    prev = risk
  }
})

test('リスクは intensity / accum / fill それぞれについて単調', () => {
  // intensity（＝雨量）
  assert.ok(rainfallRelativeRisk(0.5, 0.1, 0.2) < rainfallRelativeRisk(0.5, 0.1, 0.6))
  // accum（集水）
  assert.ok(rainfallRelativeRisk(0.2, 0.1, 0.5) < rainfallRelativeRisk(0.8, 0.1, 0.5))
  // fill（窪地の充填深）
  assert.ok(rainfallRelativeRisk(0.5, 0.0, 0.5) < rainfallRelativeRisk(0.5, 0.4, 0.5))
})

// --- 7. catchment と雨量リスクを混同していない ---------------------

test('雨量リスクは「水みちの値の素通し」ではない', () => {
  const accum = 0.7
  // 同じ集水でも、雨量（intensity）が違えばリスクは違う
  const low = rainfallRelativeRisk(accum, 0, 0.2)
  const high = rainfallRelativeRisk(accum, 0, 0.8)
  assert.ok(high > low)
  // intensity 0 では、水みちの値が最大でもリスクは 0（catchment 表示 ≠ リスク）
  assert.equal(rainfallRelativeRisk(1, 0, 0), 0)
  // 雨量リスクの関数は潮位・h_conn を引数に取らない（海水浸水と別軸）
  assert.equal(rainfallRelativeRisk.length, 3)
})

// --- 8. 既存の高潮浸水判定が変わっていない -------------------------
//
// `domain/rainfall.ts` は `domain/flood.ts` を import しない。念のため
// 既存モデルの代表値を固定して、リグレッションが無いことを見張る。

test('domain/flood.ts の判定は従来どおり（雨量モジュール追加の影響なし）', () => {
  // 単純モデル: 浸水深 = max(0, 潮位 - 地盤高)、連結性は問わない
  assert.equal(depth(0.5, undefined, 1.0, 'simple'), 0.5)
  assert.equal(depth(1.5, undefined, 1.0, 'simple'), 0)
  // 連結モデル: h_conn <= 潮位 のときだけ深さが付く
  assert.equal(depth(0.5, 0.8, 1.0, 'connected'), 0.5)
  assert.equal(depth(0.5, 1.2, 1.0, 'connected'), 0)   // 海とつながっていない
  assert.equal(wet(0.8, 1.0), true)
  assert.equal(wet(1.2, 1.0), false)
  // 窪地: connected のときだけ存在する状態
  assert.equal(ponded(0.5, 1.2, 1.0, 'connected'), true)
  assert.equal(ponded(0.5, 1.2, 1.0, 'simple'), false)
})

// --- 9. GLSL 側（three/floodMaterial.ts）との式の一致 -------------
//
// parity.test.mjs と同じ方針で、シェーダの式を二重化して domain と突き合わせる。
// FS: pond = clamp(fill * 2.0, 0, 1); risk = intensity * (1.0*clamp(accum,0,1) + 0.6*pond)

test('シェーダの相対リスク式が domain/rainfall.ts と一致する', () => {
  const glsl = (accum, fill, intensity) => {
    if (!(intensity > 0)) return 0
    const pond = Math.min(1, Math.max(0, fill * RAINFALL_RISK_POND_DEPTH_SCALE))
    return intensity * (1.0 * Math.min(1, Math.max(0, accum)) + RAINFALL_RISK_POND_WEIGHT * pond)
  }
  for (const accum of [0, 0.25, 0.6, 1, 1.4]) {
    for (const fill of [0, 0.1, 0.5, 1.2]) {
      for (const intensity of [0, 0.15, 0.5, 1.04]) {
        const a = rainfallRelativeRisk(accum, fill, intensity)
        const b = glsl(accum, fill, intensity)
        assert.ok(Math.abs(a - b) < 1e-12,
          `accum=${accum} fill=${fill} intensity=${intensity}: ${a} vs ${b}`)
      }
    }
  }
})
