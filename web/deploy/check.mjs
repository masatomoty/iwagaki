#!/usr/bin/env node
// デプロイ後の配信条件を実測する。
//
// ローカル（web/serve.mjs）と Cloudflare は配信条件が違い、結論は配信条件に強く依存する
// （docs/PLATFORM.md）。ここで確認するのは主に次の 3 点:
//
//   1. COPC が本当に 206 + 正しい Content-Range を返すか（返さなければ COPC の意味が消える）
//   2. Workers Assets が Range をどう扱うか（206 か 200 か。docs では [未確認] のまま）
//   3. 圧縮とキャッシュ制御が意図どおりか（geojson が br で来るか、immutable が付くか）
//
//   node deploy/check.mjs https://iwagaki-viewer.<subdomain>.workers.dev
//
// MUST が 1 つでも落ちたら exit 1。RECORD は測って出すだけ（合否判定しない）。
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, '..', 'dist')

const base = process.argv[2]?.replace(/\/+$/, '')
if (!base) {
  console.error('使い方: node deploy/check.mjs <配信 URL>')
  process.exit(2)
}

const results = []
function record(kind, name, ok, detail) {
  results.push({ kind, name, ok, detail })
  const mark = kind === 'RECORD' ? '·' : ok ? 'ok' : 'NG'
  console.log(`${mark.padStart(3)}  ${name}  ${detail}`)
}
const must = (name, ok, detail) => record('MUST', name, ok, detail)
const note = (name, detail) => record('RECORD', name, true, detail)

const url = (rel) => `${base}/${rel.replace(/^\//, '')}`
async function get(rel, headers = {}) {
  const res = await fetch(url(rel), { headers, redirect: 'manual' })
  const buf = Buffer.from(await res.arrayBuffer())
  return { res, buf }
}
const h = (res, name) => res.headers.get(name) ?? '-'
const enc = (res) => h(res, 'content-encoding')

// ---- 1. 入口 ----------------------------------------------------------------
{
  const { res } = await get('/')
  must('index.html', res.status === 200 && h(res, 'content-type').includes('text/html'),
    `${res.status} ${h(res, 'content-type')} cache-control=${h(res, 'cache-control')} enc=${enc(res)}`)
}

let catalog
{
  const { res, buf } = await get('data/catalog.json')
  try { catalog = JSON.parse(buf.toString('utf8')) } catch { /* 下で落ちる */ }
  must('catalog.json', res.status === 200 && catalog?.version === 1,
    `${res.status} version=${catalog?.version} cache-control=${h(res, 'cache-control')} enc=${enc(res)}`)
}
if (!catalog) { summary(); process.exit(1) }

