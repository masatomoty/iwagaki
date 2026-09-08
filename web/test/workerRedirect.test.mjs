// 配信エントリ Worker（deploy/worker.js）のドメイン振り分けのテスト。
// 旧 *.workers.dev は正規ドメインへ 301、正規ドメイン・localhost はリダイレクトしない。
//
//   pnpm test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../deploy/worker.js'

/** env は使わない経路だけを叩く（R2・ASSETS には到達しない） */
const call = (u) => worker.fetch(new Request(u), {})

test('旧 workers.dev は同じパス・クエリで正規ドメインへ 301', async () => {
  const res = await call('https://iwagaki-viewer.tonbo.workers.dev/report/?intro=1')
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('location'), 'https://maizuru.oniyanma.jp/report/?intro=1')
})

test('別の workers.dev サブドメインでも 301', async () => {
  const res = await call('https://iwagaki-viewer.example.workers.dev/')
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('location'), 'https://maizuru.oniyanma.jp/')
})

test('正規ドメインの静的パスはリダイレクトしない（ASSETS へ委譲する手前で 301 を出さない）', async () => {
  // env.ASSETS が無いので委譲時に投げる。301 を返さないことだけ確認する
  await assert.rejects(call('https://maizuru.oniyanma.jp/'), (e) => !(e instanceof Response))
})

test('localhost（wrangler dev / check.mjs）はリダイレクトしない', async () => {
  await assert.rejects(call('http://localhost:8788/'), (e) => !(e instanceof Response))
})
