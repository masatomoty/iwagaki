#!/usr/bin/env python3
"""結果サマリを出す。

差が出たと言うための指標は docs/design.md「差が出たと言うための指標」に定義がある。
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import ATTRIBUTION, OUT, REPRESENTATIVE_H, TP_OF_MSL

DEM_ACCURACY_M = 0.25   # [未確認] 京都府DEMの公称精度不明。国土地理院の類似成果の目安


def num(v):
    return None if v in ("", None) else float(v)


def main() -> int:
    compare = json.loads((OUT / "compare.json").read_text())
    flood = json.loads((OUT / "flood_meta.json").read_text())
    rows = list(csv.DictReader((OUT / "objects.csv").open()))
    reliable = [r for r in rows if r["unreliable"] == "False"]

    bh = compare["pairs"]["baseline_vs_highres"]
    per_h = {}
    for h in REPRESENTATIVE_H:
        k = f"{h:.2f}"
        ch = [r for r in reliable if r[f"decision_changed@{k}"] == "True"]
        newly_wet = [r for r in ch if num(r[f"depth_highres@{k}"]) > 0
                     and num(r[f"depth_baseline@{k}"]) == 0]
        newly_dry = [r for r in ch if num(r[f"depth_baseline@{k}"]) > 0
                     and num(r[f"depth_highres@{k}"]) == 0]
        per_h[k] = {
            "n_changed": len(ch),
            "n_changed_buildings": sum(r["feature_type"] == "bldg:Building" for r in ch),
            "n_changed_roads": sum(r["feature_type"] == "tran:Road" for r in ch),
            "n_plateau_dry_highres_wet": len(newly_wet),
            "n_plateau_wet_highres_dry": len(newly_dry),
            "n_road_class_change_only": len(ch) - len(newly_wet) - len(newly_dry),
            "area_newly_wet_m2": bh["levels"][k]["area_newly_wet_m2"],
            "area_newly_dry_m2": bh["levels"][k]["area_newly_dry_m2"],
            "depth_diff_p95_m": bh["levels"][k]["depth_diff_p95_m"],
            "depth_diff_max_m": bh["levels"][k]["depth_diff_max_m"],
            "examples": [
                {"gml_id": r["gml_id"], "feature_type": r["feature_type"],
                 "ground_elev_baseline": num(r["ground_elev_baseline"]),
                 "ground_elev_highres": num(r["ground_elev_highres"]),
                 "depth_baseline": num(r[f"depth_baseline@{k}"]),
                 "depth_highres": num(r[f"depth_highres@{k}"])}
                for r in sorted(ch, key=lambda r: -abs(num(r["delta_ground_elev"]) or 0))[:5]
            ],
        }

    dg = np.array([num(r["delta_ground_elev"]) for r in reliable
                   if num(r["delta_ground_elev"]) is not None])

    go = any(v["n_changed"] > 0 for v in per_h.values())
    signal = bh["delta_h_conn"]["frac_abs_gt_0_25m"]

    report = {
        "aoi": {"name": "yoshiwara", "bounds_epsg6674": compare["aoi"],
                "land_area_m2": compare["land_area_m2"],
                "open_water_area_m2": compare["seed_area_m2"]},
        "settings": {k: flood[k] for k in
                     ("h_min", "h_max", "h_step", "connectivity",
                      "seed_level_m_tp", "seed_min_area_m2", "nodata_as_water")},
        "reference_levels_m_tp": {"MSL_maizuru": TP_OF_MSL},
        "terrain": {
            "baseline": "PLATEAU 地形モデル LOD1 TIN (5 m 格子)",
            "highres": "京都府 数値標高モデル 0.5 m (航空レーザ計測 2019-2023)",
            "control": "highres を 5 m に平均集約（解像度効果の切り分け用）",
            "pointcloud": "0.5m DEM に地上点群（バックパック SLAM 2026-07）の地表面を融合",
            "diff": "PLATEAU 5m と 0.5m DEM の判定差（h_conn を 2 チャンネルに格納）",
            "diff_pc": "0.5m DEM と点群融合地形の判定差（点群が何を変えたか）",
        },
        "features": {"total": len(rows), "reliable": len(reliable),
                     "excluded_unreliable": len(rows) - len(reliable)},
        "delta_ground_elev_highres_minus_baseline": {
            "mean": round(float(dg.mean()), 3),
            "p5": round(float(np.percentile(dg, 5)), 3),
            "p50": round(float(np.percentile(dg, 50)), 3),
            "p95": round(float(np.percentile(dg, 95)), 3),
            "frac_abs_gt_dem_accuracy": round(float((np.abs(dg) > DEM_ACCURACY_M).mean()), 4),
        },
        "delta_h_conn": bh["delta_h_conn"],
        "decomposition_frac_abs_delta_h_conn_gt_0_25m": {
            "baseline_vs_highres_total": bh["delta_h_conn"]["frac_abs_gt_0_25m"],
            "baseline_vs_control_data_source": (
                compare["pairs"]["baseline_vs_control"]["delta_h_conn"]["frac_abs_gt_0_25m"]),
            "control_vs_highres_resolution": (
                compare["pairs"]["control_vs_highres"]["delta_h_conn"]["frac_abs_gt_0_25m"]),
        },
        "per_water_level": per_h,
        "go_no_go": {
            "criterion": "同一水位で浸水判定が変わる地物が最低1つ（gml_id つき）",
            "result": "GO" if go else "NO-GO",
            "signal_above_dem_accuracy": bool(signal is not None and signal > 0.02),
            "note": f"DEM高さ精度は[未確認]。目安 {DEM_ACCURACY_M} m を超える差の割合を signal とした",
        },
        "attribution": ATTRIBUTION,
    }
    (OUT / "summary.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
