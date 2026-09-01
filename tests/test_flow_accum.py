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

from iwagaki.flow import (DinfResult, d8_accumulation, d8_flow_direction,
                          dinf_accumulation, dinf_flow_direction,
                          edge_truncated_fraction, flow_basins, label_pits,
                          main_channel_from_outlet, pit_pour_points,
                          pit_records, priority_flood_fill, route_with_collar)


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


def test_collar_c0_matches_plain_routing():
    # collar=0, method=d8 は素の d8_flow_direction + d8_accumulation と一致する
    rng = np.random.default_rng(7)
    dem = rng.random((18, 22)) * 6.0
    dem[3:6, 8:11] = np.nan
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    d8 = d8_flow_direction(filled)
    accum0, term0 = d8_accumulation(d8, valid)

    r = route_with_collar(dem, dem.copy(), 0, method="d8")
    assert np.allclose(r.accum[valid], accum0[valid])
    assert np.array_equal(r.term_edge, term0)
    assert r.conservation_ok

    # 既定は dinf。collar=0 は素の dinf ルーティングと一致し、保存則も満たす
    di = dinf_flow_direction(filled)
    accumd, termd = dinf_accumulation(di, valid)
    rd = route_with_collar(dem, dem.copy(), 0)
    assert np.allclose(rd.accum[valid], accumd[valid])
    assert np.array_equal(rd.term_edge, termd)
    assert rd.conservation_ok
    assert rd.accum[valid].min() >= 1.0 - 1e-9


def test_dinf_uniform_rain_conservation():
    # 一様単位降雨の保存則が D-inf でも成り立つ（分配しても総量は不変）
    rng = np.random.default_rng(42)
    dem = rng.random((30, 40)) * 8.0
    dem[5:8, 10:14] = np.nan
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)

    di = dinf_flow_direction(filled)
    accum, term_edge = dinf_accumulation(di, valid)

    n_valid = int(valid.sum())
    assert accum[valid].min() >= 1.0 - 1e-9
    assert accum[~valid].sum() == 0.0
    # 位相ソートは全有効セルを含む
    assert di.order.size == n_valid
    # 配分は各セルで保存する（1.0 か、終端なら 0.0）
    p1 = di.prop1[valid]; p2 = di.prop2[valid]
    tot = p1 + p2
    assert np.all((np.abs(tot - 1.0) < 1e-9) | (tot == 0.0))
    # 終端（receiver を持たないセル）に全降雨が集まる
    rec1 = di.receiver1.reshape(-1)
    terminal = valid.reshape(-1) & (rec1 == np.arange(rec1.size))
    assert accum.reshape(-1)[terminal].sum() == pytest.approx(n_valid)


def test_dinf_plane_collects_all_flow_downstream():
    # 南へ下る平面。分配しても全量が下流端に集まる（南端の列合計 = セル数）。
    dem = (20.0 - np.arange(5)[:, None]) + np.zeros((5, 7))
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    di = dinf_flow_direction(filled)
    accum, term_edge = dinf_accumulation(di, valid)
    # fall line は真南（基本方位）なので分配は起きない（e2 側は 0）
    assert np.allclose(di.prop2[valid], 0.0)
    assert np.allclose(di.prop1[:-1, :], 1.0)          # 南端以外は単一 receiver
    assert accum[-1, :].sum() == pytest.approx(35.0)
    assert term_edge.all()


def test_dinf_splits_flow_where_d8_picks_one():
    # アスペクトが軸に乗らない斜面（fall line が西と北西の間）。
    # D-inf は最急降下方向を挟む 2 セルへ分配する。D8 は 1 セルだけ。
    n = 9
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    dem = 100.0 - (2.0 * xx + 1.0 * yy)          # 下る向き (+x, +y): 東寄り・やや南
    filled = priority_flood_fill(dem)

    di = dinf_flow_direction(filled)
    d8 = d8_flow_direction(filled)

    c = 4 * n + 4                                 # 中央セルの flat index
    # D8 は 1 receiver（自分自身ではない）
    assert d8.receiver.reshape(-1)[c] != c
    # D-inf は 2 receiver、どちらも正の割合。東（c+1）と南東（c+1+n）
    r1 = int(di.receiver1.reshape(-1)[c])
    r2 = int(di.receiver2.reshape(-1)[c])
    p1 = float(di.prop1.reshape(-1)[c])
    p2 = float(di.prop2.reshape(-1)[c])
    assert p1 > 0.0 and p2 > 0.0
    assert {r1, r2} == {c + 1, c + 1 + n}
    assert p1 + p2 == pytest.approx(1.0)
    # 内角 r = atan2(1, 2) ≈ 0.4636 rad -> e2（南東）へ r/(π/4) ≈ 0.59
    assert p2 == pytest.approx(np.arctan2(1.0, 2.0) / (np.pi / 4), rel=1e-6)


