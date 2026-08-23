#!/usr/bin/env python3
"""実点群の被覆と密度を AOI グリッド上で測る。

DTM を作る前に「どこにどれだけ点があるか」を知る必要がある。
バックパック SLAM は歩いた線に沿ってしか点が無いので、
AOI 全面の 0.5m DTM が作れるとは限らない。

writers.gdal は streaming で動くので、20 GB を読んでもメモリは増えない。
1 パスで count（点数）と min（最低 Z）を出す。min は地面の第一近似でもある。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, CRS_ANALYSIS, INTERIM, RES_HIGHRES
from iwagaki.raster import Grid, read

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

_repair = import_module("24_repair_las_evlr")
NotRepairable = _repair.NotRepairable
repair_las = _repair.repair

# SRS が書かれていないファイルは、座標域が他と同じなので同じ CRS とみなす
# （docs/data.md §3。推測ではなく「同一測量の同一出力」という根拠に基づく）
FILES_WITHOUT_SRS = ("⑧", "⑨")


def build_pipeline(files: list[Path], out: Path, res: float, types: str) -> dict:
    grid = Grid.for_aoi(AOI, res)
    readers: list[dict] = []
    for f in files:
        r: dict = {"type": "readers.las", "filename": str(f)}
        if f.name[0] in FILES_WITHOUT_SRS:
            r["override_srs"] = CRS_ANALYSIS
        readers.append(r)
    return {"pipeline": [
        *readers,
        {"type": "filters.crop",
         "bounds": f"([{AOI.xmin},{AOI.xmax}],[{AOI.ymin},{AOI.ymax}])"},
        {"type": "writers.gdal", "filename": str(out),
         "output_type": types, "resolution": res,
         # 既定の radius は resolution*sqrt(2) で、1 点が複数セルに寄与して
         # count が多重計上になる。セルに内接する円にして「そのセルの点」に近づける
         "radius": res * 0.5,
         "origin_x": AOI.xmin, "origin_y": AOI.ymin,
         "width": grid.width, "height": grid.height,
         "nodata": -9999, "data_type": "float32", "gdaldriver": "GTiff"},
    ]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("--res", type=float, default=RES_HIGHRES)
    ap.add_argument("--limit", type=int, default=0, help="ファイル数を絞る（試走用）")
    ap.add_argument("--out", type=Path, default=INTERIM / "pc_coverage.tif")
    args = ap.parse_args()

    files = sorted(p for p in args.src.iterdir() if p.suffix.lower() in (".las", ".laz"))
    # PDAL が開けないものは、直せる壊れ方なら修復コピーを作って使う（scripts/24）。
    # 以前はここで黙って外しており、⑨ が解析からも配信からも抜けたまま気づけなかった。
    # 外したものは pc_coverage.json の dropped_files に必ず残す。
    ok: list[Path] = []
    dropped: list[dict] = []
    for f in files:
        r = subprocess.run(["pdal", "info", "--summary", str(f)],
                           capture_output=True, text=True)
        if r.returncode == 0:
            ok.append(f)
            continue
        err = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "(理由不明)"
        print(f"PDAL が開けない: {f.name}\n  {err}")
        try:
            fixed = repair_las(f, INTERIM / "las_repaired")
        except NotRepairable as e:
            print(f"  修復対象外: {e}")
            dropped.append({"file": f.name, "reason": err, "repair": str(e)})
            continue
        print(f"  修復コピーを使う: {fixed}")
        ok.append(fixed)
    if args.limit:
        ok = ok[: args.limit]
    print(f"{len(ok)} ファイルを 1 パスで走査（res={args.res} m）")

    pj = INTERIM / "pc_coverage_pipeline.json"
    pj.parent.mkdir(parents=True, exist_ok=True)
    pj.write_text(json.dumps(build_pipeline(ok, args.out, args.res, "count,min,max"),
                             indent=2, ensure_ascii=False))
    t0 = time.time()
    r = subprocess.run(["pdal", "pipeline", "--stream", str(pj)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        # streaming が使えないステージがあると失敗する。理由をそのまま出す
        print(r.stderr[-1500:])
        raise SystemExit("pdal pipeline に失敗")
    dt = time.time() - t0
    total_bytes = sum(f.stat().st_size for f in ok)
    print(f"完了 {dt:.0f} s  ({total_bytes/1e9:.1f} GB, {total_bytes/1e6/dt:.0f} MB/s)")

    # writers.gdal は output_type ごとにバンドを作るが、**並びは指定順とは限らない**。
    # 実測では "min, max, count" で返ってきた。band description を見て選ぶ。
    _, grid, nodata = read(args.out)
    import rasterio
    with rasterio.open(args.out) as src:
        descs = list(src.descriptions)
        bands = {descs[i - 1]: src.read(i).astype("float64") for i in range(1, src.count + 1)}
    if "count" not in bands:
        raise SystemExit(f"count バンドが無い。descriptions={descs}")
    cnt = bands["count"]
    cnt[cnt == nodata] = 0
    cnt[~np.isfinite(cnt)] = 0
    cell = grid.cell_area()
    covered = cnt > 0
    report = {
        "files": [f.name for f in ok],
        # 使えなかったファイルを必ず残す。空配列なら「全部入っている」と読める
        "dropped_files": dropped,
        "repaired_files": [f.name for f in ok if f.parent.name == "las_repaired"],
        "resolution_m": args.res,
        "band_descriptions": descs,
        "grid": [grid.height, grid.width],
        "aoi_area_ha": round(grid.height * grid.width * cell / 1e4, 2),
        "covered_cells": int(covered.sum()),
        "covered_ha": round(float(covered.sum()) * cell / 1e4, 2),
        "coverage_fraction_of_aoi": round(float(covered.mean()), 4),
        "points_in_aoi": int(cnt.sum()),
        "density_per_m2": {
            "over_covered_area": round(float(cnt[covered].sum() / (covered.sum() * cell)), 1),
            "p50_per_cell": round(float(np.percentile(cnt[covered], 50)), 1),
            "p95_per_cell": round(float(np.percentile(cnt[covered], 95)), 1),
        },
        "elapsed_s": round(dt, 1),
    }
    (INTERIM / "pc_coverage.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