// catalog の URL はすべて相対でなければならない。絶対 URL が混ざると
// クロスオリジンになり transferSize が 0 になる（docs/WEB_DESIGN.md「収集する量」）
{
  const urls = []
  JSON.stringify(catalog, (k, v) => { if (k === 'url' && typeof v === 'string') urls.push(v); return v })
  const absolute = urls.filter((u) => /^[a-z]+:\/\//i.test(u))
  must('catalog の url が全て相対（同一オリジン）', absolute.length === 0,
    `${urls.length} 件中 絶対 URL ${absolute.length} 件 ${absolute.join(' ') }`)
}

// ---- 2. COPC = R2 経由。Range が本題 ---------------------------------------
const copcUrl = catalog.pointcloud?.url
const copcSize = catalog.pointcloud?.bytes
if (!copcUrl) {
  must('catalog に pointcloud.url がある', false, '無い')
} else {
  {
    const res = await fetch(url(copcUrl), { method: 'HEAD' })
    must('COPC HEAD', res.status === 200 && Number(h(res, 'content-length')) === copcSize,
      `${res.status} content-length=${h(res, 'content-length')} (catalog=${copcSize}) accept-ranges=${h(res, 'accept-ranges')}`)
    note('COPC ヘッダ', `cache-control=${h(res, 'cache-control')} etag=${h(res, 'etag')} content-type=${h(res, 'content-type')}`)
  }
  {
    const { res, buf } = await get(copcUrl, { range: 'bytes=0-1023' })
    must('COPC Range 先頭 1 KiB -> 206',
      res.status === 206 && h(res, 'content-range') === `bytes 0-1023/${copcSize}` && buf.length === 1024,
      `${res.status} content-range=${h(res, 'content-range')} 実バイト=${buf.length}`)

    // 中身まで一致しているか（dist にローカル実体があれば突き合わせる）
    const local = path.join(DIST, copcUrl)
    if (await stat(local).then(() => true, () => false)) {
      const want = (await readFile(local)).subarray(0, 1024)
      must('COPC Range の中身がローカル実体と一致', Buffer.compare(want, buf) === 0,
        buf.length === 1024 ? (Buffer.compare(want, buf) === 0 ? 'byte 一致' : '不一致') : 'サイズ違い')
    }
  }
  {
    const { res, buf } = await get(copcUrl, { range: 'bytes=-4096' })
    const start = copcSize - 4096
    must('COPC 末尾指定 (bytes=-4096) -> 206',
      res.status === 206 && h(res, 'content-range') === `bytes ${start}-${copcSize - 1}/${copcSize}` && buf.length === 4096,
      `${res.status} content-range=${h(res, 'content-range')} 実バイト=${buf.length}`)
  }
  {
    const { res } = await get(copcUrl, { range: `bytes=${copcSize}-` })
    must('COPC 範囲外 -> 416', res.status === 416 && h(res, 'content-range') === `bytes */${copcSize}`,
      `${res.status} content-range=${h(res, 'content-range')}`)
  }
  {
    // マルチレンジは R2 も対応しない。黙って全体を返されるのが最悪（14 MB が毎回落ちてくる）
    const { res, buf } = await get(copcUrl, { range: 'bytes=0-99, 200-299' })
    must('COPC マルチレンジ -> 全体を返さない', res.status !== 200 || buf.length < copcSize,
      `${res.status} 実バイト=${buf.length}`)
  }
}

// ---- 3. Workers Assets 側の Range 挙動（docs の [未確認] を測る）------------
{
  const tileRel = sampleTile(catalog)
  if (tileRel) {
    const plain = await get(tileRel)
    // _headers が読まれないと既定の max-age=0, must-revalidate に静かに戻る
    must('terrain タイルが immutable（_headers が効いている）',
      plain.res.status === 200 && h(plain.res, 'cache-control').includes('immutable'),
      `${plain.res.status} ${plain.buf.length} B cache-control=${h(plain.res, 'cache-control')} cf-cache-status=${h(plain.res, 'cf-cache-status')}`)
    const ranged = await get(tileRel, { range: 'bytes=0-99' })
    note('Workers Assets の Range 挙動',
      `status=${ranged.res.status} content-range=${h(ranged.res, 'content-range')} 実バイト=${ranged.buf.length}/${plain.buf.length}`
      + (ranged.res.status === 206 ? '  → 206 を返す' : '  → 206 ではない（COPC を assets に置けない根拠）'))
  } else {
    note('terrain タイル', 'catalog から標本タイルを決められなかった')
  }
}

// ---- 4. 圧縮とキャッシュ ----------------------------------------------------
{
  const { res, buf } = await get('data/objects.geojson', { 'accept-encoding': 'br, gzip' })
  const wire = Number(h(res, 'content-length'))
  // 570 kB の geojson は first_meaningful_render の 2 割を占めうる（docs/WEB_DESIGN.md「アセットの形式」）。
  // application/geo+json が Cloudflare の圧縮対象から外れると静かに効く
  must('objects.geojson が圧縮されて来る', res.status === 200 && enc(res) !== '-',
    `${res.status} enc=${enc(res)} wire=${Number.isFinite(wire) ? wire : '?'} B / 実体 ${buf.length} B cache-control=${h(res, 'cache-control')}`)
}
{
  const tileset = catalog.plateau?.bldg_lod1?.url
  if (tileset) {
    const { res } = await get(tileset)
    note('3D Tiles tileset.json', `${res.status} enc=${enc(res)} cache-control=${h(res, 'cache-control')}`)
  }
}
{
  const js = await findAssetPath()
  if (js) {
    const { res, buf } = await get(js)
    note('bundle (js)', `${res.status} enc=${enc(res)} wire=${h(res, 'content-length')} B / 実体 ${buf.length} B cache-control=${h(res, 'cache-control')}`)
  }
}
{
  const { res } = await get('data/pointcloud/does-not-exist.copc.laz')
  must('存在しない COPC -> 404', res.status === 404, String(res.status))
}

summary()

function summary() {
  const fails = results.filter((r) => r.kind === 'MUST' && !r.ok)
  console.log()
  console.log(`MUST ${results.filter((r) => r.kind === 'MUST').length - fails.length}/${results.filter((r) => r.kind === 'MUST').length} 通過`)
  if (fails.length) {
    console.log('落ちた項目:')
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`)
    process.exitCode = 1
  }
}

/** AOI 中心の min_zoom タイルを slippy 座標で求める */
function sampleTile(cat) {
  const t = cat.terrain?.highres ?? cat.terrain?.baseline
  const centre = cat.aoi?.centre_wgs84
  if (!t?.url || !centre) return null
  const z = t.min_zoom ?? 14
  const [lon, lat] = centre
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const rad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  return t.url.replace('{z}', z).replace('{x}', x).replace('{y}', y)
}

/** index.html から実際に読まれる JS を 1 本拾う */
async function findAssetPath() {
  const { buf } = await get('/')
  const m = /src="([^"]*assets\/[^"]+\.js)"/.exec(buf.toString('utf8'))
  return m?.[1] ?? null
}
