#!/usr/bin/env python3
"""浸水建物を国勢調査の小地域（町丁・字等）ごとに集計して書き出す。

上田氏の要望（2026-08-28）「浸水建物の抽出を国勢調査の小地域ごとに集計できると
地域ごとの比較ができていい」への対応。viewer の潮位再生パネルは床上/床下の
**全体棟数**しか出していない（`web/src/domain/flood.ts` の `floorCounts`）ので、
その内訳を小地域別にする。**このスクリプトはファイル書き出しだけ**で、viewer 表示と
catalog への配線は別 PR（`docs/design.md`「やらないこと」。`scripts/88` / `scripts/91`
と同じ立て付け）。

入力
----
* `data/out/{aoi}/objects.geojson` の `feature_type == "bldg:Building"`
* `scripts/13_fetch_census_boundaries.py` が出した
  `data/interim/census_boundary_maizuru_2020.geojson`（小地域ポリゴン、EPSG:6674）

各建物を **geometry の重心**で小地域に空間結合する。重心がどの小地域にも入らない
建物は `(小地域外)` 行にまとめる（母数を objects.geojson と一致させるため）。

集計
----
代表潮位ごとにファイルを 1 組出し、その中に **2 つの浸水モデルを列で並べる**。

* 代表潮位 `DEFAULT_TIDES = (0.93, 0.69)`（`scripts/91` と同じ。
  0.93 = 既往最高潮位、0.69 = 高潮想定の基準潮位）
* 浸水深（`scripts/91` の `depth_simple` / `depth_connected`、
  `web/src/domain/flood.ts` の `depth()` と一致）:
    * ``simple``    … ``max(0, H - ground_elev_highres)``
    * ``connected`` … 同式だが ``h_conn_highres <= H`` でなければ 0
* 判定（`web/src/view/buildingColor.ts` の `FLOOR_ABOVE_DEPTH_M = 0.5` と一致）:
    * ``unreliable == true`` の建物は集計から除外（総棟数にも入れない）
    * 床上 = 浸水深 >= 0.5
    * 床下 = 0 < 浸水深 < 0.5
* 小地域ごとの値: 総棟数 / 浸水棟数（床上+床下）/ 床上棟数 / 床下棟数 / 浸水率

対象範囲
--------
`DEFAULT_AOIS = ("nishi_maizuru", "higashi_maizuru")`。`yoshiwara` は `--aoi` で
選べる（`scripts/91` / `scripts/88` と同じ CLI）。**`yoshiwara` は 100 ha で
小地域が数個しか掛からない**ので地域比較には向かない（吉原 AOI に交差する
小地域は 22、うち建物が乗るのはさらに少ない）。

出力（`data/out/{aoi}/` 直下、`scripts/91` の命名に倣う）
----
* ``area_flood_H0p93.csv`` / ``area_flood_H0p69.csv``（小地域 1 行）
* ``area_flood_H0p93.geojson`` / ``area_flood_H0p69.geojson``
  （小地域ポリゴン、EPSG:4326、集計値を属性に。将来 viewer のコロプレス用）
* ``area_flood_summary.json``（範囲・潮位・モデル別の合計、母数、生成時刻、
  境界データの版）

**注意（この出力の限界）**

* ここに出る棟数は **モデル由来の推計値**であり、国勢調査の公式統計値ではない
  （各行・各ファイルに `value_kind` 明記）。小地域の人口・世帯数は使っていない。
* 静水位モデル。流量・時間発展・波浪・越波・河川流量は含まない
  （`docs/design.md`「既知の限界」）。
* `connected` が 0 に潰すぶんは「標高は潮位以下だが地表面で海とつながらない」窪地。
  吐口にフラップゲートが無い以上、過小評価はこちら側（`docs/results.md`）。
* 建物の代表点（重心）が小地域の境に乗ると、どちらか一方に決めて数える。
* PLATEAU LOD1 は床高を持たないので「床上」は地盤面から 0.5 m 浸かったの意味で、
  その建物の床面を超えた証明ではない（`web/src/view/buildingColor.ts`）。
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import CRS_ANALYSIS, INTERIM, ROOT

DEFAULT_AOIS = ("nishi_maizuru", "higashi_maizuru")
AOI_CHOICES = ("yoshiwara", "nishi_maizuru", "higashi_maizuru")
DEFAULT_TIDES = (0.93, 0.69)

#: 床上浸水とみなす浸水深 [m]。web/src/view/buildingColor.ts の FLOOR_ABOVE_DEPTH_M。
FLOOR_ABOVE_DEPTH_M = 0.5

BOUNDARY_PATH = INTERIM / "census_boundary_maizuru_2020.geojson"

#: 重心がどの小地域にも入らなかった建物をまとめる行のキー
OUTSIDE_KEY = ""
OUTSIDE_NAME = "(小地域外)"

VALUE_KIND = "推計棟数（モデル由来。国勢調査の公式統計値ではない）"

MODELS = ("simple", "connected")

FIELDS = [
    "aoi",
    "target_tide_m_tp",
    "key_code",
    "s_name",
    "city_name",
    "total_bldg",
    "simple_flooded_bldg",
    "simple_floor_above_bldg",
    "simple_floor_under_bldg",
    "simple_flood_rate",
    "connected_flooded_bldg",
    "connected_floor_above_bldg",
    "connected_floor_under_bldg",
    "connected_flood_rate",
    "value_kind",
]


def finite(value: object) -> float | None:
    if value in (None, "", "None"):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result not in (float("inf"), float("-inf")) else None


def building_depths(props: dict, tide: float) -> tuple[float, float]:
    """(depth_simple, depth_connected)。scripts/91 と flood.ts の式に一致させる。"""
    ground = finite(props.get("ground_elev_highres"))
    if ground is None:
        return 0.0, 0.0
    h_conn = finite(props.get("h_conn_highres"))
    depth_simple = max(0.0, tide - ground)
    depth_connected = depth_simple if (h_conn is not None and h_conn <= tide) else 0.0
    return depth_simple, depth_connected


def floor_bucket(depth: float, floor: float = FLOOR_ABOVE_DEPTH_M) -> str:
    """浸水深 -> 'above' / 'under' / 'dry'。閾値は「以上」で床上。"""
    if depth >= floor:
        return "above"
    if depth > 0:
        return "under"
    return "dry"


def _blank_counts() -> dict[str, int]:
    return {f"{m}_{b}": 0 for m in MODELS for b in ("above", "under")}


def load_buildings(aoi: str) -> gpd.GeoDataFrame:
    path = ROOT / "data" / "out" / aoi / "objects.geojson"
    if not path.exists():
        raise SystemExit(f"入力がありません: {path}")
    data = json.loads(path.read_text())
    if data.get("crs", {}).get("properties", {}).get("name") != CRS_ANALYSIS:
        raise SystemExit(f"{path}: CRS が {CRS_ANALYSIS} ではありません")
    rows = []
    for feature in data.get("features", []):
        p = feature.get("properties", {})
        if str(p.get("feature_type", "")) != "bldg:Building":
            continue
        if str(p.get("unreliable", "")).lower() == "true":
            continue
        geom = shape(feature.get("geometry"))
        rows.append({
            "gml_id": p.get("gml_id"),
            "ground_elev_highres": p.get("ground_elev_highres"),
            "h_conn_highres": p.get("h_conn_highres"),
            # 代表点は geometry の重心（要望どおり）
            "geometry": geom.centroid,
        })
    if not rows:
        raise SystemExit(f"{path}: bldg:Building が 0 件")
    return gpd.GeoDataFrame(rows, crs=CRS_ANALYSIS)


def load_boundaries() -> gpd.GeoDataFrame:
    if not BOUNDARY_PATH.exists():
        raise SystemExit(
            f"{BOUNDARY_PATH} がありません。先に scripts/13_fetch_census_boundaries.py"
        )
    gdf = gpd.read_file(BOUNDARY_PATH)
    if gdf.crs is None:
        gdf = gdf.set_crs(CRS_ANALYSIS)
    return gdf.to_crs(CRS_ANALYSIS)[["KEY_CODE", "S_NAME", "CITY_NAME", "geometry"]]


def assign_to_areas(
    buildings: gpd.GeoDataFrame, areas: gpd.GeoDataFrame
) -> pd.DataFrame:
    """建物の重心を小地域に空間結合する。返り値は建物 1 行、小地域キー付き。

    境界ちょうどに乗って複数の小地域に当たる建物は KEY_CODE 昇順で 1 つに決める。
    どの小地域にも入らない建物は KEY_CODE を空にする。
    """
    joined = gpd.sjoin(buildings, areas, predicate="within", how="left")
    joined = (
        joined.sort_values("KEY_CODE")
        .drop_duplicates("gml_id", keep="first")
        .set_index("gml_id")
    )
    out = buildings.set_index("gml_id").copy()
    out["key_code"] = joined["KEY_CODE"].reindex(out.index).fillna(OUTSIDE_KEY)
    out["s_name"] = joined["S_NAME"].reindex(out.index).fillna(OUTSIDE_NAME)
    out["city_name"] = joined["CITY_NAME"].reindex(out.index).fillna("")
    return pd.DataFrame(out.drop(columns="geometry"))


def aggregate(assigned: pd.DataFrame, tide: float) -> dict[str, dict]:
    """小地域キー -> 集計値 dict。"""
    acc: dict[str, dict] = {}
    for row in assigned.itertuples(index=False):
        key = row.key_code
        rec = acc.get(key)
        if rec is None:
            rec = {
                "key_code": key,
                "s_name": row.s_name,
                "city_name": row.city_name,
                "total_bldg": 0,
                **_blank_counts(),
            }
            acc[key] = rec
        rec["total_bldg"] += 1
        ds, dc = building_depths(
            {"ground_elev_highres": row.ground_elev_highres,
             "h_conn_highres": row.h_conn_highres},
            tide,
        )
        for model, depth in (("simple", ds), ("connected", dc)):
            bucket = floor_bucket(depth)
            if bucket != "dry":
                rec[f"{model}_{bucket}"] += 1
    return acc


def _rate(flooded: int, total: int) -> float:
    return round(flooded / total, 4) if total else 0.0


def to_rows(acc: dict[str, dict], aoi: str, tide: float) -> list[dict]:
    rows = []
    for rec in acc.values():
        total = rec["total_bldg"]
        row = {
            "aoi": aoi,
            "target_tide_m_tp": f"{tide:.2f}",
            "key_code": rec["key_code"],
            "s_name": rec["s_name"],
            "city_name": rec["city_name"],
            "total_bldg": total,
            "value_kind": VALUE_KIND,
        }
        for model in MODELS:
            above = rec[f"{model}_above"]
            under = rec[f"{model}_under"]
            flooded = above + under
            row[f"{model}_flooded_bldg"] = flooded
            row[f"{model}_floor_above_bldg"] = above
            row[f"{model}_floor_under_bldg"] = under
            row[f"{model}_flood_rate"] = _rate(flooded, total)
        rows.append(row)
    # 浸水棟数（simple）の多い順、次いで KEY_CODE。小地域外は末尾。
    rows.sort(key=lambda r: (
        r["key_code"] == OUTSIDE_KEY,
        -r["simple_flooded_bldg"],
        r["key_code"],
    ))
    return rows


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {path} ({len(rows)} 小地域)")


def write_geojson(
    path: Path, rows: list[dict], areas_ll: gpd.GeoDataFrame, tide: float,
    boundary_meta: dict,
) -> None:
    by_key = {r["key_code"]: r for r in rows if r["key_code"] != OUTSIDE_KEY}
    features = []
    for rec in areas_ll.itertuples(index=False):
        row = by_key.get(rec.KEY_CODE)
        if row is None or row["total_bldg"] == 0:
            continue
        props = {k: v for k, v in row.items()}
        features.append({
            "type": "Feature",
            "geometry": rec.geometry.__geo_interface__,
            "properties": props,
        })
    fc = {
        "type": "FeatureCollection",
        "name": path.stem,
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "metadata": {
            "target_tide_m_tp": tide,
            "value_kind": VALUE_KIND,
            "models": {
                "simple": "max(0, H - ground_elev_highres)",
                "connected": "同式だが h_conn_highres <= H でなければ 0",
            },
            "floor_above_depth_m": FLOOR_ABOVE_DEPTH_M,
            "boundary": boundary_meta,
            "caveat":
                "モデル由来の推計棟数。国勢調査の公式統計値ではない。静水位モデルで"
                "流量・時間発展・波浪・越波・河川流量を含まない。小地域外の建物は"
                "このファイルに含めない（CSV と summary には (小地域外) 行がある）",
        },
        "features": features,
    }
    path.write_text(json.dumps(fc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {path} ({len(features)} 小地域ポリゴン)")


def totals_of(rows: list[dict]) -> dict:
    def s(field: str) -> int:
        return sum(r[field] for r in rows)
    total = s("total_bldg")
    out = {"total_bldg": total, "outside_area_bldg":
           next((r["total_bldg"] for r in rows if r["key_code"] == OUTSIDE_KEY), 0)}
    for model in MODELS:
        flooded = s(f"{model}_flooded_bldg")
        out[model] = {
            "flooded_bldg": flooded,
            "floor_above_bldg": s(f"{model}_floor_above_bldg"),
            "floor_under_bldg": s(f"{model}_floor_under_bldg"),
            "flood_rate": _rate(flooded, total),
        }
    return out


def boundary_metadata() -> dict:
    meta = json.loads(BOUNDARY_PATH.read_text()).get("metadata", {})
    return {k: meta.get(k) for k in ("survey_id", "boundary_year", "datum",
                                     "source", "source_url") if k in meta}


def run_aoi(aoi: str, tides: list[float], boundary_meta: dict) -> dict:
    buildings = load_buildings(aoi)
    areas = load_boundaries()
    assigned = assign_to_areas(buildings, areas)
    areas_ll = areas.to_crs("EPSG:4326")
    out_dir = ROOT / "data" / "out" / aoi
    out_dir.mkdir(parents=True, exist_ok=True)

    per_tide = {}
    for tide in tides:
        rows = to_rows(aggregate(assigned, tide), aoi, tide)
        level = f"{tide:.2f}".replace(".", "p")
        write_csv(out_dir / f"area_flood_H{level}.csv", rows)
        write_geojson(out_dir / f"area_flood_H{level}.geojson", rows, areas_ll,
                      tide, boundary_meta)
        per_tide[f"{tide:.2f}"] = totals_of(rows)
        t = per_tide[f"{tide:.2f}"]
        print(f"  {aoi} H={tide:.2f}: 総 {t['total_bldg']} 棟 / "
              f"浸水 simple {t['simple']['flooded_bldg']} "
              f"connected {t['connected']['flooded_bldg']}")

    summary = {
        "aoi": aoi,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tides_m_tp": tides,
        "floor_above_depth_m": FLOOR_ABOVE_DEPTH_M,
        "boundary": boundary_meta,
        "value_kind": VALUE_KIND,
        "building_universe":
            "objects.geojson の feature_type == 'bldg:Building' かつ unreliable != true",
        "by_tide": per_tide,
        "caveats": [
            "モデル由来の推計棟数であり国勢調査の公式統計値ではない",
            "静水位モデル。流量・時間発展・波浪・越波・河川流量を含まない",
            "床上/床下の閾値は地盤面からの浸水深 0.5 m（PLATEAU LOD1 は床高を持たない）",
            "建物の代表点は geometry の重心。小地域の境に乗ると片方に寄せて数える",
            "(小地域外) 行は重心がどの小地域にも入らなかった建物（母数の突き合わせ用）",
        ],
    }
    (out_dir / "area_flood_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  wrote {out_dir / 'area_flood_summary.json'}")
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--aoi", choices=AOI_CHOICES, nargs="+",
                    default=list(DEFAULT_AOIS))
    ap.add_argument("--tide-m-tp", type=float, nargs="+",
                    default=list(DEFAULT_TIDES))
    ap.add_argument("--dry-run", action="store_true",
                    help="集計関数の自己確認だけ行い、ファイルは書かない")
    args = ap.parse_args()

    if args.dry_run:
        return _selfcheck()

    boundary_meta = boundary_metadata()
    for aoi in args.aoi:
        run_aoi(aoi, list(args.tide_m_tp), boundary_meta)
    return 0


def _selfcheck() -> int:
    """objects.geojson / 境界データが無くても回る最小の自己確認。"""
    cases = [
        # (ground, h_conn, tide) -> (depth_simple, depth_connected)
        ((1.0, 1.0, 0.93), (0.0, 0.0)),
        ((0.0, 5.0, 0.93), (0.93, 0.0)),      # 連結しない窪地
        ((0.0, 0.5, 0.93), (0.93, 0.93)),
        ((0.30, 0.20, 0.69), (0.39, 0.39)),
        ((None, None, 0.93), (0.0, 0.0)),
    ]
    ok = True
    for (g, h, tide), (exp_s, exp_c) in cases:
        gs, gc = building_depths(
            {"ground_elev_highres": g, "h_conn_highres": h}, tide)
        mark = "ok" if (abs(gs - exp_s) < 1e-9 and abs(gc - exp_c) < 1e-9) else "NG"
        ok = ok and mark == "ok"
        print(f"[{mark}] ground={g} h_conn={h} H={tide} -> "
              f"{gs:.2f}/{gc:.2f} (期待 {exp_s:.2f}/{exp_c:.2f})")
    for depth, exp in ((0.5, "above"), (0.49, "under"), (0.0, "dry"),
                       (1.2, "above"), (1e-9, "under")):
        got = floor_bucket(depth)
        mark = "ok" if got == exp else "NG"
        ok = ok and mark == "ok"
        print(f"[{mark}] depth={depth} -> {got} (期待 {exp})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
