#!/usr/bin/env bash
# 把 dist/ 里的包和 catalog.json 发到阿里云 OSS 与码云 Release。
#
#   TAG=v1 ./publish.sh
#
# 需要的环境变量：
#   OSS_BUCKET, OSS_ENDPOINT          例如 notex-runtimes / oss-cn-hangzhou.aliyuncs.com
#   OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET
#   GITEE_OWNER, GITEE_REPO, GITEE_TOKEN   码云仓库与私人令牌（需要 projects 权限）
#   TAG                                Release 的 tag，默认 v1；同一个 tag 反复发就是覆盖附件
#   OSS_PREFIX                         桶内前缀，默认 v1
#
# 两处都传是为了下载地址有备份：清单里 OSS 排第一，码云第二。
# 只想传一处就把另一处的变量留空，脚本会跳过。
set -euo pipefail
cd "$(dirname "$0")"

DIST="${DIST:-dist}"
TAG="${TAG:-v1}"
OSS_PREFIX="${OSS_PREFIX:-v1}"
[[ -f "$DIST/catalog.json" ]] || { echo "先运行 make-catalog.mjs 生成 $DIST/catalog.json" >&2; exit 1; }

log() { printf '\033[1;34m▸\033[0m %s\n' "$*" >&2; }

# ---- 阿里云 OSS ----
if [[ -n "${OSS_BUCKET:-}" ]]; then
  # ossutil 2.x（aliyun 官方，brew install ossutil）；1.x 叫 ossutil64，参数略有不同
  if command -v ossutil >/dev/null 2>&1; then OSS=ossutil; elif command -v ossutil64 >/dev/null 2>&1; then OSS=ossutil64; else
    echo "没有 ossutil，安装：brew install ossutil 或 https://help.aliyun.com/zh/oss/developer-reference/ossutil" >&2; exit 1; fi
  export OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
  log "上传到 oss://$OSS_BUCKET/$OSS_PREFIX/"
  for f in "$DIST"/*.tar.gz "$DIST"/catalog.json; do
    "$OSS" cp -f "$f" "oss://$OSS_BUCKET/$OSS_PREFIX/$(basename "$f")" -e "${OSS_ENDPOINT:-oss-cn-hangzhou.aliyuncs.com}" \
      -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" >/dev/null
    log "  ✓ $(basename "$f")"
  done
  # 清单要能被浏览器直接 fetch，桶的 CORS 规则里允许 GET，见 README
else
  log "OSS_BUCKET 未设置，跳过 OSS"
fi

# ---- 码云 Release ----
if [[ -n "${GITEE_TOKEN:-}" ]]; then
  API="https://gitee.com/api/v5/repos/$GITEE_OWNER/$GITEE_REPO/releases"
  log "查找码云 Release $TAG"
  RELEASE_ID="$(curl -fsS "$API/tags/$TAG?access_token=$GITEE_TOKEN" 2>/dev/null | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1 || true)"
  if [[ -z "$RELEASE_ID" ]]; then
    log "创建 Release $TAG"
    RELEASE_ID="$(curl -fsS -X POST "$API" \
      -d "access_token=$GITEE_TOKEN" -d "tag_name=$TAG" -d "name=运行时 $TAG" \
      -d "body=NoteX 内置运行时包，清单见 catalog.json" -d "target_commitish=main" \
      | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
  fi
  [[ -n "$RELEASE_ID" ]] || { echo "拿不到 Release id" >&2; exit 1; }
  # 同名附件先删再传，码云不允许重名
  EXISTING="$(curl -fsS "$API/$RELEASE_ID/attach_files?access_token=$GITEE_TOKEN&per_page=100")"
  for f in "$DIST"/*.tar.gz "$DIST"/catalog.json; do
    name="$(basename "$f")"
    # 码云免费版单附件上限 100 MB。完整科学计算环境可能超过这个值，
    # 此时保留清单里的码云候选地址供客户端自动回退，但不让整个发布任务失败。
    size="$(wc -c < "$f" | tr -d ' ')"
    if (( size > 100 * 1024 * 1024 )); then
      log "  - 跳过 $name（超过码云 100 MB 附件上限）"
      continue
    fi
    old_id="$(echo "$EXISTING" | tr '{' '\n' | grep "\"name\":\"$name\"" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1 || true)"
    if [[ -n "$old_id" ]]; then
      curl -fsS -X DELETE "$API/$RELEASE_ID/attach_files/$old_id?access_token=$GITEE_TOKEN" >/dev/null
    fi
    curl -fsS -X POST "$API/$RELEASE_ID/attach_files" -F "access_token=$GITEE_TOKEN" -F "file=@$f" >/dev/null
    log "  ✓ $name"
  done
  log "码云下载前缀：https://gitee.com/$GITEE_OWNER/$GITEE_REPO/releases/download/$TAG"
else
  log "GITEE_TOKEN 未设置，跳过码云"
fi
