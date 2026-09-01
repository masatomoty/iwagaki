"""scripts/80_build_web_tiles.py の「水みち／窪地」タイルのパッキング。

タイルの枚数・サイズは PR 本文の実行結果で確認する。ここでは
- R チャネル（log8）の encode↔decode 往復
- B チャネル（充填深コード）の往復
- nodata（A=0）の扱い
を固定する。three/floodMaterial.ts の decodeFlow・scripts/84 の検査と同じ式。
"""
from __future__ import annotations

import numpy as np
import pytest

from conftest import load_script

mod = load_script("80_build_web_tiles")


def test_flow_r8_roundtrip_log_space():
    accum_max = 673381.0
    accum = np.array([[0.0, 1.0, 50.0, 5000.0],
                      [50000.0, 300000.0, accum_max, np.nan]], dtype="float64")
    fill = np.zeros_like(accum)
    rgba = mod.encode_flow(accum, fill, accum_max)
    back, _ = mod.decode_flow(rgba, accum_max)

    denom = np.log1p(accum_max)
    finite = np.isfinite(accum)
    t_src = np.log1p(np.clip(accum[finite], 0, None)) / denom
    t_rt = np.log1p(np.clip(back[finite], 0, None)) / denom
    assert np.max(np.abs(t_rt - t_src)) <= 1 / 255 + 1e-9
    # nodata は A=0 -> decode で NaN
    assert np.isnan(back[1, 3])


def test_flow_fill_depth_code_roundtrip():
    accum = np.full((1, 5), 100.0)
    fill = np.array([[0.0, 0.005, 0.05, 1.96, 20.0]])   # 0.005 は窪地に数えない
    rgba = mod.encode_flow(accum, fill, 1000.0)
    _, back = mod.decode_flow(rgba, 1000.0)
    # 0.005 <= MIN_PIT_DEPTH_M -> コード 0 -> 0.0
    assert back[0, 0] == 0.0
    assert back[0, 1] == 0.0
    assert back[0, 2] == pytest.approx(0.05, abs=0.025 + 1e-6)
    assert back[0, 3] == pytest.approx(1.95, abs=0.025 + 1e-6)
    # 12.70 m で飽和（コード 255）
    assert back[0, 4] == pytest.approx(12.70, abs=1e-6)


def test_flow_conditions_drop_drainage():
    # config の水みちタイル条件に drainage が入っていない（潮位非依存・highres と同じ地形）
    from iwagaki.config import FLOW_TILE_CONDITIONS_BY_AOI
    for conds in FLOW_TILE_CONDITIONS_BY_AOI.values():
        assert "drainage" not in conds
