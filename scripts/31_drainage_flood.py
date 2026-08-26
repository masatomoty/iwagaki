#!/usr/bin/env python3
"""仮想吐口ペアから S2 の h_conn を生成する。

入力 GeoJSON は EPSG:6674 の Point geometry を海側の吐口とし、
properties.inland_node を [x, y]（EPSG:6674）で持つ。
実在施設ではなく、ハッカソン用の仮想逆流経路である。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
from rasterio.transform import rowcol

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (
    AOI, CONNECTIVITY, DRAINAGE_DROP_M, H_MAX, H_MIN, H_STEP,
    OUT, RES_HIGHRES, SEED_LEVEL, SEED_MIN_AREA,
)
from iwagaki.flood import (
    compute_h_conn_with_inland_outfalls,
    find_open_water,
)
from iwagaki.raster import Grid, read, write


def parse_inland_node(value: object) -> tuple[float, float] | None:
    if isinstance(value, dict) and value.get("type") == "Point":
        coords = value.get("coordinates")
    else:
        coords = value
    if isinstance(coords, (list, tuple, np.ndarray)) and len(coords) >= 2:
        try:
            return float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--pairs",
        type=Path,
        default=OUT / "synthetic_outfall_pairs.geojson",
        help="EPSG:6674 GeoJSON of mouth points and inland_node properties",
    )
    ap.add_argument(
        "--drop-m",
        type=float,
        default=DRAINAGE_DROP_M,
        help="invert_mouth = inland DEM elevation - drop",
    )
    args = ap.parse_args()

    dem, grid, nodata = read(OUT / "dtm_highres_050.tif")
    dem[dem == nodata] = np.nan

    seed_path = OUT / "seed_highres_050.tif"
    if seed_path.exists():
        seed_arr, _, seed_nodata = read(seed_path)
        seed = np.isfinite(seed_arr) & (seed_arr > 0.5)
    else:
        seed, seed_info = find_open_water(
            dem, SEED_LEVEL, grid.cell_area(), SEED_MIN_AREA, CONNECTIVITY,
            include_nodata=True,
        )
        write(seed_path, seed.astype("float32"), grid, nodata=-1)
        print(f"generated seed: {len(seed_info)} component(s)")

    if not args.pairs.exists():
        raise SystemExit(
            f"{args.pairs} がありません。海側 geometry と inland_node を持つ "
            "仮想吐口ペアGeoJSONを用意してください。"
        )

    pairs = gpd.read_file(args.pairs)
    if pairs.crs is None:
        pairs = pairs.set_crs("EPSG:6674")
    else:
        pairs = pairs.to_crs("EPSG:6674")

    inland_mask = np.zeros(dem.shape, dtype=bool)
    invert = np.full(dem.shape, np.inf, dtype="float64")
    records: list[dict] = []

    for idx, feature in pairs.iterrows():
        gate_type = str(feature.get("gate_type", "none")).strip().lower()
        if gate_type == "flap":
            # フラップゲート付きの吐口はS2（ゲートなし）の追加seedにしない。
            continue
        node = parse_inland_node(feature.get("inland_node"))
        if node is None:
            # GeoJSON propertiesで表現しにくい場合の別名も許容する。
            try:
                node = (float(feature["inland_x"]), float(feature["inland_y"]))
            except (KeyError, TypeError, ValueError):
                raise SystemExit(
                    f"feature {idx}: inland_node=[x,y] または inland_x/inland_y が必要"
                )
        r, c = rowcol(grid.transform, node[0], node[1])
        if not (0 <= r < dem.shape[0] and 0 <= c < dem.shape[1]):
            print(f"skip feature {idx}: inland_node is outside AOI", file=sys.stderr)
            continue
        ground = dem[r, c]
        if not np.isfinite(ground):
            print(f"skip feature {idx}: inland_node has nodata DEM", file=sys.stderr)
            continue
        inland_mask[r, c] = True
        invert[r, c] = ground - args.drop_m
        records.append({
            "feature": int(idx),
            "gate_type": gate_type,
            "rowcol": [int(r), int(c)],
            "inland_ground_m": round(float(ground), 3),
            "invert_mouth_m": round(float(invert[r, c]), 3),
        })

    if not records:
        raise SystemExit("有効な inland_node が1件もありません")

    hc = compute_h_conn_with_inland_outfalls(
        dem, seed, inland_mask, invert,
        H_MIN, H_MAX, H_STEP, CONNECTIVITY,
    )
    out_path = OUT / "h_conn_drainage_S2.tif"
    write(out_path, np.where(np.isfinite(hc), hc, -9999), grid)

    meta = {
        "aoi": AOI.name,
        "model": "S2",
        "pairs": str(args.pairs),
        "pair_count": len(records),
        "drop_m": args.drop_m,
        "h_min": H_MIN,
        "h_max": H_MAX,
        "h_step": H_STEP,
        "connectivity": CONNECTIVITY,
        "seed": "existing open-water seed",
        "synthetic": True,
        "nodes": records,
    }
    (OUT / "drainage_meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False)
    )
    print(f"wrote {out_path}")
    print(f"wrote {OUT / 'drainage_meta.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
