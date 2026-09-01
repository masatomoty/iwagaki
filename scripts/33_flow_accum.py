#!/usr/bin/env python3
"""地表流の集中（flow accumulation）と窪地構造を静的ラスタとして焼く。

外部プロダクト FARR（mite-shiru 社）と同じ土俵。DEM だけから

  - 窪地充填（Priority-Flood + ε）とその副産物: 充填深・越流点標高・容積
  - flow accumulation（D8, 一様単位降雨）: 「水みち」ラスタ
  - 潮位に依らない窪地マップ: ローカル最小 + 集水 + 充填深 + 越流点

を条件（baseline / control / highres / pointcloud）ごとに出す。手法は
`src/iwagaki/flow.py`、出典・根拠区分は `docs/data.md`「地表流の集中と窪地構造」。

**潮位に依存しない静的セル値**なので `h_conn` と同じ扱い（1 回焼く・再計算なし）。
**浸水判定には混ぜない**（`docs/design.md`「モデルは分離可能に保つ」）。別レイヤ。

画面（Web タイル・viewer）は別 PR。ここはファイルと確認用の図だけ
（`scripts/88` / `scripts/91` / `scripts/13+92` と同じ立て付け）。
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, CRS_ANALYSIS, FLOW_BASIN_CHANNEL_MIN_AREA_M2,
                            FLOW_BASIN_MAX_COUNT, FLOW_BASIN_MIN_AREA_M2,
                            FLOW_BASIN_SIMPLIFY_M, FLOW_COLLAR_M, FLOW_METHOD,
                            FLOW_POUR_POINT_MAX_COUNT,
                            FLOW_POUR_POINT_MIN_AREA_M2, OUT, RES_COARSE,
                            RES_HIGHRES, ROOT, asset_name)
from iwagaki.flow import (edge_truncated_fraction, label_pits, pit_records,
                          priority_flood_fill, route_with_collar,
                          top_pits_by_area)
from iwagaki.gsi_dem import GsiTilesUnavailable
from iwagaki.gsi_dem import collar_dem as gsi_collar_dem
from iwagaki.raster import Grid, read, write

# scripts/30_flood.py の CONDITIONS と同じ（同一グリッド思想）。
CONDITIONS: dict[str, tuple[str, float]] = {
    "baseline": ("dtm_baseline_500.tif", RES_COARSE),
    "control": ("dtm_control_500.tif", RES_COARSE),
    "highres": ("dtm_highres_050.tif", RES_HIGHRES),
    # 実点群を融合した地形（scripts/19）。ファイルが無ければ黙って飛ばす
    "pointcloud": ("dtm_pointcloud_050.tif", RES_HIGHRES),
}

#: 充填深がこれ以下のセルは窪地に数えない（ε 充填の ULP 積み上がり・float32 往復対策）
MIN_PIT_DEPTH_M = 0.01

#: ルーティング法。`IWAGAKI_FLOW_METHOD` で上書き（`IWAGAKI_FLOW_COLLAR` に倣う）
FLOW_METHOD_USED = os.environ.get("IWAGAKI_FLOW_METHOD", FLOW_METHOD)

_METHOD_LABEL = {
    "dinf": "D-infinity flow accumulation（Tarboton 1997, 一様単位降雨。1 セル最大 2 方向へ角度按分）",
    "d8": "D8 flow accumulation（O'Callaghan & Mark 1984, 一様単位降雨。1 セル 1 方向）",
}

METHOD = (
    "Priority-Flood + ε 窪地充填（Barnes, Lehman & Yatheendradas 2014）／"
    f"{_METHOD_LABEL.get(FLOW_METHOD_USED, FLOW_METHOD_USED)}。"
    "実装 src/iwagaki/flow.py（純 numpy/scipy、依存追加なし）。"
    "D8 API は比較用に残してある（IWAGAKI_FLOW_METHOD=d8）"
)
_ROUTING_CAVEAT = {
    "dinf": "flow accumulation は D-infinity（Tarboton 1997。最急降下 facet を挟む 2 隣接へ角度按分）。"
            "尾根の分岐は D8 より滑らか",
    "d8": "flow accumulation は D8（1 セル 1 方向）。D-infinity ではないので尾根の分岐が粗い",
}
CAVEATS = [
    "一様降雨・地形のみ。実際の降雨分布・地表被覆・浸透・管路・時間発展は含まない",
    _ROUTING_CAVEAT.get(FLOW_METHOD_USED, _ROUTING_CAVEAT["dinf"]),
    "nodata（京都府 DEM では主に開放水面）と AOI 外周を流出先とする。"
    "集水域が collar の外周で切れているセルは edge_truncated_fraction で示す",
    "ルーティングは AOI 外周に GSI 5m DEM（DEM5A、穴は DEM10B）の collar 帯を "
    f"{FLOW_COLLAR_M:.0f} m 幅で張ってから回す。collar はルーティング専用で、"
    "窪地の充填深・越流点・容積は AOI 内のセルだけ集計する。collar が取得できない"
    "場合は collar 無しで続行し collar_used=false になる（docs/data.md §7）",
    "潮位に依存しない静的ラスタ。浸水判定（h_conn）には混ぜていない（別オーバーレイ）",
]


def _route(name: str, arr: np.ndarray, res: float):
    """collar 付きでルーティングする。collar が取れなければ collar 無しに落とす。

    返り値: `(CollarRouting, meta)`。`meta` は collar の諸元
    （`docs/data.md` §7、`flow_accum_summary.json`）。
    """
    collar_m = float(os.environ.get("IWAGAKI_FLOW_COLLAR", FLOW_COLLAR_M))
    h, w = arr.shape
    c = int(round(collar_m / res)) if collar_m > 0 else 0
    meta = {"collar_m": 0.0, "collar_cells": 0, "collar_used": False,
            "collar_ring_coverage": 0.0}
    # 部分流域の分割（「クリックで集水域抽出」用）は collar グリッドで解いて AOI に
    # clip する（`route_with_collar` の `want_basins`）。D-infinity のときだけ。
    cell_area = res * res
    bkw = dict(
        want_basins=FLOW_METHOD_USED == "dinf",
        basin_channel_min_accum=FLOW_BASIN_CHANNEL_MIN_AREA_M2 / cell_area,
        basin_min_cells=int(round(FLOW_BASIN_MIN_AREA_M2 / cell_area)),
        basin_max_basins=FLOW_BASIN_MAX_COUNT,
    )
    if c <= 0:
        return route_with_collar(arr, arr, 0, method=FLOW_METHOD_USED, **bkw), meta

    cgrid = Grid.for_aoi(AOI.buffered(collar_m), res)
    if (cgrid.height, cgrid.width) != (h + 2 * c, w + 2 * c):
        raise SystemExit(
            f"{name}: collar グリッド {cgrid.height}x{cgrid.width} が "
            f"{h + 2 * c}x{w + 2 * c} と合わない（res={res}, collar={collar_m}）")
    try:
        gsi = gsi_collar_dem(cgrid)
    except GsiTilesUnavailable as e:
        print(f"  {name}: GSI 標高タイルに届かない（{e}）-> collar 無しで続行")
        return route_with_collar(arr, arr, 0, method=FLOW_METHOD_USED, **bkw), meta
    if not np.isfinite(gsi).any():
        print(f"  {name}: collar 帯に有効な標高が無い（範囲がすべて海／配信外）"
              " -> collar 無しで続行")
        return route_with_collar(arr, arr, 0, method=FLOW_METHOD_USED, **bkw), meta

    ring = np.ones(gsi.shape, dtype=bool)
    ring[c:c + h, c:c + w] = False
    meta.update(collar_m=collar_m, collar_cells=c, collar_used=True,
                collar_ring_coverage=round(float(np.isfinite(gsi[ring]).mean()), 4))
    return route_with_collar(arr, gsi, c, method=FLOW_METHOD_USED, **bkw), meta


def _process(name: str, fname: str, res: float) -> dict:
    arr, grid, nodata = read(OUT / fname)
    arr[arr == nodata] = np.nan
    valid = np.isfinite(arr)
    n_valid = int(valid.sum())
    cell_area = grid.cell_area()

    # **窪地の充填・越流点・容積は AOI 内だけで解く**（collar はルーティング専用。
    # collar の地形で AOI 端の窪地の充填深まで変わると「collar 帯のセルはカウント
    # しない」の趣旨から外れる。docs/data.md §7）。
    filled = priority_flood_fill(arr)
    fill_depth = np.where(valid, filled - arr, np.nan)
    # 充填は標高を下げない。ULP 誤差ぶんの負値だけ 0 に丸める
    neg = valid & (fill_depth < 0)
    if neg.any() and float(np.nanmin(fill_depth[neg])) < -1e-6:
        raise SystemExit(f"{name}: fill_depth < 0 が {int(neg.sum())} セル")
    fill_depth = np.where(valid, np.maximum(fill_depth, 0.0), np.nan)

    # ルーティング（flow accumulation と端フラグ）は AOI 外周に GSI 5m DEM の
    # collar 帯を張ってから回し、AOI 矩形に clip する（docs/data.md §7）。
    # collar が取れなければ collar 無しに落ちる（collar_used=false）。
    routing, cmeta = _route(name, arr, res)
    if not routing.conservation_ok:
        raise SystemExit(f"{name}: flow_accum 保存則が破れている（collar グリッド）")
    accum = routing.accum
    term_edge = routing.term_edge

    # collar の前後で edge_truncated_fraction がどう動くか（docs/data.md §7）。
    # collar 無しの ε 充填面（上の `filled`）で端フラグを伝播させる（method は揃える）
    edge_frac_no_collar = (
        round(edge_truncated_fraction(filled, method=FLOW_METHOD_USED), 4)
        if cmeta["collar_used"] and n_valid else None)

    pit_id, n_pits = label_pits(fill_depth, MIN_PIT_DEPTH_M)
    # 越流点セルは viewer が出す上位の窪地だけ計算する（highres で 5〜7 万個あり、
    # 全部回すと遅い）。`_write_pour_points` と同じ絞り
    pour_for = top_pits_by_area(pit_id, FLOW_POUR_POINT_MIN_AREA_M2, cell_area,
                                FLOW_POUR_POINT_MAX_COUNT) if n_pits else None
    pits = pit_records(pit_id, fill_depth, filled, arr, cell_area, pour_for=pour_for)
    for p in pits:
        if p.spill_elev_m_tp + 1e-3 < p.max_ground_elev_m_tp:
            raise SystemExit(
                f"{name}: 窪地 {p.pit_id} の越流点 {p.spill_elev_m_tp} < "
                f"窪地内最大標高 {p.max_ground_elev_m_tp}")

    spill_elev = np.where(fill_depth > MIN_PIT_DEPTH_M, filled, nodata)
    write(OUT / f"fill_depth_{name}.tif", np.where(valid, fill_depth, nodata), grid, nodata)
    write(OUT / f"spill_elev_{name}.tif", spill_elev, grid, nodata)
    write(OUT / f"flow_accum_{name}.tif", np.where(valid, accum, nodata), grid, nodata)
    write(OUT / f"pit_id_{name}.tif", np.where(pit_id > 0, pit_id, nodata), grid, nodata)

    edge_frac = float(term_edge[valid].mean()) if n_valid else 0.0
    total_pit_area = round(sum(p.area_m2 for p in pits), 2)
    total_pit_vol = round(sum(p.volume_m3 for p in pits), 2)
    max_fill = round(max((p.max_fill_depth_m for p in pits), default=0.0), 3)

    if edge_frac_no_collar is not None:
        ec = f"{edge_frac_no_collar * 100:.1f}%->{edge_frac * 100:.1f}%"
    else:
        ec = f"{edge_frac * 100:.1f}%  (collar なし)"
    print(f"{name:10s} res={res:>4}  pits={n_pits:4d}  "
          f"pit_area={total_pit_area / 1e4:7.2f} ha  max_fill={max_fill:.2f} m  "
          f"vol={total_pit_vol:11.1f} m3  edge_truncated={ec}")

    (OUT / f"flow_accum_pits_{name}.json").write_text(json.dumps(
        [p.__dict__ for p in pits], indent=2, ensure_ascii=False), encoding="utf-8")
    n_markers = _write_pour_points(name, grid, pits, term_edge)
    n_basins, max_basin_accum_m2 = _write_basins(name, grid, routing.basins, pits)
    n_channels, total_channel_len_m = _write_channels(name, grid, routing.basins)
    print(f"{'':10s} basins={n_basins:4d}  "
          f"max_catchment={max_basin_accum_m2 / 1e4:7.2f} ha  "
          f"channels={n_channels:4d}  total_length={total_channel_len_m / 1e3:6.2f} km")

    return {
        "dtm": fname, "res_m": res, "cells": int(arr.size),
        "valid_cells": n_valid,
        "cell_area_m2": cell_area,
        "basin_count": n_basins,
        "basin_max_catchment_m2": max_basin_accum_m2,
        "basin_channel_min_area_m2": FLOW_BASIN_CHANNEL_MIN_AREA_M2,
        "basin_min_area_m2": FLOW_BASIN_MIN_AREA_M2,
        "pit_count": n_pits,
        "total_pit_area_m2": total_pit_area,
        "total_pit_area_ha": round(total_pit_area / 1e4, 3),
        "total_fill_volume_m3": total_pit_vol,
        "max_fill_depth_m": max_fill,
        "flow_accum_max_cells": int(round(float(np.nanmax(accum)))) if n_valid else 0,
        "flow_accum_max_m2": round(float(np.nanmax(accum)) * cell_area, 1) if n_valid else 0,
        "edge_truncated_fraction": round(edge_frac, 4),
        "edge_truncated_fraction_no_collar": edge_frac_no_collar,
        "collar_m": cmeta["collar_m"],
        "collar_cells": cmeta["collar_cells"],
        "collar_used": cmeta["collar_used"],
        "collar_ring_coverage": cmeta["collar_ring_coverage"],
        "sink_outlet_cells": int(routing.sink_outlet.sum()),
        "edge_outlet_cells": int(routing.edge_outlet.sum()),
        "accum_conservation_ok": routing.conservation_ok,
        "pour_point_markers": n_markers,
        "channel_count": n_channels,
        "channel_total_length_m": round(total_channel_len_m, 1),
    }


def _write_pour_points(name: str, grid, pits: list, term_edge: np.ndarray) -> int:
    """越流点マーカーの GeoJSON（EPSG:6674, Point）。**面積上位の窪地だけ**。

    viewer の「窪地の越流点」レイヤ用（`scripts/83` が WGS84 に起こす）。
    座標は Z に越流点標高を入れて `three/pourPoints.ts` が地形を待たずに置ける
    ようにする（`three/railwayLine.ts` と同じ）。**潮位判定には一切使わない。**
    """
    big = sorted(
        (p for p in pits
         if p.area_m2 >= FLOW_POUR_POINT_MIN_AREA_M2 and p.pour_row >= 0),
        key=lambda p: p.area_m2, reverse=True)[:FLOW_POUR_POINT_MAX_COUNT]
    feats = []
    for p in big:
        x, y = grid.transform * (p.pour_col + 0.5, p.pour_row + 0.5)
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [round(x, 3), round(y, 3),
                                         round(p.spill_elev_m_tp, 3)]},
            "properties": {
                "pit_id": p.pit_id,
                "area_ha": round(p.area_m2 / 1e4, 4),
                "max_fill_depth_m": p.max_fill_depth_m,
                "volume_m3": p.volume_m3,
                "spill_elev_m_tp": p.spill_elev_m_tp,
                "edge_truncated": bool(term_edge[p.pour_row, p.pour_col]),
            },
        })
    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
        "properties": {
            "condition": name,
            "what": "海に通じない窪地の越流点（鞍部）。潮位非依存の原理版",
            "selection": (f"面積 >= {FLOW_POUR_POINT_MIN_AREA_M2:.0f} m² の窪地を"
                          f"面積上位 {FLOW_POUR_POINT_MAX_COUNT} 件まで"),
            "total_pits": len(pits),
        },
        "features": feats,
    }
    (OUT / f"flow_accum_pits_{name}.geojson").write_text(
        json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    return len(feats)


def _round_geom(obj, nd: int = 2):
    if isinstance(obj, (list, tuple)):
        return [_round_geom(x, nd) for x in obj]
    if isinstance(obj, float):
        return round(obj, nd)
    return obj


def _write_basins(name: str, grid, basins, pits: list) -> tuple[int, float]:
    """部分流域ポリゴンの GeoJSON（EPSG:6674, Polygon/MultiPolygon）。

    「クリックで集水域を抽出する」用（`scripts/83` が WGS84 に起こして
    `catalog.flow.basins`）。viewer は `downstream_basin_id` を逆にたどって
    「クリックしたリーフ流域＋その上流の全リーフ」を union する
    （`docs/web_design.md`）。**潮位非依存。浸水判定には混ぜない。**

    - `area_ha` はセル数から出す**厳密値**（単純化ポリゴンの面積ではない）。
      `edge_truncated` の流域では AOI 内に入っているぶんだけ。
    - `max_accum_*` は流域の吐口セルの D-infinity 集水。主 receiver で切った流域境界を
      分流が跨いで出入りするため `area_ha` とは一致しない。collar 込みの値なので、
      `edge_truncated` の流域では AOI 内の `area_ha` より大きくなることもある。
    - `edge_truncated` は集水域が AOI/collar の外へ延びている（切れている）か。
    - 越流点（`_write_pour_points` と同じ窪地）が流域内にあれば `pit_id` /
      `spill_elev_m_tp` を付ける。
    """
    from rasterio.features import shapes as rio_shapes
    from shapely.geometry import mapping
    from shapely.geometry import shape as shp_shape
    from shapely.ops import unary_union

    if basins is None or basins.n_basins == 0:
        fc = {"type": "FeatureCollection",
              "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
              "properties": {"condition": name, "basin_count": 0,
                             "what": "地表流の部分流域（クリックで集水域抽出）"},
              "features": []}
        (OUT / f"flow_basins_{name}.geojson").write_text(
            json.dumps(fc, ensure_ascii=False), encoding="utf-8")
        return 0, 0.0

    lab = np.ascontiguousarray(basins.labels, dtype="int32")
    cell_area = grid.res * grid.res
    counts = np.bincount(lab.reshape(-1), minlength=basins.n_basins + 1)

    # 越流点（面積上位の窪地）が入っている流域に spill 情報を寄せる
    spill_of: dict[int, tuple[int, float, float]] = {}
    for p in pits:
        if p.pour_row < 0:
            continue
        b = int(lab[p.pour_row, p.pour_col])
        if b <= 0:
            continue
        cur = spill_of.get(b)
        if cur is None or p.area_m2 > cur[1]:
            spill_of[b] = (p.pit_id, p.area_m2, p.spill_elev_m_tp)

    geoms: dict[int, list] = {}
    for geom, val in rio_shapes(lab, mask=lab > 0, transform=grid.transform):
        geoms.setdefault(int(val), []).append(shp_shape(geom))

    feats = []
    max_accum_m2 = 0.0
    for b in range(1, basins.n_basins + 1):
        polys = geoms.get(b)
        if not polys:
            continue
        g = unary_union(polys)
        if FLOW_BASIN_SIMPLIFY_M > 0:
            g = g.simplify(FLOW_BASIN_SIMPLIFY_M, preserve_topology=True)
        if g.is_empty:
            continue
        acc_m2 = round(float(basins.max_accum[b]) * cell_area, 1)
        max_accum_m2 = max(max_accum_m2, acc_m2)
        orow, ocol = (int(v) for v in basins.outlet_rc[b])
        props: dict = {
            "basin_id": b,
            "area_ha": round(float(counts[b]) * cell_area / 1e4, 4),
            "max_accum_cells": int(round(float(basins.max_accum[b]))),
            "max_accum_m2": acc_m2,
            "downstream_basin_id": int(basins.downstream[b]),
            "edge_truncated": bool(basins.edge_truncated[b]),
        }
        if orow >= 0:
            ox, oy = grid.transform * (ocol + 0.5, orow + 0.5)
            props["outlet"] = [round(ox, 2), round(oy, 2)]
        if b in spill_of:
            props["pit_id"] = spill_of[b][0]
            props["spill_elev_m_tp"] = spill_of[b][2]
        geom = mapping(g)
        geom["coordinates"] = _round_geom(geom["coordinates"], 2)
        feats.append({"type": "Feature", "geometry": geom, "properties": props})

    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
        "properties": {
            "condition": name,
            "basin_count": len(feats),
            "what": "地表流の部分流域（クリックで集水域抽出）。主 receiver の"
                    "流下木を本流の合流点で切ったリーフ流域。潮位非依存",
            "how": (f"本流閾値 {FLOW_BASIN_CHANNEL_MIN_AREA_M2:.0f} m²、"
                    f"最小流域 {FLOW_BASIN_MIN_AREA_M2:.0f} m²、"
                    f"上限 {FLOW_BASIN_MAX_COUNT} 個、単純化 {FLOW_BASIN_SIMPLIFY_M:.1f} m"),
            "downstream_note": "downstream_basin_id を逆にたどると上流の全リーフ。"
                               "-1 は AOI 内の終端（端流出 or 海）",
        },
        "features": feats,
    }
    (OUT / f"flow_basins_{name}.geojson").write_text(
        json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    return len(feats), max_accum_m2


def _write_channels(name: str, grid, basins) -> tuple[int, float]:
    """流域の**主流路**（吐口→源流のポリライン）の GeoJSON（EPSG:6674, LineString）。

    `flow_basins` が主 receiver の流下木を合流点で切ったリーフごとに、各分岐で
    集水セル数の大きい方だけを選んで遡った 1 本道（`src/iwagaki/flow.py` の
    `main_channel_from_outlet`。断面ツールの自動測線用、`scripts/83` が
    `catalog.flow.channels` にする。**潮位非依存。浸水判定には混ぜない。**

    1 セルしかない（合流点のすぐ下流だけの）リーフは LineString にならないので
    出さない（`_write_basins`・`_write_pour_points` と同じ「絞る」流儀）。

    セル沿いの折れ線は 1 頂点/セルで冗長（highres 0.5m だと長い流路で数百〜数千
    頂点）なので、`FLOW_BASIN_SIMPLIFY_M`（流域ポリゴンと同じ許容量）で単純化する。
    始点・終点（吐口・源流）は Douglas-Peucker で必ず残るので、断面ツールが使う
    2 点はそのまま（`main.ts`）。
    """
    from shapely.geometry import LineString

    if basins is None or basins.n_basins == 0:
        fc = {"type": "FeatureCollection",
              "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
              "properties": {"condition": name, "channel_count": 0,
                             "what": "流域の主流路（断面ツールの自動測線用）"},
              "features": []}
        (OUT / f"flow_channels_{name}.geojson").write_text(
            json.dumps(fc, ensure_ascii=False), encoding="utf-8")
        return 0, 0.0

    feats = []
    total_len = 0.0
    for b in range(1, basins.n_basins + 1):
        cells = basins.channel_rc[b] if b < len(basins.channel_rc) else None
        if cells is None or len(cells) < 2:
            continue
        coords = [grid.transform * (c + 0.5, r + 0.5) for r, c in cells.tolist()]
        # 実長はセル沿いの生の折れ線で測る（単純化で短くなる分は無視しない）
        length_m = sum(math.dist(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
        total_len += length_m
        if FLOW_BASIN_SIMPLIFY_M > 0 and len(coords) > 2:
            coords = list(LineString(coords).simplify(
                FLOW_BASIN_SIMPLIFY_M, preserve_topology=True).coords)
        truncated = (bool(basins.channel_truncated[b])
                     if b < len(basins.channel_truncated) else False)
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": [[round(x, 3), round(y, 3)] for x, y in coords]},
            "properties": {
                "basin_id": b,
                "length_m": round(length_m, 1),
                "n_points": len(coords),
                "truncated": truncated,
            },
        })
    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
        "properties": {
            "condition": name,
            "channel_count": len(feats),
            "what": "流域の主流路（吐口→源流。各合流点で集水セル数が大きい方を選ぶ）。"
                    "潮位非依存。断面ツールの自動測線に使う",
            "truncated_note": "properties.truncated は源流が AOI/collar 端の外に"
                              "あって打ち切ったもの（`flow_basins` の "
                              "`channel_truncated`）",
        },
        "features": feats,
    }
    (OUT / f"flow_channels_{name}.geojson").write_text(
        json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    return len(feats), total_len


def _load(name: str) -> np.ndarray | None:
    p = OUT / name
    if not p.exists():
        return None
    arr, _, nd = read(p)
    arr[arr == nd] = np.nan
    return arr


def _figures(done: list[str]) -> None:
    """確認用の図（docs/images/）。Web 実装前の目視用。"""
    import matplotlib
    matplotlib.use("Agg")
    matplotlib.rcParams["font.family"] = [
        "Hiragino Sans", "Hiragino Kaku Gothic ProN", "YuGothic", "Noto Sans CJK JP",
    ]
    matplotlib.rcParams["axes.unicode_minus"] = False
    import matplotlib.pyplot as plt

    img_dir = ROOT / "docs" / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    factor = int(round(RES_COARSE / RES_HIGHRES))

    def up(a: np.ndarray) -> np.ndarray:
        return np.repeat(np.repeat(a, factor, 0), factor, 1)

    # (1) 各条件の flow accumulation（log スケール）
    accums = [(c, _load(f"flow_accum_{c}.tif")) for c in done]
    accums = [(c, a) for c, a in accums if a is not None]
    if accums:
        fig, axes = plt.subplots(1, len(accums), figsize=(3.3 * len(accums), 3.9),
                                 squeeze=False)
        for ax, (c, a) in zip(axes[0], accums):
            la = np.log10(np.where(np.isfinite(a) & (a > 0), a, np.nan))
            im = ax.imshow(la, cmap="cubehelix_r", vmin=0)
            ax.set_title(f"{c}  log10(集水セル数)")
            ax.set_xticks([]); ax.set_yticks([])
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        _m = {"dinf": "D-infinity", "d8": "D8"}.get(FLOW_METHOD_USED, FLOW_METHOD_USED)
        fig.suptitle(f"{AOI.name}: 地表流の集中（{_m}・一様降雨・地形のみ）")
        fig.tight_layout()
        out = img_dir / asset_name("flow_accum.png")
        fig.savefig(out, dpi=85); plt.close(fig)
        print("wrote", out.relative_to(ROOT))

    # (2) highres の窪地マップ（充填深）＋越流点
    fd = _load("fill_depth_highres.tif")
    se = _load("spill_elev_highres.tif")
    if fd is not None:
        fig, ax = plt.subplots(figsize=(5.2, 5.2))
        im = ax.imshow(np.where(fd > MIN_PIT_DEPTH_M, fd, np.nan), cmap="viridis")
        if se is not None:
            ax.imshow(np.where(np.isfinite(se), 1.0, np.nan), cmap="autumn",
                      alpha=0.25)
        ax.set_title(f"{AOI.name}: 窪地の充填深 [m]（原理版・潮位非依存）")
        ax.set_xticks([]); ax.set_yticks([])
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="充填深 [m]")
        fig.tight_layout()
        out = img_dir / asset_name("flow_accum_pit_map.png")
        fig.savefig(out, dpi=85); plt.close(fig)
        print("wrote", out.relative_to(ROOT))

    # (3) control -> highres で水みち・窪地構造がどう変わるか
    ac = _load("flow_accum_control.tif")
    ah = _load("flow_accum_highres.tif")
    if ac is not None and ah is not None and ac.shape != ah.shape:
        lc = np.log10(np.where(np.isfinite(ac) & (ac > 0), ac, np.nan))
        lh = np.log10(np.where(np.isfinite(ah) & (ah > 0), ah, np.nan))
        diff = lh - up(lc)
        fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.9))
        for ax, data, ttl, cm in (
            (axes[0], up(lc), "control 5m（集約） log10", "cubehelix_r"),
            (axes[1], lh, "highres 0.5m log10", "cubehelix_r"),
            (axes[2], diff, "highres − control（水みちの出入り）", "RdBu_r"),
        ):
            vlim = {"cmap": cm}
            if cm == "RdBu_r":
                vlim.update(vmin=-2, vmax=2)
            im = ax.imshow(data, **vlim)
            ax.set_title(ttl); ax.set_xticks([]); ax.set_yticks([])
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        fig.suptitle(f"{AOI.name}: データ源 vs 解像度（集約した 5m と 0.5m の水みち）")
        fig.tight_layout()
        out = img_dir / asset_name("flow_accum_res_diff.png")
        fig.savefig(out, dpi=85); plt.close(fig)
        print("wrote", out.relative_to(ROOT))


def main() -> int:
    summary = {
        "aoi": AOI.bounds, "aoi_name": AOI.name,
        "method": METHOD,
        "flow_method": FLOW_METHOD_USED,
        "rainfall": "uniform unit（有効セルの寄与 = 1）",
        "connectivity_note": (
            "flow routing は 8 近傍（dinf は最急降下 facet を挟む 2 セルへ角度按分、"
            "d8 は 1 セル 1 方向）。h_conn の 4 近傍とは別物"),
        "collar_note": (
            f"ルーティングは AOI 外周に GSI 5m DEM（DEM5A、穴は DEM10B）の collar 帯を "
            f"{FLOW_COLLAR_M:.0f} m 張ってから回し、AOI 矩形に clip する。collar は"
            "ルーティング専用（充填深・越流点・容積は AOI セルのみ）。条件ごとの "
            "collar_used / collar_ring_coverage / edge_truncated_fraction_no_collar 参照"),
        "min_pit_depth_m": MIN_PIT_DEPTH_M,
        "caveats": CAVEATS,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "conditions": {},
    }
    done: list[str] = []
    for name, (fname, res) in CONDITIONS.items():
        if not (OUT / fname).exists():
            print(f"{name:10s} skip（{fname} が無い）")
            continue
        summary["conditions"][name] = _process(name, fname, res)
        done.append(name)

    if not done:
        raise SystemExit("処理できる地形条件が 1 つも無い（先に scripts/20・21 を回す）")

    (OUT / "flow_accum_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote flow_accum_summary.json（{', '.join(done)}）")

    _figures(done)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
