#!/usr/bin/env python3
"""実点群から地表面を作り、京都府 0.5m DEM と融合する。

**点群は DEM の置き換えではない。** 被覆は AOI の 7.1% しかない（scripts/17）。
一方その 7.1% は密度 5,478 点/m2 で、浸水の連結性を決めている
護岸の天端や路地の微地形がまさにそこにある。
そこで **点群がある所だけ上書きし、残りは DEM のまま**にする。

地表面の推定は、scripts/17 が 1 パスで作った 0.5m セルごとの min（最低 Z）を使う。
バックパック SLAM は自分が歩いた地面を必ず見ているので min は良い地面近似だが、
水面反射などで下方向の外れ値が混ざる（実測で Z が -9.9 m まである）。
そこで **ラスタ領域でスパイク除去**してから使う。

融合の前に scripts/18 で鉛直バイアスを実測済み（+0.007 m = 実質ゼロ）。
**バイアスを黙って合わせることはしない。** 閾値を超えたらここで止める。
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

from iwagaki.config import AOI, INTERIM, OUT, RES_HIGHRES
from iwagaki.raster import Grid, read, write

MIN_POINTS = 8           # このセルに最低これだけ点があること
DESPIKE_WIN = 9          # 下向きスパイク判定に使う近傍（セル）
DESPIKE_DROP = 0.40      # 近傍中央値よりこれ以上低ければ外れ値 [m]
# 「そのセルで地面を見たか」の判定（点群だけで完結させる。DEM は使わない）。
# 近傍の最低点より大きく高いセルは、壁面や軒下しか見ていない = 地面未観測とみなす。
GROUND_WIN = 21          # 近傍の広さ（セル）。21 セル = 10.5 m
GROUND_TOL = 0.50        # 近傍最低点からこの高さまでを地面として許容 [m]
MAX_BIAS_M = 0.10        # 鉛直バイアスがこれを超えたら止める
FILL_MAX_CELLS = 2       # 被覆内の小さな穴はこのセル数まで埋める


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--coverage", type=Path, default=INTERIM / "pc_coverage.tif")
    ap.add_argument("--dem", type=Path, default=OUT / "dtm_highres_050.tif")
    args = ap.parse_args()

    with rasterio.open(args.coverage) as src:
        descs = list(src.descriptions)
        band = {descs[i - 1]: src.read(i).astype("float64") for i in range(1, src.count + 1)}
        nod = src.nodata
    zmin, cnt = band["min"], band["count"]
    for a in (zmin, cnt):
        if nod is not None:
            a[a == nod] = np.nan

    dem, grid, dnod = read(args.dem)
    dem[dem == dnod] = np.nan
    if dem.shape != zmin.shape:
        raise SystemExit(f"格子が違う: dem {dem.shape} vs pc {zmin.shape}")

    have = np.isfinite(zmin) & (np.nan_to_num(cnt) >= MIN_POINTS)

    # --- スパイク除去 -----------------------------------------------------
    # 近傍中央値より DESPIKE_DROP 以上低いセルは外れ値（水面反射・地下）とみなす。
    filled = np.where(have, zmin, np.nan)
    med = ndimage.generic_filter(
        np.where(have, zmin, np.nan), np.nanmedian, size=DESPIKE_WIN,
        mode="constant", cval=np.nan)
    spike = have & np.isfinite(med) & ((med - filled) > DESPIKE_DROP)
    kept = have & ~spike

    # --- 地面を見ていないセルを落とす（点群だけで判定）---------------------
    # バックパックは自分が歩いた地面を必ず見るので、地面を見たセルの min は
    # 近傍の最低点とほぼ同じ高さになる。壁面や軒下しか入っていないセルは
    # 近傍最低点より明確に高くなるので、そこで切る。
    big = np.where(kept, zmin, np.inf)
    local_min = ndimage.minimum_filter(big, size=GROUND_WIN, mode="nearest")
    on_ground = kept & np.isfinite(local_min) & ((zmin - local_min) <= GROUND_TOL)
    not_ground = kept & ~on_ground
    ground = np.where(on_ground, zmin, np.nan)

    # 被覆内の小さな穴を埋める（外れ値を抜いた跡）。大きな穴は埋めない
    holes = on_ground & ~np.isfinite(ground)
    if holes.any():
        idx = ndimage.distance_transform_edt(
            ~np.isfinite(ground), return_distances=False, return_indices=True)
        near = ground[tuple(idx)]
        dist = ndimage.distance_transform_edt(~np.isfinite(ground))
        ground = np.where(np.isfinite(ground), ground,
                          np.where(holes & (dist <= FILL_MAX_CELLS), near, np.nan))

    usable = np.isfinite(ground)

    # --- 鉛直バイアスの再確認（融合前の関門）------------------------------
    both = usable & np.isfinite(dem)
    d = (ground - dem)[both]
    bias = float(np.median(d))
    madv = float(np.median(np.abs(d - bias)))
    if abs(bias) > MAX_BIAS_M:
        raise SystemExit(
            f"鉛直バイアス {bias:+.3f} m が閾値 {MAX_BIAS_M} m を超えている。"
            "黙って合わせずに原因を確認すること")

    # --- 融合 -------------------------------------------------------------
    fused = np.where(usable, ground, dem)

    stats = {
        "inputs": {"coverage": str(args.coverage), "dem": str(args.dem)},
        "params": {
            "min_points_per_cell": MIN_POINTS,
            "despike_window_cells": DESPIKE_WIN,
            "despike_drop_m": DESPIKE_DROP,
            "ground_window_cells": GROUND_WIN,
            "ground_tolerance_m": GROUND_TOL,
            "fill_max_cells": FILL_MAX_CELLS,
            "max_bias_m": MAX_BIAS_M,
        },
        "cells": {
            "pc_with_min_points": int(have.sum()),
            "removed_as_spike": int(spike.sum()),
            "removed_as_not_ground": int(not_ground.sum()),
            "usable_pc_ground": int(usable.sum()),
            "usable_ha": round(float(usable.sum()) * grid.cell_area() / 1e4, 3),
            "fraction_of_aoi": round(float(usable.mean()), 4),
            "dem_only": int((np.isfinite(fused) & ~usable).sum()),
            "fused_valid": int(np.isfinite(fused).sum()),
        },
        "pc_minus_dem_on_usable_m": {
            "median_bias": round(bias, 4),
            "mad": round(madv, 4),
            "p05": round(float(np.percentile(d, 5)), 3),
            "p95": round(float(np.percentile(d, 95)), 3),
            "frac_abs_gt_0_25m": round(float((np.abs(d - bias) > 0.25).mean()), 4),
        },
        "note": "点群がある 0.5m セルだけ上書きし、残りは京都府 DEM のまま。"
                "鉛直バイアスは補正していない（実測で無視できる大きさ）",
    }
    write(OUT / "dtm_pointcloud_050.tif", np.where(np.isfinite(fused), fused, -9999), grid)
    write(OUT / "pc_ground_mask_050.tif", usable.astype("float32"), grid, nodata=-1)
    (OUT / "dtm_pointcloud_050.json").write_text(json.dumps(stats, indent=2, ensure_ascii=False))
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    print("\nwrote dtm_pointcloud_050.tif (融合地形), pc_ground_mask_050.tif (点群由来の範囲)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
