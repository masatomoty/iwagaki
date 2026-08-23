#!/usr/bin/env python3
"""Web 用の catalog.json と objects.geojson(WGS84) を作る。

catalog.json は「ブラウザが最初に読む 1 ファイル」であり、
**ローカル配信と Cloudflare 配信の唯一の境界**（docs/web_design.md「配信の境界」）。
URL を差し替えるだけで配信先を変えられるようにする。
"""
from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pyproj

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, CRS_ANALYSIS, H_MAX, H_MIN, H_STEP, OUT, RAW, ROOT,
                            REPRESENTATIVE_H, ROAD_DEPTH_CLASSES, TP_OF_MSL,
                            ATTRIBUTION)
from iwagaki.versioning import publish_dir, publish_file

WEB_DATA = ROOT / "web" / "public" / "data"

KEEP_PROPS = [
    "gml_id", "feature_type", "name", "class", "usage", "area_m2",
    "section_type", "section_type_label", "water_fraction",
    "unreliable", "unreliable_reason",
    # 4 条件すべて。以前は baseline / highres だけで、点群融合地形での
    # 判定を地物単位で見られなかった（docs/todo.md A2）
    "ground_elev_baseline", "ground_elev_highres",
    "ground_elev_control", "ground_elev_pointcloud",
    "h_conn_baseline", "h_conn_highres",
    "h_conn_control", "h_conn_pointcloud",
    "delta_ground_elev", "delta_h_conn",
]


# 属性コードの表示名。CityGML の codeSpace が指しているコードリスト（配布 zip 同梱）
# をそのまま使う。手書きの対応表を持たない。
CODELISTS = {"bldg:class": "Building_class.xml", "bldg:usage": "Building_usage.xml"}
GML = "{http://www.opengis.net/gml}"


def codelist(path: Path) -> dict[str, str]:
    root = ET.parse(path).getroot()
    out = {}
    for d in root.iter(f"{GML}Definition"):
        code, label = d.findtext(f"{GML}name"), d.findtext(f"{GML}description")
        if code and label:
            out[code.strip()] = label.strip()
    return out


def geoid_undulation(lon: float, lat: float) -> float:
    """標高(T.P.) -> 楕円体高 の差 N [m]。PROJ の GSIGEO2011 グリッドを使う。

    3D Tiles は楕円体高、我々の解析は T.P. なので、この差だけずれる。
    """
    pyproj.network.set_network_enabled(True)
    t = pyproj.Transformer.from_crs("EPSG:6697", "EPSG:4979", always_xy=True)
    return float(t.transform(lon, lat, 0.0)[2])


def local_frame(to_wgs, x0: float, y0: float, lon0: float, lat0: float) -> dict:
    """EPSG:6674 のオフセット -> 真の東西/南北メートル（deck.gl METER_OFFSETS 用）。

    平面直角座標をそのまま「メートルオフセット」として扱うと、子午線収差
    （吉原で約 -0.39 度）の分だけ回転してズレる。500 m 先で 3 m 以上。
    AOI が 1 km 四方しかないので、中心まわりの回転+スケールの 2x2 行列で十分に足りる。
    残差を実測して一緒に返す。
    """
    import math

    m_per_deg_lat = 111132.92 - 559.82 * math.cos(2 * math.radians(lat0))
    m_per_deg_lon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))

    def to_local(x: float, y: float) -> tuple[float, float]:
        lon, lat = to_wgs.transform(x, y)
        return ((lon - lon0) * m_per_deg_lon, (lat - lat0) * m_per_deg_lat)

    d = 500.0
    ex, ey = to_local(x0 + d, y0)
    nx, ny = to_local(x0, y0 + d)
    a, c = ex / d, ey / d          # 列: dE/dx, dN/dx
    b, dd = nx / d, ny / d         # 列: dE/dy, dN/dy

    worst = 0.0
    for sx in (-500.0, 0.0, 500.0):
        for sy in (-500.0, 0.0, 500.0):
            te, tn = to_local(x0 + sx, y0 + sy)
            ae, an = a * sx + b * sy, c * sx + dd * sy
            worst = max(worst, math.hypot(te - ae, tn - an))
    return {
        "origin_epsg6674": [x0, y0],
        "origin_wgs84": [round(lon0, 7), round(lat0, 7)],
        "matrix_2x2_row_major": [round(a, 9), round(b, 9), round(c, 9), round(dd, 9)],
        "usage": "[east, north] = M * [x - x0, y - y0]  (EPSG:6674 -> deck.gl METER_OFFSETS)",
        "max_residual_m_over_aoi": round(worst, 4),
    }


