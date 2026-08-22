# INFRA — Cloudflare への配信インフラ

`docs/WEB_DESIGN.md` §6（責務境界）の実装。ここで作るのは **静的配信だけ**。
アップロード経路とジョブ実行（同 §7）は作らない（§9 に境界を書く）。

根拠区分は `docs/DATA.md` と同じ（**[実測]** / **[既知]** / **[仮説]** / **[未確認]**）。
配信条件（Range・圧縮・キャッシュ）は **実配信で実測済み**（§7.1）。
残っているのは実 RTT 込みの性能で、そこは未測（§8）。

---

## 0. スコープ

| | |
|---|---|
| 作る | viewer + 生成済みアセットの配信、COPC の Range 配信、配信条件の検証手段 |
| 作らない | LAS アップロード、D1、Queues、external compute、独自ドメイン、認証 |

配信できるようになると何が変わるか: `docs/WEB_RESULTS.md` の計測はすべてローカル配信のもので、
「CDN のキャッシュ階層・実 RTT 分布・実際の Range 挙動」が入っていない（同 §7 の限界)。
このインフラはその再測の土台であって、それ自体が結論ではない。
Range 挙動は §7.1 で確定したが、**RTT 込みの性能はまだ測っていない。**

---

## 1. 構成

```
Browser ─┬─ /  /assets/*  /data/{catalog.json,tiles,3dtiles,objects.geojson}
         │        → Workers Assets（web/dist をそのまま）
         │
         └─ /data/pointcloud/*.copc.laz   Range: bytes=...
                  → Worker (deploy/worker.js) → R2 binding → 206 Partial Content
```

Worker は 1 本（`iwagaki-viewer`）。同一オリジンに両方を載せる。
分けているのは配信経路だけで、**URL 空間は分けていない** ——
`catalog.json` の url は全て相対のままで、アプリ側の変更は無い。
（同一オリジンに揃える理由: `PerformanceResourceTiming.transferSize` は
クロスオリジンだと 0 になる。`docs/WEB_DESIGN.md` §8.3）

| ファイル | 役割 |
|---|---|
| `web/wrangler.jsonc` | Worker 名 / assets ディレクトリ / R2 binding / どのパスを Worker が先に取るか |
| `web/deploy/worker.js` | COPC の Range 配信のみ。他のパスには関与しない |
| `web/deploy/_headers` | Workers Assets のキャッシュ制御（deploy 時に `dist/_headers` へコピー） |
| `web/deploy/assetsignore` | COPC をアセットとしてアップロードしない（→ `dist/.assetsignore`） |
| `web/deploy/deploy.sh` | build → R2 へ COPC → `wrangler deploy` |
| `web/deploy/check.mjs` | デプロイ後に配信条件を実測して合否を出す |

---

## 2. COPC だけ R2 を経由する理由 **[実測]**

Workers Assets は Range リクエストに **200 を返し、ファイル全体を返す**
（`bytes=0-99` に対し status 200 / 9132 B 全体。**実配信とローカル workerd の両方で確認**）。
COPC は「必要なノードのバイト範囲だけ取る」ことが前提なので、
これに載せると 1 ノードごとに 14.4 MB が落ちてくる。**COPC を採用した意味が消える。**
`docs/WEB_DESIGN.md` §6.1 は Pages についてこれを [既知] としていたが、
Workers Assets でも同じだった。

そこで `/data/pointcloud/*` だけを Worker に渡し、R2 binding から読む。
R2 は範囲を持つ `R2ObjectBody` を返すので、Worker は 206 と `Content-Range` を組み立てるだけ。

`web/serve.mjs`（ローカル配信）と振る舞いを揃えている:

| 要求 | 応答 |
|---|---|
| `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` | 206 + `Content-Range` + `Content-Length` |
| 範囲外 | 416 + `Content-Range: bytes */size` |
| マルチレンジ `bytes=a-b, c-d` | 400（R2 の S3 API も非対応。`docs/WEB_DESIGN.md` §4.4） |
| `If-None-Match` つき全体 GET | 304 |
| HEAD | 200 + `Content-Length` |

**黙って全体を返す経路を作らないこと**が要点。マルチレンジに 200 を返すのが最悪で、
クライアントは正しく動いているように見えたまま毎回 14 MB を落とす。
`check.mjs` はこれを明示的に検査する。

---

## 3. リソースと命名

| 種別 | 名前 | 備考 |
|---|---|---|
| Worker | `iwagaki-viewer` | `workers_dev: true`。既定で `*.workers.dev` に出る |
| R2 バケット | `iwagaki-assets` | location hint `apac` |
| R2 キー空間 | `data/pointcloud/*.copc.laz` | **URL パスと 1:1**（先頭の `/` を落としただけ） |
| 〃（将来） | `raw/las/*` | アップロードされた原データ置き場（`docs/WEB_DESIGN.md` §7） |

