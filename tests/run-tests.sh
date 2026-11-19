#!/usr/bin/env bash
# 移植层回归测试。
#
#   bash tests/run-tests.sh
#
# 需要 Electron 运行时（不装依赖也能跑，只要系统里有一份 Electron 36）：
#   ELECTRON=/path/to/electron bash tests/run-tests.sh
# 未指定时依次尝试常见位置与 PATH。
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FAIL=0

find_electron() {
  if [ -n "${ELECTRON:-}" ] && [ -x "${ELECTRON}" ]; then echo "$ELECTRON"; return; fi
  for c in \
    "$ROOT/../e36/node_modules/electron/dist/electron" \
    "$ROOT/../electron/node_modules/electron/dist/electron" \
    "$ROOT/node_modules/electron/dist/electron"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v electron 2>/dev/null && return
  echo ""
}

EL=$(find_electron)
if [ -z "$EL" ]; then
  echo "找不到 Electron 运行时。用 ELECTRON=/path/to/electron 指定后重试。" >&2
  exit 2
fi
echo "Electron: $EL"
echo "Node:     $(node -v)"

# Electron 在 DSH 之类环境里可能被注入 ELECTRON_RUN_AS_NODE / LD_LIBRARY_PATH，必须清掉
E() {
  env -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH "$@"
}

run() { echo; echo "── $1 ──"; shift; "$@"; local rc=$?; [ $rc -ne 0 ] && FAIL=1; return 0; }

echo
echo "── 1/3 窗口尺寸（纯 Node）──"
node tests/window-size.test.js || FAIL=1

UD_DEFAULT=$(mktemp -d "${TMPDIR:-/tmp}/kook-t-default-XXXXXX")
UD_GRAY=$(mktemp -d "${TMPDIR:-/tmp}/kook-t-gray-XXXXXX")

echo
echo "── 2/3 IPC 处理器（Electron · 默认态）──"
E TEST_MODE=default TEST_USERDATA="$UD_DEFAULT" DISPLAY="${DISPLAY:-:0}" \
  "$EL" --no-sandbox --ozone-platform=headless --disable-gpu tests/handlers.test.js 2>&1 | grep -v Fontconfig
[ "${PIPESTATUS[0]}" -ne 0 ] && FAIL=1

echo
echo "── 3/3 IPC 处理器（Electron · 灰度 KOOK_DEVICE_DETAIL_FULL=1，跑两轮验稳定性）──"
OUT=$(E TEST_MODE=gray TEST_USERDATA="$UD_GRAY" DISPLAY="${DISPLAY:-:0}" KOOK_DEVICE_DETAIL_FULL=1 \
  "$EL" --no-sandbox --ozone-platform=headless --disable-gpu tests/handlers.test.js 2>&1 | grep -v Fontconfig)
echo "$OUT"
echo "$OUT" | grep -q "FAIL" && FAIL=1
UNIQ=$(echo "$OUT" | sed -n 's/^DEVICE_UNIQ=//p')

E TEST_MODE=gray TEST_USERDATA="$UD_GRAY" TEST_EXPECT_UNIQ="$UNIQ" DISPLAY="${DISPLAY:-:0}" KOOK_DEVICE_DETAIL_FULL=1 \
  "$EL" --no-sandbox --ozone-platform=headless --disable-gpu tests/handlers.test.js 2>&1 | grep -v Fontconfig
[ "${PIPESTATUS[0]}" -ne 0 ] && FAIL=1

echo
if [ $FAIL -ne 0 ]; then
  echo "❌ 有测试未通过"
  exit 1
fi
echo "✅ 全部通过"
