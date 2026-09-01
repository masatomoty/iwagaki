"""建物の重心を国勢調査の小地域（町丁・字等）に空間結合する。

`scripts/92_area_aggregate.py`（潮位別の集計ファイル）と
`scripts/83_build_catalog.py`（`objects.geojson` への `area_code` 付与と
`small_areas.geojson` の配信）で **同じ結合ロジック**を使うために切り出した。
どちらも `scripts/13_fetch_census_boundaries.py` が出した
`data/interim/census_boundary_maizuru_2020.geojson`（EPSG:6674）を境界に使い、
建物 1 棟を 1 つの小地域へ寄せる。ここが割れると
「viewer の地域表」と「`scripts/92` の CSV」が食い違う。
"""
from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd

from iwagaki.config import CRS_ANALYSIS, INTERIM

#: `scripts/13` の中間物
BOUNDARY_PATH = INTERIM / "census_boundary_maizuru_2020.geojson"

#: 境界から残す属性（人口・世帯数は持ち込まない。`docs/data.md` §5）
BOUNDARY_FIELDS = ["KEY_CODE", "S_NAME", "CITY_NAME"]

#: 重心がどの小地域にも入らなかった建物のキー／表示名
OUTSIDE_KEY = ""
OUTSIDE_NAME = "(小地域外)"


def load_boundaries(crs: str = CRS_ANALYSIS) -> gpd.GeoDataFrame:
    """小地域ポリゴンを `crs` で返す（既定は解析 CRS）。"""
    if not BOUNDARY_PATH.exists():
        raise SystemExit(
            f"{BOUNDARY_PATH} がありません。先に scripts/13_fetch_census_boundaries.py"
        )
    gdf = gpd.read_file(BOUNDARY_PATH)
    if gdf.crs is None:
        gdf = gdf.set_crs(CRS_ANALYSIS)
    return gdf.to_crs(crs)[[*BOUNDARY_FIELDS, "geometry"]]


def boundary_metadata() -> dict:
    """境界データの版・出典（`scripts/13` が書いた `metadata` の抜粋）。"""
    meta = json.loads(BOUNDARY_PATH.read_text()).get("metadata", {})
    return {k: meta.get(k) for k in ("survey_id", "boundary_year", "datum",
                                     "source", "source_url") if k in meta}


def assign_centroids(
    centroids: gpd.GeoDataFrame, areas: gpd.GeoDataFrame
) -> pd.DataFrame:
    """建物の代表点を小地域へ空間結合する。

    Parameters
    ----------
    centroids
        ``gml_id`` 列と**点** geometry を持つ GeoDataFrame。CRS は ``areas`` と同じ。
    areas
        :func:`load_boundaries` が返すポリゴン。

    Returns
    -------
    ``gml_id`` を index に持つ DataFrame（``key_code`` / ``s_name`` / ``city_name``）。
    境界ちょうどで複数の小地域に当たる建物は **KEY_CODE 昇順**で 1 つに決める。
    どの小地域にも入らない建物は ``key_code == OUTSIDE_KEY``。
    """
    joined = (
        gpd.sjoin(centroids[["gml_id", "geometry"]], areas,
                  predicate="within", how="left")
        .sort_values("KEY_CODE")
        .drop_duplicates("gml_id", keep="first")
        .set_index("gml_id")
    )
    idx = centroids.set_index("gml_id").index
    return pd.DataFrame(
        {
            "key_code": joined["KEY_CODE"].reindex(idx).fillna(OUTSIDE_KEY),
            "s_name": joined["S_NAME"].reindex(idx).fillna(OUTSIDE_NAME),
            "city_name": joined["CITY_NAME"].reindex(idx).fillna(""),
        },
        index=idx,
    )
