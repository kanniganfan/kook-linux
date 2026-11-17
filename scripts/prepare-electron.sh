#!/usr/bin/env bash
# 准备一份可打包的 Electron 运行时。
#
# 为什么需要这一步：
#   开发机上 Electron 解包目录里有个 modules/ 软链，指向 Steam 里的官方客户端
#   （.../app-0.112.0/modules，约 178MB，装的是 kook-windows-helper 之类的原生模块）。
#   打包时如果原样带上这个软链，装到别人机器上那个路径根本不存在，
#   客户端加载原生模块会直接失败。所以这里把软链解引用成真实目录。
#
# 做法用硬链接（cp -al），不额外占空间，几百 MB 也是秒完成。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ELECTRON_SRC:-$HOME/kook-port/e36/node_modules/electron/dist}"
DEST="$ROOT/.electron-dist"

if [ ! -d "$SRC" ]; then
  echo "找不到 Electron 运行时：$SRC" >&2
  echo "用 ELECTRON_SRC 指定解包后的 electron/dist 目录。" >&2
  exit 1
fi

if [ -x "$DEST/electron" ] && [ -d "$DEST/modules" ] && [ ! -L "$DEST/modules" ]; then
  echo "==> Electron 运行时已就绪（复用）：$DEST"
  exit 0
fi

echo "==> 复制 Electron 运行时（硬链接）：$SRC"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -al "$SRC/." "$DEST/" 2>/dev/null || cp -a "$SRC/." "$DEST/"

if [ -L "$DEST/modules" ]; then
  TARGET="$(readlink -f "$DEST/modules" || true)"
  echo "==> modules 是软链 -> $TARGET"
  rm -f "$DEST/modules"
  if [ -n "$TARGET" ] && [ -d "$TARGET" ]; then
    cp -al "$TARGET" "$DEST/modules" 2>/dev/null || cp -a "$TARGET" "$DEST/modules"
    echo "    已解引用为真实目录（$(du -sh "$DEST/modules" | cut -f1)）"
  else
    mkdir -p "$DEST/modules"
    echo "    警告：软链目标不存在，先建了空目录" >&2
  fi
fi

echo "==> 完成：$(du -sh "$DEST" | cut -f1) -> $DEST"
