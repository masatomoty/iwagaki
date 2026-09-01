# USAGE — セットアップと実行

## 前提

| | |
|---|---|
| Python | 3.11 以上 |
| GDAL | 3.x（CLI） |
| PDAL | 2.x（点群パスで使用） |
| Node.js | 20 以上（`web/`） |

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

---

## 対象範囲を選ぶ

**範囲は 3 つある**（`src/iwagaki/config.py` の `AOIS`）。環境変数で切り替える。

| `IWAGAKI_AOI` | 範囲 | 広さ | 焼く条件 |
|---|---|---:|---|
| `yoshiwara`（既定） | 吉原 | 100 ha | 4 条件（地上点群あり） |
| `nishi_maizuru` | 西舞鶴（吉原を含む） | 625 ha | `baseline` / `highres` / `diff` |
| `higashi_maizuru` | 東舞鶴市街・溝尻・愛宕・泉源寺 | **1,000 ha** | 同左 |

```bash
IWAGAKI_AOI=higashi_maizuru scripts/run_all.sh
IWAGAKI_AOI=higashi_maizuru scripts/build_web.sh
```

- 解析結果は `data/out/<範囲>/` に分かれる
- 配信物は `web/public/data/` に**混ざって**並ぶ。範囲は名前の接頭辞で分かれる
  （`tiles/higashi_maizuru_highres-<hash>/`。`config.asset_name()`）。
  ディレクトリを割らないのは `web/deploy/_headers` が `/data/tiles/*` を
  immutable で配り、`deploy.sh` と `worker.js` がその形を前提にしているため
- **既定範囲だけは接頭辞が付かない。** 吉原の配信物の URL を変えないためで、
  既にデプロイ済みのアセットがそのまま使える
- 入口は `data/areas.json`（範囲の索引）。viewer は `?area=<id>` で選ぶ
- **点群は吉原にしか無い。** `IWAGAKI_AOI` を変えて 15〜25 番台（点群系）を
  流してはいけない
- 潮位（`scripts/86`）は舞鶴験潮場の 1 点なので範囲に依らない。
  `data/out/<範囲>/tide_levels.json` は既定範囲からコピーしてよい

## 解析を通す

```bash
scripts/run_all.sh        # 取得 → 地形 → 浸水 → 比較 → 地物結合 → 図
scripts/build_web.sh      # → Web 配信アセット（タイル・3D Tiles・線路・catalog）
scripts/88_export_survey_targets.py
                           # → 西舞鶴・東舞鶴の「次の高潮時に見るべき地物」
```

初回は京都府 DEM タイル 4 枚（各 12 MB）と PLATEAU CityGML 4 メンバー（計 1.25 GB）を取得する。
配布 zip は 3.7〜10.7 GB あるが、**HTTP Range で必要なメンバーだけ**抜くので全体は落とさない
（`src/iwagaki/remotezip.py`）。2 回目以降はキャッシュを使い 1 分程度で完走する。

スクリプトは番号順に依存する。個別に流す場合もこの順を守る。

| 番号帯 | 役割 |
|---|---|
| 10 番台 | 取得（DEM / CityGML）と点群の実態調査 |
| 20 番台 | 地形の生成・融合、表示用 COPC |
| 30 / 40 | 浸水計算（`h_conn`）と条件間の比較 |
| 33 | 地表流の集中（flow accumulation）と窪地構造。**潮位非依存の別レイヤ**で `h_conn` には混ぜない |
| 50 / 60 | 地物との結合、レポート |
| 80 番台 | Web 配信アセット（タイル・3D Tiles・catalog） |

### 主な成果物（`data/out/<範囲>/`）

| ファイル | 内容 |
|---|---|
| `dtm_{baseline,highres,control,pointcloud}_*.tif` | 4 条件の地形 |
| `h_conn_*.tif` | 連結浸水開始水位。**1 枚で全水位を表す** |
| `flow_accum_{cond}.tif` | 地表流の集中（D8・一様降雨・生値 = 集水セル数）。「水みち」 |
| `fill_depth_{cond}.tif` / `spill_elev_{cond}.tif` / `pit_id_{cond}.tif` | 窪地の充填深・越流点標高・窪地 ID（潮位非依存の原理版） |
| `flow_accum_summary.json` / `flow_accum_pits_{cond}.json` | 窪地数・面積・容積・端で切れた集水の割合・手法・生成時刻 |
| `objects.geojson` / `objects.csv` | 地物 + 条件ごとの地盤高・`h_conn` |
| `changed_H*.geojson` | 判定が変わった領域 |
| `summary.json` | 設定・指標 |
| `tide_levels.json` | 参照水位（気象庁の推算潮位から計算 + 公表値） |
| `bank_crest.json` | 越流開始水位と護岸天端のプロファイル |

### 調査対象リスト（`data/out/` 直下）

