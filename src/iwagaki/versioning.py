"""配信物の URL に内容ハッシュを入れる。

`web/deploy/_headers` は `data/tiles` と `data/3dtiles` を
`immutable, max-age=31536000` で配る。**URL に内容が反映されていないと、
データを作り直したときに immutable キャッシュを持つブラウザは古いタイルを
見続ける**（`docs/infra.md`）。入口の `catalog.json` だけは毎回再検証されるので、
**カタログが指す URL が内容ごとに変われば追従できる。**

ここは「名前を内容から決める」だけを持つ。どこに何を置くかは
`scripts/83_build_catalog.py` が決める（URL を決めているのはあの 1 か所だけ）。

ハッシュはファイルの**相対パスと中身の両方**から取る。中身だけだと
タイルが 1 枚増えても名前が変わらないことがある。
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

#: 名前に入れる長さ。1,048 枚のタイルに対して 8 桁（16^8 ≈ 43 億）で十分
HASH_LEN = 8


def dir_hash(d: Path, length: int = HASH_LEN) -> str:
    """ディレクトリの内容ハッシュ。相対パス順に並べ、パスと中身を混ぜる。"""
    h = hashlib.sha256()
    for p in sorted(x for x in d.rglob("*") if x.is_file()):
        h.update(str(p.relative_to(d)).encode())
        h.update(b"\0")
        h.update(hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()[:length]


def file_hash(p: Path, length: int = HASH_LEN) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:length]


def publish_dir(parent: Path, base: str) -> str:
    """
    `parent/base` を `parent/base-<hash>` に改名し、その名前を返す。

    - 既に `parent/base-<hash>` だけがある（= 前回の成果物）ならそれをそのまま使う
    - ハッシュ違いの古い兄弟は消す。残すと `dist` と Workers Assets に
      両方載って、転送量と枚数が増えるだけである
    - どちらも無ければ `base` を返す（そのステップを踏んでいない配信物）
    """
    fresh = parent / base
    if fresh.is_dir():
        name = f"{base}-{dir_hash(fresh)}"
        target = parent / name
        if target.is_dir():
            shutil.rmtree(target)
        fresh.rename(target)
    else:
        existing = sorted(p for p in parent.glob(f"{base}-*") if p.is_dir())
        if not existing:
            return base
        name = existing[-1].name

    for p in parent.glob(f"{base}-*"):
        if p.is_dir() and p.name != name:
            shutil.rmtree(p)
    return name


def publish_file(p: Path) -> str:
    """
    `foo.geojson` を `foo-<hash>.geojson` に改名し、その名前を返す。
    既に改名済み（`foo-<hash>.geojson` だけがある）ならそれを使う。
    """
    stem, suffix = p.stem, p.suffix
    if p.is_file():
        name = f"{stem}-{file_hash(p)}{suffix}"
        target = p.with_name(name)
        if target != p:
            target.unlink(missing_ok=True)
            p.rename(target)
    else:
        existing = sorted(p.parent.glob(f"{stem}-*{suffix}"))
        if not existing:
            return p.name
        name = existing[-1].name

    for q in p.parent.glob(f"{stem}-*{suffix}"):
        if q.name != name:
            q.unlink()
    return name
