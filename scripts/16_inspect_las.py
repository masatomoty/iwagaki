#!/usr/bin/env python3
"""届いた LAS の実態を調べる（docs/DATA.md §3 の [未確認] を埋める）。

見るのは次の 5 点。どれも「推測せず記録する」ために必要なもの。

  1. CRS — 解析 CRS (EPSG:6674) と一致するか。ずれていれば再投影が要る
  2. Z が標高(T.P.) か楕円体高か — 楕円体高ならジオイド補正なしでは 37 m ずれる
  3. classification — 2(ground) が入っているか。無ければ PDAL filters.smrf で作る
  4. 密度 — 0.5m DTM を作れるか
  5. AOI との重なり — どれだけが吉原 AOI に入るか

点の統計はファイル全体を読むと 20 GB になるので、間引いて見る。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, CRS_ANALYSIS, INTERIM

# 京都府 0.5m DEM と PLATEAU から分かっている、AOI の地表面のおおよその高さ [m T.P.]
GROUND_TP_RANGE = (0.0, 6.0)
GEOID = 36.955      # 吉原のジオイド高（catalog.json / scripts/83）


class PdalError(RuntimeError):
    pass


def run_json(cmd: list[str]) -> dict:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise PdalError(p.stderr.strip().splitlines()[-1] if p.stderr else "unknown")
    return json.loads(p.stdout)


def summary(path: Path) -> dict:
    d = run_json(["pdal", "info", "--summary", str(path)])["summary"]
    m = d["metadata"]
    b = d["bounds"]
    return {
        "file": path.name,
        "points": m["count"],
        "bounds": b,
        "las": f'{m["major_version"]}.{m["minor_version"]}',
        "pdrf": m["dataformat_id"],
        "software": m.get("software_id", ""),
        "creation": f'{m.get("creation_year")}-doy{m.get("creation_doy")}',
        "srs_epsg": _epsg(m),
        "dimensions": d["dimensions"],
    }


def _epsg(meta: dict) -> str:
    """LAS の SRS から EPSG を取る。WKT の書き方が版で違うので複数経路で見る。"""
    srs = meta.get("srs", {})
    auth = srs.get("authority")
    if isinstance(auth, dict) and auth.get("horizontal"):
        return f'EPSG:{auth["horizontal"]}'
    j = srs.get("json")
    if isinstance(j, dict):
        idn = j.get("id") or {}
        if idn.get("authority") == "EPSG" and idn.get("code"):
            return f'EPSG:{idn["code"]}'
    wkt = srs.get("horizontal") or meta.get("spatialreference") or ""
    if isinstance(wkt, str) and wkt:
        tail = wkt.rsplit('AUTHORITY["EPSG","', 1)
        if len(tail) == 2:
            return f'EPSG:{tail[1].split(chr(34))[0]}'
    return "(SRS 記載なし)"


def sampled_stats(path: Path, step: int) -> dict:
    """間引いて Classification / Z / Intensity の分布を見る。"""
    pipeline = {"pipeline": [
        str(path),
        {"type": "filters.decimation", "step": step},
        {"type": "filters.stats",
         "dimensions": "Z,Classification,Intensity,NumberOfReturns",
         "enumerate": "Classification,NumberOfReturns"},
    ]}
    pj = INTERIM / f"inspect_{path.stem[:6]}.json"
    mj = INTERIM / f"inspect_{path.stem[:6]}_meta.json"
    pj.parent.mkdir(parents=True, exist_ok=True)
    pj.write_text(json.dumps(pipeline))
    r = subprocess.run(["pdal", "pipeline", "--metadata", str(mj), str(pj)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise PdalError(r.stderr.strip().splitlines()[-1] if r.stderr else "unknown")
    out = json.loads(mj.read_text())
    stats = out["stages"]["filters.stats"]["statistic"]
    by = {s["name"]: s for s in stats}
    return {
        "sampled_points": by["Z"]["count"],
        "z": {k: round(by["Z"][k], 3) for k in ("minimum", "maximum", "average", "stddev")},
        "classification_counts": by["Classification"].get("counts", []),
        "returns_counts": by["NumberOfReturns"].get("counts", []),
        "intensity_avg": round(by["Intensity"]["average"], 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path, help="LAS が入ったディレクトリ")
    ap.add_argument("--step", type=int, default=500, help="統計用の間引き間隔")
    ap.add_argument("--stats-files", type=int, default=2, help="統計を取るファイル数")
    args = ap.parse_args()

    files = sorted(p for p in args.src.iterdir() if p.suffix.lower() in (".las", ".laz"))
    if not files:
        raise SystemExit(f"LAS/LAZ が無い: {args.src}")

    heads, broken = [], []
    for p in files:
        try:
            heads.append(summary(p))
        except PdalError as e:
            broken.append({"file": p.name, "size": p.stat().st_size, "error": str(e)})
    if not heads:
        raise SystemExit("読める LAS が 1 つも無い")
    total = sum(h["points"] for h in heads)
    bx = [h["bounds"] for h in heads]
    allb = {
        "minx": min(b["minx"] for b in bx), "maxx": max(b["maxx"] for b in bx),
        "miny": min(b["miny"] for b in bx), "maxy": max(b["maxy"] for b in bx),
        "minz": min(b["minz"] for b in bx), "maxz": max(b["maxz"] for b in bx),
    }
    area = (allb["maxx"] - allb["minx"]) * (allb["maxy"] - allb["miny"])

    print(f'{"file":<44}{"points":>13}  {"X 範囲":>21}  {"Y 範囲":>21}  {"Z":>16}')
    for h in heads:
        b = h["bounds"]
        print(f'{h["file"][:43]:<44}{h["points"]:>13,}  '
              f'{b["minx"]:>10.1f}..{b["maxx"]:>9.1f}  {b["miny"]:>10.1f}..{b["maxy"]:>9.1f}  '
              f'{b["minz"]:>7.2f}..{b["maxz"]:>6.2f}')
    if broken:
        print()
        for b in broken:
            print(f'!! 読めない: {b["file"]}  ({b["size"]/1e9:.1f} GB)  {b["error"]}')
    print(f'\n合計 {total:,} 点 / 読めた {len(heads)} / 全 {len(files)} ファイル')
    print(f'全体範囲 X {allb["minx"]:.1f}..{allb["maxx"]:.1f}  '
          f'Y {allb["miny"]:.1f}..{allb["maxy"]:.1f}  Z {allb["minz"]:.2f}..{allb["maxz"]:.2f}')
    print(f'外接矩形 {allb["maxx"]-allb["minx"]:.0f} x {allb["maxy"]-allb["miny"]:.0f} m '
          f'= {area/1e4:.1f} ha, 平均 {total/max(area,1):.1f} 点/m2（外接矩形あたり）')

    srs = {h["srs_epsg"] for h in heads}
    print(f'\nCRS: {srs}  -> 解析CRS {CRS_ANALYSIS} と{"一致" if srs == {CRS_ANALYSIS} else "不一致（再投影が要る）"}')
    print(f'LAS: {{{", ".join(sorted({h["las"] for h in heads}))}}}  '
          f'PDRF: {sorted({h["pdrf"] for h in heads})}  '
          f'software: {sorted({h["software"] for h in heads})}')
    print(f'取得: {sorted({h["creation"] for h in heads})}')

    # --- Z が標高か楕円体高か -------------------------------------------
    # 地表面は 0〜6 m T.P.。楕円体高ならそこに GEOID(約 37 m) が乗るので桁が違う。
    lo, _hi = GROUND_TP_RANGE
    if allb["minz"] < lo + GEOID - 10:
        z_kind = ("標高(T.P.) とみて矛盾しない"
                  f"（楕円体高なら最小でも {lo + GEOID - 10:.0f} m 付近になるはず）")
    else:
        z_kind = f"楕円体高の可能性が高い（ジオイド高 {GEOID} m を引く必要）"
    print(f'Z の基準: minz={allb["minz"]:.2f} maxz={allb["maxz"]:.2f} -> {z_kind}')

    # --- AOI との重なり ---------------------------------------------------
    ov = (max(0.0, min(allb["maxx"], AOI.xmax) - max(allb["minx"], AOI.xmin))
          * max(0.0, min(allb["maxy"], AOI.ymax) - max(allb["miny"], AOI.ymin)))
    print(f'AOI({AOI.name}) との重なり: {ov/1e4:.1f} ha '
          f'(点群外接矩形の {ov/max(area,1)*100:.0f}%)')

    # --- 間引いた統計 -----------------------------------------------------
    ok_files = [p for p in files if p.name not in {b["file"] for b in broken}]
    stats = []
    for p in ok_files[: args.stats_files]:
        print(f'\n--- {p.name} を 1/{args.step} に間引いて統計 ---')
        st = sampled_stats(p, args.step)
        stats.append({"file": p.name, **st})
        print(f'  抽出 {st["sampled_points"]:,} 点  Z {st["z"]}')
        cc = st["classification_counts"]
        print(f'  Classification: {cc if cc else "(値が1種類のみ = 未分類の可能性)"}')
        print(f'  NumberOfReturns: {st["returns_counts"]}  Intensity 平均 {st["intensity_avg"]}')

    report = {
        "source_dir": str(args.src), "files": heads, "unreadable": broken,
        "total_points": total, "combined_bounds": allb,
        "crs": sorted(srs), "z_interpretation": z_kind,
        "aoi_overlap_ha": round(ov / 1e4, 2),
        "sampled_stats": stats,
    }
    out = INTERIM / "las_inspect.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
