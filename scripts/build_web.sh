#!/usr/bin/env bash
# 解析成果物 -> Web 配信アセット。scripts/run_all.sh のあとに実行する。
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-.venv/bin/python}"

$PY scripts/80_build_web_tiles.py        # RGBA タイル（baseline / highres / diff）
$PY scripts/84_validate_tiles.py         # パッキング往復の検証（性能ではなく正しさ）
$PY scripts/81_build_pointcloud_sample.py  # 配信検証用の合成 COPC（観測データではない）
$PY scripts/82_build_plateau_subset.py   # PLATEAU 3D Tiles の AOI サブセット
$PY scripts/86_tide_levels.py            # 潮位の基準線（水位スライダの目盛り）
$PY scripts/83_build_catalog.py          # catalog.json + objects.geojson(WGS84)
$PY scripts/85_emit_parity_fixture.py    # ブラウザ側の実装との突き合わせ用フィクスチャ

echo
echo "次: cd web && npm install && npm run build && node serve.mjs"
