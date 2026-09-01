"""scripts/93_point_buffer_agg.py と iwagaki.areas の円バッファ集計のテスト。

実データ（境界・統計・objects.geojson）の突き合わせは PR 本文の実行結果で確認する。
ここでは面按分の重み・重心内包・年齢区分の合計整合・用途集計だけを固定する。
"""
from __future__ import annotations

import math

import geopandas as gpd
import pandas as pd
import pytest
from pyproj import Transformer
from shapely.geometry import Point, Polygon

from conftest import load_script

agg = load_script("93_point_buffer_agg")
from iwagaki import areas as areas_mod  # noqa: E402
from iwagaki.config import CRS_ANALYSIS, CRS_LONLAT  # noqa: E402

# 舞鶴の解析原点の近く。ここを中心に合成の小地域を並べる。
CX, CY = -60000.0, -60000.0
_TO_LONLAT = Transformer.from_crs(CRS_ANALYSIS, CRS_LONLAT, always_xy=True)
CENTER_LON, CENTER_LAT = _TO_LONLAT.transform(CX, CY)


def _square(x0, y0, x1, y1):
    return Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def _areas():
    # A: 中心の西側 1000x1000、B: 東側 1000x1000（中心が共有辺の上）、
    # C: 遠く（掛からない）、D: 中心の北側（統計欠損のテスト用）
    return gpd.GeoDataFrame(
        {
            "KEY_CODE": ["A", "B", "C", "D"],
            "S_NAME": ["西区", "東区", "遠区", "北区"],
            "CITY_NAME": ["市"] * 4,
            "geometry": [
                _square(CX - 1000, CY - 500, CX, CY + 500),
                _square(CX, CY - 500, CX + 1000, CY + 500),
                _square(CX + 5000, CY + 5000, CX + 6000, CY + 6000),
                _square(CX - 500, CY + 400, CX + 500, CY + 1400),
            ],
        },
        crs=CRS_ANALYSIS,
    )


def _stats():
    df = pd.DataFrame(
        {
            "key_code": ["A", "B", "C", "D"],
            "pop_total": [1000, 2000, 9999, pd.NA],
            "age_0_14": [100, 300, 999, pd.NA],
            "age_15_64": [700, 1400, 8000, pd.NA],
            "age_65_plus": [200, 300, 1000, pd.NA],
            "age_unknown": [0, 0, 0, pd.NA],
            "age_75_plus": [90, 120, 500, pd.NA],
            "suppressed": [False, False, False, True],
        }
    )
    for c in areas_mod.STATS_COUNT_FIELDS:
        df[c] = df[c].astype("Int64")
    return df.set_index("key_code")


# --- iwagaki.areas.areas_in_circle: 面按分の重み ----------------------

def test_areas_in_circle_fraction():
    hit = areas_mod.areas_in_circle(_areas(), CENTER_LON, CENTER_LAT, 500.0)
    by = {r.KEY_CODE: r for r in hit.itertuples(index=False)}
    assert set(by) == {"A", "B", "D"}          # C は掛からない
    half_disk = math.pi * 500**2 / 2
    assert by["A"].overlap_m2 == pytest.approx(half_disk, rel=1e-3)
    assert by["A"].circle_frac == pytest.approx(half_disk / 1e6, rel=1e-3)
    assert by["B"].circle_frac == pytest.approx(half_disk / 1e6, rel=1e-3)


# --- population_section: 面按分と重心内包 ----------------------------

def test_population_areal_weighting_and_age_sum():
    sec, rows = agg.population_section(
        _areas(), _stats(), CENTER_LON, CENTER_LAT, 500.0, "areal")
    frac = math.pi * 500**2 / 2 / 1e6
    assert sec["population_estimate"] == pytest.approx(frac * (1000 + 2000), rel=1e-3)
    # 年齢 3 区分 + 不詳 の合計 == 人口推計（unknown=0 なので 3 区分で一致）
    counts = [sec["age_distribution"][k]["count"] for k in agg.AGE_FIELDS]
    assert sum(counts) == pytest.approx(sec["population_estimate"], rel=1e-6)
    assert sec["age_distribution"]["age_15_64"]["count"] == pytest.approx(
        frac * (700 + 1400), rel=1e-3)
    # D は統計欠損（秘匿）なので按分に入らず、件数だけ立つ
    assert sec["n_small_areas_missing_stats_in_circle"] == 1
    assert sec["n_small_areas_suppressed_in_circle"] == 1
    assert sec["n_small_areas_counted"] == 2


def test_population_centroid_method_is_all_or_nothing():
    # 半径 700 なら A,B の重心（中心から 500 m）は円内、D の重心（900 m）は外
    sec, _ = agg.population_section(
        _areas(), _stats(), CENTER_LON, CENTER_LAT, 700.0, "centroid")
    assert sec["population_estimate"] == pytest.approx(3000.0)
    assert sec["aging_rate_65plus"] == pytest.approx(500 / 3000, abs=1e-4)


def test_population_shares_sum_to_one():
    sec, _ = agg.population_section(
        _areas(), _stats(), CENTER_LON, CENTER_LAT, 800.0, "areal")
    shares = [sec["age_distribution"][k]["share"] for k in agg.AGE_FIELDS]
    assert sum(shares) == pytest.approx(1.0, abs=1e-3)


# --- building_usage_section -----------------------------------------

def _buildings(items):
    # items: (dx, dy, usage)
    return gpd.GeoDataFrame(
        {
            "gml_id": [f"b{i}" for i in range(len(items))],
            "feature_type": ["bldg:Building"] * len(items),
            "usage": [u for *_, u in items],
            "unreliable": [False] * len(items),
            "geometry": [Point(CX + dx, CY + dy) for dx, dy, _ in items],
        },
        crs=CRS_ANALYSIS,
    )


def test_building_usage_counts_and_labels():
    objs = _buildings([
        (0, 0, "411"), (100, 0, "411"), (-200, 50, "402"),
        (0, 0, None),                       # 用途なし
        (5000, 5000, "411"),                # 円の外
    ])
    codes = {"411": "住宅", "402": "商業施設"}
    sec, rows = agg.building_usage_section(objs, CENTER_LON, CENTER_LAT, 500.0, codes)
    assert sec["total_buildings"] == 4
    by = {d["code"]: d for d in sec["by_usage"]}
    assert by["411"]["count"] == 2
    assert by["411"]["label"] == "住宅"
    assert by["402"]["count"] == 1
    assert agg.USAGE_UNKNOWN in by and by[agg.USAGE_UNKNOWN]["count"] == 1
    # 件数の降順
    assert [d["count"] for d in sec["by_usage"]] == sorted(
        (d["count"] for d in sec["by_usage"]), reverse=True)


# --- pick_aoi ------------------------------------------------------

def test_pick_aoi_prefers_containing_aoi():
    from iwagaki.config import AOIS
    a = AOIS["higashi_maizuru"]
    x = (a.xmin + a.xmax) / 2
    y = (a.ymin + a.ymax) / 2
    name, edge = agg.pick_aoi(x, y)
    assert name == "higashi_maizuru"
    assert edge == 0.0


def test_pick_aoi_prefers_larger_on_overlap():
    from iwagaki.config import AOIS
    a = AOIS["yoshiwara"]          # nishi_maizuru に内包される
    x = (a.xmin + a.xmax) / 2
    y = (a.ymin + a.ymax) / 2
    name, edge = agg.pick_aoi(x, y)
    assert name == "nishi_maizuru"   # 両方に入るが広い方
    assert edge == 0.0
