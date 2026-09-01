"""地表流の集中（flow accumulation）と窪地構造の静的解析。

外部プロダクト **FARR**（Flow Accumulation Realtime Renderer, mite-shiru 社
<https://mite-shiru.co.jp/farr/>）と同じ土俵 — DEM だけから「一様降雨時に地表流が
どこに集まるか（水みち）」と「海に通じない窪地（充填深・越流点標高・容積）」を
求める。**潮位に依存しない静的セル値**なので `h_conn` と同じ扱い（1 回焼く・
再計算なし・配信量は潮位数に依らない）。

**浸水判定には混ぜない**（`docs/design.md`「やらないこと」）。別オーバーレイに留める。

手法（`docs/data.md` §7「地表流の集中と窪地構造」に出典・OSS 比較）:

- **窪地充填 = Priority-Flood + ε**（Barnes, Lehman & Yatheendradas 2014,
  *Computers & Geosciences* 62）。`heapq` と `collections.deque` だけで書ける
  （heap + FIFO の 2 本立て。窪地・平地のセルは heap を経由しない）。
  `iwagaki/flood.py` の `h_conn` は同じ Priority-Flood 系の minimax 量だが、
  0.05 m 刻みに量子化され `H_MAX` で頭打ちになるので、充填深・越流点標高には
  そのまま使えない。ここは非量子化で解く。ε は 1 ULP（`math.nextafter`）で、
  平地に最小の勾配を与えて D8 が必ず下流セルを持つようにするためだけのもの。
  地形値は事実上変えない（`docs/data.md`）。
- **flow accumulation = D8**（O'Callaghan & Mark 1984）。ε 充填面の最急降下で
  1 セル 1 方向に流し、位相ソートで上流セル数を数える。一様単位降雨
  （有効セルの寄与 = 1）。**D-infinity は numba（pyflwdir）か C++（richdem）が
  要るので第 1 段では入れない**（`docs/todo.md`「FARR のロジックを取り込む」）。

境界: 配列の外周セルと nodata セルを流出先（sink）とする。nodata は京都府 DEM
では主に開放水面（湾・川・水路）なので、そこに達した流れは AOI を出たとみなす。
最急降下が外周で map の外へ抜けるセルは「AOI 端で切れている」フラグを立てる。
"""
from __future__ import annotations

import heapq
import math
from collections import deque
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

