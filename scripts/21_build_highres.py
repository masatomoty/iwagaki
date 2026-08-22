#!/usr/bin/env python3
"""高解像度地形(0.5m)と、解像度効果切り分け用の control(5m集約) を作る。

現行の高解像度地形 = 京都府 数値標高モデル 0.5m。
点群提供後は `--source pointcloud` で PDAL 由来の DTM に差し替える（同じ出力名を書く）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, KYOTO_DEM_ZIPS, OUT, RAW, RES_COARSE,
                            RES_HIGHRES)
from iwagaki.kokudo import tiles_covering
from iwagaki.raster import Grid, aggregate, mosaic_clip, read, write


def from_kyoto_dem() -> np.ndarray:
    tiles = tiles_covering(*AOI.bounds, sheets=tuple(KYOTO_DEM_ZIPS))
    paths = [RAW / "kyoto_dem" / f"{t.name}.tif" for t in tiles]
    missing = [p for p in paths if not p.exists()]
    if missing:
        raise SystemExit(f"missing tiles: {missing}. run scripts/10_fetch_kyoto_dem.py")
    grid = Grid.for_aoi(AOI, RES_HIGHRES)
    print(f"mosaicking {len(paths)} tiles -> {grid.height}x{grid.width} @ {RES_HIGHRES} m")
    return mosaic_clip(paths, grid)


def from_pointcloud(path: Path) -> np.ndarray:
    """PDAL 由来の DTM を AOI グリッドに合わせて読み込む。

    writers.gdal の origin は左下・北上きなので、AOI グリッドと厳密に一致しない
    ことがある。一致しなければモザイク経路で再サンプルして合わせる。
    """
    if not path.exists():
        raise SystemExit(f"{path} が無い。先に scripts/15_pointcloud_dtm.py を実行する")
    grid = Grid.for_aoi(AOI, RES_HIGHRES)
    arr, g, nodata = read(path)
    if (g.height, g.width) == (grid.height, grid.width) and \
            abs(g.transform.c - grid.transform.c) < 1e-6 and \
            abs(g.transform.f - grid.transform.f) < 1e-6:
        arr[arr == nodata] = np.nan
        return arr
    print(f"point-cloud DTM grid {g.height}x{g.width} != AOI grid "
          f"{grid.height}x{grid.width}; resampling")
    return mosaic_clip([path], grid)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=("kyoto_dem", "pointcloud"), default="kyoto_dem")
    ap.add_argument("--pointcloud-dtm", type=Path,
                    default=OUT / "dtm_pointcloud_050.tif")
    args = ap.parse_args()

    arr = (from_kyoto_dem() if args.source == "kyoto_dem"
           else from_pointcloud(args.pointcloud_dtm))
    grid = Grid.for_aoi(AOI, RES_HIGHRES)

    factor = int(round(RES_COARSE / RES_HIGHRES))
    ctrl = aggregate(arr, factor)
    ctrl_grid = Grid.for_aoi(AOI, RES_COARSE)

    stats = {
        "source": args.source,
        "highres": {
            "grid": [grid.height, grid.width], "res_m": RES_HIGHRES,
            "valid_fraction": round(float(np.isfinite(arr).mean()), 4),
            "z_min": round(float(np.nanmin(arr)), 3),
            "z_max": round(float(np.nanmax(arr)), 3),
            "z_median": round(float(np.nanmedian(arr)), 3),
        },
        "control": {
            "grid": [ctrl_grid.height, ctrl_grid.width], "res_m": RES_COARSE,
            "valid_fraction": round(float(np.isfinite(ctrl).mean()), 4),
        },
    }
    print(json.dumps(stats, indent=2))
    write(OUT / "dtm_highres_050.tif", np.where(np.isfinite(arr), arr, -9999), grid)
    write(OUT / "dtm_control_500.tif", np.where(np.isfinite(ctrl), ctrl, -9999), ctrl_grid)
    (OUT / "dtm_highres_050.json").write_text(json.dumps(stats, indent=2))
    print("wrote dtm_highres_050.tif, dtm_control_500.tif")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
