#!/usr/bin/env python3
"""実点群 COPC の実測値をドキュメントに反映する。

scripts/22 が書いた web/public/data/pointcloud_report.json の値を読んで、
docs/web_results.md の「点群は合成データ」前提だった記述を差し替える。
数値を手で写さないためのスクリプト。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import ROOT

WEB_DATA = ROOT / "web" / "public" / "data"


def main() -> int:
    rep = json.loads((WEB_DATA / "pointcloud_report.json").read_text())
    if rep.get("synthetic"):
        raise SystemExit("まだ合成点群のまま。先に scripts/22_pc_copc.py を実行する")

    n_m = rep["point_count"] / 1e6
    mb = rep["bytes"] / 1e6
    bpp = rep["bytes_per_point"]
    cell = rep["voxel_cell_m"]

    p = ROOT / "docs" / "web_results.md"
    s = p.read_text()

    old = """**点群は DTM 由来の合成データ**（`docs/data.md` §3、`scripts/81`）であり、
密度分布もノイズ特性も実測点群とは違う。**decode/LOD の結論は実 LAS で測り直す必要がある。**

**表示上の注意**: 合成点群は地表面そのものなので、地形サーフェスとほぼ同じ高さに描かれる。
その結果 **点群 ON では浸水色や差分色が点群に隠れて見えなくなる**（下の図はいずれも点群 OFF）。
実 LAS（建物・植生を含む）なら地表面の上に出るので、この重なりは合成データ固有の問題。
UI 上は点群を既定 ON にしているが、地形・差分を見るときは切る必要がある。"""
    new = f"""**実点群に差し替えた（2026-08-22）。** それまでは DTM 由来の合成点群を
配信負荷源として使っていた（`scripts/81`）。現在の配信物は
舞鶴市吉原のバックパック SLAM 実測（2026-07 取得）。

| 項目 | 合成（旧） | **実測（現）** |
|---|---:|---:|
| 点数 | 3.25 M | **{n_m:.1f} M** |
| 配信サイズ | 14.4 MB | **{mb:.0f} MB** |
| 1 点あたり | 4.4 B | **{bpp:.1f} B** |
| 由来 | 0.5m DTM の各セルを 1 点に | LAS 4.98 億点を AOI で切り、{cell} m ボクセルで間引き |

合成点群は地表面そのものだったので地形サーフェスに埋もれて見えなかったが、
**実点群は壁・建物・植生を含むので地表面の上に出る。**
`scripts/81_build_pointcloud_sample.py` は残してあるが、配信には使っていない。"""
    if old not in s:
        print("web_results.md: 置換対象が見つからない（すでに更新済みか）")
    else:
        s = s.replace(old, new)
        p.write_text(s)
        print("web_results.md を更新")

    print(json.dumps({k: rep[k] for k in
                      ("point_count", "bytes", "bytes_per_point", "voxel_cell_m")},
                     indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
