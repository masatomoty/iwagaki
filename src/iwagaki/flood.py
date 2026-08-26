"""連結浸水開始水位 h_conn の計算。

`h_conn(c)` = セル c が開放水面（海・水路）と連結して浸水し始める最小の水位 [m T.P.]。
浸水候補集合 {E <= H} が H について単調増加なので well-defined。
これを 1 枚持てば、任意の水位 H に対して

    wet(H)   = h_conn <= H
    depth(H) = max(0, H - E)   （wet なセルのみ）

が定数時間で求まる。単純な `E < H` とは異なり、海から連結していない窪地は浸水しない。

**開放水面の扱い**: seed 領域は「常に水位 H の水がある開境界」として扱う（標高を -inf とみなす）。
seed は高解像度地形から 1 度だけ求め、全条件で同一のものを使う。
そうしないと地形ごとに seed が変わってしまい、比較が seed の差に汚染される。
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

_STRUCT = {
    4: np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool),
    8: np.ones((3, 3), dtype=bool),
}


def structure(connectivity: int) -> np.ndarray:
    if connectivity not in _STRUCT:
        raise ValueError("connectivity must be 4 or 8")
    return _STRUCT[connectivity]


def find_open_water(
    elev: np.ndarray,
    seed_level: float,
    cell_area: float,
    min_area: float,
    connectivity: int = 4,
    include_nodata: bool = True,
) -> tuple[np.ndarray, list[dict]]:
    """開放水面（seed）を決める。

    候補 = 標高 <= `seed_level` のセル（+ 任意で nodata セル）。
    そのうち **配列の外周に接し**、面積が `min_area` 以上の連結成分を開放水面とする。
    （AOI の外の海・水路に通じているもの）

    暗黙のルールに頼らないよう、選ばれた成分の面積と重心を返す。呼び出し側でログに残すこと。
    """
    invalid = ~np.isfinite(elev)
    cand = np.where(invalid, False, elev <= seed_level)
    if include_nodata:
        cand |= invalid
    lab, n = ndimage.label(cand, structure=structure(connectivity))
    if n == 0:
        return np.zeros_like(cand), []
    border = np.zeros_like(cand)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    border_labels = np.unique(lab[border & cand])
    border_labels = border_labels[border_labels > 0]
    sizes = ndimage.sum_labels(
        np.ones_like(lab, dtype="float64"), lab, index=np.arange(1, n + 1)
    )
    chosen, info = [], []
    for lb in border_labels:
        area = float(sizes[lb - 1] * cell_area)
        if area < min_area:
            continue
        chosen.append(int(lb))
        cy, cx = ndimage.center_of_mass(lab == lb)
        info.append({
            "label": int(lb),
            "area_m2": round(area, 1),
            "centroid_rowcol": [round(float(cy), 1), round(float(cx), 1)],
            "nodata_fraction": round(float(invalid[lab == lb].mean()), 3),
        })
    mask = np.isin(lab, chosen) if chosen else np.zeros_like(cand)
    return mask, info


def downsample_mask(mask: np.ndarray, factor: int, threshold: float = 0.5) -> np.ndarray:
    """seed マスクを factor 倍粗くする（被覆率 threshold 以上のセルを seed とする）。"""
    h = mask.shape[0] // factor * factor
    w = mask.shape[1] // factor * factor
    blocks = mask[:h, :w].reshape(h // factor, factor, w // factor, factor)
    return blocks.mean(axis=(1, 3)) >= threshold


def compute_h_conn(
    elev: np.ndarray,
    seed: np.ndarray,
    h_min: float,
    h_max: float,
    h_step: float,
    connectivity: int = 4,
    nodata_as_water: bool = False,
) -> np.ndarray:
    """水位を昇順に走査して h_conn を求める。到達しないセルは +inf。

    seed セルは常に浸水（標高 -inf 相当）。
    nodata（NaN）は既定で**障壁**。京都府DEMの nodata は主に開放水面だが
    建物跡の欠測も混在しうるため、自動的に水にはしない（seed に入ったものは別）。
    """
    valid = np.isfinite(elev)
    e = np.where(valid, elev, -np.inf if nodata_as_water else np.inf)
    e = np.where(seed, -np.inf, e)
    passable = valid | seed | (nodata_as_water & ~valid)

    struct = structure(connectivity)
    h_conn = np.full(elev.shape, np.inf, dtype="float64")
    for h in np.arange(h_min, h_max + h_step / 2, h_step):
        cand = passable & (e <= h)
        if not cand.any():
            continue
        lab, n = ndimage.label(cand, structure=struct)
        if n == 0:
            continue
        seed_labels = np.unique(lab[seed & cand])
        seed_labels = seed_labels[seed_labels > 0]
        if seed_labels.size == 0:
            continue
        newly = np.isin(lab, seed_labels) & np.isinf(h_conn)
        if newly.any():
            h_conn[newly] = h
    return h_conn


def compute_h_conn_with_inland_outfalls(
    elev: np.ndarray,
    seed: np.ndarray,
    inland_node: np.ndarray,
    invert_mouth: np.ndarray,
    h_min: float,
    h_max: float,
    h_step: float,
    connectivity: int = 4,
    nodata_as_water: bool = False,
) -> np.ndarray:
    """陸側端を追加 seed として排水路逆流の到達水位を求める。

    `inland_node` は護岸の陸側にあるセル、`invert_mouth` は対応する海側吐口
    の敷高 [m T.P.]。潮位 `h` が敷高以上で、かつその吐口にフラップゲートが
    無いケースを表すセルだけを、その `h` の走査で seed に加える。

    海側の吐口セルを seed にしてはいけない。海側セルは通常の open-water
    seed から既に到達可能であり、陸側端を追加することでのみ護岸下の管路を
    通る逆流を表現できる。

    `inland_node` と `invert_mouth` は同じ shape とし、対象外は False / NaN
    とする。敷高は対応する陸側端のセルに保持するため、複数の吐口ペアを
    1 枚の raster で扱える。
    """
    elev = np.asarray(elev, dtype="float64")
    seed = np.asarray(seed, dtype=bool)
    inland_node = np.asarray(inland_node, dtype=bool)
    invert_mouth = np.asarray(invert_mouth, dtype="float64")
    if not (elev.shape == seed.shape == inland_node.shape == invert_mouth.shape):
        raise ValueError("elev, seed, inland_node, invert_mouth must have the same shape")
    if np.any(inland_node & ~np.isfinite(invert_mouth)):
        raise ValueError("inland_node cells must have a finite invert_mouth")

    valid = np.isfinite(elev)
    base_e = np.where(valid, elev, -np.inf if nodata_as_water else np.inf)
    passable = valid | seed | (nodata_as_water & ~valid)
    struct = structure(connectivity)
    h_conn = np.full(elev.shape, np.inf, dtype="float64")

    for h in np.arange(h_min, h_max + h_step / 2, h_step):
        dynamic_seed = seed | (inland_node & (invert_mouth <= h))
        e = np.where(dynamic_seed, -np.inf, base_e)
        cand = passable | dynamic_seed
        cand &= e <= h
        if not cand.any():
            continue
        lab, n = ndimage.label(cand, structure=struct)
        if n == 0:
            continue
        seed_labels = np.unique(lab[dynamic_seed & cand])
        seed_labels = seed_labels[seed_labels > 0]
        if seed_labels.size == 0:
            continue
        newly = np.isin(lab, seed_labels) & np.isinf(h_conn)
        h_conn[newly] = h
    return h_conn


def depth(elev: np.ndarray, h_conn: np.ndarray, h: float) -> np.ndarray:
    """水位 h における浸水深。連結していないセルは 0。"""
    d = np.where(h_conn <= h, h - elev, 0.0)
    return np.where(np.isfinite(d) & (d > 0.0), d, 0.0)
