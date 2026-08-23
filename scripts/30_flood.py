#!/usr/bin/env python3
"""4 条件（baseline / control / highres / pointcloud）について連結浸水開始水位 h_conn を計算する。

seed（開放水面）は高解像度地形から 1 度だけ求め、全条件で同一のものを使う。
地形ごとに seed が変わると、比較が seed の差に汚染されるため。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, CONNECTIVITY, H_MAX, H_MIN, H_STEP, OUT,
                            RES_COARSE, RES_HIGHRES, SEED_LEVEL, SEED_MIN_AREA)
from iwagaki.flood import compute_h_conn, downsample_mask, find_open_water
from iwagaki.raster import Grid, read, write

CONDITIONS = {
    "baseline": ("dtm_baseline_500.tif", RES_COARSE),
    "control": ("dtm_control_500.tif", RES_COARSE),
    "highres": ("dtm_highres_050.tif", RES_HIGHRES),
    # 実点群を融合した地形（scripts/19）。ファイルが無ければ黙って飛ばす
    "pointcloud": ("dtm_pointcloud_050.tif", RES_HIGHRES),
}


def main() -> int:
    hi, hi_grid, nd = read(OUT / "dtm_highres_050.tif")
    hi[hi == nd] = np.nan

    seed_hi, seed_info = find_open_water(
        hi, SEED_LEVEL, hi_grid.cell_area(), SEED_MIN_AREA, CONNECTIVITY,
        include_nodata=True,
    )
    print(f"open-water seed on {RES_HIGHRES} m grid: {len(seed_info)} component(s), "
          f"{seed_hi.sum() * hi_grid.cell_area():.0f} m2 total")
    for c in seed_info:
        print("   ", c)
    write(OUT / "seed_highres_050.tif", seed_hi.astype("float32"), hi_grid, nodata=-1)

    factor = int(round(RES_COARSE / RES_HIGHRES))
    seed_coarse = downsample_mask(seed_hi, factor, threshold=0.5)

    meta = {
        "aoi": AOI.bounds, "aoi_name": AOI.name,
        "h_min": H_MIN, "h_max": H_MAX, "h_step": H_STEP,
        "connectivity": CONNECTIVITY,
        "seed_level_m_tp": SEED_LEVEL, "seed_min_area_m2": SEED_MIN_AREA,
        "seed_components": seed_info,
        "seed_area_m2": round(float(seed_hi.sum() * hi_grid.cell_area()), 1),
        "nodata_as_water": False,
        "conditions": {},
    }

    for name, (fname, res) in CONDITIONS.items():
        if not (OUT / fname).exists():
            print(f"{name:9s} skip（{fname} が無い）")
            continue
        arr, grid, nodata = read(OUT / fname)
        arr[arr == nodata] = np.nan
        seed = seed_hi if res == RES_HIGHRES else seed_coarse
        if seed.shape != arr.shape:
            raise SystemExit(f"{name}: seed {seed.shape} != dtm {arr.shape}")
        hc = compute_h_conn(arr, seed, H_MIN, H_MAX, H_STEP, CONNECTIVITY)
        reached = np.isfinite(hc)
        meta["conditions"][name] = {
            "dtm": fname, "res_m": res,
            "cells": int(hc.size),
            "seed_cells": int(seed.sum()),
            "reached_cells": int(reached.sum()),
            "reached_area_m2": round(float(reached.sum() * grid.cell_area()), 1),
            "h_conn_median": (round(float(np.median(hc[reached])), 3)
                              if reached.any() else None),
        }
        print(f"{name:9s} res={res:>4} reached {reached.sum()} cells "
              f"({reached.sum() * grid.cell_area():.0f} m2) "
              f"median h_conn={meta['conditions'][name]['h_conn_median']}")
        write(OUT / f"h_conn_{name}.tif", np.where(reached, hc, -9999), grid)

    (OUT / "flood_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print("wrote h_conn_*.tif, flood_meta.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
