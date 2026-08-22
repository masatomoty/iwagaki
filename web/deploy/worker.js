// COPC だけを R2 から Range 配信する Worker。
//
// なぜ必要か（docs/WEB_DESIGN.md §6.1）:
//   COPC は「必要なノードのバイト範囲だけ取る」ことが前提のフォーマットで、
//   Range に 200 を返す配信に置くと 1 ノードごとに 14 MB 全体が落ちてくる。
//   つまり COPC を採用した意味が消える。R2 は 206 を返すので、
//   そのパスだけ Worker から R2 binding を読む。
//
// 他のアセット（html / js / wasm / catalog / タイル / 3D Tiles / geojson）は
// Workers Assets が直接返す。ここには来ない（wrangler.jsonc の run_worker_first を参照）。
//
// ローカルの web/serve.mjs と振る舞いを揃える:
//   - 単一 Range に 206 + Content-Range
//   - 範囲外は 416 + `Content-Range: bytes */size`
//   - マルチレンジ（`bytes=a-b, c-d`）は 400。R2 の S3 API と同じで対応しない（同 §4.4）
//   - content 不変なので immutable

const R2_PREFIX = '/data/pointcloud/'
const IMMUTABLE = 'public, max-age=31536000, immutable'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (!url.pathname.startsWith(R2_PREFIX)) {
      // run_worker_first に載っていないパスは Asset Worker が先に処理する。
      // ここに来るのは「一致するアセットが無かった」場合だけ。
      return text(404, 'not found')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'method not allowed', { allow: 'GET, HEAD' })
    }

    // キーは URL パスと 1:1（先頭の / を落とすだけ）。デプロイ手順もこの規則で put する。
    const key = url.pathname.slice(1)
    if (key.includes('..')) return text(400, 'bad path')

    return serve(request, env.BUCKET, key)
  },
}

async function serve(request, bucket, key) {
  if (request.method === 'HEAD') {
    const head = await bucket.head(key)
    if (!head) return text(404, 'not found')
    const headers = objectHeaders(head)
    headers.set('content-length', String(head.size))
    return new Response(null, { status: 200, headers })
  }

  const rangeHeader = request.headers.get('range')
  if (!rangeHeader) return serveWhole(request, bucket, key)

  const range = parseRange(rangeHeader)
  if (!range) return text(400, 'multi-range not supported')

  // `bytes=-0` は「末尾 0 バイト」で常に unsatisfiable。R2 に渡す前に落とす
  if (range.suffix === 0) return unsatisfiable(bucket, key)

  let object
  try {
    object = await bucket.get(key, { range })
  } catch (e) {
    // R2 は範囲外を例外で返すことがある（10039 The requested range is not satisfiable）
    if (String(e?.message ?? e).toLowerCase().includes('range')) return unsatisfiable(bucket, key)
    throw e
  }
  if (!object) return text(404, 'not found')
  if (!object.body) {
    // 範囲外。size は full object のサイズなのでそのまま使える
    const headers = objectHeaders(object)
    headers.set('content-range', `bytes */${object.size}`)
    return new Response(null, { status: 416, headers })
  }

  const { start, end } = resolveRange(range, object.size)
  const headers = objectHeaders(object)
  headers.set('content-range', `bytes ${start}-${end}/${object.size}`)
  headers.set('content-length', String(end - start + 1))
  return new Response(object.body, { status: 206, headers })
}

async function serveWhole(request, bucket, key) {
  // 条件付き GET（reload 時のブラウザ再検証）だけは onlyIf に任せる
  const object = await bucket.get(key, { onlyIf: request.headers })
  if (!object) return text(404, 'not found')
  const headers = objectHeaders(object)
  if (!object.body) {
    const conditional = request.headers.has('if-none-match') || request.headers.has('if-modified-since')
    return new Response(null, { status: conditional ? 304 : 412, headers })
  }
  headers.set('content-length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}

async function unsatisfiable(bucket, key) {
  const head = await bucket.head(key)
  if (!head) return text(404, 'not found')
  const headers = objectHeaders(head)
  headers.set('content-range', `bytes */${head.size}`)
  return new Response(null, { status: 416, headers })
}

/** R2 のメタデータを載せてから、配信ポリシーで上書きする（順序が逆だと cache-control が負ける） */
function objectHeaders(object) {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('cache-control', IMMUTABLE)
  // 同一オリジン配信なら不要。将来 R2 を別ホストに割った時に transferSize を残すため
  headers.set('timing-allow-origin', '*')
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
  return headers
}

/**
 * 単一 Range のみ受ける。戻り値は R2Range。
 *   bytes=a-b -> { offset, length }   bytes=a- -> { offset }   bytes=-n -> { suffix }
 * マルチレンジ・不正な形式は null（呼び出し側で 400）。
 */
function parseRange(value) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!m) return null
  const [, from, to] = m
  if (from === '' && to === '') return null
  if (from === '') return { suffix: Number(to) }
  const offset = Number(from)
  if (to === '') return { offset }
  const last = Number(to)
  if (last < offset) return null
  return { offset, length: last - offset + 1 }
}

/** Content-Range に書く実際の [start, end]。R2 が返した範囲と同じ規則で解く */
function resolveRange(range, size) {
  if (range.suffix !== undefined) {
    return { start: Math.max(0, size - range.suffix), end: size - 1 }
  }
  const start = range.offset ?? 0
  const end = range.length === undefined ? size - 1 : Math.min(start + range.length - 1, size - 1)
  return { start, end }
}

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...extra },
  })
}
