#!/usr/bin/env bash
# 実点群のパイプライン一式。scripts/run_all.sh（解析）の後に実行する。
#
#   scripts/run_pointcloud.sh "/path/to/吉原点群データ"
#
# 20 GB を数回読むので、全体で 30 分程度かかる。
# 出力は data/out/dtm_pointcloud_050.tif（融合地形）と
# web/public/data/pointcloud/*.copc.laz（表示用）。
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-.venv/bin/python}"
SRC="${1:?LAS が入ったディレクトリを指定してください}"

echo "== 1. LAS の実態を調べる（CRS / Z の基準 / classification / 密度）"
$PY scripts/16_inspect_las.py "$SRC"

echo "== 2. 被覆と密度を AOI グリッドで測る（streaming, 20 GB を 1 パス）"
$PY scripts/17_pc_coverage.py "$SRC"

echo "== 3. 京都府 0.5m DEM と突き合わせる（使えるデータかの検証）"
$PY scripts/18_pc_vs_dem.py

echo "== 4. 地表面を作り DEM と融合する"
$PY scripts/19_pc_dtm_fuse.py

echo "== 5. 融合地形で浸水を再計算し、比較する"
$PY scripts/30_flood.py
$PY scripts/40_compare.py > /dev/null
$PY scripts/33_flow_accum.py

echo "== 6. 地物単位・護岸帯での影響を測る"
$PY scripts/20_pc_object_impact.py
$PY scripts/21_pc_crest_impact.py

echo "== 7. 表示用 COPC を作る（間引き -> COPC）"
$PY scripts/22_pc_copc.py "$SRC" --cell 0.05

echo "== 8. catalog を作り直し、ドキュメントの数値を更新する"
$PY scripts/83_build_catalog.py
$PY scripts/23_pc_docs_update.py

echo
echo "完了。web を作り直す: cd web && pnpm build"
