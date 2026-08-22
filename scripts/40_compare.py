#!/usr/bin/env python3
"""baseline / control / highres の浸水結果を比較する。

- 粗地形の結果は最近傍で 0.5m 解析格子に展開する（面積を保つため。双線形にすると
  粗地形にはない滑らかさを与えてしまう）。
- 開放水面(seed)は「もともと水」なので陸域の指標からは除外する。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, OUT, REPRESENTATIVE_H, RES_COARSE,
                            RES_HIGHRES, CRS_ANALYSIS)
from iwagaki.raster import Grid, read, upsample_nearest, write

PAIRS = [("baseline", "highres"), ("control", "highres"), ("baseline", "control")]


def load_condition(name: str, factor: int) -> tuple[np.ndarray, np.ndarray]:
    """(elev, h_conn) を 0.5m 解析格子に展開して返す。"""
    dtm_name = {"baseline": "dtm_baseline_500.tif", "control": "dtm_control_500.tif",
                "highres": "dtm_highres_050.tif"}[name]
    e, _, nd = read(OUT / dtm_name)
    e[e == nd] = np.nan
    hc, _, nd2 = read(OUT / f"h_conn_{name}.tif")
    hc[hc == nd2] = np.inf
    if name != "highres":
        e = upsample_nearest(e, factor)
        hc = upsample_nearest(hc, factor)
    return e, hc


def polygonize(mask: np.ndarray, grid: Grid, value: int) -> list[dict]:
    out = []
    for geom, v in shapes(mask.astype("uint8"), mask=mask, transform=grid.transform):
        if v != 1:
            continue
        g = shape(geom)
        out.append({"type": "Feature",
                    "properties": {"change": value, "area_m2": round(g.area, 1)},
                    "geometry": geom})
    return out


def main() -> int:
    grid = Grid.for_aoi(AOI, RES_HIGHRES)
    factor = int(round(RES_COARSE / RES_HIGHRES))
    seed, _, _ = read(OUT / "seed_highres_050.tif")
    seed = seed > 0.5
    land = ~seed
    cell = grid.cell_area()

    cond = {n: load_condition(n, factor) for n in ("baseline", "control", "highres")}

    report: dict = {"aoi": AOI.bounds, "cell_area_m2": cell,
                    "land_area_m2": round(float(land.sum() * cell), 1),
                    "seed_area_m2": round(float(seed.sum() * cell), 1),
                    "pairs": {}}

    for a, b in PAIRS:
        ea, ha = cond[a]
        eb, hb = cond[b]
        key = f"{a}_vs_{b}"
        d = hb - ha                       # Δh_conn (b - a)
        finite = np.isfinite(d) & land
        entry: dict = {
            "delta_h_conn": {
                "n_cells_both_reached": int(finite.sum()),
                "p5": round(float(np.percentile(d[finite], 5)), 3) if finite.any() else None,
                "p50": round(float(np.percentile(d[finite], 50)), 3) if finite.any() else None,
                "p95": round(float(np.percentile(d[finite], 95)), 3) if finite.any() else None,
                "frac_abs_gt_0_25m": (round(float((np.abs(d[finite]) > 0.25).mean()), 4)
                                      if finite.any() else None),
            },
            "levels": {},
        }
        for h in REPRESENTATIVE_H:
            wa = (ha <= h) & land
            wb = (hb <= h) & land
            newly_wet = wb & ~wa
            newly_dry = wa & ~wb
            da = np.where(wa, h - ea, 0.0)
            db = np.where(wb, h - eb, 0.0)
            da = np.where(np.isfinite(da) & (da > 0), da, 0.0)
            db = np.where(np.isfinite(db) & (db > 0), db, 0.0)
            both = wa & wb
            dd = (db - da)[both]
            entry["levels"][f"{h:.2f}"] = {
                f"wet_area_{a}_m2": round(float(wa.sum() * cell), 1),
                f"wet_area_{b}_m2": round(float(wb.sum() * cell), 1),
                "area_newly_wet_m2": round(float(newly_wet.sum() * cell), 1),
                "area_newly_dry_m2": round(float(newly_dry.sum() * cell), 1),
                "depth_diff_mean_m": round(float(dd.mean()), 3) if dd.size else None,
                "depth_diff_p95_m": round(float(np.percentile(np.abs(dd), 95)), 3) if dd.size else None,
                "depth_diff_max_m": round(float(np.abs(dd).max()), 3) if dd.size else None,
            }
            if (a, b) == ("baseline", "highres"):
                feats = (polygonize(newly_wet, grid, 1) + polygonize(newly_dry, grid, -1))
                feats = [f for f in feats if f["properties"]["area_m2"] >= 4.0]
                feats.sort(key=lambda f: -f["properties"]["area_m2"])
                gj = {"type": "FeatureCollection",
                      "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
                      "features": feats}
                p = OUT / f"changed_H{h:.2f}.geojson"
                p.write_text(json.dumps(gj))
                entry["levels"][f"{h:.2f}"]["changed_polygons"] = len(feats)
                entry["levels"][f"{h:.2f}"]["changed_geojson"] = p.name
        report["pairs"][key] = entry

    # Δh_conn ラスタ（全水位を1枚で表す差分）
    _, hb = cond["highres"]
    _, ha = cond["baseline"]
    d = np.where(np.isfinite(hb - ha), hb - ha, -9999)
    write(OUT / "delta_h_conn_baseline_to_highres.tif", d, grid)

    (OUT / "compare.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