def default_section() -> dict:
    """scripts/87 が決めた既定の断面線。無ければ空で返す。

    座標を viewer に埋め込まないのは、AOI や地形を変えたら線も変わるため。
    どこを切るべきかは解析側が知っている。
    """
    p = OUT / "bank_crest.json"
    if not p.exists():
        return {}
    d = json.loads(p.read_text()).get("default_section")
    if not d:
        return {}
    return {"from": d["from_wgs84"], "to": d["to_wgs84"],
            "length_m": d["length_m"], "why": d["why"]}


def pc_coverage() -> dict:
    """scripts/25 が書いた被覆輪郭。無ければ空で返す（配線だけ先に入っている状態を許す）"""
    p = WEB_DATA / "pc_coverage.geojson"
    if not p.exists() and not list(WEB_DATA.glob("pc_coverage-*.geojson")):
        return {}
    name = publish_file(p)
    q = WEB_DATA / name
    props = json.loads(q.read_text())["features"][0]["properties"]
    return {"url": f"data/{name}", "bytes": q.stat().st_size, **props}


def versioned_urls(tiles: dict | None, tiles3d: dict | None) -> None:
    """
    配信物のディレクトリ／ファイルに**内容ハッシュを入れて改名**し、
    レポートの `url` を書き換える。

    `web/deploy/_headers` は `data/tiles` と `data/3dtiles` を immutable で配るので、
    **URL に内容が入っていないとデータを作り直しても古いキャッシュが残る**。
    入口の `catalog.json` は毎回再検証されるので、そこが指す URL が変われば追従できる。

    ここで一括してやるのは、**URL を決めているのがこのスクリプトだけ**だから。
    タイルを焼く `scripts/80` と 3D Tiles を作る `scripts/82` は
    `tiles/<名前>` / `3dtiles/<名前>` にそのまま書き、改名はここが引き受ける
    （重い 2 本を再実行しなくてもバージョンを付け直せる）。
    """
    for cond, meta in ((tiles or {}).get("conditions") or {}).items():
        name = publish_dir(WEB_DATA / "tiles", cond)
        meta["url"] = f"data/tiles/{name}/{{z}}/{{x}}/{{y}}.png"
    for key, meta in (tiles3d or {}).items():
        if not isinstance(meta, dict) or "url" not in meta:
            continue
        # url は "data/3dtiles/<名前>/tileset.json"。<名前> だけを付け替える
        base = str(meta["url"]).split("/")[2].split("-")[0]
        name = publish_dir(WEB_DATA / "3dtiles", base)
        meta["url"] = f"data/3dtiles/{name}/tileset.json"


