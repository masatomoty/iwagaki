# DESIGN — 設計と実装計画

対象: 舞鶴市 吉原地区。目的: PLATEAUの粗い地形（5m格子TIN）では捉えられない微地形を反映した
高潮浸水範囲を求め、**PLATEAU-only の結果と高解像度地形の結果で「判断が変わる場所」**を地物単位で示す。

前提となるデータの実測結果は `docs/DATA.md`。本書はその上に立つ。

---

## 1. 中心となる考え方

### 1.1 役割分担

```
PLATEAU Entity  (bldg:Building / tran:Road)
  ├─ geometry / semantics      … PLATEAUが持つ。ID・用途・構造・階数・道路種別
  ├─ Terrain Observation       … 点群 / 0.5m DEM。現況の地表面
  └─ Derived Assertion         … 本リポジトリが生成する
       ├─ ground_elev          最低地盤高 (m T.P.)
       ├─ h_conn               連結浸水開始水位 (m T.P.)   ← 後述
       ├─ depth(H)             任意水位Hでの浸水深
       └─ exposure / decision  判定クラスと baseline との差異
```

**点群からPLATEAUのgeometryを書き換えない。** PLATEAUのIDに対して assertion を外付けする。
出力は `gml_id` をキーにしたテーブル + GeoJSON であり、CityGMLは変更しない。

### 1.2 「連結浸水開始水位」 h_conn ── 設計の要

単純な `elevation < waterLevel` は使わない。海側seedから連結したセルのみ浸水とする。
ここで、水位Hを掃引するたびにflood fillを回すのではなく、**セルごとに「そのセルが海と連結して
浸水し始める最小の水位」 `h_conn` を1回だけ求める。**

`h_conn` が well-defined なのは、浸水候補集合 `{E <= H}` が H について単調増加であり、
連結性も単調に保たれるため。数学的には `h_conn(c) = min over paths seed→c of max(E along path)`
（bottleneck / minimax path）であり、Priority-Flood 系アルゴリズムと同じ量。

これにより:

| | 効果 |
|---|---|
| 出力 | 地形ごとに **ラスタ1枚** (`h_conn`) で全水位を表現 |
| ブラウザ | `wet(H) = h_conn <= H`, `depth(H) = max(0, H - E)` の2式のみ。**水位スライダが連続かつ即応** |
| 地物 | 地物ごとに `h_conn_min` と `ground_elev` を持たせれば、任意Hでの判定が定数時間 |
| 比較 | baseline と highres の `h_conn` 差 = **「その地点の判定が変わる水位帯」** そのもの |

`decision_changed(H) = (h_conn_base <= H) XOR (h_conn_hi <= H)` となり、
「判断が変わる場所」は `min(h_conn_base, h_conn_hi) <= H < max(...)` の帯で定義できる。

---

## 2. 既存OSSの調査結果 ── 何を再発明しないか

| 課題 | 使うもの | 判断 |
|---|---|---|
| CityGML → GIS形式 | **PLATEAU-GIS-Converter** (Project-PLATEAU / MIERUNE, Rust, CLI+GUI)。GeoPackage/GeoJSON/3D Tiles/MVT出力 | 汎用変換はこれ。ただし本件は `bldg`/`tran`/`dem` の限定的な抽出であり、依存を増やさないため **lxml の iterparse による直接パース**を第一実装とし、Converterは代替経路として文書化 |
| 地形TINのラスタ化 | GDAL (`gdal_grid` / `gdal_rasterize`) | PLATEAU demのTIN頂点は5m格子そのものなので、頂点抽出 → 格子代入で十分。三角形補間は不要 |
| 点群の地面抽出 | **PDAL `filters.smrf`** (Simple Morphological Filter, Pingel et al. 2013)。代替 `filters.pmf` / `filters.csf` | 自前ICP/NDT/segmentationは作らない。classification済みなら `filters.expression` で `Classification == 2` を抜くだけ |
| 点群 → DTM | **PDAL `writers.gdal`** (`output_type=idw` または `min`, `resolution=0.5`) | |
| DTMの穴埋め | `gdal_fillnodata` | |
| 点群のWeb配信 | **COPC** (Cloud Optimized Point Cloud, LAZ1.4 + clustered octree)。`writers.copc` で生成 | 独自タイル形式を作らない。静的ホスティング + HTTP Range で完結 |
| 点群のブラウザ描画 | **copc.js** + **deck.gl `PointCloudLayer`**（`maplibre-gl-lidar` が同構成の実装例）。代替 Potree 2 | |
| 連結浸水 | `scipy.ndimage.label` による水位ステップ走査 | Priority-Flood (Barnes et al. 2014) の自前実装より、成熟ライブラリの連結成分ラベリングを段階適用する方が検証しやすい |
| 地物×ラスタの集計 | `rasterio.features.rasterize` + numpy | `rasterstats` を入れるほどではない |
| 地形のブラウザ配信 | terrain-RGB タイル（`rio-rgbify`）または COG + 直接読み | |
| 3D都市モデル描画 | PLATEAU配布の **3D Tiles** をそのまま利用（deck.gl `Tile3DLayer` / CesiumJS） | 建物ジオメトリを作り直さない |

