// electron-builder afterPack 钩子：打目标格式之前，对已展开的 app 目录做最后清理与加工。
//
// 两件事：
//   1. 删掉 resources/app-update.yml —— electron-builder 会照着 package.json 的
//      repository 自动推断 publish=github，然后往 deb/rpm 里塞一份指向发布仓库的
//      更新配置。移植版必须屏蔽自动更新，这份文件不该出现在分发物里。
//      （build.publish 设成 null 才真正阻止生成，这里只是兜底。）
//   2. 把可执行文件换成启动器 shell，真正的二进制改名 kook-linux-bin。
//      原因是 Electron 的 GTK 后端必须在进程启动时就定下来：Wayland 会话下不指定
//      ozone 平台，Electron 会同时把 GTK3 和 GTK4 的 Wayland 后端拉进同一进程，
//      GTK 直接 abort，双击毫无反应（连日志都没有）：
//        Gtk-ERROR **: GTK 2/3 symbols detected. Using GTK 2/3 and GTK 4 in the
//        same process is not supported
//      main.js 里 app.commandLine.appendSwitch 太晚，GTK 早就初始化完了。
//      顺带在 chrome-sandbox 没有 SUID 位时补 --no-sandbox（AppImage 挂载是只读
//      squashfs，SUID 位根本设不上去）。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// 把 .stage/app/node_modules 整份补进包里的 resources/app/node_modules。
//
// 为什么必须自己补：electron-builder 只拷 package.json dependencies 声明的那棵树，
// 而官方客户端的 node_modules 是扁平化安装的，大量传递依赖（call-bind-apply-helpers、
// get-proto 这一串）没写进任何 package.json。照它的清单拷，@kookapp/electron-local-server
// 一 require 就断，本地 HTTP 服务起不来 —— 表现就是窗口打开一片空白。
// 硬链接同步，几百 MB 也是秒级。
function syncNodeModules(context) {
  const projectDir = context.packager.projectDir
  const src = path.join(projectDir, '.stage/app/node_modules')
  const dst = path.join(context.appOutDir, 'resources/app/node_modules')
  if (!fs.existsSync(src)) {
    console.log('  ! .stage/app/node_modules 不存在，跳过依赖同步')
    return
  }
  fs.mkdirSync(dst, { recursive: true })
  try {
    execFileSync('cp', ['-alf', src + '/.', dst + '/'], { stdio: 'pipe' })
  } catch (e) {
    // 硬链接跨文件系统会失败，退回复制
    execFileSync('cp', ['-af', src + '/.', dst + '/'], { stdio: 'pipe' })
  }
  const n = fs.readdirSync(dst).length
  console.log(`  • 已同步 node_modules -> resources/app（${n} 个顶层条目）`)
}

const LAUNCHER = `#!/bin/sh
# KOOK 启动器（由构建脚本生成，别手改）
DIR=$(dirname "$(readlink -f "$0")")
BIN="$DIR/kook-linux-bin"

EXTRA=""

# 1) 强制 GTK3。GNOME 会话下 Chromium 会尝试 dlopen libgtk-4，而进程里
#    已经初始化了 libgtk-3，GTK 检测到两套符号就往 abort 走：
#      Gtk-ERROR **: GTK 2/3 symbols detected. Using GTK 2/3 and GTK 4 in the
#      same process is not supported
#    表现就是双击没有任何反应、也没有日志。--gtk-version=3 只走 GTK3。
case " $* " in
  *" --gtk-version="*|*" --gtk-version "*) ;;
  *) EXTRA="$EXTRA --gtk-version=3" ;;
esac

# 2) ozone 平台：Wayland 会话下走原生 Wayland（XWayland 下渲染进程容易起不来）。
case " $* " in
  *" --ozone-platform="*|*" --ozone-platform "*) ;;
  *)
    if [ "\${XDG_SESSION_TYPE:-}" = "wayland" ] || [ -n "\${WAYLAND_DISPLAY:-}" ]; then
      EXTRA="$EXTRA --ozone-platform=wayland"
    fi
    ;;
esac

# 3) chrome-sandbox 需要 root:root 且 SUID；AppImage 是只读 squashfs，SUID 位
#    设不上去，装包后也可能被改动。不可用时不加 --no-sandbox 就是静默退出。
case " $* " in
  *" --no-sandbox"*) ;;
  *)
    if [ ! -u "$DIR/chrome-sandbox" ]; then
      EXTRA="$EXTRA --no-sandbox"
    fi
    ;;
esac

# shellcheck disable=SC2086
exec "$BIN" $EXTRA "$@"
`

module.exports = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')

  syncNodeModules(context)

  for (const name of ['app-update.yml', 'app-update.yml.blockmap']) {
    const file = path.join(resources, name)
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      console.log(`  • 已移除 resources/${name}（移植版屏蔽自动更新）`)
    }
  }

  // executableName 由 package.json 的 build.linux.executableName 决定
  const exeName = context.packager.executableName || 'kook-linux'
  const bin = path.join(context.appOutDir, exeName)
  const real = bin + '-bin'

  if (fs.existsSync(bin) && !fs.existsSync(real)) {
    fs.renameSync(bin, real)
    fs.writeFileSync(bin, LAUNCHER, { mode: 0o755 })
    console.log(`  • 已生成启动器 ${exeName} → ${exeName}-bin`)
  } else if (fs.existsSync(bin)) {
    fs.writeFileSync(bin, LAUNCHER, { mode: 0o755 })
    console.log(`  • 已刷新启动器 ${exeName}`)
  }
}
