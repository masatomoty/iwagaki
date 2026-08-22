#!/usr/bin/env python3
"""吉原入江の護岸天端高と「越流が始まる水位」を求める（docs/DATA.md §4 の [未確認]）。

外部資料が見つからなかったので、手持ちの 0.5m DEM から直接測る。

2 つの見方を出す。

1. **越流開始水位** — `h_conn` の定義そのもの。
   h_conn(c) = セル c が海側と連結して浸水し始める最小水位
             = 海から c に至る経路上の「最も低い峰」の高さ。
   つまり **h_conn の最小値が、その領域を守っている護岸の最低天端高**にあたる。
   幾何的にレイを飛ばすより厳密。

2. **天端高の断面** — 水際から陸側 BAND_M の帯で、区画ごとに最大標高を取る。
   (1) の裏付けと、5m 地形が護岸を表現できているかの比較に使う。

粗地形(5m)と高解像度(0.5m)で同じことをやり、差を見る。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, OUT, RES_COARSE, RES_HIGHRES
from iwagaki.raster import Grid, read, upsample_nearest

BAND_M = 6.0          # 水際から陸側にこの距離までを「護岸の帯」とみなす
SEG_M = 20.0          # 天端高断面のサンプリング間隔


def load(name: str) -> np.ndarray:
    a, _, nd = read(OUT / name)
    a[a == nd] = np.nan
    return a


def crest_profile(elev: np.ndarray, water: np.ndarray, res: float) -> np.ndarray:
    """水際から BAND_M 以内の陸側セルについて、区画ごとの最大標高を返す。"""
    land = np.isfinite(elev) & ~water
    dist = ndimage.distance_transform_edt(~water) * res     # 水面からの距離 [m]
    band = land & (dist > 0) & (dist <= BAND_M)
    if not band.any():
        return np.array([])
    step = max(1, int(round(SEG_M / res)))
    h, w = elev.shape
    hh, ww = h // step * step, w // step * step
    e = np.where(band, np.nan_to_num(elev, nan=-9999.0), -9999.0)[:hh, :ww]
    b = band[:hh, :ww]
    blocks_e = e.reshape(hh // step, step, ww // step, step).max(axis=(1, 3))
    blocks_n = b.reshape(hh // step, step, ww // step, step).sum(axis=(1, 3))
    # 帯セルが少なすぎる区画は代表値にしない
    return blocks_e[(blocks_n >= step) & (blocks_e > -9000.0)]


def main() -> int:
    hi = load("dtm_highres_050.tif")
    base_c = load("dtm_baseline_500.tif")
    hc_hi = load("h_conn_highres.tif")
    hc_b = load("h_conn_baseline.tif")
    seed = load("seed_highres_050.tif") > 0.5

    factor = int(round(RES_COARSE / RES_HIGHRES))
    base = upsample_nearest(base_c, factor)
    hc_base = upsample_nearest(hc_b, factor)
    land = ~seed

    # --- 1. 越流開始水位 -------------------------------------------------
    # 水際そのものは「守られていない場所」なので、護岸の内側
    # （水際から BAND_M より奥）の陸域について最小 h_conn を見る
    dist = ndimage.distance_transform_edt(~seed) * RES_HIGHRES
    inland = land & (dist > BAND_M) & np.isfinite(hi)

    def spill(hc: np.ndarray, label: str) -> dict:
        v = hc[inland & np.isfinite(hc)]
        if v.size == 0:
            return {"terrain": label, "n": 0}
        lo = float(v.min())
        mask = inland & np.isfinite(hc) & (hc <= lo + 1e-9)
        rr, cc = np.nonzero(mask)
        x = AOI.xmin + (cc[0] + 0.5) * RES_HIGHRES
        y = AOI.ymax - (rr[0] + 0.5) * RES_HIGHRES
        return {
            "terrain": label,
            "spill_level_m_tp": round(lo, 3),
            "n_cells_at_min": int(mask.sum()),
            "example_epsg6674": [round(x, 1), round(y, 1)],
            "p05": round(float(np.percentile(v, 5)), 3),
            "p50": round(float(np.percentile(v, 50)), 3),
        }

    # --- 2. 天端高の断面 --------------------------------------------------
    prof_hi = crest_profile(hi, seed, RES_HIGHRES)
    prof_base = crest_profile(base, seed, RES_HIGHRES)

    def stats(a: np.ndarray) -> dict:
        if a.size == 0:
            return {"n_segments": 0}
        return {
            "n_segments": int(a.size),
            "min": round(float(a.min()), 3),
            "p05": round(float(np.percentile(a, 5)), 3),
            "p50": round(float(np.percentile(a, 50)), 3),
            "p95": round(float(np.percentile(a, 95)), 3),
            "max": round(float(a.max()), 3),
        }

    report = {
        "aoi": AOI.name,
        "method": {
            "band_m": BAND_M, "segment_m": SEG_M,
            "spill_level":
                "h_conn の定義（海からの経路上の最低の峰）を使う。"
                "水際から band_m より内側の陸域で h_conn の最小値をとる",
            "crest_profile":
                "水際から band_m 以内の陸側セルを segment_m 角の区画に割り、"
                "各区画の最大標高を天端高の代表値とする",
        },
        "spill_level": [spill(hc_hi, "highres_0.5m"), spill(hc_base, "baseline_5m")],
        "crest_profile": {
            "highres_0.5m": stats(prof_hi),
            "baseline_5m": stats(prof_base),
        },
        "caveats": [
            "外部資料（設計天端高）と突き合わせていない。DEM から測った現況の高さである",
            "京都府 DEM は森林資源把握が目的の成果で、市街地の精度は保証されていない",
            "水門・樋門・陸閘は考慮していない。閉まっていれば実際の越流水位は上がる",
        ],
    }
    (OUT / "bank_crest.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report["spill_level"], indent=2, ensure_ascii=False))
    print(json.dumps(report["crest_profile"], indent=2, ensure_ascii=False))
    print(f"\nwrote {OUT / 'bank_crest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
