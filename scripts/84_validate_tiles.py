#!/usr/bin/env python3
"""タイルパッキングの往復検証（docs/web_design.md「正しさを守るテスト」）。

GeoTIFF -> PNG タイル -> デコード が値を保つことを確認する。
premultiply 事故やビット詰めのミスは絵を見ても気づけないので、数値で押さえる。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iwagaki.config import (asset_name, H_STEP, OUT, ROOT, WEB_CONDITIONS,
                            WEB_FLOW_CONDITIONS)

mod = __import__("80_build_web_tiles")
CONDITIONS, WEB_DATA, sample, decode = mod.CONDITIONS, mod.WEB_DATA, mod.sample, mod.decode
FLOW_CONDITIONS, decode_flow = mod.FLOW_CONDITIONS, mod.decode_flow

ELEV_TOL = 1.0 / 256.0 + 1e-9
MAX_TILES = 12


def tile_dir(cond: str):
    """
    その条件のタイルの置き場。**名前は 2 通りある。**

    `scripts/80` は素の名前（範囲の接頭辞つき）で書き、`scripts/83` が
    内容ハッシュを足して改名する。ここは両方を受ける。
    見ていなかったので、**83 を通したあとに回すと 0 枚で「0 failures」を
    返していた**（範囲を増やして実際に踏んだ）。
    """
    base = asset_name(cond)
    d = WEB_DATA / "tiles" / base
    if d.is_dir():
        return d
    hashed = sorted(x for x in (WEB_DATA / "tiles").glob(f"{base}-*") if x.is_dir())
    return hashed[-1] if hashed else None


def main() -> int:
    fails = 0
    checked = 0
    # 範囲によって焼く条件が違う（config.CONDITIONS_BY_AOI）
    for cond in WEB_CONDITIONS:
        dtm, hconn_f = CONDITIONS[cond]
        d = tile_dir(cond)
        if d is None:
            print(f"FAIL {cond}: タイルのディレクトリが無い（scripts/80 を先に回す）")
            fails += 1
            continue
        tiles = sorted(d.rglob("*.png"))
        step = max(1, len(tiles) // MAX_TILES)
        for p in tiles[::step][:MAX_TILES]:
            y = int(p.stem)
            x = int(p.parent.name)
            z = int(p.parent.parent.name)
            elev_src, _ = sample(OUT / dtm, z, x, y, Resampling.nearest)
            hc_src, _ = sample(OUT / hconn_f, z, x, y, Resampling.nearest)
            rgba = np.asarray(Image.open(p).convert("RGBA"))
            elev_rt, hc_rt = decode(rgba)
            checked += 1

            m = np.isfinite(elev_src)
            if m.any():
                d = np.abs(elev_rt[m] - elev_src[m])
                if not np.isfinite(d).all() or d.max() > ELEV_TOL:
                    print(f"FAIL elev {cond} {z}/{x}/{y}: max|d|={np.nanmax(d):.6f}")
                    fails += 1
            if (~m).any() and np.isfinite(elev_rt[~m]).any():
                print(f"FAIL elev-nodata {cond} {z}/{x}/{y}")
                fails += 1

            mh = np.isfinite(hc_src)
            if mh.any():
                d = np.abs(hc_rt[mh] - hc_src[mh])
                if not np.isfinite(d).all() or d.max() > H_STEP / 2 + 1e-9:
                    print(f"FAIL hconn {cond} {z}/{x}/{y}: max|d|={np.nanmax(d):.6f}")
                    fails += 1
            if (~mh).any() and np.isfinite(hc_rt[~mh]).any():
                print(f"FAIL hconn-nodata {cond} {z}/{x}/{y}")
                fails += 1

    # --- 水みち／窪地タイル ------------------------------------------------
    #
    # 8bit log 量子化なので `accum` の絶対誤差は見ない。**log 正規化値**が
    # 1/255 以内で往復すること、充填深コードが H_STEP/2 以内で戻ることを見る。
    for cond in WEB_FLOW_CONDITIONS:
        accum_f, fill_f = FLOW_CONDITIONS[cond]
        d = tile_dir(f"flow_{cond}")
        if d is None:
            print(f"FAIL flow_{cond}: タイルのディレクトリが無い（scripts/80 を先に回す）")
            fails += 1
            continue
        with rasterio.open(OUT / accum_f) as src:
            a = src.read(1).astype("float64")
            nd = src.nodata
        if nd is not None:
            a[a == nd] = np.nan
        accum_max = float(np.nanmax(a)) if np.isfinite(a).any() else 1.0
        denom = np.log1p(max(accum_max, 1.0))

        tiles = sorted(d.rglob("*.png"))
        step = max(1, len(tiles) // MAX_TILES)
        for p in tiles[::step][:MAX_TILES]:
            y, x, z = int(p.stem), int(p.parent.name), int(p.parent.parent.name)
            accum_src, _ = sample(OUT / accum_f, z, x, y, Resampling.nearest)
            fill_src, _ = sample(OUT / fill_f, z, x, y, Resampling.nearest)
            rgba = np.asarray(Image.open(p).convert("RGBA"))
            accum_rt, fill_rt = decode_flow(rgba, accum_max)
            checked += 1

            m = np.isfinite(accum_src)
            if m.any():
                t_src = np.log1p(np.clip(accum_src[m], 0.0, None)) / denom
                t_rt = np.log1p(np.clip(accum_rt[m], 0.0, None)) / denom
                dd = np.abs(t_rt - t_src)
                if not np.isfinite(dd).all() or dd.max() > 1.0 / 255 + 1e-6:
                    print(f"FAIL flow {cond} {z}/{x}/{y}: max|d(log)|={np.nanmax(dd):.5f}")
                    fails += 1
            # 窪地セル（fill_depth > 0.01）だけコードの往復を見る。
            # **充填深は連続値**なので半ステップの量子化誤差はそのまま出る（h_conn は
            # 解析側で 0.05 量子化済みだったが、こちらは違う）。許容は半ステップ + 丸め ULP。
            mp = np.isfinite(fill_src) & (fill_src > 0.01)
            if mp.any():
                dd = np.abs(fill_rt[mp] - fill_src[mp])
                if not np.isfinite(dd).all() or dd.max() > H_STEP / 2 + 1e-6:
                    print(f"FAIL flow-fill {cond} {z}/{x}/{y}: max|d|={np.nanmax(dd):.4f}")
                    fails += 1

    print(f"checked {checked} tiles, {fails} failures "
          f"(elev tol {ELEV_TOL:.6f} m, hconn tol {H_STEP/2} m, "
          f"flow log tol {1/255:.4f})")
    # **1 枚も見ていないのに成功を返してはいけない。** 検証していないことと
    # 検証して通ったことは別物である
    if checked == 0:
        print("FAIL: 検証できたタイルが 0 枚。名前の解決か焼き直しの順序を確かめる")
        return 1
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
