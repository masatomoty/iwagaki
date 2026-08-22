"""AOI・データソース・解析パラメータの一元定義。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"
OUT = ROOT / "data" / "out"

# --- 座標系 -------------------------------------------------------------
CRS_ANALYSIS = "EPSG:6674"   # JGD2011 / 平面直角座標系 第VI系（京都府DEMのネイティブ）
CRS_PLATEAU = "EPSG:6697"    # JGD2011 経緯度 + 標高（PLATEAU CityGML）
CRS_LONLAT = "EPSG:6668"     # JGD2011 経緯度


@dataclass(frozen=True)
class Aoi:
    """解析対象矩形（EPSG:6674, メートル）。"""
    name: str
    xmin: float
    ymin: float
    xmax: float
    ymax: float

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (self.xmin, self.ymin, self.xmax, self.ymax)

    def buffered(self, m: float) -> "Aoi":
        return Aoi(self.name, self.xmin - m, self.ymin - m, self.xmax + m, self.ymax + m)


# 吉原（東吉原・西吉原・吉原入江）。東吉原の基準点 E=-60838.6, N=-60164.7 を含む。
AOI = Aoi("yoshiwara", xmin=-61500.0, ymin=-60500.0, xmax=-60500.0, ymax=-59500.0)

# 参照点（検証用, lon/lat EPSG:6668）
REF_POINTS = {
    # AOI 内。OSM: 日ノ出湯 / 京都府舞鶴市字東吉原297-2
    "higashi_yoshiwara": (135.3297551, 35.4558360),
    # AOI 外（南）。位置関係の確認用
    "nishimaizuru_sta": (135.3325, 35.4497),
}

# --- 解像度 -------------------------------------------------------------
RES_HIGHRES = 0.5
RES_COARSE = 5.0

# --- 潮位（docs/DATA.md §4）--------------------------------------------
# 気象庁 舞鶴(MZ) 実測値
TP_OF_TIDE_TABLE_DATUM = -0.066   # 潮位表基準面の標高 [m T.P.]
TP_OF_OBSERVATION_DATUM = -1.517  # 観測基準面の標高 [m T.P.]
TP_OF_MSL = 0.124                 # 平均水面の標高 [m T.P.]


def tide_table_to_tp(cm: float) -> float:
    """潮位表（推算潮位）の値[cm] → 標高[m T.P.]"""
    return cm / 100.0 + TP_OF_TIDE_TABLE_DATUM


def observation_to_tp(cm: float) -> float:
    """毎時潮位（観測値）の値[cm] → 標高[m T.P.]"""
    return cm / 100.0 + TP_OF_OBSERVATION_DATUM


# --- 浸水計算パラメータ -------------------------------------------------
H_MIN = 0.0
H_MAX = 3.0
H_STEP = 0.05
CONNECTIVITY = 4          # 4 or 8。baseline/highres で必ず同一にする
SEED_LEVEL = 0.20         # [m T.P.] これ以下を開放水面の候補とする
SEED_MIN_AREA = 5000.0    # [m^2] seed 成分の最小面積
REPRESENTATIVE_H = (1.0, 1.5, 2.0)   # 代表水位 [m T.P.]

# 道路の通行支障クラス閾値 [m]（暫定・要出典固定）
ROAD_DEPTH_CLASSES = (0.1, 0.3, 0.5)

NODATA = -9999.0

# --- データソース -------------------------------------------------------
PLATEAU_CITYGML_URL = (
    "https://assets.cms.plateau.reearth.io/assets/8f/8ad134-6969-4a6c-a7c2-4ac370a73096/"
    "26202_maizuru-shi_city_2025_citygml_1_op.zip"
)
# AOI を含む CityGML メンバー（docs/DATA.md §1）。
# dem は 2次メッシュを 3次メッシュ 5x5 の 4 象限に割ったファイル構成のため複数枚必要になる。
# AOI が象限境界（lat 35.45833）をまたぐので "05"(3次メッシュ行0-4) と "55"(行5-9) の両方を使う。
PLATEAU_MEMBERS = {
    "dem": [
        "udx/dem/533512_dem_6697_05_op.gml",
        "udx/dem/533512_dem_6697_55_op.gml",
    ],
    "bldg": ["udx/bldg/53351246_bldg_6697_op.gml"],
    "tran": ["udx/tran/53351246_tran_6697_op.gml"],
}

# 京都府 数値標高モデル(DEM) 0.5m。図郭 zip ごとの入手先。
# 06LC は CKAN の署名付きリダイレクト、06MC は S3 直リンク。
KYOTO_DEM_ZIPS = {
    "06LC": "https://www.geospatial.jp/ckan/dataset/a7c25ae6-cc29-4f3a-98e9-d32b946dd06b/"
            "resource/df582950-0148-4963-ac9c-259d3a10c6d8/download/06lc.zip",
    "06MC": "https://gic-kyoto.s3.ap-northeast-1.amazonaws.com/2024/dem/06MC.zip",
}

ATTRIBUTION = [
    "出典：3D都市モデル（Project PLATEAU）舞鶴市（2025年度）／国土交通省",
    "出典：京都府オープンデータ「数値標高モデル（DEM）」（2019-2023年計測）"
    "（本成果は同データを加工して作成したものであり、京都府が作成したものではありません）",
    "出典：気象庁 潮位観測資料（舞鶴）",
]