def test_collar_adds_upstream_catchment_at_aoi_edge():
    # 北（行 0）から南へ一様に下る斜面。collar でその斜面を北へ延長すると、
    # AOI 北端セルは collar 側の上流ぶんだけ集水が増える。
    h = w = 8
    c = 3
    aoi = (100.0 - np.arange(h)[:, None]) + np.zeros((h, w))
    yy = np.arange(h + 2 * c)[:, None] - c            # AOI 座標系の行番号
    collar = (100.0 - yy) + np.zeros((h + 2 * c, w + 2 * c))

    with_collar = route_with_collar(aoi, collar.copy(), c)
    without = route_with_collar(aoi, aoi.copy(), 0)

    # 端の集水は collar で増える（減りはしない）
    assert with_collar.accum[0, :].sum() > without.accum[0, :].sum()
    assert np.all(with_collar.accum[0, :] >= without.accum[0, :])
    # 純粋な平面斜面なら 1 列 1 方向に流れ、collar の行数ぶん (= c) だけ上流が増える
    assert np.allclose(with_collar.accum[0, :], without.accum[0, :] + c)
    # AOI 内部は collar の影響を受けない
    assert np.allclose(with_collar.accum[1:, :], without.accum[1:, :] + c)


def test_collar_routes_edge_flow_into_sea_instead_of_truncating():
    # 西（列 0）へ下る斜面。AOI 単体だと西端で map 外へ抜けて「端で切れる」。
    # collar のさらに西端を nodata（海）にすると、そこへ抜けるので切れなくなる。
    h = w = 6
    c = 3
    aoi = (100.0 + np.arange(w)[None, :]) + np.zeros((h, w))
    xx = np.arange(w + 2 * c)[None, :] - c
    collar = (100.0 + xx) + np.zeros((h + 2 * c, w + 2 * c))
    collar[:, 0] = np.nan                              # collar の外縁 = 海

    with_collar = route_with_collar(aoi, collar.copy(), c)
    without = route_with_collar(aoi, aoi.copy(), 0)

    assert without.term_edge[:, 0].all()              # collar 無し: 端で切れている
    assert not with_collar.term_edge.any()            # collar 有り: すべて海へ抜ける
    # collar 有りでは端で切れるセルの割合が下がる
    assert with_collar.term_edge.mean() < without.term_edge.mean()
    # edge_truncated_fraction（collar 無しの軽量指標）も「全部切れている」を返す
    assert edge_truncated_fraction(priority_flood_fill(aoi)) == pytest.approx(1.0)


def _y_valley(h=26, w=25):
    """Y 字谷の合成 DEM。左枝・右枝が合流点 (row 12, col 12) で 1 本になり、
    トランクが南（行が増える向き）へ下って map 外へ抜ける。スケルトンからの
    直交距離を強く効かせて、丘面はかならずスケルトンへ排水する。"""
    yy, xx = np.mgrid[0:h, 0:w].astype(float)

    def seg(px, py, ax, ay, bx, by):
        vx, vy = bx - ax, by - ay
        t = np.clip(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy), 0.0, 1.0)
        cx, cy = ax + t * vx, ay + t * vy
        return np.hypot(px - cx, py - cy), t

    jx, jy = 12.0, 12.0
    dt, tt = seg(xx, yy, jx, jy, jx, h - 1.0)          # トランク: 合流点→南端
    dl, tl = seg(xx, yy, 3.0, 1.0, jx, jy)             # 左枝
    dr, tr = seg(xx, yy, w - 4.0, 1.0, jx, jy)         # 右枝
    trunk_len = h - 1.0 - jy
    along = np.select(
        [(dt <= dl) & (dt <= dr), dl <= dr],
        [(1.0 - tt) * trunk_len,
         trunk_len + (1.0 - tl) * 14.0],
        trunk_len + (1.0 - tr) * 14.0)
    dmin = np.minimum(dt, np.minimum(dl, dr))
    return along * 1.0 + dmin * 5.0


