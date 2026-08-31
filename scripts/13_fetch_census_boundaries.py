#!/usr/bin/env python3
"""e-Stat 統計GIS の「境界データ」から 2020年国勢調査の小地域（町丁・字等別）を取る。

上田氏の要望（2026-08-28）「浸水建物の抽出を国勢調査の小地域ごとに集計できると
地域ごとの比較ができていい」に対して、集計の受け皿になる **行政界（町丁・字等）の
ポリゴン**を用意する。これは `scripts/12_fetch_railway.py` と同じ「外部データセットの
フェッチャ」で、`scripts/92_area_aggregate.py` の入力になる。

取得元
------
政府統計の総合窓口 e-Stat／統計地理情報システム（統計GIS）の境界データ。
市区町村単位でダウンロードできる URL（`downloadType=5` が Shapefile）:

    https://www.e-stat.go.jp/gis/statmap-search/data
        ?dlserveyId=A002005212020   # 2020年 国勢調査（小地域）町丁・字等別
        &code=26202                 # 舞鶴市
        &coordSys=1                 # 1 = 世界測地系・緯度経度
        &format=shape               # Shapefile
        &downloadType=5
        &datum=2011                 # 測地成果2011（本解析の地形と同じ世代）

**版・測地系・ライセンス（`docs/data.md` §5 にも記録）**

* 版: 2020年（令和2年）国勢調査 小地域（町丁・字等別）。統計表 ID `A002005212020`。
* 測地系: **JGD2011 経緯度**（`.prj` が `GCS_JGD_2011`）。`datum=2011` を指定して取得。
  本リポジトリの緯度経度 CRS（`config.CRS_LONLAT` = EPSG:6668）と同じ世代。
* 図郭ではなく**行政界**。町丁・字等の境で、メッシュではない。
* ライセンス: 政府統計の総合窓口（e-Stat）利用規約。出典表記を条件に加工・再配布可
  （商用含む）。編集・加工した場合はその旨を明記する。
  出典表記例: 「「令和2年国勢調査」（総務省統計局）の境界データ（e-Stat 統計GIS）を
  加工して作成」。

**自動ダウンロードが不安定なとき（fallback）**

e-Stat の境界データ URL は API 仕様として公表されているものではないので、
サイト構成が変わると 404 になりうる。その場合は手動で:

1. https://www.e-stat.go.jp/gis/statmap-search?type=2&aggregateUnitForBoundary=A
   &toukeiCode=00200521&toukeiYear=2020&serveyId=A002005212020&datum=2011 を開く
2. 「市区町村を選択」→ 京都府 舞鶴市 → 「世界測地系緯度経度・Shapefile」をダウンロード
3. 落とした zip を `data/raw/estat/A002005212020_26202.zip` に置く
   （または展開した `r2ka26202.{shp,shx,dbf,prj}` を `data/raw/estat/` に置く）

そのうえでこのスクリプトを再実行するとキャッシュを使う。

出力
----
AOI 3 範囲（`config.AOIS`）のいずれかに交差する小地域だけに切り出して
`data/interim/census_boundary_maizuru_2020.geojson`（EPSG:6674、解析 CRS）に置く。
KEY_CODE で dissolve して 1 小地域 1 ポリゴンにし、どの AOI に掛かるかを
`aoi_hit` 属性に持たせる（`scripts/92` はこれを使わず建物側で空間結合するが、
中間物を単体で見たときに範囲が分かるようにしておく）。**人口・世帯数の属性は
落とす**（この成果物は建物カウントの受け皿であって統計値の取り込みではない）。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import geopandas as gpd
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import AOIS, CRS_ANALYSIS, INTERIM, RAW

ESTAT_URL = (
    "https://www.e-stat.go.jp/gis/statmap-search/data"
    "?dlserveyId=A002005212020&code=26202&coordSys=1&format=shape"
    "&downloadType=5&datum=2011"
)
#: 2020年国勢調査 小地域（町丁・字等別）／舞鶴市（26202）
ESTAT_SURVEY_ID = "A002005212020"
CITY_CODE = "26202"
#: e-Stat の Shapefile の測地系（`.prj` が GCS_JGD_2011）
BOUNDARY_CRS = "EPSG:6668"

CACHE = RAW / "estat" / f"{ESTAT_SURVEY_ID}_{CITY_CODE}.zip"
SHP_STEM = f"r2ka{CITY_CODE}"

OUT_PATH = INTERIM / "census_boundary_maizuru_2020.geojson"

#: 小地域が AOI に「掛かる」と判定するときの AOI 矩形の緩衝 [m]。
#: 境界ちょうどに乗る建物の代表点を取りこぼさないよう少し広げる。
AOI_BUFFER_M = 100.0

#: 中間物に残す属性（人口・世帯数は入れない）
KEEP_FIELDS = ["KEY_CODE", "PREF_NAME", "CITY_NAME", "S_NAME", "HCODE"]


def load_shapefile_bytes() -> dict[str, bytes]:
    """`r2ka26202.{shp,shx,dbf,prj}` を bytes で返す。キャッシュが無ければ取得する。"""
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        loose = {ext: RAW / "estat" / f"{SHP_STEM}{ext}"
                 for ext in (".shp", ".shx", ".dbf", ".prj")}
        if all(p.exists() for p in loose.values()):
            print(f"using loose shapefile in {loose['.shp'].parent}")
            return {f"{SHP_STEM}{ext}": p.read_bytes() for ext, p in loose.items()}
        print(f"downloading {ESTAT_URL}")
        req = urllib.request.Request(ESTAT_URL, headers={"User-Agent": "iwagaki/1.0"})
        with urllib.request.urlopen(req, timeout=300) as r:
            payload = r.read()
        if payload[:2] != b"PK":
            raise SystemExit(
                "e-Stat から zip が返ってこなかった（サイト構成の変更の可能性）。"
                "docstring の fallback 手順で手動配置する"
            )
        CACHE.write_bytes(payload)
    print(f"{CACHE.name}  {CACHE.stat().st_size / 1e6:.2f} MB")
    with zipfile.ZipFile(CACHE) as z:
        return {n: z.read(n) for n in z.namelist()
                if n.startswith(SHP_STEM) and n.endswith(
                    (".shp", ".shx", ".dbf", ".prj"))}


def read_boundaries() -> gpd.GeoDataFrame:
    members = load_shapefile_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        for name, data in members.items():
            (Path(tmp) / Path(name).name).write_bytes(data)
        gdf = gpd.read_file(Path(tmp) / f"{SHP_STEM}.shp")
    if gdf.crs is None:
        gdf = gdf.set_crs(BOUNDARY_CRS)
    return gdf


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="キャッシュを無視して e-Stat から取り直す")
    args = ap.parse_args()
    if args.force:
        CACHE.unlink(missing_ok=True)

    gdf = read_boundaries()
    print(f"e-Stat 境界データ: {len(gdf)} レコード / CRS {gdf.crs}")

    missing = [c for c in KEEP_FIELDS if c not in gdf.columns]
    if missing:
        raise SystemExit(f"想定した属性が無い: {missing}（実際: {list(gdf.columns)}）")

    # 分割ポリゴン（同一 KEY_CODE の飛び地・水面調査区）を 1 小地域にまとめる。
    gdf = gdf.to_crs(CRS_ANALYSIS)
    dissolved = gdf.dissolve(by="KEY_CODE", as_index=False, aggfunc="first")[
        [*KEEP_FIELDS, "geometry"]
    ]

    # AOI 3 範囲のいずれかに交差する小地域だけ残す。
    aoi_boxes = {name: box(*a.bounds).buffer(AOI_BUFFER_M)
                 for name, a in AOIS.items()}
    dissolved["aoi_hit"] = dissolved.geometry.apply(
        lambda g: ",".join(n for n, b in aoi_boxes.items() if g.intersects(b))
    )
    kept = dissolved[dissolved["aoi_hit"] != ""].reset_index(drop=True)
    kept.attrs = {}

    INTERIM.mkdir(parents=True, exist_ok=True)
    # objects.geojson と同じく EPSG:6674 のまま crs メンバー付きで書く。
    kept.to_file(OUT_PATH, driver="GeoJSON")
    # to_file は crs を urn 形式で書くので、objects.geojson と同じ短縮形に直す。
    fc = json.loads(OUT_PATH.read_text())
    fc["crs"] = {"type": "name", "properties": {"name": CRS_ANALYSIS}}
    fc["metadata"] = {
        "source": "「令和2年国勢調査」（総務省統計局）の境界データ（e-Stat 統計GIS）を加工",
        "source_url": ESTAT_URL,
        "survey_id": ESTAT_SURVEY_ID,
        "boundary_year": 2020,
        "boundary_crs_original": BOUNDARY_CRS,
        "datum": "測地成果2011",
        "unit": "町丁・字等（小地域）。行政界であり図郭ではない",
        "license":
            "政府統計の総合窓口（e-Stat）利用規約。出典表記を条件に加工・再配布可",
        "note":
            "人口・世帯数など統計値は含めていない（建物カウントの受け皿）。"
            "同一 KEY_CODE の分割ポリゴンは dissolve 済み",
    }
    OUT_PATH.write_text(json.dumps(fc, ensure_ascii=False))

    by_aoi: dict[str, int] = {}
    for hit in kept["aoi_hit"]:
        for name in hit.split(","):
            by_aoi[name] = by_aoi.get(name, 0) + 1
    print(f"wrote {OUT_PATH}: {len(kept)} 小地域")
    for name in AOIS:
        print(f"    {name}: {by_aoi.get(name, 0)} 小地域")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
