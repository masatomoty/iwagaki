#!/usr/bin/env python3
"""点群が地形に効いている範囲を輪郭 GeoJSON にする。

AOI は 100 ha だが、点群が地表面として使えているのは 3.17 ha しかない
（`docs/results.md`）。画面上でそれが分からないと、
**「点群で高精度に見た結果」が AOI 全域に効いているように読めてしまう。**
実際に効いているのは歩いた帯だけなので、その境界を明示する。

入力は scripts/19 が書く pc_ground_mask_050.tif（点群由来の地表面が使えたセル）。
0.5 m セルをそのまま多角形にすると頂点が数十万個になるので、
- 形態学的な closing で 1 セルの穴を埋め
- 面積が小さい破片を落とし
- 頂点を間引く（許容誤差はセル寸法と同じ 0.5 m。それ以上は形が変わる）
という順で、意味を変えない範囲だけ軽くする。

出力は WGS84（viewer の objects.geojson と同じ座標系）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import shapes
from scipy import ndimage
from shapely.geometry import mapping, shape
from shapely.ops import transform as shapely_transform
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import CRS_ANALYSIS, OUT, ROOT

WEB_DATA = ROOT / "web" / "public" / "data"
OUT_NAME = "pc_coverage.geojson"

# 1 セル（0.5 m）の穴・ひげを埋める。歩行帯は連続しているはずなので、
# 1 セルの抜けはノイズとみなす
CLOSING_CELLS = 1
# これより小さい破片は落とす。0.5 m セル 16 個 = 4 m²。
# 「歩いた帯」と呼べない大きさの点在は輪郭として意味を持たない
MIN_AREA_M2 = 4.0
# 頂点間引きの許容誤差。セル寸法と同じにして「セル境界の階段を直線化する」程度に留める
SIMPLIFY_M = 0.5
# 座標の小数桁。6 桁 = 約 11 cm で、0.5 m 解像度の輪郭には十分
COORD_DECIMALS = 6


def round_coords(obj, nd: int):
    """GeoJSON の座標を丸める。7 桁(1 cm)は 0.5 m の輪郭には過剰で、ただ嵩む"""
    if isinstance(obj, dict):
        return {k: round_coords(v, nd) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [round_coords(v, nd) for v in obj]
    if isinstance(obj, float):
        return round(obj, nd)
    return obj


def main() -> int:
    src_path = OUT / "pc_ground_mask_050.tif"
    with rasterio.open(src_path) as src:
        a = src.read(1)
        nod = src.nodata
        transform = src.transform
        res = abs(transform.a)
    mask = np.isfinite(a) & (a != nod) & (a > 0.5)
    raw_cells = int(mask.sum())

    closed = ndimage.binary_closing(mask, np.ones((CLOSING_CELLS * 2 + 1,) * 2))
    polys = [shape(g) for g, v in
             shapes(closed.astype("uint8"), mask=closed, transform=transform) if v == 1]
    kept = [p for p in polys if p.area >= MIN_AREA_M2]
    merged = unary_union(kept)
    simplified = merged.simplify(SIMPLIFY_M, preserve_topology=True)

    to_wgs = Transformer.from_crs(CRS_ANALYSIS, "EPSG:4326", always_xy=True).transform
    wgs = shapely_transform(to_wgs, simplified)

    n_vert = sum(len(g.exterior.coords) for g in getattr(wgs, "geoms", [wgs]))
    geom = round_coords(mapping(wgs), COORD_DECIMALS)
    fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "what": "点群が地表面として使えた範囲",
                # 輪郭の面積は、帯の内側の抜け（壁・軒下で地表面と判定できなかったセル）を
                # 埋めた後の値なので、実セル面積より少し大きい。両方出して混同を防ぐ
                "area_ha_cells": round(float(raw_cells) * res * res / 1e4, 3),
                "area_ha_outline": round(merged.area / 1e4, 3),
                "cells": raw_cells,
                "resolution_m": res,
                "note": "この外側の地形は京都府 0.5m DEM のまま。点群は効いていない",
            },
        }],
    }
    outp = WEB_DATA / OUT_NAME
    outp.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({
        "cells": raw_cells,
        "area_ha_raw": round(float(raw_cells) * res * res / 1e4, 3),
        "area_ha_outline": round(merged.area / 1e4, 3),
        "parts": len(getattr(wgs, "geoms", [wgs])),
        "dropped_parts": len(polys) - len(kept),
        "vertices": n_vert,
        "bytes": outp.stat().st_size,
        "out": str(outp.relative_to(ROOT)),
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
