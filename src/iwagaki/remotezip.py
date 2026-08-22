"""HTTP Range で リモート zip の一部だけを読む。

京都府DEMの図郭zipは 3.7〜10.7 GB あるが、必要なのは数枚のタイルだけ。
zip の central directory を読んでから、対象メンバーのバイト範囲だけ取得する。
"""
from __future__ import annotations

import io
import urllib.request
import zipfile
from collections.abc import Iterator

_UA = "iwagaki/0.1 (+https://github.com/masatomoty/iwagaki)"


def resolve_redirect(url: str) -> str:
    """CKAN の署名付きリダイレクトを解決する（S3直リンクはそのまま返る）。"""
    req = urllib.request.Request(url, headers={"User-Agent": _UA}, method="GET")
    req.add_header("Range", "bytes=0-0")
    with urllib.request.urlopen(req) as r:
        return r.url


class RangeReader(io.RawIOBase):
    """Range リクエストでランダムアクセスするシーク可能ファイル。"""

    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        req = urllib.request.Request(
            url, headers={"User-Agent": _UA, "Range": "bytes=0-0"}
        )
        with urllib.request.urlopen(req) as r:
            cr = r.headers.get("Content-Range")
            if not cr:
                raise RuntimeError(f"server does not support Range requests: {url}")
            self.size = int(cr.split("/")[1])
            self.url = r.url  # リダイレクト後のURLを使い回す

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = (
            off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        )
        return self.pos

    def tell(self) -> int:
        return self.pos

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = self.size - self.pos
        if n <= 0:
            return b""
        end = min(self.pos + n, self.size) - 1
        if end < self.pos:
            return b""
        req = urllib.request.Request(
            self.url, headers={"User-Agent": _UA, "Range": f"bytes={self.pos}-{end}"}
        )
        with urllib.request.urlopen(req) as r:
            data = r.read()
        self.pos += len(data)
        return data

    def readinto(self, b) -> int:  # BufferedReader が使う
        d = self.read(len(b))
        b[: len(d)] = d
        return len(d)


def open_remote_zip(url: str, buffer_size: int = 1 << 20) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BufferedReader(RangeReader(url), buffer_size=buffer_size))


def iter_member_lines(zf: zipfile.ZipFile, member: str, chunk: int = 1 << 22) -> Iterator[bytes]:
    """巨大メンバーをストリーム展開する（全体をメモリに載せない）。"""
    with zf.open(member) as f:
        while True:
            data = f.read(chunk)
            if not data:
                return
            yield data
