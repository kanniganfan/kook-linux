#!/usr/bin/env bash
# 直接调 rpmbuild 打 rpm，绕开 electron-builder 内部的 fpm。
#
# 为什么不用 fpm：它生成的 spec 在 rpm 6.x 上跑不通（rpmbuild 直接 exit 1，
# 而且错误被 fpm 吞掉看不见）。既然本机已经有可用的 rpmbuild，就自己写 spec，
# 依赖、路径、权限全都明明白白。
#
# 前置：bash scripts/build.sh AppImage deb 先跑过一次，dist/linux-unpacked 已生成。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNPACKED="$ROOT/dist/linux-unpacked"
OUT="$ROOT/dist"
VERSION="$(node -p "require('$ROOT/package.json').version")"
# 元信息统一从 package.json 取，避免 spec 里再写一遍硬编码的占位地址
PKG_URL="$(node -p "require('$ROOT/package.json').homepage || ''")"
PKG_LICENSE="$(node -p "require('$ROOT/package.json').license || 'MIT'")"

if [ ! -x "$UNPACKED/kook-linux" ]; then
  echo "缺少 $UNPACKED，请先执行：bash scripts/build.sh AppImage deb" >&2
  exit 1
fi

RPMBUILD="$(command -v rpmbuild || true)"
if [ -z "$RPMBUILD" ] && [ -x "$HOME/.local/rpm-tools/bin/rpmbuild" ]; then
  RPMBUILD="$HOME/.local/rpm-tools/bin/rpmbuild"
  export LD_LIBRARY_PATH="$HOME/.local/rpm-tools/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export RPM_CONFIGDIR="$HOME/.local/rpm-tools/lib/rpm"
  export PATH="$HOME/.local/rpm-tools/bin:$PATH"
fi
if [ -z "$RPMBUILD" ]; then
  echo "找不到 rpmbuild。Debian/Ubuntu: apt install rpm；Arch: bash scripts/fetch-rpm-tools.sh" >&2
  exit 1
fi
echo "==> rpmbuild: $("$RPMBUILD" --version 2>/dev/null | head -1)"

TOP="$ROOT/.rpmbuild"
rm -rf "$TOP"
mkdir -p "$TOP"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}

echo "==> 准备源目录"
SRC="$TOP/sources"
mkdir -p "$SRC/icons"
cp -a "$ROOT/build/kook-linux.desktop" "$SRC/"
cp -a "$ROOT/build/icons/." "$SRC/icons/"
# 用硬链接代替复制：300MB+ 的目录 cp -a 每次要半分钟，硬链接秒过。
# 跨文件系统时自动退回复制。
cp -al "$UNPACKED" "$SRC/app" 2>/dev/null || cp -a "$UNPACKED" "$SRC/app"

sed -e "s|__VERSION__|$VERSION|g" -e "s|__URL__|$PKG_URL|g" -e "s|__LICENSE__|$PKG_LICENSE|g" \
  "$ROOT/build/kook.spec.in" > "$TOP/SPECS/kook.spec"

echo "==> rpmbuild -bb"
"$RPMBUILD" -bb \
  --define "_topdir $TOP" \
  --define "_sourcedir $SRC" \
  --define "_buildrootdir $TOP/BUILDROOT" \
  --define "__os_install_post %{nil}" \
  --define "debug_package %{nil}" \
  --target x86_64 \
  "$TOP/SPECS/kook.spec"

RPM_FILE="$(find "$TOP/RPMS" -name '*.rpm' | head -1)"
if [ -z "$RPM_FILE" ]; then
  echo "rpmbuild 没有产出 rpm" >&2
  exit 1
fi

cp -a "$RPM_FILE" "$OUT/kook-linux-$VERSION.x86_64.rpm"
echo
echo "==> 已生成："
ls -lh "$OUT/kook-linux-$VERSION.x86_64.rpm"
