#!/usr/bin/env python3
"""地表流の集中（flow accumulation）と窪地構造を静的ラスタとして焼く。

外部プロダクト FARR（mite-shiru 社）と同じ土俵。DEM だけから

  - 窪地充填（Priority-Flood + ε）とその副産物: 充填深・越流点標高・容積
  - flow accumulation（D8, 一様単位降雨）: 「水みち」ラスタ
  - 潮位に依らない窪地マップ: ローカル最小 + 集水 + 充填深 + 越流点

を条件（baseline / control / highres / pointcloud）ごとに出す。手法は
`src/iwagaki/flow.py`、出典・根拠区分は `docs/data.md`「地表流の集中と窪地構造」。

**潮位に依存しない静的セル値**なので `h_conn` と同じ扱い（1 回焼く・再計算なし）。
**浸水判定には混ぜない**（`docs/design.md`「モデルは分離可能に保つ」）。別レイヤ。

画面（Web タイル・viewer）は別 PR。ここはファイルと確認用の図だけ
（`scripts/88` / `scripts/91` / `scripts/13+92` と同じ立て付け）。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOI, OUT, RES_COARSE, RES_HIGHRES, ROOT, asset_name
from iwagaki.flow import (d8_accumulation, d8_flow_direction, label_pits,
                          pit_records, priority_flood_fill)
from iwagaki.raster import read, write

# scripts/30_flood.py の CONDITIONS と同じ（同一グリッド思想）。
CONDITIONS: dict[str, tuple[str, float]] = {
    "baseline": ("dtm_baseline_500.tif", RES_COARSE),
    "control": ("dtm_control_500.tif", RES_COARSE),
    "highres": ("dtm_highres_050.tif", RES_HIGHRES),
    # 実点群を融合した地形（scripts/19）。ファイルが無ければ黙って飛ばす
    "pointcloud": ("dtm_pointcloud_050.tif", RES_HIGHRES),
}

#: 充填深がこれ以下のセルは窪地に数えない（ε 充填の ULP 積み上がり・float32 往復対策）
MIN_PIT_DEPTH_M = 0.01

METHOD = (
    "Priority-Flood + ε 窪地充填（Barnes, Lehman & Yatheendradas 2014）／"
    "D8 flow accumulation（O'Callaghan & Mark 1984, 一様単位降雨）。"
    "実装 src/iwagaki/flow.py（純 numpy/scipy）。D-infinity は未実装（docs/todo.md）"
)
CAVEATS = [
    "一様降雨・地形のみ。実際の降雨分布・地表被覆・浸透・管路・時間発展は含まない",
    "flow accumulation は D8（1 セル 1 方向）。D-infinity ではないので尾根の分岐が粗い",
    "nodata（京都府 DEM では主に開放水面）と AOI 外周を流出先とする。"
    "集水域が AOI 端で切れているセルは edge_truncated_fraction で示す",
    "GSI 5m DEM の collar は第 1 段では入れていない（AOI 端の集水は過小、docs/todo.md）",
    "潮位に依存しない静的ラスタ。浸水判定（h_conn）には混ぜていない（別オーバーレイ）",
]


def _process(name: str, fname: str, res: float) -> dict:
    arr, grid, nodata = read(OUT / fname)
    arr[arr == nodata] = np.nan
    valid = np.isfinite(arr)
    cell_area = grid.cell_area()

    filled = priority_flood_fill(arr)

    fill_depth = np.where(valid, filled - arr, np.nan)
    # 充填は標高を下げない。ULP 誤差ぶんの負値だけ 0 に丸める
    neg = valid & (fill_depth < 0)
    if neg.any() and float(np.nanmin(fill_depth[neg])) < -1e-6:
        raise SystemExit(f"{name}: fill_depth < 0 が {int(neg.sum())} セル")
    fill_depth = np.where(valid, np.maximum(fill_depth, 0.0), np.nan)

    d8 = d8_flow_direction(filled)
    accum, term_edge = d8_accumulation(d8, valid)

    # 一様単位降雨の保存則: 有効セルの寄与 1 が終端に集まる -> 総和 = 有効セル数
    rec = d8.receiver.reshape(-1)
    flat_valid = valid.reshape(-1)
    terminal = flat_valid & ((rec == np.arange(rec.size)) | ~flat_valid[rec])
    n_valid = int(valid.sum())
    term_sum = float(accum.reshape(-1)[terminal].sum())
    if abs(term_sum - n_valid) > 0.5:
        raise SystemExit(f"{name}: flow_accum 保存則が破れている（{term_sum} != {n_valid}）")

    pit_id, n_pits = label_pits(fill_depth, MIN_PIT_DEPTH_M)
    pits = pit_records(pit_id, fill_depth, filled, arr, cell_area)
    for p in pits:
        if p.spill_elev_m_tp + 1e-3 < p.max_ground_elev_m_tp:
            raise SystemExit(
                f"{name}: 窪地 {p.pit_id} の越流点 {p.spill_elev_m_tp} < "
                f"窪地内最大標高 {p.max_ground_elev_m_tp}")

    spill_elev = np.where(fill_depth > MIN_PIT_DEPTH_M, filled, nodata)
    write(OUT / f"fill_depth_{name}.tif", np.where(valid, fill_depth, nodata), grid, nodata)
    write(OUT / f"spill_elev_{name}.tif", spill_elev, grid, nodata)
    write(OUT / f"flow_accum_{name}.tif", np.where(valid, accum, nodata), grid, nodata)
    write(OUT / f"pit_id_{name}.tif", np.where(pit_id > 0, pit_id, nodata), grid, nodata)

    edge_frac = float(term_edge[valid].mean()) if n_valid else 0.0
    total_pit_area = round(sum(p.area_m2 for p in pits), 2)
    total_pit_vol = round(sum(p.volume_m3 for p in pits), 2)
    max_fill = round(max((p.max_fill_depth_m for p in pits), default=0.0), 3)

    print(f"{name:10s} res={res:>4}  pits={n_pits:4d}  "
          f"pit_area={total_pit_area / 1e4:7.2f} ha  max_fill={max_fill:.2f} m  "
          f"vol={total_pit_vol:11.1f} m3  edge_truncated={edge_frac * 100:.1f}%")

    (OUT / f"flow_accum_pits_{name}.json").write_text(json.dumps(
        [p.__dict__ for p in pits], indent=2, ensure_ascii=False), encoding="utf-8")

    return {
        "dtm": fname, "res_m": res, "cells": int(arr.size),
        "valid_cells": n_valid,
        "cell_area_m2": cell_area,
        "pit_count": n_pits,
        "total_pit_area_m2": total_pit_area,
        "total_pit_area_ha": round(total_pit_area / 1e4, 3),
        "total_fill_volume_m3": total_pit_vol,
        "max_fill_depth_m": max_fill,
        "flow_accum_max_cells": int(np.nanmax(accum)) if n_valid else 0,
        "flow_accum_max_m2": round(float(np.nanmax(accum)) * cell_area, 1) if n_valid else 0,
        "edge_truncated_fraction": round(edge_frac, 4),
        "sink_outlet_cells": int(d8.sink_outlet.sum()),
        "edge_outlet_cells": int(d8.edge_outlet.sum()),
        "accum_conservation_ok": abs(term_sum - n_valid) <= 0.5,
    }


def _load(name: str) -> np.ndarray | None:
    p = OUT / name
    if not p.exists():
        return None
    arr, _, nd = read(p)
    arr[arr == nd] = np.nan
    return arr


def _figures(done: list[str]) -> None:
    """確認用の図（docs/images/）。Web 実装前の目視用。"""
    import matplotlib
    matplotlib.use("Agg")
    matplotlib.rcParams["font.family"] = [
        "Hiragino Sans", "Hiragino Kaku Gothic ProN", "YuGothic", "Noto Sans CJK JP",
    ]
    matplotlib.rcParams["axes.unicode_minus"] = False
    import matplotlib.pyplot as plt

    img_dir = ROOT / "docs" / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    factor = int(round(RES_COARSE / RES_HIGHRES))

    def up(a: np.ndarray) -> np.ndarray:
        return np.repeat(np.repeat(a, factor, 0), factor, 1)

    # (1) 各条件の flow accumulation（log スケール）
    accums = [(c, _load(f"flow_accum_{c}.tif")) for c in done]
    accums = [(c, a) for c, a in accums if a is not None]
    if accums:
        fig, axes = plt.subplots(1, len(accums), figsize=(3.3 * len(accums), 3.9),
                                 squeeze=False)
        for ax, (c, a) in zip(axes[0], accums):
            la = np.log10(np.where(np.isfinite(a) & (a > 0), a, np.nan))
            im = ax.imshow(la, cmap="cubehelix_r", vmin=0)
            ax.set_title(f"{c}  log10(集水セル数)")
            ax.set_xticks([]); ax.set_yticks([])
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        fig.suptitle(f"{AOI.name}: 地表流の集中（D8・一様降雨・地形のみ）")
        fig.tight_layout()
        out = img_dir / asset_name("flow_accum.png")
        fig.savefig(out, dpi=85); plt.close(fig)
        print("wrote", out.relative_to(ROOT))

    # (2) highres の窪地マップ（充填深）＋越流点
    fd = _load("fill_depth_highres.tif")
    se = _load("spill_elev_highres.tif")
    if fd is not None:
        fig, ax = plt.subplots(figsize=(5.2, 5.2))
        im = ax.imshow(np.where(fd > MIN_PIT_DEPTH_M, fd, np.nan), cmap="viridis")
        if se is not None:
            ax.imshow(np.where(np.isfinite(se), 1.0, np.nan), cmap="autumn",
                      alpha=0.25)
        ax.set_title(f"{AOI.name}: 窪地の充填深 [m]（原理版・潮位非依存）")
        ax.set_xticks([]); ax.set_yticks([])
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="充填深 [m]")
        fig.tight_layout()
        out = img_dir / asset_name("flow_accum_pit_map.png")
        fig.savefig(out, dpi=85); plt.close(fig)
        print("wrote", out.relative_to(ROOT))

    # (3) control -> highres で水みち・窪地構造がどう変わるか
    ac = _load("flow_accum_control.tif")
    ah = _load("flow_accum_highres.tif")
    if ac is not None and ah is not None and ac.shape != ah.shape:
        lc = np.log10(np.where(np.isfinite(ac) & (ac > 0), ac, np.nan))
        lh = np.log10(np.where(np.isfinite(ah) & (ah > 0), ah, np.nan))
        diff = lh - up(lc)
        fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.9))
        for ax, data, ttl, cm in (
            (axes[0], up(lc), "control 5m（集約） log10", "cubehelix_r"),
            (axes[1], lh, "highres 0.5m log10", "cubehelix_r"),
            (axes[2], diff, "highres − control（水みちの出入り）", "RdBu_r"),
        ):
            vlim = {"cmap": cm}
            if cm == "RdBu_r":
                vlim.update(vmin=-2, vmax=2)
            im = ax.imshow(data, **vlim)
            ax.set_title(ttl); ax.set_xticks([]); ax.set_yticks([])
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        fig.suptitle(f"{AOI.name}: データ源 vs 解像度（集約した 5m と 0.5m の水みち）")
        fig.tight_layout()
        out = img_dir / asset_name("flow_accum_res_diff.png")
        fig.savefig(out, dpi=85); plt.close(fig)
        print("wrote", out.relative_to(ROOT))


def main() -> int:
    summary = {
        "aoi": AOI.bounds, "aoi_name": AOI.name,
        "method": METHOD,
        "rainfall": "uniform unit（有効セルの寄与 = 1）",
        "connectivity_note": "flow routing は D8（8 近傍）。h_conn の 4 近傍とは別物",
        "min_pit_depth_m": MIN_PIT_DEPTH_M,
        "caveats": CAVEATS,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "conditions": {},
    }
    done: list[str] = []
    for name, (fname, res) in CONDITIONS.items():
        if not (OUT / fname).exists():
            print(f"{name:10s} skip（{fname} が無い）")
            continue
        summary["conditions"][name] = _process(name, fname, res)
        done.append(name)

    if not done:
        raise SystemExit("処理できる地形条件が 1 つも無い（先に scripts/20・21 を回す）")

    (OUT / "flow_accum_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote flow_accum_summary.json（{', '.join(done)}）")

    _figures(done)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
