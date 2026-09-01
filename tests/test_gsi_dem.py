"""src/iwagaki/gsi_dem.py の collar フェッチャ。**ネットワークには触らない**
（`urlopen` を monkeypatch する）。実データでの被覆は PR 本文の数値で確認する。
"""
from __future__ import annotations

import urllib.error

import numpy as np
import pytest
from rasterio.transform import from_origin

from iwagaki import gsi_dem
from iwagaki.config import CRS_ANALYSIS
from iwagaki.raster import Grid


def _grid() -> Grid:
    # 舞鶴あたりの小さいグリッド（EPSG:6674, 40x40 @ 5 m）
    return Grid(from_origin(-61500.0, -59500.0, 5.0, 5.0), 40, 40, 5.0, CRS_ANALYSIS)


def test_offline_raises_gsi_tiles_unavailable(monkeypatch, tmp_path):
    monkeypatch.setattr(gsi_dem, "_CACHE", tmp_path / "gsi_dem")

    def boom(*_a, **_k):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    # scripts/33 の _route はこれを受けて collar 無しに落とす（collar_used=false）
    with pytest.raises(gsi_dem.GsiTilesUnavailable):
        gsi_dem.collar_dem(_grid())


def test_network_error_is_not_cached(monkeypatch, tmp_path):
    cache = tmp_path / "gsi_dem"
    monkeypatch.setattr(gsi_dem, "_CACHE", cache)
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(TimeoutError("slow")),
    )
    with pytest.raises(gsi_dem.GsiTilesUnavailable):
        gsi_dem._fetch_tile("dem5a", 15, 28703, 12921)
    # 一過性なのでキャッシュを残さない（次回リトライされる）
    assert not (cache / "dem5a" / "15" / "28703" / "12921.txt").exists()


def test_all_404_returns_all_nan_not_exception(monkeypatch, tmp_path):
    monkeypatch.setattr(gsi_dem, "_CACHE", tmp_path / "gsi_dem")

    def not_found(*_a, **_k):
        raise urllib.error.HTTPError("u", 404, "not found", {}, None)

    monkeypatch.setattr("urllib.request.urlopen", not_found)
    # サーバには届いたが範囲がすべて配信外 -> 例外ではなく全面 NaN
    out = gsi_dem.collar_dem(_grid())
    assert out.shape == (40, 40)
    assert not np.isfinite(out).any()


def test_partial_fetch_survives_late_network_drop(monkeypatch, tmp_path):
    """DEM5A は取れたが DEM10B の取得中に切れた -> 部分成果（DEM5A）を返す。"""
    monkeypatch.setattr(gsi_dem, "_CACHE", tmp_path / "gsi_dem")

    calls = {"n": 0}
    tile = np.full((gsi_dem._TILE, gsi_dem._TILE), 12.5, dtype="float32")

    def fake(layer, z, x, y):
        calls["n"] += 1
        if layer == "dem5a":
            return tile.copy()
        raise gsi_dem.GsiTilesUnavailable("dropped mid-way")

    monkeypatch.setattr(gsi_dem, "_fetch_tile", fake)
    out = gsi_dem.collar_dem(_grid())
    assert np.isfinite(out).all()
    assert np.allclose(out[np.isfinite(out)], 12.5)
