#!/usr/bin/env python3
"""PLATEAU 配布の 3D Tiles から AOI 分だけを切り出す。

市域全体は bldg LOD1 だけで 240 MB / 428 ファイル。AOI(1km四方) に交差する
タイルだけを残し、tileset.json の木も同じ形で刈り込む。ジオメトリは作り直さない。
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pyproj import Transformer

from iwagaki.config import AOI, asset_name, CRS_ANALYSIS, WEB_DATA
from iwagaki.remotezip import open_remote_zip

TILES3D_URL = ("https://assets.cms.plateau.reearth.io/assets/55/2c1991-f75e-4bf8-9108-"
               "531c27952a2b/26202_maizuru-shi_city_2025_3dtiles_mvt_1_op.zip")
SETS = {
    "bldg_lod1": "26202_maizuru-shi_city_2025_citygml_1_op_bldg_3dtiles_lod1",
    "bldg_lod2": "26202_maizuru-shi_city_2025_citygml_1_op_bldg_3dtiles_lod2",
}
# batch table から残すキー -----------------------------------------------------
# PLATEAU の b3dm は batch table JSON に全属性（水系別の洪水浸水想定区域、
# 土砂災害リスク、uro:* など約 70 キー）を持っており、**これが b3dm の 70% を占める**。
# [実測] bldg_lod1 22 タイル 10.64 MB のうち batch table JSON が 7.46 MB。
#
# この viewer が読むのは gml_id と塗り分け用の属性だけ
# （web/src/view/buildingColor.ts の ATTRIBUTE、web/src/view/plateau.ts の colorizeTile）。
# 残りは配信しない。増やす時は buildingColor.ts と揃える。
# 実際に残したキーは 3dtiles_report.json の batch_table_keys に出す。
BATCH_TABLE_KEEP = ("gml_id", "bldg:class", "bldg:usage")


def trim_batch_table(data: bytes) -> bytes:
    """b3dm の batch table を BATCH_TABLE_KEEP だけに絞る。ジオメトリは触らない。

    glTF チャンク（draco 圧縮済み）はバイト列のまま移すだけなので、
    ジオメトリの精度も見た目も変わらない。
    """
    magic, _ver, _blen, ftj, ftb, btj, btb = struct.unpack("<4sIIIIII", data[:28])
    if magic != b"b3dm" or btj == 0:
        return data
    head = 28 + ftj + ftb
    table = json.loads(data[head:head + btj])
    kept = {k: v for k, v in table.items() if k in BATCH_TABLE_KEEP}
    # 残したキーが binary body を参照している（{byteOffset: ...} 形式）なら body ごと残す。
    # 参照が無ければ body は誰も見ないので落とす。
    keep_bin = any(isinstance(v, dict) for v in kept.values())
    body = data[head + btj:head + btj + btb] if keep_bin else b""
    new = json.dumps(kept, ensure_ascii=False, separators=(",", ":")).encode()
    new += b" " * (-len(new) % 8)   # JSON の padding は空白（3D Tiles 1.0）
    out = bytearray(data[:head] + new + body + data[head + btj + btb:])
    struct.pack_into("<I", out, 8, len(out))    # byteLength
    struct.pack_into("<I", out, 20, len(new))   # batchTableJSONByteLength
    struct.pack_into("<I", out, 24, len(body))  # batchTableBinaryByteLength
    return bytes(out)


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
        dest = WEB_DATA / "3dtiles" / asset_name(name)
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "tileset.json").write_text(json.dumps(out_ts, separators=(",", ":")))
        total = 0
        raw_total = 0
        for u in wanted:
            raw = zf.read(f"{prefix}/{u}")
            data = trim_batch_table(raw)
            p = dest / u
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            total += len(data)
            raw_total += len(raw)
        mh = min_height(pruned_root)
        report[name] = {
            "url": f"data/3dtiles/{asset_name(name)}/tileset.json",
            "b3dm_count": len(wanted),
            "bytes": total,
            "bytes_before_batch_table_trim": raw_total,
            "batch_table_keys": list(BATCH_TABLE_KEEP),
            "region_min_height_ellipsoidal_m": round(mh, 3),
        }
        print(f"{name}: {len(wanted)} b3dm, {total/1e6:.2f} MB "
              f"(batch table 削減前 {raw_total/1e6:.2f} MB), "
              f"region minH(ellipsoidal) = {mh:.3f} m")
    (WEB_DATA / asset_name("3dtiles_report.json")).write_text(
        json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
