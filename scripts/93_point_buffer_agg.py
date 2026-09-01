#!/usr/bin/env python3
"""任意地点を中心にした徒歩圏（半径 500 / 800 / 1000 m）の範囲集計。

京都市・さいたま市からの要望（`docs/todo.md` T1、2026-08-28〜29、CITY GAP 側の
やり取り）。**500m メッシュ起点をやめ、地図上の任意点＋半径切替＋町丁・字単位**で
集計する。`scripts/92_area_aggregate.py`（矩形 AOI の建物を小地域へ空間結合）を
「円 ∩ 小地域」へ一般化したもの。

表示順は山本氏の回答どおり:

    ① 人口と年齢分布   ← 国勢調査 小地域（`scripts/13` 境界 + `scripts/14` 統計）
    ② 建物用途分布     ← PLATEAU `bldg:usage`（`objects.geojson`、`scripts/50`）
    ③ 事業所数         ← **未取得**（経済センサス。別データ・別 PR）
    ④ 用途地域等の制限 ← **未取得**（都市計画 GIS。別データ・別 PR）
    ⑤ 交通             ← PLATEAU `tran:Road` の本数と面積（円内）＋ 線路延長

800 m は国交省『都市構造評価ハンドブック』の徒歩圏、500 m は高齢者徒歩圏
（**[実測: 要望]**）。**このスクリプトはファイル書き出しだけ**（viewer 配線は別 PR。
`scripts/88` / `scripts/91` / `scripts/92` と同じ立て付け）。

入力
----
* `data/interim/census_boundary_maizuru_2020.geojson`（`scripts/13`、EPSG:6674）
* `data/interim/census_stats_maizuru_2020.csv`（`scripts/14`）
* `data/out/{aoi}/objects.geojson`（`scripts/50`、EPSG:6674）
* `data/raw/plateau/Building_usage.xml`（用途コードの表示名。無くてもコードで出す）
* `web/public/data/{aoi_}railway.geojson`（あれば。`scripts/12`、EPSG:4326）

人口の按分
----
既定は **面按分（areal weighting）**: 小地域の人口が域内で一様と仮定し、
`人口 × (小地域 ∩ 円 の面積 / 小地域の面積)` を足す。`--method centroid` は
小地域の重心が円内なら全人口を足す（`scripts/92` の建物の寄せ方と揃う）。
**秘匿（`suppressed`）の小地域は人口が欠損**なので按分の分母から外し、
「圏内に秘匿 N 地域」と出力に添える（人口は過小評価側）。

出力（`data/out/point_buffer/` 直下）
----
* `point_buffer_{label}.json`   … 中心・AOI・半径別の ①〜⑤ ＋ 版・出典・注意
* `point_buffer_{label}_pop.csv` … 半径 × 小地域の按分内訳（① の裏づけ）
* `point_buffer_{label}_bldg_usage.csv` … 半径 × 用途コードの棟数（② の裏づけ）
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.areas import (areas_in_circle, boundary_metadata, circle_geom,
                           features_in_circle, load_area_stats, load_boundaries,
                           point_to_analysis, stats_metadata)
from iwagaki.config import AOIS, CRS_ANALYSIS, ROOT

RADII = (500, 800, 1000)
DEFAULT_RADII = (500, 800, 1000)
METHODS = ("areal", "centroid")

AGE_FIELDS = ("age_0_14", "age_15_64", "age_65_plus", "age_unknown")
AGE_LABELS = {
    "age_0_14": "年少人口（0〜14歳）",
    "age_15_64": "生産年齢人口（15〜64歳）",
    "age_65_plus": "老年人口（65歳以上）",
    "age_unknown": "年齢不詳",
}

BUILDING_USAGE_XML = ROOT / "data" / "raw" / "plateau" / "Building_usage.xml"
GML = "{http://www.opengis.net/gml}"
USAGE_UNKNOWN = "(用途不明)"


def usage_codelist() -> dict[str, str]:
    """`bldg:usage` コード -> 表示名（配布 zip 同梱の codelist。手書き対応表を持たない）。"""
    if not BUILDING_USAGE_XML.exists():
        return {}
    root = ET.parse(BUILDING_USAGE_XML).getroot()
    out: dict[str, str] = {}
    for d in root.iter(f"{GML}Definition"):
        code, label = d.findtext(f"{GML}name"), d.findtext(f"{GML}description")
        if code and label:
            out[code.strip()] = label.strip()
    return out


def pick_aoi(x: float, y: float) -> tuple[str, float]:
    """点（解析 CRS）に最も近い AOI 名と、点から AOI 矩形までの距離 [m]（内側なら 0）。

    `yoshiwara`（100 ha）は `nishi_maizuru`（625 ha）に内包されるので、両方に入る点では
    **大きい方**を採る（円が矩形からはみ出しにくい）。
    """
    scored = []
    for name, a in AOIS.items():
        dx = max(a.xmin - x, 0.0, x - a.xmax)
        dy = max(a.ymin - y, 0.0, y - a.ymax)
        d = math.hypot(dx, dy)
        area = (a.xmax - a.xmin) * (a.ymax - a.ymin)
        scored.append((d, -area, name))
    scored.sort()
    return scored[0][2], scored[0][0]


def load_objects(aoi: str) -> gpd.GeoDataFrame:
    path = ROOT / "data" / "out" / aoi / "objects.geojson"
    if not path.exists():
        raise SystemExit(f"入力がありません: {path}（先に IWAGAKI_AOI={aoi} scripts/50）")
    data = json.loads(path.read_text())
    if data.get("crs", {}).get("properties", {}).get("name") != CRS_ANALYSIS:
        raise SystemExit(f"{path}: CRS が {CRS_ANALYSIS} ではありません")
    rows = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        rows.append({
            "gml_id": p.get("gml_id"),
            "feature_type": p.get("feature_type"),
            "usage": p.get("usage"),
            "unreliable": str(p.get("unreliable", "")).lower() == "true",
            "geometry": shape(feat["geometry"]),
        })
    return gpd.GeoDataFrame(rows, crs=CRS_ANALYSIS)


def population_section(
    areas: gpd.GeoDataFrame, stats: pd.DataFrame, lon: float, lat: float,
    radius_m: float, method: str,
) -> tuple[dict, list[dict]]:
    hit = areas_in_circle(areas, lon, lat, radius_m)
    if method == "centroid":
        cent = hit.geometry.centroid
        circle = circle_geom(lon, lat, radius_m)
        hit = hit.assign(weight=cent.within(circle).astype(float))
    else:
        hit = hit.assign(weight=hit["circle_frac"])

    totals = {"pop_total": 0.0, **{k: 0.0 for k in AGE_FIELDS}}
    n_missing = 0  # weight>0 だが人口・年齢が引けなかった小地域（秘匿など）
    rows: list[dict] = []
    for rec in hit.itertuples(index=False):
        s = stats.loc[rec.KEY_CODE] if rec.KEY_CODE in stats.index else None
        suppressed = bool(s is not None and s["suppressed"])
        want = ("pop_total", *AGE_FIELDS)
        complete = s is not None and not any(pd.isna(s[k]) for k in want)
        row = {
            "radius_m": int(radius_m),
            "key_code": rec.KEY_CODE,
            "s_name": rec.S_NAME,
            "circle_frac": round(rec.circle_frac, 4),
            "weight": round(rec.weight, 4),
            "pop_total": int(s["pop_total"]) if complete else None,
            "suppressed": suppressed,
        }
        for k in AGE_FIELDS:
            row[k] = int(s[k]) if complete else None
        rows.append(row)
        if rec.weight <= 0:
            continue
        if not complete:
            n_missing += 1
            continue
        totals["pop_total"] += rec.weight * float(s["pop_total"])
        for k in AGE_FIELDS:
            totals[k] += rec.weight * float(s[k])

    pop_est = totals["pop_total"]
    age = {k: round(totals[k], 1) for k in AGE_FIELDS}
    shares = {k: (round(totals[k] / pop_est, 4) if pop_est else None)
              for k in AGE_FIELDS}
    aging_rate = (round(totals["age_65_plus"]
                        / (pop_est - totals["age_unknown"]), 4)
                  if pop_est - totals["age_unknown"] > 0 else None)
    section = {
        "method": method,
        "method_note": ("面按分（人口が小地域内で一様と仮定）"
                        if method == "areal" else "重心内包（重心が円内なら全人口）"),
        "population_estimate": round(pop_est, 1),
        "age_distribution": {k: {"count": age[k], "share": shares[k],
                                 "label": AGE_LABELS[k]} for k in AGE_FIELDS},
        "aging_rate_65plus": aging_rate,
        "n_small_areas_intersecting": int((hit["circle_frac"] > 0).sum()),
        "n_small_areas_counted": int(sum(
            1 for r in rows if r["weight"] > 0 and r["pop_total"] is not None)),
        "n_small_areas_missing_stats_in_circle": n_missing,
        "n_small_areas_suppressed_in_circle": int(sum(
            1 for r in rows if r["weight"] > 0 and r["suppressed"])),
        "value_kind": "国勢調査 小地域の公式集計を面按分した推計値（棟数モデルではない）",
    }
    return section, rows


def building_usage_section(
    objects: gpd.GeoDataFrame, lon: float, lat: float, radius_m: float,
    codes: dict[str, str],
) -> tuple[dict, list[dict]]:
    bldg = objects[objects["feature_type"] == "bldg:Building"].copy()
    bldg = bldg.set_geometry(bldg.geometry.centroid)
    inside = features_in_circle(bldg, lon, lat, radius_m, predicate="within")

    counts: dict[str, int] = {}
    for u in inside["usage"]:
        key = USAGE_UNKNOWN if (u is None or pd.isna(u) or u == "") else str(u)
        counts[key] = counts.get(key, 0) + 1
    rows = [{
        "radius_m": int(radius_m),
        "usage_code": code,
        "usage_label": (USAGE_UNKNOWN if code == USAGE_UNKNOWN
                        else codes.get(code, code)),
        "count": n,
    } for code, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    return {
        "total_buildings": int(len(inside)),
        "by_usage": [{"code": r["usage_code"], "label": r["usage_label"],
                      "count": r["count"]} for r in rows],
        "value_kind": "PLATEAU bldg:usage（LOD1、2024年測量）。重心が円内の棟",
    }, rows


def transport_section(
    objects: gpd.GeoDataFrame, lon: float, lat: float, radius_m: float,
) -> dict:
    circle = circle_geom(lon, lat, radius_m)
    roads = objects[objects["feature_type"] == "tran:Road"]
    hit = roads[roads.intersects(circle)]
    road_area = float(hit.geometry.intersection(circle).area.sum())
    circle_area = math.pi * radius_m * radius_m
    return {
        "plateau_road_segments": int(len(hit)),
        "plateau_road_area_m2_in_circle": round(road_area, 1),
        "road_area_ratio": round(road_area / circle_area, 4),
        "value_kind": "PLATEAU tran:Road（車道の面）。**公式の歩行者網ではない**",
        "note": "道路ネットワーク距離・等時線（10 分圏）は T2（別 PR）。"
                "ここは円内の素の道路面積。線路は scripts/12（配信物）にあるが未取り込み",
    }


def run_point(
    lon: float, lat: float, radii: list[int], method: str, label: str,
    aoi_override: str | None, out_dir: Path,
) -> dict:
    x, y = point_to_analysis(lon, lat)
    aoi, edge_m = (aoi_override, None) if aoi_override else (None, None)
    if aoi is None:
        aoi, edge_m = pick_aoi(x, y)

    areas = load_boundaries(CRS_ANALYSIS)
    stats = load_area_stats()
    objects = load_objects(aoi)
    codes = usage_codelist()

    max_r = max(radii)
    aoi_a = AOIS[aoi]
    circle_in_aoi = (aoi_a.xmin <= x - max_r and x + max_r <= aoi_a.xmax
                     and aoi_a.ymin <= y - max_r and y + max_r <= aoi_a.ymax)

    per_radius: dict[str, dict] = {}
    pop_rows: list[dict] = []
    usage_rows: list[dict] = []
    for r in radii:
        pop_sec, prows = population_section(areas, stats, lon, lat, r, method)
        use_sec, urows = building_usage_section(objects, lon, lat, r, codes)
        trans_sec = transport_section(objects, lon, lat, r)
        pop_rows += prows
        usage_rows += urows
        per_radius[str(r)] = {
            "1_population_and_age": pop_sec,
            "2_building_usage": use_sec,
            "3_establishments": {
                "status": "未取得",
                "note": "経済センサス（事業所数）。別データ取得・別 PR（docs/todo.md T1）",
            },
            "4_land_use_regulation": {
                "status": "未取得",
                "note": "用途地域等の都市計画制限（都市計画 GIS）。別データ取得・別 PR",
            },
            "5_transport": trans_sec,
        }

    result = {
        "label": label,
        "center_wgs84_ish": {"lon": lon, "lat": lat, "crs": "EPSG:6668"},
        "center_epsg6674": [round(x, 2), round(y, 2)],
        "aoi": aoi,
        "aoi_selection": ("指定" if aoi_override else "点に最も近い AOI を自動選択"),
        "point_to_aoi_edge_m": None if edge_m is None else round(edge_m, 1),
        "radii_m": radii,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "by_radius": per_radius,
        "boundary": boundary_metadata(),
        "census_stats": stats_metadata(),
        "caveats": [
            "① 境界は scripts/13 が AOI 3 範囲に交差する小地域だけに絞った 162 面。"
            "円がその外へ出ると小地域ごと欠落する（AOI 中心部では実害なし）",
            "① 人口・年齢は 2020年国勢調査 小地域の公式値を面按分した推計。"
            "小地域内で人口が一様という仮定が入る（--method centroid で切替可）",
            "① 秘匿（対象数が少ない）小地域は人口が欠損。按分の分母から外している"
            "（人口は過小評価側。n_small_areas_suppressed_in_circle 参照）",
            "② 建物は PLATEAU LOD1（2024年測量）。小地域境界は 2020年時点。"
            "新築・除却・境界改定のずれは補正していない",
            "② 用途は bldg:usage の代表値 1 つ（複合用途の内訳は持たない）",
            "③ 事業所数・④ 用途地域は未取得（別データ・別 PR）",
            "⑤ tran:Road は車道の面であって歩行者網ではない。"
            "道路ネットワーク距離・等時線は T2（別 PR）",
        ],
    }
    if not circle_in_aoi:
        result["caveats"].insert(0,
            f"② ⑤ の建物・道路は AOI '{aoi}' の objects.geojson が母数。"
            f"半径 {max_r} m の円が AOI 矩形からはみ出しており、"
            "縁の建物・道路を取りこぼしている可能性がある（① 人口には影響しない）")

    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^0-9A-Za-z_-]+", "_", label) or "point"
    (out_dir / f"point_buffer_{slug}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_csv(out_dir / f"point_buffer_{slug}_pop.csv", pop_rows,
               ["radius_m", "key_code", "s_name", "circle_frac", "weight",
                "pop_total", *AGE_FIELDS, "suppressed"])
    _write_csv(out_dir / f"point_buffer_{slug}_bldg_usage.csv", usage_rows,
               ["radius_m", "usage_code", "usage_label", "count"])
    for r in radii:
        s = per_radius[str(r)]
        print(f"  r={r:>4} m: 人口 {s['1_population_and_age']['population_estimate']:>8.0f}"
              f"（高齢化率 {s['1_population_and_age']['aging_rate_65plus']}）"
              f" / 建物 {s['2_building_usage']['total_buildings']:>5}"
              f" / 道路 {s['5_transport']['plateau_road_segments']:>4} 本")
    print(f"  wrote {out_dir}/point_buffer_{slug}.json ほか 2 CSV")
    return result


def _write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow({k: ("" if row.get(k) is None else row.get(k)) for k in fields})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lon", type=float, required=True, help="中心の経度（EPSG:6668）")
    ap.add_argument("--lat", type=float, required=True, help="中心の緯度（EPSG:6668）")
    ap.add_argument("--radius", type=int, nargs="+", choices=RADII,
                    default=list(DEFAULT_RADII), help="徒歩圏半径 [m]（複数可）")
    ap.add_argument("--method", choices=METHODS, default="areal",
                    help="人口の按分方法（既定 areal = 面按分）")
    ap.add_argument("--aoi", choices=list(AOIS),
                    help="建物・道路の母数にする AOI（既定: 点に最も近い AOI）")
    ap.add_argument("--label", default="", help="地点名（出力ファイル名・JSON に入る）")
    ap.add_argument("--out-dir", type=Path,
                    default=ROOT / "data" / "out" / "point_buffer")
    args = ap.parse_args()

    label = args.label or f"{args.lat:.5f}_{args.lon:.5f}"
    run_point(args.lon, args.lat, sorted(set(args.radius)), args.method, label,
              args.aoi, args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
