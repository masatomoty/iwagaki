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
from pyproj import Transformer
from shapely.geometry import Point

from iwagaki.config import CRS_ANALYSIS, CRS_LONLAT, INTERIM

#: `scripts/13` の中間物
BOUNDARY_PATH = INTERIM / "census_boundary_maizuru_2020.geojson"

#: `scripts/14` の中間物（国勢調査 小地域の人口・年齢）
STATS_PATH = INTERIM / "census_stats_maizuru_2020.csv"

#: `scripts/14` の CSV のうち数値として読む列（`age_75_plus` は 65+ の内数・再掲）
STATS_COUNT_FIELDS = ("pop_total", "age_0_14", "age_15_64", "age_65_plus",
                      "age_unknown", "age_75_plus")

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


def load_area_stats() -> pd.DataFrame:
    """`scripts/14` の小地域統計（人口・年齢）を ``key_code`` を index に返す。

    数値列（:data:`STATS_COUNT_FIELDS`）は nullable Int64。**秘匿（`suppressed`）の
    小地域は値が欠損**で、按分の分母に入れると人口を過小評価するので、呼び出し側で
    `suppressed` を見て「圏内に秘匿 N 地域」と添える（`scripts/93`）。
    """
    if not STATS_PATH.exists():
        raise SystemExit(
            f"{STATS_PATH} がありません。先に scripts/14_fetch_census_stats.py"
        )
    df = pd.read_csv(STATS_PATH, dtype={"key_code": str, "hyosyo": str})
    for col in STATS_COUNT_FIELDS:
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    df["suppressed"] = df["suppressed"].astype(str).str.lower() == "true"
    return df.set_index("key_code")


def stats_metadata() -> dict:
    """`scripts/14` が書いた `.json`（版・出典・列定義・秘匿件数）。"""
    p = STATS_PATH.with_suffix(".json")
    if not p.exists():
        return {}
    meta = json.loads(p.read_text())
    return {k: meta.get(k) for k in
            ("stats_id", "stats_name", "boundary_year", "source", "source_url",
             "derived", "suppression") if k in meta}


def point_to_analysis(lon: float, lat: float) -> tuple[float, float]:
    """経緯度（`CRS_LONLAT` = EPSG:6668）-> 解析平面直角座標（`CRS_ANALYSIS`）。"""
    tf = Transformer.from_crs(CRS_LONLAT, CRS_ANALYSIS, always_xy=True)
    x, y = tf.transform(lon, lat)
    return float(x), float(y)


def circle_geom(lon: float, lat: float, radius_m: float):
    """中心（経緯度）と半径 [m] から、解析 CRS の円ポリゴンを返す。

    `CRS_ANALYSIS` は平面直角座標系（第VI系）なので、この範囲（舞鶴、原点近傍）では
    スケール誤差は 1e-4 未満。半径 1 km で 0.1 m 未満なので m 単位の buffer で十分。
    """
    x, y = point_to_analysis(lon, lat)
    # quad_segs=64 で真円との面積差は 1e-4 未満（既定 8 だと 0.17 %）
    return Point(x, y).buffer(radius_m, quad_segs=64)


def areas_in_circle(
    areas: gpd.GeoDataFrame, lon: float, lat: float, radius_m: float
) -> gpd.GeoDataFrame:
    """円に掛かる小地域を返す（`areas` の CRS は `CRS_ANALYSIS`）。

    面按分（areal weighting）のための重み列を付ける:

    * ``overlap_m2``   … 小地域 ∩ 円 の面積 [m^2]
    * ``area_m2``      … 小地域そのものの面積 [m^2]
    * ``circle_frac``  … ``overlap_m2 / area_m2``（0〜1）。人口が小地域内で一様と
      仮定して按分するときの係数

    重心内包（centroid containment）でやりたい呼び出し側は ``circle_frac`` を
    無視して geometry の重心が円内かを見ればよい。
    """
    if areas.crs is None:
        areas = areas.set_crs(CRS_ANALYSIS)
    circle = circle_geom(lon, lat, radius_m)
    hit = areas[areas.intersects(circle)].copy()
    hit["area_m2"] = hit.geometry.area
    hit["overlap_m2"] = hit.geometry.intersection(circle).area
    hit["circle_frac"] = (hit["overlap_m2"] / hit["area_m2"]).clip(0.0, 1.0)
    return hit.reset_index(drop=True)


def features_in_circle(
    features: gpd.GeoDataFrame, lon: float, lat: float, radius_m: float,
    predicate: str = "intersects",
) -> gpd.GeoDataFrame:
    """円内の地物を返す（`features` の CRS は `CRS_ANALYSIS`）。

    ``predicate`` は shapely の述語名。建物を重心で数えたいときは、呼び出し側で
    ``features.set_geometry(features.geometry.centroid)`` を渡して ``"within"``。
    """
    circle = circle_geom(lon, lat, radius_m)
    return features[getattr(features.geometry, predicate)(circle)].copy()
