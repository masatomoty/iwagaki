# TODO（索引）

**生きているタスクはここから辿る。**

| 種別 | 場所 |
|---|---|
| **機能（解析結果を成果物として使える形にする）** | この文書 |
| ネットワーク / 性能 | `docs/WEB_RESULTS.md` §8（実測の根拠つき） |

`docs/WEB_ARCH_REVIEW.md` §10.3 はレビュー時点のスナップショットで、生きたリストではない。

根拠区分は `docs/DATA.md` と同じ（**[実測]** / **[既知]** / **[仮説]** / **[未確認]**）。

---

## A. 解析結果が viewer に届いていない

このリポジトリの問いは「**PLATEAU だけの浸水判定と、点群由来の地形での浸水判定が、
どこで食い違うか**」である（`README.md`）。解析側はその答えを出しているが、
**viewer はその半分しか出していない。**

解析が持っている地形条件は 4 つある:

| 条件 | ラスタ | viewer |
|---|---|---|
| `baseline` | `dtm_baseline_500.tif` / `h_conn_baseline.tif` | **あり** |
| `highres` | `dtm_highres_050.tif` / `h_conn_highres.tif` | **あり** |
| `control` | `dtm_control_500.tif` / `h_conn_control.tif` | **無い** |
| `pointcloud` | `dtm_pointcloud_050.tif` / `h_conn_pointcloud.tif` | **無い** |

> **A1〜A4 は完了した。** `scripts/50` / `scripts/80` / `scripts/83` を 4 条件に広げ、
> viewer の地形切替を 6 択（4 条件 + 差分 2 組）にした。実配信で 6 モードすべての
> 描画を確認済み（`web/perf/surfaces.mjs`）。以下は完了記録として残す。

| # | 優先 | 内容 | 根拠 |
|---|---|---|---|
| ~~A1~~ | **完了** | **点群融合地形を viewer の地形条件に足す** | `scripts/80_build_web_tiles.py` の `CONDITIONS` が baseline / highres の 2 つだけで、`catalog.json` にも出ていない。**⑨ の EVLR まで直して 10 本すべてで出した点群の結果が、画面から一切見られない。** viewer に載っている点群は表示専用で、融合地形の浸水判定とはつながっていない |
| ~~A2~~ | **完了** | **地物属性に点群条件を足す** | `scripts/50_join_semantics.py` が join しているのは baseline / highres のみ（`objects.geojson` の属性も同じ）。既往最高潮位 T.P.+0.93 m で **18 件の判定が変わる**ことは分かっているのに、**その 18 件を画面上で特定できない。** README の成功条件「浸水判定が変わる地点を地物IDつきで確認できること」を、点群条件については満たしていない |
| ~~A3~~ | **完了** | **差分に「highres vs pointcloud」を足す** | 現在の差分タイルは `DIFF_SOURCES = (h_conn_baseline, h_conn_highres)` 固定。**点群が何を変えたかを見るための差分が無い。** 差分は h_conn を 2 チャンネルに詰めた専用ピラミッドなので、組を変えたもう 1 枚を焼けばよい |
| ~~A4~~ | **完了** | `control` 地形を viewer に足す | `docs/DESIGN.md` §6 の「UI（最小）」に **`baseline / highres / control` の 3 つ**と明記されているが、実装は baseline / highres / diff になっている。データ源 10.5 % / 解像度 3.4 % という分解（`docs/RESULTS.md`）の根拠を、画面で確かめられない |

A1〜A3 はどれも「解析側の成果物は既にあり、配信物に載せていないだけ」だった。
新しい解析はしていない。

**やったこと**
- `scripts/80_build_web_tiles.py`: `CONDITIONS` を 4 条件に、差分を 2 組（`diff` / `diff_pc`）に
- `scripts/50_join_semantics.py`: 4 条件すべてを地物に結合
- `scripts/83_build_catalog.py`: `KEEP_PROPS` に 4 条件分を追加
- `scripts/60_report.py`: 新条件のラベル
- `web/src/domain/terrain.ts`（新規）: surface → 幾何タイル / 差分タイルの解決を
  ドメイン側の純関数に切り出した。描画側に分岐を置くと、レンダラを差し替えるたびに書き写すことになる