# (dy, dx, 距離). 距離は D8 の斜め = sqrt(2)。
_D8: tuple[tuple[int, int, float], ...] = (
    (-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
    (-1, -1, math.sqrt(2.0)), (-1, 1, math.sqrt(2.0)),
    (1, -1, math.sqrt(2.0)), (1, 1, math.sqrt(2.0)),
)

_STRUCT8 = np.ones((3, 3), dtype=bool)


def priority_flood_fill(dem: np.ndarray) -> np.ndarray:
    """Priority-Flood + ε で窪地を充填した標高面を返す（Barnes 2014）。

    `dem` は NaN を nodata とする 2 次元配列。返り値も同じ shape で、nodata は
    NaN のまま。有効セルでは `filled >= dem`（単調・充填は標高を下げない）。

    seed（流出先）= 配列の外周に接する有効セル ∪ nodata に隣接する有効セル。
    nodata は「常に排水される開境界」（海・水路）として扱う。

    ε は 1 ULP（`math.nextafter(e, +inf)`）。平地・窪地の中でだけ効き、
    真に下る斜面では `dem` をそのまま使うので地形値は変わらない。
    充填セルどうしが同一標高で並ばないので、D8 が必ず下流セルを持つ。

    実装は heap（Open）と FIFO（Pit）の 2 本立て（Barnes 2014 のプレーンキュー版の
    簡略形。ε は 1 ULP 固定）。窪地・平地のセルは heap を経由しないので、海際の
    低平地でも実用的な速さで通る。
    """
    dem = np.asarray(dem, dtype="float64")
    if dem.ndim != 2:
        raise ValueError("dem must be 2D")
    valid = np.isfinite(dem)
    h, w = dem.shape

    filled = np.where(valid, np.inf, np.nan)
    closed = ~valid

    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    adj_nodata = ndimage.binary_dilation(~valid, _STRUCT8) & valid
    seeds = valid & (border | adj_nodata)

    counter = 0
    heap: list[tuple[float, int, int]] = []
    ys, xs = np.nonzero(seeds)
    for c in (ys * w + xs).tolist():
        z = float(dem.flat[c])
        filled.flat[c] = z
        closed.flat[c] = True
        heap.append((z, counter, c))
        counter += 1
    heapq.heapify(heap)

    pit: deque[int] = deque()
    push = heapq.heappush
    pop = heapq.heappop
    nextafter = math.nextafter
    inf = math.inf
    demf = dem.reshape(-1)
    filledf = filled.reshape(-1)
    closedf = closed.reshape(-1)
    # (flat-index offset, 列方向 dx)。dx で列の折り返しを、範囲チェックで行の外を弾く
    offs = ((-w, 0), (w, 0), (-1, -1), (1, 1),
            (-w - 1, -1), (-w + 1, 1), (w - 1, -1), (w + 1, 1))
    n_cells = h * w

    while heap or pit:
        if pit:
            c = pit.popleft()
        else:
            _, _, c = pop(heap)
        e = filledf[c]
        raised = nextafter(e, inf)
        col = c % w
        for off, need_col in offs:
            nc = c + off
            if nc < 0 or nc >= n_cells:
                continue
            if need_col == -1 and col == 0:
                continue
            if need_col == 1 and col == w - 1:
                continue
            if closedf[nc]:
                continue
            closedf[nc] = True
            dz = demf[nc]
            if dz <= raised:
                filledf[nc] = raised
                pit.append(nc)
            else:
                filledf[nc] = dz
                push(heap, (dz, counter, nc))
                counter += 1

    stuck = valid & ~np.isfinite(filled)
    if stuck.any():
        filled[stuck] = dem[stuck]
    return filled


@dataclass(frozen=True)
class D8Result:
    receiver: np.ndarray      # int32, flat index of downslope neighbor (自分自身 = 端流出)
    edge_outlet: np.ndarray   # bool, map の外へ抜けるセル
    sink_outlet: np.ndarray   # bool, nodata（海・水路）へ流れ込むセル
    order: np.ndarray         # int32, 位相ソート順（source -> sink）の flat index


def d8_flow_direction(filled: np.ndarray) -> D8Result:
    """ε 充填面の最急降下から D8 の流向を決める。

    nodata セルは routing 上 -inf として扱うので、海に隣接するセルは海へ流れる。
    外周で map の外に抜けるセルは `edge_outlet`、nodata に流れ込むセルは
    `sink_outlet`。どちらでもない有効セルは必ず下流の有効セルを持つ
    （Priority-Flood + ε の帰結）。
    """
    filled = np.asarray(filled, dtype="float64")
    h, w = filled.shape
    valid = np.isfinite(filled)

    routing = np.where(valid, filled, -np.inf)
    OUT = np.inf  # map 外は登れない壁
    padded = np.full((h + 2, w + 2), OUT, dtype="float64")
    padded[1:-1, 1:-1] = routing

    best_slope = np.full((h, w), -np.inf, dtype="float64")
    best_k = np.full((h, w), -1, dtype="int8")
    center = padded[1:-1, 1:-1]
    with np.errstate(invalid="ignore"):
        for k, (dy, dx, dist) in enumerate(_D8):
            nb = padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            slope = (center - nb) / dist
            take = slope > best_slope
            best_slope = np.where(take, slope, best_slope)
            best_k = np.where(take, np.int8(k), best_k)

    # best_slope <= 0 は下流が無い（外周の真の流出、または map 外へ）
    has_down = valid & (best_slope > 0.0)
    idx = np.arange(h * w, dtype="int64").reshape(h, w)
    receiver = idx.copy()
    rec_y = np.zeros((h, w), dtype="int64")
    rec_x = np.zeros((h, w), dtype="int64")
    for k, (dy, dx, _dist) in enumerate(_D8):
        m = has_down & (best_k == k)
        if m.any():
            yy, xx = np.nonzero(m)
            rec_y[yy, xx] = yy + dy
            rec_x[yy, xx] = xx + dx
    m = has_down
    receiver[m] = idx[rec_y[m], rec_x[m]]

    rec_is_nodata = np.zeros((h, w), dtype=bool)
    rec_is_nodata[m] = ~valid[rec_y[m], rec_x[m]]
    sink_outlet = rec_is_nodata
    # 下流が無い有効セルで、外周に接する = map の外へ抜ける
    on_border = np.zeros((h, w), dtype=bool)
    on_border[0, :] = on_border[-1, :] = on_border[:, 0] = on_border[:, -1] = True
    edge_outlet = valid & ~has_down & on_border
    # 下流が nodata のセルは受け手を自分自身にして DAG を閉じる
    receiver[sink_outlet] = idx[sink_outlet]
    receiver[valid & ~has_down] = idx[valid & ~has_down]

    order = _topological_order(receiver, valid)
    return D8Result(
        receiver=receiver.astype("int32"),
        edge_outlet=edge_outlet,
        sink_outlet=sink_outlet & valid,
        order=order.astype("int32"),
    )


def _topological_order(receiver: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """source（集水の無いセル）-> sink の順に有効セルの flat index を返す（Kahn）。"""
    h, w = receiver.shape
    flat_valid = valid.reshape(-1)
    rec = receiver.reshape(-1)
    n = h * w

    indeg = np.zeros(n, dtype="int64")
    contrib = flat_valid & (rec != np.arange(n))
    np.add.at(indeg, rec[contrib], 1)

    dq = deque(int(i) for i in np.nonzero(flat_valid & (indeg == 0))[0])
    out: list[int] = []
    while dq:
        c = dq.popleft()
        out.append(c)
        r = int(rec[c])
        if r == c or not flat_valid[r]:
            continue
        indeg[r] -= 1
        if indeg[r] == 0:
            dq.append(r)
    return np.asarray(out, dtype="int64")


def d8_accumulation(
    d8: D8Result, valid: np.ndarray, weights: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """上流寄与セル数（自セルを含む）を返す。一様単位降雨なら weights=None。

    返り値: `(accum, terminates_at_edge)`。
    - `accum`: float64。有効セルは >= 1。nodata は 0。
    - `terminates_at_edge`: bool。そのセルの流れが最終的に **AOI の外周**で
      map の外へ抜ける（= 集水域が端で切れている）なら True。nodata（海）へ
      抜けるセルは False。
    """
    h, w = valid.shape
    n = h * w
    rec = d8.receiver.reshape(-1).astype("int64")
    flat_valid = valid.reshape(-1)

    accum = np.where(flat_valid, 1.0, 0.0)
    if weights is not None:
        accum = np.where(flat_valid, np.asarray(weights, dtype="float64").reshape(-1), 0.0)

    for c in d8.order.tolist():
        r = rec[c]
        if r == c or not flat_valid[r]:
            continue
        accum[r] += accum[c]

    term_edge = np.zeros(n, dtype=bool)
    edge = d8.edge_outlet.reshape(-1)
    for c in d8.order[::-1].tolist():
        r = rec[c]
        if r == c or not flat_valid[r]:
            term_edge[c] = bool(edge[c])
        else:
            term_edge[c] = term_edge[r]

    return accum.reshape(h, w), term_edge.reshape(h, w)


@dataclass(frozen=True)
class Pit:
    pit_id: int
    area_m2: float
    max_fill_depth_m: float
    volume_m3: float
    spill_elev_m_tp: float
    max_ground_elev_m_tp: float


def label_pits(
    fill_depth: np.ndarray, min_depth_m: float = 0.01
) -> tuple[np.ndarray, int]:
    """充填深 > `min_depth_m` の連結成分を窪地としてラベリング（8 近傍）。

    `min_depth_m` は ε 充填の ULP 積み上がりと float32 往復を無視するための下限。
    """
    mask = np.asarray(fill_depth) > min_depth_m
    lab, n = ndimage.label(mask, structure=_STRUCT8)
    return lab.astype("int32"), int(n)


def pit_records(
    labels: np.ndarray,
    fill_depth: np.ndarray,
    filled: np.ndarray,
    dem: np.ndarray,
    cell_area_m2: float,
) -> list[Pit]:
    """窪地 ID ごとの面積・最大充填深・容積・越流点標高。

    越流点標高 = 窪地内の充填面の最大値（その一帯を止めている鞍部の高さ）。
    定義上 `spill_elev >= 窪地内の最大地表標高`。
    """
    labels = np.asarray(labels)
    n = int(labels.max())
    if n == 0:
        return []
    fd = np.asarray(fill_depth, dtype="float64")
    fl = np.asarray(filled, dtype="float64")
    de = np.asarray(dem, dtype="float64")
    idx = np.arange(1, n + 1)

    counts = ndimage.sum_labels(np.ones_like(fd), labels, index=idx)
    vol = ndimage.sum_labels(fd, labels, index=idx)
    dmax = ndimage.maximum(fd, labels, index=idx)
    spill = ndimage.maximum(fl, labels, index=idx)
    gmax = ndimage.maximum(de, labels, index=idx)

    out: list[Pit] = []
    for i in range(n):
        out.append(Pit(
            pit_id=i + 1,
            area_m2=round(float(counts[i] * cell_area_m2), 2),
            max_fill_depth_m=round(float(dmax[i]), 3),
            volume_m3=round(float(vol[i] * cell_area_m2), 2),
            spill_elev_m_tp=round(float(spill[i]), 3),
            max_ground_elev_m_tp=round(float(gmax[i]), 3),
        ))
    return out
