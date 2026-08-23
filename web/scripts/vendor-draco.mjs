#!/usr/bin/env node
// Draco のデコーダを **自分のオリジンから** 配れるように public/ へ複製する。
//
// なぜ要るか: PLATEAU の b3dm は 44 枚すべて `KHR_draco_mesh_compression` 付きで、
// Draco は必須である。ところが loaders.gl は既定で
//   unpkg.com/@loaders.gl/draco@x/dist/libs/draco_wasm_wrapper.js  (59 kB)
//   unpkg.com/@loaders.gl/draco@x/dist/libs/draco_decoder.wasm     (283 kB)
// を **worker 1 本につき 1 組** 取りに行く。実測で 3 本 x 342 kB = 1.03 MB。
// 1 Mbps なら 8 秒分で、しかもクロスオリジンでは `transferSize` が 0 になるため
// こちらの転送量計測に映らない（docs/web_results.md）。
//
// 置き場所を loaders.gl の規約に合わせる。`options.CDN` を指定すると
//   `${CDN}/draco@${loaders.gl のバージョン}/dist/libs/${ファイル名}`
// を引くので、**そのとおりのディレクトリを作る**。バージョンがパスに入るので
// `_headers` で immutable にしてよい（上げたら URL が変わる）。
//
// `options.modules` に URL を直接渡す道もあるが、worker へ渡る途中で
// 落ちて既定の CDN に戻ることを実測で確認したので使わない。

import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..')
// draco は 3d-tiles の依存だが、ここで中身を取り出すので package.json に直接書く
// （pnpm は間接依存を node_modules 直下に置かない）
const SRC = path.join(WEB, 'node_modules/@loaders.gl/draco')
const VENDOR = path.join(WEB, 'public/vendor')
const FILES = ['draco_wasm_wrapper.js', 'draco_decoder.wasm']

const { version } = JSON.parse(await readFile(path.join(SRC, 'package.json'), 'utf8'))
const dest = path.join(VENDOR, `draco@${version}/dist/libs`)

// 古いバージョンを残さない。immutable で配るので、消し忘れると増え続ける
await mkdir(VENDOR, { recursive: true })
for (const e of await readdir(VENDOR, { withFileTypes: true })) {
  if (e.isDirectory() && e.name.startsWith('draco@') && e.name !== `draco@${version}`) {
    await rm(path.join(VENDOR, e.name), { recursive: true, force: true })
  }
}

await mkdir(dest, { recursive: true })
for (const f of FILES) {
  await copyFile(path.join(SRC, 'dist/libs', f), path.join(dest, f))
}
console.log(`vendor: public/vendor/draco@${version}/dist/libs/ <- ${FILES.join(', ')}`)
