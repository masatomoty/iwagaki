#!/usr/bin/env bash
# 解析成果物 -> Web 配信アセット。scripts/run_all.sh のあとに実行する。
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-.venv/bin/python}"
# 対象範囲。既定は吉原（src/iwagaki/config.py の DEFAULT_AOI）。
#   IWAGAKI_AOI=higashi_maizuru scripts/build_web.sh
AOI="${IWAGAKI_AOI:-yoshiwara}"

$PY scripts/80_build_web_tiles.py        # RGBA タイル（範囲ごとの条件だけ焼く）
$PY scripts/84_validate_tiles.py         # パッキング往復の検証（性能ではなく正しさ）
# 表示用の点群。**吉原だけ。** バックパック SLAM を歩かせたのはそこだけで、
# ほかの範囲では catalog の pointcloud が空になる。
# 実点群があるなら scripts/run_pointcloud.sh 側で作る（scripts/22）。
# ここで作るのは実点群が無いときの代替（合成データ。観測値ではない）。
if [ "$AOI" = "yoshiwara" ] \
   && [ ! -f web/public/data/pointcloud/yoshiwara-backpack-slam.copc.laz ]; then
  $PY scripts/81_build_pointcloud_sample.py
fi
$PY scripts/82_build_plateau_subset.py   # PLATEAU 3D Tiles の AOI サブセット
# JR 線路（国土数値情報 N02）。**PLATEAU 舞鶴市に鉄道は入っていない。**
# 取得系（10・11）ではなくここで回すのは、頂点に 0.5m DEM の標高を焼き込むので
# scripts/21 の出力が要るため。線路が掛からない範囲では何も置かない
$PY scripts/12_fetch_railway.py
if [ "$AOI" = "yoshiwara" ]; then
  $PY scripts/86_tide_levels.py          # 潮位の基準線（験潮場 1 点なので範囲に依らない）
else
  # 潮位は舞鶴験潮場の 1 点。範囲ごとに取り直す意味が無いので複製する
  cp "data/out/yoshiwara/tide_levels.json" "data/out/$AOI/tide_levels.json"
  cp data/out/yoshiwara/tide_series_*.json "data/out/$AOI/"
fi
$PY scripts/83_build_catalog.py          # catalog + objects.geojson(WGS84) + areas.json
if [ "$AOI" = "yoshiwara" ]; then
  $PY scripts/85_emit_parity_fixture.py  # ブラウザ側の実装との突き合わせ用フィクスチャ
fi

echo
echo "次: cd web && pnpm install && pnpm build && node serve.mjs"
