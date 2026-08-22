#!/usr/bin/env python3
"""実点群から Web 配信用の COPC を作る。

4.98 億点をそのまま COPC にはできない。`writers.copc` は streaming に対応しておらず
（`pdal --showjson --drivers` で確認）全点をメモリに載せるため。
そこで 2 段構えにする。

  1. **間引き**: `filters.crop` + `filters.voxeldownsize` は両方 streaming 可なので、
     20 GB を低メモリで読みながらボクセル間引きした LAZ を書く。
  2. **COPC 化**: 間引き後なら全点をメモリに載せられる。

ボクセル寸法は「見た目が保てる最大」を実測で決める（--calibrate）。
解析用の DTM は scripts/17-19 が別に作っており、こちらは表示専用。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, CRS_ANALYSIS, INTERIM, ROOT

WEB_DATA = ROOT / "web" / "public" / "data"
OUT_NAME = "yoshiwara-backpack-slam.copc.laz"
FILES_WITHOUT_SRS = ("⑧", "⑨")


def readers(files: list[Path]) -> list[dict]:
    out = []
    for f in files:
        r: dict = {"type": "readers.las", "filename": str(f)}
        if f.name[0] in FILES_WITHOUT_SRS:
            r["override_srs"] = CRS_ANALYSIS
        out.append(r)
    return out


def readable(src: Path) -> list[Path]:
    ok = []
    for f in sorted(p for p in src.iterdir() if p.suffix.lower() in (".las", ".laz")):
        r = subprocess.run(["pdal", "info", "--summary", str(f)],
                           capture_output=True, text=True)
        if r.returncode == 0:
            ok.append(f)
        else:
            print(f"skip（PDAL が開けない）: {f.name}")
    return ok


def run(cmd: list[str]) -> None:
    print("$", " ".join(cmd[:3]), "...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr[-2500:])


def count_of(path: Path) -> int:
    r = subprocess.run(["pdal", "info", "--summary", str(path)],
                       capture_output=True, text=True)
    return json.loads(r.stdout)["summary"]["metadata"]["count"]


def thin(files: list[Path], cell: float, out: Path) -> tuple[int, float]:
    pipeline = {"pipeline": [
        *readers(files),
        {"type": "filters.crop",
         "bounds": f"([{AOI.xmin},{AOI.xmax}],[{AOI.ymin},{AOI.ymax}])"},
        {"type": "filters.voxeldownsize", "cell": cell, "mode": "center"},
        {"type": "writers.las", "filename": str(out),
         "compression": "laszip", "a_srs": CRS_ANALYSIS,
         "minor_version": 4, "dataformat_id": 7},
    ]}
    pj = INTERIM / f"thin_{cell:g}.json"
    pj.parent.mkdir(parents=True, exist_ok=True)
    pj.write_text(json.dumps(pipeline, indent=2, ensure_ascii=False))
    t0 = time.time()
    run(["pdal", "pipeline", "--stream", str(pj)])
    return count_of(out), time.time() - t0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("--cell", type=float, default=0.05, help="ボクセル寸法 [m]")
    ap.add_argument("--calibrate", action="store_true",
                    help="1 ファイルで複数のボクセル寸法を試して点数を測るだけ")
    ap.add_argument("--keep-thinned", action="store_true")
    args = ap.parse_args()

    files = readable(args.src)
    if not files:
        raise SystemExit("読める LAS が無い")

    if args.calibrate:
        f = files[:1]
        base = count_of(f[0])
        print(f"calibrate: {f[0].name}  元 {base:,} 点")
        rows = []
        for cell in (0.03, 0.05, 0.10):
            tmp = INTERIM / f"thin_cal_{cell:g}.laz"
            n, dt = thin(f, cell, tmp)
            mb = tmp.stat().st_size / 1e6
            rows.append((cell, n, mb, dt))
            print(f"  cell={cell:>5} m  {n:>12,} 点 ({n/base*100:5.1f}%)  "
                  f"{mb:7.1f} MB  {dt:5.0f} s")
            tmp.unlink()
        print("\n全 9 ファイル（元 497.6M 点）に外挿した見込み:")
        for cell, n, mb, _ in rows:
            k = 497_618_233 / base
            print(f"  cell={cell:>5} m  約 {n*k/1e6:6.1f} M 点  約 {mb*k:7.0f} MB")
        return 0

    thinned = INTERIM / f"yoshiwara_thin_{args.cell:g}.laz"
    print(f"間引き（cell={args.cell} m, streaming）: {len(files)} ファイル")
    n, dt = thin(files, args.cell, thinned)
    print(f"  {n:,} 点  {thinned.stat().st_size/1e6:.0f} MB  {dt:.0f} s")

    out = WEB_DATA / "pointcloud" / OUT_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    cp = {"pipeline": [
        str(thinned),
        {"type": "writers.copc", "filename": str(out), "a_srs": CRS_ANALYSIS},
    ]}
    cj = INTERIM / "copc.json"
    cj.write_text(json.dumps(cp, indent=2))
    t0 = time.time()
    run(["pdal", "pipeline", str(cj)])
    size = out.stat().st_size
    info = json.loads(subprocess.run(["pdal", "info", "--summary", str(out)],
                                     capture_output=True, text=True).stdout)["summary"]
    report = {
        "url": f"data/pointcloud/{OUT_NAME}",
        "synthetic": False,
        "provenance": "舞鶴市吉原 バックパック SLAM（LiBackpack / LiFuser-BP）2026-07 取得。"
                      f"AOI で切り出し、{args.cell} m ボクセルで間引いたもの。表示専用",
        "source_files": [f.name for f in files],
        "voxel_cell_m": args.cell,
        "bytes": size,
        "point_count": info.get("num_points"),
        "bytes_per_point": round(size / max(info.get("num_points") or 1, 1), 3),
        "bounds": info.get("bounds"),
        "copc_build_s": round(time.time() - t0, 1),
    }
    (WEB_DATA / "pointcloud_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not args.keep_thinned:
        thinned.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
