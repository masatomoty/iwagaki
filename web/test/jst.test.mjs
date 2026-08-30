// formatJst が実行環境の TZ に依らず JST（UTC+9）で時刻を出すことの確認。
// src の TS を Node 24 の型除去でそのまま読む。
//
//   pnpm test

import assert from 'node:assert/strict'
import { formatJst } from '../src/domain/tideSeries.ts'

// 2026-08-09 00:00 UTC = 09:00 JST。TZ=UTC でも JST の日付・時刻になる
const t = Date.UTC(2026, 7, 9, 0, 0)
assert.equal(formatJst(t), '08-09 09:00')

// 日付境界。2026-08-09 15:30 UTC = 08-10 00:30 JST
assert.equal(formatJst(Date.UTC(2026, 7, 9, 15, 30)), '08-10 00:30')

console.log('ok formatJst は JST 固定')
