#!/usr/bin/env python3
"""タイルパッキングの往復検証（docs/WEB_DESIGN.md §8.4）。

GeoTIFF -> PNG タイル -> デコード が値を保つことを確認する。
premultiply 事故やビット詰めのミスは絵を見ても気づけないので、数値で押さえる。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iwagaki.config import H_STEP, OUT, ROOT

mod = __import__("80_build_web_tiles")
CONDITIONS, WEB_DATA, sample, decode = mod.CONDITIONS, mod.WEB_DATA, mod.sample, mod.decode

ELEV_TOL = 1.0 / 256.0 + 1e-9
MAX_TILES = 12


def main() -> int:
    fails = 0
    checked = 0
    for cond, (dtm, hconn_f) in CONDITIONS.items():
        tiles = sorted((WEB_DATA / "tiles" / cond).rglob("*.png"))
        step = max(1, len(tiles) // MAX_TILES)
        for p in tiles[::step][:MAX_TILES]:
            y = int(p.stem)
            x = int(p.parent.name)
            z = int(p.parent.parent.name)
            elev_src, _ = sample(OUT / dtm, z, x, y, Resampling.nearest)
            hc_src, _ = sample(OUT / hconn_f, z, x, y, Resampling.nearest)
            rgba = np.asarray(Image.open(p).convert("RGBA"))
            elev_rt, hc_rt = decode(rgba)
            checked += 1

            m = np.isfinite(elev_src)
            if m.any():
                d = np.abs(elev_rt[m] - elev_src[m])
                if not np.isfinite(d).all() or d.max() > ELEV_TOL:
                    print(f"FAIL elev {cond} {z}/{x}/{y}: max|d|={np.nanmax(d):.6f}")
                    fails += 1
            if (~m).any() and np.isfinite(elev_rt[~m]).any():
                print(f"FAIL elev-nodata {cond} {z}/{x}/{y}")
                fails += 1

            mh = np.isfinite(hc_src)
            if mh.any():
                d = np.abs(hc_rt[mh] - hc_src[mh])
                if not np.isfinite(d).all() or d.max() > H_STEP / 2 + 1e-9:
                    print(f"FAIL hconn {cond} {z}/{x}/{y}: max|d|={np.nanmax(d):.6f}")
                    fails += 1
            if (~mh).any() and np.isfinite(hc_rt[~mh]).any():
                print(f"FAIL hconn-nodata {cond} {z}/{x}/{y}")
                fails += 1

    print(f"checked {checked} tiles, {fails} failures "
          f"(elev tol {ELEV_TOL:.6f} m, hconn tol {H_STEP/2} m)")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
