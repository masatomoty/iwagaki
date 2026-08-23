#!/usr/bin/env bash
# viewer + 生成済みアセットを Cloudflare に載せる。
#   静的アセット -> Workers Assets（dist/ をそのまま）
#   COPC        -> R2（Range 206 が要るため。docs/platform.md）
#
# 前提: `npx wrangler login` 済み。scripts/build_web.sh でアセットが生成済み。
#
#   deploy/deploy.sh                 build -> R2 へ COPC -> deploy
#   deploy/deploy.sh --no-build      dist/ を作り直さない
#   deploy/deploy.sh --skip-r2       COPC を上げ直さない（アセットだけ更新する時）
#   deploy/deploy.sh --dry-run       設定と bundle の検証だけ。Cloudflare に何も作らない
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="${WRANGLER:-./node_modules/.bin/wrangler}"
# wrangler r2 object put の上限（Cloudflare docs: 315 MB）。これを超えたら S3 API 経路に回す
WRANGLER_PUT_LIMIT="${WRANGLER_PUT_LIMIT:-330000000}"
BUILD=1
UPLOAD_R2=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --skip-r2)  UPLOAD_R2=0 ;;
    --dry-run)  DRY_RUN=1; UPLOAD_R2=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -x "$WRANGLER" ] || { echo "wrangler が無い。web/ で npm install を実行する" >&2; exit 1; }

# バケット名は wrangler.jsonc を単一の出所にする（二重管理して食い違うのを避ける）
BUCKET="$(grep -o '"bucket_name"[[:space:]]*:[[:space:]]*"[^"]*"' wrangler.jsonc | head -1 | cut -d'"' -f4)"
[ -n "$BUCKET" ] || { echo "wrangler.jsonc から bucket_name を読めない" >&2; exit 1; }

if [ "$DRY_RUN" -eq 0 ]; then
  "$WRANGLER" whoami >/dev/null 2>&1 || { echo "未ログイン。'npx wrangler login' を実行する" >&2; exit 1; }
fi

if [ "$BUILD" -eq 1 ]; then
  echo "==> vite build"
  npm run build
fi
[ -d dist ] || { echo "dist/ が無い。--no-build を外すか npm run build を実行する" >&2; exit 1; }

# 点群が dist に無い = scripts/build_web.sh が未実行。気づかず「点群だけ出ない」配信になる
shopt -s nullglob
COPC_FILES=(dist/data/pointcloud/*.copc.laz)
shopt -u nullglob
if [ "${#COPC_FILES[@]}" -eq 0 ]; then
  echo "警告: dist/data/pointcloud/*.copc.laz が無い。scripts/build_web.sh を先に実行する" >&2
fi

if [ "$UPLOAD_R2" -eq 1 ]; then
  if ! "$WRANGLER" r2 bucket info "$BUCKET" >/dev/null 2>&1; then
    echo "==> R2 バケット作成: $BUCKET (apac)"
    "$WRANGLER" r2 bucket create "$BUCKET" --location apac
  fi
  for f in "${COPC_FILES[@]}"; do
    key="data/pointcloud/$(basename "$f")"   # キーは URL パスと 1:1（deploy/worker.js と同じ規則）
    size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
    echo "==> R2 put $BUCKET/$key  ($(du -h "$f" | cut -f1))"

    # wrangler r2 object put は 315 MB までしか扱えない。
    # https://developers.cloudflare.com/r2/objects/upload-objects/
    #   "Wrangler supports uploading files up to 315 MB and only allows one object at a time."
    #   "For large files or bulk uploads, use rclone or another S3-compatible tool."
    # 実際に 490 MB の COPC を上げようとして、R2 に 277 MB の壊れたオブジェクト
    # （先頭 1 KB が全ゼロ、LASF 無し）が残った。**黙って壊れる**ので必ず分岐する。
    if [ "$size" -gt "$WRANGLER_PUT_LIMIT" ]; then
      echo "    $size バイト > ${WRANGLER_PUT_LIMIT} — wrangler では上げられないので S3 API (multipart) を使う"
      command -v aws >/dev/null || { echo "aws CLI が無い。rclone 等でも可" >&2; exit 1; }
      # 認証は deploy/r2put.sh が .env.deploy から読む。aws CLI は 8 MB 超を自動で multipart にする。
      # 実測 1 MB/s 程度しか出ないので 490 MB で 8 分ほどかかる。途中で止めても
      # aws CLI が multipart を abort するので、壊れたオブジェクトは残らない。
      deploy/r2put.sh s3 cp "$f" "s3://$BUCKET/$key" \
        --content-type application/octet-stream --only-show-errors
    else
      "$WRANGLER" r2 object put "$BUCKET/$key" --file "$f" \
        --remote --content-type application/octet-stream
    fi

    # 上げたものが本当に読めるか確認する。壊れた put を検知できずに deploy まで進むと、
    # viewer が壊れたオブジェクトを指す（実際に 277 MB の全ゼロオブジェクトで起きた）。
    # サイズと先頭 4 バイトの両方を見る。片方だけでは足りない：
    #   - サイズだけ → 中身が全ゼロでも通る
    #   - 先頭だけ   → 途中で切れていても通る
    tmp="$(mktemp)"
    if deploy/r2put.sh s3api get-object --bucket "$BUCKET" --key "$key" \
         --range bytes=0-3 "$tmp" >/dev/null 2>&1; then
      head4=$(head -c 4 "$tmp")
    else
      head4="(取得失敗)"
    fi
    rm -f "$tmp"
    remote_size=$(deploy/r2put.sh s3api head-object --bucket "$BUCKET" --key "$key" \
                    --query ContentLength --output text 2>/dev/null || echo "?")
    if [ "$head4" != "LASF" ] || [ "$remote_size" != "$size" ]; then
      echo "    検証失敗: 先頭4B='$head4'（期待 LASF）, サイズ=$remote_size（期待 $size）。中断する" >&2
      exit 1
    fi
    echo "    OK: 先頭 4 バイト = LASF, サイズ = $remote_size"
  done
fi

# Workers Assets 側の設定はアセットディレクトリの中に置く決まりなので、deploy 直前にコピーする
cp deploy/_headers dist/_headers
cp deploy/assetsignore dist/.assetsignore

echo "==> wrangler deploy"
if [ "$DRY_RUN" -eq 1 ]; then
  "$WRANGLER" deploy --dry-run
  echo
  echo "dry-run 完了。実際に配信するには --dry-run を外す"
  exit 0
fi
"$WRANGLER" deploy

echo
echo "==> 配信の検証: node deploy/check.mjs <デプロイされた URL>"
