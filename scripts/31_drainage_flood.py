#!/usr/bin/env python3
"""仮想吐口ペアから S2 の h_conn を生成する。

入力 GeoJSON は EPSG:6674 の Point geometry を海側の吐口とし、
properties.inland_node を [x, y]（EPSG:6674）で持つ。
実在施設ではなく、ハッカソン用の仮想逆流経路である。

**敷高の仮定を 1 本の線にしない。** 吐口の敷高は `地盤高 − DRAINAGE_DROP_M`
という仮定でしかないので、`DRAINAGE_INVERT_CASES` のオフセットぶんだけ
別々に解いて 1 ケース 1 枚の到達水位ラスタを出す。ビューアは現在の潮位に対して
「3 ケース中いくつで浸水したか」を数える（`docs/flood_simulation_spec.md` §8）。
**確率ではない。** 各ケースに重みは無く、分母で割った比率も出さない。
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
    AOI, CONNECTIVITY, DRAINAGE_DROP_M, DRAINAGE_INVERT_CASES,
    drainage_case_file, H_MAX, H_MIN, H_STEP,
    OUT, RES_HIGHRES, SEED_LEVEL, SEED_MIN_AREA,
)
from iwagaki.flood import (
    compute_h_conn_with_inland_outfalls,
    find_open_water,
    reached,
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
    ap.add_argument(
        "--invert-cases",
        type=float,
        nargs="+",
        default=list(DRAINAGE_INVERT_CASES),
        help="敷高に足すオフセット [m]。負 = 敷高が低い = 逆流しやすい",
    )
    ap.add_argument(
        "--check-levels",
        type=float,
        nargs="+",
        default=[0.5, 0.93, 1.5, 3.0],
        help="単調性の確認と面積の記録に使う潮位 [m T.P.]（昇順）",
    )
    args = ap.parse_args()
    args.check_levels = sorted(args.check_levels)

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

    # **ケースごとに 1 枚。** オフセットは敷高に足す（負 = 敷高が低い = 逆流しやすい）。
    # 基準ケース（オフセット 0）は既存の名前を兼用するので複製にはならない
    land = np.isfinite(dem)
    cell_ha = grid.cell_area() / 1e4
    cases: list[dict] = []
    for offset in args.invert_cases:
        hc = compute_h_conn_with_inland_outfalls(
            dem, seed, inland_mask, invert + offset,
            H_MIN, H_MAX, H_STEP, CONNECTIVITY,
        )
        out_path = OUT / drainage_case_file(offset)
        write(out_path, np.where(np.isfinite(hc), hc, -9999), grid)
        # 単調性（仕様 §9-2）はこの場で見ておく。1 ケースでも崩れたら
        # 「潮位を上げたのに浸水域が減る」絵になり、スライダの意味が壊れる
        wet_ha = {
            f"{h:.2f}": round(float((land & reached(hc, h, H_STEP)).sum()) * cell_ha, 2)
            for h in args.check_levels
        }
        areas = [wet_ha[f"{h:.2f}"] for h in args.check_levels]
        if any(b < a - 1e-9 for a, b in zip(areas, areas[1:])):
            raise SystemExit(
                f"単調性が崩れた（offset {offset:+.2f} m）: {wet_ha}")
        cases.append({
            "invert_offset_m": round(float(offset), 3),
            "invert_mouth_note": (
                f"地盤高 - {args.drop_m} m {offset:+.2f} m"),
            "file": out_path.name,
            "wet_land_ha_by_level": wet_ha,
        })
        print(f"wrote {out_path}  ({offset:+.2f} m) {wet_ha}")

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
        # **仮定の幅。** 確率ではないので重みも分母も持たせない（仕様 §8）
        "invert_cases": cases,
        "invert_case_count": len(cases),
        "uncertainty_note": (
            "各ケースは仮想敷高の仮定違いであり、発生確率ではない。"
            "ケース数で割った比率を出力しないこと"
        ),
        "nodes": records,
    }
    (OUT / "drainage_meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False)
    )
    print(f"wrote {OUT / 'drainage_meta.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
