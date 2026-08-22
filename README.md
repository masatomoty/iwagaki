# iwagaki

舞鶴市**吉原**地区を対象に、**PLATEAU 3D都市モデル**と**高解像度地形観測**を組み合わせ、
PLATEAUの粗い地形表現（5m格子TIN）では捉えられない微地形を反映した高潮浸水範囲を可視化するプロトタイプ。

## 何をするものか

単なる「PLATEAU + 点群の3D重畳」ではなく、両者の役割を分ける。

| 役割 | データ | 意味 |
|---|---|---|
| **semantic city model** | PLATEAU (bldg / tran / urf / luse) | 建物・道路の「意味」と識別子 |
| **terrain observation** | 高解像度DTM（点群 / 0.5m DEM） | 現況の微地形 |
| **derived assertion** | 本リポジトリの解析結果 | 地物ごとの最低地盤高・浸水深・判定変化 |

最終出力は、同一の高潮水位 H に対する

- `baseline`   = PLATEAU地形（5m格子TIN）由来の浸水結果
- `highres`    = 高解像度DTM（0.5m / 点群由来）の浸水結果

の比較であり、**「どの道路・建物で浸水判定が変わるか」** を地物単位で提示する。

## 現在のステータス

- [x] データ調査（`docs/DATA.md`）— 舞鶴・吉原で必要データが揃うことを実測確認
- [x] 設計・実装計画（`docs/DESIGN.md`）
- [x] 最小 vertical slice — **go/no-go は GO**（`docs/RESULTS.md`）
- [x] Web 配信・描画・ネットワーク設計（`docs/WEB_DESIGN.md`）と最小 viewer（`web/`）
- [ ] LAS/LAZ 点群パス（PDAL ground filter → DTM → COPC）※ 点群データは別途提供予定、スクリプトは用意済み・未検証
- [ ] Cloudflare へのデプロイと LAS アップロード経路

### 第一段階の結果 → **GO**

> 成功条件: 同一高潮水位で、浸水判定が変わる地点を最低1つ、地物IDつきで確認できること。

水位 **H = 1.0 m T.P.** において、**905件のPLATEAU地物のうち 137件（15.1%）で浸水判定が変わった。**

![H=1.0m での比較](docs/images/flood_compare_H1.0.png)

左=PLATEAU 5m地形の浸水域、中=0.5m LiDAR地形の浸水域、右=差分（赤=新たに浸水／黄=浸水しなくなる）。
浸水面積の合計はほぼ同じ（124,979 m² vs 122,733 m²）でも、**場所が違う**。
陸域 702,033 m² のうち 41,002 m²（5.8%）で判定が入れ替わる。

差の要因を分解すると、**主因は解像度ではなくデータソース**だった
（`|Δh_conn| > 0.25 m` のセル割合: 合計 12.7% ＝ データソース差 10.5% ＋ 解像度差 3.4%）。

詳細・限界・次の一手は `docs/RESULTS.md`。

## 対象範囲（AOI）

舞鶴市 吉原（東吉原・西吉原、吉原入江周辺）。

| 項目 | 値 |
|---|---|
| 中心付近 | 東経 135.3298°, 北緯 35.4558°（東吉原） |
| 平面直角座標 | JGD2011 / 系VI（EPSG:6674）, X≈-60165 m, Y≈-60839 m |
| AOI矩形（既定） | E -62000〜-60000, N -60750〜-59250（2000 m × 1500 m） |
| 標高レンジ | 水面 0 m 〜 背後山地 258 m。市街地部は概ね **0.5〜3 m T.P.** |

吉原は二本の水路（吉原入江・伊佐津川）に挟まれた低平な砂州上の漁村集落であり、
「護岸天端・道路の微かな峰・路地の窪み」が浸水連結性を支配する。5m格子ではこれらが平滑化される。
微地形が効くことを期待する典型地形として選定した。

## リポジトリ構成

```
docs/
  DATA.md        データ棚卸し（出典・CRS・解像度・ライセンス・未確認事項）
  DESIGN.md      解析の設計と実装計画
  RESULTS.md     第一段階（解析）の結果と go/no-go
  WEB_DESIGN.md  Web 配信・描画・ネットワーク設計
  WEB_RESULTS.md ネットワーク実測の結果
src/iwagaki/     解析ライブラリ
scripts/         前処理パイプライン（番号順に実行）
data/
  raw/           取得した原データ（git管理外）
  interim/       中間生成物（git管理外）
  out/           成果物: DTM, 浸水深, 差分, 地物別テーブル（git管理外）
web/             ブラウザ可視化
  src/domain/    純ロジック（描画ライブラリに依存しない）
  src/net/       リクエストスケジューラ（優先度・帯域・キャンセル・coalescing）
  src/pointcloud/ COPC index / LOD / decode / renderer（差し替え可能）
  src/view/      MapLibre + deck.gl
  serve.mjs      production 相当の静的配信（HTTP/2・Range・事前圧縮）
  perf/run.mjs   ネットワークプロファイル別の実測ハーネス
```

## セットアップ

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

外部ツール: GDAL 3.x（CLI）, PDAL 2.x（点群パスで使用）。

## 実行

```bash
scripts/run_all.sh          # 取得 → 地形生成 → 浸水計算 → 比較 → 地物結合 → 図
scripts/build_web.sh        # → Web 配信アセット（タイル・COPC・3D Tiles・catalog）
```

初回は京都府DEMタイル4枚（各12MB）とPLATEAU CityGML 4メンバー（計1.25GB）を取得する。
図郭zipは3.7〜10.7GBあるがHTTP Rangeで必要分だけ落とすので全体はダウンロードしない。
2回目以降はキャッシュを使い1分程度で完走する。

主な成果物（`data/out/`）:

| ファイル | 内容 |
|---|---|
| `dtm_baseline_500.tif` | PLATEAU地形 5m |
| `dtm_highres_050.tif` | 高解像度地形 0.5m |
| `dtm_control_500.tif` | 高解像度地形を5mに集約（解像度効果の切り分け用） |
| `h_conn_*.tif` | 連結浸水開始水位。**1枚で全水位を表す** |
| `objects.geojson` / `objects.csv` | 建物・道路 + 地物別 assertion |
| `changed_H*.geojson` | 判定が変わった領域 |
| `summary.json` | 設定・指標・go/no-go |

### 点群を投入する

```bash
.venv/bin/python scripts/15_pointcloud_dtm.py path/to/input.laz --inspect  # まず中身を確認
.venv/bin/python scripts/15_pointcloud_dtm.py path/to/input.laz            # DTM + COPC 生成
scripts/run_all.sh --source pointcloud
```

## 出典・ライセンス

本リポジトリのコードは MIT。データは各提供元の規約に従う。

- 3D都市モデル（Project PLATEAU）舞鶴市（2025年度）, 国土交通省 — PLATEAU Site Policy
- 京都府オープンデータ「数値標高モデル（DEM）」（航空レーザ計測 平成31〜令和5年） — 公共データ利用規約(PDL1.0)、**出典表示および加工した旨の明示が必要**
- 潮位諸元: 気象庁 潮位観測資料（舞鶴 MZ）

詳細と注意事項（測量法43/44条、森林資源把握目的の成果である旨など）は `docs/DATA.md` を参照。
