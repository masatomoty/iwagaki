"""src/iwagaki/flow.py（Priority-Flood 充填 + D8 flow accumulation）の単体テスト。

大きいラスタでの実行結果は PR 本文の数値で確認する。ここでは
- 充填の単調性・冪等性
- 小さい合成 DEM での窪地の既知解
- D8 の一様単位降雨の保存則
- 越流点標高 >= 窪地内最大標高
を固定する。
"""
from __future__ import annotations

import numpy as np
import pytest

from iwagaki.flow import (d8_accumulation, d8_flow_direction, label_pits,
                          pit_pour_points, pit_records, priority_flood_fill)


def test_fill_is_monotone_and_no_pit_on_slope():
    # 南（行が増える向き）へ一様に下る斜面。窪地は無い。
    dem = (10.0 - np.arange(6)[:, None]) + np.zeros((6, 8))
    filled = priority_flood_fill(dem)
    assert np.all(filled >= dem - 1e-12)
    # 斜面なので充填は起きない（ULP 1 段ぶんの許容）
    assert np.max(filled - dem) < 1e-6


def test_fill_is_idempotent():
    rng = np.random.default_rng(0)
    dem = rng.random((20, 25)) * 5.0
    once = priority_flood_fill(dem)
    twice = priority_flood_fill(once)
    assert np.allclose(once, twice, atol=1e-9)


def test_known_bowl_pit():
    # 縁は標高 5、内側 3x3 は 1、中心は 0 の鉢。縁で越流する。
    dem = np.full((5, 5), 5.0)
    dem[1:4, 1:4] = 1.0
    dem[2, 2] = 0.0
    filled = priority_flood_fill(dem)
    fill_depth = filled - dem

    # 内側 9 セルはすべて越流水位（≈ 5）まで充填される
    assert np.all(fill_depth[1:4, 1:4] > 0.99)
    assert filled[2, 2] == pytest.approx(5.0, abs=1e-3)
    # 縁は動かない
    assert np.all(fill_depth[0, :] < 1e-6)

    labels, n = label_pits(fill_depth)
    assert n == 1
    (pit,) = pit_records(labels, fill_depth, filled, dem, cell_area_m2=1.0)
    assert pit.area_m2 == pytest.approx(9.0)
    assert pit.max_fill_depth_m == pytest.approx(5.0, abs=1e-3)
    # 容積 = Σ 充填深: 中心 5 + 8 セル × 4 = 37
    assert pit.volume_m3 == pytest.approx(37.0, abs=1e-2)
    # 越流点標高 >= 窪地内の最大地表標高
    assert pit.spill_elev_m_tp + 1e-6 >= pit.max_ground_elev_m_tp
    # 越流点セルは窪地の内側（内側 3x3）に来る
    assert 1 <= pit.pour_row <= 3 and 1 <= pit.pour_col <= 3


def test_pour_point_sits_on_the_saddle():
    # 縁 5・内側 1・中心 0 の鉢。ただし縁の 1 か所（[0,2]）を 2 に下げて鞍部にする。
    dem = np.full((5, 5), 5.0)
    dem[1:4, 1:4] = 1.0
    dem[2, 2] = 0.0
    dem[0, 2] = 2.0                      # ここが越流の鞍部（周囲の縁 5 より低い）
    filled = priority_flood_fill(dem)
    fill_depth = filled - dem
    labels, n = label_pits(fill_depth)
    assert n == 1
    pour = pit_pour_points(labels, fill_depth, filled)
    (yx,) = pour.values()
    # 鞍部 [0,2] に接する窪地の上縁（行 1）から溢れる
    assert yx[0] == 1 and yx[1] in (1, 2, 3)
    # その越流点セルの外側には鞍部（filled = 2.0）が隣接している
    ry, rx = yx
    assert min(filled[max(ry - 1, 0), c] for c in (rx - 1, rx, rx + 1)
               if 0 <= c < 5) == pytest.approx(2.0)


def test_pour_points_empty_when_no_pit():
    dem = (10.0 - np.arange(6)[:, None]) + np.zeros((6, 8))
    filled = priority_flood_fill(dem)
    fill_depth = filled - dem
    labels, _ = label_pits(fill_depth)
    assert pit_pour_points(labels, fill_depth, filled) == {}


def test_nodata_acts_as_outlet():
    # 左端の列を nodata（海）にすると、そこへ抜けるので窪地は塞がれない。
    dem = np.full((5, 6), 3.0)
    dem[1:4, 1:4] = 0.5
    dem[:, 0] = np.nan
    filled = priority_flood_fill(dem)
    fill_depth = np.where(np.isfinite(dem), filled - dem, np.nan)
    # 海に隣接して低い経路があるので、内側は縁の高さまでは充填されない
    assert np.nanmax(fill_depth) < 2.5
    assert np.isnan(filled[0, 0])


def test_d8_uniform_rain_conservation():
    rng = np.random.default_rng(42)
    dem = rng.random((30, 40)) * 8.0
    # いくつか nodata を混ぜる
    dem[5:8, 10:14] = np.nan
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)

    d8 = d8_flow_direction(filled)
    accum, term_edge = d8_accumulation(d8, valid)

    n_valid = int(valid.sum())
    assert accum[valid].min() >= 1.0
    assert accum[~valid].sum() == 0.0

    rec = d8.receiver.reshape(-1)
    flat_valid = valid.reshape(-1)
    terminal = flat_valid & ((rec == np.arange(rec.size)) | ~flat_valid[rec])
    assert accum.reshape(-1)[terminal].sum() == pytest.approx(n_valid)
    # topological order は全有効セルを含む
    assert d8.order.size == n_valid


def test_d8_single_outlet_plane():
    # 南へ下る平面。全セルが南端へ流れ、南端の列合計 = セル数。
    dem = (20.0 - np.arange(5)[:, None]) + np.zeros((5, 7))
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    d8 = d8_flow_direction(filled)
    accum, term_edge = d8_accumulation(d8, valid)
    assert accum[-1, :].sum() == pytest.approx(35.0)
    # 南端はマップ外へ抜ける -> すべて端で切れている
    assert term_edge.all()
