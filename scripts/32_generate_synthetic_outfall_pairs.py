#!/usr/bin/env python3
"""窪地の越流点から仮想吐口ペアを作る。

`scripts/33_flow_accum.py` が Priority-Flood + ε で特定した窪地（海に通じない
くぼみ）のうち、**面積 `--min-area-m2`（既定 1000 m²）以上・越流点標高（鞍部の
高さ）が低い順**に最大 `--max-pairs` 個を選び、各窪地の**越流点セル**
（`iwagaki.flow.pit_pour_points` が出す鞍部）を陸側端、最寄りの open-water seed を
海側の geometry として GeoJSON へ出力する。`scripts/31_drainage_flood.py` が
その陸側端を追加 seed にして S2 の到達水位ラスタを出す。

`scripts/33` の越流点 GeoJSON は**面積上位 60 窪地だけ**なので、`--min-area-m2`
はその最小面積より大きくしておく（`main` が検査して、そうでなければ止める）。
面積下限で切ったうえで spill で並べるので、上位 60 から漏れた低 spill の窪地を
取りこぼさない。

**「大きい窪地から順」ではなく越流点ベースにした理由**（`docs/todo.md`,
`docs/flood_simulation_spec.md` §5.2）: S2 の感度を支配しているのは吐口の敷高
ではなく「どの窪地にペアを置いたか」なので（`docs/results.md`「敷高の仮定は
結果を支配していない」）、置き場所を排水ネットワーク上の意味のある点にする。
越流点はその窪地が実際に水を吐く鞍部で、`spill_elev` はその窪地に水が溜まり
始める（＝ 潮位逆流が効き始める）水位そのもの。旧版の「窪地成分の最低セル」は
底であって排水ネットワーク上の位置ではなかった。

**実在する排水口の復元ではなく、S2 の感度を確認するための仮想データ。**

前提: `scripts/33_flow_accum.py` を先に回して
`data/out/<範囲>/flow_accum_pits_highres.geojson`（面積上位の窪地の越流点）を
作っておく。`scripts/run_all.sh` は 33 -> 32 -> 31 の順に回す。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from rasterio.transform import rowcol
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, CRS_ANALYSIS, DRAINAGE_DROP_M, OUT
from iwagaki.raster import Grid, read


def parse_pit_features(fc: dict) -> list[dict]:
    """`flow_accum_pits_*.geojson` の各 Feature を平らな dict にする。

    座標は EPSG:6674 の [x, y, spill_elev]。properties から窪地の諸元を拾う。
    """
    out: list[dict] = []
    for feat in fc.get("features", []):
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "Point" or len(coords) < 2:
            continue
        p = feat.get("properties") or {}
        spill = p.get("spill_elev_m_tp")
        if spill is None and len(coords) >= 3:
            spill = coords[2]
        out.append({
            "x": float(coords[0]),
            "y": float(coords[1]),
            "pit_id": int(p.get("pit_id", -1)),
            "spill_elev_m_tp": float(spill),
            "max_fill_depth_m": float(p.get("max_fill_depth_m", 0.0)),
            "area_m2": round(float(p.get("area_ha", 0.0)) * 1e4, 2),
            "edge_truncated": bool(p.get("edge_truncated", False)),
        })
    return out


def select_outfall_pits(
    pit_features: list[dict],
    hc: np.ndarray,
    grid: Grid,
    target_h: float,
    max_pairs: int,
    min_area_m2: float,
) -> list[dict]:
    """越流点ベースで仮想吐口を置く窪地を選ぶ。

    残す条件（旧版の `ponded` = 「標高 <= 潮位 だが海に非連結」と同じ意図を
    窪地の越流点で表す）:

    - 窪地の底（`spill_elev - max_fill_depth`）が `target_h` より低い
      （潮位が届かない窪地に吐口を置いても S2 は動かない）
    - 越流点セルの `h_conn` が `target_h` より高い（既に海から地表で連結して
      いるなら追加 seed は不要）。`h_conn` が nodata のセルは「連結していない」
      とみなして残す
    - 窪地面積が `min_area_m2` 以上

    並び順は **越流点標高の昇順**（逆流が効き始めるのが早い順）、同着は面積の
    降順。先頭から `max_pairs` 個。

    入力の `pit_features` は `scripts/33` が出す**面積上位の窪地だけ**なので、
    `min_area_m2` はその面積下限より大きくしておく（`main` が検査する）。
    そうしないと「面積は下限以上だが上位 N に入らなかった低 spill の窪地」が
    候補から漏れ、spill 昇順という前提が崩れる。
    """
    h, w = hc.shape
    chosen: list[tuple[float, float, dict]] = []
    for f in pit_features:
        if f["area_m2"] < min_area_m2:
            continue
        floor = f["spill_elev_m_tp"] - f["max_fill_depth_m"]
        if not (floor < target_h):
            continue
        r, c = rowcol(grid.transform, f["x"], f["y"])
        if not (0 <= r < h and 0 <= c < w):
            continue
        hc_here = hc[r, c]
        if np.isfinite(hc_here) and hc_here <= target_h:
            continue
        rec = dict(f)
        rec["row"], rec["col"] = int(r), int(c)
        rec["hc_at_pour_m_tp"] = (
            round(float(hc_here), 3) if np.isfinite(hc_here) else None)
        chosen.append((f["spill_elev_m_tp"], -f["area_m2"], rec))
    chosen.sort(key=lambda t: (t[0], t[1]))
    return [rec for _, _, rec in chosen[:max_pairs]]


def pit_source_truncation_error(fc: dict, min_area_m2: float) -> str | None:
    """越流点 GeoJSON が面積で頭打ちで、`min_area_m2` がその最小面積より小さいなら
    エラーメッセージを返す（そうでなければ `None`）。

    `scripts/33` の GeoJSON は面積上位 `FLOW_POUR_POINT_MAX_COUNT` 窪地だけ。
    `min_area_m2` がその最小面積以下だと「面積は下限以上だが上位に入らなかった
    低 spill の窪地」が候補から漏れ、spill 昇順という前提が崩れる。
    """
    feats = fc.get("features", [])
    total_pits = int(fc.get("properties", {}).get("total_pits", len(feats)))
    areas = [round(float(f.get("properties", {}).get("area_ha", 0.0)) * 1e4, 2)
             for f in feats]
    min_listed = min(areas, default=0.0)
    if total_pits <= len(feats) or min_area_m2 >= min_listed:
        return None
    return (f"越流点 GeoJSON は面積上位 {len(feats)} 窪地だけ"
            f"（最小 {min_listed:.0f} m²、全 {total_pits} 窪地）。"
            f"--min-area-m2 {min_area_m2:.0f} はそれより小さいので条件を満たす"
            f"窪地が漏れる。--min-area-m2 を {min_listed:.0f} 以上にするか、"
            "scripts/33 の FLOW_POUR_POINT_MAX_COUNT を増やして越流点を焼き直す。")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-h", type=float, default=0.93)
    ap.add_argument("--max-pairs", type=int, default=12)
    # 既定は 1000 m²（0.1 ha）。`scripts/33` の越流点 GeoJSON は面積上位 60 窪地
    # だけなので、その最小面積（範囲により 600〜950 m² 程度）より大きくしておく。
    ap.add_argument("--min-area-m2", type=float, default=1000.0)
    ap.add_argument("--pits", type=Path,
                    default=OUT / "flow_accum_pits_highres.geojson",
                    help="scripts/33 が出す越流点 GeoJSON（面積上位の窪地）")
    ap.add_argument("--output", type=Path,
                    default=OUT / "synthetic_outfall_pairs.geojson")
    args = ap.parse_args()

    hc, grid, hc_nodata = read(OUT / "h_conn_highres.tif")
    hc[hc == hc_nodata] = np.nan
    seed_arr, _, _ = read(OUT / "seed_highres_050.tif")
    seed = np.isfinite(seed_arr) & (seed_arr > 0.5)

    if not args.pits.exists():
        raise SystemExit(
            f"{args.pits} がありません。先に scripts/33_flow_accum.py を回して "
            "窪地の越流点を書き出してください（run_all.sh は 33 -> 32 の順）。")
    fc = json.loads(args.pits.read_text())
    pit_features = parse_pit_features(fc)
    if not seed.any():
        raise SystemExit("open-water seed が空です（scripts/30 を先に回す）")

    truncation = pit_source_truncation_error(fc, args.min_area_m2)
    if truncation:
        raise SystemExit(truncation)

    picks = select_outfall_pits(
        pit_features, hc, grid, args.target_h, args.max_pairs, args.min_area_m2)
    if not picks:
        raise SystemExit("仮想吐口候補がありません（越流点 GeoJSON と閾値を確認）")

    # 各越流点から最近傍 open-water seed（旧版と同じユークリッド最寄り）。
    _, nearest = ndimage.distance_transform_edt(
        ~seed, return_distances=True, return_indices=True)

    features = []
    for f in picks:
        r, c = f["row"], f["col"]
        mr, mc = int(nearest[0, r, c]), int(nearest[1, r, c])
        inland_x, inland_y = grid.transform * (c + 0.5, r + 0.5)
        mouth_x, mouth_y = grid.transform * (mc + 0.5, mr + 0.5)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [mouth_x, mouth_y]},
            "properties": {
                "id": f"synthetic-{len(features) + 1:03d}",
                "inland_node": [inland_x, inland_y],
                "gate_type": "none",
                "drain_to": "open-water-seed",
                "source": "synthetic",
                "target_h_m": args.target_h,
                # 越流点標高＝その窪地の鞍部の高さ。**吐口の敷高の目安**。
                # `scripts/31` は敷高を `dem[inland_node] - DRAINAGE_DROP_M` で
                # 決めており（敷高の軸は退化しているので変えない。§8）、この値は
                # 排水ネットワーク上の基準として持たせるだけ。
                "spill_elev_m_tp": round(f["spill_elev_m_tp"], 3),
                "invert_ref_m_tp": round(
                    f["spill_elev_m_tp"] - DRAINAGE_DROP_M, 3),
                "pit_id": f["pit_id"],
                "pit_area_m2": f["area_m2"],
                "pit_max_fill_depth_m": round(f["max_fill_depth_m"], 3),
                "hc_at_pour_m_tp": f["hc_at_pour_m_tp"],
                "pour_edge_truncated": f["edge_truncated"],
            },
        })

    data = {
        "type": "FeatureCollection",
        "name": f"{AOI.name}_synthetic_outfall_pairs",
        "crs": {"type": "name", "properties": {"name": CRS_ANALYSIS}},
        "properties": {
            "what": "海に通じない窪地の越流点を陸側端にした仮想吐口ペア（S2 用）",
            "placement": (
                "flow_accum_pits_highres.geojson の窪地を越流点標高の昇順に選ぶ。"
                "旧版の『窪地成分の最低セルを大きい順』は使わない"
            ),
            "target_h_m": args.target_h,
            "pit_source": args.pits.name,
            "synthetic": True,
        },
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"wrote {args.output}: {len(features)} pair(s) "
          f"（spill {features[0]['properties']['spill_elev_m_tp']:.2f}"
          f"–{features[-1]['properties']['spill_elev_m_tp']:.2f} m T.P.）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
