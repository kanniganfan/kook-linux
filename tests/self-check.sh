#!/usr/bin/env bash
# 反向自检：注入一条必失败的断言，验证 runner 会以非零退出码结束。
#
# 这条检查存在的意义：一个只会输出「✅ 全部通过」的脚本，在 CI 里和真正通过没有区别。
# 只有「故意失败 → 必须变红」被验证过，前面的绿灯才算数。
#
#   bash tests/self-check.sh
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

set +e
KOOK_TEST_FORCE_FAIL=1 CREDENTIAL="${CREDENTIAL:-0}" bash tests/run-tests.sh >"$LOG" 2>&1
RC=$?
set -e

tail -6 "$LOG"

if [ "$RC" -eq 0 ]; then
  echo "❌ 自检失败：注入了必然失败的断言，runner 却返回 0（CI 会误判为通过）"
  exit 1
fi

echo "✅ 自检通过：注入失败后 runner 返回 $RC"
