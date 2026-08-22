#!/usr/bin/env python3
"""EVLR 宣言が壊れた LAS の修復コピーを作る。**原本は変更しない。**

⑨2026-07-14-14-31-19_result_085559.las で PDAL が
`readers.las: EVLR 1(/64139) size too large -- exceeds file size` を出して開けない。

調べた実態（実測）:
  ファイルサイズ        2,108,160,220
  EVLR offset (byte 235) 2,108,160,159
  EVLR count  (byte 243) 1
  点データの終端         375 + 58,559,994 × 36 = 2,108,160,159  ← EVLR offset と一致
  末尾 61 バイト         EVLR ヘッダ(60 B)として解釈すると record_id=64139、
                        宣言長 68,719,476,737 B（ファイルの 32 倍）。ただのゴミ。

つまり **点データ本体は無傷**で、書き出し側（LiFuser-BP）が EVLR を書き損じている。
EVLR の宣言を消して末尾のゴミを落とせば、点は 1 点も失わずに読める。

黙って直すと「読めなかったものを読めることにした」ことが後から追えないので、
- 原本は read-only で開くだけ。書き換えない
- 「点データ終端が EVLR offset とちょうど一致する」ことを確認できた場合だけ直す。
  一致しなければ壊れ方が想定と違うので、直さずに落とす
- APFS の clone（cp -c）を使い、2 GB の実コピーを避ける（差分ブロックだけ確保される）
"""
from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
from pathlib import Path

# LAS 1.4 public header block のオフセット
OFF_VERSION_MAJOR = 24
OFF_VERSION_MINOR = 25
OFF_HEADER_SIZE = 94
OFF_POINT_DATA_OFFSET = 96
OFF_POINT_RECORD_LENGTH = 105
OFF_EVLR_OFFSET = 235
OFF_EVLR_COUNT = 243
OFF_POINT_COUNT_14 = 247
HEADER_READ_BYTES = 375


class NotRepairable(Exception):
    """壊れ方が想定と違う。黙って直さずに呼び出し側へ返す"""


def diagnose(src: Path) -> dict:
    size = src.stat().st_size
    with src.open("rb") as f:
        h = f.read(HEADER_READ_BYTES)
    if len(h) < HEADER_READ_BYTES or h[:4] != b"LASF":
        raise NotRepairable(f"{src.name}: LAS ではない")
    ver = (h[OFF_VERSION_MAJOR], h[OFF_VERSION_MINOR])
    if ver != (1, 4):
        raise NotRepairable(f"{src.name}: LAS {ver[0]}.{ver[1]} は対象外（EVLR は 1.4 の機能）")
    point_offset = struct.unpack_from("<I", h, OFF_POINT_DATA_OFFSET)[0]
    record_length = struct.unpack_from("<H", h, OFF_POINT_RECORD_LENGTH)[0]
    evlr_offset = struct.unpack_from("<Q", h, OFF_EVLR_OFFSET)[0]
    evlr_count = struct.unpack_from("<I", h, OFF_EVLR_COUNT)[0]
    n_points = struct.unpack_from("<Q", h, OFF_POINT_COUNT_14)[0]
    return {
        "file_size": size,
        "point_data_offset": point_offset,
        "point_record_length": record_length,
        "point_count": n_points,
        "point_data_end": point_offset + n_points * record_length,
        "evlr_offset": evlr_offset,
        "evlr_count": evlr_count,
    }


def check_repairable(d: dict, name: str) -> None:
    if d["evlr_count"] == 0:
        raise NotRepairable(f"{name}: EVLR を宣言していない。この壊れ方ではない")
    if d["point_data_end"] != d["evlr_offset"]:
        raise NotRepairable(
            f"{name}: 点データ終端 {d['point_data_end']} が EVLR offset "
            f"{d['evlr_offset']} と一致しない。点データ側も壊れている可能性があるので直さない")
    if d["evlr_offset"] > d["file_size"]:
        raise NotRepairable(f"{name}: EVLR offset がファイル外")
    if d["point_data_end"] > d["file_size"]:
        raise NotRepairable(
            f"{name}: 宣言された点数 {d['point_count']} 分のデータがファイルに無い（切り詰められている）")


def clone(src: Path, dst: Path) -> None:
    """APFS の copy-on-write clone。使えなければ通常コピーに落とす"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    r = subprocess.run(["cp", "-c", str(src), str(dst)], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  clone 不可（{r.stderr.strip()[:80]}）。通常コピーする")
        shutil.copyfile(src, dst)


def repair(src: Path, out_dir: Path, verify: bool = True) -> Path:
    """修復コピーのパスを返す。原本は開くだけで書き換えない"""
    d = diagnose(src)
    check_repairable(d, src.name)
    dst = out_dir / src.name
    print(f"  修復: {src.name}")
    print(f"    EVLR count {d['evlr_count']} -> 0, 末尾 {d['file_size'] - d['evlr_offset']} B を落とす")
    clone(src, dst)
    with dst.open("r+b") as f:
        f.seek(OFF_EVLR_OFFSET)
        f.write(struct.pack("<Q", 0))       # EVLR offset
        f.write(struct.pack("<I", 0))       # EVLR count（隣接しているのでそのまま続けて書ける）
        f.truncate(d["evlr_offset"])
    if verify:
        r = subprocess.run(["pdal", "info", "--summary", str(dst)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"修復後も PDAL が開けない:\n{r.stderr[-1500:]}")
        print("    PDAL で読めることを確認")
    return dst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True, help="修復コピーの置き場")
    args = ap.parse_args()
    for f in args.files:
        d = diagnose(f)
        print(f"{f.name}: {d}")
        try:
            check_repairable(d, f.name)
        except NotRepairable as e:
            print(f"  対象外: {e}")
            continue
        repair(f, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
