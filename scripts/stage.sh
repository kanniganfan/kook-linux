#!/usr/bin/env bash
# 把「官方客户端本体 + 移植层补丁」组装成可打包的 app 目录。
#
# 为什么不在仓库里放官方文件：
#   官方客户端的 src/、webapp/、node_modules/ 都是有版权的产物，
#   仓库里只保留我们自己写的移植层（patches/），构建时从本机已安装的
#   KOOK 客户端目录里取基础文件，拼在一起。
#
# 基础文件来源（按优先级）：
#   1. $KOOK_BASE_APP 指定的目录
#   2. $KOOK_WORK/linux/app（开发机上的解包目录）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KOOK_WORK="${KOOK_WORK:-$HOME/kook-port}"
BASE_APP="${KOOK_BASE_APP:-$KOOK_WORK/linux/app}"
STAGE="$ROOT/.stage/app"

echo "==> 仓库根目录 : $ROOT"
echo "==> 基础客户端 : $BASE_APP"

if [ ! -d "$BASE_APP" ]; then
  echo "找不到基础客户端目录：$BASE_APP" >&2
  echo "请先准备官方 KOOK 客户端（解包后的 app 目录），或用 KOOK_BASE_APP 指定。" >&2
  exit 1
fi

echo "==> 清理并复制基础文件"
rm -rf "$ROOT/.stage"
mkdir -p "$STAGE"
# node_modules 必须整份带上：官方依赖里有大量原生模块，不能重装
rsync -a \
  --exclude '*.log' \
  --exclude '.cache/' \
  --exclude '**/node_modules/.cache/' \
  "$BASE_APP/" "$STAGE/"

echo "==> 覆盖移植层补丁"
rsync -a "$ROOT/patches/" "$STAGE/"

echo "==> 修正 package.json（版本 / 入口 / 名称 / 元信息）"
VERSION="$(node -p "require('$ROOT/package.json').version")"
node - "$STAGE/package.json" "$VERSION" "$ROOT/package.json" <<'NODE'
const fs = require('fs')
const [file, version, rootFile] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const root = JSON.parse(fs.readFileSync(rootFile, 'utf8'))
pkg.name = 'kook'
pkg.version = version
pkg.main = 'main.js'
pkg.description = 'KOOK Linux 原生移植版'
// 元信息统一从仓库根 package.json 取：electron-builder 生成 deb/rpm 控制文件时
// 读的是「被打包的 app 目录」里的这个 package.json，不是构建配置那份。
// 写死在这里会直接变成包里的 Homepage / License 字段（之前就是 https://github.com/ 和 unknown）。
pkg.author = root.author || { name: 'KANNI', email: 'cylqm@qq.com' }
pkg.homepage = root.homepage || ''
if (root.repository) pkg.repository = root.repository
pkg.license = root.license || 'MIT'
// electron-builder 会照 dependencies 去重装原生模块，这里必须清空：
// 依赖已经在 node_modules 里了，重装只会把可用的版本换坏。
pkg.dependencies = {}
pkg.devDependencies = {}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('    version=' + version + ' main=' + pkg.main)
console.log('    homepage=' + pkg.homepage + ' license=' + pkg.license)
NODE

echo "==> 清理 Windows 专用二进制（在 Linux 包里没用，能省几十 MB）"
find "$STAGE" -maxdepth 1 -type f \( -name '*.dll' -o -name '*.exe' \) -print -delete || true

SIZE="$(du -sh "$STAGE" | cut -f1)"
COUNT="$(find "$STAGE" -type f | wc -l)"
echo "==> 组装完成：$SIZE / $COUNT 个文件 -> $STAGE"
