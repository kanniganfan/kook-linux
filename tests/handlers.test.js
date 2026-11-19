// handlers.js 的回归测试（真实 Electron 主进程，非 mock）。
//
//   TEST_MODE=default  electron --no-sandbox --ozone-platform=headless tests/handlers.test.js
//   TEST_MODE=gray     KOOK_DEVICE_DETAIL_FULL=1 ... 同上
//
// 覆盖：SYSTEM_GET_FILE（无窗口不弹窗）、SYSTEM_SWITCH_SERVER_API（白名单 + 落盘 + 重启生效）、
//       SYSTEM_GET_ACTIVE_DOMAIN（官方形状）、SYSTEM_GET_UNIQUE / _DETAIL（两态 + 稳定性）。
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const MODE = process.env.TEST_MODE || 'default'
const userData = process.env.TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'kook-h-' + MODE + '-'))
app.setPath('userData', userData)

const lines = []
let pass = 0
function ok(name, cond, detail) {
  if (cond) {
    pass++
    lines.push('  ok   ' + name)
  } else {
    lines.push('  FAIL ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)))
  }
}

app.whenReady().then(async () => {
  const rt = require('../patches/handlers.js').createRuntime({ app, LOG: () => {} })
  const h = rt.handlers
  const dir = rt.dir

  // ── 文件选择：无窗口时必须立刻返回 -1，不能弹原生对话框把 sendSync 挂死 ──
  const noWin = await h.SYSTEM_GET_FILE({ properties: ['openFile'] })
  ok('GET_FILE 无窗口返回 code:-1', noWin && noWin.code === -1, noWin)
  ok('GET_FILE 无窗口不返回伪成功', !(noWin && noWin.code === 0 && !noWin.data), noWin)

  // ── 域名切换 ──
  const before = h.SYSTEM_GET_ACTIVE_DOMAIN()
  ok(
    'GET_ACTIVE_DOMAIN 用官方字段名',
    before && typeof before.activeApiOrigin === 'string' && typeof before.activeH5Origin === 'string',
    before
  )
  ok('GET_ACTIVE_DOMAIN 保留旧键兜底', before && typeof before.origin === 'string' && typeof before.api === 'string', before)

  const evil = h.SYSTEM_SWITCH_SERVER_API('https://evil.example.com')
  ok('拒绝非白名单域名', evil === false, evil)
  ok('拒绝后域名未变', h.SYSTEM_GET_ACTIVE_DOMAIN().activeApiOrigin === before.activeApiOrigin)

  const toBackup = h.SYSTEM_SWITCH_SERVER_API('backup')
  ok('接受 backup 别名', toBackup === true, toBackup)
  const afterBackup = h.SYSTEM_GET_ACTIVE_DOMAIN()
  ok('切换后 activeApiOrigin 变化', afterBackup.activeApiOrigin !== before.activeApiOrigin, afterBackup)
  ok(
    '切换后 api 与 h5 同域族',
    new URL(afterBackup.activeApiOrigin).host !== new URL(afterBackup.activeH5Origin).host,
    afterBackup
  )

  const toPrimary = h.SYSTEM_SWITCH_SERVER_API('primary')
  ok('可切回 primary', toPrimary === true, toPrimary)
  ok('切回后 activeApiOrigin 复原', h.SYSTEM_GET_ACTIVE_DOMAIN().activeApiOrigin === before.activeApiOrigin)

  // 从磁盘读：切换结果必须真落盘（重启后生效的前提）
  let disk = null
  try {
    disk = JSON.parse(fs.readFileSync(path.join(dir, 'domain.json'), 'utf8'))
  } catch (e) {}
  ok('domain.json 已落盘', !!disk && typeof disk === 'object', disk)

  // ── 设备指纹 ──
  const uniq = h.SYSTEM_GET_UNIQUE()
  const detail = h.SYSTEM_GET_UNIQUE_DETAIL()
  const uniqAgain = h.SYSTEM_GET_UNIQUE()
  const detailAgain = h.SYSTEM_GET_UNIQUE_DETAIL()

  ok('GET_UNIQUE 在同一进程内稳定', uniq === uniqAgain, [uniq, uniqAgain])
  ok('GET_UNIQUE_DETAIL 在同一进程内稳定', JSON.stringify(detail) === JSON.stringify(detailAgain), [detail, detailAgain])

  if (MODE === 'gray') {
    ok('灰度：detail 有 bios', typeof detail.bios === 'string' && detail.bios.length > 0, detail)
    ok('灰度：detail 有 machine', typeof detail.machine === 'string' && detail.machine.length > 0, detail)
    ok('灰度：detail.device_id 与 GET_UNIQUE 同源同值', detail.device_id === uniq, [detail, uniq])
    ok('灰度：device_id 是 UUID 形态', /^[0-9a-f-]{36}$/i.test(detail.device_id || ''), detail.device_id)
    // 第二次启动仍要一致：由 run-tests.sh 传入同一个 TEST_USERDATA 再跑一次比对
    if (process.env.TEST_EXPECT_UNIQ) {
      ok('灰度：跨进程重启值不变', uniq === process.env.TEST_EXPECT_UNIQ, [uniq, process.env.TEST_EXPECT_UNIQ])
    }
  } else {
    ok('默认：detail 保持 {id,type} 形状', detail && detail.type === 'linux' && typeof detail.id === 'string', detail)
    ok('默认：detail.id 与 GET_UNIQUE 一致', detail.id === uniq, [detail, uniq])
    ok('默认：不带 bios/machine（老用户指纹零漂移）', !('bios' in detail) && !('machine' in detail), detail)
  }

  console.log(lines.join('\n'))
  console.log('\n[' + MODE + '] ' + pass + '/' + lines.length + ' 通过')
  if (MODE === 'gray') console.log('DEVICE_UNIQ=' + uniq)
  app.exit(pass === lines.length ? 0 : 1)
})
