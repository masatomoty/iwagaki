"""国土基本図図郭 ↔ 平面直角座標（京都府DEMのタイル命名）。

タイル名は `{系}{行}{列}{d1}{d2}{d3}{d4}` 形式（例 `06LC9444`）。
規則は実データのワールドファイルから導出し 4 タイルで検証済み（docs/data.md §2）。
"""
from __future__ import annotations

from dataclasses import dataclass

# 1/50000 図郭のサイズ
SHEET_H = 30_000.0   # 北南方向
SHEET_W = 40_000.0   # 東西方向
# 1/5000 図郭
CELL_H = 3_000.0
CELL_W = 4_000.0
# 1/2500 象限
Q_H = 1_500.0
Q_W = 2_000.0
# 1/1000 象限（=1タイル）
TILE_H = 750.0
TILE_W = 1_000.0

# 1/50000 図郭の北西端（系VI）。行=北から A,B,C,... 列=西から A,B,C,...
_ROW_LETTERS = "ABCDEFGHIJKLMNOPQRST"
_COL_LETTERS = "ABCDEFGH"
_N_ORIGIN = 300_000.0   # 行 A の北端
_E_ORIGIN = -160_000.0  # 列 A の西端


def sheet_origin(sheet: str) -> tuple[float, float]:
    """1/50000 図郭コード（例 '06LC'）の北西端 (E, N) を返す。"""
    row, col = sheet[2], sheet[3]
    n = _N_ORIGIN - _ROW_LETTERS.index(row) * SHEET_H
    e = _E_ORIGIN + _COL_LETTERS.index(col) * SHEET_W
    return e, n


def _quadrant(is_south: bool, is_east: bool) -> int:
    return {(False, False): 1, (False, True): 2, (True, False): 3, (True, True): 4}[
        (is_south, is_east)
    ]


@dataclass(frozen=True)
class Tile:
    sheet: str        # '06LC'
    code: str         # '9444'
    e0: float         # 北西端 easting
    n0: float         # 北西端 northing

    @property
    def name(self) -> str:
        return f"{self.sheet}{self.code}"

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """(xmin, ymin, xmax, ymax)"""
        return (self.e0, self.n0 - TILE_H, self.e0 + TILE_W, self.n0)


def tile_at(e: float, n: float, sheets: tuple[str, ...]) -> Tile | None:
    """座標 (e, n) を含むタイルを `sheets` の中から探す。"""
    for sheet in sheets:
        se, sn = sheet_origin(sheet)
        de, dn = e - se, sn - n
        if not (0 <= de < SHEET_W and 0 <= dn < SHEET_H):
            continue
        d1 = int(dn // CELL_H)
        d2 = int(de // CELL_W)
        re_, rn = de - d2 * CELL_W, dn - d1 * CELL_H
        d3 = _quadrant(rn >= Q_H, re_ >= Q_W)
        re2 = re_ - (Q_W if re_ >= Q_W else 0.0)
        rn2 = rn - (Q_H if rn >= Q_H else 0.0)
        d4 = _quadrant(rn2 >= TILE_H, re2 >= TILE_W)
        code = f"{d1}{d2}{d3}{d4}"
        return Tile(sheet, code, *tile_origin(sheet, code))
    return None


def tile_origin(sheet: str, code: str) -> tuple[float, float]:
    """タイルコードから北西端 (E, N) を復元する。"""
    d1, d2, d3, d4 = (int(c) for c in code)
    se, sn = sheet_origin(sheet)
    e = se + d2 * CELL_W + (Q_W if d3 in (2, 4) else 0.0) + (TILE_W if d4 in (2, 4) else 0.0)
    n = sn - d1 * CELL_H - (Q_H if d3 in (3, 4) else 0.0) - (TILE_H if d4 in (3, 4) else 0.0)
    return e, n


def tiles_covering(
    xmin: float, ymin: float, xmax: float, ymax: float, sheets: tuple[str, ...]
) -> list[Tile]:
    """矩形を覆うタイルを列挙する（1/50000 図郭をまたいでも良い）。"""
    found: dict[str, Tile] = {}
    e = xmin
    while e < xmax + TILE_W:
        n = ymax
        while n > ymin - TILE_H:
            t = tile_at(min(e, xmax - 1e-6), max(n, ymin + 1e-6), sheets)
            if t is not None:
                found[t.name] = t
            n -= TILE_H
        e += TILE_W
    return sorted(found.values(), key=lambda t: (-t.n0, t.e0))