キーと URL パスを一致させているので、Worker 側にマッピング表が無い。
バケット名は `wrangler.jsonc` を単一の出所とし、`deploy.sh` はそこから読む。

必要な API 権限（トークンを切る場合）: Workers Scripts:Edit / Workers R2 Storage:Edit / Account Settings:Read。
`wrangler login` で済ませるなら不要。

---

## 4. 手順

```bash
cd web
npx wrangler login          # 初回のみ（ブラウザ認証）
npm run deploy:dry          # 設定と bundle の検証だけ。Cloudflare に何も作らない
npm run deploy              # build → R2 へ COPC → wrangler deploy
npm run deploy:check https://iwagaki-viewer.<subdomain>.workers.dev
```

- `deploy/deploy.sh --no-build` … `dist/` を作り直さない
- `deploy/deploy.sh --skip-r2` … COPC を上げ直さない（アセットだけ更新する時）
- 初回は R2 バケットが無ければ作る。2 回目以降はそのまま使う
- アセット生成（`scripts/build_web.sh`）が先。COPC が `dist/` に無ければ警告する

ローカルで Cloudflare と同じ経路を再現する場合:

```bash
# 一度だけ: ローカル R2 に COPC を入れる（wrangler dev はローカル実体を見る）
npx wrangler r2 object put iwagaki-assets/data/pointcloud/<name>.copc.laz \
  --file dist/data/pointcloud/<name>.copc.laz --content-type application/octet-stream --local
cp deploy/_headers dist/_headers && cp deploy/assetsignore dist/.assetsignore
npx wrangler dev --port 8788
node deploy/check.mjs http://localhost:8788
```

**`_headers` は `wrangler dev` の起動時に読まれる。** 起動後に置いても
反映されないことがある（起動直後に既定の `max-age=0, must-revalidate` が返る事象を確認）。
これは静かに壊れるので `check.mjs` が MUST として検査する。

---

## 5. キャッシュと圧縮

| 対象 | Cache-Control | 誰が決めるか |
|---|---|---|
| `/index.html`, `/data/catalog.json`, `/data/*_report.json` | `public, max-age=0, must-revalidate` | Workers Assets の既定 |
| `/assets/*`（vite の内容ハッシュつき） | `immutable` (1 年) | `deploy/_headers` |
| `/data/tiles/*`, `/data/3dtiles/*`, `/data/objects.geojson` | `immutable` (1 年) | `deploy/_headers` |
| `/data/pointcloud/*.copc.laz` | `immutable` (1 年) | `deploy/worker.js` |

`web/serve.mjs` の方針（入口だけ再検証、あとは immutable）と同じにしてある。計測条件を揃えるため。

**代償 [既知]**: `data/tiles` と `data/3dtiles` の URL は内容ハッシュを含まない。
データを作り直しても immutable キャッシュを持つブラウザは古いタイルを見続ける。
差し替える時は URL を変える（`catalog.json` の url にバージョンを入れる）か、
Cloudflare 側のキャッシュを purge する。**今は URL にバージョンが無い** ——
データを更新する運用に入るならここが最初に効く。

圧縮は edge に任せる（`web/serve.mjs` の事前圧縮に相当）。
`application/geo+json` は Cloudflare の圧縮対象に入っている **[既知]** ので
570 kB の `objects.geojson` も圧縮されて出る。ここは静かに外れると
`first_meaningful_render` に直接効くので、`check.mjs` が MUST として検査する。

---

## 6. ローカル配信との差分（再測が必要な理由）

| 項目 | `web/serve.mjs` | Cloudflare |
|---|---|---|
| Range | 自前で 206 | アセットは 200（→ COPC は R2 経由で 206） |
| 圧縮 | 事前 br/gzip をメモリに常駐 | edge が都度 |
| キャッシュ階層 | 無し（プロセス直） | edge キャッシュあり。`cf-cache-status` が付く |
| COPC のキャッシュ | OS のページキャッシュ | **CDN キャッシュに乗らない [既知]**。毎回 R2 まで行く |
| プロトコル | HTTP/2（自己署名 TLS）または HTTP/1.1 | HTTP/2・HTTP/3 |
| RTT | ~0 | 実 RTT。ここが最も効く |

COPC が CDN に乗らないのは Worker → R2 binding が subrequest であり、
Cache API に 206 を put できないため（**[既知]**）。
点群のノード取得は毎回 R2 まで行く前提で読む。
乗せたい場合の選択肢は「R2 をカスタムドメインで直接配信する」だが、
別オリジンになるので `transferSize` が 0 になり計測が濁る。**今は取らない。**

---

## 7. 実測

### 7.1 実配信 **[実測]**

配信先: `https://iwagaki-viewer.tonbo.workers.dev`（2026-08-22 デプロイ）