**手法の位置づけ**: 連結flood fillは coastal flooding の文脈で
"hydrologically connected bathtub model" として確立された手法（Poulter & Halpin 2008 ほか、
NOAA Sea Level Rise Viewer も同系統）。**[既知]** 本件はその適用であって新手法の提案ではない。

---

## 3. AOI と座標系

| 項目 | 値 |
|---|---|
| 解析CRS | **EPSG:6674**（JGD2011 / 平面直角座標系 第VI系）。京都府DEMのネイティブ |
| 鉛直基準 | **標高 T.P.**（京都府DEM・PLATEAU dem ともT.P.） |
| AOI（既定） | E `-61500 … -60500`, N `-60500 … -59500`（**1000 m × 1000 m**） |
| 高解像グリッド | 0.5 m → 2000 × 2000 セル |
| 粗グリッド | 5.0 m → 200 × 200 セル |

AOIは吉原入江と東吉原・西吉原の集落中心を含む。必要タイル（京都府DEM）は
`06LC9443`, `06LC9444`, `06MC0421`, `06MC0422` の4枚（1/50000図郭 `06LC`/`06MC` の境界をまたぐ）。

PLATEAUは `udx/dem/533512_dem_6697_05_op.gml`, `udx/bldg/53351246_bldg_6697_op.gml`,
`udx/tran/53351246_tran_6697_op.gml`。EPSG:6697 (経緯度) → EPSG:6674 に pyproj で変換する。

---

## 4. パイプライン

```
[取得]                     [地形生成]                    [浸水]              [比較・結合]
京都府DEM 0.5m tiles ──┐
                       ├─→ dtm_highres_050.tif ──┐
LAS/LAZ（後日提供） ───┘                          │
   PDAL smrf → DTM                                ├─→ h_conn_*.tif ──┐
                                                  │    (水位ステップ  │
PLATEAU dem GML ──────→ dtm_baseline_500.tif ─────┘     走査)         ├─→ objects.geojson
                                                                      │    objects.csv
PLATEAU bldg/tran GML ─→ buildings.geojson ───────────────────────────┘    summary.json
                         roads.geojson
```

すべてオフライン前処理。成果物は静的ファイル。ブラウザ側にサーバロジックを持たない。

### 4.1 取得 `scripts/10_fetch_*.py`

- 京都府DEM: 3.7GB/10.7GB のzipを**全部落とさない**。HTTP Range で central directory を読み、
  必要な4タイルだけ抜き出す（`06LC`/`06MC` の図郭コード計算は `iwagaki.kokudo` に実装）。
- PLATEAU: 914MB zip から同様に3メンバーだけ抽出。`dem` メンバーはストリーム展開して
  AOI外の三角形を捨てながら読む（748MBを丸ごとメモリに置かない）。

### 4.2 baseline terrain（粗地形）`scripts/20_build_baseline.py`

PLATEAU `dem` の TIN を読み、**三角形の頂点座標のみ**を収集 → EPSG:6674 に変換 →
5m格子にスナップして代入 → `dtm_baseline_500.tif`（5m, EPSG:6674）。

- 根拠: 頂点間隔が実測 5.00〜5.05 m の規則格子であるため、三角形補間は情報を増やさない。
- 検証: 格子への割当率（重複・欠落）をログに出す。欠落は `gdal_fillnodata`。
- **[代替]** PLATEAUを使わず基盤地図情報5mメッシュDEMを baseline にする経路も残す（`--baseline gsi5m`）。

### 4.3 high-resolution terrain `scripts/21_build_highres.py`

