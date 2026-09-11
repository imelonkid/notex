#!/usr/bin/env bash
# 构建 python-sci：python-build-standalone 加一组钉死版本的科学计算包。
#
#   PY_VERSION=3.12.14 PBS_TAG=20260901 BUILD_NO=1 ./build-python.sh
#
# 可选环境变量：
#   PBS_MIRROR      python-build-standalone 的镜像前缀（国内构建时用），默认走 GitHub Releases
#   PIP_INDEX_URL   pip 镜像，例如 https://pypi.tuna.tsinghua.edu.cn/simple
#   PIP_PACKAGES    覆盖 requirements.txt，空格分隔，调试脚本时用
#
# 产物：dist/python-sci-<PY_VERSION>-<BUILD_NO>-<platform>-<arch>.tar.gz，包内顶层是 bin/python3
source "$(dirname "$0")/lib.sh"

ID=python-sci
PY_VERSION="${PY_VERSION:-3.12.14}"
PBS_TAG="${PBS_TAG:-20260901}"
BUILD_NO="${BUILD_NO:-1}"
VERSION="$PY_VERSION-$BUILD_NO"

case "$PLATFORM-$ARCH" in
  darwin-arm64) TRIPLE=aarch64-apple-darwin ;;
  darwin-x64) TRIPLE=x86_64-apple-darwin ;;
  linux-x64) TRIPLE=x86_64-unknown-linux-gnu ;;
  linux-arm64) TRIPLE=aarch64-unknown-linux-gnu ;;
  *) die "python-build-standalone 没有 $PLATFORM-$ARCH 的构建" ;;
esac

FILE="cpython-$PY_VERSION+$PBS_TAG-$TRIPLE-install_only.tar.gz"
BASE="${PBS_MIRROR:-https://github.com/astral-sh/python-build-standalone/releases/download}"
fetch "$BASE/$PBS_TAG/$FILE" "$WORK/$FILE"

STAGE="$WORK/$ID"
rm -rf "$STAGE"; mkdir -p "$STAGE"
# install_only 包解压出来是 python/，剥掉这一层
tar -xzf "$WORK/$FILE" -C "$STAGE" --strip-components=1
PY="$STAGE/bin/python3"
[[ -x "$PY" ]] || die "解压后找不到 bin/python3"

log "安装依赖包"
export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
"$PY" -m pip install --quiet --upgrade pip
if [[ -n "${PIP_PACKAGES:-}" ]]; then
  # shellcheck disable=SC2086
  "$PY" -m pip install --quiet $PIP_PACKAGES
else
  "$PY" -m pip install --quiet -r "$RT_ROOT/python-sci/requirements.txt"
fi

log "精简"
prune_common "$STAGE"
rm -rf "$STAGE/lib/python3."*/test "$STAGE/lib/python3."*/idlelib "$STAGE/lib/python3."*/tkinter \
       "$STAGE/lib/python3."*/turtledemo "$STAGE/share" "$STAGE/lib/tcl"* "$STAGE/lib/tk"* \
       "$STAGE/lib/python3."*/site-packages/pip/_vendor/*/tests 2>/dev/null || true
# pip 装出来的命令行脚本 shebang 写的是构建机的绝对路径，搬到用户机器上就是坏的；
# 用户只需要 python3 -m xxx，脚本一律去掉
find "$STAGE/bin" -type f ! -name 'python*' -exec sh -c 'head -c 2 "$1" | grep -q "#!" && rm -f "$1"' _ {} \; 2>/dev/null || true

log "自检：隔离模式下导入全部包"
"$PY" -I -c "
import sys, importlib, re
specs = '${PIP_PACKAGES:-}'.split() or [l.strip() for l in open('$RT_ROOT/python-sci/requirements.txt') if l.strip() and not l.startswith('#')]
# 去掉版本限定，只留包名：jedi==0.19.2 → jedi
mods = [re.split(r'[=<>!~\[;]', s)[0].strip() for s in specs]
names = {'pillow': 'PIL'}
for m in mods:
    importlib.import_module(names.get(m, m))
print('python', sys.version.split()[0], 'ok:', ', '.join(mods))
"
if "$PY" -I -c "import matplotlib" 2>/dev/null; then
  MPLCONFIGDIR="$WORK/mpl" "$PY" -I -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as p; p.plot([1,2]); p.savefig('$WORK/smoke.png'); print('matplotlib Agg ok')"
fi

pack "$STAGE" "$(artifact_name "$ID" "$VERSION")"
