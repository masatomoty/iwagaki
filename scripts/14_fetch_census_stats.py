#!/usr/bin/env python3
"""e-Stat 統計GIS の「統計データ」から 2020年国勢調査の小地域**統計表**を取る。

京都市・さいたま市からの「任意地点を中心にした範囲集計」（`docs/todo.md` T1、
2026-08-28〜29）の受け皿。`scripts/13_fetch_census_boundaries.py` が出した
**境界ポリゴン**（`data/interim/census_boundary_maizuru_2020.geojson`）に
`KEY_CODE` で結合できる形で、**人口総数と年齢区分**を持ってくる。

`scripts/13` と同じ「外部データセットのフェッチャ」で、`scripts/93_point_buffer_agg.py`
の入力になる。**人口・年齢だけ**取る（世帯・産業・就業は T1 のスコープ外。
事業所数＝経済センサス、用途地域＝都市計画 GIS は別データ・別 PR）。

取得元
------
政府統計の総合窓口 e-Stat／統計地理情報システム（統計GIS）の「統計データ」。
統計表を選ぶと都道府県単位で CSV（zip）をダウンロードできる:

    https://www.e-stat.go.jp/gis/statmap-search/data
        ?statsId=T001082    # 2020年国勢調査（小地域）年齢（5歳階級、4区分）別、男女別人口
        &code=26            # 京都府（市区町村単位でも可: code=26202）
        &downloadType=2     # 2 = CSV

**統計表 ID（`statsId`）の探し方**（サイト構成が変わって上の URL が 404 のとき）

1. https://www.e-stat.go.jp/gis/statmap-search?type=1 を開く
2. 「統計データ」→ 国勢調査 → 2020年 → 小地域（町丁・字等）
   → 「年齢（５歳階級、４区分）別、男女別人口」を選ぶ
3. 一覧に「CSV」ボタンが並ぶ。URL バーの `statsId=...` がそれ
   （人口総数だけなら「男女別人口総数及び世帯総数」= 別 ID。ただし**総数は
   下の T001082 の `T001082001` 列にも入っている**ので、この 1 表で足りる）
4. 落とした zip を `data/raw/estat/tblT001082C26.zip` に置いてこのスクリプトを再実行

**版・出典・ライセンス（`docs/data.md` §5 にも記録）**

* 版: 2020年（令和2年）国勢調査 小地域（町丁・字等別）。統計表 ID `T001082`
  「年齢（５歳階級、４区分）別、男女別人口」。境界（`scripts/13` の
  `A002005212020`）と同じ調査・同じ年次。
* 文字コード: **Shift_JIS（cp932）**。1 行目が列コード、2 行目が日本語の列名、
  3 行目以降がデータ。`HYOSYO` は集計単位（1=市, 2=特殊(水面等), 3=大字, 4=町丁字）。
* 秘匿: 対象が少ない小地域は値が **`X`**（秘匿）や **`-`**（該当なし）。
  `X` は復元しない（`suppressed=True` で残す）。舞鶴市の AOI 圏内では
  8 小地域（自衛隊・寮・修道院・水面など）が該当する [実測 2026-09-01]。
* ライセンス: 政府統計の総合窓口（e-Stat）利用規約。出典表記を条件に加工・再配布可
  （商用含む）。出典表記例: 「「令和2年国勢調査」（総務省統計局）（e-Stat 統計GIS）を
  加工して作成」。

使う列（`T001082` の 60 列のうち。詳細は 2 行目の列名）
----
* `T001082001` 総数（年齢「不詳」含む）      -> `pop_total`
* `T001082017` 総数 15歳未満（年少人口）      -> `age_0_14`
* `T001082018` 総数 15〜64歳（生産年齢人口）  -> `age_15_64`
* `T001082019` 総数 65歳以上（老年人口）      -> `age_65_plus`
* `T001082020` 総数 75歳以上（再掲）          -> `age_75_plus`

`age_0_14 + age_15_64 + age_65_plus + 年齢不詳 = pop_total`。年齢不詳は
`pop_total` から 3 区分を引いて求める（`age_unknown`）。

出力
----
`data/interim/census_stats_maizuru_2020.csv`（舞鶴市の全小地域。KEY_CODE で
`scripts/13` の境界に結合可能）と `.json`（版・出典・列定義・秘匿件数）。
**このスクリプトはファイル書き出しだけ。** viewer 配線は無し（`scripts/13` と同じ）。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import INTERIM, RAW

#: 2020年国勢調査（小地域）年齢（５歳階級、４区分）別、男女別人口
STATS_ID = "T001082"
#: 京都府（都道府県コード）。市区町村単位でも取れるが、府単位の 1 zip で舞鶴を含む
PREF_CODE = "26"
CITY_PREFIX = "26202"  # 舞鶴市

ESTAT_STATS_URL = (
    "https://www.e-stat.go.jp/gis/statmap-search/data"
    f"?statsId={STATS_ID}&code={PREF_CODE}&downloadType=2"
)
#: 統計GIS の境界（`scripts/13`）と揃えるための調査 ID（記録用）
BOUNDARY_SURVEY_ID = "A002005212020"

CACHE = RAW / "estat" / f"tbl{STATS_ID}C{PREF_CODE}.zip"
CSV_MEMBER = f"tbl{STATS_ID}C{PREF_CODE}.txt"

OUT_CSV = INTERIM / "census_stats_maizuru_2020.csv"
OUT_JSON = INTERIM / "census_stats_maizuru_2020.json"

#: 列コード -> 出力名。2 行目の日本語列名から確認した対応（docstring 参照）。
COLS = {
    "T001082001": "pop_total",
    "T001082017": "age_0_14",
    "T001082018": "age_15_64",
    "T001082019": "age_65_plus",
    "T001082020": "age_75_plus",
}
#: 秘匿・該当なしを表すトークン
SUPPRESSED = "X"
NOT_APPLICABLE = "-"

OUT_FIELDS = [
    "key_code", "hyosyo", "s_name",
    "pop_total", "age_0_14", "age_15_64", "age_65_plus", "age_unknown",
    "age_75_plus", "suppressed",
]


def fetch_csv_bytes(force: bool = False) -> bytes:
    """`tblT001082C26.txt` を bytes（cp932）で返す。キャッシュが無ければ取得する。"""
    if force:
        CACHE.unlink(missing_ok=True)
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        loose = RAW / "estat" / CSV_MEMBER
        if loose.exists():
            print(f"using loose CSV {loose}")
            return loose.read_bytes()
        print(f"downloading {ESTAT_STATS_URL}")
        req = urllib.request.Request(
            ESTAT_STATS_URL, headers={"User-Agent": "iwagaki/1.0"})
        with urllib.request.urlopen(req, timeout=300) as r:
            payload = r.read()
        if payload[:2] != b"PK":
            raise SystemExit(
                "e-Stat から zip が返ってこなかった（サイト構成の変更の可能性）。"
                "docstring の手順で statsId を確認し手動配置する"
            )
        CACHE.write_bytes(payload)
    print(f"{CACHE.name}  {CACHE.stat().st_size / 1e6:.2f} MB")
    with zipfile.ZipFile(CACHE) as z:
        name = next((n for n in z.namelist() if n.endswith(".txt")), None)
        if name is None:
            raise SystemExit(f"{CACHE} に .txt が無い（{z.namelist()}）")
        return z.read(name)


def parse(raw: bytes) -> tuple[list[dict], dict[str, str]]:
    """(舞鶴市の小地域行, 列コード->日本語列名)。"""
    rows = list(csv.reader(io.StringIO(raw.decode("cp932"))))
    header, labels = rows[0], rows[1]
    idx = {code: i for i, code in enumerate(header)}
    missing = [c for c in COLS if c not in idx]
    if missing:
        raise SystemExit(f"想定した列が無い: {missing}（実際の先頭: {header[:10]}）")
    col_labels = {code: labels[idx[code]] for code in COLS}

    out: list[dict] = []
    for r in rows[2:]:
        key = r[idx["KEY_CODE"]]
        if not key.startswith(CITY_PREFIX) or key == CITY_PREFIX:
            continue  # 府・市の合計行は落とす（小地域だけ残す）
        raw_vals = {name: r[idx[code]] for code, name in COLS.items()}
        suppressed = any(v == SUPPRESSED for v in raw_vals.values())

        def num(v: str) -> int | None:
            if v == NOT_APPLICABLE:
                return 0
            if v in (SUPPRESSED, ""):
                return None
            return int(v)

        vals = {name: num(v) for name, v in raw_vals.items()}
        unknown = None
        if all(vals[k] is not None for k in
               ("pop_total", "age_0_14", "age_15_64", "age_65_plus")):
            unknown = (vals["pop_total"] - vals["age_0_14"]
                       - vals["age_15_64"] - vals["age_65_plus"])
        out.append({
            "key_code": key,
            "hyosyo": r[idx["HYOSYO"]],
            "s_name": r[idx["NAME"]],
            "pop_total": vals["pop_total"],
            "age_0_14": vals["age_0_14"],
            "age_15_64": vals["age_15_64"],
            "age_65_plus": vals["age_65_plus"],
            "age_unknown": unknown,
            "age_75_plus": vals["age_75_plus"],
            "suppressed": suppressed,
        })
    return out, col_labels


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="キャッシュを無視して e-Stat から取り直す")
    args = ap.parse_args()

    records, col_labels = parse(fetch_csv_bytes(force=args.force))
    if not records:
        raise SystemExit("舞鶴市（26202）の小地域行が 0 件。statsId / code を確認する")

    INTERIM.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=OUT_FIELDS)
        w.writeheader()
        for rec in sorted(records, key=lambda r: r["key_code"]):
            w.writerow({k: ("" if rec[k] is None else rec[k]) for k in OUT_FIELDS})

    n_suppressed = sum(r["suppressed"] for r in records)
    # HYOSYO=3（大字）は 4（町丁字）の合算なので、合計は 4 だけで数える
    # （秘匿で 3 にしか値が無い小地域は 4 側が空になる。取りこぼしは軽微）
    pop = sum(r["pop_total"] for r in records
              if r["hyosyo"] == "4" and r["pop_total"] is not None)
    meta = {
        "source": "「令和2年国勢調査」（総務省統計局）（e-Stat 統計GIS）を加工",
        "source_url": ESTAT_STATS_URL,
        "stats_id": STATS_ID,
        "stats_name": "年齢（５歳階級、４区分）別、男女別人口",
        "boundary_survey_id": BOUNDARY_SURVEY_ID,
        "boundary_year": 2020,
        "join_key": "KEY_CODE（scripts/13 の census_boundary_maizuru_2020.geojson と共通）",
        "encoding_original": "cp932 (Shift_JIS)",
        "columns_used": {code: col_labels[code] for code in COLS},
        "derived": {
            "age_unknown": "pop_total - age_0_14 - age_15_64 - age_65_plus（年齢不詳）",
            "age_75_plus": "65歳以上の内数（再掲）。3 区分の合計には足さない",
        },
        "suppression": {
            "token": SUPPRESSED,
            "meaning": "対象数が少なく秘匿。復元しない（suppressed=True, 値は空欄）",
            "n_small_areas_suppressed": n_suppressed,
        },
        "license": "政府統計の総合窓口（e-Stat）利用規約。出典表記を条件に加工・再配布可",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_small_areas": len(records),
        "hyosyo_note": "HYOSYO 3=大字 は 4=町丁字 の合算。結合は KEY_CODE 一致なので"
                       "境界（scripts/13）が持つキーだけが引かれる（二重計上しない）",
        "pop_total_hyosyo4_sum": pop,
    }
    OUT_JSON.write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    print(f"wrote {OUT_CSV}  ({len(records)} 小地域, うち秘匿 {n_suppressed})")
    print(f"wrote {OUT_JSON}")
    print(f"  名前付き小地域の人口合計 {pop:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