def test_flow_basins_y_valley_splits_into_three():
    dem = _y_valley()
    h, w = dem.shape
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    di = dinf_flow_direction(filled)
    accum, term_edge = dinf_accumulation(di, valid)

    b = flow_basins(di, valid, accum, channel_min_accum=50.0, term_edge=term_edge)
    assert b.n_basins == 3

    roots = [i for i in range(1, 4) if int(b.downstream[i]) == -1]
    assert len(roots) == 1
    trunk = roots[0]
    # 左右の枝はトランクへ流れ込む
    assert sorted(int(b.downstream[i]) for i in range(1, 4) if i != trunk) == [trunk, trunk]
    # トランクの上流をたどると全流域、枝の上流は自分だけ
    assert b.upstream_of(trunk) == {1, 2, 3}
    for i in range(1, 4):
        if i != trunk:
            assert b.upstream_of(i) == {i}
    # トランクの吐口は南端付近で、map 外へ抜けるので端で切れている
    assert int(b.outlet_rc[trunk][0]) >= h - 3
    assert bool(b.edge_truncated[trunk])
    # ラベルは有効セルを覆い、nodata は 0
    assert (b.labels[valid] > 0).all()
    # max_accum は **吐口セルの集水**（流域内の最大ではない）
    for i in range(1, 4):
        oy, ox = (int(v) for v in b.outlet_rc[i])
        assert b.max_accum[i] == pytest.approx(accum[oy, ox], rel=1e-9)
    # トランクの吐口の集水 = 全セル（全量が南端へ集まる）
    assert b.max_accum[trunk] == pytest.approx(float(valid.sum()), rel=1e-9)


def test_dinf_no_partial_split_into_nodata():
    # nodata に触れる facet は routing 上 -1e18 なので内角が 0 か π/4 に張り付き、
    # nodata 側へ 100 %（もう片方の prop は 0）になる。中間の分流で nodata へ
    # 抜けるセルは生じない（`src/iwagaki/flow.py` の sink 畳み込みが陸側の配分を
    # 捨てても保存則が破れない根拠）。
    rng = np.random.default_rng(3)
    dem = rng.random((25, 30)) * 6.0
    dem[4:9, 6:11] = np.nan          # nodata の島
    dem[:, -1] = np.nan              # 海の縁
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    di = dinf_flow_direction(filled)
    fv = valid.reshape(-1)
    ar = np.arange(fv.size)
    for rf, pf in ((di.receiver1.reshape(-1), di.prop1.reshape(-1)),
                   (di.receiver2.reshape(-1), di.prop2.reshape(-1))):
        to_nd = (rf != ar) & ~fv[rf]
        partial = fv & to_nd & (pf > 1e-9) & (pf < 1.0 - 1e-9)
        assert not partial.any()


def test_flow_basins_single_valley_is_one_basin():
    # 合流の無い 1 本の谷。閾値を越える本流はできるが合流点が無い -> 1 流域。
    dem = (30.0 - np.arange(20)[:, None]) + np.abs(np.arange(15) - 7)[None, :] * 4.0
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    di = dinf_flow_direction(filled)
    accum, _ = dinf_accumulation(di, valid)
    b = flow_basins(di, valid, accum, channel_min_accum=60.0)
    assert b.n_basins == 1
    assert int(b.downstream[1]) == -1
    assert b.upstream_of(1) == {1}


def test_flow_basins_coarsen_by_count_and_area():
    dem = _y_valley()
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    di = dinf_flow_direction(filled)
    accum, _ = dinf_accumulation(di, valid)
    # 低い本流閾値で細切れ -> max_basins で 2 個まで畳む
    fine = flow_basins(di, valid, accum, channel_min_accum=12.0)
    assert fine.n_basins > 2
    capped = flow_basins(di, valid, accum, channel_min_accum=12.0, max_basins=2)
    assert capped.n_basins == 2
    assert sorted(np.unique(capped.labels[valid]).tolist()) == [1, 2]
    # 巨大な下限を与えると全部トランク 1 個に畳まれる
    one = flow_basins(di, valid, accum, channel_min_accum=50.0,
                      min_basin_cells=10_000)
    assert one.n_basins == 1
    assert (one.labels[valid] == 1).all()


