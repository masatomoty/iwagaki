#!/usr/bin/env python3
"""PLATEAU 配布の 3D Tiles から AOI 分だけを切り出す。

市域全体は bldg LOD1 だけで 240 MB / 428 ファイル。AOI(1km四方) に交差する
タイルだけを残し、tileset.json の木も同じ形で刈り込む。ジオメトリは作り直さない。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pyproj import Transformer

from iwagaki.config import AOI, CRS_ANALYSIS, ROOT
from iwagaki.remotezip import open_remote_zip

TILES3D_URL = ("https://assets.cms.plateau.reearth.io/assets/55/2c1991-f75e-4bf8-9108-"
               "531c27952a2b/26202_maizuru-shi_city_2025_3dtiles_mvt_1_op.zip")
SETS = {
    "bldg_lod1": "26202_maizuru-shi_city_2025_citygml_1_op_bldg_3dtiles_lod1",
    "bldg_lod2": "26202_maizuru-shi_city_2025_citygml_1_op_bldg_3dtiles_lod2",
}
WEB_DATA = ROOT / "web" / "public" / "data"


def aoi_region_rad() -> tuple[float, float, float, float]:
    t = Transformer.from_crs(CRS_ANALYSIS, "EPSG:4326", always_xy=True)
    pts = [t.transform(x, y) for x in (AOI.xmin, AOI.xmax) for y in (AOI.ymin, AOI.ymax)]
    lons = [math.radians(p[0]) for p in pts]
    lats = [math.radians(p[1]) for p in pts]
    return min(lons), min(lats), max(lons), max(lats)


def region_intersects(region: list[float], aoi: tuple[float, float, float, float]) -> bool:
    w, s, e, n = region[0], region[1], region[2], region[3]
    return not (e < aoi[0] or w > aoi[2] or n < aoi[1] or s > aoi[3])


def bv_region(node: dict) -> list[float] | None:
    bv = node.get("boundingVolume") or {}
    return bv.get("region")


def prune(node: dict, aoi) -> dict | None:
    """AOI に交差しないノードを落とす。content の region も見る。"""
    reg = bv_region(node)
    if reg is not None and not region_intersects(reg, aoi):
        return None
    out = {k: v for k, v in node.items() if k not in ("children", "content")}
    content = node.get("content")
    if content is not None:
        creg = bv_region(content) or reg
        if creg is None or region_intersects(creg, aoi):
            out["content"] = content
    kids = [prune(c, aoi) for c in node.get("children", [])]
    kids = [k for k in kids if k is not None]
    if kids:
        out["children"] = kids
    if "content" not in out and not kids:
        return None
    return out


def uris(node: dict) -> list[str]:
    got = []
    c = node.get("content")
    if c and c.get("uri"):
        got.append(c["uri"])
    for ch in node.get("children", []):
        got += uris(ch)
    return got


def min_height(node: dict, acc=None) -> float:
    reg = bv_region(node)
    vals = [reg[4]] if reg else []
    for ch in node.get("children", []):
        vals.append(min_height(ch))
    return min(vals) if vals else float("inf")


def main() -> int:
    aoi = aoi_region_rad()
    print("AOI region (rad):", [round(v, 8) for v in aoi])
    zf = open_remote_zip(TILES3D_URL)
    report = {}
    for name, prefix in SETS.items():
        ts = json.loads(zf.read(f"{prefix}/tileset.json"))
        pruned_root = prune(ts["root"], aoi)
        if pruned_root is None:
            print(f"{name}: no tiles intersect AOI")
            continue
        out_ts = {**ts, "root": pruned_root}
        wanted = sorted(set(uris(pruned_root)))
        dest = WEB_DATA / "3dtiles" / name
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "tileset.json").write_text(json.dumps(out_ts, separators=(",", ":")))
        total = 0
        for u in wanted:
            data = zf.read(f"{prefix}/{u}")
            p = dest / u
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            total += len(data)
        mh = min_height(pruned_root)
        report[name] = {
            "url": f"data/3dtiles/{name}/tileset.json",
            "b3dm_count": len(wanted),
            "bytes": total,
            "region_min_height_ellipsoidal_m": round(mh, 3),
        }
        print(f"{name}: {len(wanted)} b3dm, {total/1e6:.2f} MB, "
              f"region minH(ellipsoidal) = {mh:.3f} m")
    (WEB_DATA / "3dtiles_report.json").write_text(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
