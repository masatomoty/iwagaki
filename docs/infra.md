# INFRA — Cloudflare 配信の構成と手順

```
┌──── ビルド（ローカル） ─────────────────────────────────────────┐
│                                                                  │
│  scripts/run_all.sh        解析 ──▶ data/out/*.tif, *.geojson    │
│  scripts/build_web.sh      配信アセット生成                       │
│         │                                                        │
│         ├─▶ web/public/data/tiles/{条件}/{z}/{x}/{y}.png         │
│         ├─▶ web/public/data/3dtiles/…                            │
│         ├─▶ web/public/data/objects.geojson                      │
│         ├─▶ web/public/data/catalog.json      ← 配信物の目録       │
│         └─▶ web/public/data/pointcloud/*.copc.laz                │
│                                                                  │
│  pnpm build                vite ──▶ web/dist/                    │
└──────────────────────────────┬───────────────────────────────────┘
                               │  deploy/deploy.sh
              ┌────────────────┴───────────────────┐
              │                                    │
              ▼                                    ▼
  ┌───────────────────────┐          ┌─────────────────────────────┐
  │  Workers Assets       │          │  R2  iwagaki-assets          │
  │  （dist/ をそのまま）  │          │  data/pointcloud/*.copc.laz  │
  │                       │          │  ※ 315 MB 超は S3 API 経由   │
  │  html / js / css      │          └──────────────┬──────────────┘
  │  tiles / 3dtiles      │                         │ R2 binding
  │  objects.geojson      │                         │
  │  catalog.json         │          ┌──────────────▼──────────────┐
  └───────────┬───────────┘          │  Worker  iwagaki-viewer      │
              │                      │  deploy/worker.js            │
              │                      │  /data/pointcloud/* だけ担当  │
              │                      │  Range → 206 Partial Content │
              │                      └──────────────┬──────────────┘
              │                                     │
              └──────────────┬──────────────────────┘
                             │  同一オリジン
                             ▼
                    ┌─────────────────┐
                    │     Browser     │
                    │  catalog.json   │──▶ 以降のすべての URL はここから
                    └─────────────────┘
```

Worker は 1 本（`iwagaki-viewer`）。**静的アセットと COPC を同一オリジンに載せる。**
分けているのは配信経路だけで URL 空間は分けていないので、
`catalog.json` の url は全て相対のままでよく、アプリ側に分岐は無い。

同一オリジンに揃える理由は 2 つある。`PerformanceResourceTiming.transferSize` は
クロスオリジンだと 0 になり転送量が測れなくなること（`docs/web_design.md`「収集する量」）と、
CORS の設定が 1 つ増えると静かに壊れる箇所が 1 つ増えること。

**COPC だけ Worker + R2 を経由するのは、Workers Assets が Range に 200 を返すから**である。
根拠と実測は `docs/platform.md`。

### 市向け示唆レポート（`/report/`）

`report/`（VitePress、`base: '/report/'`）を**同じ Worker のサブパス**として配信する。
`deploy/deploy.sh` が vite build の直後に VitePress をビルドし、成果を `dist/report/` に複製する。
`/report/*` は `wrangler.jsonc` の `run_worker_first` に載っていないので Workers Assets が直接返し、
`deploy/worker.js` は関与しない（新規パスの登録も不要）。同一オリジンなので transferSize も
CORS も既存の viewer と同じ扱いのまま。内容は解析結果（`docs/results.md`）の報告用まとめで、
`docs/*.md` の内部作業ノートとは別物。

---

## スコープ

| | |
|---|---|
| 作る | viewer + 生成済みアセットの配信、COPC の Range 配信、配信条件の検証手段 |
| 作らない | LAS アップロード、D1、Queues、external compute、独自ドメイン、認証 |

---

## リソースと命名

| 種別 | 名前 | 備考 |
|---|---|---|
| Worker | `iwagaki-viewer` | `workers_dev: true`。既定で `*.workers.dev` に出る |
| R2 バケット | `iwagaki-assets` | location hint `apac` |
| R2 キー空間 | `data/pointcloud/*.copc.laz` | **URL パスと 1:1**（先頭の `/` を落としただけ） |
| 〃（将来） | `raw/las/*` | アップロードされた原データ置き場。**今回は作らない**（下記「まだ作らないもの」） |

キーと URL パスを一致させているので、Worker 側にマッピング表が無い。
バケット名は `wrangler.jsonc` を単一の出所とし、`deploy.sh` はそこから読む。

