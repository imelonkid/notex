#!/usr/bin/env bash
# 构建 java-jdk：用 jlink 从 Temurin JDK 裁一个只含 JShell 所需模块的镜像。
#
#   JAVA_MAJOR=17 BUILD_NO=1 ./build-java.sh
#
# 可选环境变量：
#   JDK_HOME     直接用本机已有的 JDK（含 bin/jlink），不下载
#   JDK_URL      指定 JDK 压缩包地址（国内可用清华镜像 https://mirrors.tuna.tsinghua.edu.cn/Adoptium/）
#                不指定时走 Adoptium API 的 latest
#
# 产物：dist/java-jdk-<版本>-<BUILD_NO>-<platform>-<arch>.tar.gz，包内顶层是 bin/java
source "$(dirname "$0")/lib.sh"

ID=java-jdk
JAVA_MAJOR="${JAVA_MAJOR:-17}"
BUILD_NO="${BUILD_NO:-1}"

if [[ -z "${JDK_HOME:-}" ]]; then
  case "$PLATFORM-$ARCH" in
    darwin-arm64) OS=mac; A=aarch64 ;;
    darwin-x64) OS=mac; A=x64 ;;
    linux-x64) OS=linux; A=x64 ;;
    linux-arm64) OS=linux; A=aarch64 ;;
    *) die "不支持 $PLATFORM-$ARCH" ;;
  esac
  URL="${JDK_URL:-https://api.adoptium.net/v3/binary/latest/$JAVA_MAJOR/ga/$OS/$A/jdk/hotspot/normal/eclipse}"
  fetch "$URL" "$WORK/temurin-$JAVA_MAJOR-$OS-$A.tar.gz"
  rm -rf "$WORK/jdk"; mkdir -p "$WORK/jdk"
  tar -xzf "$WORK/temurin-$JAVA_MAJOR-$OS-$A.tar.gz" -C "$WORK/jdk" --strip-components=1
  if [[ -d "$WORK/jdk/Contents/Home" ]]; then JDK_HOME="$WORK/jdk/Contents/Home"; else JDK_HOME="$WORK/jdk"; fi
fi
[[ -x "$JDK_HOME/bin/jlink" ]] || die "$JDK_HOME 里没有 jlink，必须是 JDK"

JAVA_VERSION="$(sed -n 's/^JAVA_VERSION="\(.*\)"/\1/p' "$JDK_HOME/release")"
[[ -n "$JAVA_VERSION" ]] || die "读不到 $JDK_HOME/release 里的版本"
VERSION="$JAVA_VERSION-$BUILD_NO"

# 内核需要：jshell（远端执行走 jdi）、compiler（源码启动器与 jshell 编译）、desktop（BufferedImage 出图）、
# unsupported（内核用 sun.misc.Signal 接 SIGINT）、localedata 与 charsets（中文日期与 GBK）；
# 其余是用户代码常用的标准库模块。jlink 会自动带上传递依赖。
MODULES=java.base,java.desktop,java.logging,java.management,java.net.http,java.sql,java.xml,java.naming,java.prefs,java.scripting,java.compiler,java.instrument,jdk.jshell,jdk.compiler,jdk.unsupported,jdk.zipfs,jdk.crypto.ec,jdk.localedata,jdk.charsets,jdk.httpserver,jdk.net,jdk.management

STAGE="$WORK/$ID"
rm -rf "$STAGE"
log "jlink $MODULES"
"$JDK_HOME/bin/jlink" --add-modules "$MODULES" --strip-debug --no-man-pages --no-header-files --compress=2 --output "$STAGE"

log "自检"
"$STAGE/bin/java" --list-modules | grep -q '^jdk.jshell' || die "镜像里没有 jdk.jshell"
"$STAGE/bin/java" -Djava.awt.headless=true -version 2>&1 | head -1
# 源码启动器要能编译并跑一个用到 jshell 与 awt 的小程序，这是内核的启动方式
cat > "$WORK/Probe.java" <<'EOF'
public class Probe {
    public static void main(String[] a) throws Exception {
        var sh = jdk.jshell.JShell.create();
        var im = new java.awt.image.BufferedImage(2, 2, java.awt.image.BufferedImage.TYPE_INT_RGB);
        System.out.println("jshell+awt ok " + sh.eval("1+1").get(0).value() + " " + im.getWidth());
        sh.close();
    }
}
EOF
"$STAGE/bin/java" -Djava.awt.headless=true "$WORK/Probe.java"

prune_common "$STAGE"
pack "$STAGE" "$(artifact_name "$ID" "$VERSION")"
