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
- **flow accumulation = D-infinity**（Tarboton 1997。既定）ないし **D8**
  （O'Callaghan & Mark 1984）。ε 充填面の最急降下で流し、位相ソートで上流セル数を
  数える。一様単位降雨（有効セルの寄与 = 1）。D-inf は 8 三角 facet の最急勾配方向を
  求め、それを挟む隣接 2 セルへ角度で按分する（1 セル最大 2 receiver）。numba も C++
  も使わず純 numpy/scipy で書ける（`docs/data.md` §7「FARR 取り込み・第 4 段」）。
  D8 API は比較用に残してある。`method={"dinf","d8"}` で切替（`route_with_collar`）。

境界: 配列の外周セルと nodata セルを流出先（sink）とする。nodata は京都府 DEM
では主に開放水面（湾・川・水路）なので、そこに達した流れは AOI を出たとみなす。
最急降下が外周で map の外へ抜けるセルは「AOI 端で切れている」フラグを立てる。

**collar（縁取り）**: AOI 端の集水を過小評価しないよう、`route_with_collar` は
AOI の外周に GSI 5m DEM のバッファ帯を張ってからルーティングし、集計・書き出しは
元の AOI 矩形に clip する（`scripts/33`、`docs/data.md` §7）。collar はルーティング
専用で、窪地の充填深・越流点・容積は AOI 内のセルだけ集計する。collar と method
（dinf / d8）は直交する。
"""
from __future__ import annotations

import array
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


# --- D-infinity（Tarboton 1997）-------------------------------------------------
#
# D8 は 1 セル 1 方向なので尾根の分岐が粗い。D-inf は各セルで 8 つの三角 facet の
# うち最急降下のものを選び、その facet を挟む隣接 2 セル（基本方位 e1・斜め e2）へ
# 流れの角度で按分する（1 セル最大 2 receiver）。純 numpy/scipy で書けるので
# `requirements.txt` は増えない（`docs/data.md` §7）。D8 API はそのまま残す。

_PI4 = math.pi / 4.0
#: routing 上で nodata（海・水路）に与える「必ず下る」標高。inf を避けて有限値にする
_ROUTE_NODATA = -1.0e18

#: Tarboton (1997) Table 1 の 8 facet。各要素は
#: `((e1 の dy,dx), (e2 の dy,dx))`。e1 = 基本方位の隣（距離 1）、e2 = 斜めの隣。
#: facet 内角 r（e1 から e2 へ測る、範囲 [0, π/4]）で 2 セルへ配分する。
_DINF_FACETS: tuple[tuple[tuple[int, int], tuple[int, int]], ...] = (
    ((0, 1), (-1, 1)), ((-1, 0), (-1, 1)),
    ((-1, 0), (-1, -1)), ((0, -1), (-1, -1)),
    ((0, -1), (1, -1)), ((1, 0), (1, -1)),
    ((1, 0), (1, 1)), ((0, 1), (1, 1)),
)


@dataclass(frozen=True)
class DinfResult:
    receiver1: np.ndarray     # int32 flat index（第 1 receiver。自分自身 = 端流出/sink）
    receiver2: np.ndarray     # int32 flat index（第 2 receiver。無ければ receiver1 と同じ）
    prop1: np.ndarray         # float64, receiver1 へ配分する割合（単一なら 1.0、終端は 0.0）
    prop2: np.ndarray         # float64, receiver2 へ配分する割合（単一なら 0.0）
    edge_outlet: np.ndarray   # bool, map の外へ抜けるセル
    sink_outlet: np.ndarray   # bool, nodata（海・水路）へ流れ込むセル
    order: np.ndarray         # int32, 位相ソート順（source -> sink）の flat index


def dinf_flow_direction(filled: np.ndarray) -> DinfResult:
    """ε 充填面から D-infinity（Tarboton 1997）の流向を決める。

    各セルは 8 つの三角 facet の中で最急降下のものを選び、その facet を挟む
    2 つの隣接セル（基本方位 e1・斜め e2）へ facet 内角で按分して流す（最大 2
    receiver）。内角 r が 0 なら e1 だけ、π/4 なら e2 だけに流れ、D8 に一致する。

    nodata は routing 上 -1e18（必ず下る）として扱うので海に隣接するセルは海へ
    流れ、`sink_outlet` が立つ。外周で map 外へ抜けるセルは `edge_outlet`。
    どちらでもない有効セルは必ず下流の有効セルを持つ（Priority-Flood + ε の帰結）。
    """
    filled = np.asarray(filled, dtype="float64")
    h, w = filled.shape
    valid = np.isfinite(filled)

    routing = np.where(valid, filled, _ROUTE_NODATA)
    padded = np.full((h + 2, w + 2), np.inf, dtype="float64")  # map 外は登れない壁
    padded[1:-1, 1:-1] = routing
    e0 = padded[1:-1, 1:-1]

    best_s = np.full((h, w), -np.inf, dtype="float64")
    best_r = np.zeros((h, w), dtype="float64")
    best_k = np.full((h, w), -1, dtype="int8")
    sqrt2 = math.sqrt(2.0)
    with np.errstate(invalid="ignore"):
        for k, ((dy1, dx1), (dy2, dx2)) in enumerate(_DINF_FACETS):
            e1 = padded[1 + dy1:1 + dy1 + h, 1 + dx1:1 + dx1 + w]
            e2 = padded[1 + dy2:1 + dy2 + h, 1 + dx2:1 + dx2 + w]
            s1 = e0 - e1
            s2 = e1 - e2
            r = np.arctan2(s2, s1)
            s = np.hypot(s1, s2)
            lo = r < 0.0
            r = np.where(lo, 0.0, r)
            s = np.where(lo, s1, s)
            hi = r > _PI4
            r = np.where(hi, _PI4, r)
            s = np.where(hi, (e0 - e2) / sqrt2, s)
            # e1/e2 が map 外（inf）の facet は使えない。nodata（-1e18）は可
            usable = np.isfinite(e1) & np.isfinite(e2)
            take = usable & (s > best_s) & (s > 0.0)
            best_s = np.where(take, s, best_s)
            best_r = np.where(take, r, best_r)
            best_k = np.where(take, np.int8(k), best_k)

    idx = np.arange(h * w, dtype="int64").reshape(h, w)
    r1 = idx.copy()
    r2 = idx.copy()
    p1 = np.zeros((h, w), dtype="float64")
    p2 = np.zeros((h, w), dtype="float64")

    has_down = valid & (best_k >= 0)
    ys, xs = np.nonzero(has_down)
    if ys.size:
        kk = best_k[ys, xs]
        rr = best_r[ys, xs]
        e1y = ys.copy(); e1x = xs.copy()
        e2y = ys.copy(); e2x = xs.copy()
        for k, ((dy1, dx1), (dy2, dx2)) in enumerate(_DINF_FACETS):
            m = kk == k
            if not m.any():
                continue
            e1y[m] = ys[m] + dy1; e1x[m] = xs[m] + dx1
            e2y[m] = ys[m] + dy2; e2x[m] = xs[m] + dx2
        prop_e2 = rr / _PI4
        r1[ys, xs] = idx[e1y, e1x]
        r2[ys, xs] = idx[e2y, e2x]
        p1[ys, xs] = 1.0 - prop_e2
        p2[ys, xs] = prop_e2

    flat_valid = valid.reshape(-1)
    r1f = r1.reshape(-1)
    r2f = r2.reshape(-1)
    p1f = p1.reshape(-1)
    p2f = p2.reshape(-1)
    ar = np.arange(h * w)

    # receiver が nodata のセルは海へ抜ける（sink）。receiver を自分自身に畳んで
    # DAG を閉じ、accumulation では終端として扱う（D8 の sink_outlet と同じ）
    r1_nd = (r1f != ar) & ~flat_valid[r1f] & (p1f > 0.0)
    r2_nd = (r2f != ar) & ~flat_valid[r2f] & (p2f > 0.0)
    sink = flat_valid & (r1_nd | r2_nd)
    r1f[sink] = ar[sink]; r2f[sink] = ar[sink]
    p1f[sink] = 1.0; p2f[sink] = 0.0

    on_border = np.zeros((h, w), dtype=bool)
    on_border[0, :] = on_border[-1, :] = on_border[:, 0] = on_border[:, -1] = True
    no_rec = flat_valid & (r1f == ar)
    edge_outlet = (no_rec & ~sink & on_border.reshape(-1)).reshape(h, w)

    order = _drain_order(filled.reshape(-1), flat_valid)
    return DinfResult(
        receiver1=r1f.reshape(h, w).astype("int32"),
        receiver2=r2f.reshape(h, w).astype("int32"),
        prop1=p1f.reshape(h, w),
        prop2=p2f.reshape(h, w),
        edge_outlet=edge_outlet,
        sink_outlet=sink.reshape(h, w),
        order=order.astype("int32"),
    )


def _drain_order(filled_flat: np.ndarray, flat_valid: np.ndarray) -> np.ndarray:
    """accumulation の処理順（flat index、標高の高いセルから）。

    各セルは donor（自分に流し込むセル）すべてより後、receiver より先に処理したい。
    ε 充填面では正の配分先 receiver は必ず中心セルより真に低いので、
    **充填標高の降順**がそのまま妥当な位相順になる（Kahn を回さずに済む）。
    同一標高で互いに流し合うセルは無いので同着の並びは任意でよい。
    """
    fl = np.where(flat_valid, filled_flat, -np.inf)
    order = np.argsort(fl, kind="stable")[::-1]
    n_valid = int(flat_valid.sum())
    return order[:n_valid].astype("int64")


def dinf_accumulation(
    dinf: DinfResult, valid: np.ndarray, weights: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """上流寄与セル数（自セルを含む）を返す。一様単位降雨なら weights=None。

    D8 の `d8_accumulation` と同じ契約。各セルの寄与は最大 2 receiver へ
    `prop1` / `prop2` で割って流す（分配しても総量は保存する）。

    返り値: `(accum, edge_drained_fraction)`。
    - `accum`: float64。有効セルは >= 1（自セルの降雨ぶん）。nodata は 0。
    - `edge_drained_fraction`: float64（0–1）。そのセルの流出のうち、最終的に
      AOI 外周で map の外へ抜ける割合（配分を下流へ辿った加重平均）。nodata（海）へ
      抜けるぶんは 0 に数える。D8 の `d8_accumulation` が返す bool（1 経路が端へ
      抜けるか）を、分配に合わせて連続値に一般化したもの。端流出セルは 1.0。
    """
    h, w = valid.shape
    n = h * w
    flat_valid = valid.reshape(-1)

    accum0 = np.where(flat_valid, 1.0, 0.0)
    if weights is not None:
        accum0 = np.where(flat_valid, np.asarray(weights, dtype="float64").reshape(-1), 0.0)

    # 0.5 m 条件は数千万セルあり Python ループを回す。numpy スカラ index は遅く、
    # list 化はメモリを食い過ぎる（4000 万要素の float list で ~1 GB）。
    # `array.array`（型付き・オブジェクト無し）で両方を避ける。index は int32 で足りる
    # （最大セル数 < 2^31）。
    order = array.array("i")
    order.frombytes(dinf.order.reshape(-1).astype("int32").tobytes())
    rec1 = array.array("i")
    rec1.frombytes(dinf.receiver1.reshape(-1).astype("int32").tobytes())
    rec2 = array.array("i")
    rec2.frombytes(dinf.receiver2.reshape(-1).astype("int32").tobytes())
    p1 = array.array("d")
    p1.frombytes(np.ascontiguousarray(dinf.prop1, dtype="float64").tobytes())
    p2 = array.array("d")
    p2.frombytes(np.ascontiguousarray(dinf.prop2, dtype="float64").tobytes())
    accum = array.array("d")
    accum.frombytes(np.ascontiguousarray(accum0, dtype="float64").tobytes())

    for c in order:
        a = accum[c]
        r = rec1[c]
        if r != c:
            w1 = p1[c]
            if w1 > 0.0:
                accum[r] += a * w1
        r = rec2[c]
        if r != c:
            w2 = p2[c]
            if w2 > 0.0:
                accum[r] += a * w2

    edge = array.array("b")
    edge.frombytes(np.ascontiguousarray(dinf.edge_outlet, dtype="int8").tobytes())
    ef = array.array("d", bytes(8 * n))   # 端へ抜ける流出の割合（下流から伝播）
    for c in reversed(order):
        r1 = rec1[c]
        r2 = rec2[c]
        has_rec = False
        val = 0.0
        w1 = p1[c]
        if r1 != c and w1 > 0.0:
            has_rec = True
            val += w1 * ef[r1]
        w2 = p2[c]
        if r2 != c and w2 > 0.0:
            has_rec = True
            val += w2 * ef[r2]
        ef[c] = val if has_rec else (1.0 if edge[c] else 0.0)

    accum_out = np.frombuffer(accum, dtype="float64").copy()
    accum_out[~flat_valid] = 0.0
    edge_frac = np.frombuffer(ef, dtype="float64").copy()
    edge_frac[~flat_valid] = 0.0
    return accum_out.reshape(h, w), edge_frac.reshape(h, w)


@dataclass(frozen=True)
class CollarRouting:
    """`route_with_collar` の結果。配列はすべて AOI 矩形に clip 済み。

    - `filled`: collar DEM を外周に付けて解いた ε 充填面（AOI 部分）。**AOI 端の
      窪地は collar の地形で堰き止められて充填深が変わる**ので、窪地の充填深・
      越流点・容積を「collar 帯を数えない」形で出したいなら、これではなく
      `priority_flood_fill(dem)`（AOI 単独）を使うこと（`scripts/33`）。
    - `accum`: 集水セル数。**collar 経由で AOI に流れ込む上流の寄与を含む**ので、
      AOI 端のセルで collar 無しより増える。
    - `term_edge`: そのセルの流出のうち最終的に **collar の外周**で map の外へ
      抜ける割合（= まだ端で切れているぶん）。collar 内の窪地・海（nodata）で
      終わるぶんは 0。`method="d8"` では bool（0/1）、`"dinf"` では 0–1 の連続値。
    - `sink_outlet` / `edge_outlet`: AOI セルのうち nodata へ直接流れ込む / 下流を
      持たず AOI 矩形の縁に接するもの（collar 有りでは後者はほぼ空になる）。
    """
    filled: np.ndarray
    accum: np.ndarray
    term_edge: np.ndarray
    sink_outlet: np.ndarray
    edge_outlet: np.ndarray
    conservation_ok: bool
    collar_shape: tuple[int, int]
    #: `want_basins=True`（かつ `method="dinf"`）のときだけ。collar グリッドで
    #: 分割した部分流域を **AOI 矩形に clip** したもの（`flow_basins`）。AOI 外へ
    #: 出る／collar 側に上流を持つ流域は `edge_truncated` が立つ。
    basins: "BasinResult | None" = None


def _clip_basins(
    basins: "BasinResult", row0: int, col0: int, h: int, w: int,
) -> "BasinResult":
    """`flow_basins` の結果を `[row0:row0+h, col0:col0+w]` の矩形に切り出す。

    矩形の外にはみ出す流域・吐口が矩形外にある流域は `edge_truncated` を立てる
    （collar 側に上流／下流があり、AOI では集水域が切れている）。id は詰め直す。

    **`max_accum`（= その流域の集水域の広さ）は再クリップしない。** collar 側の
    上流ぶんを含んだ真の値を残し、`edge_truncated` の流域では「面（`labels`）は
    AOI 内だけ・集水サイズは collar 込み」になる。viewer はこの食い違いを
    インスペクタで断る（`web/src/ui/inspector.ts`、`docs/web_design.md`）。

    併合（`_coarsen_basins`）は clip の**前**に collar グリッド全体で済ませてある。
    clip で AOI に食い込むだけの縁の破片がいくつか残るが、いずれも
    `edge_truncated=True`（集水域が AOI 外へ延びている）でマークされる。
    """
    lab_big = basins.labels
    sub = lab_big[row0:row0 + h, col0:col0 + w]
    present = np.unique(sub)
    present = present[present > 0]
    remap = np.zeros(basins.n_basins + 1, dtype="int64")
    remap[present] = np.arange(1, present.size + 1)
    k = int(present.size)

    total = np.bincount(lab_big.reshape(-1), minlength=basins.n_basins + 1)
    inside = np.bincount(sub.reshape(-1), minlength=basins.n_basins + 1)

    new_downstream = np.full(k + 1, -1, dtype="int64")
    new_outlet = np.full((k + 1, 2), -1, dtype="int64")
    new_maxacc = np.zeros(k + 1, dtype="float64")
    new_edge = np.zeros(k + 1, dtype=bool)
    for old in present.tolist():
        nb = int(remap[old])
        d = int(basins.downstream[old])
        new_downstream[nb] = int(remap[d]) if d != -1 and remap[d] > 0 else -1
        new_maxacc[nb] = float(basins.max_accum[old])
        orow, ocol = (int(v) for v in basins.outlet_rc[old])
        in_clip = row0 <= orow < row0 + h and col0 <= ocol < col0 + w
        if in_clip:
            new_outlet[nb] = (orow - row0, ocol - col0)
        new_edge[nb] = (bool(basins.edge_truncated[old])
                        or int(inside[old]) < int(total[old]) or not in_clip)
    return BasinResult(
        labels=remap[sub].astype("int32"),
        downstream=new_downstream.astype("int32"),
        outlet_rc=new_outlet.astype("int32"),
        max_accum=new_maxacc,
        edge_truncated=new_edge,
        n_basins=k,
    )


def route_with_collar(
    dem: np.ndarray, collar_dem: np.ndarray, collar: int, method: str = "dinf",
    *, want_basins: bool = False, basin_channel_min_accum: float = 0.0,
    basin_min_cells: int = 0, basin_max_basins: int = 0,
) -> CollarRouting:
    """`dem`（AOI）の外周に `collar_dem` のバッファ帯を張ってから Priority-Flood +
    flow accumulation を回し、AOI 矩形に clip した集水・端フラグを返す。

    `method`: `"dinf"`（既定、D-infinity / Tarboton 1997）または `"d8"`（比較用）。

    `collar_dem` は shape `(H + 2*collar, W + 2*collar)`。中心 `(H, W)` は必ず
    `dem` で上書きするので、呼び手は帯だけ埋めれば十分（全面 GSI DEM を渡してもよい）。
    NaN = nodata。`collar == 0` なら collar 無し（`*_flow_direction` /
    `*_accumulation` を素の AOI に掛けるのと一致する）。

    **collar 帯はルーティングにだけ使う。** 返すのは `accum` と `term_edge`（と
    その補助フラグ）。窪地の充填深・越流点標高・容積は collar で AOI 端の窪地の
    充填面まで動くので、呼び手は **AOI 単独**の `priority_flood_fill(dem)` で別に
    解いて AOI セルだけ集計すること（`scripts/33`、`docs/data.md` §7）。
    返り値の `filled` は collar 込みの充填面で、その用途には使わない。
    """
    dem = np.asarray(dem, dtype="float64")
    h, w = dem.shape
    c = int(collar)
    if c < 0:
        raise ValueError("collar must be >= 0")
    if method not in ("dinf", "d8"):
        raise ValueError(f"method must be 'dinf' or 'd8', got {method!r}")
    big = np.array(collar_dem, dtype="float64")
    if big.shape != (h + 2 * c, w + 2 * c):
        raise ValueError(
            f"collar_dem shape {big.shape} != {(h + 2 * c, w + 2 * c)}")
    big[c:c + h, c:c + w] = dem

    filled_big = priority_flood_fill(big)
    valid_big = np.isfinite(filled_big)
    flat_valid = valid_big.reshape(-1)

    if method == "d8":
        fd = d8_flow_direction(filled_big)
        accum_big, term_big = d8_accumulation(fd, valid_big)
        rec1 = fd.receiver.reshape(-1)
        sink_big, edge_big = fd.sink_outlet, fd.edge_outlet
    else:
        fd = dinf_flow_direction(filled_big)
        accum_big, term_big = dinf_accumulation(fd, valid_big)
        rec1 = fd.receiver1.reshape(-1)
        sink_big, edge_big = fd.sink_outlet, fd.edge_outlet

    # 一様単位降雨の保存則は collar グリッド全体で見る。終端 = receiver を持たない
    # セル（端流出・sink・孤立窪地）。ここに全降雨が集まる
    terminal = flat_valid & ((rec1 == np.arange(rec1.size)) | ~flat_valid[rec1])
    n_valid = int(valid_big.sum())
    term_sum = float(accum_big.reshape(-1)[terminal].sum())

    basins = None
    if want_basins:
        if method != "dinf":
            raise ValueError("want_basins は method='dinf' のときだけ使える")
        big_basins = flow_basins(
            fd, valid_big, accum_big, channel_min_accum=basin_channel_min_accum,
            min_basin_cells=basin_min_cells, max_basins=basin_max_basins,
            term_edge=term_big)
        basins = _clip_basins(big_basins, c, c, h, w)

    sl = (slice(c, c + h), slice(c, c + w))
    return CollarRouting(
        filled=filled_big[sl].copy(),
        accum=accum_big[sl].copy(),
        term_edge=term_big[sl].copy(),
        sink_outlet=(sink_big[sl] & valid_big[sl]).copy(),
        edge_outlet=edge_big[sl].copy(),
        conservation_ok=abs(term_sum - n_valid) <= max(0.5, 1e-6 * n_valid),
        collar_shape=big.shape,
        basins=basins,
    )


def edge_truncated_fraction(filled: np.ndarray, method: str = "dinf") -> float:
    """collar 無しで解いたときに集水域が AOI 端で切れるセルの割合。

    `route_with_collar` の前後比較用。`filled` は `priority_flood_fill(dem)` の
    結果（collar 無し）。`method` は `route_with_collar` と揃える。
    """
    filled = np.asarray(filled, dtype="float64")
    valid = np.isfinite(filled)
    flat_valid = valid.reshape(-1)
    if method == "d8":
        fd = d8_flow_direction(filled)
        _, term = d8_accumulation(fd, valid)
    elif method == "dinf":
        fd = dinf_flow_direction(filled)
        _, term = dinf_accumulation(fd, valid)
    else:
        raise ValueError(f"method must be 'dinf' or 'd8', got {method!r}")
    term_edge = term.reshape(-1)
    nv = int(flat_valid.sum())
    return float(term_edge[flat_valid].mean()) if nv else 0.0


# --- 部分流域への分割（クリックで集水域抽出。FARR 取り込み・最終段）----------------
#
# viewer は「地図をクリックした地点の上流（集水域）を面で出す」。receiver グリッド
# （D-inf は receiver1/receiver2/prop1/prop2 の 4 枚）を 0.5m 全域でクライアントへ
# 配信するのは非現実的なので、解析側で **主 receiver（配分の大きい方）の流下木**を
# 作り、本流セル（accum >= 閾値）の合流点で切って数十〜数百個のリーフ部分流域に
# する。各リーフに「下流のリーフ」を持たせて配信し（`downstream`）、viewer は
# それを逆にたどって「クリックしたリーフ＋その上流の全リーフ」を union する。
# `docs/data.md` §7 / `docs/web_design.md`「クリックで集水域を抽出する」。


@dataclass(frozen=True)
class BasinResult:
    """`flow_basins` の結果。id は 1..n_basins（0 = nodata / 未割当）。"""
    labels: np.ndarray          # int32 (h, w), セルごとのリーフ流域 id
    downstream: np.ndarray      # int32 (n_basins + 1,), downstream[b] = b の下流流域 id（終端は -1）
    outlet_rc: np.ndarray       # int32 (n_basins + 1, 2), 各流域の吐口セル (row, col)（未割当は -1）
    max_accum: np.ndarray       # float64 (n_basins + 1,), 吐口の集水セル数（= その流域の集水域の広さ）。
    #                             _clip_basins は **これを再クリップしない** ので、collar 側に
    #                             上流を持つ流域では collar 込みの真の上流サイズが残る（`edge_truncated`）
    edge_truncated: np.ndarray  # bool (n_basins + 1,), 吐口の流出が AOI/collar 端で切れているか
    n_basins: int

    def upstream_of(self, basin_id: int) -> "set[int]":
        """`basin_id` とその上流すべての流域 id（`downstream` を逆にたどる）。

        viewer の `catchmentOf` と同じ木を Python 側で確認するためのもの
        （`tests/test_flow_accum.py`）。"""
        children: dict[int, list[int]] = {}
        for b in range(1, self.n_basins + 1):
            d = int(self.downstream[b])
            if d != -1:
                children.setdefault(d, []).append(b)
        out: set[int] = set()
        stack = [int(basin_id)]
        while stack:
            b = stack.pop()
            if b in out:
                continue
            out.add(b)
            stack.extend(children.get(b, ()))
        return out


def flow_basins(
    dinf: DinfResult,
    valid: np.ndarray,
    accum: np.ndarray,
    channel_min_accum: float,
    min_basin_cells: int = 0,
    max_basins: int = 0,
    term_edge: np.ndarray | None = None,
) -> BasinResult:
    """主 receiver の流下木を本流の合流点で切って部分流域に分割する。

    D-infinity は 1 セル最大 2 receiver だが、ここでは **配分の大きい方
    （`prop1 >= prop2` なら `receiver1`）だけを主 receiver として木を作る**。
    この木を「本流セル（`accum >= channel_min_accum`）」の合流点
    （本流ドナーを 2 つ以上持つ本流セル）で切り、各セグメントの上流集水を
    1 つのリーフ流域にまとめる。

    - `accum`: `dinf_accumulation` の集水セル数（`dinf` と同じグリッド）。
    - `channel_min_accum`: 本流とみなす集水セル数の下限（`scripts/33` が m² から換算）。
    - `min_basin_cells`: セル数がこれ未満のリーフ流域は下流へ吸収する
      （配信するポリゴン数を抑える。0 で無効）。
    - `term_edge`: `dinf_accumulation` / `route_with_collar` が返す端流出割合。
      吐口セルの値 > 0.5 の流域に `edge_truncated` を立てる。省略時は全 False。

    返す `downstream` はリーフ流域どうしの下流関係。viewer はこれを逆にたどって
    「クリック地点の上流の全リーフ」を union する（`docs/web_design.md`）。
    """
    valid = np.asarray(valid, dtype=bool)
    h, w = valid.shape
    n = h * w
    flat_valid = valid.reshape(-1)
    r1 = dinf.receiver1.reshape(-1).astype("int64")
    r2 = dinf.receiver2.reshape(-1).astype("int64")
    p1 = dinf.prop1.reshape(-1)
    p2 = dinf.prop2.reshape(-1)
    ar = np.arange(n, dtype="int64")
    acc = np.asarray(accum, dtype="float64").reshape(-1)

    # 主 receiver = 配分の大きい方。終端（自分自身 or nodata 受け）は自分に畳む
    main = np.where(p2 > p1, r2, r1)
    terminal = flat_valid & ((main == ar) | ~flat_valid[main])
    main = np.where(terminal, ar, main)

    channel = flat_valid & (acc >= float(channel_min_accum))
    chan_src = ar[channel & ~terminal]
    donor = np.zeros(n, dtype="int64")
    np.add.at(donor, main[chan_src], 1)
    junction = channel & (donor >= 2)

    # 木を切るのは「本流セルが合流点へ流れ込む辺」。合流点へ入る各支流リンクが
    # 別々の流域になり（左右の枝が分かれる）、合流点セル自身は下流側の流域に属す。
    main_is_junction = np.zeros(n, dtype=bool)
    mv = chan_src  # 本流かつ非終端のセル
    main_is_junction[mv] = junction[main[mv]]
    is_outlet = terminal | main_is_junction

    # 各セルの吐口 = 下流へ主 receiver をたどって最初に当たる is_outlet セル。
    # 充填標高の昇順（下流が先）に 1 パス。`dinf.order` は降順なので反転して回す。
    # 4M セルの Python ループなので `array.array`（`dinf_accumulation` と同じ手）。
    order_a = array.array("i")
    order_a.frombytes(np.ascontiguousarray(dinf.order, dtype="int32").tobytes())
    main_a = array.array("i")
    main_a.frombytes(main.astype("int32").tobytes())
    outlet_a = array.array("b")
    outlet_a.frombytes(is_outlet.astype("int8").tobytes())
    stop_a = array.array("i")
    stop_a.frombytes(ar.astype("int32").tobytes())
    for c in reversed(order_a):
        if outlet_a[c]:
            stop_a[c] = c
        else:
            mc = main_a[c]
            if mc != c:
                stop_a[c] = stop_a[mc]
    stop = np.frombuffer(stop_a, dtype="int32").astype("int64")

    outlets = np.unique(stop[flat_valid])
    remap = np.zeros(n, dtype="int64")
    remap[outlets] = np.arange(1, outlets.size + 1)
    labels_flat = np.where(flat_valid, remap[stop], 0)
    nb = int(outlets.size)

    downstream = np.full(nb + 1, -1, dtype="int64")
    for b in range(1, nb + 1):
        o = int(outlets[b - 1])
        if not terminal[o]:
            downstream[b] = int(labels_flat[main[o]])

    max_accum = np.zeros(nb + 1, dtype="float64")
    np.maximum.at(max_accum, labels_flat[flat_valid], acc[flat_valid])

    if nb > 1 and ((min_basin_cells and min_basin_cells > 1) or max_basins):
        labels_flat, downstream, outlets, max_accum = _coarsen_basins(
            labels_flat, downstream, outlets, max_accum, flat_valid,
            h, w, int(min_basin_cells), int(max_basins))
        nb = int(outlets.size)

    edge = np.zeros(nb + 1, dtype=bool)
    if term_edge is not None:
        te = np.asarray(term_edge, dtype="float64").reshape(-1)
        edge[1:] = te[outlets] > 0.5

    outlet_rc = np.full((nb + 1, 2), -1, dtype="int64")
    outlet_rc[1:, 0] = outlets // w
    outlet_rc[1:, 1] = outlets % w

    return BasinResult(
        labels=labels_flat.reshape(h, w).astype("int32"),
        downstream=downstream.astype("int32"),
        outlet_rc=outlet_rc.astype("int32"),
        max_accum=max_accum,
        edge_truncated=edge,
        n_basins=nb,
    )


def _basin_adjacency(labels_flat: np.ndarray, h: int, w: int, nb: int) -> dict:
    """リーフ流域 id の隣接（共有境界の長さ）。`{a: {b: 共有辺数}}`（a < b 双方向）。"""
    lab = labels_flat.reshape(h, w)
    adj: dict[int, dict[int, int]] = {b: {} for b in range(1, nb + 1)}
    mult = nb + 1
    for a_arr, b_arr in ((lab[:, :-1], lab[:, 1:]), (lab[:-1, :], lab[1:, :])):
        a = a_arr.reshape(-1)
        b = b_arr.reshape(-1)
        m = (a != b) & (a > 0) & (b > 0)
        lo = np.minimum(a[m], b[m]).astype("int64")
        hi = np.maximum(a[m], b[m]).astype("int64")
        keys, counts = np.unique(lo * mult + hi, return_counts=True)
        for k, c in zip(keys.tolist(), counts.tolist()):
            x, y = divmod(k, mult)
            adj[x][y] = adj[x].get(y, 0) + c
            adj[y][x] = adj[y].get(x, 0) + c
    return adj


def _coarsen_basins(
    labels_flat: np.ndarray, downstream: np.ndarray, outlets: np.ndarray,
    max_accum: np.ndarray, flat_valid: np.ndarray, h: int, w: int,
    min_cells: int, max_basins: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """細かすぎるリーフ流域を **隣接する流域へ併合**して数を減らす。

    毎回「セル数 < `min_cells` の流域（最優先）／`max_basins` を超えているなら
    吐口の集水がいちばん小さい流域」を、**共有境界がいちばん長い隣接流域**へ
    併合する。これで海際の 1〜数セルの終端破片も、数値地形の平滑な収束域で
    D-infinity の分流→再合流が作る擬似合流点も、まとめて畳める
    （`docs/data.md` §7、`docs/web_design.md`）。id は連番に詰め直す。

    - `min_cells`: セル数がこれ未満の流域は隣へ併合する（0 で無効）。
    - `max_basins`: 生存流域数がこれ以下になるまで併合を続ける（0 で無効）。
    """
    import heapq

    nb = int(outlets.size)
    cnt = np.bincount(labels_flat[flat_valid], minlength=nb + 1).astype("int64")
    ds = downstream.astype("int64").copy()
    macc = max_accum.astype("float64").copy()
    alive = np.ones(nb + 1, dtype=bool)
    alive[0] = False
    redirect = np.arange(nb + 1, dtype="int64")
    adj = _basin_adjacency(labels_flat, h, w, nb)
    children: dict[int, list[int]] = {}
    for b in range(1, nb + 1):
        d = int(ds[b])
        if d != -1:
            children.setdefault(d, []).append(b)

    target = max_basins if max_basins else 0
    n_alive = nb
    gen = np.zeros(nb + 1, dtype="int64")

    def entry(b: int) -> tuple:
        forced = bool(min_cells) and cnt[b] < min_cells
        return (0 if forced else 1,
                float(cnt[b]) if forced else float(macc[b]), int(gen[b]), b)

    heap = [entry(b) for b in range(1, nb + 1)]
    heapq.heapify(heap)

    while heap:
        f, _metric, g, b = heapq.heappop(heap)
        if not alive[b] or g != gen[b]:
            continue
        forced = bool(min_cells) and cnt[b] < min_cells
        if not forced and (target == 0 or n_alive <= target):
            continue
        nbrs = [(bord, macc[q], q) for q, bord in adj.get(b, {}).items() if alive[q]]
        if not nbrs:
            continue
        _b, _m, p = max(nbrs)
        alive[b] = False
        redirect[b] = p
        cnt[p] += cnt[b]
        macc[p] = max(macc[p], macc[b])
        for q, bord in adj.pop(b, {}).items():
            if q == p or not alive[q]:
                adj.get(q, {}).pop(b, None)
                continue
            adj[p][q] = adj[p].get(q, 0) + bord
            adj[q][p] = adj[q].get(p, 0) + bord
            adj[q].pop(b, None)
        adj.get(p, {}).pop(b, None)
        for ch in children.get(b, ()):
            ds[ch] = p
            children.setdefault(p, []).append(ch)
        n_alive -= 1
        gen[p] += 1
        heapq.heappush(heap, entry(p))

    survivors = [b for b in range(1, nb + 1) if alive[b]]

    def root(b: int) -> int:
        while redirect[b] != b:
            b = int(redirect[b])
        return b

    compact = {old: i + 1 for i, old in enumerate(survivors)}
    lut = np.zeros(nb + 1, dtype="int64")
    for b in range(1, nb + 1):
        lut[b] = compact[root(b)]
    new_labels = np.where(flat_valid, lut[labels_flat], 0)
    new_outlets = outlets[np.array(survivors, dtype="int64") - 1]

    k = len(survivors)
    new_ds = np.full(k + 1, -1, dtype="int64")
    new_macc = np.zeros(k + 1, dtype="float64")
    for old in survivors:
        nb_id = compact[old]
        new_macc[nb_id] = macc[old]
        d = int(ds[old])
        if d == -1:
            continue
        nd = compact[root(d)]
        new_ds[nb_id] = -1 if nd == nb_id else nd
    return new_labels, new_ds, new_outlets, new_macc


@dataclass(frozen=True)
class Pit:
    pit_id: int
    area_m2: float
    max_fill_depth_m: float
    volume_m3: float
    spill_elev_m_tp: float
    max_ground_elev_m_tp: float
    #: 越流点セルの行・列（`pit_pour_points`）。窪地から水が溢れ出す鞍部の位置。
    #: viewer のマーカーはここに置く（`scripts/33` が GeoJSON に起こす）
    pour_row: int = -1
    pour_col: int = -1


def label_pits(
    fill_depth: np.ndarray, min_depth_m: float = 0.01
) -> tuple[np.ndarray, int]:
    """充填深 > `min_depth_m` の連結成分を窪地としてラベリング（8 近傍）。

    `min_depth_m` は ε 充填の ULP 積み上がりと float32 往復を無視するための下限。
    """
    mask = np.asarray(fill_depth) > min_depth_m
    lab, n = ndimage.label(mask, structure=_STRUCT8)
    return lab.astype("int32"), int(n)


def top_pits_by_area(
    labels: np.ndarray, min_area_m2: float, cell_area_m2: float, max_count: int,
) -> "set[int]":
    """面積上位の窪地 ID（`min_area_m2` 以上を面積降順で `max_count` 件まで）。

    越流点マーカーに出す窪地を先に絞るのに使う（`scripts/33`。highres で窪地は
    5〜7 万個あり、全部の越流点を計算すると遅い）。
    """
    labels = np.asarray(labels)
    n = int(labels.max())
    if n == 0:
        return set()
    counts = ndimage.sum_labels(np.ones(labels.shape), labels, index=np.arange(1, n + 1))
    min_cells = min_area_m2 / cell_area_m2
    order = np.argsort(counts)[::-1]
    return {int(order[k]) + 1 for k in range(min(n, max_count))
            if counts[order[k]] >= min_cells}


def pit_pour_points(
    labels: np.ndarray, fill_depth: np.ndarray, filled: np.ndarray,
    only: "set[int] | None" = None,
) -> dict[int, tuple[int, int]]:
    """窪地 ID -> 越流点セル (row, col)。

    越流点 = その窪地を止めている鞍部。窪地内で、**窪地の外の低い有効セルに
    隣接していて**（= 縁のセル）、充填面が越流水位（窪地内の `filled` 最大値）に
    いちばん近いセルを採る。同着は「外側がいちばん低い」で割る（そこが実際の吐け口）。
    縁のセルが取れない窪地（数値誤差）は最深セル（`fill_depth` の最大）で代用する。

    `only` を渡すとその窪地 ID だけ返す（越流点が要るのは配信する上位の窪地だけで、
    全 5〜7 万個を回すと遅い。`scripts/33`）。**全画素 1 パスのベクタ演算**なので
    `only` を絞っても速度は主に窪地の総数で決まる（`ndimage` の集約部分）。
    """
    labels = np.asarray(labels)
    n = int(labels.max())
    if n == 0:
        return {}
    fl = np.asarray(filled, dtype="float64")
    fd = np.asarray(fill_depth, dtype="float64")
    ids = np.arange(1, n + 1)
    spill = ndimage.maximum(fl, labels, index=ids)

    inside = labels > 0
    # 各セルについて「外側の有効セル隣接の filled 最小値」を 8 シフトで求める
    outside = np.isfinite(fl) & ~inside
    out_fl = np.where(outside, fl, np.inf)
    min_out = np.full(labels.shape, np.inf)
    for dy, dx, _d in _D8:
        shifted = np.full(labels.shape, np.inf)
        ys = slice(max(dy, 0), labels.shape[0] + min(dy, 0))
        xs = slice(max(dx, 0), labels.shape[1] + min(dx, 0))
        yt = slice(max(-dy, 0), labels.shape[0] + min(-dy, 0))
        xt = slice(max(-dx, 0), labels.shape[1] + min(-dx, 0))
        shifted[yt, xt] = out_fl[ys, xs]
        min_out = np.minimum(min_out, shifted)

    rim = inside & np.isfinite(min_out)
    # spill を各セルにブロードキャスト
    spill_at = np.zeros(labels.shape)
    spill_at[inside] = spill[labels[inside] - 1]
    near_spill = np.round(np.abs(fl - spill_at), 6)
    # ソートキー: near_spill が主、外側の低さが従。rim 以外は +inf で外す
    BIG = 1e6
    key = np.where(rim, near_spill * BIG + np.minimum(min_out, BIG - 1.0), np.inf)

    want = ids if only is None else np.array(sorted(only), dtype=ids.dtype)
    want = want[(want >= 1) & (want <= n)]
    if want.size == 0:
        return {}

    out: dict[int, tuple[int, int]] = {}
    # index を配列で渡すと minimum / minimum_position は必ず配列・リストを返す
    has_rim = np.atleast_1d(ndimage.minimum(key, labels, index=want))
    pos = list(ndimage.minimum_position(key, labels, index=want))
    fb: dict[int, tuple[int, int]] = {}
    need_fallback = [int(p) for p, hr in zip(want.tolist(), has_rim) if not np.isfinite(hr)]
    if need_fallback:
        # rim が 1 つも無い窪地は最深セルで代用
        fd_key = np.where(inside, -fd, np.inf)
        fpos = list(ndimage.minimum_position(fd_key, labels, index=need_fallback))
        fb = {p: (int(q[0]), int(q[1])) for p, q in zip(need_fallback, fpos)}
    for p, q in zip(want.tolist(), pos):
        p = int(p)
        out[p] = fb.get(p, (int(q[0]), int(q[1])))
    return out


def pit_records(
    labels: np.ndarray,
    fill_depth: np.ndarray,
    filled: np.ndarray,
    dem: np.ndarray,
    cell_area_m2: float,
    pour_for: "set[int] | None" = None,
) -> list[Pit]:
    """窪地 ID ごとの面積・最大充填深・容積・越流点標高・越流点セル。

    越流点標高 = 窪地内の充填面の最大値（その一帯を止めている鞍部の高さ）。
    定義上 `spill_elev >= 窪地内の最大地表標高`。越流点セルは `pit_pour_points`。

    `pour_for` を渡すと越流点セルはその窪地 ID だけ計算する（残りは `pour_row = -1`）。
    越流点が要るのは viewer が出す上位の窪地だけなので、5〜7 万個を全部回さない
    （`scripts/33`）。
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
    pour = pit_pour_points(labels, fd, fl, only=pour_for)

    out: list[Pit] = []
    for i in range(n):
        py, px = pour.get(i + 1, (-1, -1))
        out.append(Pit(
            pit_id=i + 1,
            area_m2=round(float(counts[i] * cell_area_m2), 2),
            max_fill_depth_m=round(float(dmax[i]), 3),
            volume_m3=round(float(vol[i] * cell_area_m2), 2),
            spill_elev_m_tp=round(float(spill[i]), 3),
            max_ground_elev_m_tp=round(float(gmax[i]), 3),
            pour_row=int(py),
            pour_col=int(px),
        ))
    return out
