#!/usr/bin/env python3
"""ブラウザ側の実装が Python 側とずれていないか検証するためのフィクスチャ。

docs/WEB_DESIGN.md「正しさを守るテスト」。性能とは別に「静かに間違う」のを防ぐためのもの。
"""
from __future__ import annotations

import csv
import json
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iwagaki.config import H_STEP, OUT, REPRESENTATIVE_H, ROAD_DEPTH_CLASSES, ROOT

mod = __import__("80_build_web_tiles")
decode, WEB_DATA = mod.decode, mod.WEB_DATA

DEST = ROOT / "web" / "test" / "fixtures"


def main() -> int:
    rng = random.Random(7)
    tiles = sorted((WEB_DATA / "tiles" / "highres").rglob("*.png"))
    samples = []
    for p in tiles[:: max(1, len(tiles) // 6)][:6]:
        rgba = np.asarray(Image.open(p).convert("RGBA"))
        elev, hconn = decode(rgba)
        for _ in range(40):
            i, j = rng.randrange(rgba.shape[0]), rng.randrange(rgba.shape[1])
            samples.append({
                "r": int(rgba[i, j, 0]), "g": int(rgba[i, j, 1]),
                "b": int(rgba[i, j, 2]), "a": int(rgba[i, j, 3]),
                "elev": None if not np.isfinite(elev[i, j]) else round(float(elev[i, j]), 6),
                "h_conn": None if not np.isfinite(hconn[i, j]) else round(float(hconn[i, j]), 6),
            })

    rows = list(csv.DictReader((OUT / "objects.csv").open()))
    def num(v):
        return None if v in ("", None) else float(v)
    feats = []
    for r in rng.sample(rows, min(120, len(rows))):
        at = {}
        for h in REPRESENTATIVE_H:
            k = f"{h:.2f}"
            at[k] = {
                "depth_baseline": num(r[f"depth_baseline@{k}"]) or 0.0,
                "depth_highres": num(r[f"depth_highres@{k}"]) or 0.0,
                # unreliable な地物は scripts/50 側でも判定変化としてカウントしない
                "decision_changed": (r[f"decision_changed@{k}"] == "True"
                                     and r["unreliable"] == "False"),
            }
        feats.append({
            "gml_id": r["gml_id"], "feature_type": r["feature_type"],
            "unreliable": r["unreliable"] == "True",
            "ground_elev_baseline": num(r["ground_elev_baseline"]),
            "ground_elev_highres": num(r["ground_elev_highres"]),
            "h_conn_baseline": num(r["h_conn_baseline"]),
            "h_conn_highres": num(r["h_conn_highres"]),
            "at": at,
        })

    DEST.mkdir(parents=True, exist_ok=True)
    out = {"h_step": H_STEP, "road_depth_classes_m": list(ROAD_DEPTH_CLASSES),
           "packing": samples, "features": feats}
    (DEST / "parity.json").write_text(json.dumps(out, indent=1))
    print(f"wrote {DEST/'parity.json'}: {len(samples)} pixels, {len(feats)} features")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
