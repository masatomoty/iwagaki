#!/usr/bin/env node
// production 相当の静的配信。計測の結論は配信条件に強く依存するので、
// Cloudflare に載せたときと同じ性質を再現する（docs/WEB_DESIGN.md §9.2）。
//
//   - HTTP/2（既定。自己署名 TLS）と HTTP/1.1（--http1）を切り替えられる
//   - Range に 206 を返す
//   - br / gzip を事前圧縮してメモリに持つ
//   - content 不変アセットは immutable
//
// Cloudflare Pages は Range に 200 を返す（206 非対応）ので、COPC は R2 配信になる。
// ここではその条件差を「記録した上で」正しい 206 を返す。

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import http2 from 'node:http2'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, 'dist')
const CERT_DIR = path.join(HERE, '.certs')
const args = process.argv.slice(2)
const HTTP1 = args.includes('--http1')
const PORT = Number(args.find((a) => a.startsWith('--port='))?.slice(7) ?? (HTTP1 ? 8443 : 8443))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8', '.png': 'image/png',
  '.wasm': 'application/wasm', '.b3dm': 'application/octet-stream',
  '.laz': 'application/octet-stream', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.geojson', '.wasm', '.map', '.svg'])

/** 事前圧縮。リクエスト時に圧縮すると初回だけ遅くなって計測が濁る */
const precompressed = new Map()
async function precompress(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { await precompress(p); continue }
    const ext = path.extname(e.name)
    if (!COMPRESSIBLE.has(ext)) continue
    const buf = await readFile(p)
    if (buf.length < 512) continue
    precompressed.set(p, {
      mtimeMs: statSync(p).mtimeMs,
      br: zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
      }),
      gzip: zlib.gzipSync(buf, { level: 8 }),
    })
  }
}

function ensureCert() {
  const key = path.join(CERT_DIR, 'key.pem')
  const crt = path.join(CERT_DIR, 'cert.pem')
  if (existsSync(key) && existsSync(crt)) return { key: readFileSync(key), cert: readFileSync(crt) }
  execFileSync('mkdir', ['-p', CERT_DIR])
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
    '-keyout', key, '-out', crt, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })
  return { key: readFileSync(key), cert: readFileSync(crt) }
}

function cacheControl(rel) {
  if (rel === '/index.html' || rel.endsWith('catalog.json')) return 'no-cache'
  return 'public, max-age=31536000, immutable'
}

function handle(req, res) {
  const url = new URL(req.url, 'https://x')
  let rel = decodeURIComponent(url.pathname)
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.join(ROOT, rel)
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  const ext = path.extname(file)
  const type = MIME[ext] ?? 'application/octet-stream'
  const st = statSync(file)
  const headers = {
    'content-type': type,
    'cache-control': cacheControl(rel),
    'accept-ranges': 'bytes',
    'timing-allow-origin': '*',
  }

  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!m) {
      // R2 と同じくマルチレンジは受け付けない（docs/WEB_DESIGN.md §4.4）
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('multi-range not supported')
      return
    }
    const start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1])
    const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1)
    if (start >= st.size || start > end) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${st.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': end - start + 1,
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }

  let pc = precompressed.get(file)
  // rebuild 後に古い圧縮結果を返すと、存在しない JS を index.html が指してしまう
  if (pc && pc.mtimeMs !== st.mtimeMs) { precompressed.delete(file); pc = undefined }
  const accept = String(req.headers['accept-encoding'] ?? '')
  if (pc && accept.includes('br')) {
    res.writeHead(200, { ...headers, 'content-encoding': 'br', 'content-length': pc.br.length, vary: 'accept-encoding' })
    res.end(pc.br)
    return
  }
  if (pc && accept.includes('gzip')) {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': pc.gzip.length, vary: 'accept-encoding' })
    res.end(pc.gzip)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  createReadStream(file).pipe(res)
}

if (!existsSync(ROOT)) {
  console.error(`dist/ が無い。先に \`npm run build\` を実行する`)
  process.exit(1)
}
await precompress(ROOT)

const server = HTTP1
  ? http.createServer(handle)
  : http2.createSecureServer({ ...ensureCert(), allowHTTP1: true }, handle)

server.listen(PORT, () => {
  const scheme = HTTP1 ? 'http' : 'https'
  console.log(`${scheme}://localhost:${PORT}  (${HTTP1 ? 'HTTP/1.1' : 'HTTP/2 + TLS'})`)
  console.log(`precompressed ${precompressed.size} files`)
})
