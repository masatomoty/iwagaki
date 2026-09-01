#!/usr/bin/env python3
"""任意地点から道路ネットワーク上の徒歩圏（等時線）を単純バッファと併置する。

複数自治体（京都市・さいたま市）からの周辺分析の要望 T2（`docs/todo.md`）:
T1（任意地点＋半径）の単純バッファに対し、**道路ネットワーク上の等時線**を
別レイヤーで重ねて「道でつながっていない土地」の乖離を見せる。

入力
----
既定は `data/out/{aoi}/objects.geojson` の ``feature_type == "tran:Road"``（EPSG:6674）。
**PLATEAU 舞鶴市の道路は車道の面（`lod1MultiSurface`）だけ**で中心線ネットワークが
無いので、道路面ポリゴンの隣接からグラフを組む（`src/iwagaki/road_graph.py`）。
**`tran:Road` は全部使う。** 橋梁・高架橋・アンダーパス・トンネル（`scripts/50` が
浸水深の信頼性で立てる ``unreliable``）も**歩行者は通れる経路**で、これを外すと
JR 線路をまたぐ立体交差が落ちてグラフが南北に割れる [実測]。浸水深の判定では
ないので信頼性フラグは無視する。``--drop-grade-separated`` で外せる。

`--from-raw` を付けると `data/raw/plateau/*_tran_*.gml` を直接読む（`scripts/11` が
取得済みのもの）。地形パイプライン（`scripts/20`〜`50`、PLATEAU の 748 MB `dem`
メンバー）を通さずに道路グラフだけ回せる。

出力（`data/out/{aoi}/` 直下、`scripts/91` の命名に倣う。**ファイルのみ**。
viewer 表示は別 PR）
----
* ``walk_isochrone_{lon}_{lat}_{minutes}min.geojson``
  （EPSG:4326、FeatureCollection に 2 面）
    * ``layer == "network_isochrone"`` … 道路ネットワーク上の到達圏
    * ``layer == "simple_buffer"``      … 同じ距離の単純バッファ（半径 = 分 × 速度）
* ``walk_isochrone_summary.json``（起点・パラメータ・面積・乖離）

**注意（この出力の限界。properties と docs にも入れる）**

* PLATEAU の道路網は**車道中心線**であって**公式の歩行者網ではない**。
  一方通行・歩道橋・地下道・私道・歩車分離を区別しない。
  ネットワークの妥当性は未検証（[仮説]。OSM 照合は未実施）。
* **AOI 内でのみ有効。** 起点が AOI 外なら空を返す。道路グラフの端で等時線も切れる。
* 歩行速度は一定（80 m/分＝『都市構造評価ハンドブック』の徒歩圏の前提）。
  信号待ち・勾配・混雑を含まない。
* 代表点どうしを結ぶグラフなので経路長は真の中心線より数 % 長め＝等時線は
  内側に安全側へずれる。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import transform as shp_transform
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, AOI_LABELS, CRS_ANALYSIS, CRS_LONLAT, OUT,
                            PLATEAU_MEMBERS, RAW)
from iwagaki.road_graph import (WALK_SPEED_M_PER_MIN, DEFAULT_EDGE_BUFFER_M,
                                DEFAULT_TOUCH_TOL_M, connected_components,
                                graph_from_road_polygons, walk_isochrone)

#: 起点が道路からこれ以上離れていたら「ネットワーク上に無い」とみなして空を返す [m]。
MAX_SNAP_M = 150.0

#: 路面が地表面と一致しない構造（`scripts/50` の SECTION_TYPE_NOT_ON_GROUND と同じ）。
#: 2 高架橋 / 3 橋梁 / 5 アンダーパス / 6 トンネル
SECTION_TYPE_NOT_ON_GROUND = {"2", "3", "5", "6"}

NOT_OFFICIAL_NOTE = (
    "PLATEAU の車道中心線ベース。公式の歩行者網ではない"
    "（一方通行・歩道橋・地下道・私道・歩車分離を区別しない）。妥当性は未検証"
)
AOI_ONLY_NOTE = "AOI 内でのみ有効。道路グラフの端で等時線も切れる"


def load_road_polygons(aoi_name: str, drop_grade_separated: bool) -> list:
    """objects.geojson から道路面ポリゴンを読む（EPSG:6674 のまま）。"""
    path = OUT / "objects.geojson"
    if not path.exists():
        raise SystemExit(f"入力がありません: {path}")
    data = json.loads(path.read_text())
    if data.get("crs", {}).get("properties", {}).get("name") != "EPSG:6674":
        raise SystemExit(f"{path}: CRS が EPSG:6674 ではありません")
    polys = []
    for feature in data.get("features", []):
        p = feature.get("properties", {})
        if str(p.get("feature_type", "")) != "tran:Road":
            continue
        if drop_grade_separated and (
            str(p.get("section_type") or "") in SECTION_TYPE_NOT_ON_GROUND
        ):
            continue
        geom = shape(feature.get("geometry"))
        if geom.is_empty:
            continue
        polys.extend(_iter_polygons(geom))
    return polys


def _iter_polygons(geom):
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type == "MultiPolygon":
        yield from geom.geoms


def load_road_polygons_from_raw(drop_grade_separated: bool) -> list:
    """`data/raw/plateau/*_tran_*.gml` を直接読んで道路面を EPSG:6674 で返す。"""
    from iwagaki.citygml import parse_roads

    tf = Transformer.from_crs(CRS_LONLAT, CRS_ANALYSIS, always_xy=True)
    back = Transformer.from_crs(CRS_ANALYSIS, CRS_LONLAT, always_xy=True)
    lon0, lat0 = back.transform(AOI.xmin, AOI.ymin)
    lon1, lat1 = back.transform(AOI.xmax, AOI.ymax)
    bbox = (lon0, lat0, lon1, lat1)
    clip = Polygon([(AOI.xmin, AOI.ymin), (AOI.xmax, AOI.ymin),
                    (AOI.xmax, AOI.ymax), (AOI.xmin, AOI.ymax)])

    polys = []
    for member in PLATEAU_MEMBERS["tran"]:
        path = RAW / "plateau" / Path(member).name
        if not path.exists():
            raise SystemExit(f"入力がありません: {path}（先に scripts/11_fetch_plateau.py）")
        for road in parse_roads(path, bbox):
            if (drop_grade_separated
                    and (road.get("section_type") or "") in SECTION_TYPE_NOT_ON_GROUND):
                continue
            rings = []
            for xy in road["rings"]:
                x, y = tf.transform(xy[:, 0], xy[:, 1])
                p = Polygon(np.column_stack([x, y]))
                if not p.is_valid:
                    p = p.buffer(0)
                if not p.is_empty and p.area > 0:
                    rings.append(p)
            if not rings:
                continue
            g = unary_union(rings).intersection(clip)
            if g.is_empty or g.area < 1.0:
                continue
            polys.extend(_iter_polygons(g))
    return polys


def _feature(geom_ll, layer: str, props: dict) -> dict:
    return {
        "type": "Feature",
        "geometry": None if geom_ll is None or geom_ll.is_empty else mapping(geom_ll),
        "properties": {"layer": layer, **props},
    }


def build(
    aoi_name: str,
    lon: float,
    lat: float,
    minutes: float,
    speed: float,
    edge_buffer_m: float,
    drop_grade_separated: bool,
    from_raw: bool = False,
) -> tuple[dict, dict]:
    """(FeatureCollection, summary dict) を組む。"""
    fwd = Transformer.from_crs("EPSG:4326", "EPSG:6674", always_xy=True)
    inv = Transformer.from_crs("EPSG:6674", "EPSG:4326", always_xy=True)
    x, y = fwd.transform(lon, lat)
    max_cost = minutes * speed

    common = {
        "aoi": aoi_name,
        "aoi_label": AOI_LABELS.get(aoi_name, aoi_name),
        "origin_lon": round(lon, 7),
        "origin_lat": round(lat, 7),
        "minutes": minutes,
        "walk_speed_m_per_min": speed,
        "reach_distance_m": round(max_cost, 1),
        "not_official_pedestrian_network": NOT_OFFICIAL_NOTE,
        "valid_in_aoi_only": AOI_ONLY_NOTE,
    }

    x0, y0, x1, y1 = AOI.bounds
    inside_aoi = x0 <= x <= x1 and y0 <= y <= y1
    summary: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **common,
        "inside_aoi": inside_aoi,
    }

    if not inside_aoi:
        summary["status"] = "outside_aoi"
        fc = {
            "type": "FeatureCollection",
            "name": f"walk_isochrone_{minutes:g}min",
            "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
            "metadata": {**common, "status": "起点が AOI 外。空を返す"},
            "features": [
                _feature(None, "network_isochrone", {"status": "outside_aoi"}),
                _feature(None, "simple_buffer", {"status": "outside_aoi"}),
            ],
        }
        return fc, summary

    polys = (load_road_polygons_from_raw(drop_grade_separated) if from_raw
             else load_road_polygons(aoi_name, drop_grade_separated))
    summary["road_source"] = "raw_citygml" if from_raw else "objects.geojson"
    if not polys:
        raise SystemExit(f"{aoi_name}: 道路が 1 件も読めませんでした")
    graph = graph_from_road_polygons(polys)
    comps = connected_components(graph)
    largest_frac = len(comps[0]) / graph.n_nodes
    frag_note = (
        f"道路グラフは {len(comps)} 連結成分（最大成分が全ノードの "
        f"{round(largest_frac * 100)}%）。PLATEAU の道路面は交差点で切れているため "
        f"{DEFAULT_TOUCH_TOL_M:g} m 橋渡ししてつないでいる。等時線は起点の成分内で"
        "完結するので実際の徒歩圏より小さめ＝安全側に出る"
    )
    result = walk_isochrone(graph, (x, y), max_cost, edge_buffer_m)

    snap_ok = result.snap_distance_m <= MAX_SNAP_M
    net_ll = shp_transform(inv.transform, result.network_polygon) if snap_ok else None
    buf_ll = shp_transform(inv.transform, result.simple_buffer)

    # 面積は投影 CRS（メートル）で測る
    net_area = result.network_polygon.area if snap_ok else 0.0
    buf_area = result.simple_buffer.area
    coverage = round(net_area / buf_area, 4) if buf_area else 0.0

    summary.update({
        "status": "ok" if snap_ok else "no_nearby_road",
        "road_polygon_count": len(polys),
        "graph_nodes": graph.n_nodes,
        "graph_edges": graph.n_edges,
        "graph_components": len(comps),
        "largest_component_frac": round(largest_frac, 3),
        "network_fragmentation_note": frag_note,
        "snap_distance_m": round(result.snap_distance_m, 2),
        "max_snap_m": MAX_SNAP_M,
        "reached_node_count": result.reached_node_count,
        "network_area_m2": round(net_area, 1),
        "simple_buffer_area_m2": round(buf_area, 1),
        "network_over_buffer_ratio": coverage,
        "gap_note": (
            "単純バッファのうちネットワークで届かない面（道でつながっていない土地）が "
            f"{round((1 - coverage) * 100, 1)}%"
            if snap_ok else "起点付近に道路が無く等時線を出せない"
        ),
        "drop_grade_separated": drop_grade_separated,
        "edge_buffer_m": edge_buffer_m,
    })

    fc = {
        "type": "FeatureCollection",
        "name": f"walk_isochrone_{minutes:g}min",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "metadata": {
            **common,
            "model": "多始点 Dijkstra（道路面ポリゴンの隣接グラフ）",
            "edge_buffer_m": edge_buffer_m,
            "snap_distance_m": round(result.snap_distance_m, 2),
            "network_over_buffer_ratio": coverage,
            "graph_components": len(comps),
            "network_fragmentation_note": frag_note,
        },
        "features": [
            _feature(net_ll, "network_isochrone", {
                "status": "ok" if snap_ok else "no_nearby_road",
                "reached_node_count": result.reached_node_count,
                "area_m2": round(net_area, 1),
                "snap_distance_m": round(result.snap_distance_m, 2),
            }),
            _feature(buf_ll, "simple_buffer", {
                "status": "ok",
                "radius_m": round(max_cost, 1),
                "area_m2": round(buf_area, 1),
            }),
        ],
    }
    return fc, summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lon", type=float, help="起点の経度（EPSG:4326）")
    ap.add_argument("--lat", type=float, help="起点の緯度（EPSG:4326）")
    ap.add_argument("--minutes", type=float, default=10.0, help="徒歩の分数（既定 10）")
    ap.add_argument("--speed-m-min", type=float, default=WALK_SPEED_M_PER_MIN,
                    help=f"歩行速度 [m/分]（既定 {WALK_SPEED_M_PER_MIN:g}）")
    ap.add_argument("--edge-buffer-m", type=float, default=DEFAULT_EDGE_BUFFER_M,
                    help=f"到達エッジをふくらませる片幅 [m]（既定 {DEFAULT_EDGE_BUFFER_M:g}）")
    ap.add_argument("--drop-grade-separated", action="store_true",
                    help="橋梁・高架橋・アンダーパス・トンネルをグラフから外す"
                         "（既定は入れる。歩行者は通れるうえ、外すと立体交差で網が割れる）")
    ap.add_argument("--from-raw", action="store_true",
                    help="objects.geojson でなく data/raw/plateau の tran GML を直接読む")
    ap.add_argument("--dry-run", action="store_true",
                    help="グラフ・等時線の自己確認だけ行い、ファイルは書かない")
    args = ap.parse_args()

    if args.dry_run:
        return _selfcheck()
    if args.lon is None or args.lat is None:
        ap.error("--lon と --lat は必須です（--dry-run のとき以外）")

    fc, summary = build(AOI.name, args.lon, args.lat, args.minutes,
                        args.speed_m_min, args.edge_buffer_m, args.drop_grade_separated,
                        from_raw=args.from_raw)

    OUT.mkdir(parents=True, exist_ok=True)
    tag = f"{args.lon:.5f}_{args.lat:.5f}_{args.minutes:g}min"
    gj_path = OUT / f"walk_isochrone_{tag}.geojson"
    gj_path.write_text(json.dumps(fc, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path = OUT / "walk_isochrone_summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                            encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"wrote {gj_path}")
    print(f"wrote {summary_path}")
    return 0


def _selfcheck() -> int:
    """objects.geojson が無くても回る最小の自己確認（格子状の合成道路）。"""
    from iwagaki.road_graph import (dijkstra, graph_from_polylines, nearest_node,
                                    reached_nodes)

    step, n = 100.0, 10  # 0..9 の格子、間隔 100 m
    grid = np.arange(n) * step
    lines = []
    for i in range(n):
        lines.append(np.column_stack([np.full(n, i * step), grid]))  # 縦線
        lines.append(np.column_stack([grid, np.full(n, i * step)]))  # 横線
    graph = graph_from_polylines(lines)

    speed, minutes = WALK_SPEED_M_PER_MIN, 10.0
    max_cost = speed * minutes  # 800 m
    origin = (0.0, 0.0)
    src, _ = nearest_node(graph, origin)
    dist = dijkstra(graph, [(src, 0.0)], max_cost)

    reached = {tuple(np.round(graph.nodes[k] / step).astype(int)) for k in
               reached_nodes(dist, max_cost)}
    expected = {(i, j) for i in range(n) for j in range(n) if (i + j) * step <= max_cost}
    ok = reached == expected
    print(f"[{'ok' if ok else 'NG'}] 到達ノード {len(reached)} 個 "
          f"(期待 {len(expected)} = i+j<=8)")

    res = walk_isochrone(graph, origin, max_cost)
    smaller = res.network_polygon.area < res.simple_buffer.area
    print(f"[{'ok' if smaller else 'NG'}] ネットワーク等時線 "
          f"{res.network_polygon.area:,.0f} m² < 単純バッファ "
          f"{res.simple_buffer.area:,.0f} m²（回り道ぶん）")

    contained = res.network_polygon.difference(
        res.simple_buffer.buffer(DEFAULT_EDGE_BUFFER_M + 1e-6)).area < 1.0
    print(f"[{'ok' if contained else 'NG'}] ネットワーク等時線 ⊆ 単純バッファ")

    return 0 if (ok and smaller and contained) else 1


if __name__ == "__main__":
    raise SystemExit(main())
