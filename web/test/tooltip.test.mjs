// ツールチップ（`docs/todo.md` U2）の位置決め純関数 `placeTip` の確認。
// 見るのは上下フリップと左右クランプだけ。src の TS を Node の型除去でそのまま読む
// （`jst.test.mjs` と同じ）。
//
//   node --test test/tooltip.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import { placeTip } from '../src/ui/tooltip.ts'

const VP = { w: 1000, h: 700 }
const TIP = { w: 200, h: 60 }
// tooltip.ts の内部定数（GAP=8 / MARGIN=6）に合わせた期待値

test('既定はトリガーの上、中央そろえ', () => {
  const r = { left: 400, top: 300, width: 80, height: 24 }
  const p = placeTip(r, TIP, VP)
  assert.equal(p.placement, 'top')
  assert.equal(p.y, 300 - 8 - 60) // 上端 − GAP − 高さ
  assert.equal(p.x, 440 - 100)    // トリガー中央 − 幅の半分
})

test('上に収まらなければ下へフリップ', () => {
  const r = { left: 400, top: 10, width: 80, height: 24 }
  const p = placeTip(r, TIP, VP)
  assert.equal(p.placement, 'bottom')
  assert.equal(p.y, 10 + 24 + 8) // 下端 + GAP
})

test('左端でクランプ（MARGIN で止まる）', () => {
  const r = { left: 0, top: 300, width: 20, height: 20 }
  const p = placeTip(r, TIP, VP)
  assert.equal(p.x, 6)
})

test('右端でクランプ', () => {
  const r = { left: 980, top: 300, width: 20, height: 20 }
  const p = placeTip(r, TIP, VP)
  assert.equal(p.x, VP.w - TIP.w - 6) // 794
})

test('上下どちらにも収まらないときは上端で切れない', () => {
  const tall = { w: 200, h: 680 }
  const r = { left: 400, top: 10, width: 80, height: 24 }
  const p = placeTip(r, tall, VP)
  assert.ok(p.y >= 6)
  assert.ok(p.y + tall.h <= VP.h)
})
