"""scripts/92_area_aggregate.py の集計ロジックの軽いテスト。

突き合わせの本体（母数 = objects.geojson の建物数、床上/床下の合計 =
web/src/domain/flood.ts の floorCounts）は PR 本文の実行結果で確認する。
ここでは空間結合と床上/床下の閾値まわりだけを固定する。
"""
from __future__ import annotations

import geopandas as gpd
import pytest
from shapely.geometry import Point, Polygon

from conftest import load_script

agg = load_script("92_area_aggregate")


# --- 浸水深の式（scripts/91 / flood.ts と一致） -------------------------

@pytest.mark.parametrize("ground, h_conn, tide, expect", [
    (1.0, 1.0, 0.93, (0.0, 0.0)),          # 潮位より高い地盤
    (0.0, 5.0, 0.93, (0.93, 0.0)),         # 連結しない窪地 -> connected は 0
    (0.0, 0.5, 0.93, (0.93, 0.93)),        # 海と連結
    (0.30, 0.20, 0.69, (0.39, 0.39)),
    (None, None, 0.93, (0.0, 0.0)),        # 地盤高なし -> 深さ 0（総棟数には残る）
    (0.5, None, 0.93, (0.43, 0.0)),        # h_conn なし -> connected は 0
])
def test_building_depths(ground, h_conn, tide, expect):
    got = agg.building_depths(
        {"ground_elev_highres": ground, "h_conn_highres": h_conn}, tide)
    assert got == pytest.approx(expect)


# --- 床上/床下の閾値（0.5 m ちょうどは床上） ---------------------------

@pytest.mark.parametrize("depth, bucket", [
    (0.0, "dry"),
    (1e-9, "under"),
    (0.4999, "under"),
    (0.5, "above"),
    (2.0, "above"),
])
def test_floor_bucket(depth, bucket):
    assert agg.floor_bucket(depth) == bucket


# --- 空間結合（重心 -> 小地域） ---------------------------------------

def _areas():
    west = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    east = Polygon([(10, 0), (20, 0), (20, 10), (10, 10)])
    return gpd.GeoDataFrame(
        {"KEY_CODE": ["A", "B"], "S_NAME": ["西区", "東区"],
         "CITY_NAME": ["市", "市"], "geometry": [west, east]},
        crs=agg.CRS_ANALYSIS,
    )


def _buildings(points):
    return gpd.GeoDataFrame(
        {"gml_id": [f"b{i}" for i in range(len(points))],
         "ground_elev_highres": [0.0] * len(points),
         "h_conn_highres": [0.0] * len(points),
         "geometry": [Point(*p) for p in points]},
        crs=agg.CRS_ANALYSIS,
    )


def test_assign_to_areas_matches_and_outside():
    buildings = _buildings([(5, 5), (5, 6), (15, 5), (50, 50)])
    assigned = agg.assign_to_areas(buildings, _areas())
    by_id = assigned["key_code"].to_dict()
    assert by_id["b0"] == "A"
    assert by_id["b1"] == "A"
    assert by_id["b2"] == "B"
    assert by_id["b3"] == agg.OUTSIDE_KEY
    assert assigned.loc["b3", "s_name"] == agg.OUTSIDE_NAME


def test_assign_to_areas_no_double_count_on_overlap():
    # 小地域どうしが重なっていても、建物は 1 棟 1 行で KEY_CODE 昇順の 1 つに決まる。
    a = Polygon([(0, 0), (12, 0), (12, 10), (0, 10)])
    b = Polygon([(8, 0), (20, 0), (20, 10), (8, 10)])
    areas = gpd.GeoDataFrame(
        {"KEY_CODE": ["B2", "A1"], "S_NAME": ["東", "西"],
         "CITY_NAME": ["市", "市"], "geometry": [b, a]},
        crs=agg.CRS_ANALYSIS,
    )
    buildings = _buildings([(10, 5)])          # 重なり部分にある
    assigned = agg.assign_to_areas(buildings, areas)
    assert len(assigned) == 1
    assert assigned["key_code"].iloc[0] == "A1"   # 昇順で先

def test_assign_to_areas_edge_point_goes_outside():
    # 共有境界ちょうどの点は within ではないので (小地域外) に落ちる。
    buildings = _buildings([(10, 5)])
    assigned = agg.assign_to_areas(buildings, _areas())
    assert assigned["key_code"].iloc[0] == agg.OUTSIDE_KEY


# --- 集計と行の組み立て ---------------------------------------------

def test_aggregate_counts_and_rate():
    # 西区: 地盤 0.0 の建物 3 棟（H=1.0 で全部 深さ1.0 -> 床上）＋ 乾いた 1 棟
    buildings = gpd.GeoDataFrame(
        {"gml_id": ["w1", "w2", "w3", "w4"],
         "ground_elev_highres": [0.0, 0.0, 0.7, 5.0],
         "h_conn_highres": [0.0, 5.0, 0.0, 0.0],
         "geometry": [Point(1, 1), Point(2, 2), Point(3, 3), Point(4, 4)]},
        crs=agg.CRS_ANALYSIS,
    )
    assigned = agg.assign_to_areas(buildings, _areas())
    rows = agg.to_rows(agg.aggregate(assigned, 1.0), "test_aoi", 1.0)
    assert len(rows) == 1
    row = rows[0]
    assert row["key_code"] == "A"
    assert row["total_bldg"] == 4
    # simple: w1,w2 深さ1.0 床上 / w3 深さ0.3 床下 / w4 乾き
    assert row["simple_floor_above_bldg"] == 2
    assert row["simple_floor_under_bldg"] == 1
    assert row["simple_flooded_bldg"] == 3
    assert row["simple_flood_rate"] == pytest.approx(0.75)
    # connected: w2 は h_conn=5.0 > 1.0 で連結せず 0 -> 床上は w1 のみ
    assert row["connected_floor_above_bldg"] == 1
    assert row["connected_floor_under_bldg"] == 1
    assert row["connected_flooded_bldg"] == 2
    assert row["value_kind"] == agg.VALUE_KIND


def test_selfcheck_passes():
    assert agg._selfcheck() == 0
