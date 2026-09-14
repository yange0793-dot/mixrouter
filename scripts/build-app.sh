#!/bin/bash
# 构建 Mixrouter.app —— 原生 macOS 外壳(AppKit + WKWebView 包住本地控制台)。
#
#   scripts/build-app.sh
#
# 只依赖 CommandLineTools 里的 swiftc(本机 macOS 13 + CLT,无完整 Xcode),
# 不装任何依赖、不联网。产物写到 ~/Applications/Mixrouter.app,可反复执行(幂等)。
#
# 仓库根会被烘进 Info.plist 的 MixrouterRepoRoot(应用要靠它跑 ./mixctl start 和打开 logs/)。
# 解析顺序:MIXROUTER_REPO 环境变量 > 本脚本所在仓库。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$SRC_ROOT/app"
SOURCE="$APP_DIR/MixrouterApp.swift"
ICON="$APP_DIR/appicon.icns"
APP_BUNDLE="${MIXROUTER_APP_BUNDLE:-$HOME/Applications/Mixrouter.app}"
BUNDLE_ID="com.tufu.mixrouter.app"
VERSION="2.0"

# ---- 仓库根 ----------------------------------------------------------------
REPO_ROOT="${MIXROUTER_REPO:-$SRC_ROOT}"
[ -x "$REPO_ROOT/mixctl" ] || { echo "× $REPO_ROOT 里没有可执行的 mixctl,仓库根不对" >&2; exit 1; }

# ---- 目标架构(默认本机)----------------------------------------------------
ARCH="${MIXROUTER_ARCH:-$(uname -m)}"
TARGET="$ARCH-apple-macos11.0"

echo "==> 编译 $SOURCE"
echo "    仓库根   $REPO_ROOT"
echo "    目标     $TARGET"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mixrouter-app.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

# -parse-as-library:swiftc 单文件里用 @main 入口,不能让顶层代码被当成 main.swift
swiftc -O -parse-as-library \
  -target "$TARGET" \
  -framework AppKit -framework WebKit \
  -o "$BUILD_DIR/Mixrouter" \
  "$SOURCE"

# ---- 组装 bundle -----------------------------------------------------------
# 先停下旧实例(不这样 open 只会把老进程顶到前面,新的编了也看不到效果)。
# 只按 bundle 内的可执行文件全路径匹配,绝不误伤 node 起的 mixrouter 服务进程。
if pgrep -f "$APP_BUNDLE/Contents/MacOS/Mixrouter" >/dev/null 2>&1; then
  echo "==> 退出正在运行的旧实例"
  pkill -f "$APP_BUNDLE/Contents/MacOS/Mixrouter" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP_BUNDLE/Contents/MacOS/Mixrouter" >/dev/null 2>&1 || break
    sleep 0.2
  done
fi

echo "==> 组装 $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

install -m 755 "$BUILD_DIR/Mixrouter" "$APP_BUNDLE/Contents/MacOS/Mixrouter"
install -m 644 "$ICON" "$APP_BUNDLE/Contents/Resources/appicon.icns"

cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Mixrouter</string>
  <key>CFBundleDisplayName</key><string>Mixrouter</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>Mixrouter</string>
  <key>CFBundleIconFile</key><string>appicon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 控制台走 http://127.0.0.1:8788,ATS 必须放行本地网络,否则 WKWebView 直接白屏 -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <!-- 应用靠它找 mixctl / logs/,由本脚本烘入;运行时可被 MIXROUTER_REPO 覆盖 -->
  <key>MixrouterRepoRoot</key><string>$REPO_ROOT</string>
</dict>
</plist>
PLIST

plutil -lint "$APP_BUNDLE/Contents/Info.plist" >/dev/null

echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP_BUNDLE" 2>&1 | sed 's/^/    /'
codesign --verify --deep --strict "$APP_BUNDLE" 2>&1 | sed 's/^/    /' || true

echo
echo "完成:$APP_BUNDLE"
echo "  open \"$APP_BUNDLE\""