- `web/src/domain/types.ts`: `TerrainCondition` 4 つ、`SurfaceMode` 6 つ
- `web/src/ui/controls.ts`: 6 択 + 選択中の条件の説明。差分の凡例を組ごとに出し分け
- `web/src/ui/inspector.ts`: 4 条件を並べる。属性が無い条件は「—」

**配信物の増分**: タイル 4.45 → 9.17 MB、`objects.geojson` 570 → 662 kB（デコード後）。
既定は `highres` のままなので**初回転送は変わらない**。他の条件は選んだ時に初めて取る。

> **viewer 側の作業分担**（`threejs-migration` ブランチ以降）。
> `catalog.terrain` が 2 → 6 条件（`baseline` / `highres` / `control` / `pointcloud` /
> `diff` / `diff_pc`）に増えたとき、viewer で直すのは 3 か所だけ:
>
> 1. `src/domain/types.ts` の `SurfaceMode`
> 2. `src/ui/controls.ts` の `SURFACES`
> 3. `src/main.ts` の `buildTerrain()` — 幾何をどの条件から取るか
>    （`diff` は `highres`、`diff_pc` は `pointcloud`）と `diffUrl` の分岐
>
> **シェーダ（`src/three/floodMaterial.ts`）は変更不要。** 差分は h_conn を R/G の
> 2 チャンネルに詰めた同じ形式で、どの組かはタイルの中身の違いでしかない。

---

## B. 明示的な要求で未達のもの

**現在このセクションは空（B1 は完了）。** 記録として残す。

| # | 優先 | 内容 | 根拠 |
|---|---|---|---|
| ~~B1~~ | — | ~~**正射投影（CAD のように xyz 方向から見る）**~~ **完了** | `docs/WEB_RESULTS.md` §8.1.1。MapLibre を外して three.js にした際に `OrthographicCamera` で実現した。カメラプリセット 1〜5（平面・南↑・西→・北↓・東←）が正射に切り替わり、6（俯瞰）は透視のまま。`O` キーと `?ortho=1` でも切り替わる |

---

## C. データが未確認で、機能が作れないもの

| # | 優先 | 内容 | 根拠 |
|---|---|---|---|
| C1 | 中 | **設計高潮位 / 計画高潮位** [未確認] | 京都府「丹後沿岸海岸保全基本計画」の数値（`docs/DATA.md` §4）。確定すれば水位スライダの参照線に足せる。既往最高潮位 T.P.+0.93 m は確定済み |
| C2 | 中 | **水門・樋門・陸閘の位置と敷高** [未確認] | `docs/DESIGN.md` §8 の「既知の限界」2 番。**連結性モデルの最大の弱点**で、seed / 障壁として反映できれば h_conn の前提が変わる。入手できなければ「考慮していない」と明記し続ける |

推測で埋めない。確定できるまで **[未確認]** のまま残す。

---

## D. ドキュメントの陳腐化

| # | 優先 | 内容 | 根拠 |
|---|---|---|---|
| D1 | 低 | `docs/DESIGN.md` §9 の実装順序表 | 「#10 点群パス 実装済み・**未検証**（LAS未入手）」「#11 Webアプリ **未着手**」のまま。どちらも完了している |

---

## D2. three.js 化で発生した宿題

`docs/WEB_RESULTS.md` §8.1.1 の「残っている宿題」と同じもの。**ネットワーク / 性能側なので
生きたリストは `docs/WEB_RESULTS.md` §8 にある。**ここには索引だけ置く。

| # | 優先 | 内容 |
|---|---|---|
| — | 高 | `slow-highrtt` だけ FMR が悪化した理由（転送量は減っている） |
| — | 高 | この計測環境で baseline の PLATEAU が 1 タイルも読まれない件 |
| — | 中 | `THREE.Points` での描画コスト再計測（`PC_MAX_POINTS` の根拠が失効している） |

---

## E. やると決めていないもの（判断が要る）

- **判定が変わる地物の一覧表示 / 書き出し**。現在は地図をクリックして 1 件ずつしか見られない。
  庁内で使うなら一覧や CSV 書き出しが要りそうだが、`docs/DESIGN.md` §6「やらないこと」に
  **「過度な UI 作り込み、印刷レイアウト」**を挙げている。要件を確認してから決める。
- **時系列（潮位の時間変化）**。同上「やらないこと」。静水位モデルなので、
  出すなら「時間発展ではなくパラメータ掃引」であることを画面で明示する必要がある。
