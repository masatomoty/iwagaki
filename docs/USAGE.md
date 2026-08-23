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

## 解析を通す

```bash
scripts/run_all.sh        # 取得 → 地形 → 浸水 → 比較 → 地物結合 → 図
scripts/build_web.sh      # → Web 配信アセット（タイル・3D Tiles・catalog）
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
| 50 / 60 | 地物との結合、レポート |
| 80 番台 | Web 配信アセット（タイル・3D Tiles・catalog） |

### 主な成果物（`data/out/`）

| ファイル | 内容 |
|---|---|
| `dtm_{baseline,highres,control,pointcloud}_*.tif` | 4 条件の地形 |
| `h_conn_*.tif` | 連結浸水開始水位。**1 枚で全水位を表す** |
| `objects.geojson` / `objects.csv` | 地物 + 条件ごとの地盤高・`h_conn` |
| `changed_H*.geojson` | 判定が変わった領域 |
| `summary.json` | 設定・指標 |
| `tide_levels.json` | 参照水位（気象庁の推算潮位から計算 + 公表値） |
| `bank_crest.json` | 越流開始水位と護岸天端のプロファイル |

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
npm install
npm run build
npm run serve          # https://localhost:8443（HTTP/2 + 自己署名 TLS）
```

`serve.mjs` は production 相当の配信を再現する（HTTP/2、Range 206、
事前圧縮 br/gz、immutable キャッシュ、マルチレンジは 400）。
**開発サーバ（`npm run dev`）でネットワークを測っても意味が無い。**

### 配信する

```bash
cd web
npx wrangler login          # 初回のみ
npm run deploy:dry          # 設定の検証だけ（Cloudflare に何も作らない）
npm run deploy              # build → COPC を R2 → Worker をデプロイ
npm run deploy:check <URL>  # Range 206 / 圧縮 / キャッシュを実測して合否を出す
```

静的アセットは Workers Assets、**COPC だけ Worker 経由で R2 から Range 配信**する
（Workers Assets は Range に 200 を返すため）。構成と手順は `docs/INFRA.md`。

COPC が 315 MB を超える場合は `wrangler r2 object put` では上げられない。
`deploy/r2put.sh` が S3 API の multipart に回し、
アップロード後にサイズと先頭 4 バイト（`LASF`）の両方を検証する。

---

## 計測する

```bash
cd web
node perf/run.mjs                          # 4 プロファイルで実測
BASE=https://... node perf/run.mjs         # 実配信に対して
ROUNDS=3 node perf/ab.mjs                  # A/B を交互に n 回、中央値と範囲
node test/camera.test.mjs                  # 純関数の単体テスト
```

計測で守ること:

- **headed で測る。** headless では requestAnimationFrame が絞られ、
  再描画駆動の指標（`time_to_plateau`、LOD、カメラ settle）が実際より悪く出る
- **1 回で判断しない。** 絞りなしでも `time_to_terrain` は 478〜992 ms の幅を持つ。
  A/B は `perf/ab.mjs` で交互に複数回まわして中央値と範囲を見る
- **転送量は wire で見る。** デコード後のバイト数は br が効くアセットで 6 倍ずれる

道具の一覧と、それぞれが何を切り分けるためのものかは `docs/WEB_RESULTS.md`。
