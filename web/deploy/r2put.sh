#!/usr/bin/env bash
# 315 MB を超える COPC を R2 に上げる（wrangler r2 object put では上げられない）。
#   deploy/r2put.sh s3 cp <file> s3://<bucket>/<key>
# 認証は .env.deploy（R2 API トークン Object Read & Write）。web/ かリポジトリ直下を見る。
set -euo pipefail
cd "$(dirname "$0")/.."
ENVF=""
for c in "./.env.deploy" "$(cd .. && pwd)/.env.deploy"; do
  [ -f "$c" ] && { ENVF="$c"; break; }
done
[ -n "$ENVF" ] || { echo ".env.deploy が無い（R2 API トークンを置く）" >&2; exit 1; }
set -a; . "$ENVF"; set +a
: "${R2_ACCOUNT_ID:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION=auto
# R2 は本物の AWS ではないので、~/.aws のプロファイルが混ざらないようにする
unset AWS_PROFILE AWS_SESSION_TOKEN
exec aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" "$@"
