// COPC だけを R2 から Range 配信する Worker。
//
// なぜ必要か（docs/platform.md）:
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
const TIDE_FORECAST_PATH = '/api/tide/maizuru'
const IMMUTABLE = 'public, max-age=31536000, immutable'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === TIDE_FORECAST_PATH) {
      if (request.method !== 'GET') return text(405, 'method not allowed', { allow: 'GET' })
      return handleTideForecast()
    }

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

// ============================================================================
// 舞鶴（MZ）潮位予測 — 気象庁 潮位表（潮汐推算）を同一オリジンで中継する。
//
// なぜ Worker 経由か（docs/web_design.md「外部オリジン通信ゼロ」）:
//   ブラウザから気象庁へ直接 fetch すると `deploy/check.mjs` の同一オリジン MUST に
//   違反する（あの check はブラウザが実際に投げるリクエストを Playwright で数える）。
//   ここでの気象庁への通信は Cloudflare の Worker（エッジ）が行うサーバ間通信で、
//   ブラウザからは常に同一オリジンの `/api/tide/maizuru` しか見えない。
//
// データ源（公式テキストデータ版。HTML の構造変化に強い固定長フォーマット）:
//   https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/MZ.txt
//   仕様は気象庁「潮位表（PDF版・テキストデータ版）フォーマット」
//   (https://ds.data.jma.go.jp/kaiyou/db/tide/suisan/readme.html) が明記している:
//     毎時潮位 : 1〜72カラム（3桁×24時間、0時から23時、単位cm、符号あり）
//     年月日   : 73〜78カラム（2桁×3＝YY MM DD）
//     地点記号 : 79〜80カラム（2桁英数字）
//     満潮時刻・潮位 : 81〜108カラム（時刻4桁+潮位3桁 ×4）
//     干潮時刻・潮位 : 109〜136カラム（同上 ×4）
//   （満干潮欄はここでは使わない。改行は LF。1 行 = 1 局 1 日。）
//   このプロジェクトの `docs/data.md` §4 に上と同じ確認結果が既に記録してある
//   （2026-09-03 に https://www.data.jma.go.jp/kaiyou/db/tide/suisan/suisan.php?stn=MZ
//   と readme.html を実機で再確認し、値は変わっていない）。
//
// T.P. 換算（**必ず `src/iwagaki/config.py` の定数と一致させること**。
// このアプリの「観測」潮位系列（`scripts/86_tide_levels.py`）も同じ換算を使っており、
// ここだけ別の基準を使うと 2 本の曲線が同じ T.P. のはずなのにずれる):
//   気象庁の公表値は測地成果2024 基準、この解析の地形（PLATEAU・0.5m DEM・点群）は
//   測地成果2011 基準なので、換算しないと水位を 0.190 m 低く見て浸水を過小評価する
//   （docs/data.md「標高成果の世代」）。
//     測地成果2011→2024 の標高補正量: -0.19031 m（吉原 3次メッシュ 53351246、
//       国土地理院「測量成果2024移行のための水準点標高補正パラメータ」実値）
//     潮位表基準面の標高（測地成果2024 基準）: -0.066 m T.P.
//       （気象庁 潮位表 舞鶴(MAIZURU) ページの「潮位表基準面の標高」表示）
//   測地成果2011 基準に換算した潮位表基準面の標高:
//     -0.066 - (-0.19031) = 0.12431 m T.P.
//   すなわち: T.P.(m) = 潮位表の値(cm)/100 + 0.12431
const TIDE_STATION = 'MZ'
const TIDE_STATION_LABEL = '舞鶴（MAIZURU）'
const TIDE_SOURCE_LABEL = '気象庁 潮位表（潮汐推算）'
const HYOKO_DH_JGD2011_TO_2024_M = -0.19031
const TP_OF_TIDE_TABLE_DATUM_JGD2024_M = -0.066
export const TP_OF_TIDE_TABLE_DATUM_M = TP_OF_TIDE_TABLE_DATUM_JGD2024_M - HYOKO_DH_JGD2011_TO_2024_M
const FORECAST_WINDOW_DAYS = 7
const FORECAST_WINDOW_MS = FORECAST_WINDOW_DAYS * 24 * 3600 * 1000
const JST_OFFSET_MS = 9 * 3600 * 1000

export function tideTableCmToTpMeters(cm) {
  return cm / 100 + TP_OF_TIDE_TABLE_DATUM_M
}

function suisanTxtUrl(year) {
  return `https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/${year}/${TIDE_STATION}.txt`
}

/**
 * 固定長 1 行（136 カラム）を解く。年は呼び出し側が渡す 4 桁年を使う
 * （埋め込みの YY は 2 桁で世紀をまたぐ判定が要る。取得元の URL が年を
 * 確定させているので、そちらを信頼し、埋め込み YY とは整合性チェックだけ行う）。
 * 解けない行（長さ不足・数値が読めない）は null を返し、呼び出し側が捨てる。
 */
export function parseSuisanLine(line, fullYear) {
  if (typeof line !== 'string' || line.length < 80) return null
  const hourly = []
  for (let h = 0; h < 24; h++) {
    const field = line.slice(h * 3, h * 3 + 3)
    const v = Number(field)
    if (!Number.isFinite(v)) return null
    hourly.push(v)
  }
  const yy = Number(line.slice(72, 74))
  const month = Number(line.slice(74, 76))
  const day = Number(line.slice(76, 78))
  const stn = line.slice(78, 80)
  if (!Number.isFinite(yy) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (stn !== TIDE_STATION) return null
  if (yy !== fullYear % 100) return null   // 取得元の年と埋め込み YY が食い違う = 壊れた行
  return { year: fullYear, month, day, hourlyCm: hourly }
}

/** 年ぶんのテキスト全体を日次レコードの配列にする。壊れた行は黙って飛ばす（欠測扱い）。 */
export function parseSuisanText(text, fullYear) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const rec = parseSuisanLine(line, fullYear)
    if (rec) records.push(rec)
  }
  return records
}

