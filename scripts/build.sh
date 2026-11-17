#!/usr/bin/env bash
# 打安装包。用法：
#   bash scripts/build.sh              # 三种全打
#   bash scripts/build.sh AppImage     # 只打 AppImage
#   bash scripts/build.sh deb rpm      # 打指定几种
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(AppImage deb rpm)
fi

echo "==> 准备 Electron 运行时"
bash scripts/prepare-electron.sh

if [ "${SKIP_STAGE:-0}" = "1" ] && [ -d "$ROOT/.stage/app" ]; then
  echo "==> 跳过组装（复用 .stage/app）"
else
  echo "==> 组装 app 目录"
  bash scripts/stage.sh
fi

echo "==> 开始打包：${TARGETS[*]}"
ARGS=()
for t in "${TARGETS[@]}"; do ARGS+=(--linux "$t"); done

# electron-builder 需要的环境
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$ROOT/.cache/electron-builder}"

# rpm 目标需要 rpmbuild。没有系统包时用 scripts/fetch-rpm-tools.sh 备好的本地工具链。
if [ -x "$HOME/.local/rpm-tools/bin/rpmbuild" ]; then
  export PATH="$HOME/.local/rpm-tools/bin:$PATH"
  export LD_LIBRARY_PATH="$HOME/.local/rpm-tools/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  # rpmbuild 会去读 /usr/lib/rpm/rpmrc，本机没装 rpm 系统包，指到自备目录
  if [ -d "$HOME/.local/rpm-tools/lib/rpm" ]; then
    export RPM_CONFIGDIR="$HOME/.local/rpm-tools/lib/rpm"
  fi
  echo "==> rpmbuild: $("$HOME/.local/rpm-tools/bin/rpmbuild" --version 2>/dev/null | head -1 || echo 不可用)"
fi

npx --no-install electron-builder "${ARGS[@]}" --x64

echo
echo "==> 产物："
ls -lh "$ROOT/dist" | grep -vE '^total|^total' || true
