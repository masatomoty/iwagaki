#!/usr/bin/env bash
# README / docs に書いた出典リンクが実際に到達するか確かめる。
# 「出典を書いた」と「出典に行ける」は別なので、実際に叩く。
set -uo pipefail
for u in "$@"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 "$u" || echo "ERR")
  printf '%-4s %s\n' "$code" "$u"
done
