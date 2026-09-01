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
    # items: (dx, dy, usage) or (dx, dy, usage, unreliable)
    return gpd.GeoDataFrame(
        {
            "gml_id": [f"b{i}" for i in range(len(items))],
            "feature_type": ["bldg:Building"] * len(items),
            "usage": [it[2] for it in items],
            "unreliable": [it[3] if len(it) > 3 else False for it in items],
            "geometry": [Point(CX + it[0], CY + it[1]) for it in items],
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


# --- codex レビューで挙がったエッジケース --------------------------------

def test_building_usage_excludes_unreliable():
    objs = _buildings([
        (0, 0, "411"),
        (10, 0, "411", True),          # unreliable -> 除外
        (-10, 0, "402", True),         # unreliable -> 除外
    ])
    sec, _ = agg.building_usage_section(objs, CENTER_LON, CENTER_LAT, 500.0, {})
    assert sec["total_buildings"] == 1
    assert {d["code"] for d in sec["by_usage"]} == {"411"}


def test_population_coverage_fraction_flags_gap():
    # 円の半分しか小地域が無い（A だけ、B/C/D を外す）-> 被覆 ~0.5
    areas = _areas().iloc[[0]].copy()
    sec, _ = agg.population_section(
        areas, _stats(), CENTER_LON, CENTER_LAT, 500.0, "areal")
    assert sec["boundary_coverage_fraction"] == pytest.approx(0.5, abs=0.02)
    assert sec["coverage_complete"] is False


def test_population_full_coverage_is_complete():
    sec, _ = agg.population_section(
        _areas(), _stats(), CENTER_LON, CENTER_LAT, 400.0, "areal")
    assert sec["coverage_complete"] is True
    assert sec["boundary_coverage_fraction"] == pytest.approx(1.0, abs=1e-3)


def test_population_key_not_in_stats_is_missing_not_crash():
    areas = _areas()
    stats = _stats().drop(index="A")      # A の統計を消す
    sec, rows = agg.population_section(
        areas, stats, CENTER_LON, CENTER_LAT, 500.0, "areal")
    a_row = next(r for r in rows if r["key_code"] == "A")
    assert a_row["pop_total"] is None
    assert sec["n_small_areas_missing_stats_in_circle"] == 2  # A（統計なし）+ D（秘匿）
    # B だけ計上される
    frac = math.pi * 500**2 / 2 / 1e6
    assert sec["population_estimate"] == pytest.approx(frac * 2000, rel=1e-3)


def test_population_zero_pop_no_aging_rate():
    areas = _areas()
    stats = _stats()
    for c in areas_mod.STATS_COUNT_FIELDS:
        stats.loc["A", c] = 0
        stats.loc["B", c] = 0
    sec, _ = agg.population_section(
        areas, stats, CENTER_LON, CENTER_LAT, 500.0, "areal")
    assert sec["population_estimate"] == 0.0
    assert sec["aging_rate_65plus"] is None


# --- update_index: viewer 用の索引（新規） ----------------------------

def test_update_index_creates_and_upserts(tmp_path):
    agg.update_index(tmp_path, "a", "地点A", 135.1, 35.1, "yoshiwara",
                      [500, 800], "2026-09-01T00:00:00+00:00", "point_buffer_a.json")
    agg.update_index(tmp_path, "b", "地点B", 135.2, 35.2, "nishi_maizuru",
                      [1000], "2026-09-01T00:00:01+00:00", "point_buffer_b.json")
    import json as _json
    idx = _json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert idx["version"] == 1
    assert [p["id"] for p in idx["points"]] == ["a", "b"]

    # 同じ id を再実行すると 1 件のまま内容だけ更新される（重複しない）
    agg.update_index(tmp_path, "a", "地点A改", 135.15, 35.15, "yoshiwara",
                      [500], "2026-09-01T01:00:00+00:00", "point_buffer_a.json")
    idx = _json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert [p["id"] for p in idx["points"]] == ["a", "b"]
    a = next(p for p in idx["points"] if p["id"] == "a")
    assert a["label"] == "地点A改"
    assert a["center_wgs84"] == [135.15, 35.15]
    assert a["radii_m"] == [500]


def test_areas_in_circle_reprojects_wgs84_input():
    # EPSG:4326 の areas を渡しても内部で 6674 に変換される
    ll = _areas().to_crs("EPSG:4326")
    hit = areas_mod.areas_in_circle(ll, CENTER_LON, CENTER_LAT, 500.0)
    assert set(hit["KEY_CODE"]) == {"A", "B", "D"}
    half_disk = math.pi * 500**2 / 2
    by = {r.KEY_CODE: r for r in hit.itertuples(index=False)}
    assert by["A"].overlap_m2 == pytest.approx(half_disk, rel=2e-3)
