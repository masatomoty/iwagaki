"""道路ネットワーク上の最短路と徒歩等時線。

**PLATEAU 舞鶴市の `tran` は `tran:Road/lod1MultiSurface`（車道の面）だけ**で、
LOD0 の道路中心線ネットワークを持たない（`docs/data.md` §1 / §7、`citygml.parse_roads`
も面しか返さない）。そこで道路面ポリゴンから隣接グラフを組む:

* ノード = 各道路ポリゴンの代表点（`shapely` の ``representative_point``）
* エッジ = 境界が接する 2 ポリゴンの代表点どうし（重み = 直線距離 [m]）

合成データ、およびのちに LOD0 中心線が手に入った場合に備えて、折れ線列からも
同じグラフを組める（:func:`graph_from_polylines`）。最短路は ``heapq`` だけの
Dijkstra で、``networkx`` も ``scipy.sparse.csgraph`` も使わない
（依存を増やさない方針、`docs/design.md`「再発明しないために使っているもの」）。

歩行速度は一定（:data:`WALK_SPEED_M_PER_MIN` = 80 m/分。国土交通省
『都市構造評価ハンドブック』が徒歩圏（800 m）の前提に置く速度）。

**限界（成果物に必ず明記する）:**

* PLATEAU の道路網は**車道中心線**であって公式の歩行者網ではない。一方通行・
  歩道橋・地下道・私道・歩車分離を区別しない。ネットワークの妥当性は [仮説]
  （OSM 照合 Spearman 0.95 は `docs/todo.md` の別項で、本モジュールでは未実施）。
* **PLATEAU 舞鶴市の道路面は交差点で切れている**（隣り合う `tran:Road` の
  `lod1MultiSurface` が交差部を塗っていない）。:data:`DEFAULT_TOUCH_TOL_M` で
  橋渡ししてつなぐ。それでも経路長は真の中心線より長め＝等時線は実際の
  徒歩圏より小さめ（**安全側**）に出る（`docs/results.md`「徒歩10分圏」）。
* グラフが連結でない区画（橋で分断・行き止まり）では等時線もそこで切れる。
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

import numpy as np
from shapely import concave_hull
from shapely.geometry import LineString, MultiPoint, MultiPolygon, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

#: 歩行速度 [m/分]。国土交通省『都市構造評価ハンドブック』の徒歩圏（800 m ≒ 10 分）。
WALK_SPEED_M_PER_MIN = 80.0

#: 到達エッジをふくらませて面にする既定の片幅 [m]（車道 1 車線＋歩道相当）。
DEFAULT_EDGE_BUFFER_M = 15.0

#: 到達ノードの凹包（concave hull）の ``ratio``。小さいほど凹む（`shapely.concave_hull`）。
DEFAULT_HULL_RATIO = 0.4

#: 凹包を道路のある範囲に留めるための帯幅 [m]。街区は埋め、これより広い
#: 道路の無い空隙（河川・港・大規模施設）は埋めない。
DEFAULT_FILL_GAP_M = 45.0

#: 折れ線グラフで端点を同一ノードに寄せる既定の許容 [m]。
DEFAULT_SNAP_TOL_M = 1.0

#: 道路面ポリゴンが「接している」とみなす既定の許容 [m]。
#: **PLATEAU 舞鶴市の道路面は交差点で切れていて隙間がある**（隣り合う `tran:Road` の
#: `lod1MultiSurface` が交差部を塗っていない）。0.5 m だとグラフが 90 以上の
#: 連結成分に割れる。車線幅・交差点ぶんを見込んで 6 m まで橋渡しする [実測]。
DEFAULT_TOUCH_TOL_M = 6.0


def _dedupe_edges(
    raw: list[tuple[int, int, float]]
) -> list[tuple[int, int, float]]:
    """``(i, j, w)`` を ``i < j`` に正規化し、自己ループを捨て、同じ対は最小重みで畳む。"""
    best: dict[tuple[int, int], float] = {}
    for a, b, w in raw:
        if a == b:
            continue
        key = (a, b) if a < b else (b, a)
        if key not in best or w < best[key]:
            best[key] = w
    return [(i, j, w) for (i, j), w in sorted(best.items())]


@dataclass
class Graph:
    """無向・重み付きグラフ。座標は投影メートル（EPSG:6674 想定）。"""

    nodes: np.ndarray  # (N, 2) float64
    edges: list[tuple[int, int, float]]  # (i, j, 重み[m])、i < j、重複なし
    adj: list[list[tuple[int, float]]] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.nodes = np.asarray(self.nodes, dtype="float64").reshape(-1, 2)
        self.edges = _dedupe_edges([(int(i), int(j), float(w)) for i, j, w in self.edges])
        self.adj = [[] for _ in range(len(self.nodes))]
        for i, j, w in self.edges:
            self.adj[i].append((j, w))
            self.adj[j].append((i, w))

    @property
    def n_nodes(self) -> int:
        return len(self.nodes)

    @property
    def n_edges(self) -> int:
        return len(self.edges)

    @classmethod
    def from_edges(
        cls, nodes: np.ndarray, edges: list[tuple[int, int, float]]
    ) -> "Graph":
        return cls(np.asarray(nodes, dtype="float64"), list(edges))


def graph_from_polylines(
    lines: list[np.ndarray], snap_tol_m: float = DEFAULT_SNAP_TOL_M
) -> Graph:
    """折れ線列（各 ``(M, 2)`` 配列）からグラフを組む。

    頂点を ``snap_tol_m`` の格子に丸めて同一視し、連続頂点をエッジにする。
    端点が ``snap_tol_m`` 以内なら同じノードに寄る（交差点のスナップ）。
    合成テストと、のちの LOD0 中心線データ用。
    """
    if snap_tol_m <= 0:
        raise ValueError("snap_tol_m must be > 0")
    node_of: dict[tuple[int, int], int] = {}
    coords: list[tuple[float, float]] = []
    raw_edges: list[tuple[int, int, float]] = []

    def node_id(x: float, y: float) -> int:
        key = (int(round(x / snap_tol_m)), int(round(y / snap_tol_m)))
        idx = node_of.get(key)
        if idx is None:
            idx = len(coords)
            node_of[key] = idx
            coords.append((key[0] * snap_tol_m, key[1] * snap_tol_m))
        return idx

    for line in lines:
        pts = np.asarray(line, dtype="float64").reshape(-1, 2)
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
            a = node_id(x0, y0)
            b = node_id(x1, y1)
            if a == b:
                continue
            w = math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1])
            raw_edges.append((a, b, w))

    return Graph(np.array(coords, dtype="float64").reshape(-1, 2), raw_edges)


def graph_from_road_polygons(
    polys: list[Polygon], touch_tol_m: float = DEFAULT_TOUCH_TOL_M
) -> Graph:
    """道路面ポリゴン列から隣接グラフを組む（PLATEAU `tran` 用）。

    ノードは各ポリゴンの代表点、エッジは境界が ``touch_tol_m`` 以内に接する対。
    重みは代表点どうしの直線距離。連結でない区画がありうる（呼び手が扱う）。
    """
    reps = [p.representative_point() for p in polys]
    coords = np.array([[pt.x, pt.y] for pt in reps], dtype="float64").reshape(-1, 2)
    if not polys:
        return Graph(coords, [])

    tree = STRtree(polys)
    raw_edges: list[tuple[int, int, float]] = []
    for i, gi in enumerate(polys):
        for j in tree.query(gi, predicate="dwithin", distance=touch_tol_m):
            j = int(j)
            if j <= i:
                continue
            if gi.distance(polys[j]) > touch_tol_m:
                continue
            w = math.hypot(coords[i, 0] - coords[j, 0], coords[i, 1] - coords[j, 1])
            raw_edges.append((i, j, w))
    return Graph(coords, raw_edges)


def connected_components(graph: Graph) -> list[list[int]]:
    """連結成分をノード index の列で返す（大きい順）。"""
    seen = np.zeros(graph.n_nodes, dtype=bool)
    out: list[list[int]] = []
    for start in range(graph.n_nodes):
        if seen[start]:
            continue
        stack = [start]
        seen[start] = True
        comp = []
        while stack:
            u = stack.pop()
            comp.append(u)
            for v, _ in graph.adj[u]:
                if not seen[v]:
                    seen[v] = True
                    stack.append(v)
        out.append(comp)
    out.sort(key=len, reverse=True)
    return out


def nearest_node(graph: Graph, xy: tuple[float, float]) -> tuple[int, float]:
    """``xy`` にいちばん近いノードの index と距離 [m]。グラフが空なら ``(-1, inf)``。"""
    if graph.n_nodes == 0:
        return -1, math.inf
    d = np.hypot(graph.nodes[:, 0] - xy[0], graph.nodes[:, 1] - xy[1])
    k = int(np.argmin(d))
    return k, float(d[k])


def dijkstra(
    graph: Graph,
    sources: list[tuple[int, float]],
    max_cost: float = math.inf,
) -> np.ndarray:
    """多始点 Dijkstra。到達コスト [m] の配列を返す（未到達は ``inf``）。

    ``sources`` は ``(ノード index, 初期コスト)`` の列（道路までの歩行ぶんを
    初期コストに載せられる）。``max_cost`` を超えたノードは展開しない。
    """
    dist = np.full(graph.n_nodes, math.inf)
    heap: list[tuple[float, int]] = []
    for idx, base in sources:
        if 0 <= idx < graph.n_nodes and base < dist[idx]:
            dist[idx] = base
            heapq.heappush(heap, (base, idx))
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u] or d > max_cost:
            continue
        for v, w in graph.adj[u]:
            nd = d + w
            if nd < dist[v] and nd <= max_cost:
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
    return dist


def reached_nodes(dist: np.ndarray, max_cost: float) -> np.ndarray:
    """``dist <= max_cost`` のノード index。"""
    return np.nonzero(dist <= max_cost)[0]


def _reached_segments(
    graph: Graph, dist: np.ndarray, max_cost: float
) -> tuple[list[LineString], list[tuple[float, float]]]:
    """到達区間の線分と、その端点（凹包の入力点）を返す。

    エッジ ``(i, j, w)`` について i 側から届く割合は
    ``clip((max_cost - dist[i]) / w, 0, 1)``。両側の到達区間の和を取る。
    """
    nodes = graph.nodes
    segs: list[LineString] = []
    pts: list[tuple[float, float]] = []
    for i, j, w in graph.edges:
        di, dj = dist[i], dist[j]
        if not (math.isfinite(di) or math.isfinite(dj)) or w == 0.0:
            continue
        pi, pj = nodes[i], nodes[j]
        fi = min(1.0, max(0.0, (max_cost - di) / w)) if math.isfinite(di) else 0.0
        fj = min(1.0, max(0.0, (max_cost - dj) / w)) if math.isfinite(dj) else 0.0
        new: list[LineString] = []
        if fi + fj >= 1.0:
            new.append(LineString([pi, pj]))
        else:
            if fi > 0.0:
                new.append(LineString([pi, pi + fi * (pj - pi)]))
            if fj > 0.0:
                new.append(LineString([pj, pj + fj * (pi - pj)]))
        for s in new:
            segs.append(s)
            pts.extend(s.coords)
    for k in reached_nodes(dist, max_cost):
        pts.append(tuple(nodes[k]))
    return segs, pts


def isochrone_polygon(
    graph: Graph,
    dist: np.ndarray,
    max_cost: float,
    edge_buffer_m: float = DEFAULT_EDGE_BUFFER_M,
    hull_ratio: float = DEFAULT_HULL_RATIO,
    fill_gap_m: float = DEFAULT_FILL_GAP_M,
) -> Polygon | MultiPolygon:
    """到達範囲の面を返す（到達ノードの凹包を道路のある範囲に留めたもの）。

    * 到達区間の線を ``edge_buffer_m`` でふくらませた**細い経路帯**（行き止まりの
      枝もここで残る）
    * 到達ノード・区間端点の**凹包**（`shapely.concave_hull`、``hull_ratio``）を
      経路帯の ``fill_gap_m`` バッファで切ったもの（街区は埋め、河川・港のような
      道路の無い広い空隙は埋めない ＝ そこで凹む）

    の和。どこにも届かなければ空ポリゴンを返す。
    """
    segs, pts = _reached_segments(graph, dist, max_cost)
    if not segs and not pts:
        return Polygon()
    corridor = unary_union(segs) if segs else MultiPoint(pts)
    thin = corridor.buffer(edge_buffer_m)
    if len(pts) < 3:
        return thin if not thin.is_empty else Polygon()
    hull = concave_hull(MultiPoint(pts), ratio=hull_ratio)
    filled = hull.intersection(corridor.buffer(fill_gap_m))
    geom = unary_union([thin, filled])
    return geom if not geom.is_empty else Polygon()


@dataclass
class WalkIsochrone:
    """:func:`walk_isochrone` の結果。座標はグラフと同じ投影 CRS。"""

    origin_xy: tuple[float, float]
    snap_node: int
    snap_distance_m: float
    max_cost_m: float
    reached_node_count: int
    network_polygon: Polygon | MultiPolygon
    simple_buffer: Polygon


def walk_isochrone(
    graph: Graph,
    origin_xy: tuple[float, float],
    max_cost_m: float,
    edge_buffer_m: float = DEFAULT_EDGE_BUFFER_M,
) -> WalkIsochrone:
    """``origin_xy`` から ``max_cost_m`` [m] のネットワーク等時線と同距離の単純バッファ。

    起点はいちばん近いノードにスナップし、そこまでの直線距離を初期コストに載せる。
    単純バッファは ``origin_xy`` を中心にした半径 ``max_cost_m`` の円。
    """
    node, snap_d = nearest_node(graph, origin_xy)
    if node < 0:
        return WalkIsochrone(origin_xy, -1, math.inf, max_cost_m, 0,
                             Polygon(), Point(origin_xy).buffer(max_cost_m))
    dist = dijkstra(graph, [(node, snap_d)], max_cost_m)
    poly = isochrone_polygon(graph, dist, max_cost_m, edge_buffer_m)
    return WalkIsochrone(
        origin_xy=origin_xy,
        snap_node=node,
        snap_distance_m=snap_d,
        max_cost_m=max_cost_m,
        reached_node_count=int(reached_nodes(dist, max_cost_m).size),
        network_polygon=poly,
        simple_buffer=Point(origin_xy).buffer(max_cost_m),
    )