- **現行**: 京都府DEM 0.5m の4タイルをAOIでモザイク・クリップ → `dtm_highres_050.tif`
- **点群提供後**: PDALパイプライン
  ```json
  [ "input.laz",
    {"type":"filters.expression","expression":"Classification == 2"},   // 分類済みの場合
    {"type":"filters.smrf"},                                            // 未分類の場合はこちら
    {"type":"filters.range","limits":"Classification[2:2]"},
    {"type":"writers.gdal","filename":"dtm_pc_050.tif","resolution":0.5,
     "output_type":"idw","window_size":3, "nodata":-9999} ]
  ```
  さらに `writers.copc` で `pointcloud.copc.laz` を生成（Web配信用）。
  **要確認事項**（`docs/DATA.md` §3）: CRS、標高か楕円体高か、classificationの有無、取得年月日。

### 4.4 対照条件（resolution effect の切り分け）

「差は解像度のせいか、データソースのせいか」を分離するため、3条件を回す。

| 条件 | 地形 | 解析格子 |
|---|---|---|
| `baseline` | PLATEAU dem TIN | 5.0 m |
| `highres` | 京都府0.5m DEM（将来: 点群DTM） | 0.5 m |
| `control` | 京都府0.5m DEM を平均で5mに集約 | 5.0 m |

`baseline` vs `control` = データソースの差、`control` vs `highres` = 解像度の差。

### 4.5 浸水計算 `scripts/30_flood.py`

入力: 標高ラスタ `E`, seedマスク `S`, 水位範囲 `[H_min, H_max]`, ステップ `dH`（既定 0.05 m）,
連結性 `4|8`（既定 **4**）。

```
h_conn = +inf の配列
for H in arange(H_min, H_max+dH, dH):        # 昇順
    cand = valid & (E <= H)
    lab, n = scipy.ndimage.label(cand, structure=conn)
    seed_labels = set(lab[S & cand]) - {0}
    newly = isin(lab, seed_labels) & isinf(h_conn)
    h_conn[newly] = H
```

- **seed の定義**: 設定ファイルに与える seed ポリゴン（開放水面 = 舞鶴湾・吉原入江・伊佐津川）を
  ラスタ化して使う。「AOI境界に触れる低標高セル」のような暗黙ルールにしない。
- **nodata の扱い**: 既定は**不通過（障壁）**。京都府DEMのnodataは主に開放水面だが、
  建物跡の欠測も混在しうるため自動的に水にはしない。`--nodata-as-water` で切替可能にし、
  両方の結果を summary に記録する。
- **連結性**: 4近傍を既定とする（8近傍は1セルの対角隙間を水が通るため、0.5mでは過大評価しやすい）。
  **baseline と highres で必ず同じ設定を使う。** 設定は出力メタデータに記録する。
- 量子化: `h_conn` の分解能は `dH`。既定0.05 mは京都府DEMの高さ精度（**[未確認]**、
  国土地理院の類似成果で約0.25 m）より細かく、量子化が支配要因にならない範囲。

出力: `h_conn_{condition}.tif`（Float32, nodata=+inf→-9999）, `dtm_{condition}.tif`

### 4.6 比較 `scripts/40_compare.py`

`baseline` / `control` の `h_conn`・`E` を 0.5m 解析格子に**最近傍**でリサンプル
（面積を保つため。双線形にすると粗地形に無い滑らかさを与えてしまう）し、代表水位 H について:

- `wet_base(H)`, `wet_hi(H)` → 浸水面積 [m²]、面積差、newly-wet / newly-dry
- `depth_base(H) = max(0, H - E_base)`, `depth_hi(H)` → 浸水深差の分布（平均・p95・最大）
- `changed(H) = wet_base XOR wet_hi` のポリゴン化（`rasterio.features.shapes`）
- 全水位一括の指標: `Δh_conn = h_conn_hi - h_conn_base`。
  正 = 高解像度では**より高い水位でないと浸かない**（微地形の峰が守っている）
  負 = 高解像度では**より低い水位で浸かる**（粗地形が見落とした低い経路がある）

### 4.7 地物との結合 `scripts/50_join_semantics.py`

PLATEAU `bldg` / `tran` を lxml でパースし EPSG:6674 のポリゴンに落とす。

- **建物**: `bldg:lod0RoofEdge`（屋根外形＝footprint）を使う。
  地盤高は **footprint の外周 1.0 m バッファのリング**から取る（footprint内部のDEMは
  建物除去後の補間値でありゴーストが残るため、内部を使わない）。
  - `ground_elev = リング内の 10パーセンタイル標高`（最低値は外れ値に弱い）
  - `h_conn_obj = リング内の h_conn の最小値`