| ファイル | 役割 |
|---|---|
| `web/wrangler.jsonc` | Worker 名 / assets ディレクトリ / R2 binding / Worker が先に取るパス |
| `web/deploy/worker.js` | COPC の Range 配信のみ。他のパスには関与しない |
| `web/deploy/_headers` | Workers Assets のキャッシュ制御（deploy 時に `dist/_headers` へコピー） |
| `web/deploy/assetsignore` | COPC をアセットとしてアップロードしない（→ `dist/.assetsignore`） |
| `web/deploy/deploy.sh` | build（viewer → `report/` VitePress → `dist/report/`）→ R2 へ COPC → `wrangler deploy` |
| `report/` | 市向け示唆レポート（VitePress、`base: '/report/'`）。`iwagaki-viewer.<subdomain>.workers.dev/report/` |
| `web/deploy/r2put.sh` | 315 MB 超を S3 API の multipart で R2 に置く |
| `web/deploy/check.mjs` | デプロイ後に配信条件を実測して合否を出す |

必要な API 権限（トークンを切る場合）: Workers Scripts:Edit / Workers R2 Storage:Edit /
Account Settings:Read。`wrangler login` で済ませるなら不要。

---

## 手順

```bash
cd web
pnpm exec wrangler login          # 初回のみ（ブラウザ認証）
pnpm run deploy:dry          # 設定と bundle の検証だけ。Cloudflare に何も作らない
pnpm run deploy              # build → R2 へ COPC → wrangler deploy
pnpm run deploy:check https://iwagaki-viewer.<subdomain>.workers.dev
```

| オプション | 効果 |
|---|---|
| `deploy/deploy.sh --no-build` | `dist/` を作り直さない |
| `deploy/deploy.sh --skip-r2` | COPC を上げ直さない（アセットだけ更新する時） |
| `deploy/deploy.sh --dry-run` | 検証のみ |

- 初回は R2 バケットが無ければ作る
- アセット生成（`scripts/build_web.sh`）が先。COPC が `dist/` に無ければ警告する

### 315 MB を超える COPC

