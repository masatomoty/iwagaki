#!/usr/bin/env python3
"""高潮時に通行規制を検討すべき道路のリストを書き出す。

舞鶴市 建設部土木課の考え方（https://www.city.maizuru.kyoto.jp/0000009894.html）に
合わせ、判定の根拠は「車が通れるか」ではなく次の 2 点にする。

* 車両の塩害 — 路面に海水が乗ること自体（浸水深 > 0）が規制の理由になる。
* 走行波 — 冠水した道を車が走ると舳先波が沿道家屋に当たる（ガラス破損・
  床下浸水の悪化）。だから **沿道に建物が近いかどうか** が効く
  （`frontage_building_count_5m`、`scripts/50` が付与）。

入力は `data/out/{aoi}/objects.geojson`。道路 1 件ごとに代表潮位 H で判定し、
`regulation != none` の道路だけを出す。出力は CSV と GeoJSON（点・EPSG:4326）と
集計 JSON。画面は作らない（`scripts/88` と同じ、`docs/design.md` の「やらないこと」）。

判定:

* ``depth_simple``     = ``max(0, H - ground_elev_highres)``（viewer 既定の静水位モデル）
* ``depth_connected``  = 同じ式だが ``h_conn_highres <= H`` でなければ 0（比較用の別列）
* ``regulation``（``depth_simple`` から。安全側で広めに出す）
    * ``none``          浸水深 0
    * ``徐行``          浸水深 > 0 かつ ``frontage_building_count_5m`` == 0
    * ``通行規制検討``  浸水深 > 0 かつ ``frontage_building_count_5m`` >= 1（走行波リスク）
    * ``通行止め相当``  浸水深 >= 0.15（沿道建物によらず優先）
* ``depth_class``       0 / 1(>=0.10) / 2(>=0.15) / 3(>=0.30)

**注意（この出力の限界）:**

* 静水位モデル。流量・時間発展・波浪・越波・河川流量は含まない。
* 走行波そのものは出していない。沿道建物の近さは走行波リスクの **間接指標**。
* 閾値 0.10 / 0.15 / 0.30 m は全国のアンダーパス冠水規制の運用値であり、
  技術基準ではない。
* 単純モデルでは窪地も冠水扱いになるので、規制対象は広めに出る（安全側）。
* 塩害の観点では ``depth_simple > 0`` の道路がすべて対象になる。
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import ROOT

DEFAULT_AOIS = ("nishi_maizuru", "higashi_maizuru")
AOI_CHOICES = ("yoshiwara", "nishi_maizuru", "higashi_maizuru")
DEFAULT_TIDES = (0.93, 0.69)

# アンダーパス冠水規制の運用値（技術基準ではない）
DEPTH_STOP_M = 0.15          # これ以上は沿道建物によらず「通行止め相当」
DEPTH_CLASS_THRESHOLDS_M = (0.10, 0.15, 0.30)   # depth_class 1 / 2 / 3

FIELDS = [
    "aoi",
    "target_tide_m_tp",
    "gml_id",
    "name",
    "class",
    "section_type_label",
    "ground_elev_highres",
    "depth_simple",
    "depth_connected",
    "nearest_building_m",
    "frontage_building_count_2m",
    "frontage_building_count_5m",
    "frontage_building_count_10m",
    "regulation",
    "depth_class",
    "representative_lon",
    "representative_lat",
]

REGULATIONS = ("徐行", "通行規制検討", "通行止め相当")


def finite(value: object) -> float | None:
    if value in (None, "", "None"):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result != float("inf") else None


def as_int(value: object) -> int | None:
    if value in (None, "", "None"):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def load_objects(root: Path, aoi: str) -> list[dict]:
    path = root / "data" / "out" / aoi / "objects.geojson"
    if not path.exists():
        raise SystemExit(f"入力がありません: {path}")
    data = json.loads(path.read_text())
    if data.get("crs", {}).get("properties", {}).get("name") != "EPSG:6674":
        raise SystemExit(f"{path}: CRS が EPSG:6674 ではありません")
    return data.get("features", [])


def depth_class(depth: float) -> int:
    c = 0
    for k, t in enumerate(DEPTH_CLASS_THRESHOLDS_M, start=1):
        if depth >= t:
            c = k
    return c


def regulation_of(depth_simple: float, frontage_5m: int | None) -> str:
    """``depth_simple`` と 5 m 沿道建物数から規制区分を決める。"""
    if depth_simple <= 0:
        return "none"
    if depth_simple >= DEPTH_STOP_M:
        return "通行止め相当"
    if frontage_5m is not None and frontage_5m >= 1:
        return "通行規制検討"
    return "徐行"


def make_record(
    feature: dict,
    aoi: str,
    tide: float,
    to_lonlat: Transformer,
) -> dict | None:
    p = feature.get("properties", {})
    if str(p.get("feature_type", "")) != "tran:Road":
        return None
    if str(p.get("unreliable", "")).lower() == "true":
        return None

    ground = finite(p.get("ground_elev_highres"))
    if ground is None:
        return None
    h_conn = finite(p.get("h_conn_highres"))

    depth_simple = max(0.0, tide - ground)
    depth_connected = depth_simple if (h_conn is not None and h_conn <= tide) else 0.0

    frontage_5m = as_int(p.get("frontage_building_count_5m"))
    regulation = regulation_of(depth_simple, frontage_5m)
    if regulation == "none":
        return None

    geom = shape(feature.get("geometry"))
    point = geom.representative_point()
    lon, lat = to_lonlat.transform(point.x, point.y)
    return {
        "aoi": aoi,
        "target_tide_m_tp": f"{tide:.2f}",
        "gml_id": p.get("gml_id"),
        "name": p.get("name") or "",
        "class": p.get("class") or "",
        "section_type_label": p.get("section_type_label") or "",
        "ground_elev_highres": f"{ground:.3f}",
        "depth_simple": f"{depth_simple:.3f}",
        "depth_connected": f"{depth_connected:.3f}",
        "nearest_building_m": _fmt(finite(p.get("nearest_building_m"))),
        "frontage_building_count_2m": _blank(as_int(p.get("frontage_building_count_2m"))),
        "frontage_building_count_5m": _blank(frontage_5m),
        "frontage_building_count_10m": _blank(as_int(p.get("frontage_building_count_10m"))),
        "regulation": regulation,
        "depth_class": depth_class(depth_simple),
        "representative_lon": round(lon, 7),
        "representative_lat": round(lat, 7),
    }


def _fmt(value: float | None) -> str:
    return "" if value is None else f"{value:.3f}"


def _blank(value: int | None) -> str | int:
    return "" if value is None else value


def write_outputs(root: Path, tide: float, records: list[dict]) -> None:
    out_dir = root / "data" / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    level = f"{tide:.2f}".replace(".", "p")
    csv_path = out_dir / f"traffic_regulation_H{level}.csv"
    geojson_path = out_dir / f"traffic_regulation_H{level}.geojson"

    rank = {r: i for i, r in enumerate(("通行止め相当", "通行規制検討", "徐行"))}
    records = sorted(
        records,
        key=lambda r: (
            rank.get(r["regulation"], 9),
            -float(r["depth_simple"]),
            r["aoi"],
            str(r["gml_id"]),
        ),
    )

    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(records)

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [r["representative_lon"], r["representative_lat"]],
            },
            "properties": r,
        }
        for r in records
    ]
    geojson = {
        "type": "FeatureCollection",
        "name": f"traffic_regulation_H{level}",
        "metadata": {
            "target_tide_m_tp": tide,
            "model": "静水位（simple）。depth_simple = max(0, H - ground_elev_highres)",
            "depth_stop_m": DEPTH_STOP_M,
            "depth_class_thresholds_m": list(DEPTH_CLASS_THRESHOLDS_M),
            "crs_of_representative_points": "EPSG:4326",
            "basis":
                "舞鶴市 建設部土木課。塩害（depth>0）と走行波（沿道建物の近さ）で判定",
            "caveat":
                "閾値はアンダーパス冠水規制の運用値であり技術基準ではない。"
                "走行波そのものは出していない間接指標。窪地も冠水扱いで安全側に広い",
        },
        "features": features,
    }
    geojson_path.write_text(
        json.dumps(geojson, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"wrote {csv_path} ({len(records)} roads)")
    print(f"wrote {geojson_path}")


def count_by_regulation(records: list[dict]) -> dict[str, int]:
    result = {r: 0 for r in REGULATIONS}
    for record in records:
        result[record["regulation"]] = result.get(record["regulation"], 0) + 1
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--aoi", choices=AOI_CHOICES, nargs="+", default=list(DEFAULT_AOIS))
    ap.add_argument("--tide-m-tp", type=float, nargs="+", default=list(DEFAULT_TIDES))
    ap.add_argument("--dry-run", action="store_true",
                    help="判定関数の自己確認だけ行い、ファイルは書かない")
    args = ap.parse_args()

    if args.dry_run:
        return _selfcheck()

    to_lonlat = Transformer.from_crs("EPSG:6674", "EPSG:4326", always_xy=True)
    per_tide: dict[float, list[dict]] = {h: [] for h in args.tide_m_tp}
    per_tide_aoi: dict[str, dict[str, list[dict]]] = {}
    for aoi in args.aoi:
        features = load_objects(ROOT, aoi)
        for tide in args.tide_m_tp:
            selected = [
                record
                for feature in features
                if (record := make_record(feature, aoi, tide, to_lonlat)) is not None
            ]
            per_tide[tide].extend(selected)
            per_tide_aoi.setdefault(f"{tide:.2f}", {})[aoi] = selected
            counts = count_by_regulation(selected)
            print(f"{aoi} H={tide:.2f}: {len(selected)} roads {counts}")

    for tide, records in per_tide.items():
        write_outputs(ROOT, tide, records)

    summary_path = ROOT / "data" / "out" / "traffic_regulation_summary.json"
    summary = {
        "aois": list(args.aoi),
        "tides_m_tp": list(args.tide_m_tp),
        "basis_url": "https://www.city.maizuru.kyoto.jp/0000009894.html",
        "model": "静水位（simple）。depth_simple = max(0, H - ground_elev_highres)",
        "depth_stop_m": DEPTH_STOP_M,
        "depth_class_thresholds_m": list(DEPTH_CLASS_THRESHOLDS_M),
        "counts": {
            f"{tide:.2f}": {
                "total": len(records),
                "by_regulation": count_by_regulation(records),
                "by_aoi": {
                    aoi: {
                        "total": len(recs),
                        "by_regulation": count_by_regulation(recs),
                    }
                    for aoi, recs in per_tide_aoi.get(f"{tide:.2f}", {}).items()
                },
            }
            for tide, records in per_tide.items()
        },
        "caveats": [
            "静水位モデル。流量・時間発展・波浪・越波・河川流量を含まない",
            "走行波そのものは出さない。沿道建物の近さは走行波リスクの間接指標",
            "閾値 0.10/0.15/0.30 m は全国のアンダーパス冠水規制の運用値であり技術基準ではない",
            "単純モデルでは窪地も冠水扱いなので規制対象は広め（安全側）",
            "塩害の観点では depth_simple > 0 の道路がすべて対象",
            "unreliable（橋梁・高架橋・アンダーパス・トンネル・大半が開放水面）は除外",
        ],
    }
    summary_path.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"wrote {summary_path}")
    return 0


def _selfcheck() -> int:
    """`objects.geojson` が無くても回る最小の自己確認。"""
    cases = [
        # (depth_simple, frontage_5m, expect regulation, expect depth_class)
        (0.0, 0, "none", 0),
        (0.05, 0, "徐行", 0),
        (0.05, 3, "通行規制検討", 0),
        (0.12, 0, "徐行", 1),
        (0.15, 0, "通行止め相当", 2),
        (0.40, 5, "通行止め相当", 3),
        (0.05, None, "徐行", 0),
    ]
    ok = True
    for depth, front, exp_reg, exp_cls in cases:
        got_reg = regulation_of(depth, front)
        got_cls = depth_class(depth)
        mark = "ok" if (got_reg == exp_reg and got_cls == exp_cls) else "NG"
        if mark == "NG":
            ok = False
        print(f"[{mark}] depth={depth} frontage_5m={front} -> "
              f"{got_reg}/{got_cls} (期待 {exp_reg}/{exp_cls})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
