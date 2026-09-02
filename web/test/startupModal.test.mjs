// 起動時モーダル（`docs/todo.md` U6）の判断ロジック。
// DOM は張らず、純関数だけ見る（`tooltip.test.mjs` と同じ方針。src の TS を
// Node の型除去でそのまま読む）。
//
//   node --test test/startupModal.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planStartupApply, startupShouldShow, pickStartupTide, resolveCarriedModel,
} from '../src/ui/startupModal.ts'

test('対象地域が同じ → その場で反映（読み直さない）', () => {
  const p = planStartupApply(
    { areaId: 'yoshiwara', floodModel: 'simple', waterLevel: 0.69 }, 'yoshiwara')
  assert.equal(p.reload, false)
  assert.deepEqual(p.patch, { floodModel: 'simple', waterLevel: 0.69 })
  assert.equal(p.carry, undefined)
})

test('対象地域が違う → 読み直し＋選択の退避', () => {
  const p = planStartupApply(
    { areaId: 'higashi_maizuru', floodModel: 'connected', waterLevel: 0.93 }, 'yoshiwara')
  assert.equal(p.reload, true)
  assert.equal(p.areaId, 'higashi_maizuru')
  assert.deepEqual(p.carry, { floodModel: 'connected', waterLevel: 0.93 })
  assert.equal(p.patch, undefined)
})

test('areaId が空なら現在地のまま（読み直さない）', () => {
  const p = planStartupApply(
    { areaId: '', floodModel: 'simple', waterLevel: 0.5 }, 'yoshiwara')
  assert.equal(p.reload, false)
})

test('startupShouldShow: forced が最優先', () => {
  assert.equal(startupShouldShow({ forced: true, dismissed: true, automated: true }), true)
  assert.equal(startupShouldShow({ forced: false, dismissed: false, automated: false }), false)
})

test('startupShouldShow: 自動化ブラウザでは出さない', () => {
  assert.equal(startupShouldShow({
    forced: null, hasParameters: false, dismissed: false, automated: true,
  }), false)
})

test('startupShouldShow: 既定は出す、「次回から表示しない」で伏せる', () => {
  assert.equal(startupShouldShow({
    forced: null, hasParameters: false, dismissed: false, automated: false,
  }), true)
  assert.equal(startupShouldShow({
    forced: null, hasParameters: false, dismissed: true, automated: false,
  }), false)
})

test('startupShouldShow: URLパラメータ付きでは初期パネルを出さない', () => {
  assert.equal(startupShouldShow({
    forced: null, hasParameters: true, dismissed: false, automated: false,
  }), false)
  // 明示的な再表示はURLパラメータより優先する
  assert.equal(startupShouldShow({
    forced: true, hasParameters: true, dismissed: true, automated: false,
  }), true)
})

test('pickStartupTide: 望ましいキーがあればその値、上から順', () => {
  const refs = [['MSL', 0.31], ['高潮想定の基準潮位', 0.69], ['既往最高潮位', 0.93]]
  assert.equal(pickStartupTide(refs, ['高潮想定の基準潮位', '既往最高潮位'], 0.31), 0.69)
  assert.equal(pickStartupTide(refs, ['存在しない', '既往最高潮位'], 0.31), 0.93)
})

test('pickStartupTide: どれも無ければ fallback', () => {
  const refs = [['MSL', 0.31]]
  assert.equal(pickStartupTide(refs, ['高潮想定の基準潮位'], 0.31), 0.31)
})

test('resolveCarriedModel: drainage は仮想排水路タイルの無い範囲で connected に落ちる', () => {
  assert.equal(resolveCarriedModel('drainage', false), 'connected')
  assert.equal(resolveCarriedModel('drainage', true), 'drainage')
  assert.equal(resolveCarriedModel('simple', false), 'simple')
  assert.equal(resolveCarriedModel('connected', false), 'connected')
})