`scripts/88_export_survey_targets.py` は西舞鶴・東舞鶴の `objects.*` を読み、
潮位 0.93 m / 0.69 m ごとに「2 段」の地物を CSV と GeoJSON へ出す。
地物外形ではなく代表点（EPSG:4326）を持ち、gml_id で元の `objects.geojson` に戻れる。
潮位を変えるときは `--tide-m-tp 1.00` のように指定する。

---

## 点群を投入する

```bash
scripts/run_pointcloud.sh "/path/to/吉原点群データ"
```

LAS の実態確認 → 被覆・密度の実測 → 京都府 DEM との突き合わせ → 融合地形の生成 →
浸水の再計算 → 地物単位の影響評価 → 表示用 COPC まで通す。
20 GB を数回読むので 30 分程度かかる。

**原本の LAS は変更しない。** PDAL が開けないファイルがあれば、
壊れ方が特定できる場合にかぎり修復コピーを作って読む（`scripts/24_repair_las_evlr.py`）。
使えなかったファイルは成果物 JSON の `dropped_files` に必ず残るので、
空配列でなければ何かが落ちている。

---

## ブラウザで見る

### ローカル

```bash
cd web
pnpm install
pnpm build
pnpm serve          # https://localhost:8443（HTTP/2 + 自己署名 TLS）
```

`serve.mjs` は production 相当の配信を再現する（HTTP/2、Range 206、
事前圧縮 br/gz、immutable キャッシュ、マルチレンジは 400）。
**開発サーバ（`pnpm dev`）でネットワークを測っても意味が無い。**

### 配信する

```bash
cd web
pnpm exec wrangler login          # 初回のみ
pnpm run deploy:dry          # 設定の検証だけ（Cloudflare に何も作らない）
pnpm run deploy              # build → COPC を R2 → Worker をデプロイ
pnpm run deploy:check <URL>  # Range 206 / 圧縮 / キャッシュを実測して合否を出す
```

静的アセットは Workers Assets、**COPC だけ Worker 経由で R2 から Range 配信**する
（Workers Assets は Range に 200 を返すため）。構成と手順は `docs/infra.md`。

COPC が 315 MB を超える場合は `wrangler r2 object put` では上げられない。
`deploy/r2put.sh` が S3 API の multipart に回し、
アップロード後にサイズと先頭 4 バイト（`LASF`）の両方を検証する。

---

### URL のフラグ

viewer の挙動を**既定値を変えずに**切り替える口。計測とデバッグに使う。

| クエリ | 既定 | 何が変わるか |
|---|---|---|
| `?pc=1` | OFF | 点群を出す。**計測では必ず付ける**（既定 OFF なので付けないと decode も LOD も測れない） |
| `?perf=1` | OFF | 計測パネルを開く（`P` キーでも開く） |
| `?z=` | `INITIAL_ZOOM`（17.2） | 起動時のズーム。要求するタイルの z が変わる |
| `?ortho=1` | OFF | 正射投影で起動する |
| `?sse=` | 1.0 | 点間隔の下限 [px]。**小さくするほど深い LOD まで取る** |
| `?maxpts=` | 2,000,000 | 常駐点数の上限 |
| `?maxbytes=` | 帯域推定 × 2（上限 20 MB） | LOD のバイト予算。**帯域推定の揺れを外して比べたいとき固定する** |
| `?rgb=0` | RGB を使う | 点の色を標高ランプに戻す（RGB を読む decode コストの A/B 用） |
| `?coalesce=0` | ON | range coalescing を切る |
| `?defer=1` | OFF | 地物メッシュを遅延ロードする |

## 計測する

```bash
cd web
node perf/run.mjs                          # 4 プロファイルで実測
BASE=https://... node perf/run.mjs         # 実配信に対して
ROUNDS=3 node perf/ab.mjs                  # A/B を交互に n 回、中央値と範囲
FLAG=rgb ROUNDS=3 node perf/ab.mjs         # 比べるフラグを変える（既定は defer）
FLAG=rgb KEYS=decode_p50 PROFILES=normal node perf/ab.mjs
node test/camera.test.mjs                  # 純関数の単体テスト
node test/pair.test.mjs                    # 比較のペアと判定の件数
node test/parity.test.mjs                  # 解析（Python）との一致
node test/png.test.mjs                     # PNG 復号が Pillow と一致するか
```

計測で守ること:

- **headed で測る。** headless では requestAnimationFrame が絞られ、
  再描画駆動の指標（`time_to_plateau`、LOD、カメラ settle）が実際より悪く出る
- **1 回で判断しない。** 絞りなしでも `time_to_terrain` は 478〜992 ms の幅を持つ。
  A/B は `perf/ab.mjs` で交互に複数回まわして中央値と範囲を見る
- **転送量は wire で見る。** デコード後のバイト数は br が効くアセットで 6 倍ずれる

道具の一覧と、それぞれが何を切り分けるためのものかは `docs/web_results.md`。
