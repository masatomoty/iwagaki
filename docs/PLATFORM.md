# PLATFORM — 配信プラットフォームの挙動（実測）

Cloudflare が実際に何を返すか、ローカル配信と何が違うかを実測で確定させたもの。
**構成と手順は `docs/INFRA.md`、アプリ側の性能は `docs/WEB_RESULTS.md`。**
ここに置くのは「プラットフォームがそうなっている」という事実だけである。

根拠区分は `docs/DATA.md` と同じ（**[実測]** / **[既知]** / **[仮説]** / **[未確認]**）。

---

## Workers Assets は Range に 200 を返す **[実測]**

`bytes=0-99` を要求しても **status 200 でファイル全体**が返る（9,132 B のタイルで確認）。
**実配信とローカル workerd の両方で同じ。**

COPC は「必要なノードのバイト範囲だけ取る」ことが前提のフォーマットなので、
これに載せると 1 ノードごとにファイル全体が落ちてくる。**採用した意味が消える。**

そこで `/data/pointcloud/*` だけを Worker に渡し、R2 binding から読む。
R2 は範囲を持つ `R2ObjectBody` を返すので、Worker は 206 と `Content-Range` を
組み立てるだけでよい。

`docs/WEB_DESIGN.md`「配信の境界」は Cloudflare Pages についてこれを [既知] としていたが、
**Workers Assets でも同じだった**。

### Range の応答規約

`web/serve.mjs`（ローカル配信）と Worker で揃えてある。計測条件を揃えるため。

| 要求 | 応答 |
|---|---|
| `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` | 206 + `Content-Range` + `Content-Length` |
| 範囲外 | 416 + `Content-Range: bytes */size` |
| マルチレンジ `bytes=a-b, c-d` | **400**（R2 の S3 API も非対応） |
| `If-None-Match` つき全体 GET | 304 |
| HEAD | 200 + `Content-Length` |

**黙って全体を返す経路を作らないこと**が要点である。
マルチレンジに 200 を返すのが最悪で、クライアントは正しく動いているように見えたまま
毎回ファイル全体を落とす。`deploy/check.mjs` はこれを MUST として検査する。

### br 応答に `content-length` が付かない **[実測]**

Cloudflare は br で返すとき `content-encoding: br` は付けるが
**`content-length` を付けない**。そのため `fetch` のヘッダからは
符号化後の長さが取れず、**アプリ側で「回線を流れたバイト数」を数えられない。**

同一オリジンなら `PerformanceResourceTiming.encodedBodySize` が
content-coding 適用後のボディ長そのものなので、そこから引き当てる。
クロスオリジンだと 0 になるので引き当てられない。

デコード後のバイト数で代用すると、圧縮が効くアセットで 6 倍ずれる
（`objects.geojson`: decode 662 kB / wire 109 kB）。
計測側の扱いは `docs/WEB_RESULTS.md`。

---

## COPC は CDN キャッシュに乗らない **[既知]**

Worker → R2 binding は subrequest であり、Cache API に 206 を put できない。
**点群のノード取得は毎回 R2 まで行く。**

乗せたい場合の選択肢は「R2 をカスタムドメインで直接配信する」だが、
別オリジンになるので `PerformanceResourceTiming.transferSize` が 0 になり、
転送量の計測が濁る（`docs/WEB_DESIGN.md`「収集する量」）。**今は取らない。**

---

## ローカル配信との差 **[既知]**

| 項目 | `web/serve.mjs` | Cloudflare |
|---|---|---|
| Range | 自前で 206 | アセットは 200（→ COPC は R2 経由で 206） |
| 圧縮 | 事前 br/gzip をメモリに常駐 | edge が都度 |
| キャッシュ階層 | 無し（プロセス直） | edge キャッシュあり。`cf-cache-status` が付く |
| COPC のキャッシュ | OS のページキャッシュ | **CDN に乗らない**。毎回 R2 |
| プロトコル | HTTP/2（自己署名 TLS）または HTTP/1.1 | HTTP/2・HTTP/3 |
| RTT | ~0 | 実 RTT。**ここが最も効く** |

ローカル配信は「経路が繋がっていて正しいステータスとバイト列が返るか」を見るためのもので、
**性能の結論はローカルでは出せない**。RTT が 0 だと往復回数の影響が消えるので、
往復回数で律速する種類の問題（COPC の hierarchy 取得など）が原理的に見えない。

---

## 実配信の検証結果 **[実測]**

配信先: `https://iwagaki-viewer.tonbo.workers.dev`

`npm run deploy:check <URL>` → **MUST 12/12**。

| 項目 | 結果 |
|---|---|
| COPC `bytes=0-1023` | 206 / `Content-Range` 正常、**中身がローカル実体と byte 一致** |
| COPC 末尾指定 `bytes=-4096` | 206 |
| COPC 範囲外 | 416 / `bytes */size` |
| COPC マルチレンジ | 400（全体を返さない） |
| **Workers Assets の Range** | **200**（全体を返す） |
| 圧縮 | `objects.geojson` / `tileset.json` / bundle すべて **br**。`application/geo+json` も対象 |
| キャッシュ | タイル・3D Tiles・geojson は `immutable`、`index.html` と `catalog.json` は再検証 |
| COPC のヘッダ | `immutable` / `etag` / `content-type: application/octet-stream` |

`_headers` は deploy 時に反映されている（`wrangler dev` の起動時読み込みの問題は
実配信では出なかった）。

ローカル workerd（`wrangler dev` + ローカル R2）でも同じ `check.mjs` で MUST 12/12。
加えて `.assetsignore` の効果を番兵ファイル（404 = アップロードされない）で確認した。

---

## 落とし穴

### URL を間違えると Cloudflare 自身の 404 が返る **[実測]**

存在しない workers.dev サブドメインを叩くと **404 + 本文 `error code: 1042`** が返る。
デプロイが失敗したように見えるが、**デプロイは成功していて URL が違うだけ**、
という状態を作る。

見分け方は content-type:

| 返した主体 | 404 の形 |
|---|---|
| Cloudflare のエラーページ | `text/html` + `cache-control: private, ..., post-check=0, pre-check=0` |
| 本リポジトリの Worker | `text/plain; charset=utf-8` + 本文 `not found` |

正しい URL は `wrangler deploy` の出力に出る。流してしまった場合は
`~/Library/Preferences/.wrangler/logs/`（macOS）のデプロイ時ログに残っている。

### `wrangler r2 object put` は 315 MB で黙って壊れる **[実測]**

エラーを出さずに途中で切れたオブジェクトを作る。
490 MB の COPC で、先頭 1 KB が全ゼロの 277 MB のオブジェクトが残った。
`deploy.sh` の分岐と検証は `docs/INFRA.md`。

### `wrangler deploy` の "Read N files" はファイル数と一致しない **[実測]**

ディレクトリ上の実ファイル数と合わない。**`.assetsignore` の効果はこの数字では確認できない。**
番兵ファイルを置いて 404 になることで確認する。

---

## 未確認

- Worker → R2 の 1 リクエストあたりのレイテンシと Class B オペレーション課金。
  点群 1 セッションで数十リクエスト出るので、無料枠の範囲かどうか **[未確認]**
- edge キャッシュが温まった 2 回目以降（`cf-cache-status: HIT`）との差 **[未確認]**
- `wrangler dev` の `_headers` が起動時にしか読まれない件は、実配信では出なかったので
  ローカル固有と見ている **[仮説]**