- **道路**: `tran:Road` の `lod1MultiSurface` をそのままゾーンに使う。
  - `depth_max`, `depth_mean`, `wet_fraction`
  - 通行判定クラス: `0 (安全) / 1 (>=0.1m) / 2 (>=0.3m 通行困難) / 3 (>=0.5m)` ※閾値は設定可能。
    0.3 m を主要閾値とするのは一般的な通行支障の目安に基づく **[仮説: 出典を後で固定する]**

出力 1行 = 1地物:

```
gml_id, feature_type, name, class, usage,
ground_elev_base, ground_elev_hi,
h_conn_base, h_conn_hi, delta_h_conn,
depth_base@H, depth_hi@H, delta_depth@H,
class_base@H, class_hi@H, decision_changed@H
```

`objects.geojson`（Webが直接読む）と `objects.csv`（検証用）を出す。
**`h_conn` を持たせているので、ブラウザ側は任意のHについて上記を再計算できる。**

### 4.8 成果物一覧

```
data/out/
  dtm_baseline_500.tif        5 m   PLATEAU地形
  dtm_control_500.tif         5 m   0.5m DEMを5mに集約
  dtm_highres_050.tif         0.5 m 高解像度地形
  h_conn_baseline.tif / h_conn_control.tif / h_conn_highres.tif
  objects.geojson             建物・道路 + assertion
  changed_H{h}.geojson        代表水位での判定変化ポリゴン
  summary.json                設定・面積指標・go/no-go判定
  pointcloud.copc.laz         （点群提供後）
```

---

## 5. go / no-go

第一段階の成功条件は

> 実際の高解像度地形と粗い地形を同一高潮水位で比較し、**浸水判定が変わる地点を最低1つ**
> 地物IDつきで確認できること。

判定に使う具体的な数値（`summary.json` に出力）:

| 指標 | 意味 |
|---|---|
| `n_objects_changed` | `decision_changed` な建物・道路の数（代表H 1.0 / 1.5 / 2.0 m T.P.） |
| `area_newly_wet_m2` / `area_newly_dry_m2` | |
| `delta_h_conn` の p5 / p50 / p95 | 判定が変わる水位帯の広さ |
| `n_changed_control_vs_highres` | 解像度だけで生じる差 |

**no-go の兆候**: どの水位でも `n_objects_changed == 0`、または差が
DEM高さ精度（**[未確認]**, 目安0.25 m）以下のノイズに収まる場合。
その場合はAOIを変える（吉原入江の護岸沿い、より低平な河口部）か、水位刻みを見直す。

現時点の**事前見込み [仮説]**: 吉原の集落地盤は 0.5〜3 m T.P. に集中しており（実測）、
5m格子ではこのレンジの微地形が平滑化される。護岸天端と背後地盤の差が数十cmなので、
差は出る可能性が高い。ただし**未検証**。

---

## 6. Webアプリ（解析成立後）

### 構成 [第一候補]

```
静的ホスティング (S3/R2/Pages)
  ├─ 3dtiles/       PLATEAU 建物 LOD1/LOD2（配布物をそのまま）
  ├─ objects.geojson / roads.geojson
  ├─ terrain/       dtm_* を terrain-RGB タイル（rio-rgbify）
  ├─ hconn/         h_conn_* を同形式で
  └─ pointcloud.copc.laz
        ↓ HTTP Range
ブラウザ: MapLibre GL JS + deck.gl
  Tile3DLayer(建物) / GeoJsonLayer(道路・変化地物) /
  TerrainLayer(地形) / PointCloudLayer + copc.js(点群)
```

CesiumJSも候補（3D Tilesと quantized-mesh 地形が素直）。
**判断**: MapLibre+deck.gl を第一候補とする。理由は COPC の既存実装
（`maplibre-gl-lidar` = copc.js + deck.gl）がこの構成で動いており、
点群Web配信の再発明を避けられるため。

### UI（最小）

- 水位スライダ（T.P. 0.0 〜 3.0 m）。目盛りに MSL(+0.124 m) を表示。
  H.W.L. / 既往最高潮位 / 設計高潮位が確定したら追加（`docs/DATA.md` §4 未確認）
- 地形切替: baseline / highres / control
- 点群 ON/OFF
- 差分表示 ON/OFF（newly-wet を赤、newly-dry を青）
- 建物・道路クリック → `ground_elev`, `h_conn`, `depth`, 判定クラス、baselineとの差

