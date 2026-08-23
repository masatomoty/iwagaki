#!/usr/bin/env python3
"""PLATEAU の建物・道路に解析結果 (Derived Assertion) を付与する。

PLATEAU の geometry は書き換えない。gml_id をキーに assertion を外付けする。
建物の地盤高は footprint 内部ではなく **外周 1m リング** から取る。
京都府DEMは建物を除去済みで、footprint 内部は補間値（ゴースト）だから。
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import Polygon, mapping
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.citygml import parse_buildings, parse_roads
from iwagaki.config import (AOI, CRS_ANALYSIS, CRS_LONLAT, OUT,
                            PLATEAU_MEMBERS, RAW, REPRESENTATIVE_H,
                            RES_COARSE, RES_HIGHRES, ROAD_DEPTH_CLASSES)
from iwagaki.raster import Grid, read, upsample_nearest

RING_M = 1.0

# uro:RoadStructureAttribute.sectionType（PLATEAU codelist）
# 1 土工区間・通常区間 / 2 高架橋 / 3 橋梁 / 4 交差部 / 5 アンダーパス / 6 トンネル
# 2,3,5,6 は路面が地表面と一致しないため、DTM から求めた地盤高は無意味。
SECTION_TYPE_LABEL = {"1": "土工区間・通常区間", "2": "高架橋", "3": "橋梁",
                      "4": "交差部", "5": "アンダーパス", "6": "トンネル"}
SECTION_TYPE_NOT_ON_GROUND = {"2", "3", "5", "6"}


def to_plane(rings: list[np.ndarray], tf: Transformer) -> Polygon | None:
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
    return u if not u.is_empty else None


def zone_stats(labels: np.ndarray, ids: np.ndarray, arr: np.ndarray, fn) -> dict:
    out = {}
    for i in ids:
        m = labels == i
        v = arr[m]
        v = v[np.isfinite(v)]
        out[int(i)] = fn(v) if v.size else None
    return out


def road_class(depth: float | None) -> int | None:
    if depth is None:
        return None
    c = 0
    for k, t in enumerate(ROAD_DEPTH_CLASSES, start=1):
        if depth >= t:
            c = k
    return c


def main() -> int:
    grid = Grid.for_aoi(AOI, RES_HIGHRES)
    factor = int(round(RES_COARSE / RES_HIGHRES))

    # 解析が持っている 4 条件すべてを地物に結合する。
    # 以前は baseline / highres だけで、**点群融合地形での判定が地物単位で
    # 出ていなかった**（docs/todo.md A2）。0.5 m 格子のものは upsample しない。
    terrains = {}
    for name, fname in (("baseline", "dtm_baseline_500.tif"),
                        ("highres", "dtm_highres_050.tif"),
                        ("control", "dtm_control_500.tif"),
                        ("pointcloud", "dtm_pointcloud_050.tif")):
        e, _, nd = read(OUT / fname)
        e[e == nd] = np.nan
        hc, _, nd2 = read(OUT / f"h_conn_{name}.tif")
        hc[hc == nd2] = np.inf
        if name in ("baseline", "control"):   # 5 m 格子。0.5 m 格子に合わせる
            e = upsample_nearest(e, factor)
            hc = upsample_nearest(hc, factor)
        terrains[name] = (e, hc)

    tf = Transformer.from_crs(CRS_LONLAT, CRS_ANALYSIS, always_xy=True)
    back = Transformer.from_crs(CRS_ANALYSIS, CRS_LONLAT, always_xy=True)
    lon0, lat0 = back.transform(AOI.xmin, AOI.ymin)
    lon1, lat1 = back.transform(AOI.xmax, AOI.ymax)
    bbox = (lon0, lat0, lon1, lat1)
    src = RAW / "plateau"

    feats: list[dict] = []
    for member in PLATEAU_MEMBERS["bldg"]:
        feats += parse_buildings(src / Path(member).name, bbox)
    n_bldg = len(feats)
    for member in PLATEAU_MEMBERS["tran"]:
        feats += parse_roads(src / Path(member).name, bbox)
    print(f"parsed {n_bldg} buildings, {len(feats) - n_bldg} roads")

    geoms: list[Polygon] = []
    keep: list[dict] = []
    clip = Polygon([(AOI.xmin, AOI.ymin), (AOI.xmax, AOI.ymin),
                    (AOI.xmax, AOI.ymax), (AOI.xmin, AOI.ymax)])
    for f in feats:
        g = to_plane(f["rings"], tf)
        if g is None:
            continue
        g = g.intersection(clip)
        if g.is_empty or g.area < 1.0:
            continue
        keep.append(f)
        geoms.append(g)
    print(f"{len(keep)} features intersect the AOI")

    ids = np.arange(1, len(keep) + 1)
    fp = rasterize([(g, int(i)) for g, i in zip(geoms, ids)],
                   out_shape=(grid.height, grid.width), transform=grid.transform,
                   fill=0, dtype="int32")
    buf = rasterize([(g.buffer(RING_M), int(i)) for g, i in zip(geoms, ids)],
                    out_shape=(grid.height, grid.width), transform=grid.transform,
                    fill=0, dtype="int32")
    ring = np.where(fp == 0, buf, 0)

    is_bldg = np.array([f["feature_type"] == "bldg:Building" for f in keep])
    # 建物は外周リング、道路は面そのものを集計ゾーンにする
    zone_raw = np.where(np.isin(fp, ids[~is_bldg]), fp, ring)

    # 開放水面セルはゾーンから除く。橋・護岸沿いの地物が水面標高(≒0)を拾って
    # 地盤高が不当に低く出るのを防ぐ。除去率は water_fraction として記録する。
    seed_arr, _, _ = read(OUT / "seed_highres_050.tif")
    seed_mask = seed_arr > 0.5
    n_all = np.bincount(zone_raw.ravel(), minlength=len(keep) + 1)
    n_water = np.bincount(zone_raw[seed_mask].ravel(), minlength=len(keep) + 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        water_frac = np.where(n_all > 0, n_water / np.maximum(n_all, 1), 0.0)
    zone = np.where(seed_mask, 0, zone_raw)

    present = np.unique(zone)
    present = present[present > 0]
    print(f"{len(present)}/{len(keep)} features have >=1 non-water raster cell "
          f"({int((water_frac[1:] > 0.5).sum())} features are >50% open water)")

    stats: dict[str, dict] = {}
    for name, (e, hc) in terrains.items():
        stats[name] = {
            "ground": zone_stats(zone, present, e, lambda v: float(np.percentile(v, 10))),
            "hconn": zone_stats(zone, present, hc, lambda v: float(v.min())),
        }

    rows, gj = [], []
    n_changed = {f"{h:.2f}": 0 for h in REPRESENTATIVE_H}
    for i, (f, g) in enumerate(zip(keep, geoms), start=1):
        if i not in stats["highres"]["ground"]:
            continue
        rec = {
            "gml_id": f["gml_id"], "feature_type": f["feature_type"],
            "name": f["name"], "class": f["class"],
            "usage": f.get("usage") or f.get("function"),
            "area_m2": round(g.area, 2),
            "section_type": f.get("section_type"),
            "section_type_label": SECTION_TYPE_LABEL.get(f.get("section_type") or ""),
            "water_fraction": round(float(water_frac[i]), 3),
        }
        # 路面が地表面と一致しない構造（橋梁・高架橋・アンダーパス・トンネル）、
        # および大半が開放水面に重なる地物は、DTM 由来の地盤高が意味を持たない。
        not_on_ground = (f.get("section_type") or "") in SECTION_TYPE_NOT_ON_GROUND
        rec["unreliable"] = bool(not_on_ground or water_frac[i] > 0.5)
        rec["unreliable_reason"] = ("not_on_ground" if not_on_ground
                                    else "mostly_open_water" if water_frac[i] > 0.5
                                    else None)
        changed_any = False
        for name in terrains:
            ge = stats[name]["ground"][i]
            hc = stats[name]["hconn"][i]
            rec[f"ground_elev_{name}"] = round(ge, 3) if ge is not None else None
            rec[f"h_conn_{name}"] = (round(hc, 3)
                                     if hc is not None and np.isfinite(hc) else None)
        gb, gh = rec["ground_elev_baseline"], rec["ground_elev_highres"]
        hb, hh = rec["h_conn_baseline"], rec["h_conn_highres"]
        rec["delta_ground_elev"] = (round(gh - gb, 3)
                                    if gb is not None and gh is not None else None)
        rec["delta_h_conn"] = (round(hh - hb, 3)
                               if hb is not None and hh is not None else None)
        for h in REPRESENTATIVE_H:
            k = f"{h:.2f}"
            db = (h - gb) if (hb is not None and hb <= h and gb is not None
                              and h > gb) else 0.0
            dh = (h - gh) if (hh is not None and hh <= h and gh is not None
                              and h > gh) else 0.0
            rec[f"depth_baseline@{k}"] = round(db, 3)
            rec[f"depth_highres@{k}"] = round(dh, 3)
            if f["feature_type"] == "tran:Road":
                cb, ch = road_class(db), road_class(dh)
                rec[f"class_baseline@{k}"], rec[f"class_highres@{k}"] = cb, ch
                changed = cb != ch
            else:
                changed = (db > 0) != (dh > 0)
            rec[f"decision_changed@{k}"] = bool(changed)
            if changed and not rec["unreliable"]:
                n_changed[k] += 1
                changed_any = True
        rec["decision_changed_any"] = changed_any and not rec["unreliable"]
        rows.append(rec)
        gj.append({"type": "Feature", "properties": rec, "geometry": mapping(g)})

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "objects.geojson").write_text(json.dumps(
        {"type": "FeatureCollection",
         "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
         "features": gj}))
    fields: list[str] = []
    for r in rows:  # 建物と道路で列が異なるので和集合を取る
        fields += [k for k in r if k not in fields]
    with (OUT / "objects.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    summary = {
        "n_features": len(rows),
        "n_buildings": sum(r["feature_type"] == "bldg:Building" for r in rows),
        "n_roads": sum(r["feature_type"] == "tran:Road" for r in rows),
        "n_decision_changed": n_changed,
        "n_decision_changed_any": sum(r["decision_changed_any"] for r in rows),
        "n_unreliable": sum(r["unreliable"] for r in rows),
        "n_unreliable_not_on_ground": sum(
            r["unreliable_reason"] == "not_on_ground" for r in rows),
        "n_unreliable_mostly_open_water": sum(
            r["unreliable_reason"] == "mostly_open_water" for r in rows),
        "ring_m": RING_M,
        "road_depth_classes_m": list(ROAD_DEPTH_CLASSES),
    }
    (OUT / "objects_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
