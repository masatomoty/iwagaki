#!/usr/bin/env python3
"""LAS/LAZ 点群から 0.5m DTM と COPC を作る（PDAL）。

**未検証**: 点群データが未入手のため実行確認ができていない（docs/DATA.md §3）。
点群を入手したら、まず `--inspect` で CRS・分類・標高の実態を確認すること。

  .venv/bin/python scripts/15_pointcloud_dtm.py path/to/input.laz --inspect
  .venv/bin/python scripts/15_pointcloud_dtm.py path/to/input.laz
  .venv/bin/python scripts/21_build_highres.py --source pointcloud
  scripts/run_all.sh   # 以降は同じ

自前のICP/NDT・segmentationは書かない。地面抽出は PDAL の filters.smrf
(Simple Morphological Filter, Pingel et al. 2013) に任せる。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, CRS_ANALYSIS, INTERIM, NODATA, OUT, RES_HIGHRES

GROUND = 2  # ASPRS classification: 2 = ground


def run(cmd: list[str]) -> str:
    print("$", " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"command failed:\n{p.stderr}")
    return p.stdout


def inspect(src: Path) -> dict:
    """CRS・点数・標高範囲・classification の分布を出す。

    docs/DATA.md §3 の「要確認事項」をこれで埋める。
    """
    info = json.loads(run(["pdal", "info", "--summary", str(src)]))
    summary = info.get("summary", {})
    print(json.dumps({
        "num_points": summary.get("num_points"),
        "bounds": summary.get("bounds"),
        "srs_wkt_head": (summary.get("srs", {}).get("wkt") or "")[:200],
        "dimensions": summary.get("dimensions"),
    }, indent=2))
    hist = json.loads(run(["pdal", "info", "--stats",
                           "--dimensions", "Classification,Z", str(src)]))
    for s in hist.get("stats", {}).get("statistic", []):
        print(f"  {s['name']}: min={s.get('minimum')} max={s.get('maximum')} "
              f"mean={s.get('average')}")
    print("\n確認すべきこと:")
    print("  - 座標参照系は EPSG:6674 か。違うなら --in-srs を指定する")
    print("  - Z は標高(T.P.)か楕円体高か。楕円体高ならジオイド補正が必須")
    print("  - Classification に 2(ground) があるか。無ければ SMRF で抽出する")
    return info


def build_pipeline(src: Path, out_dtm: Path, out_copc: Path | None,
                   use_smrf: bool, in_srs: str | None) -> list:
    grid = {
        "resolution": RES_HIGHRES,
        "origin_x": AOI.xmin,
        "origin_y": AOI.ymin,
        "width": int(round((AOI.xmax - AOI.xmin) / RES_HIGHRES)),
        "height": int(round((AOI.ymax - AOI.ymin) / RES_HIGHRES)),
    }
    reader: dict = {"type": "readers.las", "filename": str(src)}
    if in_srs:
        reader["override_srs"] = in_srs
    stages: list = [reader,
                    {"type": "filters.reprojection", "out_srs": CRS_ANALYSIS}]
    if use_smrf:
        # 未分類の点群。SMRF で地面を推定してから ground だけ残す。
        stages.append({"type": "filters.smrf"})
    stages.append({"type": "filters.range",
                   "limits": f"Classification[{GROUND}:{GROUND}]"})
    stages.append({
        "type": "writers.gdal", "filename": str(out_dtm),
        "output_type": "idw", "window_size": 3, "nodata": NODATA,
        "data_type": "float32", "gdaldriver": "GTiff", **grid,
    })
    if out_copc:
        # COPC は地面のみでなく全点を出す（Web表示用）ので、別パイプラインにする
        pass
    return stages


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("--inspect", action="store_true", help="中身を調べるだけ")
    ap.add_argument("--smrf", action="store_true",
                    help="classification が無い点群。SMRF で地面抽出する")
    ap.add_argument("--in-srs", default=None,
                    help="点群の CRS が未設定/誤りの場合に上書き（例 EPSG:6674）")
    ap.add_argument("--no-copc", action="store_true")
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"not found: {args.input}")
    if args.inspect:
        inspect(args.input)
        return 0

    INTERIM.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    out_dtm = OUT / "dtm_pointcloud_050.tif"
    pipe = {"pipeline": build_pipeline(args.input, out_dtm, None,
                                       args.smrf, args.in_srs)}
    pj = INTERIM / "pdal_dtm.json"
    pj.write_text(json.dumps(pipe, indent=2))
    run(["pdal", "pipeline", str(pj)])
    print("wrote", out_dtm)

    if not args.no_copc:
        out_copc = OUT / "pointcloud.copc.laz"
        reader: dict = {"type": "readers.las", "filename": str(args.input)}
        if args.in_srs:
            reader["override_srs"] = args.in_srs
        cp = {"pipeline": [
            reader,
            {"type": "filters.reprojection", "out_srs": CRS_ANALYSIS},
            {"type": "filters.crop",
             "bounds": f"([{AOI.xmin},{AOI.xmax}],[{AOI.ymin},{AOI.ymax}])"},
            {"type": "writers.copc", "filename": str(out_copc)},
        ]}
        cj = INTERIM / "pdal_copc.json"
        cj.write_text(json.dumps(cp, indent=2))
        run(["pdal", "pipeline", str(cj)])
        print("wrote", out_copc)

    print("\n次: .venv/bin/python scripts/21_build_highres.py --source pointcloud")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
