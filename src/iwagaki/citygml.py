"""PLATEAU CityGML の必要最小限のパース。

汎用変換は PLATEAU-GIS-Converter に譲る。ここは
「地形TINの頂点」「建物のlod0屋根外形」「道路のlod1面」だけを取り出す。
座標は EPSG:6697 の `緯度 経度 標高` 並びであることに注意。
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import numpy as np
from lxml import etree

NS = {
    "core": "http://www.opengis.net/citygml/2.0",
    "gml": "http://www.opengis.net/gml",
    "bldg": "http://www.opengis.net/citygml/building/2.0",
    "tran": "http://www.opengis.net/citygml/transportation/2.0",
    "uro": "https://www.geospatial.jp/iur/uro/3.2",
    "gen": "http://www.opengis.net/citygml/generics/2.0",
}
GML = NS["gml"]
_POSLIST = f"{{{GML}}}posList"
_ID = f"{{{GML}}}id"


def _triples(text: str) -> np.ndarray:
    """posList テキスト -> (n, 3) 配列 [lat, lon, z]"""
    v = np.fromstring(text, sep=" ")
    return v.reshape(-1, 3)


def iter_tin_vertices(
    path: Path, bbox_lonlat: tuple[float, float, float, float], chunk: int = 200_000
) -> Iterator[np.ndarray]:
    """dem GML の TIN 頂点を bbox で絞って (n,3) [lon, lat, z] のチャンクで返す。"""
    lon0, lat0, lon1, lat1 = bbox_lonlat
    buf: list[np.ndarray] = []
    n = 0
    ctx = etree.iterparse(str(path), events=("end",), tag=_POSLIST, huge_tree=True)
    for _, el in ctx:
        if el.text:
            p = _triples(el.text)
            keep = (
                (p[:, 1] >= lon0) & (p[:, 1] <= lon1)
                & (p[:, 0] >= lat0) & (p[:, 0] <= lat1)
            )
            if keep.any():
                buf.append(p[keep][:, [1, 0, 2]])
                n += int(keep.sum())
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]
        if n >= chunk:
            yield np.vstack(buf)
            buf, n = [], 0
    if buf:
        yield np.vstack(buf)


def _polygons_from(el, bbox_lonlat) -> list[np.ndarray]:
    """要素配下の gml:Polygon 外環を [lon, lat] 配列のリストで返す（bbox交差のみ）。"""
    lon0, lat0, lon1, lat1 = bbox_lonlat
    out = []
    for ring in el.iterfind(f".//{{{GML}}}exterior/{{{GML}}}LinearRing/{{{GML}}}posList"):
        if not ring.text:
            continue
        p = _triples(ring.text)
        xy = p[:, [1, 0]]
        if xy[:, 0].max() < lon0 or xy[:, 0].min() > lon1:
            continue
        if xy[:, 1].max() < lat0 or xy[:, 1].min() > lat1:
            continue
        if len(xy) >= 4:
            out.append(xy)
    return out


def _text(el, xpath: str) -> str | None:
    found = el.find(xpath, NS)
    return found.text if found is not None and found.text else None


def parse_buildings(path: Path, bbox_lonlat) -> list[dict]:
    """bldg:Building の lod0RoofEdge（無ければ lod1Solid）と主要属性。"""
    feats = []
    ctx = etree.iterparse(str(path), events=("end",),
                          tag=f"{{{NS['bldg']}}}Building", huge_tree=True)
    for _, el in ctx:
        gml_id = el.get(_ID)
        geom_src = "lod0RoofEdge"
        node = el.find("bldg:lod0RoofEdge", NS)
        if node is None:
            node = el.find("bldg:lod1Solid", NS)
            geom_src = "lod1Solid"
        rings = _polygons_from(node, bbox_lonlat) if node is not None else []
        if rings:
            feats.append({
                "gml_id": gml_id,
                "feature_type": "bldg:Building",
                "geom_src": geom_src,
                "name": _text(el, "gml:name"),
                "class": _text(el, "bldg:class"),
                "usage": _text(el, "bldg:usage"),
                "year": _text(el, "bldg:yearOfConstruction"),
                "height": _text(el, "bldg:measuredHeight"),
                "storeys": _text(el, "bldg:storeysAboveGround"),
                "structure": _text(
                    el,
                    "uro:buildingDetailAttribute/uro:BuildingDetailAttribute"
                    "/uro:buildingStructureType",
                ),
                "rings": rings,
            })
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]
    return feats


def parse_roads(path: Path, bbox_lonlat) -> list[dict]:
    """tran:Road の lod1MultiSurface と属性。"""
    feats = []
    ctx = etree.iterparse(str(path), events=("end",),
                          tag=f"{{{NS['tran']}}}Road", huge_tree=True)
    for _, el in ctx:
        node = el.find("tran:lod1MultiSurface", NS)
        rings = _polygons_from(node, bbox_lonlat) if node is not None else []
        if rings:
            feats.append({
                "gml_id": el.get(_ID),
                "feature_type": "tran:Road",
                "geom_src": "lod1MultiSurface",
                "name": _text(el, "gml:name"),
                "class": _text(el, "tran:class"),
                "function": _text(el, "tran:function"),
                "section_type": _text(
                    el,
                    "uro:roadStructureAttribute/uro:RoadStructureAttribute"
                    "/uro:sectionType",
                ),
                "rings": rings,
            })
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]
    return feats
