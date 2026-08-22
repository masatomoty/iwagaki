#!/usr/bin/env python3
"""実点群を融合した地形が、地物ごとの浸水判定を変えるかを見る。

scripts/40 のラスタ比較では差が小さかった（>0.25 m のセルが 0.35%）。
しかし本プロジェクトの判断単位は地物なので、
**面積が小さくても、効く場所に当たっていれば判定は変わる**。ここで確かめる。

比較は 0.5m DEM（highres）と 融合地形（pointcloud）。
PLATEAU 5m との比較は scripts/50 が既に出している。
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer
from rasterio.features import rasterize
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.citygml import parse_buildings, parse_roads
from iwagaki.config import (AOI, CRS_ANALYSIS, CRS_LONLAT, OUT, PLATEAU_MEMBERS,
                            RAW, RES_HIGHRES, ROAD_DEPTH_CLASSES)
from iwagaki.raster import Grid, read

RING_M = 1.0
SECTION_NOT_ON_GROUND = {"2", "3", "5", "6"}
CONDITIONS = ("highres", "pointcloud")


def load(name: str) -> tuple[np.ndarray, np.ndarray]:
    dtm = {"highres": "dtm_highres_050.tif", "pointcloud": "dtm_pointcloud_050.tif"}[name]
    e, _, nd = read(OUT / dtm)
    e[e == nd] = np.nan
    hc, _, nd2 = read(OUT / f"h_conn_{name}.tif")
    hc[hc == nd2] = np.inf
    return e, hc


def to_plane(rings, tf) -> Polygon | None:
    polys = []
    for xy in rings:
        x, y = tf.transform(xy[:, 0], xy[:, 1])
        p = Polygon(np.column_stack([x, y]))
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty and p.area > 0:
            polys.append(p)
    if not polys:
        return None
    u = unary_union(polys)
    return None if u.is_empty else u


def road_class(d: float) -> int:
    c = 0
    for i, t in enumerate(ROAD_DEPTH_CLASSES, 1):
        if d >= t:
            c = i
    return c


def main() -> int:
    grid = Grid.for_aoi(AOI, RES_HIGHRES)
    terr = {n: load(n) for n in CONDITIONS}
    seed, _, _ = read(OUT / "seed_highres_050.tif")
    seed = seed > 0.5
    pc_mask, _, _ = read(OUT / "pc_ground_mask_050.tif")
    pc_mask = pc_mask > 0.5

    tf = Transformer.from_crs(CRS_LONLAT, CRS_ANALYSIS, always_xy=True)
    back = Transformer.from_crs(CRS_ANALYSIS, CRS_LONLAT, always_xy=True)
    lon0, lat0 = back.transform(AOI.xmin, AOI.ymin)
    lon1, lat1 = back.transform(AOI.xmax, AOI.ymax)
    bbox = (lon0, lat0, lon1, lat1)

    feats = []
    for m in PLATEAU_MEMBERS["bldg"]:
        feats += parse_buildings(RAW / "plateau" / Path(m).name, bbox)
    n_b = len(feats)
    for m in PLATEAU_MEMBERS["tran"]:
        feats += parse_roads(RAW / "plateau" / Path(m).name, bbox)
    print(f"parsed {n_b} buildings, {len(feats) - n_b} roads")

    clip = Polygon([(AOI.xmin, AOI.ymin), (AOI.xmax, AOI.ymin),
                    (AOI.xmax, AOI.ymax), (AOI.xmin, AOI.ymax)])
    keep, geoms = [], []
    for f in feats:
        g = to_plane(f["rings"], tf)
        if g is None:
            continue
        g = g.intersection(clip)
        if g.is_empty or g.area < 1.0:
            continue
        keep.append(f)
        geoms.append(g)

    ids = np.arange(1, len(keep) + 1)
    fp = rasterize([(g, int(i)) for g, i in zip(geoms, ids)],
                   out_shape=(grid.height, grid.width), transform=grid.transform,
                   fill=0, dtype="int32")
    buf = rasterize([(g.buffer(RING_M), int(i)) for g, i in zip(geoms, ids)],
                    out_shape=(grid.height, grid.width), transform=grid.transform,
                    fill=0, dtype="int32")
    is_bldg = np.array([f["feature_type"] == "bldg:Building" for f in keep])
    zone_raw = np.where(np.isin(fp, ids[~is_bldg]), fp, np.where(fp == 0, buf, 0))
    zone = np.where(seed, 0, zone_raw)

    present = np.unique(zone)
    present = present[present > 0]
    # その地物のゾーンに点群由来のセルがどれだけ入っているか
    n_all = np.bincount(zone.ravel(), minlength=len(keep) + 1)
    n_pc = np.bincount(zone[pc_mask].ravel(), minlength=len(keep) + 1)

    def zstats(arr, fn):
        out = {}
        for i in present:
            v = arr[zone == i]
            v = v[np.isfinite(v)]
            out[int(i)] = fn(v) if v.size else None
        return out

    g10 = {n: zstats(terr[n][0], lambda v: float(np.percentile(v, 10))) for n in CONDITIONS}
    hmin = {n: zstats(terr[n][1], lambda v: float(v.min())) for n in CONDITIONS}

    levels = json.loads((OUT / "tide_levels.json").read_text())["reference_levels_m_tp"]
    rows, changed_at = [], {k: [] for k in levels}
    for i, f in enumerate(keep, start=1):
        if i not in g10["highres"]:
            continue
        not_on_ground = (f.get("section_type") or "") in SECTION_NOT_ON_GROUND
        if not_on_ground:
            continue
        rec = {
            "gml_id": f["gml_id"], "feature_type": f["feature_type"],
            "pc_cells": int(n_pc[i]), "zone_cells": int(n_all[i]),
            "pc_fraction": round(float(n_pc[i]) / max(int(n_all[i]), 1), 3),
        }
        for n in CONDITIONS:
            rec[f"ground_{n}"] = (round(g10[n][i], 3) if g10[n][i] is not None else None)
            h = hmin[n][i]
            rec[f"h_conn_{n}"] = round(h, 3) if h is not None and np.isfinite(h) else None
        for label, H in levels.items():
            def depth(n: str) -> float:
                g, h = rec[f"ground_{n}"], rec[f"h_conn_{n}"]
                if g is None or h is None or h > H:
                    return 0.0
                return max(0.0, H - g)
            dh, dp = depth("highres"), depth("pointcloud")
            ch = (road_class(dh) != road_class(dp)) if f["feature_type"] == "tran:Road" \
                else ((dh > 0) != (dp > 0))
            rec[f"changed@{label}"] = bool(ch)
            if ch:
                changed_at[label].append(rec["gml_id"])
        rows.append(rec)

    dg = np.array([r["ground_pointcloud"] - r["ground_highres"] for r in rows
                   if r["ground_pointcloud"] is not None and r["ground_highres"] is not None])
    touched = [r for r in rows if r["pc_cells"] > 0]

    report = {
        "compared": "highres (京都府 0.5m DEM) vs pointcloud (点群を融合した地形)",
        "features": {"evaluated": len(rows),
                     "with_pointcloud_cells": len(touched),
                     "pc_fraction_p50": round(float(np.median(
                         [r["pc_fraction"] for r in touched])), 3) if touched else None},
        "delta_ground_elev_m": {
            "median": round(float(np.median(dg)), 4),
            "p05": round(float(np.percentile(dg, 5)), 3),
            "p95": round(float(np.percentile(dg, 95)), 3),
            "frac_abs_gt_0_10m": round(float((np.abs(dg) > 0.10).mean()), 4),
        },
        "changed_counts": {k: len(v) for k, v in changed_at.items()},
        "changed_ids": {k: v[:12] for k, v in changed_at.items()},
        "reference_levels_m_tp": levels,
    }
    (OUT / "pc_object_impact.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False))
    with (OUT / "pc_object_impact.csv").open("w", newline="") as fh:
        fields: list[str] = []
        for r in rows:
            fields += [k for k in r if k not in fields]
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
