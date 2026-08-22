#!/usr/bin/env python3
"""点群が護岸天端と越流開始水位を変えるかを見る。

点群が最も効くはずの場所は、幅 1〜2 m の護岸天端。
5m 地形はここを削っており（scripts/87）、0.5m DEM でも 1〜2 セルしかない。
地上から至近距離で測った点群なら、ここを一番正確に取れているはず。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import OUT, RES_HIGHRES
from iwagaki.raster import read

BAND_M = 6.0
CONDITIONS = ("highres", "pointcloud")


def load(name: str) -> np.ndarray:
    a, _, nd = read(OUT / name)
    a[a == nd] = np.nan
    return a


def main() -> int:
    seed = load("seed_highres_050.tif") > 0.5
    hi = load("dtm_highres_050.tif")
    pc = load("dtm_pointcloud_050.tif")
    mask = load("pc_ground_mask_050.tif") > 0.5

    dist = ndimage.distance_transform_edt(~seed) * RES_HIGHRES
    inland = (~seed) & (dist > BAND_M) & np.isfinite(hi)

    spill = []
    for name in CONDITIONS:
        hc, _, nd = read(OUT / f"h_conn_{name}.tif")
        hc[hc == nd] = np.inf
        v = hc[inland & np.isfinite(hc)]
        spill.append({"terrain": name,
                      "spill_m_tp": round(float(v.min()), 3),
                      "p05": round(float(np.percentile(v, 5)), 3),
                      "p50": round(float(np.percentile(v, 50)), 3)})

    # 護岸帯（水際から BAND_M 以内の陸側）のうち、点群が入っているセル
    band = (~seed) & (dist > 0) & (dist <= BAND_M) & np.isfinite(hi) & mask
    d = (pc - hi)[band]

    report = {
        "spill_level": spill,
        "crest_band": {
            "cells_with_pointcloud": int(band.sum()),
            "ha": round(float(band.sum()) * (RES_HIGHRES ** 2) / 1e4, 3),
            "pc_minus_dem_m": {
                "median": round(float(np.median(d)), 3),
                "p05": round(float(np.percentile(d, 5)), 3),
                "p95": round(float(np.percentile(d, 95)), 3),
                "frac_abs_gt_0_10m": round(float((np.abs(d) > 0.10).mean()), 4),
            } if d.size else None,
        },
        "note": "点群は水際まで歩けた所しか無い。護岸帯の被覆が小さければ"
                "「天端を測り直せていない」ということで、差が出ないのは当然になる",
    }
    (OUT / "pc_crest_impact.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    print(f'{"地形":<12}{"越流開始":>10}{"p05":>8}{"p50":>8}')
    for s in spill:
        print(f'{s["terrain"]:<12}{s["spill_m_tp"]:>10.3f}{s["p05"]:>8.3f}{s["p50"]:>8.3f}')
    print(f'\n護岸帯で点群が入っているセル: {band.sum():,} '
          f'({report["crest_band"]["ha"]} ha)')
    if d.size:
        m = report["crest_band"]["pc_minus_dem_m"]
        print(f'  点群 - DEM: median {m["median"]:+.3f}  '
              f'p05 {m["p05"]:+.3f}  p95 {m["p95"]:+.3f} m  '
              f'|差|>0.10m {m["frac_abs_gt_0_10m"]:.1%}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
