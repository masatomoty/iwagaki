#!/usr/bin/env python3
"""市の高潮被害調査図を面としてモデルに重ねる。

**個人名・住所を含む非公表資料**を元にしているので、出力は
`data/out/city_damage/` に置き、git には入れない。
図面の座標は無いので、**地図上の地名ラベル 3 点**を GCP にして
アフィン変換で近似する。これは「見た目が合うか」を確認するための
暫定ジオリファレンスであり、精度指標は出さない
（`docs/results.md`「地物単位の突き合わせは止まっている」）。

入力画像は `pdfimages` で抽出した次の 2 枚を想定している:

    tmp/pdfs/images/first-003.png
    tmp/pdfs/images/second-004.png

いずれも「高潮被害図面（竹屋・魚屋地区）」の同一ベース地図に
青塗りの被害面が上書きされたものである。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", "/tmp/mplconfig")

import cv2
import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
from matplotlib.lines import Line2D
import matplotlib.pyplot as plt

matplotlib.rcParams["font.family"] = [
    "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo",
]
matplotlib.rcParams["axes.unicode_minus"] = False
import numpy as np
from pyproj import Transformer
from rasterio.plot import plotting_extent
from shapely.geometry import Polygon, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import CRS_ANALYSIS, CRS_LONLAT, OUT, ROOT
from iwagaki.raster import read

# OCR の x,y は画像左上原点に直し、ラベル中心にしてある。
# 対応する実座標は OpenStreetMap の地区代表点（zip コードレベルの近似値）。
GCPS = [
    {"name": "竹屋",   "px": (323.24, 2368.35), "lonlat": (135.3265153, 35.4509104)},
    {"name": "魚屋",   "px": (1361.67, 970.16), "lonlat": (135.3281170, 35.4516170)},
    {"name": "平野屋", "px": (837.36, 3180.50), "lonlat": (135.3276335, 35.4498419)},
]

EVENTS = [
    {"key": "event1", "label": "2026-07-16 第1回", "H": 0.870,
     "image": ROOT / "tmp/pdfs/images/first-003.png"},
    {"key": "event2", "label": "2026-08-09 第2回", "H": 0.860,
     "image": ROOT / "tmp/pdfs/images/second-004.png"},
]


def fit_affine(gcps: list[dict]) -> np.ndarray:
    A = []
    b = []
    for g in gcps:
        x, y = g["px"]
        A += [[x, y, 1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, x, y, 1.0]]
        b += list(g["xy"])
    return np.linalg.lstsq(np.array(A), np.array(b), rcond=None)[0]


def transform_px_to_xy(px: tuple[float, float], m: np.ndarray) -> tuple[float, float]:
    x, y = px
    return float(m[0] * x + m[1] * y + m[2]), float(m[3] * x + m[4] * y + m[5])


def extract_overlay(path: Path, m: np.ndarray, min_area: int = 5000) -> list[Polygon]:
    img = cv2.imread(str(path))
    if img is None:
        raise FileNotFoundError(path)
    mask = cv2.inRange(img, (0, 0, 230), (30, 30, 255))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    for c in contours:
        if cv2.contourArea(c) < min_area:
            continue
        pts = [transform_px_to_xy((float(p[0][0]), float(p[0][1])), m) for p in c]
        poly = Polygon(pts).buffer(0)
        if not poly.is_empty and poly.area > 0:
            polys.append(poly)
    return polys


def main() -> int:
    out_dir = OUT.parent / "city_damage"
    out_dir.mkdir(parents=True, exist_ok=True)

    tf = Transformer.from_crs(CRS_LONLAT, CRS_ANALYSIS, always_xy=True)
    for g in GCPS:
        g["xy"] = tuple(tf.transform(g["lonlat"][0], g["lonlat"][1]))
    m = fit_affine(GCPS)
    print("affine pixel -> EPSG:6674")
    print(np.round(m.reshape(2, 3), 6))

    overlays = {}
    for ev in EVENTS:
        polys = extract_overlay(ev["image"], m)
        overlays[ev["key"]] = polys
        print(f"{ev['key']}: {len(polys)} polygons, area "
              f"{sum(p.area for p in polys):.0f} m2")
        gdf = gpd.GeoDataFrame(
            {"event": [ev['key']] * len(polys), "area_m2": [p.area for p in polys]},
            geometry=polys, crs=CRS_ANALYSIS,
        )
        gdf.to_file(out_dir / f"{ev['key']}_overlay.geojson", driver="GeoJSON")

    dem, grid, nodata = read(OUT / "dtm_highres_050.tif")
    dem[dem == nodata] = np.nan
    s1, _, _ = read(OUT / "h_conn_highres.tif")
    s2, _, _ = read(OUT / "h_conn_drainage_S2.tif")
    ext = plotting_extent(dem, grid.transform)

    # 描画範囲は被害面の外接矩形 + 100 m 余白
    allpolys = [p for polys in overlays.values() for p in polys]
    minx = min(p.bounds[0] for p in allpolys) - 100
    maxx = max(p.bounds[2] for p in allpolys) + 100
    miny = min(p.bounds[1] for p in allpolys) - 100
    maxy = max(p.bounds[3] for p in allpolys) + 100

    fig, axes = plt.subplots(1, 2, figsize=(12, 6), constrained_layout=True)
    for ax, ev in zip(axes, EVENTS):
        H = ev["H"]
        below = dem <= H
        m1 = np.isfinite(s1) & (s1 <= H)
        m2 = np.isfinite(s2) & (s2 <= H) & ~m1
        below_only = below & ~m1 & ~m2

        def show(mask, color, label):
            if mask.any():
                rgba = np.zeros(dem.shape + (4,), dtype=float)
                rgba[mask] = (*matplotlib.colors.to_rgb(color), 0.35)
                ax.imshow(rgba, extent=ext, origin="upper", interpolation="nearest",
                          zorder=1, label=label)

        show(m1, "#3b82f6", "S1（海から地表で連結）")
        show(m2, "#f59e0b", "S2（仮想排水路）")
        show(below_only, "#9ca3af", "潮位以下")

        for p in overlays[ev["key"]]:
            xs, ys = p.exterior.xy
            ax.plot(xs, ys, color="#dc2626", lw=2.0, zorder=3)

        ax.set_xlim(minx, maxx)
        ax.set_ylim(miny, maxy)
        ax.set_aspect("equal")
        ax.set_title(f"{ev['label']}  H={H:.3f} m T.P.")
        ax.set_xlabel("E [m]")
        ax.set_ylabel("N [m]")
        ax.grid(True, alpha=0.2)

    by_label = [
        Line2D([0], [0], color="#3b82f6", lw=6, alpha=0.35,
               label="S1（海から地表で連結）"),
        Line2D([0], [0], color="#f59e0b", lw=6, alpha=0.35,
               label="S2（仮想排水路）"),
        Line2D([0], [0], color="#9ca3af", lw=6, alpha=0.35,
               label="潮位以下"),
        Line2D([0], [0], color="#dc2626", lw=2, label="被害調査図の青塗り"),
    ]
    fig.legend(handles=by_label, loc="outside lower center", ncol=len(by_label))
    fig.suptitle("市の被害調査図とモデルの面比較（暫定ジオリファレンス）")
    fig.savefig(out_dir / "damage_overlay.png", dpi=200, bbox_inches="tight")
    print(f"wrote {out_dir/'damage_overlay.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
