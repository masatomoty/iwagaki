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

from iwagaki.config import (AOI, AOI_LABELS, AOIS, ATTRIBUTION_RAILWAY, asset_name, catalog_name,
                            CRS_ANALYSIS, DEFAULT_AOI, H_MAX, H_MIN, H_STEP, OUT, RAW,
                            FLOOR_ABOVE_DEPTH, REPRESENTATIVE_H, ROAD_DEPTH_CLASSES,
                            TP_OF_MSL,
                            WEB_DATA, ATTRIBUTION)
from iwagaki.versioning import publish_dir, publish_file

KEEP_PROPS = [
    "gml_id", "feature_type", "name", "class", "usage", "area_m2",
    "section_type", "section_type_label", "water_fraction",
    "unreliable", "unreliable_reason",
    # 4 条件すべて。以前は baseline / highres だけで、点群融合地形での
    # 判定を地物単位で見られなかった（docs/todo.md A2）
    "ground_elev_baseline", "ground_elev_highres",
    "ground_elev_control", "ground_elev_pointcloud", "ground_elev_drainage",
    "h_conn_baseline", "h_conn_highres",
    "h_conn_control", "h_conn_pointcloud", "h_conn_drainage",
    "delta_ground_elev", "delta_h_conn",
    # 交通規制モード。**走行波リスクの間接指標**なので viewer にも渡す（scripts/50,91）
    "nearest_building_m", "frontage_building_count_2m",
    "frontage_building_count_5m", "frontage_building_count_10m",
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
    # **点群は吉原にしか無い。** `pc_coverage-*.geojson` は共有ディレクトリに
    # 1 枚だけ置いてあるので、範囲を見ないとほかの範囲まで吉原の輪郭を指してしまう
    if AOI.name != DEFAULT_AOI:
        return {}
    p = WEB_DATA / "pc_coverage.geojson"
    if not p.exists() and not list(WEB_DATA.glob("pc_coverage-*.geojson")):
        return {}
    name = publish_file(p)
    q = WEB_DATA / name
    props = json.loads(q.read_text())["features"][0]["properties"]
    return {"url": f"data/{name}", "bytes": q.stat().st_size, **props}


def railway() -> dict:
    """`scripts/12` が切り出した線路。無ければ空で返す。

    **PLATEAU 舞鶴市に鉄道は無い**ので、これだけ国土数値情報 (N02) 由来である
    （`scripts/12_fetch_railway.py`）。AOI に線路が無い範囲（吉原 100 ha）では
    ファイルごと置いていないので、ここも空になる。
    """
    p = WEB_DATA / asset_name("railway.geojson")
    stem = p.stem
    if not p.exists() and not list(WEB_DATA.glob(f"{stem}-*.geojson")):
        return {}
    name = publish_file(p)
    q = WEB_DATA / name
    props = json.loads(q.read_text(encoding="utf-8"))["properties"]
    return {"url": f"data/{name}", "bytes": q.stat().st_size,
            "length_m": props["length_m"], "lines": props["lines"],
            "source": props["source"]}


def tide_series() -> dict:
    """`scripts/86` が取得できた潮位時系列だけを配信物に載せる。

    検潮場は範囲に依らないが、**取得失敗は黙って曲線を足さない**。
    viewer は `series` が空のときに再生 UI ごと出さない。
    """
    files = sorted(OUT.glob("tide_series_*.json"))
    if not files:
        return {}
    entries = []
    for src in files:
        body = json.loads(src.read_text())
        dst = WEB_DATA / asset_name(src.name)
        dst.write_bytes(src.read_bytes())
        name = publish_file(dst)
        published = WEB_DATA / name
        entries.append({
            "id": body["id"], "label": body["label"], "kind": body["kind"],
            "url": f"data/{name}", "bytes": published.stat().st_size,
            "peak_time": body["peak_time"],
            "peak_value_m_tp": body["peak_value_m_tp"],
        })
    # 観測があればそちらを既定にする。天文潮は「気象擾乱が無い比較」用。
    observed = [e for e in entries if e["kind"] == "observed"]
    default = (observed if observed else entries)[0]["id"]
    return {"series": entries, "default": default}


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
        # ディレクトリ名は範囲で分かれている（`config.asset_name`）が、
        # **catalog のキーは条件名のまま**にする。viewer が `terrain.highres` で
        # 引いているので、ここを範囲ごとに変えると読み側が範囲を知る必要が出る
        name = publish_dir(WEB_DATA / "tiles", asset_name(cond))
        meta["url"] = f"data/tiles/{name}/{{z}}/{{x}}/{{y}}.png"
    for key, meta in (tiles3d or {}).items():
        if not isinstance(meta, dict) or "url" not in meta:
            continue
        # url は "data/3dtiles/<名前>/tileset.json"。<名前> だけを付け替える
        base = str(meta["url"]).split("/")[2].rsplit("-", 1)[0]
        name = publish_dir(WEB_DATA / "3dtiles", base)
        meta["url"] = f"data/3dtiles/{name}/tileset.json"


def write_areas_index() -> None:
    """
    範囲の索引 `data/areas.json`。**viewer の入口はここ**（無ければ
    `data/catalog.json` だけの単一範囲として動く = 旧配信物との互換）。

    ディスクにある catalog を数えるだけにしてある。範囲を 1 つだけ焼き直しても
    索引が壊れない（`AOIS` を素直に並べると、まだ焼いていない範囲を指してしまう）。
    """
    areas = []
    for name in AOIS:
        fn = "catalog.json" if name == DEFAULT_AOI else f"catalog-{name}.json"
        if not (WEB_DATA / fn).exists():
            continue
        cat = json.loads((WEB_DATA / fn).read_text())
        areas.append({
            "id": name,
            "label": AOI_LABELS.get(name, name),
            "catalog": f"data/{fn}",
            "bbox_wgs84": cat["aoi"]["bbox_wgs84"],
            "centre_wgs84": cat["aoi"]["centre_wgs84"],
            "area_ha": round(
                (AOIS[name].xmax - AOIS[name].xmin)
                * (AOIS[name].ymax - AOIS[name].ymin) / 10_000, 1),
            "conditions": sorted(cat.get("terrain", {})),
            "has_pointcloud": bool(cat.get("pointcloud")),
        })
    (WEB_DATA / "areas.json").write_text(
        json.dumps({"default": DEFAULT_AOI, "areas": areas},
                   indent=2, ensure_ascii=False))
    print("areas.json:", " / ".join(f"{a['id']}({a['area_ha']} ha)" for a in areas))


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

    # --- 起動時の注視点 ---------------------------------------------------
    #
    # **AOI の中心ではない。** 625 ha の矩形の真ん中は港と山に落ちるので、
    # 起動直後の画面に市街が入らない（実測: 東舞鶴で市街が画面の隅に来た）。
    #
    # 低平な建物の位置の中央値を使う。**浸水の話が起きるのはそこ**であり、
    # 山手の建物に引っ張られない（平均ではなく中央値にしている理由）。
    # 座標は viewer に埋め込まず catalog 経由で渡す（`default_section` と同じ方針）。
    low = []
    for f in feats:
        if f["properties"].get("feature_type") != "bldg:Building":
            continue
        g = f["properties"].get("ground_elev_highres")
        if g is None or g > 5.0:
            continue
        ring = (f["geometry"]["coordinates"][0] if f["geometry"]["type"] == "Polygon"
                else f["geometry"]["coordinates"][0][0])
        low.append((sum(c[0] for c in ring) / len(ring),
                    sum(c[1] for c in ring) / len(ring)))
    focus = None
    if low:
        lons = sorted(c[0] for c in low)
        lats = sorted(c[1] for c in low)
        focus = [round(lons[len(lons) // 2], 7), round(lats[len(lats) // 2], 7)]
        print(f"focus_wgs84: {focus}  （標高 5 m 以下の建物 {len(low)} 棟の中央値）")
    op = WEB_DATA / asset_name("objects.geojson")
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

    tiles = load(asset_name("tiles_report.json"))
    tiles3d = load(asset_name("3dtiles_report.json"))
    # 点群は吉原にしか無い。ほかの範囲では接頭辞付きのレポートが無いので空になる
    pc = load(asset_name("pointcloud_report.json"))
    # 内容ハッシュを URL に入れる（immutable キャッシュを差し替えられるように）
    versioned_urls(tiles, tiles3d)
    summary = json.loads((OUT / "summary.json").read_text())
    tide_path = OUT / "tide_levels.json"
    tide = json.loads(tide_path.read_text()) if tide_path.exists() else None

    def dir_bytes(rel: str) -> int:
        """この範囲の配信物だけを数える。`tiles/` には全範囲が並んでいる。"""
        d = WEB_DATA / rel
        if not d.exists():
            return 0
        pre = "" if AOI.name == DEFAULT_AOI else f"{AOI.name}_"
        total = 0
        for sub in d.iterdir():
            # `data/pointcloud/` は直下に COPC ファイルが並ぶ。**点群は吉原だけ**なので、
            # 既定範囲のときだけ数える（ほかの範囲で数えると 272 MB を二重に載せる）
            if sub.is_file():
                if not pre:
                    total += sub.stat().st_size
                continue
            # 既定範囲は接頭辞が無いので、**ほかの範囲の接頭辞で始まるものを外す**
            if pre:
                if not sub.name.startswith(pre):
                    continue
            elif any(sub.name.startswith(f"{a}_") for a in AOIS if a != DEFAULT_AOI):
                continue
            total += sum(f.stat().st_size for f in sub.rglob("*") if f.is_file())
        return total

    catalog = {
        "version": 1,
        "aoi": {
            "name": AOI.name,
            "bounds_epsg6674": list(AOI.bounds),
            "bbox_wgs84": [round(v, 7) for v in bbox],
            "centre_wgs84": [round(centre[0], 7), round(centre[1], 7)],
            "local_origin_wgs84": [round(centre[0], 7), round(centre[1], 7)],
            # 起動時の注視点。**矩形の中心ではなく低平な市街**（上記）
            **({"focus_wgs84": focus} if focus else {}),
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
            # **取得できた時系列だけ**。空なら viewer は再生 UI を出さない
            **({"tide_series": series} if (series := tide_series()) else {}),
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
            # 床上浸水とみなす浸水深。**地盤面からの水深**の閾値で、
            # PLATEAU LOD1 は床高を持たないので床面を超えた証明ではない。
            # 市の要望（2026-08）が 50 cm 基準だった
            "floor_above_depth_m": FLOOR_ABOVE_DEPTH,
            # 実際に出現したコードだけ載せる。viewer の凡例はこれを引く
            "codelists": codelists,
        },
        # 点群が地表面として効いている範囲。AOI 100 ha に対して 3 ha しか無いので、
        # 明示しないと「点群で高精度に見た結果」が全域に効いているように読める
        **({"pointcloud_coverage": pc_coverage()} if pc_coverage() else {}),
        # 市が「東側をここまで」と指した基準線そのもの（`docs/todo.md`）。
        # 線路が AOI に掛からない範囲では鍵ごと落とす
        **({"railway": railway()} if railway() else {}),
        # 起動時に出す断面。天端を横切る線を解析側で決める（scripts/87）。
        # **空なら鍵ごと落とす。** `{}` を置くと読み側で truthy になり、
        # `default_section.from[0]` で落ちる（面的表示用の範囲で実際に落ちた）
        **({"default_section": default_section()} if default_section() else {}),
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
        # **使ったデータの出典だけを並べる。** 線路が掛からない範囲では N02 を足さない
        "attribution": ATTRIBUTION + ([ATTRIBUTION_RAILWAY] if railway() else []),
    }
    catalog["totals_bytes"]["all"] = sum(
        v for k, v in catalog["totals_bytes"].items() if k != "all")

    cp = WEB_DATA / catalog_name()
    cp.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    write_areas_index()
    print(json.dumps({"geoid_m": catalog["vertical"]["geoid_undulation_m"],
                      "totals_MB": {k: round(v / 1e6, 2)
                                    for k, v in catalog["totals_bytes"].items()}},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