/**
 * 日次レコード → TidePoint（時刻は JST 固定の ISO 8601、`domain/tideSeries.ts` の
 * `TidePoint.time` と同じ規約）。`timeMs` は絶対時刻（フィルタ・並べ替え用）。
 */
function recordToPoints(rec) {
  const pad2 = (n) => String(n).padStart(2, '0')
  const dateStr = `${rec.year}-${pad2(rec.month)}-${pad2(rec.day)}`
  return rec.hourlyCm.map((cm, h) => {
    const timeMs = Date.UTC(rec.year, rec.month - 1, rec.day, h, 0, 0) - JST_OFFSET_MS
    return {
      time: `${dateStr}T${pad2(h)}:00:00+09:00`,
      tide_m_tp: Math.round(tideTableCmToTpMeters(cm) * 1000) / 1000,
      timeMs,
    }
  })
}

/**
 * 日次レコード群（複数年をまたいでよい）から、`nowMs`〜`nowMs + 7日` の
 * TideSeries を組み立てる。**現在時刻以前は除外**。7 日に満たない場合は
 * 無理に補間せず、取れた分だけを `warning` 付きで返す
 * （データが全く無ければ `ok: false` で理由を返す）。
 */
export function buildMaizuruForecastSeries(dailyRecords, nowMs) {
  const endMs = nowMs + FORECAST_WINDOW_MS
  const points = dailyRecords
    .flatMap(recordToPoints)
    .filter((p) => p.timeMs >= nowMs && p.timeMs <= endMs)
    .sort((a, b) => a.timeMs - b.timeMs)

  if (points.length === 0) {
    return { ok: false, error: '気象庁の潮位予測データを取得できませんでした（対象期間のデータが空）' }
  }

  const first = points[0]
  const last = points[points.length - 1]
  const startGapMs = first.timeMs - nowMs
  const endGapMs = endMs - last.timeMs
  // 7 日を大きく割り込む・立ち上がりが大きく遅れる場合は警告にする
  // （境界値は「1 時間ぶんの欠測は許容、半日以上欠ければ知らせる」の感覚値）
  let warning
  if (endGapMs > 12 * 3600 * 1000 || startGapMs > 3600 * 1000) {
    const coverDays = Math.round(((last.timeMs - first.timeMs) / (24 * 3600 * 1000)) * 10) / 10
    warning = `7 日分のうち約 ${coverDays} 日分しか取得できませんでした（気象庁側のデータ不足）`
  }

  let peak = points[0]
  for (const p of points) if (p.tide_m_tp > peak.tide_m_tp) peak = p

  return {
    ok: true,
    warning,
    series: {
      id: 'forecast-maizuru',
      label: '気象庁 潮位予測（舞鶴・7日間）',
      kind: 'computed',
      points: points.map((p) => ({ time: p.time, tide_m_tp: p.tide_m_tp })),
      peak_time: peak.time,
      peak_value_m_tp: peak.tide_m_tp,
    },
  }
}

/** JST での年（4 桁）。`nowMs` は UTC epoch ms。 */
function jstYear(ms) {
  return new Date(ms + JST_OFFSET_MS).getUTCFullYear()
}

async function fetchYearText(year) {
  const res = await fetch(suisanTxtUrl(year), {
    cf: { cacheTtl: 3600, cacheEverything: true },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`気象庁データの取得に失敗しました（${suisanTxtUrl(year)} -> ${res.status}）`)
  return res.text()
}

export async function handleTideForecast() {
  const nowMs = Date.now()
  const years = new Set([jstYear(nowMs), jstYear(nowMs + FORECAST_WINDOW_MS)])
  const records = []
  const fetchErrors = []
  // **年またぎでも片方が取れれば続行する。** 年末に翌年表がまだ無くても、
  // 今年ぶんだけで警告つきの部分系列を返せるようにする（無理に全断しない）
  await Promise.all([...years].map(async (year) => {
    try {
      records.push(...parseSuisanText(await fetchYearText(year), year))
    } catch (e) {
      fetchErrors.push(String(e?.message ?? e))
    }
  }))

  if (records.length === 0) {
    return jsonResponse(502, {
      ok: false,
      error: fetchErrors[0] ?? '気象庁の潮位予測データを取得できませんでした',
    })
  }

  const built = buildMaizuruForecastSeries(records, nowMs)
  if (!built.ok) return jsonResponse(502, built)

  return jsonResponse(200, {
    ok: true,
    warning: built.warning,
    retrieved_at: new Date(nowMs).toISOString(),
    source_label: TIDE_SOURCE_LABEL,
    source_url: suisanTxtUrl(jstYear(nowMs)),
    station_label: TIDE_STATION_LABEL,
    series: built.series,
  })
}

/**
 * ブラウザに古い予測を返し続けないよう、この API 応答は毎回無条件で取りに行かせる
 * （`no-store`）。**気象庁側への通信は減らしたい**ので、上流の取得は
 * `fetchYearText` の `cf.cacheTtl`（1 時間、Cloudflare のエッジキャッシュ）で吸収する
 * — ブラウザ向けの鮮度と気象庁への負荷を別の層で分けて解く。
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
