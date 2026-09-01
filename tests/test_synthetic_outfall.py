"""scripts/32_generate_synthetic_outfall_pairs.py の越流点ベースのペア選定。

大きいラスタでの S2 到達水位・面積は PR 本文の数値で確認する。ここでは
- `flow_accum_pits_*.geojson` のパース（spill を Z 座標からも拾う）
- 選定フィルタ（窪地の底が潮位以下 / 越流点が海に非連結 / 面積下限）
- 並び順（越流点標高の昇順、同着は面積の降順）と件数上限
を固定する。
"""
from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import from_origin

from conftest import load_script
from iwagaki.raster import Grid

mod = load_script("32_generate_synthetic_outfall_pairs")

# 10 セル四方・1 m グリッド。原点 (0, 10) から南東へ。
GRID = Grid(from_origin(0.0, 10.0, 1.0, 1.0), 10, 10, 1.0)


def _cell_xy(row: int, col: int) -> tuple[float, float]:
    x, y = GRID.transform * (col + 0.5, row + 0.5)
    return x, y


def _pit_feature(row, col, spill, fill, area_m2, pit_id=1, put_spill_in_z=True):
    x, y = _cell_xy(row, col)
    coords = [x, y, spill] if put_spill_in_z else [x, y]
    props = {"pit_id": pit_id, "max_fill_depth_m": fill,
             "area_ha": area_m2 / 1e4, "edge_truncated": False}
    if not put_spill_in_z:
        props["spill_elev_m_tp"] = spill
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": coords},
            "properties": props}


def test_pit_source_truncation_guard():
    # 面積上位 3 窪地だけ収録・全 100 窪地。最小収録面積は 900 m²。
    feats = [_pit_feature(1, 1, spill=1.2, fill=0.5, area_m2=a)
             for a in (5000, 2000, 900)]
    fc = {"properties": {"total_pits": 100}, "features": feats}
    # min_area_m2 が最小収録面積以下 → 未収録の同着窪地を取りこぼしうるので止める
    assert mod.pit_source_truncation_error(fc, 250.0) is not None
    assert mod.pit_source_truncation_error(fc, 899.0) is not None
    assert mod.pit_source_truncation_error(fc, 900.0) is not None   # 同着
    # 最小収録面積より厳密に大きければ OK
    assert mod.pit_source_truncation_error(fc, 901.0) is None
    assert mod.pit_source_truncation_error(fc, 1500.0) is None
    # 全窪地が収録されている（頭打ちでない）なら常に OK
    fc_full = {"properties": {"total_pits": 3}, "features": feats}
    assert mod.pit_source_truncation_error(fc_full, 0.0) is None


def test_parse_reads_spill_from_properties_or_z():
    fc = {"features": [
        _pit_feature(2, 2, spill=1.4, fill=0.5, area_m2=300, put_spill_in_z=True),
        _pit_feature(3, 3, spill=1.1, fill=0.4, area_m2=300, put_spill_in_z=False),
    ]}
    got = mod.parse_pit_features(fc)
    assert [round(f["spill_elev_m_tp"], 3) for f in got] == [1.4, 1.1]
    assert got[0]["area_m2"] == pytest.approx(300.0)


def test_select_orders_by_spill_then_area_and_caps_count():
    hc = np.full((10, 10), np.inf)          # どこも海に非連結
    feats = [
        _pit_feature(1, 1, spill=1.3, fill=0.6, area_m2=400, pit_id=10),
        _pit_feature(2, 2, spill=1.0, fill=0.6, area_m2=300, pit_id=11),
        _pit_feature(3, 3, spill=1.0, fill=0.6, area_m2=900, pit_id=12),  # 同着 → 面積で先
        _pit_feature(4, 4, spill=1.5, fill=0.6, area_m2=999, pit_id=13),
    ]
    picks = mod.select_outfall_pits(
        mod.parse_pit_features({"features": feats}), hc, GRID,
        target_h=0.93, max_pairs=3, min_area_m2=250.0)
    assert [p["pit_id"] for p in picks] == [12, 11, 10]
    assert all("row" in p and "col" in p for p in picks)


def test_select_drops_pits_above_tide_connected_or_too_small():
    hc = np.full((10, 10), np.inf)
    hc[5, 5] = 0.5                           # 既に海から連結（潮位 0.93 以下）
    feats = [
        # 底 = spill - fill = 1.4 - 0.3 = 1.1 > 0.93 → 潮位が届かない
        _pit_feature(1, 1, spill=1.4, fill=0.3, area_m2=400, pit_id=20),
        # 越流点が既に連結
        _pit_feature(5, 5, spill=1.2, fill=0.6, area_m2=400, pit_id=21),
        # 面積が下限未満
        _pit_feature(6, 6, spill=1.0, fill=0.6, area_m2=100, pit_id=22),
        # これだけ残る
        _pit_feature(7, 7, spill=1.1, fill=0.6, area_m2=400, pit_id=23),
    ]
    picks = mod.select_outfall_pits(
        mod.parse_pit_features({"features": feats}), hc, GRID,
        target_h=0.93, max_pairs=12, min_area_m2=250.0)
    assert [p["pit_id"] for p in picks] == [23]


def test_select_keeps_pit_when_hc_is_nodata_at_pour_point():
    hc = np.full((10, 10), np.nan)           # h_conn nodata = 非連結扱い
    feats = [_pit_feature(2, 2, spill=1.1, fill=0.6, area_m2=400, pit_id=30)]
    picks = mod.select_outfall_pits(
        mod.parse_pit_features({"features": feats}), hc, GRID,
        target_h=0.93, max_pairs=12, min_area_m2=250.0)
    assert [p["pit_id"] for p in picks] == [30]
    assert picks[0]["hc_at_pour_m_tp"] is None