`wrangler r2 object put` は **315 MB までしか扱えない**
（[Cloudflare docs](https://developers.cloudflare.com/r2/objects/upload-objects/)）。
超えるとエラーを出さずに途中で切れたオブジェクトを作る。
実際に 490 MB の COPC で、先頭 1 KB が全ゼロの 277 MB のオブジェクトが残った。

`deploy.sh` は上限を超えたら `deploy/r2put.sh`（`aws s3 cp` の自動 multipart）に回し、
**アップロード後にサイズと先頭 4 バイト（`LASF`）の両方を検証**して、
食い違えば deploy 手前で止める。片方だけでは足りない。
サイズだけなら全ゼロでも通り、先頭だけなら途中で切れていても通る。

`r2put.sh` は R2 の API トークンを `.env.deploy`（gitignore 済み）から読む。
`wrangler login` の OAuth トークンは S3 API には使えない。

```
R2_ACCOUNT_ID=<Cloudflare の Account ID>
AWS_ACCESS_KEY_ID=<R2 API トークンの Access Key ID>
AWS_SECRET_ACCESS_KEY=<同 Secret Access Key>
```

権限は **Object Read & Write**、適用範囲は該当バケットを含めること。
バケット指定を外すと全操作が 403 になる。

### ローカルで同じ経路を再現する

```bash
# 一度だけ: ローカル R2 に COPC を入れる（wrangler dev はローカル実体を見る）
pnpm exec wrangler r2 object put iwagaki-assets/data/pointcloud/<name>.copc.laz \
  --file dist/data/pointcloud/<name>.copc.laz --content-type application/octet-stream --local
cp deploy/_headers dist/_headers && cp deploy/assetsignore dist/.assetsignore
pnpm exec wrangler dev --port 8788
node deploy/check.mjs http://localhost:8788
```

**`_headers` は `wrangler dev` の起動時に読まれる。** 起動後に置いても
反映されないことがある。静かに壊れるので `check.mjs` が MUST として検査する。

---

## キャッシュと圧縮の設定

| 対象 | Cache-Control | 誰が決めるか |
|---|---|---|
| `/index.html`, `/data/catalog.json`, `/data/*_report.json` | `public, max-age=0, must-revalidate` | Workers Assets の既定 |
| `/assets/*`（vite の内容ハッシュつき） | `immutable`（1 年） | `deploy/_headers` |
| `/data/tiles/*`, `/data/3dtiles/*`, `/data/objects.geojson` | `immutable`（1 年） | `deploy/_headers` |
| `/data/pointcloud/*.copc.laz` | `immutable`（1 年） | `deploy/worker.js` |

`catalog.json` が入口なので、そこだけ再検証されれば配信物の差し替えに追従できる。
`web/serve.mjs`（ローカル配信）も同じ方針にしてある。計測条件を揃えるため。

圧縮は edge に任せる。

**代償**: `data/tiles` と `data/3dtiles` の URL は**内容ハッシュを含まない**。
データを作り直しても immutable キャッシュを持つブラウザは古いタイルを見続ける。
差し替える時は `catalog.json` の url にバージョンを入れるか、Cloudflare 側で purge する。
**今は URL にバージョンが無い。** データを更新する運用に入るならここが最初に効く。

---

## まだ作らないもの

`docs/web_design.md`「配信の境界」の図のうち、作ったのは静的配信だけ。

**「作らない」は判断であって積み残しではない。** 2026-09-05 の成果物は
「同じ高潮水位に対して地形データを変えると浸水判定がどこで変わるか」を見せることで、
データを増やす経路はその外にある（`docs/design.md`「やらないこと」）。
`docs/todo.md` には置かない。

| | 必要なもの |
|---|---|
| upload | Worker に `/api/uploads`、D1、R2 の CORS 設定、`aws4fetch` で presigned PUT。**手元から R2 へ 315 MB 超を上げる経路は `web/deploy/r2put.sh` で確立済み**なので、要るのはブラウザからの経路と受け口だけ |
| ジョブ | Queues + external compute（Cloud Run job など）。PDAL/GDAL は Workers で動かさない |
| データセット追加 | `catalog.json` を生成物として R2 に置き、Worker が組み立てて返す形に変える |

**今の `catalog.json` は静的ファイル**である。複数データセットを扱う段でここが動的になる。
その時も「境界は `catalog.json` が指す URL」という原則は保つ。

---

配信プラットフォームの挙動（Range・圧縮・キャッシュ階層）とその実測、
およびローカル配信との差は `docs/platform.md`。

## 配信物の URL には内容ハッシュを入れる

`data/tiles` と `data/3dtiles` は `immutable, max-age=31536000` で配る
（`web/deploy/_headers`）。**URL に内容が反映されていないと、データを作り直しても
immutable キャッシュを持つブラウザは古いタイルを見続ける。**

| 配信物 | 名前 | 付ける場所 |
|---|---|---|
| 地形タイル | `data/tiles/highres-a0daede5/{z}/{x}/{y}.png` | ディレクトリ名 |
| 3D Tiles | `data/3dtiles/bldg_lod1-d09e7496/tileset.json` | ディレクトリ名 |
| 地物 | `data/objects-e0f8444f.geojson` | ファイル名 |
| 点群の被覆 | `data/pc_coverage-d995f2e0.geojson` | ファイル名 |
| **点群 COPC** | `data/pointcloud/yoshiwara-backpack-slam.copc.laz` | **付けない**（下記） |

ハッシュを付けるのは **`scripts/83_build_catalog.py` の 1 か所だけ**
（`iwagaki.versioning`）。**URL を決めているのがカタログだからで**、
タイルを焼く `scripts/80` と 3D Tiles を作る `scripts/82` は
`tiles/<名前>` / `3dtiles/<名前>` にそのまま書く。重い 2 本を再実行せずに
バージョンを付け直せる。ハッシュ違いの古い兄弟は消す（`dist` と
Workers Assets に両方載ると転送量と枚数が増えるだけ）。

追従の起点は **`catalog.json`**。ここだけは既定の
`max-age=0, must-revalidate` のままなので、再検証されれば新しい URL に移る。

**COPC には付けていない。** R2 に置いてあって（`deploy/worker.js` が URL → キーを
1:1 で引く）、272 MB を作り直すたびに上げ直すことになるため。差し替えるときは
手で名前を変えるか purge する。

**直書きしてはいけない。** `deploy/check.mjs` は `catalog.semantics.url` を、
`perf/tileorient.mjs` は `catalog.terrain.highres.url` を引く。
以前は両方が `data/objects.geojson` / `public/data/tiles/highres` を直書きしていて、
ハッシュを入れた時点で壊れた。
