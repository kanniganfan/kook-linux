#!/usr/bin/env bash
# 移植层回归测试。
#
#   bash tests/run-tests.sh
#   ELECTRON=/path/to/electron bash tests/run-tests.sh
#   CREDENTIAL=0 bash tests/run-tests.sh          # 跳过需要密钥环的那组
#   KOOK_TEST_FORCE_FAIL=1 bash tests/run-tests.sh # 自检：必须失败退出（证明 CI 会变红）
#
# 判定标准只有一个：每个测试进程的退出码。输出里的 "FAIL" 只用于给人看，
# 不作为通过依据——否则脚本异常退出（比如崩溃、找不到模块）会被当成「没打印 FAIL」而误判为成功。
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FAIL=0
GROUP_COUNT=0

# Electron 在 DSH 之类环境里可能被注入 ELECTRON_RUN_AS_NODE / LD_LIBRARY_PATH，必须清掉
E() { env -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH "$@"; }

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

group() { echo; echo "── $* ──"; GROUP_COUNT=$((GROUP_COUNT + 1)); }

# 跑一条测试并判定退出码。输出先落盘再打印，避免管道吃掉退出码。
#   run_case <名字> <至少应出现的通过标记> -- <命令...>
run_case() {
  local name=$1 expect=$2; shift 3
  local log rc
  log=$(mktemp)
  "$@" >"$log" 2>&1
  rc=$?
  grep -v Fontconfig "$log" || true
  if [ $rc -ne 0 ]; then
    echo "  ✗ $name：退出码 $rc"
    FAIL=1
  elif [ -n "$expect" ] && ! grep -q "$expect" "$log"; then
    echo "  ✗ $name：退出码 0 但没看到预期标记「$expect」（可能根本没执行）"
    FAIL=1
  fi
  rm -f "$log"
  return 0
}

EL=$(find_electron)
if [ -z "$EL" ]; then
  echo "找不到 Electron 运行时。用 ELECTRON=/path/to/electron 指定后重试。" >&2
  exit 2
fi
echo "Electron: $EL"
echo "Node:     $(node -v)"

EL_CMD=("$EL" --no-sandbox --ozone-platform=headless --disable-gpu)

group "1/4 窗口尺寸（纯 Node）"
run_case "window-size" "通过" -- node tests/window-size.test.js

UD_DEFAULT=$(mktemp -d "${TMPDIR:-/tmp}/kook-t-default-XXXXXX")
UD_GRAY=$(mktemp -d "${TMPDIR:-/tmp}/kook-t-gray-XXXXXX")
trap 'rm -rf "$UD_DEFAULT" "$UD_GRAY"' EXIT

group "2/4 IPC 处理器（Electron · 默认态）"
run_case "handlers-default" "通过" -- \
  env -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH TEST_MODE=default TEST_USERDATA="$UD_DEFAULT" DISPLAY="${DISPLAY:-:0}" KOOK_TEST_FORCE_FAIL="${KOOK_TEST_FORCE_FAIL:-0}" \
  "${EL_CMD[@]}" tests/handlers.test.js

group "3/4 IPC 处理器（Electron · 灰度，跑两轮验稳定性）"
GRAY_LOG=$(mktemp)
env -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH TEST_MODE=gray TEST_USERDATA="$UD_GRAY" DISPLAY="${DISPLAY:-:0}" KOOK_DEVICE_DETAIL_FULL=1 \
  KOOK_TEST_FORCE_FAIL="${KOOK_TEST_FORCE_FAIL:-0}" "${EL_CMD[@]}" tests/handlers.test.js >"$GRAY_LOG" 2>&1
RC=$?
grep -v Fontconfig "$GRAY_LOG" || true
[ $RC -ne 0 ] && { echo "  ✗ handlers-gray：退出码 $RC"; FAIL=1; }
UNIQ=$(sed -n 's/^DEVICE_UNIQ=//p' "$GRAY_LOG" | tr -d '\r')
rm -f "$GRAY_LOG"
if [ -z "$UNIQ" ]; then
  echo "  ✗ handlers-gray：没取到 DEVICE_UNIQ，第二轮无从比对"
  FAIL=1
else
  run_case "handlers-gray-restart" "通过" -- \
    env -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH TEST_MODE=gray TEST_USERDATA="$UD_GRAY" TEST_EXPECT_UNIQ="$UNIQ" DISPLAY="${DISPLAY:-:0}" \
    KOOK_DEVICE_DETAIL_FULL=1 KOOK_TEST_FORCE_FAIL="${KOOK_TEST_FORCE_FAIL:-0}" \
    "${EL_CMD[@]}" tests/handlers.test.js
fi

if [ "${CREDENTIAL:-1}" = "0" ]; then
  group "4/4 凭据存储：已跳过（CREDENTIAL=0）"
else
  group "4/4 凭据存储（Electron · 四态 + 历史迁移）"
  # 每种后端状态一个进程：createRuntime 内 secretState 记忆化，同进程换不了后端。
  # none / insecure 用 PATH=/nonexistent 去掉 secret-tool，模拟"没有密钥环"的机器。
  cred() { # $1=mode  其余为额外环境变量
    local mode=$1; shift
    local ud
    ud=$(mktemp -d "${TMPDIR:-/tmp}/kook-cred-$mode-XXXXXX")
    run_case "credential-$mode" "通过" -- \
      env -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH TEST_MODE="$mode" TEST_USERDATA="$ud" DISPLAY="${DISPLAY:-:0}" KOOK_NO_DIALOG=1 \
      KOOK_TEST_FORCE_FAIL="${KOOK_TEST_FORCE_FAIL:-0}" "$@" "${EL_CMD[@]}" tests/credential.test.js
    rm -rf "$ud"
  }

  cred safe
  cred keyring
  cred none PATH=/nonexistent
  cred insecure PATH=/nonexistent KOOK_INSECURE_STORE=1
  cred migrate
fi

echo
if [ $FAIL -ne 0 ]; then
  echo "❌ 有测试未通过（共 $GROUP_COUNT 组）"
  exit 1
fi
echo "✅ 全部通过（共 $GROUP_COUNT 组）"