浸水深の描画は**シェーダで `max(0, H - E)` を評価し、`h_conn <= H` でマスク**する。
水位変更でサーバ往復もCPU再計算も発生しない。

### やらないこと

過度なUI作り込み、レイヤ管理UI、時系列アニメーション、印刷レイアウト。

---

## 7. 非目標（初期段階では実装しない）

- 本格的なCFD / 2次元浅水方程式ソルバ（越流量・時間発展・河川流入は扱わない）
- 独自ICP/NDT による点群レジストレーション
- 点群 segmentation AI
- CityGMLの自動更新・書き戻し
- 大規模GISバックエンド（DB・タイルサーバ・API）
- 全舞鶴市の処理

---

## 8. 既知の限界（成果物に明記する）

1. **静水位モデル**であり、越流の時間発展・流量・波の打ち上げを含まない。
2. **地下構造物・暗渠・樋門を考慮しない**。実際の連結性はこれらに強く依存する。
   → 排水施設・水門の位置情報が入手できれば seed / 障壁として反映するのが次の改善点。
3. 京都府DEMは**森林資源把握を目的**とした成果であり、市街地の精度は保証されていない
   （`docs/DATA.md` §2）。建物跡地の補間値は特に信頼度が低いため、建物地盤高は
   footprint内部ではなく外周リングから取る。
4. 計測年次が **2019〜2023** のいずれか不明（**[未確認]**）。PLATEAU（2026-03作成）との時期差がある。
5. 高潮水位は**指定ハザードではなくパラメータ**。舞鶴に高潮浸水想定区域の指定は存在しない。
6. `h_conn` の分解能は水位ステップ `dH`（既定 0.05 m）に量子化される。

---

## 9. 実装順序

| # | 内容 | 状態 |
|---|---|---|
| 1 | `iwagaki.kokudo`: 国土基本図図郭 ↔ 平面直角座標。京都府DEMタイル特定 | **完了**（8タイルで検証） |
| 2 | `scripts/10_fetch_kyoto_dem.py`: HTTP Rangeでタイル抽出 | **完了** |
| 3 | `scripts/11_fetch_plateau.py`: CityGMLからメンバー抽出 | **完了** |
| 4 | `scripts/20_build_baseline.py`: TIN頂点 → 5mラスタ | **完了**（fill 85.2%） |
| 5 | `scripts/21_build_highres.py`: 0.5mモザイク + control生成 | **完了** |
| 6 | `scripts/30_flood.py`: h_conn 計算（3条件） | **完了** |
| 7 | `scripts/40_compare.py`: 差分指標と changed ポリゴン | **完了** |
| 8 | `scripts/50_join_semantics.py`: bldg/tran パース + 地物別 assertion | **完了**（911地物） |
| 9 | `scripts/60_report.py` **go/no-go 判定** | **完了 → GO**（`docs/RESULTS.md`） |
| 10 | 点群パス（PDAL → DTM 融合 → COPC） | **完了**。実 LAS 10 本（20.0 GB / 4.98 億点）で検証（`scripts/17`〜`19`, `22`, `24`。`docs/RESULTS.md`） |
| 11 | Webアプリ | **完了**（`docs/WEB_DESIGN.md` / `docs/WEB_RESULTS.md`）。Cloudflare に配信済み。ただし **`control` と `pointcloud` の 2 条件が viewer に載っていない**（`docs/TODO.md` A1・A4） |

### 設計から変わった点（実装して分かったこと）

- PLATEAU dem は AOI が 3次メッシュ象限ファイルの境界をまたぐため**複数ファイルが必要**だった。
  京都府DEMも 1/50000 図郭 `06LC`/`06MC` の境界をまたぐ。どちらも「1枚で足りる」と思い込むと欠測する。
- seed は「常に水位Hの開境界」として標高 −inf 扱いにする形に整理した。
  京都府DEMでは海域が nodata なので、seed 候補に nodata を含める必要があった。
- 建物・道路の集計ゾーンから**開放水面セルを除外**する処理を追加した。
  さらに PLATEAU の `uro:RoadStructureAttribute.sectionType`（橋梁・高架橋・アンダーパス・トンネル）
  で、DTM由来の地盤高が意味を持たない地物を除外した。これが無いと橋の上の道路が
  「水面標高の地盤」として偽陽性の上位に並ぶ。
- 差の主因は**解像度ではなくデータソース**だった（`docs/RESULTS.md`）。当初の見立てと異なる。