def test_flow_basins_collar_clip_flags_truncation():
    # 北から南へ一様に下る斜面を collar で北へ延ばす。AOI 北端の流域は collar 側に
    # 上流を持つので edge_truncated が立つ。
    h = w = 10
    c = 4
    aoi = (100.0 - np.arange(h)[:, None]) + np.zeros((h, w))
    yy = np.arange(h + 2 * c)[:, None] - c
    collar = (100.0 - yy) + np.zeros((h + 2 * c, w + 2 * c))
    r = route_with_collar(aoi, collar.copy(), c, want_basins=True,
                          basin_channel_min_accum=1e9)  # 本流なし -> 端終端で分割
    assert r.basins is not None
    assert r.basins.n_basins >= 1
    # 端で切れている流域が少なくとも 1 つ（collar へ上流が延びる or 南で map 外）
    assert bool(r.basins.edge_truncated.any())


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


# --- 流域の主流路（main_channel_from_outlet / flow_basins.channel_rc）------------


def _dinf_manual(h: int, w: int, edges: dict, *, accum: "dict | None" = None):
    """テスト用に主 receiver（単一）だけを手で組んだ DinfResult。receiver2 は
    使わない（prop2=0 に固定）ので `main_channel_from_outlet` は receiver1 だけを
    主 receiver として扱う。"""
    def idx(r, c):
        return r * w + c

    receiver1 = np.arange(h * w).reshape(h, w)
    receiver2 = receiver1.copy()
    prop1 = np.zeros((h, w))
    prop2 = np.zeros((h, w))
    for (r, c), (rr, rc) in edges.items():
        receiver1[r, c] = idx(rr, rc)
        prop1[r, c] = 1.0
    dinf = DinfResult(
        receiver1=receiver1.astype("int32"), receiver2=receiver2.astype("int32"),
        prop1=prop1, prop2=prop2,
        edge_outlet=np.zeros((h, w), dtype=bool),
        sink_outlet=np.zeros((h, w), dtype=bool),
        order=np.arange(h * w).astype("int32"),
    )
    valid = np.ones((h, w), dtype=bool)
    acc = np.ones((h, w))
    for (r, c), a in (accum or {}).items():
        acc[r, c] = a
    return dinf, acc, valid


def test_main_channel_picks_the_larger_accum_branch_at_a_confluence():
    # 3x3。(1,0) と (1,2) がどちらも (2,1) へ合流し、(2,1) が吐口。
    # (1,2) 側の集水（9）が (1,0) 側（5）より大きいので、主流路はそちらを選ぶ。
    # さらに (0,2) が (1,2) の上流に 1 つだけあり、そこで源流に達する。
    h = w = 3
    edges = {(1, 0): (2, 1), (1, 2): (2, 1), (0, 2): (1, 2)}
    dinf, acc, valid = _dinf_manual(h, w, edges, accum={(1, 0): 5.0, (1, 2): 9.0, (0, 2): 3.0})

    path = main_channel_from_outlet(dinf, acc, valid, (2, 1))
    assert path.tolist() == [[2, 1], [1, 2], [0, 2]]


def test_main_channel_within_mask_excludes_the_larger_branch():
    # 同じ合流だが、集水が大きい (1,2) 側を within マスクから外すと (1,0) 側を選ぶ。
    h = w = 3
    edges = {(1, 0): (2, 1), (1, 2): (2, 1), (0, 2): (1, 2)}
    dinf, acc, valid = _dinf_manual(h, w, edges, accum={(1, 0): 5.0, (1, 2): 9.0, (0, 2): 3.0})

    within = np.ones((h, w), dtype=bool)
    within[1, 2] = False
    within[0, 2] = False
    path = main_channel_from_outlet(dinf, acc, valid, (2, 1), within=within)
    assert path.tolist() == [[2, 1], [1, 0]]


