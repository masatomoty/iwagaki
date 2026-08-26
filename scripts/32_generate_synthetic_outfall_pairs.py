#!/usr/bin/env python3
"""DEMと既存h_connから仮想吐口ペアを作る。

対象は「標高は潮位以下だが、地表面では海と連結していない」窪地。
各窪地から低いセルを最大1点選び、最寄りのopen-water seedを海側の
geometryとして、inland_nodeとのペアをGeoJSONへ出力する。

これは実在する排水口の復元ではなく、S2の感度を確認するための仮想データ。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, OUT
from iwagaki.raster import read


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-h", type=float, default=0.93)
    ap.add_argument("--max-pairs", type=int, default=12)
    ap.add_argument("--min-area-m2", type=float, default=250.0)
    ap.add_argument("--output", type=Path,
                    default=OUT / "synthetic_outfall_pairs.geojson")
    args = ap.parse_args()

    dem, grid, nodata = read(OUT / "dtm_highres_050.tif")
    dem[dem == nodata] = np.nan
    hc, _, hc_nodata = read(OUT / "h_conn_highres.tif")
    hc[hc == hc_nodata] = np.nan
    seed_arr, _, seed_nodata = read(OUT / "seed_highres_050.tif")
    seed = np.isfinite(seed_arr) & (seed_arr > 0.5)

    ponded = (
        np.isfinite(dem)
        & np.isfinite(hc)
        & (dem < args.target_h)
        & (hc > args.target_h)
        & ~seed
    )
    labels, count = ndimage.label(ponded, structure=np.ones((3, 3), dtype=bool))
    sizes = ndimage.sum(ponded, labels, index=np.arange(1, count + 1))
    order = np.argsort(sizes)[::-1]

    # 各セルから最近傍open-water seedの位置を引く。
    _, nearest = ndimage.distance_transform_edt(~seed, return_distances=True,
                                                 return_indices=True)
    features = []
    for label in (int(i) + 1 for i in order):
        area_m2 = float(sizes[label - 1] * grid.cell_area())
        if area_m2 < args.min_area_m2:
            continue
        rr, cc = np.nonzero(labels == label)
        # コンポーネント内で最も低いセルを陸側端にする。
        k = int(np.nanargmin(dem[rr, cc]))
        r, c = int(rr[k]), int(cc[k])
        mr, mc = int(nearest[0, r, c]), int(nearest[1, r, c])
        inland_x, inland_y = grid.transform * (c + 0.5, r + 0.5)
        mouth_x, mouth_y = grid.transform * (mc + 0.5, mr + 0.5)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [mouth_x, mouth_y]},
            "properties": {
                "id": f"synthetic-{len(features) + 1:03d}",
                "inland_node": [inland_x, inland_y],
                "gate_type": "none",
                "drain_to": "open-water-seed",
                "source": "synthetic",
                "target_h_m": args.target_h,
                "ponded_area_m2": area_m2,
            },
        })
        if len(features) >= args.max_pairs:
            break

    if not features:
        raise SystemExit("仮想吐口候補がありません")

    data = {
        "type": "FeatureCollection",
        "name": f"{AOI.name}_synthetic_outfall_pairs",
        "crs": {"type": "name", "properties": {"name": "EPSG:6674"}},
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"wrote {args.output}: {len(features)} pair(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
