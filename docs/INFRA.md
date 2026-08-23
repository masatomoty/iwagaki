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
│  npm run build             vite ──▶ web/dist/                    │
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
クロスオリジンだと 0 になり転送量が測れなくなること（`docs/WEB_DESIGN.md` §8.3）と、
CORS の設定が 1 つ増えると静かに壊れる箇所が 1 つ増えること。

**COPC だけ Worker + R2 を経由するのは、Workers Assets が Range に 200 を返すから**である。
根拠と実測は `docs/PLATFORM.md`。

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
| 〃（将来） | `raw/las/*` | アップロードされた原データ置き場（`docs/WEB_DESIGN.md` §7） |

キーと URL パスを一致させているので、Worker 側にマッピング表が無い。
バケット名は `wrangler.jsonc` を単一の出所とし、`deploy.sh` はそこから読む。

| ファイル | 役割 |
|---|---|
| `web/wrangler.jsonc` | Worker 名 / assets ディレクトリ / R2 binding / Worker が先に取るパス |
| `web/deploy/worker.js` | COPC の Range 配信のみ。他のパスには関与しない |
| `web/deploy/_headers` | Workers Assets のキャッシュ制御（deploy 時に `dist/_headers` へコピー） |
| `web/deploy/assetsignore` | COPC をアセットとしてアップロードしない（→ `dist/.assetsignore`） |
| `web/deploy/deploy.sh` | build → R2 へ COPC → `wrangler deploy` |
| `web/deploy/r2put.sh` | 315 MB 超を S3 API の multipart で R2 に置く |
| `web/deploy/check.mjs` | デプロイ後に配信条件を実測して合否を出す |

必要な API 権限（トークンを切る場合）: Workers Scripts:Edit / Workers R2 Storage:Edit /
Account Settings:Read。`wrangler login` で済ませるなら不要。

---

## 手順

```bash
cd web
npx wrangler login          # 初回のみ（ブラウザ認証）
npm run deploy:dry          # 設定と bundle の検証だけ。Cloudflare に何も作らない
npm run deploy              # build → R2 へ COPC → wrangler deploy
npm run deploy:check https://iwagaki-viewer.<subdomain>.workers.dev
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
npx wrangler r2 object put iwagaki-assets/data/pointcloud/<name>.copc.laz \
  --file dist/data/pointcloud/<name>.copc.laz --content-type application/octet-stream --local
cp deploy/_headers dist/_headers && cp deploy/assetsignore dist/.assetsignore
npx wrangler dev --port 8788
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

`docs/WEB_DESIGN.md` §6 の図のうち、作ったのは静的配信だけ。

| | 必要なもの |
|---|---|
| upload（§7） | Worker に `/api/uploads`、D1、R2 の CORS 設定、`aws4fetch` で presigned PUT |
| ジョブ | Queues + external compute（Cloud Run job など）。PDAL/GDAL は Workers で動かさない |
| データセット追加 | `catalog.json` を生成物として R2 に置き、Worker が組み立てて返す形に変える |

**今の `catalog.json` は静的ファイル**である。複数データセットを扱う段でここが動的になる。
その時も「境界は `catalog.json` が指す URL」という原則は保つ。

---

配信プラットフォームの挙動（Range・圧縮・キャッシュ階層）とその実測、
およびローカル配信との差は `docs/PLATFORM.md`。
