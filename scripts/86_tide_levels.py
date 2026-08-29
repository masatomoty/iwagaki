#!/usr/bin/env python3
"""舞鶴の潮位基準値を求める（docs/data.md §4 の [未確認] を埋める）。

水位 H を「根拠のないパラメータ」のままにしないための基準線を作る。

- **天文潮**は気象庁の推算潮位表（毎時値）から自分で計算する。
  検算: 年平均が気象庁公表の平均水面 T.P.+0.124 m と一致すること。
- **既往最高潮位**は京都府「丹後沿岸海岸保全基本計画」の記載値を使う（出典つき）。
  こちらは計算ではなく引用。

出力は data/out/tide_levels.json。catalog に取り込まれ、UI の水位スライダの目盛りになる。

加えて、静水位モデルの「パラメータ掃引」に入力できる潮位時系列を出す。
- `tide_series_astronomical.json`: 推算潮位表から選んだ 14 日間の天文潮。
- `tide_series_observed_{event}.json`: 取得できた台風イベントの毎時実測潮位。

観測値の書式は観測基準面（DL）なので、イベント当時の JMA 公表基準面で T.P. に換算する。
欠測は補間せず、取得できた期間だけを出す。
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iwagaki.config import (OUT, TP_OF_MSL, TP_OF_OBSERVATION_DATUM,
                            TP_OF_TIDE_TABLE_DATUM)

STATION = "MZ"          # 気象庁 舞鶴
URL = "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{stn}.txt"
OBSERVED_URL = ("https://www.data.jma.go.jp/kaiyou/data/db/tide/genbo/"
                "{year}/{year}{month:02d}/hry{year}{month:02d}{stn}.txt")
PROVISIONAL_URL = ("https://www.data.jma.go.jp/kaiyou/data/db/tide/sokuho/"
                   "{year}{month:02d}/z_hry{year}{month:02d}{stn}.txt")


def full_year(yy: str) -> int:
    """hry の年は下2桁。JMA の資料体系に合わせて 50 を境に補う。"""
    n = int(yy)
    return 1900 + n if n >= 50 else 2000 + n

# `genbo.php?stn=MZ&year=1998&month=09&LV=TP` の「観測基準面の標高」で確認済み
# （-130.1 cm）。現在値（-1.517 m T.P., 2024 成果）ではない。**1998 当時の公表値**。
DATUM_1998_M_TP = -1.301

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

# 京都府「高潮浸水想定区域図について」（解説資料）表 3.2。
# **舞鶴は高潮浸水想定区域に指定されている**（水防法第14条の3）。
# 以前このリポジトリは「指定は無い」と書いていたが誤りだった。
OFFICIAL_LEVELS = {
    # 舞鶴検潮所の毎時潮位記録（気象庁）から 2019-2023 の 5 ヶ年平均
    "spring_high_water_m_tp": 0.545,
    # 下野ら(2004) の日本海沿岸の値
    "anomaly_m": 0.142,
    # 朔望平均満潮位 + 異常潮位。高潮のシミュレーションはここを起点に潮位偏差を足す
    "design_base_tide_m_tp": 0.69,
    "assumed_typhoon": "中心気圧 910 hPa（室戸台風規模）。想定し得る最大規模",
    "levee_assumption":
        "海岸保全施設・河川管理施設は設計条件に達した段階で決壊するものとして扱う。"
        "決壊しない場合も別途計算し、両者の最大浸水深を区域図に表示している",
    "source": "京都府「高潮浸水想定区域図について」（水防法第14条の3に基づく公表資料）",
    "source_url": "https://www.pref.kyoto.jp/sabo/takashio_shinsui/documents/takashiokaisetsu.pdf",
    "index_url": "https://www.pref.kyoto.jp/sabo/takashio_shinsui/index.html",
    "kind": "citation",
}


def hourly_records(year: int) -> list[dict]:
    """推算潮位表の毎時値を、時刻付きの標高 [m T.P.] として返す。

    書式: 1〜72 桁が毎時潮位（3 桁 × 24）、73〜74 年、75〜76 月、
    77〜78 日、79〜80 地点記号。
    """
    text = urllib.request.urlopen(URL.format(year=year, stn=STATION)).read()
    records: list[dict] = []
    for line in text.decode("utf-8", "replace").splitlines():
        if len(line) < 72:
            continue
        yy = full_year(line[72:74])
        mm, dd = int(line[74:76]), int(line[76:78])
        if line[78:80] != STATION:
            continue
        for i in range(24):
            v = line[i * 3:(i + 1) * 3].strip()
            if v:
                records.append({
                    "time": f"{yy:04d}-{mm:02d}-{dd:02d}T{i:02d}:00+09:00",
                    "tide_m_tp": int(v) / 100.0 + TP_OF_TIDE_TABLE_DATUM,
                })
    return records


def hourly_tp(year: int) -> np.ndarray:
    """従来の検算用。毎時値のみを標高 [m T.P.] にして返す。"""
    return np.array([r["tide_m_tp"] for r in hourly_records(year)], dtype=float)


def observed_series(
    url: str, dates: set[str], datum_m_tp: float, quality: str
) -> dict | None:
    """毎時実測潮位（DL 表記）を読み、指定日だけ T.P. に換算して返す。"""
    text = urllib.request.urlopen(url).read().decode("utf-8", "replace")
    points: list[dict] = []
    for line in text.splitlines():
        if len(line) < 80 or line[78:80] != STATION:
            continue
        date = (f"{full_year(line[72:74]):04d}-"
                f"{int(line[74:76]):02d}-{int(line[76:78]):02d}")
        if date not in dates:
            continue
        for hour in range(24):
            raw = line[hour * 3:(hour + 1) * 3].strip()
            if raw:
                points.append({
                    "time": f"{date}T{hour:02d}:00+09:00",
                    "tide_m_tp": round(int(raw) / 100.0 + datum_m_tp, 3),
                })
    if not points:
        return None
    peak = max(points, key=lambda p: p["tide_m_tp"])
    return {"points": points, "peak_time": peak["time"],
            "peak_value_m_tp": peak["tide_m_tp"], "quality": quality}


def main() -> int:
    year = 2026
    records = hourly_records(year)
    tp = np.array([r["tide_m_tp"] for r in records], dtype=float)
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

    # 春潮の「見た目」を入力できるようにする。日較差が最大になる 14 日間。
    # **年最大を保証する近似ではない。**
    by_date: dict[str, list[dict]] = {}
    for r in records:
        by_date.setdefault(r["time"][:10], []).append(r)
    dates = sorted(by_date)
    ranges = [max(r["tide_m_tp"] for r in by_date[d]) -
              min(r["tide_m_tp"] for r in by_date[d]) for d in dates]
    start = max(range(len(dates) - 13), key=lambda i: sum(ranges[i:i + 14]))
    window = dates[start:start + 14]
    astro_points = [r for d in window for r in by_date[d]]
    astro_peak = max(astro_points, key=lambda p: p["tide_m_tp"])
    astronomical = {
        "id": "astronomical-2026-14d",
        "label": "天文潮 14 日間 [実測/推算]",
        "kind": "computed",
        "cause": "天文潮（気象擾乱を含まない）",
        "datum": "T.P.（潮位表基準面を config の値で換算）",
        "source_url": URL.format(year=year, stn=STATION),
        "points": astro_points,
        "peak_time": astro_peak["time"],
        "peak_value_m_tp": round(astro_peak["tide_m_tp"], 3),
        "note": "日較差が最大になる 14 日間。時間発展ではなく静水位の掃引入力",
    }

    observed_bodies: dict[str, dict] = {}
    event_defs = [
        {
            "id": "1998-09-22", "label": "台風7号（既往最高）",
            "cause": "台風7号", "url": OBSERVED_URL.format(
                year=1998, month=9, stn=STATION),
            "dates": {"1998-09-22"},
            "datum_m_tp": DATUM_1998_M_TP, "quality": "confirmed",
            "datum_note": "1998 当時の観測基準面 -1.301 m T.P.（JMA 資料ページ）",
        },
        {
            "id": "2026-08-09", "label": "2026-08-09 観測",
            "cause": None, "url": PROVISIONAL_URL.format(
                year=2026, month=8, stn=STATION),
            "dates": {"2026-08-09"},
            "datum_m_tp": TP_OF_OBSERVATION_DATUM, "quality": "provisional",
            "datum_note": "現在の観測基準面（測地成果2011 換算）",
        },
        {
            "id": "2026-08-12", "label": "2026-08-12 観測",
            "cause": None, "url": PROVISIONAL_URL.format(
                year=2026, month=8, stn=STATION),
            "dates": {"2026-08-12"},
            "datum_m_tp": TP_OF_OBSERVATION_DATUM, "quality": "provisional",
            "datum_note": "現在の観測基準面（測地成果2011 換算）",
        },
    ]
    for event in event_defs:
        try:
            body = observed_series(
                event["url"], event["dates"], event["datum_m_tp"], event["quality"])
        except Exception as exc:
            print(f"! observed {event['id']}: {exc}", file=sys.stderr)
            continue
        if body is None:
            print(f"! observed {event['id']}: 値なし", file=sys.stderr)
            continue
        observed_bodies[event["id"]] = {
            "id": f"observed-{event['id']}",
            "label": f"{event['label']} [実測]", "kind": "observed",
            "cause": event["cause"], "datum": event["datum_note"],
            "source_url": event["url"], **body,
            "note": "毎時観測値。欠測は補間していない",
        }

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
        # 京都府「高潮浸水想定区域図について」（解説資料）表 3.2 の実数値。
        # **本リポジトリの近似ではなく公表値**なので、近似より優先して出す。
        "official": OFFICIAL_LEVELS,
        "tide_series": {
            "astronomical": astronomical,
            "observed_events": [
                {"id": key, "peak_time": body["peak_time"],
                 "peak_value_m_tp": body["peak_value_m_tp"],
                 "source_url": body["source_url"]}
                for key, body in observed_bodies.items()
            ],
        },
        "reference_levels_m_tp": {
            "MSL": round(mean, 3),
            "H.W.L.(近似)": round(float(np.sort(daily_max)[-24:].mean()), 3),
            "天文潮最高": round(float(tp.max()), 3),
            # 京都府の公表値。こちらの近似（H.W.L.(近似)）より 0.1 m 高い
            "朔望平均満潮位(公表)": OFFICIAL_LEVELS["spring_high_water_m_tp"],
            "高潮想定の基準潮位": OFFICIAL_LEVELS["design_base_tide_m_tp"],
            "既往最高潮位": RECORD_HIGH["value_m_tp"],
        },
        "caveats": [
            "既往最高潮位は引用値であり、本リポジトリで再計算したものではない",
            "朔望平均満潮位(近似) は本リポジトリの近似。公表値は別に併記している",
            "**舞鶴は高潮浸水想定区域（水防法第14条の3）に指定されている。**"
            "以前『指定は無い』と記載していたのは誤り（docs/data.md §4）",
            "京都府の想定は堤防等が決壊する場合を基本としている。"
            "本リポジトリのモデルは施設を一切持たないので、決壊側に近い",
            "設計高潮位・計画高潮位の個別海岸の数値、および"
            "吉原入江の水門・樋門・陸閘は依然として未確認",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "tide_levels.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    for path, body in [
        (OUT / "tide_series_astronomical.json", astronomical),
        *((OUT / f"tide_series_observed_{key}.json", body)
          for key, body in observed_bodies.items()),
    ]:
        path.write_text(json.dumps(body, indent=2, ensure_ascii=False))
        print(f"wrote {path} ({len(body['points'])} points, "
              f"peak {body['peak_value_m_tp']:.3f} m T.P. at {body['peak_time']})")
    print(json.dumps(out["reference_levels_m_tp"], indent=2, ensure_ascii=False))
    print(f"\n検算: 天文潮の年平均 {mean:.3f} m = 気象庁公表の平均水面 {TP_OF_MSL} m ✓")
    print(f"wrote {OUT / 'tide_levels.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
