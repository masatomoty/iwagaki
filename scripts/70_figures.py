#!/usr/bin/env python3
"""結果図を作る（docs/images/）。Web実装前の確認用。

**ファイル名に範囲を入れる。** 入れていなかったので
`IWAGAKI_AOI=higashi_maizuru scripts/run_all.sh` を回すと
**README が貼っている吉原の図を黙って上書きしていた**（2026-08-25）。
既定範囲だけ従来の名前を保つのは配信物と同じ規則（`config.asset_name`）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from iwagaki.config import asset_name, OUT, RES_COARSE, RES_HIGHRES, ROOT

IMG = ROOT / "docs" / "images"
FACTOR = int(round(RES_COARSE / RES_HIGHRES))


def load(p: Path) -> np.ndarray:
    with rasterio.open(p) as s:
        a = s.read(1).astype(float)
        a[a == s.nodata] = np.nan
    return a


def up(a: np.ndarray) -> np.ndarray:
    return np.repeat(np.repeat(a, FACTOR, 0), FACTOR, 1)


def main() -> int:
    IMG.mkdir(parents=True, exist_ok=True)
    hi = load(OUT / "dtm_highres_050.tif")
    hc_hi = load(OUT / "h_conn_highres.tif")
    hc_b = up(load(OUT / "h_conn_baseline.tif"))
    hc_hi[~np.isfinite(hc_hi)] = np.inf
    hc_b[~np.isfinite(hc_b)] = np.inf
    seed = load(OUT / "seed_highres_050.tif") > 0.5

    g = np.clip(np.nan_to_num(hi, nan=0.0) / 6.0, 0, 1)
    base = np.stack([g, g, g], -1) * 0.55 + 0.18
    base[~np.isfinite(hi)] = [0.05, 0.10, 0.22]
    base[seed] = [0.05, 0.14, 0.30]

    for h in (1.0, 1.5, 2.0):
        wb = (hc_b <= h) & ~seed
        wh = (hc_hi <= h) & ~seed
        panels = []
        for mask in (wb, wh):
            img = base.copy()
            img[mask] = [0.15, 0.55, 0.95]
            panels.append((img * 255).astype(np.uint8))
        img = base.copy()
        img[wb & wh] = [0.18, 0.38, 0.62]
        img[wh & ~wb] = [0.95, 0.25, 0.20]
        img[wb & ~wh] = [0.98, 0.85, 0.20]
        panels.append((img * 255).astype(np.uint8))

        # **縦横比を保つ。** 正方形に潰していたので、東舞鶴を 4.0 x 2.5 km に
        # 広げた時点で地形が横に伸びた絵になっていた（2026-08-25）
        W = 430
        H = max(1, int(round(W * panels[0].shape[0] / panels[0].shape[1])))
        ims = [Image.fromarray(p).resize((W, H), Image.NEAREST) for p in panels]
        canvas = Image.new("RGB", (W * 3 + 24, H + 30), (18, 18, 20))
        d = ImageDraw.Draw(canvas)
        titles = [f"A: PLATEAU 5m terrain   wet @ H={h:.1f} m T.P.",
                  f"B: 0.5m LiDAR terrain   wet @ H={h:.1f} m T.P.",
                  "C: red = newly WET   yellow = newly DRY"]
        for i, (im, t) in enumerate(zip(ims, titles)):
            canvas.paste(im, (i * (W + 12), 26))
            d.text((i * (W + 12) + 4, 8), t, fill=(230, 230, 230))
        out = IMG / asset_name(f"flood_compare_H{h:.1f}.png")
        canvas.save(out)
        print("wrote", out.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
