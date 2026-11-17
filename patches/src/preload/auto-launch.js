const path = require('path')
const fs = require('fs')
const os = require('os')
const { globalStore, keys } = require('../browser_native/preload/store')

// Windows 上靠注册表 Run 项；Linux 上没有注册表，按 XDG 规范写
// ~/.config/autostart/*.desktop。原生 helper 只在 win32 才加载。
const IS_WIN = process.platform === 'win32'
let windowsHelper = null
if (IS_WIN) {
  try {
    windowsHelper = require('../requireModule')('node-windows-helper')
  } catch (e) {
    windowsHelper = null
  }
}

// ── Linux 开机自启 ──
function autostartFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'autostart', 'kook-linux.desktop')
}
// 启动命令：优先用户装好的启动器，其次当前 Electron 运行时 + 应用目录
function launcherCommand() {
  const home = os.homedir()
  for (const c of [process.env.KOOK_LAUNCH_CMD, path.join(home, '.local/bin/kook-linux')]) {
    if (!c) continue
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return `${process.execPath} ${path.join(__dirname, '..', '..')}`
}
function desktopEntry() {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=KOOK',
    'Comment=KOOK 开机自动启动',
    `Exec=${launcherCommand()}${globalStore.get(keys.app_auto_launch_min) ? ' --hidden' : ''}`,
    'Icon=kook-linux',
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}
function linuxIsEnabled() {
  try {
    return fs.readFileSync(autostartFile(), 'utf8').includes(launcherCommand())
  } catch {
    return false
  }
}
function linuxEnable(enable) {
  const file = autostartFile()
  try {
    if (enable) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, desktopEntry(), 'utf8')
    } else {
      fs.rmSync(file, { force: true })
    }
    return true
  } catch (e) {
    console.log('[auto-launch] 自启动项写入失败', e && e.message)
    return false
  }
}

function getAppPath({ hiddenArg = true, extraArgs } = {}) {
  const isElectron =
    (process.versions != null ? process.versions.electron : undefined) != null
  const bootstrapExe = path.join(
    path.dirname(process.execPath),
    '..',
    path.basename(process.execPath)
  )
  const updateDotExe = path.join(
    path.dirname(process.execPath),
    '..',
    'update.exe'
  )
  if (isElectron && fs.existsSync(bootstrapExe)) {
    pathToAutoLaunchedApp = `"${bootstrapExe}"`
    args = ' -autoRun'
  } else if (isElectron && fs.existsSync(updateDotExe)) {
    pathToAutoLaunchedApp = `"${updateDotExe}"`
    args = ` --processStart "${path.basename(process.execPath)}"`
    if (hiddenArg || extraArgs) {
      args += ' --process-start-args'
      if (hiddenArg) {
        args += ` "${hiddenArg !== true ? hiddenArg : '--hidden'}"`
      }
      if (extraArgs) {
        args += ' "'
        args += extraArgs.join('" "')
        args += '"'
      }
    }
  } else {
    if (process.windowsStore) {
      pathToAutoLaunchedApp = `"explorer.exe" shell:AppsFolder\\${this.appPath}`
    } else {
      pathToAutoLaunchedApp = `"${process.execPath}"`
    }
    if (hiddenArg) {
      args = [hiddenArg !== true ? hiddenArg : ' --hidden']
    }
    if (extraArgs) {
      args += ' '
      args += extraArgs.join(' ')
    }
  }
  return `${pathToAutoLaunchedApp} ${args}`
}

function syncConfig() {
  if (!IS_WIN) {
    try {
      const realEnabled = linuxIsEnabled()
      if (realEnabled !== Boolean(globalStore.get(keys.app_auto_launch))) {
        globalStore.set(keys.app_auto_launch, realEnabled)
      }
    } catch {}
    return
  }
  try {
    let result = windowsHelper.readKookRegAutorun()
    let runPath = getAppPath()
    // 这里路径包含参数 - 去除参数只对比路径
    runPath = runPath.trim().split(' ')[0]
    let realPath = result.value.trim().split(' ')[0]
    let realEnabled = realPath == runPath
    let currentIsEnabled = globalStore.get(keys.app_auto_launch)
    if (realEnabled != currentIsEnabled) {
      globalStore.set(keys.app_auto_launch, realEnabled)
    }
  } catch {}
}

module.exports = {
  syncConfig,
  startMin(value) {
    globalStore.set(keys.app_auto_launch_min, Boolean(value))
    // 自启项里的 --hidden 跟着变，否则改了开关但开机行为还是旧的
    if (!IS_WIN && linuxIsEnabled()) linuxEnable(true)
  },
  isStartMin() {
    return Boolean(globalStore.get(keys.app_auto_launch_min))
  },
  enable(enable) {
    if (!IS_WIN) {
      const ok = linuxEnable(Boolean(enable))
      // 写盘失败就别把界面勾成开的，否则设置和真实状态对不上
      globalStore.set(keys.app_auto_launch, ok ? Boolean(enable) : linuxIsEnabled())
      return ok
    }
    if (enable) {
      windowsHelper.writeKookRegAutorun(getAppPath())
    } else {
      windowsHelper.deleteKookRegAutorun()
    }
    globalStore.set(keys.app_auto_launch, enable)
    return true
  },
  isEnabled() {
    if (!IS_WIN) return linuxIsEnabled()
    return globalStore.get(keys.app_auto_launch)
  },
}
