#!/usr/bin/env python3
"""解析ラスタ -> Web 配信用 RGBA タイル（docs/web_design.md「RGBA タイルのパッキング」）。

1 タイル = 1 地形条件。RGB に標高(Terrarium)、A に h_conn コードを詰める。

    RGB  elev_m = (R*256 + G + B/256) - 32768        精度 1/256 m
         nodata は R=G=B=0 (= -32768 m) を予約
    A    0        -> どの水位でも浸水しない（未到達）
         1..255   -> h_conn = (A-1) * H_STEP

elev と h_conn が必ず同一ピクセルで整合し、リクエスト数も半分になる。
ブラウザ側は premultiplyAlpha:'none' で読むこと（さもないと RGB が壊れる）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, CRS_ANALYSIS, H_STEP, OUT, ROOT

WEB_DATA = ROOT / "web" / "public" / "data"
TILE = 256
R_EARTH = 6378137.0
ORIGIN = math.pi * R_EARTH        # 20037508.342789244

# 解析が持っている 4 条件をすべて配信する。
# 以前は baseline / highres の 2 つしか焼いておらず、**点群を融合した地形の
# 浸水判定を viewer から一切見られなかった**（docs/todo.md A1）。
# control は「解像度だけを落とした highres」で、データ源と解像度のどちらが
# 効いているかを切り分けるための条件（docs/design.md「地形の生成」）。
CONDITIONS = {
    "baseline": ("dtm_baseline_500.tif", "h_conn_baseline.tif"),
    "highres": ("dtm_highres_050.tif", "h_conn_highres.tif"),
    "control": ("dtm_control_500.tif", "h_conn_control.tif"),
    "pointcloud": ("dtm_pointcloud_050.tif", "h_conn_pointcloud.tif"),
}

# 差分は 2 条件の h_conn だけあれば任意の水位で判定できる（浸水深は使わない）。
# 専用ピラミッドを 1 枚作っておけば、ブラウザ側のシェーダは常に単一テクスチャで済む。
#   R = h_conn(左) コード, G = h_conn(右) コード, B = 0, A = 255
#
# 2 組焼く。1 つ目が「PLATEAU 5m と 0.5m DEM の差」、
# 2 つ目が「0.5m DEM と点群融合地形の差」= 点群が何を変えたか。
DIFFS = {
    "diff": ("h_conn_baseline.tif", "h_conn_highres.tif"),
    "diff_pc": ("h_conn_highres.tif", "h_conn_pointcloud.tif"),
}

# 差分モードで地形メッシュの形を取る条件（viewer の domain/terrain.ts と同じ規則）。
# 焼く枚数をその条件に合わせるために使う
GEOMETRY_FOR_DIFF = {
    "diff": "dtm_highres_050.tif",
    "diff_pc": "dtm_pointcloud_050.tif",
}


def lonlat_to_3857(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * R_EARTH
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R_EARTH
    return x, y


def tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 2 ** z
    span = 2 * ORIGIN / n
    return (-ORIGIN + x * span, ORIGIN - (y + 1) * span,
            -ORIGIN + (x + 1) * span, ORIGIN - y * span)


def tiles_for_bounds(b3857, z: int):
    n = 2 ** z
    span = 2 * ORIGIN / n
    x0 = int((b3857[0] + ORIGIN) // span)
    x1 = int((b3857[2] + ORIGIN) // span)
    y0 = int((ORIGIN - b3857[3]) // span)
    y1 = int((ORIGIN - b3857[1]) // span)
    for y in range(max(y0, 0), min(y1, n - 1) + 1):
        for x in range(max(x0, 0), min(x1, n - 1) + 1):
            yield z, x, y


def sample(src_path: Path, z: int, x: int, y: int, resampling) -> tuple[np.ndarray, float]:
    with rasterio.open(src_path) as src:
        dst = np.full((TILE, TILE), np.nan, dtype="float32")
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_crs=CRS_ANALYSIS,
            dst_crs="EPSG:3857",
            dst_transform=from_bounds(*tile_bounds_3857(z, x, y), TILE, TILE),
            dst_nodata=np.nan,
            resampling=resampling,
        )
        nodata = src.nodata
    if nodata is not None:
        dst[dst == nodata] = np.nan
    return dst, nodata


def encode(elev: np.ndarray, hconn: np.ndarray) -> np.ndarray:
    """Terrarium(RGB) + h_conn コード(A) に詰める。"""
    rgba = np.zeros((TILE, TILE, 4), dtype=np.uint8)
    ok = np.isfinite(elev)
    # NaN を先に潰してから整数化する（np.where は両枝を評価するため）
    v = np.clip(np.nan_to_num(elev, nan=0.0) + 32768.0, 1.0, 65535.99)
    vi = np.floor(v).astype(np.int32)
    frac = np.floor((v - vi) * 256.0).astype(np.int32)
    rgba[..., 0] = np.where(ok, vi >> 8, 0)
    rgba[..., 1] = np.where(ok, vi & 0xFF, 0)
    rgba[..., 2] = np.where(ok, frac, 0)
    reached = np.isfinite(hconn)
    code = np.clip(
        np.round(np.nan_to_num(hconn, nan=0.0) / H_STEP).astype(np.int32) + 1, 1, 255)
    rgba[..., 3] = np.where(reached, code, 0)
    return rgba


def hconn_code(hconn: np.ndarray) -> np.ndarray:
    reached = np.isfinite(hconn)
    code = np.clip(
        np.round(np.nan_to_num(hconn, nan=0.0) / H_STEP).astype(np.int32) + 1, 1, 255)
    return np.where(reached, code, 0).astype(np.uint8)


def encode_diff(hb: np.ndarray, hh: np.ndarray) -> np.ndarray:
    rgba = np.zeros((TILE, TILE, 4), dtype=np.uint8)
    rgba[..., 0] = hconn_code(hb)
    rgba[..., 1] = hconn_code(hh)
    rgba[..., 3] = 255          # 不透明にして premultiply の影響を受けないようにする
    return rgba


def decode(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """検証用。encode の逆。"""
    r, g, b, a = (rgba[..., i].astype(np.float64) for i in range(4))
    elev = r * 256.0 + g + b / 256.0 - 32768.0
    elev[(r == 0) & (g == 0) & (b == 0)] = np.nan
    hconn = np.where(a == 0, np.nan, (a - 1) * H_STEP)
    return elev, hconn


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-zoom", type=int, default=14)
    ap.add_argument("--max-zoom", type=int, default=18)
    args = ap.parse_args()

    # AOI を 3857 に
    with rasterio.open(OUT / "dtm_highres_050.tif") as src:
        pass
    from pyproj import Transformer
    t = Transformer.from_crs(CRS_ANALYSIS, "EPSG:4326", always_xy=True)
    corners = [t.transform(x, y) for x in (AOI.xmin, AOI.xmax) for y in (AOI.ymin, AOI.ymax)]
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    b3857 = (*lonlat_to_3857(min(lons), min(lats)), *lonlat_to_3857(max(lons), max(lats)))

    report: dict = {"h_step": H_STEP, "tile_size": TILE, "conditions": {}}
    for cond, (dtm, hconn_f) in CONDITIONS.items():
        outdir = WEB_DATA / "tiles" / cond
        n_tiles = 0
        total = 0
        per_zoom = {}
        for z in range(args.min_zoom, args.max_zoom + 1):
            zn = zt = 0
            for _, x, y in tiles_for_bounds(b3857, z):
                elev, _ = sample(OUT / dtm, z, x, y, Resampling.nearest)
                hc, _ = sample(OUT / hconn_f, z, x, y, Resampling.nearest)
                if not np.isfinite(elev).any() and not np.isfinite(hc).any():
                    continue
                rgba = encode(elev, hc)
                p = outdir / str(z) / str(x) / f"{y}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, "RGBA").save(p, "PNG", optimize=True)
                sz = p.stat().st_size
                zn += 1
                zt += sz
            per_zoom[z] = {"tiles": zn, "bytes": zt}
            n_tiles += zn
            total += zt
            print(f"  {cond} z{z}: {zn} tiles, {zt/1e3:.0f} kB")
        report["conditions"][cond] = {
            "tiles": n_tiles, "bytes": total,
            "min_zoom": args.min_zoom, "max_zoom": args.max_zoom,
            "per_zoom": per_zoom,
            "url": f"data/tiles/{cond}/{{z}}/{{x}}/{{y}}.png",
        }
        print(f"{cond}: {n_tiles} tiles, {total/1e6:.2f} MB")

    # --- 差分ピラミッド ---------------------------------------------------
    for name, (left, right) in DIFFS.items():
        outdir = WEB_DATA / "tiles" / name
        n_tiles = total = 0
        per_zoom = {}
        for z in range(args.min_zoom, args.max_zoom + 1):
            zn = zt = 0
            for _, x, y in tiles_for_bounds(b3857, z):
                hb, _ = sample(OUT / left, z, x, y, Resampling.nearest)
                hh, _ = sample(OUT / right, z, x, y, Resampling.nearest)
                # **地形条件と同じ枚数を焼く。**
                # 以前は「両条件とも h_conn が無いタイル」を落としていたので
                # 地形 131 枚に対し差分 101 枚になり、差分モードで存在しない
                # タイルへの 404 が毎回出ていた（docs/todo.md F3）。
                # 標高があるなら地形メッシュは描かれるので、差分タイルも要る。
                # 中身が全て「どちらも浸水しない」でも PNG は数百バイトにしかならない。
                elev, _ = sample(OUT / GEOMETRY_FOR_DIFF[name], z, x, y, Resampling.nearest)
                if (not np.isfinite(elev).any()
                        and not np.isfinite(hb).any() and not np.isfinite(hh).any()):
                    continue
                p = outdir / str(z) / str(x) / f"{y}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(encode_diff(hb, hh), "RGBA").save(p, "PNG", optimize=True)
                zn += 1
                zt += p.stat().st_size
            per_zoom[z] = {"tiles": zn, "bytes": zt}
            n_tiles += zn
            total += zt
            print(f"  {name} z{z}: {zn} tiles, {zt/1e3:.0f} kB")
        report["conditions"][name] = {
            "tiles": n_tiles, "bytes": total,
            "min_zoom": args.min_zoom, "max_zoom": args.max_zoom,
            "per_zoom": per_zoom,
            "url": f"data/tiles/{name}/{{z}}/{{x}}/{{y}}.png",
            "packing": f"R=hconn({left[7:-4]}) code, G=hconn({right[7:-4]}) code, A=255",
        }
        print(f"{name}: {n_tiles} tiles, {total/1e6:.2f} MB")

    (WEB_DATA / "tiles_report.json").parent.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "tiles_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: {"tiles": v["tiles"], "MB": round(v["bytes"]/1e6, 2)}
                      for k, v in report["conditions"].items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
