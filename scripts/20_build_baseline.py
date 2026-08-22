#!/usr/bin/env python3
"""PLATEAU 地形モデル(dem, LOD1 TIN) から粗地形ラスタ(5m)を作る。

TIN の頂点間隔は実測 5.00〜5.05 m の規則格子（docs/DATA.md §1）なので、
三角形補間は情報を増やさない。頂点を 5m 格子に集約するだけにする。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.citygml import iter_tin_vertices
from iwagaki.config import (AOI, CRS_ANALYSIS, CRS_LONLAT, INTERIM, OUT,
                            PLATEAU_MEMBERS, RAW, RES_COARSE)
from iwagaki.raster import Grid, write

CACHE = INTERIM / "plateau_tin_vertices.npy"


def load_vertices() -> np.ndarray:
    """AOI(+バッファ) 内の TIN 頂点を EPSG:6674 の (x, y, z) で返す。"""
    if CACHE.exists():
        return np.load(CACHE)
    fwd = Transformer.from_crs(CRS_ANALYSIS, CRS_LONLAT, always_xy=True)
    a = AOI.buffered(3 * RES_COARSE)
    lon0, lat0 = fwd.transform(a.xmin, a.ymin)
    lon1, lat1 = fwd.transform(a.xmax, a.ymax)
    chunks = []
    for member in PLATEAU_MEMBERS["dem"]:
        src = RAW / "plateau" / Path(member).name
        print(f"scanning {src.name} ({src.stat().st_size/1e6:.0f} MB) ...")
        got = [c for c in iter_tin_vertices(src, (lon0, lat0, lon1, lat1))]
        n = sum(len(c) for c in got)
        print(f"  {n} vertices in AOI")
        chunks.extend(got)
    v = np.vstack(chunks)
    back = Transformer.from_crs(CRS_LONLAT, CRS_ANALYSIS, always_xy=True)
    x, y = back.transform(v[:, 0], v[:, 1])
    out = np.column_stack([x, y, v[:, 2]])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.save(CACHE, out)
    return out


def main() -> int:
    v = load_vertices()
    grid = Grid.for_aoi(AOI, RES_COARSE)
    col = np.floor((v[:, 0] - AOI.xmin) / RES_COARSE).astype(int)
    row = np.floor((AOI.ymax - v[:, 1]) / RES_COARSE).astype(int)
    inside = (col >= 0) & (col < grid.width) & (row >= 0) & (row < grid.height)
    col, row, z = col[inside], row[inside], v[inside, 2]

    idx = row * grid.width + col
    n = grid.width * grid.height
    total = np.bincount(idx, weights=z, minlength=n)
    count = np.bincount(idx, minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    arr = mean.reshape(grid.height, grid.width)

    filled = int(np.isfinite(arr).sum())
    stats = {
        "grid": [grid.height, grid.width],
        "res_m": RES_COARSE,
        "vertices_used": int(len(z)),
        "cells_filled": filled,
        "cells_total": n,
        "fill_fraction": round(filled / n, 4),
        "z_min": round(float(np.nanmin(arr)), 3),
        "z_max": round(float(np.nanmax(arr)), 3),
        "vertices_per_filled_cell": round(len(z) / max(filled, 1), 2),
    }
    print(json.dumps(stats, indent=2))

    out = write(OUT / "dtm_baseline_500.tif", np.where(np.isfinite(arr), arr, -9999), grid)
    print("wrote", out)
    (OUT / "dtm_baseline_500.json").write_text(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
