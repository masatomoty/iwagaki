#!/usr/bin/env bash
# 前処理パイプライン一式。data/out/ に成果物が出る。
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-.venv/bin/python}"

$PY scripts/10_fetch_kyoto_dem.py
$PY scripts/11_fetch_plateau.py
$PY scripts/20_build_baseline.py
$PY scripts/21_build_highres.py "$@"
$PY scripts/30_flood.py
# 地表流の集中・窪地構造（潮位非依存の別レイヤ。浸水判定には混ぜない）。
# **仮想吐口の 32 より前に回す** — 32 は 33 が出す窪地の越流点を陸側端に使う
$PY scripts/33_flow_accum.py
AOI_NAME="${IWAGAKI_AOI:-yoshiwara}"
if [ "$AOI_NAME" = "nishi_maizuru" ] || [ "$AOI_NAME" = "higashi_maizuru" ]; then
  PAIRS="data/out/${AOI_NAME}/synthetic_outfall_pairs.geojson"
  if [ ! -f "$PAIRS" ]; then
    $PY scripts/32_generate_synthetic_outfall_pairs.py --output "$PAIRS"
  fi
  $PY scripts/31_drainage_flood.py --pairs "$PAIRS"
fi
$PY scripts/40_compare.py > /dev/null
$PY scripts/50_join_semantics.py
$PY scripts/60_report.py
$PY scripts/70_figures.py
