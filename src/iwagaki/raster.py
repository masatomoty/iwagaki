"""ラスタ入出力とグリッド定義の薄いヘルパ。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.transform import Affine, from_origin

from .config import CRS_ANALYSIS, NODATA, Aoi


@dataclass(frozen=True)
class Grid:
    transform: Affine
    width: int
    height: int
    res: float
    crs: str = CRS_ANALYSIS

    @classmethod
    def for_aoi(cls, aoi: Aoi, res: float) -> "Grid":
        w = int(round((aoi.xmax - aoi.xmin) / res))
        h = int(round((aoi.ymax - aoi.ymin) / res))
        return cls(from_origin(aoi.xmin, aoi.ymax, res, res), w, h, res)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        x0, y1 = self.transform * (0, 0)
        x1, y0 = self.transform * (self.width, self.height)
        return (x0, y0, x1, y1)

    def cell_area(self) -> float:
        return self.res * self.res

    def xy_centers(self) -> tuple[np.ndarray, np.ndarray]:
        x0, y1 = self.transform * (0.5, 0.5)
        xs = x0 + np.arange(self.width) * self.res
        ys = y1 - np.arange(self.height) * self.res
        return xs, ys


def write(path: Path, arr: np.ndarray, grid: Grid, nodata: float = NODATA) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(arr, dtype="float32")
    with rasterio.open(
        path, "w", driver="GTiff", height=grid.height, width=grid.width, count=1,
        dtype="float32", crs=grid.crs, transform=grid.transform, nodata=nodata,
        compress="deflate", predictor=3, tiled=True, blockxsize=512, blockysize=512,
    ) as dst:
        dst.write(arr, 1)
    return path


def read(path: Path) -> tuple[np.ndarray, Grid, float]:
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float64")
        grid = Grid(src.transform, src.width, src.height, abs(src.transform.a), str(src.crs))
        nodata = src.nodata if src.nodata is not None else NODATA
    return arr, grid, nodata


def mosaic_clip(tifs: list[Path], grid: Grid) -> np.ndarray:
    """タイル群をモザイクして `grid` に合わせて切り出す。nodata は NaN で返す。"""
    srcs = [rasterio.open(p) for p in tifs]
    try:
        data, transform = merge(srcs, bounds=grid.bounds, res=(grid.res, grid.res),
                                nodata=NODATA, resampling=Resampling.nearest)
    finally:
        for s in srcs:
            s.close()
    arr = data[0].astype("float64")
    # merge の出力形状が丸めで 1px ずれることがあるので合わせ込む
    arr = arr[: grid.height, : grid.width]
    if arr.shape != (grid.height, grid.width):
        pad = np.full((grid.height, grid.width), NODATA)
        pad[: arr.shape[0], : arr.shape[1]] = arr
        arr = pad
    arr[arr == NODATA] = np.nan
    return arr


def aggregate(arr: np.ndarray, factor: int) -> np.ndarray:
    """factor x factor の平均で粗くする（NaN 無視）。端は切り捨てる。"""
    h = arr.shape[0] // factor * factor
    w = arr.shape[1] // factor * factor
    blocks = arr[:h, :w].reshape(h // factor, factor, w // factor, factor)
    with np.errstate(invalid="ignore"):
        return np.nanmean(blocks, axis=(1, 3))


def upsample_nearest(arr: np.ndarray, factor: int) -> np.ndarray:
    return np.repeat(np.repeat(arr, factor, axis=0), factor, axis=1)
