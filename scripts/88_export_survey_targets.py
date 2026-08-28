#!/usr/bin/env python3
"""次の高潮時に先に見るべき地物のリストを書き出す。

「仮定の段階」が 2 段になる地物（S1 では未到達、S2 では到達）を対象にする。
これは「実在の吐口があれば確定する地物」であり、仮想吐口そのものは実在施設ではない。

出力は CSV と GeoJSON。画面は作らない（docs/design.md の「やらないこと」）。
代表潮位ごとに 1 組ずつ出し、東舞鶴・西舞鶴を 1 つのファイルにまとめる。
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
DEFAULT_TIDES = (0.93, 0.69)
FEATURE_TYPE_LABEL = {
    "bldg:Building": "建物",
    "tran:Road": "道路",
}

FIELDS = [
    "aoi",
    "target_tide_m_tp",
    "survey_priority",
    "assumption_step",
    "gml_id",
    "feature_type",
    "feature_type_label",
    "name",
    "class",
    "usage",
    "area_m2",
    "representative_lon",
    "representative_lat",
    "ground_elev_drainage_m_tp",
    "h_conn_s1_m_tp",
    "h_conn_s2_m_tp",
    "s2_minus_s1_m",
    "target_reason",
    "outfall_check_conclusive",
    "synthetic_outfall_note",
]


def finite(value: object) -> float | None:
    if value in (None, "", "None"):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result != float("inf") else None


def load_objects(root: Path, aoi: str) -> list[dict]:
    path = root / "data" / "out" / aoi / "objects.geojson"
    if not path.exists():
        raise SystemExit(f"入力がありません: {path}")
    data = json.loads(path.read_text())
    features = data.get("features", [])
    if data.get("crs", {}).get("properties", {}).get("name") != "EPSG:6674":
        raise SystemExit(f"{path}: CRS が EPSG:6674 ではありません")
    return features


def make_record(
    feature: dict,
    aoi: str,
    tide: float,
    to_lonlat: Transformer,
) -> dict | None:
    p = feature.get("properties", {})
    if str(p.get("unreliable", "")).lower() == "true":
        return None

    s1 = finite(p.get("h_conn_highres"))
    s2 = finite(p.get("h_conn_drainage"))
    ground = finite(p.get("ground_elev_drainage"))
    if s1 is None or s2 is None or ground is None:
        return None

    # 2段: S1（海から地表で連結）ではまだ浸からず、S2（仮想吐口を逆流）で浸かる。
    # この行の判定は「吐口がある」という仮定に依存する。
    if not (s1 > tide and s2 <= tide and ground <= tide):
        return None

    geom = shape(feature.get("geometry"))
    point = geom.representative_point()
    lon, lat = to_lonlat.transform(point.x, point.y)
    feature_type = str(p.get("feature_type", ""))
    return {
        "aoi": aoi,
        "target_tide_m_tp": f"{tide:.2f}",
        "survey_priority": 1,
        "assumption_step": 2,
        "gml_id": p.get("gml_id"),
        "feature_type": feature_type,
        "feature_type_label": FEATURE_TYPE_LABEL.get(feature_type, feature_type),
        "name": p.get("name") or "",
        "class": p.get("class") or "",
        "usage": p.get("usage") or "",
        "area_m2": p.get("area_m2"),
        "representative_lon": round(lon, 7),
        "representative_lat": round(lat, 7),
        "ground_elev_drainage_m_tp": f"{ground:.3f}",
        "h_conn_s1_m_tp": f"{s1:.3f}",
        "h_conn_s2_m_tp": f"{s2:.3f}",
        "s2_minus_s1_m": f"{s2 - s1:.3f}",
        "target_reason":
            "S1では未到達・S2では到達。吐口の位置・敷高・逆流防止施設が分かれば判定を確定できる",
        "outfall_check_conclusive": True,
        "synthetic_outfall_note":
            "S2の吐口は仮想データであり実在施設ではない（docs/flood_simulation_spec.md §1）",
    }


def write_outputs(root: Path, tide: float, records: list[dict]) -> None:
    out_dir = root / "data" / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    level = f"{tide:.2f}".replace(".", "p")
    csv_path = out_dir / f"survey_targets_H{level}.csv"
    geojson_path = out_dir / f"survey_targets_H{level}.geojson"

    records = sorted(
        records,
        key=lambda r: (
            float(r["h_conn_s2_m_tp"]),
            float(r["h_conn_s1_m_tp"]),
            r["aoi"],
            0 if r["feature_type"] == "bldg:Building" else 1,
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
                "coordinates": [
                    r["representative_lon"],
                    r["representative_lat"],
                ],
            },
            "properties": r,
        }
        for r in records
    ]
    geojson = {
        "type": "FeatureCollection",
        "name": f"survey_targets_H{level}",
        "metadata": {
            "target_tide_m_tp": tide,
            "assumption_step": 2,
            "definition": "h_conn_highres > H かつ h_conn_drainage <= H",
            "crs_of_representative_points": "EPSG:4326",
            "synthetic_outfall_warning":
                "S2の吐口は仮想データであり実在施設ではない",
        },
        "features": features,
    }
    geojson_path.write_text(
        json.dumps(geojson, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"wrote {csv_path} ({len(records)} features)")
    print(f"wrote {geojson_path}")


def count_by(records: list[dict], key: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for record in records:
        value = str(record[key])
        result[value] = result.get(value, 0) + 1
    return dict(sorted(result.items()))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", choices=DEFAULT_AOIS, nargs="+", default=list(DEFAULT_AOIS))
    ap.add_argument("--tide-m-tp", type=float, nargs="+", default=list(DEFAULT_TIDES))
    args = ap.parse_args()

    to_lonlat = Transformer.from_crs("EPSG:6674", "EPSG:4326", always_xy=True)
    all_records: dict[float, list[dict]] = {h: [] for h in args.tide_m_tp}
    for aoi in args.aoi:
        features = load_objects(ROOT, aoi)
        for tide in args.tide_m_tp:
            selected = [
                record
                for feature in features
                if (record := make_record(feature, aoi, tide, to_lonlat)) is not None
            ]
            all_records[tide].extend(selected)
            print(
                f"{aoi} H={tide:.2f}: {len(selected)} features "
                f"({count_by(selected, 'feature_type_label')})"
            )

    for tide, records in all_records.items():
        write_outputs(ROOT, tide, records)

    summary_path = ROOT / "data" / "out" / "survey_targets_summary.json"
    summary = {
        "aois": list(args.aoi),
        "definition": "h_conn_highres > H かつ h_conn_drainage <= H",
        "assumption_step": 2,
        "priority_note":
            "このリストは「仮定で割れる」地物を優先する。経路を示せない1段は含めない",
        "counts": {
            f"{tide:.2f}": {
                "total": len(records),
                "by_aoi": count_by(records, "aoi"),
                "by_feature_type": count_by(records, "feature_type_label"),
            }
            for tide, records in all_records.items()
        },
        "caveats": [
            "S2の吐口は仮想データであり実在施設ではない",
            "地盤高・h_connはobjects.csvの集計値を再計算なしで使う",
            "静水位モデルであり流量・時間発展・波浪・越波・河川流量を含まない",
        ],
    }
    summary_path.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"wrote {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
