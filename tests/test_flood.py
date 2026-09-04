"""src/iwagaki/flood.py の h_conn 計算と、刻み格子での判定ヘルパ。

大きいラスタでの実行結果は PR 本文の数値で確認する。ここでは
- 合成 DEM での h_conn の既知解（連結した窪地は浸水、非連結は +inf）
- `reached()` が float32 で保存した段の値を取りこぼさないこと
  （`docs/results.md`「イベント水位付近の階段状の跳び」で一度踏んだ 2 cm の
  見かけの跳びの回帰テスト）
を固定する。
"""
from __future__ import annotations

import numpy as np

from iwagaki.flood import compute_h_conn, reached

STEP = 0.05


def test_compute_h_conn_connected_vs_isolated_basin():
    # 左端が海（seed）。中央に鞍部 0.6 で仕切られた低地 0.1、
    # 右側に完全に閉じた窪地 0.1（掃引域 h_max=3.0 より高い 3.5 の壁で囲う）。
    W = 3.5
    elev = np.array([
        [0.0, 0.1, 0.6, 0.1, W, 0.1, W],
        [0.0, 0.1, 0.6, 0.1, W, 0.1, W],
        [0.0, 0.1, 0.6, 0.1, W, W, W],
    ])
    seed = np.zeros_like(elev, dtype=bool)
    seed[:, 0] = True

    hc = compute_h_conn(elev, seed, h_min=0.0, h_max=3.0, h_step=STEP)

    # 海に直結する左の低地は潮位 0.1 で連結
    assert hc[0, 1] <= 0.1 + 1e-9
    # 鞍部の向こうの低地は鞍部 0.6 を越えないと連結しない
    assert abs(hc[0, 3] - 0.6) < 1e-9
    # 壁で閉じた窪地は到達不能
    assert not np.isfinite(hc[0, 5])


def test_reached_does_not_miss_a_step_stored_as_float32():
    # h_conn の段の値（0.05 の倍数）を float32 で保存すると厳密には表現できない。
    hc32 = np.array([0.85, 0.90], dtype=np.float32).astype(np.float64)

    # 生の比較は 0.85 の段を取りこぼす（これがバグだった）
    assert not bool((hc32[0] <= 0.85))
    assert bool((hc32[0] <= 0.86))

    # reached は段の格子で見るので 0.85 で拾う。0.85 と 0.87 は同じ判定になる
    assert bool(reached(hc32, 0.85, STEP)[0])
    assert np.array_equal(reached(hc32, 0.85, STEP), reached(hc32, 0.87, STEP))
    # 次の段 0.90 は 0.87 では False、0.90 で True
    assert not bool(reached(hc32, 0.87, STEP)[1])
    assert bool(reached(hc32, 0.90, STEP)[1])


def test_reached_keeps_sub_step_reference_tides_strict():
    # 参照潮位は刻みからずれる（例: 朔望平均満潮位(公表) 0.545）。
    # 段 0.55 のセルは 0.545 では連結していないので False のまま。
    hc = np.array([0.50, 0.55], dtype=np.float32).astype(np.float64)
    assert list(reached(hc, 0.545, STEP)) == [True, False]


def test_reached_marks_unreached_cells_false():
    hc = np.array([np.inf, np.nan, 0.30])
    assert list(reached(hc, 1.0, STEP)) == [False, False, True]
