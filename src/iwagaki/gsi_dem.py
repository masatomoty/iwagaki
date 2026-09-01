"""国土地理院 標高タイル（数値標高モデル）を取得して解析グリッドに合わせる。

用途は **flow accumulation のルーティング collar 専用**（AOI 外周のバッファ帯。
`src/iwagaki/flow.py` の `route_with_collar`、`docs/data.md` §7「境界の扱いと限界」）。
collar はルーティングにだけ効かせ、窪地の充填深・越流点・容積は AOI 内のセルだけ
集計する。

タイルは `.txt` 形式（256x256 の CSV、標高値 [m]、`"e"` = nodata = 主に海面）を使う。
PNG（`dem_png`）だと RGB→標高のデコードに 1 段増えるだけで情報は同じなので、
テキストのまま扱って依存を増やさない（`requirements.txt` は軽く保つ方針。
`docs/design.md`「重い C++ 依存を足すなら理由を書く」）。

- 主: **DEM5A**（航空レーザ測量 5m。標高タイルのズーム 15）
- 副: **DEM10B**（10m メッシュ。ズーム 14。DEM5A が配信されていないタイルを埋める）

取得したタイルは `data/raw/gsi_dem/<layer>/<z>/<x>/<y>.txt` にキャッシュする
（空ファイル = そのタイルは 404。次回スキップ）。
"""
from __future__ import annotations

import math
import urllib.error
import urllib.request

import numpy as np
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject
from pyproj import Transformer

from .config import GSI_DEM_TILE_LAYERS, GSI_DEM_TILE_URL, NODATA, RAW
from .raster import Grid

_UA = "iwagaki/0.1 (+https://github.com/masatomoty/iwagaki)"
_TILE = 256
_R_EARTH = 6378137.0
_ORIGIN = math.pi * _R_EARTH          # 20037508.342789244 (Web メルカトルの半幅)
_CACHE = RAW / "gsi_dem"


def _deg2tile(lon: float, lat: float, z: int) -> tuple[float, float]:
    """経緯度 -> XYZ タイル座標（分数）。標準の slippy map（Web メルカトル）。"""
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def _mosaic_transform(z: int, x0: int, y0: int) -> Affine:
    """タイル (z, x0, y0) の北西端を原点とする EPSG:3857 のアフィン変換。"""
    span = 2.0 * _ORIGIN / (2.0 ** z)          # 1 タイルの辺長 [m]
    px = span / _TILE
    return Affine(px, 0.0, -_ORIGIN + x0 * span, 0.0, -px, _ORIGIN - y0 * span)


def _fetch_tile(layer: str, z: int, x: int, y: int) -> np.ndarray | None:
    """1 タイルを 256x256 の float32（NaN=nodata）で返す。404 は None。"""
    cache = _CACHE / layer / str(z) / str(x) / f"{y}.txt"
    if cache.exists():
        text = cache.read_text()
    else:
        url = GSI_DEM_TILE_URL.format(layer=layer, z=z, x=x, y=y)
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text("")          # 空 = このタイルは無い
                return None
            raise
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text)
    if not text.strip():
        return None
    rows = [line for line in text.splitlines() if line]
    a = np.array(
        [[np.nan if v == "e" else float(v) for v in line.split(",")] for line in rows],
        dtype="float32",
    )
    if a.shape != (_TILE, _TILE):
        raise ValueError(f"{layer} {z}/{x}/{y}: 期待外の shape {a.shape}")
    return a


def _layer_to_grid(layer: str, z: int, grid: Grid, lonlat: tuple[float, float, float, float]) -> np.ndarray:
    """1 レイヤの標高タイルを覆う範囲だけ取得し、`grid` に再投影して返す。"""
    lon0, lat0, lon1, lat1 = lonlat
    tx0, ty0 = _deg2tile(lon0, lat1, z)        # 北西
    tx1, ty1 = _deg2tile(lon1, lat0, z)        # 南東
    x_lo, x_hi = math.floor(tx0), math.floor(tx1)
    y_lo, y_hi = math.floor(ty0), math.floor(ty1)

    ny = (y_hi - y_lo + 1) * _TILE
    nx = (x_hi - x_lo + 1) * _TILE
    mosaic = np.full((ny, nx), NODATA, dtype="float32")
    got = 0
    for j, ty in enumerate(range(y_lo, y_hi + 1)):
        for i, tx in enumerate(range(x_lo, x_hi + 1)):
            tile = _fetch_tile(layer, z, tx, ty)
            if tile is None:
                continue
            block = np.where(np.isfinite(tile), tile, NODATA)
            mosaic[j * _TILE:(j + 1) * _TILE, i * _TILE:(i + 1) * _TILE] = block
            got += 1

    dst = np.full((grid.height, grid.width), NODATA, dtype="float32")
    if got:
        reproject(
            source=mosaic,
            destination=dst,
            src_transform=_mosaic_transform(z, x_lo, y_lo),
            src_crs="EPSG:3857",
            src_nodata=NODATA,
            dst_transform=grid.transform,
            dst_crs=grid.crs,
            dst_nodata=NODATA,
            resampling=Resampling.bilinear,
        )
    dst[dst == NODATA] = np.nan
    return dst


def collar_dem(grid: Grid) -> np.ndarray:
    """`grid`（解析 CRS）に合わせた GSI DEM。NaN = nodata（主に海面）。

    DEM5A を主に敷き、まだ NaN のセルを DEM10B で埋める。1 セルも取れなければ
    全面 NaN（呼び手はこれを見て collar 無しにフォールバックする）。
    """
    t = Transformer.from_crs(grid.crs, "EPSG:4326", always_xy=True)
    x0, y0, x1, y1 = grid.bounds
    lons, lats = zip(*(t.transform(x, y) for x in (x0, x1) for y in (y0, y1)))
    pad = 0.004                                  # 約 350 m の余裕（端の補間用）
    lonlat = (min(lons) - pad, min(lats) - pad, max(lons) + pad, max(lats) + pad)

    out = np.full((grid.height, grid.width), np.nan, dtype="float32")
    for layer, z in GSI_DEM_TILE_LAYERS:
        need = ~np.isfinite(out)
        if not need.any():
            break
        out[need] = _layer_to_grid(layer, z, grid, lonlat)[need]
    return out
