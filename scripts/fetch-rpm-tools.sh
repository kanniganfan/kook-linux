#!/usr/bin/env bash
# 准备本地 rpmbuild（没有 root、系统又没装 rpm 时用）。
#
# 背景：electron-builder 打 rpm 需要可执行的 rpmbuild。Arch / CachyOS 这类
# 发行版默认不带它，Ubuntu/Fedora 用户直接 apt/dnf install rpm 就行。
# 这里从 Arch 官方仓库取二进制包，解到 ~/.local/rpm-tools，不改系统。
#
# 用法：bash scripts/fetch-rpm-tools.sh
set -euo pipefail

DEST="${RPM_TOOLS_DIR:-$HOME/.local/rpm-tools}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DEST/bin" "$DEST/lib"

fetch() {
  local url="$1" out="$2"
  echo "    下载 $url"
  # --compressed 必须加：不加会拿到 gzip 过的响应体，文件是坏的
  curl -sL --compressed -o "$out" "$url" --max-time 180
}

# rpm-tools：提供 rpmbuild。librpm_sequoia 依赖旧 ABI 的 nettle(8)/hogweed(6)，
# 所以 nettle 单独从归档里取 3.9.1（新版的 .so.9/.7 符号版本对不上）。
echo "==> 取 rpm-tools"
fetch "https://archlinux.org/packages/extra/x86_64/rpm-tools/download/" "$TMP/rpm-tools.pkg.tar.zst"
mkdir -p "$TMP/rpm" && tar --zstd -xf "$TMP/rpm-tools.pkg.tar.zst" -C "$TMP/rpm"

echo "==> 取 rpm-sequoia"
fetch "https://archlinux.org/packages/extra/x86_64/rpm-sequoia/download/" "$TMP/rpm-sequoia.pkg.tar.zst"
mkdir -p "$TMP/seq" && tar --zstd -xf "$TMP/rpm-sequoia.pkg.tar.zst" -C "$TMP/seq"

echo "==> 取 nettle 3.9.1（旧 ABI）"
fetch "https://archive.archlinux.org/packages/n/nettle/nettle-3.9.1-1-x86_64.pkg.tar.zst" "$TMP/nettle.pkg.tar.zst"
mkdir -p "$TMP/nettle" && tar --zstd -xf "$TMP/nettle.pkg.tar.zst" -C "$TMP/nettle"

cp -a "$TMP/rpm/usr/bin/." "$DEST/bin/" 2>/dev/null || true
cp -a "$TMP/rpm/usr/lib/"*.so* "$DEST/lib/" 2>/dev/null || true
cp -a "$TMP/seq/usr/lib/"*.so* "$DEST/lib/" 2>/dev/null || true
cp -a "$TMP/nettle/usr/lib/libnettle.so.8"* "$TMP/nettle/usr/lib/libhogweed.so.6"* "$DEST/lib/" 2>/dev/null || true
chmod +x "$DEST/bin/"* 2>/dev/null || true

# rpmbuild 启动时会读 /usr/lib/rpm/rpmrc，没装 rpm 系统包的机器上没有这个目录，
# 直接把包里自带的配置目录放到本地，再用 RPM_CONFIGDIR 指过去。
cp -a "$TMP/rpm/usr/lib/rpm" "$DEST/lib/" 2>/dev/null || true

echo
echo "==> 验证"
if RPM_CONFIGDIR="$DEST/lib/rpm" LD_LIBRARY_PATH="$DEST/lib" "$DEST/bin/rpmbuild" --version; then
  echo "可用：$DEST"
  echo "build.sh 会自动把 $DEST/bin 加进 PATH。"
else
  echo "rpmbuild 仍不可用，检查缺库：" >&2
  LD_LIBRARY_PATH="$DEST/lib" ldd "$DEST/bin/rpmbuild" | grep 'not found' || true
  exit 1
fi
