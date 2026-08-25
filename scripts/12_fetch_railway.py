#!/usr/bin/env python3
"""国土数値情報「鉄道」(N02) から AOI 内の線路を切り出す。

**PLATEAU 舞鶴市（2025年度）に鉄道は入っていない** [実測]。配布の `udx/` 配下は
`bldg` 81 / `tran` 83 / `dem` 24 / `fld` 155 / `urf` 21 / `lsld` 10 / `luse` 8 /
`tnm` 7 で、`rwy` が無い（`codelists/Railway_*.xml` だけある）。`tran` の中身も
`tran:Road` だけで `tran:Railway` は 0 件。だから線路は別データセットから取る。

市の要望（2026-08、`高潮表示範囲 (1).pdf`）が **JR 線路を赤破線で示して
「表示範囲の東側をここまで」**というものだったので、**その基準線そのものが
画面に無い**と「どこまで広げたのか」が読めない。

出力は `[lon, lat, 標高]` の LineString で、**標高は 0.5m DEM から焼き込む**。
viewer 側で地形を引き直さずに済み、鉛直強調を掛けても地面から浮かない。
"""
from __future__ import annotations

import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (AOI, asset_name, CRS_ANALYSIS, CRS_LONLAT, OUT, RAW,
                            WEB_DATA)

#: 国土数値情報 鉄道 (N02) の全国版。**14.9 MB しかない**ので丸ごと取る
#: （京都府 DEM のように図郭単位の巨大 zip ではない）。
N02_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip"
N02_MEMBER = "N02-25_GML/UTF-8/N02-25_RailroadSection.geojson"
#: 配布の CRS。`crs` に `urn:ogc:def:crs:EPSG::6668` と明記されている [実測]
N02_CRS = "EPSG:6668"

CACHE = RAW / "ksj" / "N02-25_GML.zip"

#: 頂点をこの間隔[m]まで割る。標高を焼き込むので、粗いと谷や築堤を跨いで浮く
DENSIFY_M = 5.0


def fetch() -> bytes:
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {N02_URL}")
        with urllib.request.urlopen(N02_URL, timeout=300) as r:
            CACHE.write_bytes(r.read())
    print(f"{CACHE.name}  {CACHE.stat().st_size / 1e6:.1f} MB")
    with zipfile.ZipFile(CACHE) as z:
        return z.read(N02_MEMBER)


def clip_to_aoi(line: np.ndarray, b: tuple[float, float, float, float]) -> list[np.ndarray]:
    """AOI 矩形の中に入っている連続区間だけを返す（EPSG:6674 の (n,2)）。

    **必ず `densify()` のあとに呼ぶ。** N02 の頂点間隔は舞鶴周辺で中央 42〜66 m /
    最大 332 m ある [実測] ので、素のまま頂点で切ると矩形の縁が最大 332 m ずれる。
    """
    x0, y0, x1, y1 = b
    inside = (line[:, 0] >= x0) & (line[:, 0] <= x1) & (line[:, 1] >= y0) & (line[:, 1] <= y1)
    out, cur = [], []
    for i, ok in enumerate(inside):
        if ok:
            cur.append(line[i])
        elif cur:
            out.append(np.array(cur))
            cur = []
    if cur:
        out.append(np.array(cur))
    return [s for s in out if len(s) >= 2]


def densify(line: np.ndarray, step: float) -> np.ndarray:
    """折れ線を `step` m 以下の間隔に割る。"""
    out = [line[0]]
    for a, b in zip(line[:-1], line[1:]):
        d = float(np.hypot(*(b - a)))
        n = max(1, int(np.ceil(d / step)))
        for k in range(1, n + 1):
            out.append(a + (b - a) * (k / n))
    return np.array(out)


def sample_elev(xy: np.ndarray) -> np.ndarray:
    """0.5m DEM の標高。nodata は前後の有効値で埋める（線路は連続しているので）。"""
    src = OUT / "dtm_highres_050.tif"
    if not src.exists():
        raise SystemExit(f"{src} が無い。先に scripts/21_build_highres.py を実行する")
    with rasterio.open(src) as ds:
        nodata = ds.nodata
        z = np.array([v[0] for v in ds.sample(xy.tolist())], dtype="float64")
    z[z == nodata] = np.nan
    ok = np.isfinite(z)
    if not ok.any():
        return np.zeros_like(z)
    idx = np.arange(len(z))
    return np.interp(idx, idx[ok], z[ok])


def main() -> int:
    raw = json.loads(fetch().decode("utf-8"))
    fwd = Transformer.from_crs(N02_CRS, CRS_ANALYSIS, always_xy=True)
    back = Transformer.from_crs(CRS_ANALYSIS, CRS_LONLAT, always_xy=True)
    b = AOI.bounds

    feats: list[dict] = []
    total_m = 0.0
    lines_seen: set[tuple[str, str]] = set()
    for f in raw.get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") != "LineString":
            continue
        lon, lat = np.array(g["coordinates"], dtype="float64").T
        x, y = fwd.transform(lon, lat)
        for d in clip_to_aoi(densify(np.column_stack([x, y]), DENSIFY_M), b):
            z = sample_elev(d)
            glon, glat = back.transform(d[:, 0], d[:, 1])
            p = f.get("properties") or {}
            name, op = p.get("N02_003") or "", p.get("N02_004") or ""
            lines_seen.add((name, op))
            total_m += float(np.hypot(*np.diff(d, axis=0).T).sum())
            feats.append({
                "type": "Feature",
                "properties": {"line": name, "operator": op},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(a, 7), round(c, 7), round(float(e), 2)]
                                    for a, c, e in zip(glon, glat, z)],
                },
            })

    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:{CRS_LONLAT}"}},
        "properties": {
            "source": "国土数値情報（鉄道データ）国土交通省",
            "source_url": N02_URL,
            "aoi": AOI.name,
            "length_m": round(total_m, 1),
            "lines": sorted(f"{n}（{o}）" for n, o in lines_seen),
            "elevation": "各頂点の Z は 0.5m DEM (dtm_highres_050.tif) から焼き込んだ標高 [m T.P.]",
            "densify_m": DENSIFY_M,
        },
        "features": feats,
    }
    out = WEB_DATA / asset_name("railway.geojson")
    if not feats:
        # **AOI に線路が無い範囲では何も置かない**（吉原 100 ha がそれ）。
        # 空の FeatureCollection を配ると catalog に凡例だけが出る
        out.unlink(missing_ok=True)
        for stale in WEB_DATA.glob(asset_name("railway") + "-*.geojson"):
            stale.unlink()
        print(f"{AOI.name}: AOI 内に線路が無い。何も置かない")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    print(f"{out.name}: {len(feats)} 区間 / {total_m / 1000:.2f} km / "
          f"{out.stat().st_size / 1e3:.0f} kB")
    for s in fc["properties"]["lines"]:
        print("   ", s)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