def main() -> int:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    to_wgs = pyproj.Transformer.from_crs(CRS_ANALYSIS, "EPSG:4326", always_xy=True)

    corners = [to_wgs.transform(x, y)
               for x in (AOI.xmin, AOI.xmax) for y in (AOI.ymin, AOI.ymax)]
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    bbox = [min(lons), min(lats), max(lons), max(lats)]
    centre = to_wgs.transform((AOI.xmin + AOI.xmax) / 2, (AOI.ymin + AOI.ymax) / 2)
    n_geoid = geoid_undulation(*centre)

    # --- objects.geojson: EPSG:6674 -> WGS84, 属性を絞る -------------------
    src = json.loads((OUT / "objects.geojson").read_text())
    feats = []
    for f in src["features"]:
        p = f["properties"]
        props = {k: p.get(k) for k in KEEP_PROPS if p.get(k) not in (None, "")}
        g = f["geometry"]

        def conv(ring):
            return [[round(v, 7) for v in to_wgs.transform(x, y)] for x, y in ring]

        if g["type"] == "Polygon":
            g = {"type": "Polygon", "coordinates": [conv(r) for r in g["coordinates"]]}
        elif g["type"] == "MultiPolygon":
            g = {"type": "MultiPolygon",
                 "coordinates": [[conv(r) for r in poly] for poly in g["coordinates"]]}
        else:
            continue
        feats.append({"type": "Feature", "properties": props, "geometry": g})
    objects = {"type": "FeatureCollection", "features": feats}
    op = WEB_DATA / "objects.geojson"
    op.write_text(json.dumps(objects, separators=(",", ":")))
    # immutable で配るので URL に内容ハッシュを入れる（versioned_urls と同じ理由）
    semantics_name = publish_file(op)
    print(f"{semantics_name}: {len(feats)} features, "
          f"{(WEB_DATA / semantics_name).stat().st_size/1e6:.2f} MB")

    # --- 属性コード -> 表示名（建物のみ。出現したコードに絞る）----------------
    codelists = {}
    for key, fname in CODELISTS.items():
        path = RAW / "plateau" / fname
        if not path.exists():
            print(f"  ! {fname} 未取得。scripts/11_fetch_plateau.py を実行する")
            continue
        table = codelist(path)
        prop = key.split(":")[1]
        seen = sorted({f["properties"].get(prop) for f in feats
                       if f["properties"].get("feature_type") == "bldg:Building"}
                      - {None})
        codelists[key] = {c: table.get(c, c) for c in seen}
        missing = [c for c in seen if c not in table]
        print(f"  {key}: {len(seen)} codes"
              + (f" (コードリストに無い: {missing})" if missing else ""))

    # --- 各レポートを取り込む -----------------------------------------------
    def load(name):
        p = WEB_DATA / name
        return json.loads(p.read_text()) if p.exists() else None

    tiles = load("tiles_report.json")
    tiles3d = load("3dtiles_report.json")
    pc = load("pointcloud_report.json")
    # 内容ハッシュを URL に入れる（immutable キャッシュを差し替えられるように）
    versioned_urls(tiles, tiles3d)
    summary = json.loads((OUT / "summary.json").read_text())
    tide_path = OUT / "tide_levels.json"
    tide = json.loads(tide_path.read_text()) if tide_path.exists() else None

    def dir_bytes(rel: str) -> int:
        d = WEB_DATA / rel
        return sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) if d.exists() else 0

    catalog = {
        "version": 1,
        "aoi": {
            "name": AOI.name,
            "bounds_epsg6674": list(AOI.bounds),
            "bbox_wgs84": [round(v, 7) for v in bbox],
            "centre_wgs84": [round(centre[0], 7), round(centre[1], 7)],
            "local_origin_wgs84": [round(centre[0], 7), round(centre[1], 7)],
        },
        "local_frame": local_frame(
            to_wgs, (AOI.xmin + AOI.xmax) / 2, (AOI.ymin + AOI.ymax) / 2, *centre),
        "vertical": {
            "datum": "T.P. (orthometric)",
            "geoid_undulation_m": round(n_geoid, 3),
            "geoid_source": "PROJ EPSG:6697 -> EPSG:4979 (GSIGEO2011)",
            "note": "3D Tiles は楕円体高。我々のレイヤは z_render = z_TP + geoid_undulation_m で合わせる",
        },
        "water_level": {
            "min": H_MIN, "max": H_MAX, "step": H_STEP,
            "representative": list(REPRESENTATIVE_H),
            # scripts/86_tide_levels.py が求めた実際の潮位。水位 H を
            # 根拠のないパラメータのままにしないための目盛り
            "reference_levels_m_tp": (tide["reference_levels_m_tp"] if tide
                                      else {"MSL": TP_OF_MSL}),
            "reference_levels_detail": tide,
        },
        "packing": {
            "scheme": "rgba-terrarium-hconn",
            "elev": "(R*256 + G + B/256) - 32768",
            "elev_nodata": "R=G=B=0",
            "hconn": "A==0 -> unreachable; else (A-1)*h_step",
            "h_step": H_STEP,
            "note": "createImageBitmap は premultiplyAlpha:'none' で読むこと",
        },
        "terrain": {
            cond: {
                **{k: v for k, v in meta.items() if k != "per_zoom"},
                "label": summary["terrain"].get(
                    cond, "baseline と highres の判定差（h_conn を 2 チャンネルに格納）"),
            }
            for cond, meta in (tiles or {}).get("conditions", {}).items()
        },
        "plateau": tiles3d or {},
        "pointcloud": pc or {},
        "semantics": {
            "url": f"data/{semantics_name}",
            "bytes": (WEB_DATA / semantics_name).stat().st_size,
            "feature_count": len(feats),
            "road_depth_classes_m": list(ROAD_DEPTH_CLASSES),
            # 実際に出現したコードだけ載せる。viewer の凡例はこれを引く
            "codelists": codelists,
        },
        # 点群が地表面として効いている範囲。AOI 100 ha に対して 3 ha しか無いので、
        # 明示しないと「点群で高精度に見た結果」が全域に効いているように読める
        "pointcloud_coverage": pc_coverage(),
        # 起動時に出す断面。天端を横切る線を解析側で決める（scripts/87）
        "default_section": default_section(),
        "totals_bytes": {
            "tiles": dir_bytes("tiles"),
            "3dtiles": dir_bytes("3dtiles"),
            "pointcloud": dir_bytes("pointcloud"),
            "semantics": (WEB_DATA / semantics_name).stat().st_size,
        },
        "analysis_summary": {
            "features": summary["features"],
            "per_water_level": {
                k: {"n_changed": v["n_changed"]}
                for k, v in summary["per_water_level"].items()
            },
            "go_no_go": summary["go_no_go"]["result"],
        },
        "attribution": ATTRIBUTION,
    }
    catalog["totals_bytes"]["all"] = sum(
        v for k, v in catalog["totals_bytes"].items() if k != "all")

    cp = WEB_DATA.parent / "data" / "catalog.json"
    cp.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    print(json.dumps({"geoid_m": catalog["vertical"]["geoid_undulation_m"],
                      "totals_MB": {k: round(v / 1e6, 2)
                                    for k, v in catalog["totals_bytes"].items()}},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
