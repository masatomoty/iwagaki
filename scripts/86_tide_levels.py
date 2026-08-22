#!/usr/bin/env python3
"""舞鶴の潮位基準値を求める（docs/DATA.md §4 の [未確認] を埋める）。

水位 H を「根拠のないパラメータ」のままにしないための基準線を作る。

- **天文潮**は気象庁の推算潮位表（毎時値）から自分で計算する。
  検算: 年平均が気象庁公表の平均水面 T.P.+0.124 m と一致すること。
- **既往最高潮位**は京都府「丹後沿岸海岸保全基本計画」の記載値を使う（出典つき）。
  こちらは計算ではなく引用。

出力は data/out/tide_levels.json。catalog に取り込まれ、UI の水位スライダの目盛りになる。
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import OUT, TP_OF_MSL, TP_OF_TIDE_TABLE_DATUM

STATION = "MZ"          # 気象庁 舞鶴
URL = "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{stn}.txt"

# 京都府「丹後沿岸海岸保全基本計画（変更原案）」より。原典は気象庁。
# https://www.pref.kyoto.jp/shingikai/kaigan-01/documents/shiryo4.pdf
RECORD_HIGH = {
    "value_m_tp": 0.93,
    "when": "1998-09-22",
    "cause": "台風7号",
    "source": "京都府「丹後沿岸海岸保全基本計画」（原典: 気象庁）",
    "source_url": "https://www.pref.kyoto.jp/shingikai/kaigan-01/documents/shiryo4.pdf",
    "kind": "citation",
}


def hourly_tp(year: int) -> np.ndarray:
    """推算潮位表の毎時値 [cm, 潮位表基準面] を読み、標高 [m T.P.] にして返す。

    書式: 1〜72 桁が毎時潮位（3 桁 × 24）、73〜78 桁が年月日、79〜80 桁が地点記号。
    """
    text = urllib.request.urlopen(URL.format(year=year, stn=STATION)).read()
    vals: list[int] = []
    for line in text.decode("utf-8", "replace").splitlines():
        if len(line) < 72:
            continue
        for i in range(24):
            v = line[i * 3:(i + 1) * 3].strip()
            if v:
                vals.append(int(v))
    return np.array(vals, dtype=float) / 100.0 + TP_OF_TIDE_TABLE_DATUM


def main() -> int:
    year = 2026
    tp = hourly_tp(year)
    if len(tp) % 24 != 0:
        raise SystemExit(f"毎時値の数が 24 の倍数でない: {len(tp)}")
    daily_max = tp.reshape(-1, 24).max(axis=1)

    mean = float(tp.mean())
    # 検算: 天文潮の年平均は平均水面に一致するはず
    drift = abs(mean - TP_OF_MSL)
    if drift > 0.01:
        raise SystemExit(
            f"年平均 {mean:.3f} が気象庁公表の平均水面 {TP_OF_MSL} と {drift:.3f} m ずれている。"
            "基準面の換算か書式の読み方が間違っている")

    out = {
        "station": {"name": "舞鶴", "jma_code": STATION,
                    "tide_table_datum_m_tp": TP_OF_TIDE_TABLE_DATUM,
                    "msl_m_tp_published": TP_OF_MSL},
        "astronomical": {
            "year": year, "hours": int(len(tp)),
            "kind": "computed",
            "method": "気象庁 推算潮位表（毎時値）から計算。天文潮のみで気象擾乱を含まない",
            "source_url": URL.format(year=year, stn=STATION),
            "mean_m_tp": round(mean, 3),
            "mean_matches_published_msl": True,
            "max_m_tp": round(float(tp.max()), 3),
            "daily_max_mean_m_tp": round(float(daily_max.mean()), 3),
            # 朔望平均満潮位は「朔望の前2日後4日の各月最高満潮面の平均」。
            # ここでは日最高の上位 24 日（月2回×12ヶ月相当）の平均で近似する
            "spring_high_water_approx_m_tp": round(float(np.sort(daily_max)[-24:].mean()), 3),
            "spring_high_water_note":
                "朔望平均満潮位の近似。厳密な定義（朔望前後の各月最高満潮面の平均）ではない",
        },
        "record_high": RECORD_HIGH,
        "reference_levels_m_tp": {
            "MSL": round(mean, 3),
            "H.W.L.(近似)": round(float(np.sort(daily_max)[-24:].mean()), 3),
            "天文潮最高": round(float(tp.max()), 3),
            "既往最高潮位": RECORD_HIGH["value_m_tp"],
        },
        "caveats": [
            "既往最高潮位は引用値であり、本リポジトリで再計算したものではない",
            "朔望平均満潮位は近似値。設計に使う値ではない",
            "舞鶴に高潮浸水想定区域（水防法）の指定は無い（docs/DATA.md §4）",
            "設計高潮位・計画高潮位・吉原入江の護岸天端高は依然として未確認",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "tide_levels.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(json.dumps(out["reference_levels_m_tp"], indent=2, ensure_ascii=False))
    print(f"\n検算: 天文潮の年平均 {mean:.3f} m = 気象庁公表の平均水面 {TP_OF_MSL} m ✓")
    print(f"wrote {OUT / 'tide_levels.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
