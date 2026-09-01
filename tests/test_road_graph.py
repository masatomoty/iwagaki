"""道路グラフと徒歩等時線（`src/iwagaki/road_graph.py` / `scripts/94`）。

合成の格子道路で、
* 等時線に入るノード集合が既知（原点から i+j<=8 マス）
* ネットワーク等時線が同距離の単純バッファより小さい（回り道ぶん）
* ネットワーク等時線が単純バッファに収まる
を固定する。実データとの突き合わせ（東舞鶴駅前の圏域）は PR 本文の実行結果で確認する。
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from conftest import load_script
from iwagaki import road_graph as rg

script = load_script("94_walk_isochrone")

STEP, N = 100.0, 10
MAX_COST = rg.WALK_SPEED_M_PER_MIN * 10.0  # 800 m


def grid_graph() -> rg.Graph:
    """0..9 の格子（間隔 100 m）。縦線・横線の折れ線から組む。"""
    coord = np.arange(N) * STEP
    lines = []
    for i in range(N):
        lines.append(np.column_stack([np.full(N, i * STEP), coord]))
        lines.append(np.column_stack([coord, np.full(N, i * STEP)]))
    return rg.graph_from_polylines(lines)


def node_ij(graph: rg.Graph, idx: int) -> tuple[int, int]:
    return tuple(np.round(graph.nodes[idx] / STEP).astype(int))


# --- グラフ構築 -------------------------------------------------------

def test_polyline_graph_snaps_shared_vertices():
    graph = grid_graph()
    assert graph.n_nodes == N * N  # 交差点が重複ノードになっていない
    by_ij = {node_ij(graph, k): k for k in range(graph.n_nodes)}
    assert len(graph.adj[by_ij[(5, 5)]]) == 4  # 内部ノードの次数 4
    assert len(graph.adj[by_ij[(0, 0)]]) == 2  # 隅は 2
    assert len(graph.adj[by_ij[(0, 5)]]) == 3  # 辺は 3


def test_snap_tolerance_merges_close_endpoints():
    a = np.array([[0.0, 0.0], [10.0, 0.0]])
    b = np.array([[10.3, 0.0], [10.3, 10.0]])  # 0.3 m ずれ
    graph = rg.graph_from_polylines([a, b], snap_tol_m=1.0)
    assert graph.n_nodes == 3  # (0,0) (10,0)=(10.3,0) (10,10)


# --- 最短路と等時線ノード集合 ---------------------------------------

def test_isochrone_node_set_is_known():
    graph = grid_graph()
    src, snap = rg.nearest_node(graph, (0.0, 0.0))
    assert (src, snap) == (next(k for k in range(graph.n_nodes)
                                if node_ij(graph, k) == (0, 0)), 0.0)
    dist = rg.dijkstra(graph, [(src, 0.0)], MAX_COST)
    reached = {node_ij(graph, k) for k in rg.reached_nodes(dist, MAX_COST)}
    expected = {(i, j) for i in range(N) for j in range(N)
                if (i + j) * STEP <= MAX_COST}
    assert reached == expected
    # 格子上は最短路 = マンハッタン距離
    far = next(k for k in range(graph.n_nodes) if node_ij(graph, k) == (3, 5))
    assert dist[far] == pytest.approx(8 * STEP)


def test_max_cost_prunes_far_nodes():
    graph = grid_graph()
    src, _ = rg.nearest_node(graph, (0.0, 0.0))
    dist = rg.dijkstra(graph, [(src, 0.0)], MAX_COST)
    assert not math.isfinite(dist[next(k for k in range(graph.n_nodes)
                                       if node_ij(graph, k) == (5, 5))])  # 1000 m


# --- ネットワーク等時線 vs 単純バッファ -----------------------------

def test_network_isochrone_smaller_than_and_within_simple_buffer():
    graph = grid_graph()
    res = rg.walk_isochrone(graph, (0.0, 0.0), MAX_COST)
    assert res.network_polygon.area < res.simple_buffer.area
    # 回り道ぶん、はっきり小さい
    assert res.network_polygon.area < 0.5 * res.simple_buffer.area
    outside = res.network_polygon.difference(
        res.simple_buffer.buffer(rg.DEFAULT_EDGE_BUFFER_M + 1e-6))
    assert outside.area < 1.0


def test_buffer_only_land_is_excluded_from_network():
    graph = grid_graph()
    res = rg.walk_isochrone(graph, (0.0, 0.0), MAX_COST)
    # (5,5) は単純バッファ内（707 m < 800）だがネットワークでは 1000 m で未到達
    p55 = rg.Point(5 * STEP, 5 * STEP)
    assert res.simple_buffer.contains(p55)
    assert not res.network_polygon.contains(p55)
    # (0,8) はネットワークで丁度 800 m 到達
    assert res.network_polygon.buffer(1e-6).contains(rg.Point(0.0, 8 * STEP))


def test_snap_distance_added_as_initial_cost():
    graph = grid_graph()
    # 原点から 50 m 離れた起点。最寄り (0,0) にスナップして 50 m を初期コストに載せる
    res = rg.walk_isochrone(graph, (-30.0, -40.0), MAX_COST)
    assert res.snap_distance_m == pytest.approx(50.0)
    dist = rg.dijkstra(graph, [(res.snap_node, res.snap_distance_m)], MAX_COST)
    # i+j<=7 マス（750+50=800）までに縮む
    reached = {node_ij(graph, k) for k in rg.reached_nodes(dist, MAX_COST)}
    assert (7, 0) in reached and (8, 0) not in reached


# --- 空・退化 --------------------------------------------------------

def test_empty_graph_returns_empty_network_and_full_buffer():
    graph = rg.Graph(np.empty((0, 2)), [])
    res = rg.walk_isochrone(graph, (0.0, 0.0), MAX_COST)
    assert res.network_polygon.is_empty
    # shapely のバッファは 8 分割の多角形近似なので真円よりわずかに小さい
    assert res.simple_buffer.area == pytest.approx(math.pi * MAX_COST**2, rel=2e-2)


def test_road_polygon_graph_connects_touching_segments():
    # 2 本の道路面が端で接する -> 2 ノード 1 エッジ
    r1 = rg.Polygon([(0, 0), (100, 0), (100, 10), (0, 10)])
    r2 = rg.Polygon([(100, 0), (200, 0), (200, 10), (100, 10)])
    r3 = rg.Polygon([(500, 500), (600, 500), (600, 510), (500, 510)])  # 孤立
    graph = rg.graph_from_road_polygons([r1, r2, r3])
    assert graph.n_nodes == 3
    assert graph.n_edges == 1
    assert graph.edges[0][:2] == (0, 1)


# --- スクリプトの自己確認 ------------------------------------------

def test_script_selfcheck_passes():
    assert script._selfcheck() == 0
