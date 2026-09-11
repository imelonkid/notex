#!/usr/bin/env bash
# 三个构建脚本共用的小工具：平台架构判定、下载、校验、打包。
# 用法：source "$(dirname "$0")/lib.sh"

set -euo pipefail

RT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${DIST:-$RT_ROOT/dist}"
WORK="${WORK:-$RT_ROOT/.work}"
mkdir -p "$DIST" "$WORK"

# 与 catalog.json 的 platform / arch 字段一致
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  *) echo "不支持的系统：$(uname -s)" >&2; exit 1 ;;
esac
case "${ARCH_OVERRIDE:-$(uname -m)}" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

log() { printf '\033[1;34m▸\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 下载到指定文件；已存在就跳过（CI 里可以缓存 .work）。支持通过 HTTP_PROXY 走代理
fetch() {
  local url="$1" out="$2"
  if [[ -s "$out" ]]; then log "已有 $(basename "$out")，跳过下载"; return; fi
  log "下载 $url"
  curl -fL --retry 3 --retry-delay 2 -C - -o "$out.part" "$url"
  mv "$out.part" "$out"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# 把目录打成 tar.gz，包内顶层直接是 bin/…，不套外层目录
pack() {
  local dir="$1" out="$2"
  rm -f "$out"
  # --no-xattrs 去掉 macOS 的扩展属性，避免解压时一堆 ._ 文件；COPYFILE_DISABLE 同理
  ( cd "$dir" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out" . 2>/dev/null || COPYFILE_DISABLE=1 tar -czf "$out" . )
  log "打包完成 $(basename "$out") $(du -h "$out" | cut -f1) sha256=$(sha256_of "$out")"
}

# 包名：<id>-<version>-<platform>-<arch>.tar.gz，make-catalog.mjs 按这个解析
artifact_name() {
  local id="$1" version="$2"
  echo "$DIST/$id-$version-$PLATFORM-$ARCH.tar.gz"
}

# 删掉会把包撑大又没人用的东西
prune_common() {
  local dir="$1"
  find "$dir" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$dir" -name '*.pyc' -delete 2>/dev/null || true
  find "$dir" -name '.DS_Store' -delete 2>/dev/null || true
}
