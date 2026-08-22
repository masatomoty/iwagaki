#!/usr/bin/env python3
"""PLATEAU 舞鶴市 CityGML(914MB) から AOI に必要な 3 メンバーだけを取得する。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import PLATEAU_CITYGML_URL, PLATEAU_MEMBERS, RAW
from iwagaki.remotezip import open_remote_zip

DEST = RAW / "plateau"


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    need = [(k, m) for k, ms in PLATEAU_MEMBERS.items() for m in ms
            if not (DEST / Path(m).name).exists()]
    if not need:
        print("all cached")
    else:
        print(f"opening remote zip: {PLATEAU_CITYGML_URL.rsplit('/', 1)[-1]}")
        zf = open_remote_zip(PLATEAU_CITYGML_URL)
        for kind, member in need:
            out = DEST / Path(member).name
            print(f"  extracting {kind}: {member}")
            with zf.open(member) as src, out.open("wb") as dst:
                total = 0
                while True:
                    chunk = src.read(1 << 22)
                    if not chunk:
                        break
                    dst.write(chunk)
                    total += len(chunk)
                    print(f"\r    {total/1e6:8.1f} MB", end="", flush=True)
            print()
    for kind, members in PLATEAU_MEMBERS.items():
        for member in members:
            p = DEST / Path(member).name
            print(f"  ok {kind}: {p.name}  {p.stat().st_size/1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
