---
title: データ出典
---

# 付録 D. データ出典

詳細な素性・取得方法は解析リポジトリの `docs/data.md` を参照。

| データ | 内容 | 規模 | 用途 | 出典 |
|---|---|---|---|---|
| **PLATEAU 建物 LOD1**（舞鶴市 2025 年度） | CityGML `bldg` | 吉原 AOI 内 930 棟 | 地物の識別子・用途/構造の属性・3D 表示 | [G空間情報センター](https://www.geospatial.jp/ckan/dataset/plateau-26202-maizuru-shi-2025) ／ [PLATEAU](https://www.mlit.go.jp/plateau/) |
| **PLATEAU 道路** | CityGML `tran` | 吉原 AOI 内 293 本（評価対象は橋梁等 6 本を除く 287 本） | 区間種別（橋梁/高架/トンネルの除外） | 同上 |
| **PLATEAU 地形モデル LOD1**（TIN） | CityGML `dem` | 5m 格子相当 | `baseline` 地形 | 同上 |
| **京都府 数値標高モデル（DEM）** | 航空レーザ測量（2019〜2023）、0.5m 格子 | — | `highres` 地形、`control`（5m に集約） | [G空間情報センター](https://www.geospatial.jp/ckan/dataset/dem05_kyoto) |
| **地上点群** | バックパック SLAM、LAS 1.4 | 20.0 GB / 約 5 億点（2026-07 取得） | `pointcloud` 地形、表示用 COPC | [国土地理院 建甲場（舞鶴）](https://cais.gsi.go.jp/cmdc/center/kenchojo/maizuru/maizuru.html) |
| **気象庁 推算潮位**（舞鶴 MZ） | 潮汐推算の毎時値 | 1 年分 | 潮位スライダの参照水位、潮位の記録の再生 | [潮位表](https://www.data.jma.go.jp/kaiyou/db/tide/suisan/suisan.php?stn=MZ) ／ [テキスト版](https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/2026/MZ.txt) |
| **気象庁 観測潮位**（既往・速報） | 1998-09（既往最高）／2026-08（速報値） | — | 実測 2 事象・既往最高潮位 | [既往（1998-09）](https://www.data.jma.go.jp/kaiyou/data/db/tide/genbo/1998/199809/hry199809MZ.txt) ／ [速報（2026-08）](https://www.data.jma.go.jp/kaiyou/data/db/tide/sokuho/202608/z_hry202608MZ.txt) |
| **国土数値情報 鉄道（N02）** | JR 小浜線・舞鶴線のリンク | 東舞鶴 2.77 km / 西舞鶴 1.27 km | PLATEAU に鉄道が無いため別途取得 | [国土数値情報 N02](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02.html) |
| **e-Stat 統計 GIS 境界データ** | 2020 年国勢調査 小地域（町丁・字等） | AOI 3 範囲に交差する 162 面 | 小地域ごとの浸水建物集計 | [統計 GIS](https://www.e-stat.go.jp/gis/statmap-search) |
| **2020 年国勢調査 小地域 統計表** | 人口・年齢（`T001082` ほか） | — | 任意地点圏域の集計（[付録 E](./other-cities)） | [e-Stat（T001082）](https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001082&code=26&downloadType=2) |
| **標高成果 2011 → 2024 補正 / ジオイド** | 水準点標高補正パラメータ、GSIGEO2011 | AOI で N = 36.955 m | 楕円体高 ↔ 標高（T.P.）、潮位の世代換算 | [測量成果 2024](https://www.gsi.go.jp/sokuchikijun/hyoko2024rev.html) ／ [補正計算](https://vldb.gsi.go.jp/sokuchi/surveycalc/hyokorev/hyokorev.html) |
| **京都府 高潮浸水想定区域図** | 910 hPa 想定、基準潮位 T.P.+0.69 m | — | 京都府の想定との対応（未突合） | [京都府 高潮浸水想定](https://www.pref.kyoto.jp/sabo/takashio_shinsui/index.html) ／ [解説 PDF](https://www.pref.kyoto.jp/sabo/takashio_shinsui/documents/takashiokaisetsu.pdf) |
| **既往最高潮位 T.P.+0.93 m の出典** | 1998-09-22、台風 7 号 | — | 代表水位 | 京都府「丹後沿岸海岸保全基本計画」（原典 気象庁）[PDF](https://www.pref.kyoto.jp/shingikai/kaigan-01/documents/shiryo4.pdf) |
| **FARR（mite-shiru 社）** | 地表流の集中・窪地構造のロジック | — | 水みち・窪地の焼き込み（[付録 E](./other-cities)） | [FARR](https://mite-shiru.co.jp/farr/) |
| **高潮被害調査資料**（舞鶴市、非公表） | 2026-07-16 / 2026-08-09 の 2 事象 | 家屋・道路の一覧 | 実測との突き合わせ（[4.1](./results)） | 舞鶴市 危機管理・防災課／消防本部（個人名・住所を含むため git 管理外） |

## 出典表記

成果物には次の帰属表記を含める。

- 「PLATEAU」（国土交通省）
- 京都府「数値標高モデル（DEM）」
- 気象庁「潮位表」
- 「国土数値情報（鉄道データ）」（国土交通省）
- 「政府統計の総合窓口（e-Stat）」の統計 GIS
