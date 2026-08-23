#!/usr/bin/env python3
"""配信検証用の COPC を 0.5m DTM から生成する。

**これは観測データではない。** 舞鶴の公開 LAS/LAZ は存在せず（docs/DATA.md §3）、
実点群は別途提供予定。それまでの間、ネットワーク／LOD／デコードの経路を
実際に動かして計測するための **負荷源** として、DTM の各セルを 1 点に変換したものを使う。

- 生成物のファイル名・catalog・UI すべてに `synthetic-from-dtm` を明示する。
- 解析には一切使わない。
- 実 LAS が来たら scripts/15_pointcloud_dtm.py の出力に差し替える（catalog のキーは同じ）。

ラスタ→点群の変換は PDAL readers.gdal に任せる（自前で LAS を書かない）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import CRS_ANALYSIS, INTERIM, OUT, ROOT

WEB_DATA = ROOT / "web" / "public" / "data"
OUT_NAME = "yoshiwara-synthetic-from-dtm.copc.laz"


def run(cmd: list[str]) -> str:
    print("$", " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"failed:\n{p.stderr[-4000:]}")
    return p.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=OUT / "dtm_highres_050.tif")
    args = ap.parse_args()

    dest = WEB_DATA / "pointcloud"
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / OUT_NAME
    INTERIM.mkdir(parents=True, exist_ok=True)

    pipeline = {"pipeline": [
        {"type": "readers.gdal", "filename": str(args.src), "header": "Z"},
        # nodata(-9999) を落とす。AOI の海域は点を持たない
        {"type": "filters.range", "limits": "Z[-100:1000]"},
        {"type": "filters.assign", "value": "Classification = 2"},
        {"type": "writers.copc", "filename": str(out), "a_srs": CRS_ANALYSIS},
    ]}
    pj = INTERIM / "pdal_synthetic_copc.json"
    pj.write_text(json.dumps(pipeline, indent=2))
    run(["pdal", "pipeline", str(pj)])

    info = json.loads(run(["pdal", "info", "--summary", str(out)]))["summary"]
    size = out.stat().st_size
    report = {
        "url": f"data/pointcloud/{OUT_NAME}",
        "synthetic": True,
        "provenance": "derived from dtm_highres_050.tif (one point per 0.5 m cell) "
                      "— NOT an observation; delivery/perf load only",
        "bytes": size,
        "point_count": info.get("num_points"),
        "bounds": info.get("bounds"),
        "bytes_per_point": round(size / max(info.get("num_points") or 1, 1), 3),
    }
    (WEB_DATA / "pointcloud_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if size < 5_000_000:
        print("\n注意: COPC が 5 MB 未満。規則格子なので LAZ が効きすぎている可能性がある。"
              "\nネットワーク負荷源としては弱い。docs/WEB_DESIGN.md「既知の制約」を参照。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