`npm run deploy:check https://iwagaki-viewer.tonbo.workers.dev` → **MUST 12/12**。

| 項目 | 結果 |
|---|---|
| COPC `bytes=0-1023` | 206 / `bytes 0-1023/14445214`、**中身がローカル実体と byte 一致** |
| COPC `bytes=-4096` | 206 / `bytes 14441118-14445213/14445214` |
| COPC 範囲外 | 416 / `bytes */14445214` |
| COPC マルチレンジ | 400（全体を返さない） |
| **Workers Assets の Range** | **200**（全体を返す）。§2 の判断が実配信でも正しいことの確認 |
| 圧縮 | `objects.geojson` / `tileset.json` / bundle すべて **br**（`application/geo+json` も対象） |
| キャッシュ | タイル・3D Tiles・geojson は `immutable`、`index.html` と `catalog.json` は再検証。初回は `cf-cache-status: MISS` |
| COPC のヘッダ | `immutable` / `etag` / `content-type: application/octet-stream` |

つまり **Range 挙動・圧縮・キャッシュ制御は実配信で確定**した。
`_headers` は deploy 時に反映されている（起動時読み込みの問題は実配信では出なかった）。

### 7.2 ローカル workerd（`wrangler dev` + ローカル R2） **[実測]**

同じ `check.mjs` で MUST 12/12。実配信と同じ結果に加えて、
`.assetsignore` の効果を番兵ファイル（404 = アップロードされない）で確認した。

viewer 実体での通し確認（`URL=http://localhost:8788/?pc=1 node perf/smoke.mjs`）:

| | |
|---|---|
| COPC リクエスト | 14 本すべて 206、失敗 0、`wastedBytes` 0 |
| `catalog_loaded` / `first_meaningful_render` | 28 ms / 648 ms |
| `pc_index_loaded` / `time_to_first_useful_pc` | 2048 ms / 5000 ms |
| PLATEAU b3dm | 22/22（失敗 0） |

**この数字は性能の結論ではない**（ローカル・RTT ほぼ 0）。
確認しているのは「経路が繋がっていて、正しいステータスとバイト列が返る」ことだけ。
実配信での性能は §8 のとおり未測。

### 7.3 落とし穴: URL を間違えると Cloudflare 自身の 404 が返る **[実測]**

存在しない workers.dev サブドメイン（例: `iwagaki-viewer.plateau.workers.dev`）を叩くと
**404 + 本文 `error code: 1042`** が返る。デプロイが失敗したように見えるが、
デプロイは成功していて URL が違うだけ、という状態を作る。

見分け方は **content-type**:

| 返した主体 | 404 の形 |
|---|---|
| Cloudflare のエラーページ | `text/html` + `cache-control: private, ..., post-check=0, pre-check=0` |
| 本リポジトリの Worker | `text/plain; charset=utf-8` + 本文 `not found` |

正しい URL は `wrangler deploy` の出力に出る。流してしまった場合は
`~/Library/Preferences/.wrangler/logs/`（macOS）のデプロイ時ログに残っている。
`wrangler deployments list` でデプロイの有無だけは別に確認できる。

---

## 8. 未確認

- **実配信での性能 [未確認]**。§7.1 で確認したのは配信条件（ステータス・ヘッダ・バイト列）だけ。
  実 RTT 込みのマイルストーンは `perf/run.mjs` を実 URL に向けて回す必要がある。
  edge キャッシュが温まった 2 回目以降（`cf-cache-status: HIT`）との差も未測。
- Worker → R2 の 1 リクエストあたりのレイテンシと Class B オペレーション課金。
  点群 1 セッションで数十〜数百リクエスト出るので、無料枠の範囲かどうかを見る。
- `wrangler deploy` が表示する "Read N files" はディレクトリ上の実ファイル数（434）と一致しない。
  `.assetsignore` の効果はこの数字では確認できず、番兵ファイルで確認した。
- `wrangler dev` の `_headers` は起動時に読まれる（起動後に置くと反映されないことがある）。
  実配信では出なかったので、ローカル固有の事象と見ている。**[仮説]**

---

## 9. まだ作らないもの

`docs/WEB_DESIGN.md` §6 の図のうち、今回作ったのは静的配信だけ。残り:

| | 何が要るか |
|---|---|
| upload（§7） | Worker に `/api/uploads`、D1、R2 の CORS 設定、`aws4fetch` で presigned PUT |
| ジョブ | Queues + external compute（Cloud Run job など）。PDAL/GDAL は Workers で動かさない |
| データセット追加 | `catalog.json` を生成物として R2 に置き、Worker が組み立てて返す形に変える |

**今の catalog.json は静的ファイル**である。複数データセットを扱う段でここが動的になる。
その時も「境界は catalog.json が指す URL」（§6）を保つ。
