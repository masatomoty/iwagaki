"""scripts/83_build_catalog.py の point_buffer() のテスト。

catalog.json 全体の組み立てはタイル・PLATEAU・DEM が要るので統合実行でしか確かめられない
（この repo に scripts/83 の既存ユニットテストが無いのはそのため）。ここは
`point_buffer()` だけを切り出して確かめる — 範囲を跨いだ共通の索引から
**この範囲の地点だけ**を拾えているか、索引が無ければ鍵ごと落ちるか。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

from conftest import load_script

bc = load_script("83_build_catalog")


def _patch(monkeypatch, tmp_path, aoi_name: str = "yoshiwara"):
    monkeypatch.setattr(bc, "OUT", tmp_path / "out" / aoi_name)
    monkeypatch.setattr(bc, "WEB_DATA", tmp_path / "web_data")
    monkeypatch.setattr(bc, "AOI", SimpleNamespace(name=aoi_name))


def test_point_buffer_filters_by_aoi_and_publishes(tmp_path, monkeypatch):
    src_dir = tmp_path / "out" / "point_buffer"
    src_dir.mkdir(parents=True)
    (src_dir / "point_buffer_a.json").write_text(
        json.dumps({"label": "地点A"}), encoding="utf-8")
    (src_dir / "point_buffer_b.json").write_text(
        json.dumps({"label": "地点B"}), encoding="utf-8")
    (src_dir / "index.json").write_text(json.dumps({
        "version": 1,
        "points": [
            {"id": "a", "label": "地点A", "center_wgs84": [135.1, 35.1],
             "aoi": "yoshiwara", "radii_m": [500, 800, 1000],
             "generated_at": "2026-09-01T00:00:00", "url": "point_buffer_a.json"},
            {"id": "b", "label": "地点B", "center_wgs84": [135.9, 35.9],
             "aoi": "nishi_maizuru", "radii_m": [500, 800, 1000],
             "generated_at": "2026-09-01T00:00:00", "url": "point_buffer_b.json"},
        ],
    }), encoding="utf-8")
    (tmp_path / "web_data").mkdir()
    _patch(monkeypatch, tmp_path)

    asset = bc.point_buffer()
    assert asset["count"] == 1
    name = asset["url"].split("data/", 1)[1]
    published = json.loads((tmp_path / "web_data" / name).read_text(encoding="utf-8"))
    assert [p["id"] for p in published["points"]] == ["a"]
    assert published["points"][0]["label"] == "地点A"
    # 索引側の url は WEB_DATA 内の（内容ハッシュ付き）配信名に書き換わっている
    assert published["points"][0]["url"] != "point_buffer_a.json"


def test_point_buffer_empty_when_no_points_in_aoi(tmp_path, monkeypatch):
    src_dir = tmp_path / "out" / "point_buffer"
    src_dir.mkdir(parents=True)
    (src_dir / "index.json").write_text(json.dumps({
        "version": 1,
        "points": [{"id": "b", "label": "地点B", "center_wgs84": [135.9, 35.9],
                    "aoi": "nishi_maizuru", "radii_m": [500], "generated_at": "",
                    "url": "point_buffer_b.json"}],
    }), encoding="utf-8")
    _patch(monkeypatch, tmp_path)

    assert bc.point_buffer() == {}


def test_point_buffer_empty_without_index(tmp_path, monkeypatch):
    _patch(monkeypatch, tmp_path)
    assert bc.point_buffer() == {}
