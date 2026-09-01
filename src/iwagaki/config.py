"""AOI・データソース・解析パラメータの一元定義。

**対象範囲は 3 つある**（`AOIS`）。どれを処理するかは環境変数 `IWAGAKI_AOI` で選ぶ。

    IWAGAKI_AOI=higashi_maizuru scripts/run_all.sh

既定は `yoshiwara`（100 ha・4 条件・地上点群あり）で、`README.md` と
`docs/results.md` の数字はすべてこの範囲のものである。あとの 2 つは
市の要望（2026-08、`高潮表示範囲.pdf` の 2 つの〇）で足した**面的表示用**の
範囲で、**点群が無いので焼くのは `highres` と `baseline` とその差分だけ**。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
#: 中間物は範囲で共有する（`data/raw` と同じ）。**範囲に依存するものは
#: ファイル名に範囲名を入れる**（`interim_name()`）。点群の成果（COPC・被覆）は
#: 吉原にしか無く、ここを範囲ごとに割るとその参照が全部切れる
INTERIM = ROOT / "data" / "interim"

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
AOI_YOSHIWARA = Aoi("yoshiwara", xmin=-61500.0, ymin=-60500.0, xmax=-60500.0, ymax=-59500.0)

# --- 面的表示用の 2 範囲（市の要望、2026-08）------------------------------
#
# `高潮表示範囲.pdf`（舞鶴都市計画総括図に 2 つの〇）で示された範囲。
# 端は 250 m の倍数に揃えてある（0.5 m / 5 m の格子がちょうど割り切れる）。
#
# **東舞鶴だけ 2026-08-25 に東へ 1.5 km 伸ばした**（2.5 km 角 625 ha ->
# 4.0 x 2.5 km 1000 ha）。市から「表示範囲の東側を JR 線路まで」と
# 赤破線入りの地図で依頼があったため（`高潮表示範囲 (1).pdf`）。
#
# 赤破線は総括図を GSI 標準地図に海岸線で合わせて座標に起こした（残差 ±60 m）。
# **東舞鶴駅から愛宕浜町へ向かう JR 小浜線の上に乗る** [実測]。
# 破線の東端は E = -54020 で、伸ばす前の東端 -54500 の 480 m 外だった。
#
# 東端は破線ではなく**低地が尽きる位置**で決めた。GSI 5m DEM で
# 緯度 35.462〜35.495 の帯に占める標高 3 m 以下の割合を測ると [実測]
#
#     E    -54500  -54000  -53500  -53200  -53050  -52925
#     ≤3m    33 %    12 %    13 %     9 %   1.4 %   0.1 %
#
# なので **-53000 で切る**。破線は 1.0 km 内側に入り、低地は全部入る。
# 破線の南西端（舞鶴線側）だけは南端の 172 m 外に残るが、依頼が「東側」なので
# 南は動かしていない。
#
# 矩形は〇より余裕を持たせ、**開放水面（湾）を必ず含む**ようにした。
# `h_conn` の seed は「配列の外周に接する低い連結成分」なので、
# 海を切り落とすと浸水がどこからも始まらない（`iwagaki/flood.py`）。
#
# | 範囲 | 含む主なもの |
# |---|---|
# | `nishi_maizuru` | 吉原・伊佐津川河口・舞鶴西港・大手/浜の市街・西舞鶴駅 |
# | `higashi_maizuru` | 東舞鶴の市街（三条通〜大門通）・東舞鶴駅・舞鶴東港（前島）・溝尻・愛宕・泉源寺 |
#
# **`nishi_maizuru` は吉原 AOI を完全に含む。** 重複は承知の上で、
# 吉原側（4 条件・点群あり・公表済みの数字）をそのまま残すために別範囲にしてある。
AOI_NISHI = Aoi("nishi_maizuru", xmin=-62000.0, ymin=-61250.0, xmax=-59500.0, ymax=-58750.0)
AOI_HIGASHI = Aoi("higashi_maizuru", xmin=-57000.0, ymin=-58750.0, xmax=-53000.0, ymax=-56250.0)

AOIS: dict[str, Aoi] = {a.name: a for a in (AOI_YOSHIWARA, AOI_NISHI, AOI_HIGASHI)}
DEFAULT_AOI = "yoshiwara"

#: 画面に出す範囲の名前と、その範囲を足した理由
AOI_LABELS = {
    "yoshiwara": "吉原",
    "nishi_maizuru": "西舞鶴",
    "higashi_maizuru": "東舞鶴",
}


def aoi_name() -> str:
    name = os.environ.get("IWAGAKI_AOI", DEFAULT_AOI)
    if name not in AOIS:
        raise SystemExit(f"IWAGAKI_AOI={name!r} は未定義。選べるのは {sorted(AOIS)}")
    return name


AOI = AOIS[aoi_name()]

#: 解析結果は範囲ごとに分ける。**吉原の既存成果は `data/out/yoshiwara/` に移した**
OUT = ROOT / "data" / "out" / AOI.name

#: 配信物の置き場。**ディレクトリは分けない。**
#: `web/deploy/_headers` が `/data/tiles/*` と `/data/3dtiles/*` を immutable で配り、
#: `deploy.sh` と `worker.js` がその形を前提にしている。範囲は名前の接頭辞で分ける
#: （`asset_name()`）ので、配信設定を触らずに範囲を増やせる。
WEB_DATA = ROOT / "web" / "public" / "data"


def asset_name(base: str) -> str:
    """配信物の名前。既定範囲だけは接頭辞を付けない（既存の URL を変えないため）。"""
    return base if AOI.name == DEFAULT_AOI else f"{AOI.name}_{base}"


def interim_name(base: str) -> str:
    """範囲に依存する中間物のファイル名。共有の `data/interim` に並べる。"""
    stem, _, ext = base.rpartition(".")
    return base if AOI.name == DEFAULT_AOI else f"{stem}_{AOI.name}.{ext}"


def catalog_name() -> str:
    """`web/public/data/` に置く catalog のファイル名。既定範囲は従来どおり。"""
    return "catalog.json" if AOI.name == DEFAULT_AOI else f"catalog-{AOI.name}.json"

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

# --- 潮位（docs/data.md §4）--------------------------------------------
#
# **気象庁の公表値は測地成果2024 基準、本解析の地形は測地成果2011 基準**なので換算する。
# 気象庁「潮位表掲載地点一覧表（2026年）」が
# 「国土地理院による最新の標高成果（測地成果2024）に基づき、平均潮位（MSL）の標高
#  及び潮位表基準面の標高を更新しました」と明記している（換算値は 2026-06-12 現在）。
# 一方 PLATEAU・地上点群・京都府 0.5m DEM はいずれも測地成果2011 側である
# （docs/data.md「標高成果の世代」）。
#
# 換算しないと**水位を 0.190 m 低く見て浸水を過小評価する**。
# 京都府の資料から引いた値（既往最高潮位 0.93 など、scripts/86 の literal）は
# 改定前の公表なので**換算しない**。

#: 測地成果2011 -> 2024 の標高補正量 [m]。吉原の 3 次メッシュ 53351246。
#: 国土地理院「測量成果2024移行のための水準点標高補正パラメータ」
#: (hyokorevBM_jgd2024_h.par, https://www.gsi.go.jp/common/000268787.zip) の実値。
#: 潮位の基準面は取付水準点（一等水準点 1362）経由なので**水準点用**を使う。
#: 周辺 8 メッシュは -0.1883〜-0.1925 で滑らか（1 次メッシュ 5335 の中央は -0.2014）。
HYOKO_DH_JGD2011_TO_2024 = -0.19031

# 気象庁 舞鶴(MZ) の公表値（**測地成果2024 基準**）
TP_OF_TIDE_TABLE_DATUM_JGD2024 = -0.066   # 潮位表基準面の標高 [m T.P.(2024)]
TP_OF_OBSERVATION_DATUM_JGD2024 = -1.517  # 観測基準面の標高 [m T.P.(2024)]
TP_OF_MSL_JGD2024 = 0.124                 # 平均水面の標高 [m T.P.(2024)]

# 解析で使う値（**測地成果2011 基準**に換算。地形と同じ基準に揃える）
TP_OF_TIDE_TABLE_DATUM = TP_OF_TIDE_TABLE_DATUM_JGD2024 - HYOKO_DH_JGD2011_TO_2024
TP_OF_OBSERVATION_DATUM = TP_OF_OBSERVATION_DATUM_JGD2024 - HYOKO_DH_JGD2011_TO_2024
TP_OF_MSL = TP_OF_MSL_JGD2024 - HYOKO_DH_JGD2011_TO_2024


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
DRAINAGE_DROP_M = 0.30    # 仮想吐口敷高 = 陸側端の地盤高 - この値 [m]

#: **仮想吐口の敷高に置く仮定の幅** [m]。基準値 `- DRAINAGE_DROP_M` に対する
#: オフセットで、**負が「敷高がより低い」＝逆流しやすい**側。
#: `scripts/31` が 1 ケース 1 枚の到達水位ラスタを出す。
#:
#: **この軸は効かないことが実測で分かった**（2026-08、東舞鶴）。敷高は
#: -0.30〜+0.30 m T.P. に収まっていて、±0.20 m ずらしても**潮位 0.50 m 以上では
#: 12 組すべてが 3 ケースとも seed になる**。3 ケースが違うのは 9〜11 セル
#: （0.0003 ha）だけで、すべて h_conn ≤ 0.35 m の帯にある [実測]。
#: 既往最高潮位 0.93 m での浸水面積は 3 ケースとも 24.85 ha で完全に一致する。
#:
#: **したがって敷高は S2 の感度を支配していない。支配しているのは吐口の有無**
#: （どの窪地にペアを置いたか）である。画面に出す「仮定の段階」は敷高ではなく
#: モデルの入れ子（連結 ⊆ 仮想排水 ⊆ 潮位以下）で出す（`docs/results.md`）。
#: ここは**その結論を再現するための感度確認**として残してある。
#:
#: **確率ではない。** 分母で割った比率も出さない（ケース間に重みが無い）。
DRAINAGE_INVERT_CASES: tuple[float, ...] = (-0.20, 0.0, 0.20)


def drainage_case_file(offset: float) -> str:
    """敷高ケースの到達水位ラスタ名。**基準ケースは既存の名前を兼用する**
    （`docs/flood_simulation_spec.md` §7.1「基準ケースを兼用し、複製しない」）。
    """
    if abs(offset) < 1e-9:
        return "h_conn_drainage_S2.tif"
    sign = "minus" if offset < 0 else "plus"
    return f"h_conn_drainage_S2_invert_{sign}_{round(abs(offset) * 100):03d}.tif"


REPRESENTATIVE_H = (1.0, 1.5, 2.0)   # 代表水位 [m T.P.]

# 道路の通行支障クラス閾値 [m]（暫定・要出典固定）
ROAD_DEPTH_CLASSES = (0.1, 0.3, 0.5)

#: 床上浸水とみなす浸水深 [m]。**地盤面からの水深**の閾値。
#: 市の要望（2026-08）が「浸水深 50cm を基準に床下・床上を分ける」だった。
#: **PLATEAU LOD1 は床高を持たない**ので、床面を超えたことの証明ではない。
#: 「浸水位」の定義そのものも未確認で照会中（`docs/todo.md` 中 4）。
FLOOR_ABOVE_DEPTH = 0.5

NODATA = -9999.0

# --- データソース -------------------------------------------------------
PLATEAU_CITYGML_URL = (
    "https://assets.cms.plateau.reearth.io/assets/8f/8ad134-6969-4a6c-a7c2-4ac370a73096/"
    "26202_maizuru-shi_city_2025_citygml_1_op.zip"
)
# AOI を含む CityGML メンバー（docs/data.md §1）。
# dem は 2次メッシュを 3次メッシュ 5x5 の 4 象限に割ったファイル構成のため複数枚必要になる。
# AOI が象限境界（lat 35.45833）をまたぐので "05"(3次メッシュ行0-4) と "55"(行5-9) の両方を使う。
#: 属性コードの表示名はコードリスト（同じ zip 内）が正。手で対応表を書かない
_CODELISTS = [
    "codelists/Building_class.xml",
    "codelists/Building_usage.xml",
]

#: 範囲ごとに必要な 3 次メッシュ。**zip の namelist と突き合わせて確認済み**
#: （2026-08。`bldg` 81 メンバー / `tran` 83 メンバー / 全 691 メンバー）。
#: 地物が 1 件も無いメッシュは配布に入っていないので、無いものは挙げていない
#: （`53351257` の bldg、`53351265` の bldg と tran、`53351380` の tran）。
_MESH3: dict[str, list[str]] = {
    # 吉原。**AOI は 4 枚に掛かる。**
    #
    # 長らく 46 の 1 枚だけを挙げていて、`README.md` の 911 地物（建物 694 /
    # 道路 217）はその数字だった。範囲を増やしたときに調べたら
    # **34 % 取りこぼしていた**（建物 +238 / 道路 +76）。
    # 「掛かるのは入江と山手だから影響は小さい」と書いていたが誤りで、
    # 取りこぼしの地盤高は中央値 2.30 m（道路 1.60 m）、
    # **既往最高潮位 0.93 m で浸水する建物が +9 %** 増える
    # （`docs/results.md`「3 次メッシュの取りこぼし」）。
    #
    # 3D Tiles 側（`scripts/82`）は AOI の矩形で切っていて最初から入っていたので、
    # viewer では**解析範囲の中なのに「解析範囲外」の灰色**で出ていた。
    "yoshiwara": ["53351245", "53351246", "53351255", "53351256"],
    "nishi_maizuru": [
        "53351235", "53351236", "53351237",
        "53351245", "53351246", "53351247",
        "53351255", "53351256", "53351257",
        "53351265", "53351266", "53351267",
    ],
    # 東へ 1.5 km 伸ばしたぶん、右列（下 2 桁が 62/63/72/73/82/83）が 6 枚増えた。
    # **6 枚とも bldg / tran の両方が配布に入っていることを zip の namelist で確認済み**
    "higashi_maizuru": [
        "53351269", "53351279", "53351289",
        "53351360", "53351361", "53351362", "53351363",
        "53351370", "53351371", "53351372", "53351373",
        "53351380", "53351381", "53351382", "53351383",
    ],
}

#: 地形 TIN。2 次メッシュを 3 次メッシュ 5x5 の 4 象限に割った構成で、
#: 象限名は `{行グループ}{列グループ}`（グループは 0 か 5）。
_DEM_QUADRANTS: dict[str, list[str]] = {
    "yoshiwara": ["533512_05", "533512_55"],
    "nishi_maizuru": ["533512_05", "533512_55"],
    "higashi_maizuru": ["533512_55", "533513_50"],
}

#: zip に無いメンバー（そのメッシュに地物が 1 件も無い）。挙げても取りに行かない
_ABSENT = {
    "udx/bldg/53351257_bldg_6697_op.gml",
    "udx/bldg/53351265_bldg_6697_op.gml",
    "udx/tran/53351265_tran_6697_op.gml",
    "udx/tran/53351380_tran_6697_op.gml",
}


def _members(aoi: str) -> dict[str, list[str]]:
    out = {
        "dem": [f"udx/dem/{q[:6]}_dem_6697_{q[7:]}_op.gml" for q in _DEM_QUADRANTS[aoi]],
        "bldg": [f"udx/bldg/{m}_bldg_6697_op.gml" for m in _MESH3[aoi]],
        "tran": [f"udx/tran/{m}_tran_6697_op.gml" for m in _MESH3[aoi]],
        "codelists": list(_CODELISTS),
    }
    for k in ("bldg", "tran"):
        out[k] = [m for m in out[k] if m not in _ABSENT]
    return out


PLATEAU_MEMBERS_BY_AOI = {a: _members(a) for a in AOIS}
PLATEAU_MEMBERS = PLATEAU_MEMBERS_BY_AOI[AOI.name]

#: 配信する地形条件。**点群は吉原にしか無い。** 面的表示用の 2 範囲は
#: 市の要望どおり 0.5m を主役にし、比較用に PLATEAU 5m だけ足す
#: （`control` = 5m 集約は解析では作るが、タイルは焼かない）
CONDITIONS_BY_AOI: dict[str, tuple[str, ...]] = {
    "yoshiwara": ("baseline", "control", "highres", "pointcloud"),
    "nishi_maizuru": ("baseline", "highres", "drainage"),
    "higashi_maizuru": ("baseline", "highres", "drainage"),
}
#: 配信する差分。鎖の辺のうち、両端の条件を配信しているものだけ
DIFFS_BY_AOI: dict[str, tuple[str, ...]] = {
    "yoshiwara": ("diff", "diff_src", "diff_res", "diff_pc"),
    "nishi_maizuru": ("diff", "diff_drainage"),
    "higashi_maizuru": ("diff", "diff_drainage"),
}
WEB_CONDITIONS = CONDITIONS_BY_AOI[AOI.name]
WEB_DIFFS = DIFFS_BY_AOI[AOI.name]

#: 配信する「水みち／窪地」（flow accumulation）タイルの条件。
#: **flow accumulation は潮位非依存**で、`drainage` は `highres` と同じ地形なので
#: 焼かない（`scripts/33` は 4 条件を解析するが、タイルは地形条件と 1 対 1）。
FLOW_TILE_CONDITIONS_BY_AOI: dict[str, tuple[str, ...]] = {
    aoi: tuple(c for c in conds if c != "drainage")
    for aoi, conds in CONDITIONS_BY_AOI.items()
}
WEB_FLOW_CONDITIONS = FLOW_TILE_CONDITIONS_BY_AOI[AOI.name]

#: 越流点マーカー（`scripts/33` の `flow_accum_pits_*.geojson`）に出す窪地の絞り込み。
#: **highres は窪地が 6,000 超**あるので、面積上位だけをベクタにする。
#: 潮位判定には一切使わない原理版（`docs/todo.md`「FARR のロジックを取り込む」）。
FLOW_POUR_POINT_MIN_AREA_M2 = 25.0
FLOW_POUR_POINT_MAX_COUNT = 60

# 京都府 数値標高モデル(DEM) 0.5m。図郭 zip ごとの入手先。
# 06LC は CKAN の署名付きリダイレクト、06MC は S3 直リンク。
KYOTO_DEM_ZIPS = {
    "06LC": "https://www.geospatial.jp/ckan/dataset/a7c25ae6-cc29-4f3a-98e9-d32b946dd06b/"
            "resource/df582950-0148-4963-ac9c-259d3a10c6d8/download/06lc.zip",
    "06MC": "https://gic-kyoto.s3.ap-northeast-1.amazonaws.com/2024/dem/06MC.zip",
}

#: 国土地理院 標高タイル（数値標高モデル）。`.txt`（256x256 の CSV、`"e"`=nodata）を
#: 使うので PNG デコード（Pillow）は要らない。**flow accumulation のルーティング
#: collar 専用**（`src/iwagaki/gsi_dem.py`、`docs/data.md` §7）。
#: `(レイヤ ID, ズーム)` の順に試す。主 = `dem5a`（DEM5A、航空レーザ 5m、z15）、
#: 副 = `dem`（**DEM10B（10m）の配信レイヤ ID は "dem"**。`dem10b` という URL は無い。
#: z14。DEM5A の無いタイルを埋める）。
#: レイヤ一覧: https://maps.gsi.go.jp/development/ichiran.html#dem
GSI_DEM_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.txt"
GSI_DEM_TILE_LAYERS: tuple[tuple[str, int], ...] = (("dem5a", 15), ("dem", 14))

#: flow accumulation のルーティング用に AOI 外周へ足す collar 帯の幅 [m]。
#: **5.0 と 0.5 の両解像度で割り切れる値**にする（150 / 5 = 30、150 / 0.5 = 300）。
#: collar はルーティングにだけ効かせ、窪地の充填深・越流点・容積は AOI 内のセルだけ
#: 集計する（`src/iwagaki/flow.py` の `route_with_collar`、`docs/data.md` §7）。
#: `IWAGAKI_FLOW_COLLAR`（[m]）で上書きできる（0 で collar 無効）。
FLOW_COLLAR_M = 150.0

ATTRIBUTION = [
    "出典：3D都市モデル（Project PLATEAU）舞鶴市（2025年度）／国土交通省",
    "出典：京都府オープンデータ「数値標高モデル（DEM）」（2019-2023年計測）"
    "（本成果は同データを加工して作成したものであり、京都府が作成したものではありません）",
    "出典：気象庁 潮位観測資料（舞鶴）",
    "出典：国土地理院 標高タイル（数値標高モデル DEM5A・DEM10B）"
    "（地表流の集中解析で解析範囲外周の流路補正にのみ使用）",
]

#: 線路を出す範囲だけに足す出典。**PLATEAU 舞鶴市に鉄道は入っていない**
#: （`udx/` に `rwy` が無く、`tran` は Road だけ）ので、線路は
#: `scripts/12_fetch_railway.py` が国土数値情報 (N02) から切り出している。
#: 吉原 100 ha には線路が掛からないので、そこでは足さない
#: （使っていないデータの出典を並べない）。
ATTRIBUTION_RAILWAY = (
    "出典：国土数値情報（鉄道データ）国土交通省"
    "（本成果は同データを加工して作成したものである）"
)

#: 小地域境界（`scripts/13`）を配信物に含める範囲だけに足す出典。
#: e-Stat 利用規約が加工の明記を条件にしている（`docs/data.md` §5 / §6）。
#: 境界が無い配信物（`small_areas` を持たない catalog）では足さない。
ATTRIBUTION_CENSUS = (
    "出典：「令和2年国勢調査」（総務省統計局）の境界データ"
    "（e-Stat 統計GIS）を加工して作成"
)
