#!/usr/bin/env bash
# 构建 js-node：官方 Node 二进制重新打包，去掉文档和头文件。
#
#   NODE_VERSION=20.20.2 BUILD_NO=1 ./build-node.sh
#
# 可选环境变量：
#   NODE_MIRROR   默认 https://npmmirror.com/mirrors/node（国内快），也可以用 https://nodejs.org/dist
#
# 产物：dist/js-node-<NODE_VERSION>-<BUILD_NO>-<platform>-<arch>.tar.gz，包内顶层是 bin/node
source "$(dirname "$0")/lib.sh"

ID=js-node
NODE_VERSION="${NODE_VERSION:-20.20.2}"
BUILD_NO="${BUILD_NO:-1}"
VERSION="$NODE_VERSION-$BUILD_NO"
MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"

FILE="node-v$NODE_VERSION-$PLATFORM-$ARCH.tar.gz"
fetch "$MIRROR/v$NODE_VERSION/$FILE" "$WORK/$FILE"

STAGE="$WORK/$ID"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$WORK/$FILE" -C "$STAGE" --strip-components=1
[[ -x "$STAGE/bin/node" ]] || die "解压后找不到 bin/node"

log "精简"
rm -rf "$STAGE/include" "$STAGE/share" "$STAGE/CHANGELOG.md" "$STAGE/README.md"
# npm 留着：用户以后要在笔记库目录里 npm install；它的文档和测试去掉
rm -rf "$STAGE/lib/node_modules/npm/docs" "$STAGE/lib/node_modules/npm/man" 2>/dev/null || true
find "$STAGE/lib/node_modules" -type d -name test -prune -exec rm -rf {} + 2>/dev/null || true
prune_common "$STAGE"

log "自检"
"$STAGE/bin/node" -e "console.log('node', process.version, 'ok'); require('node:vm').runInNewContext('1+1')"

pack "$STAGE" "$(artifact_name "$ID" "$VERSION")"
