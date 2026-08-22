#!/usr/bin/env python3
"""実点群と京都府 0.5m DEM を突き合わせる。

**DTM を作る前にやること。** 点群がそのまま使えるかどうかは、
既知の測量成果と比べないと分からない。ここで見るのは 2 つ。

  1. **鉛直方向のずれ** — SLAM / GNSS のバイアスがあると全体が上下する。
     あれば「測って記録する」。黙って合わせるのは絶対にしない。
  2. **ばらつき** — 開けた地面で数 cm に収まるか。大きければ DTM の質が疑わしい。

比較には scripts/17 が 1 パスで作った min バンド（0.5m セルごとの最低 Z）を使う。
min は地面の第一近似だが、水面反射や地下の外れ値も拾うので、
比較は **中央値と MAD**（外れ値に強い統計）で行う。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import INTERIM, OUT
from iwagaki.raster import read

# 比較に使うセルの条件
MIN_POINTS = 20          # このセルに最低これだけ点があること
FLAT_MAX_RANGE = 0.5     # 3x3 近傍の DEM の高低差がこれ以下（= 開けた平地）
CLIP_M = 3.0             # これを超える差は比較から外す（別物を見ている）


def mad(a: np.ndarray) -> float:
    return float(np.median(np.abs(a - np.median(a))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--coverage", type=Path, default=INTERIM / "pc_coverage.tif")
    ap.add_argument("--dem", type=Path, default=OUT / "dtm_highres_050.tif")
    args = ap.parse_args()

    with rasterio.open(args.coverage) as src:
        descs = list(src.descriptions)
        band = {descs[i - 1]: src.read(i).astype("float64") for i in range(1, src.count + 1)}
        nod = src.nodata
    pc_min = band["min"]
    pc_cnt = band["count"]
    for a in (pc_min, pc_cnt):
        if nod is not None:
            a[a == nod] = np.nan

    dem, grid, dnod = read(args.dem)
    dem[dem == dnod] = np.nan
    if dem.shape != pc_min.shape:
        raise SystemExit(f"格子が違う: dem {dem.shape} vs pc {pc_min.shape}")

    # DEM が平坦な（=開けた地面の）セルだけを比較に使う。
    # 壁・軒下・植生では点群の min と航空レーザの DEM が原理的に一致しない。
    finite = np.isfinite(dem)
    dmax = ndimage.maximum_filter(np.where(finite, dem, -1e9), size=3)
    dmin = ndimage.minimum_filter(np.where(finite, dem, 1e9), size=3)
    flat = finite & ((dmax - dmin) <= FLAT_MAX_RANGE)

    ok = flat & np.isfinite(pc_min) & (np.nan_to_num(pc_cnt) >= MIN_POINTS)
    diff = pc_min - dem
    sel = ok & np.isfinite(diff) & (np.abs(diff) <= CLIP_M)
    d = diff[sel]
    if d.size < 100:
        raise SystemExit(f"比較できるセルが少なすぎる: {d.size}")

    med = float(np.median(d))
    report = {
        "cells": {
            "pc_covered": int(np.isfinite(pc_min).sum()),
            "pc_covered_ge_min_points": int((np.nan_to_num(pc_cnt) >= MIN_POINTS).sum()),
            "dem_flat": int(flat.sum()),
            "compared": int(d.size),
        },
        "criteria": {
            "min_points_per_cell": MIN_POINTS,
            "dem_3x3_range_max_m": FLAT_MAX_RANGE,
            "abs_diff_clip_m": CLIP_M,
            "note": "点群の min（セル最低 Z）と DEM の差。壁・軒下・植生を避けるため "
                    "DEM が平坦なセルだけを使う",
        },
        "diff_pc_minus_dem_m": {
            "median": round(med, 3),
            "mad": round(mad(d), 3),
            "p05": round(float(np.percentile(d, 5)), 3),
            "p25": round(float(np.percentile(d, 25)), 3),
            "p75": round(float(np.percentile(d, 75)), 3),
            "p95": round(float(np.percentile(d, 95)), 3),
            "frac_within_0_10m_of_median":
                round(float((np.abs(d - med) <= 0.10).mean()), 4),
            "frac_within_0_25m_of_median":
                round(float((np.abs(d - med) <= 0.25).mean()), 4),
        },
        "interpretation": [],
    }
    interp = report["interpretation"]
    if abs(med) <= 0.05:
        interp.append(f"鉛直バイアスは {med:+.3f} m。実質ゼロで、両者は同じ鉛直基準にある")
    else:
        interp.append(
            f"鉛直バイアス {med:+.3f} m がある。点群を DTM に使うならこの差を"
            "「測った値」として記録し、補正するかどうかを明示的に決める必要がある")
    if report["diff_pc_minus_dem_m"]["mad"] <= 0.10:
        interp.append("MAD が 0.10 m 以下。開けた地面での一致は良好")
    else:
        interp.append("MAD が 0.10 m を超える。SLAM のドリフトか、min が地面以外を拾っている")

    (INTERIM / "pc_vs_dem.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
