#!/usr/bin/env python3
"""京都府 数値標高モデル(DEM) 0.5m から AOI を覆うタイルだけを取得する。

図郭zipは 3.7〜10.7 GB あるので全体は落とさない。HTTP Range で central directory を
読み、対象メンバー(.tif/.tfw)だけ抜き出す。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, KYOTO_DEM_ZIPS, RAW
from iwagaki.kokudo import tiles_covering
from iwagaki.remotezip import open_remote_zip

DEST = RAW / "kyoto_dem"


def member_names(zf, sheet: str, code: str) -> list[str]:
    """zip 内でのメンバー名は図郭zipによって接頭辞が異なる（dem_ 付き/無し）。"""
    names = set(zf.namelist())
    out = []
    for ext in (".tif", ".tfw"):
        for cand in (f"{sheet}/dem_{sheet}{code}{ext}", f"{sheet}/{sheet}{code}{ext}"):
            if cand in names:
                out.append(cand)
                break
        else:
            raise FileNotFoundError(f"{sheet}{code}{ext} not found in zip")
    return out


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    tiles = tiles_covering(*AOI.bounds, sheets=tuple(KYOTO_DEM_ZIPS))
    by_sheet: dict[str, list] = {}
    for t in tiles:
        by_sheet.setdefault(t.sheet, []).append(t)

    print(f"AOI {AOI.name} {AOI.bounds} -> {len(tiles)} tiles")
    for sheet, group in by_sheet.items():
        need = [t for t in group if not (DEST / f"{t.name}.tif").exists()]
        if not need:
            print(f"  {sheet}: all cached")
            continue
        print(f"  {sheet}: opening remote zip ({len(need)} tiles needed)")
        zf = open_remote_zip(KYOTO_DEM_ZIPS[sheet])
        for t in need:
            for m in member_names(zf, t.sheet, t.code):
                data = zf.read(m)
                out = DEST / f"{t.name}{Path(m).suffix}"
                out.write_bytes(data)
                print(f"    {out.name}  {len(data)/1e6:.1f} MB")
    for t in tiles:
        p = DEST / f"{t.name}.tif"
        print(f"  ok {p.relative_to(RAW.parent.parent)}  bounds={t.bounds}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