def test_main_channel_rejects_outlet_outside_bounds_or_mask():
    h = w = 3
    dinf, acc, valid = _dinf_manual(h, w, {})
    with pytest.raises(ValueError):
        main_channel_from_outlet(dinf, acc, valid, (3, 0))
    within = np.zeros((h, w), dtype=bool)
    with pytest.raises(ValueError):
        main_channel_from_outlet(dinf, acc, valid, (0, 0), within=within)


def test_main_channel_stops_immediately_when_outlet_has_no_donor():
    # donor の無い吐口は経路長 1（自分だけ）で止まる
    h = w = 3
    dinf, acc, valid = _dinf_manual(h, w, {})
    path = main_channel_from_outlet(dinf, acc, valid, (1, 1))
    assert path.tolist() == [[1, 1]]


def test_flow_basins_channel_starts_at_outlet_and_reaches_confluence():
    # Y 字谷: 各リーフの channel_rc が吐口で始まり、8 近傍でつながった 1 本道になる。
    # トランクのリーフは合流点セルで遡りが止まる（合流点自身はトランク側に属し、
    # 両支流の吐口は合流点の隣接セルだが別リーフなので mask の外）。
    dem = _y_valley()
    filled = priority_flood_fill(dem)
    valid = np.isfinite(filled)
    di = dinf_flow_direction(filled)
    accum, term_edge = dinf_accumulation(di, valid)

    b = flow_basins(di, valid, accum, channel_min_accum=50.0, term_edge=term_edge)
    assert b.n_basins == 3
    roots = [i for i in range(1, 4) if int(b.downstream[i]) == -1]
    assert len(roots) == 1
    trunk = roots[0]

    for i in range(1, 4):
        cells = b.channel_rc[i]
        assert cells.ndim == 2 and cells.shape[1] == 2 and cells.shape[0] >= 1
        assert tuple(int(v) for v in cells[0]) == tuple(int(v) for v in b.outlet_rc[i])
        for (r0, c0), (r1, c1) in zip(cells[:-1].tolist(), cells[1:].tolist()):
            assert max(abs(r1 - r0), abs(c1 - c0)) == 1
        for r, c in cells.tolist():
            assert b.labels[r, c] == i
        # big グリッド段階（クリップ前）では打ち切りは起きない
        assert not bool(b.channel_truncated[i])

    # トランクの主流路は合流点セル (12, 12) まで遡る（それより上流は支流のリーフ）
    trunk_cells = {tuple(x) for x in b.channel_rc[trunk].tolist()}
    assert (12, 12) in trunk_cells


def test_channel_is_truncated_at_aoi_edge_when_it_extends_into_collar():
    # 南へ一様に下る斜面を collar で北へ延ばす。**collar の南側は海（nodata）**にして
    # 吐口が AOI 南端に留まるようにする（そうしないと斜面が collar の南端まで延び、
    # 吐口自体が AOI の外に出て `in_clip=False` になり、この検証にならない）。
    # 列ごとに独立した縦一直線の流路になり、どれも北の collar 側まで遡ってから
    # AOI 矩形で打ち切られる。
    h = w = 10
    c = 4
    big_h = h + 2 * c
    aoi = (100.0 - np.arange(h)[:, None]) + np.zeros((h, w))
    yy = np.arange(big_h)[:, None] - c
    collar = (100.0 - yy) + np.zeros((big_h, w + 2 * c))
    collar[c + h:, :] = np.nan
    r = route_with_collar(aoi, collar.copy(), c, want_basins=True,
                          basin_channel_min_accum=1e9)
    assert r.basins is not None
    assert r.basins.n_basins == w   # 列ごとに独立（横方向の合流が無い一様斜面）

    for b in range(1, r.basins.n_basins + 1):
        chan = r.basins.channel_rc[b]
        assert chan.shape[0] >= 1
        assert tuple(int(v) for v in chan[0]) == tuple(int(v) for v in r.basins.outlet_rc[b])
        # AOI 矩形の中に収まっている
        assert chan[:, 0].min() >= 0 and chan[:, 0].max() < h
        assert chan[:, 1].min() >= 0 and chan[:, 1].max() < w
        # collar（北）側へ抜けた分は打ち切られているので、AOI 北端 (row 0) まで届く
        assert chan[:, 0].min() == 0
        assert bool(r.basins.channel_truncated[b])
