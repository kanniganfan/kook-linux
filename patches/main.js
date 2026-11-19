// KOOK Linux 移植版主进程（重建层）
// 目标：用原版 webapp + 原版 preload，按 209 个 IPC 契约重建主进程。
const { app, BrowserWindow, ipcMain, session, protocol } = require('electron')

// path / fs / os 必须在 globalPref() 之前就到位：桌面设置（硬件加速、关闭到托盘、
// 效能模式）要在 app ready 之前读盘决定，而 globalPref 里的 try/catch 会把
// ReferenceError 静默吞掉，表现就是设置页里关掉硬件加速完全不生效。
const path = require('path')
const fs = require('fs')
const os = require('os')

// 应用名固定为 KOOK（不加任何后缀）：GNOME 任务栏按它和 kook-linux.desktop 的
// StartupWMClass 对上，名字或 WM_CLASS 一变就会退回 Electron 的默认齿轮图标。
try {
  app.setName('KOOK')
} catch {}
// 各项系统集成（通知、录音归类）都读这个标识，Linux 上必须和 desktop 文件一致
try {
  app.setDesktopName('kook-linux.desktop')
} catch {}

// ── 桌面设置（设置面板里那几个开关的真实来源）──
// 设置存在渲染层与主进程共用的 linux-store/global.json，主进程直接读盘，
// 这样硬件加速这种必须赶在 app ready 之前决定的项才拿得到值。
const STORE_DIR = () => path.join(app.getPath('userData'), 'linux-store')
function readGlobalStore() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STORE_DIR(), 'global.json'), 'utf8')) || {}
  } catch {
    return {}
  }
}
function globalPref(key, def) {
  const v = readGlobalStore()[key]
  return v === undefined ? def : v
}

// 单实例：窗口最小化到托盘后，再点一次图标只把已有窗口唤回来，不开第二个进程。
// 托盘图标在某些桌面（GNOME 没装 AppIndicator 扩展）不显示，这条就是唤回的兜底。
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    try {
      if (mainWin && !mainWin.isDestroyed()) {
        if (mainWin.isMinimized()) mainWin.restore()
        mainWin.show()
        mainWin.focus()
      }
    } catch {}
  })
}

try {
  if (globalPref('disabled_hardware_acceleration', false) === true) {
    app.disableHardwareAcceleration()
    console.log('[linux-main] 硬件加速已按设置关闭（重启后生效）')
  }
} catch (e) {
  console.log('[linux-main] 硬件加速设置读取失败', e && e.message)
}
const { createDeviceIdentity } = require('./device-identity')

const APP_DIR = __dirname
const SRC = path.join(APP_DIR, 'src')
const WEBAPP = path.join(APP_DIR, 'webapp/build')
const PREFERRED_PORT = Number(process.env.KOOK_PORT) || 5888
let PORT = PREFERRED_PORT
const LOG = (...a) => console.log('[linux-main]', ...a)
const NOISY = /^(LOGGER_|BOOSTER_|VOLUME_|SESSION_)/;
const TRACE_ON = process.env.KOOK_TRACE === '1';
const TRACE = (kind, name, ...rest) => {
  if (!TRACE_ON && NOISY.test(name)) return;
  console.log('[ipc]', kind, name, ...rest);
}

const { net } = require('electron')
const { createRuntime } = require(path.join(__dirname, 'handlers.js'))
const { applyContentSize } = require(path.join(__dirname, 'window-size.js'))
let runtime = null
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'

// 官方只发 Windows 包；UA 报 Linux 会被风控当成异常环境
app.userAgentFallback =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'KOOK/0.112.0 Chrome/136.0.7103.177 Electron/36.7.4 Safari/537.36'

// ────────────────────────── 1. 静态服务 ──────────────────────────
let server = null
function startLocalServer() {
  const LocalServer = require(
    path.join(APP_DIR, 'node_modules/@kookapp/electron-local-server')
  )
  const srv = new LocalServer()
  // 面板缩略图用的实时画面：同源 MJPEG，<img> 自己逐帧刷新
  srv.mount({ prefix: '/__live', handle: (ctx) => liveMjpegHandler(ctx) })
  srv.mount({ prefix: '', handle: LocalServer.bodyParser() })
  srv.mount({
    prefix: '',
    exclude: /^\/app/,
    handle: LocalServer.staticFileAsar({ root: WEBAPP, redirect: 'index.htm' }),
  })
  srv.mount({
    prefix: '/app',
    handle: LocalServer.staticFileAsar({ root: WEBAPP, redirect: 'index.htm' }),
  })
  srv.on('error', (e) => LOG('LocalServer error', e && e.message))
  // 端口被占用就退到系统临时端口，避免“装到别的机器上起不来”
  const tryStart = (port) =>
    srv.start({ port, hostname: '127.0.0.1' }).then(() => {
      const addr = (srv.server && srv.server.address && srv.server.address()) || null
      if (addr && addr.port) PORT = addr.port
      LOG('local server on http://127.0.0.1:' + PORT + '/app/index.htm')
      server = srv
    })
  return tryStart(PREFERRED_PORT).catch((e) => {
    LOG('端口 ' + PREFERRED_PORT + ' 不可用（' + (e && e.message) + '），改用临时端口')
    return tryStart(0)
  })
}

// ────────────────────────── 2. IPC 打桩 ──────────────────────────
function loadChannels() {
  const constants = require(path.join(SRC, 'browser_native/constants.js'))
  return Object.keys(constants.IPCEventName)
}

function installStubs() {
  // ── 原生进程模块桥接 ──
  // 官方进程活动引擎（base/process-activity）和 taskList 都会 require('node-process-windows')，
  // 那个 .node 只有 Windows 版，加载必然失败。这里在 require 层直接换成 /proc 适配层，
  // 明文模块和官方字节码两条路径都能拿到真实进程数据。
  try {
    const Module = require('module')
    if (!Module._kookProcWindows) {
      const ADAPTER = path.join(SRC, 'controllers/taskList/process-windows-adapter')
      const origLoad = Module._load
      Module._load = function (request, parent, isMain) {
        const req = String(request)
        if (req === 'node-process-windows' || /(^|[\\/])process_windows(\.node)?$/i.test(req)) {
          let impl = null
          try { impl = require(ADAPTER) } catch (e) { LOG('[stub] 进程枚举适配层加载失败', e && e.message) }
          if (impl) {
            if (/\.node$/i.test(req)) return impl
            return { process_windows: impl }
          }
        }
        return origLoad.apply(this, arguments)
      }
      Module._kookProcWindows = true
      LOG('原生进程模块已桥接到 Linux /proc')
    }
  } catch (e) {
    LOG('进程模块桥接失败', e && e.message)
  }

  const names = loadChannels()
  LOG('IPC 通道数:', names.length)
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    // 进程列表这条链完全交给官方 src/controllers/taskList/taskList-data-manage.js 注册
    // （数据源已接到 Linux /proc 适配层）。这里抢注会让它 ipcMain.handle 抛错，
    // 模块直接初始化失败，官方进程活动引擎就永远拿不到进程。
    if (/^TASKLIST_/.test(name)) continue
    ipcMain.handle(name, (event, ...args) => {
      TRACE('invoke', name, brief(args))
      return stubValue(name, args, event)
    })
    ipcMain.on(name, (event, ...args) => {
      TRACE('send', name, brief(args))
      if (event.returnValue === undefined) event.returnValue = stubValue(name, args, event)
    })
  }
  // 非 constants 里声明、但被 preload/webapp 直接用到的通道
  const extra = [
    'get_main_webcontent_id',
    'send-to-webContent',
    'send-to-window',
  ]
  for (const name of extra) {
    ipcMain.handle(name, () => {
      TRACE('extra-invoke', name)
      return 1
    })
    ipcMain.on(name, (event) => {
      TRACE('extra-send', name)
      if (event.returnValue === undefined) event.returnValue = 1
    })
  }
  return seen.size
}

function brief(args) {
  try {
    const s = JSON.stringify(args)
    return s && s.length > 240 ? s.slice(0, 240) + '…' : s
  } catch {
    return '[unserializable]'
  }
}

let _identity = null
function IDENTITY() {
  if (!_identity) _identity = createDeviceIdentity(app)
  return _identity
}

// 空壳返回值：既是数组（支持 filter/map/forEach）又带 code/data，避免调用方类型崩溃
function makeEmpty() {
  const arr = []
  arr.code = 0
  arr.data = null
  arr.success = true
  return arr
}

// 少数通道有明确语义，先给合理默认值，其余统一空壳
function stubValue(name, args, event) {
  if (runtime && Object.prototype.hasOwnProperty.call(runtime.handlers, name)) {
    try {
      // 末尾多带一个 sender event：多数 handler 用不到，子窗口这类需要它回发事件
      return runtime.handlers[name](...args, event)
    } catch (e) {
      LOG('handler error', name, e && e.message)
    }
  }
  switch (name) {
    case 'SYSTEM_GET_ACTIVE_DOMAIN':
      return { origin: 'https://www.kookapp.cn', api: 'https://www.kookapp.cn' }
    case 'SYSTEM_GET_SYSTEM_VERSION':
      return '10.0.22631'
    // 移植版不存在可用的更新器：明确告知“不是重启更新”，避免走到安装流程
    case 'SYSTEM_IS_RELAUNCH_UPDATE':
    case 'SYSTEM_IS_RELAUNCH_PROACTIVE_UPDATE':
      return false
    case 'DOWNLOAD_UPDATE':
      LOG('[update] 下载请求已被移植版拒绝')
      return { code: -1, message: 'Linux 移植版已禁用自动更新', data: null }
    // ↓ 关键：这三条是 device-feature 加密头的取数源，必须返回裸值。
    // 包成 {code,data} 会让服务端收到对象 → 判定「登录环境异常」并踢下线。
    case 'SYSTEM_GET_UNIQUE':
      LOG('DEVICE getUnique ->', IDENTITY().device_id)
      return IDENTITY().device_id
    case 'SYSTEM_GET_UNIQUE_INFO':
      return IDENTITY().device_id
    case 'SYSTEM_GET_UNIQUE_DETAIL': {
      const id = IDENTITY()
      LOG('DEVICE detail', id.bios, id.machine)
      return { bios: id.bios, machine: id.machine, device_id: id.device_id }
    }
    case 'SYSTEM_GET_PCNAME':
      return IDENTITY().pcName
    case 'STORE_GLOBAL_GET':
    case 'STORE_USER_GET':
    case 'STORE_IMPORTANT_GET':
      return null
    case 'STORE_GLOBAL_GET_ALL':
      return {}
    case 'SETTING_GET':
      return null
    default:
      return makeEmpty()
  }
}

// ────────── 2.5 Windows 环境伪装（绕过服务端登录环境风控）──────────
const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'KOOK/0.112.0 Chrome/136.0.7103.177 Electron/36.7.4 Safari/537.36'

function installWindowsSpoof() {
  app.userAgentFallback = WIN_UA
  const ses = session.defaultSession
  ses.setUserAgent(WIN_UA)

  if (process.env.KOOK_NO_HOOKS === '1') {
    LOG('webRequest 钩子已跳过（诊断用）')
    return
  }
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    h['User-Agent'] = WIN_UA
    h['sec-ch-ua-platform'] = '"Windows"'
    h['sec-ch-ua-mobile'] = '?0'
    if (h['sec-ch-ua']) {
      h['sec-ch-ua'] = h['sec-ch-ua'].replace(/Linux|"Linux"/g, '"Windows"')
    }
    cb({ requestHeaders: h })
  })

  let uaLogged = false
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (!uaLogged && /\/api\/v3\//.test(d.url)) {
      uaLogged = true
      LOG('[http] 首个 API 请求:', d.url.slice(0, 90))
    }
    cb({})
  })
  ses.webRequest.onSendHeaders((d) => {
    if (!/\/api\/v3\/user\/me|\/api\/v3\/user\/login|\/api\/v3\/user\/profile/.test(d.url)) return
    const h = d.requestHeaders || {}
    LOG('[http] UA 校验样本 ->', d.url.slice(0, 70))
    LOG('        UA =', String(h['User-Agent'] || h['user-agent'] || '').slice(0, 100))
    LOG('        Cookie 存在 =', !!(h['Cookie'] || h['cookie']))
  })

  ses.webRequest.onCompleted((d) => {
    if (!/kookapp\.cn/.test(d.url)) return
    if (d.statusCode >= 400) {
      LOG('[http]', d.method, d.statusCode, d.url.slice(0, 110))
    }
  })
  // 屏幕分享：Electron 必须显式给 WebRTC 指定采集源，否则 getDisplayMedia 永远失败
  let rawSources = null
  let rawSourcesAt = 0
  try {
    if (process.env.KOOK_NO_DISPLAY_MEDIA === '1') throw new Error('skipped')
    const { desktopCapturer } = require('electron')
    ses.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const now = Date.now()
          if (!rawSources || now - rawSourcesAt > 60000) {
            rawSources = await desktopCapturer.getSources({
              types: ['screen', 'window'],
              thumbnailSize: { width: 0, height: 0 },
            })
            rawSourcesAt = now
          }
          const sources = rawSources
          // 面板里用的是我们自枚举的 id（screen:0:0 / window:<xid>:0），
          // portal 返回的 id 不一定一致，所以再按名字兜底匹配一次
          const wantName = pendingCaptureName
          const picked =
            (pendingCaptureSourceId && sources.find((s) => s.id === pendingCaptureSourceId)) ||
            (wantName && sources.find((s) => s.name === wantName)) ||
            sources.find((s) => String(s.id).startsWith('screen')) ||
            sources[0]
          LOG('[capture] 提供采集源', sources.length, '个，选中', picked && picked.id)
          if (!picked) return callback({})
          callback({ video: picked })
        } catch (e) {
          LOG('[capture] 采集源失败', e && e.message)
          callback({})
        }
      },
      { useSystemPicker: false }
    )
    LOG('屏幕分享处理器已注册')
  } catch (e) {
    LOG('屏幕分享处理器注册失败', e && e.message)
  }
  LOG('Windows UA 伪装已启用')
}

// ───────────── 3. 同源拦截：把 https://www.kookapp.cn/app/* 指向本地磁盘 ─────────────
// 官方就是用这个同源把 webapp 跑起来的；偏离它 → API 全部 403「越权访问」
const FIRST_PARTY_HOSTS = new Set([
  'www.kookapp.cn',
  'm.kookapp.cn',
  'kookapp.cn',
  'www.kookyuyin.cn',
])
const MIME = {
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/opus',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
}

function serveWebappFile(pathname) {
  // /app/static/js/x.js -> webapp/build/static/js/x.js
  let rel = pathname.replace(/^\/app\/?/, '')
  if (!rel || rel.endsWith('/')) rel = 'index.htm'
  const abs = path.normalize(path.join(WEBAPP, rel))
  if (!abs.startsWith(WEBAPP)) return null
  return abs
}


// 移植版必须屏蔽主程序更新：更新器只会下载 Windows 安装包，装上就把这个端口毁掉。
// 只清掉 newest（主程序新版本），保留 current 里的远程模块热更新信息——UI chunk 还得靠它。
// ── Linux 移植版自己的版本与更新记录 ──
// 版本号跟随官方格式，但归属移植线：按实际数字显示，不补零（0.0.7 就是 v0.0.7）
const PORT_VERSION = 'v0.0.12'
const PORT_BASE = '0.112.0-c5af713-kook_3321' // 移植基线的官方 PC 版本
const PORT_AUTHOR = '@KANNI#0001'

// 按官方「日期 更新记录（vx.x.x）+ 分类条目」的写法生成卡片，
// 接口返回的是 description 里的卡片数组，直接插到最前面。
function linuxUpdateCards() {
  const card = (mods) => ({ type: 'card', theme: 'none', size: 'lg', modules: mods })
  const header = (t) => card([{ type: 'header', text: { type: 'plain-text', content: t } }])
  const sec = (t) => card([{ type: 'section', text: { type: 'kmarkdown', content: t } }])
  return [
    // ── 本次版本 ──
    header(`2026.11.19 更新记录（${PORT_VERSION}）`),
    sec('**安全加固：**'),
    sec('• 开启 Chromium 的 Web 安全保护（此前为兼容性关闭）'),
    sec('• 媒体、屏幕分享、剪贴板等系统权限改为按请求来源校验，来源不明一律拒绝'),
    sec('• 登录凭据改为三层存储：系统密钥环 → AES-256-GCM → 拒绝落盘，不再退化为等价明文'),
    sec('**问题修正：**'),
    sec('• 修复「关闭硬件加速」「关闭到托盘」「效能模式」三个设置项读取失效的问题'),
    sec('• 修复域名切换从未真正生效的问题（返回结构一直与官方不符）'),
    sec('• 补上窗口初始尺寸设置通道，此前调用无声失败'),
    sec('• 文件选择与服务器线路切换改为真实实现，不再返回伪成功'),
    sec('**说明：**'),
    sec('• 没有系统密钥环的环境不再保存登录状态，每次启动需重新登录；装 gnome-keyring 或 kwallet 后恢复'),

    // ── 上一版，保留不删 ──
    header('2026.11.18 更新记录（v0.0.11）'),
    sec('**问题修正：**'),
    sec('• 修复部分桌面环境（GNOME 等）下双击客户端没有任何反应、进程启动即退出的问题'),
    sec('• 修复安装后窗口能打开但内容一片空白、界面加载不出来的问题'),
    sec('• 修复 Wayland 会话下窗口偶发打不开、渲染进程起不来的问题'),
    sec('**安装包：**'),
    sec('• 修正 deb / rpm 包信息中的主页地址与许可证'),
    sec('• 移除安装包内的自动更新配置，避免被官方更新器覆盖'),

    // ── 历史版本，保留不删 ──
    header('2026.11.18 更新记录（v0.0.7）'),
    sec('**功能优化：**'),
    sec('• 客户端透明：补上主界面被 app-mask-layer 挡住的那一层，开启后能真正透出桌面；个人设置保持官方的不透明实底，保证内容可读'),
    sec('• 悬浮工具栏：改成无边框、透明、置顶、跨工作区可见的独立窗口，支持拖动，也能正常关闭'),
    sec('• 快捷键：新增本地键盘桥，Wayland 下按键说话等快捷键不再失灵，所有按键配置都交给客户端自己判断'),
    sec('• 版本号显示按实际数字，不再补零'),
    sec('**问题修正：**'),
    sec('• 修复迅游加速器提示串到语音控制条等界面的问题'),
    sec('• 修复悬浮工具栏偶尔不显示、关不掉的问题'),
    sec('• 修复「叠加色透明度」与「客户端透明」被混为一谈的问题'),

    // ── 初版记录，保留不删 ──
    header('2026.11.18 更新记录（v0.0.1）'),
    sec('**产品发布：**'),
    sec(`• KOOK Linux 原生移植版初版，基于官方 Windows PC 客户端 ${PORT_BASE} 移植，本版本由 ${PORT_AUTHOR} 进行移植并适配 Linux。`),
    sec('**适配功能：**'),
    sec('• 屏幕分享：改用 xdg-desktop-portal 采集，一次授权同时覆盖屏幕与窗口，面板内实时预览持续刷新'),
    sec('• 用户动态：接入官方进程活动引擎，识别本机正在运行的游戏与应用'),
    sec('• 屏幕覆盖：X11 会话支持全局置顶，Wayland 会话在 KOOK 窗口内显示，设置面板内给出多语言说明'),
    sec('• 桌面集成：开机自动启动、启动时最小化、关闭时最小化到托盘、硬件加速、效能模式（POSIX nice）'),
    sec('• 通知、图片查看、子窗口、托盘图标均按 Linux 桌面规范重做'),
    sec('**功能优化：**'),
    sec('• 界面文案按 Linux 实际情况改写，覆盖简体中文、繁体中文、日文、英文'),
    sec('• 应用名统一为 KOOK，图标使用官方 logo，桌面项与任务栏保持一致'),
    sec('**问题修正：**'),
    sec('• 修复图片查看器打开白屏的问题'),
    sec('• 修复屏幕分享预览画面不刷新的问题'),
    sec('• 修复设置项在多语言下缺少说明的问题'),
  ]
}

function linuxUpdateDirection() {
  return [
    `2026.11.18 更新记录（${PORT_VERSION}）`,
    '',
    '问题修正：',
    '修复部分桌面环境（GNOME 等）下双击客户端没有任何反应、进程启动即退出的问题。',
    '修复安装后窗口能打开但内容一片空白、界面加载不出来的问题。',
    '修复 Wayland 会话下窗口偶发打不开、渲染进程起不来的问题。',
    '',
    '安装包：',
    '修正 deb / rpm 包信息中的主页地址与许可证。',
    '移除安装包内的自动更新配置，避免被官方更新器覆盖。',
    '',
    `本版本基于官方 Windows PC 客户端 ${PORT_BASE} 移植，由 ${PORT_AUTHOR} 进行移植并适配 Linux。`,
    '',
  ].join('\r\n')
}

function injectLinuxUpdateLog(target) {
  try {
    const cur = target && target.current
    if (!cur || typeof cur !== 'object') return
    // 只保留 Linux 移植线自己的记录：官方的 PC 端历史整段丢掉
    if (typeof cur.description === 'string' && cur.description.trim().startsWith('[')) {
      const cards = linuxUpdateCards()
      const text = JSON.stringify(cards, null, 2)
      if (cur.description !== text) cur.description = text
    }
    const dir = linuxUpdateDirection()
    if (cur.direction !== dir) cur.direction = dir
  } catch (e) {
    LOG('[update] 移植版更新记录注入失败', e && e.message)
  }
}

function rewriteUpdatePayload(pathname, buf) {
  try {
    if (!/^\/api\/v2\/updates/.test(pathname)) return buf
    const text = buf.toString('utf8')
    if (!text.trim().startsWith('{')) return buf
    const json = JSON.parse(text)
    // 接口有两种形态：{current,newest} 与 {code,data:{current,newest}}
    const target = json && typeof json.data === 'object' && json.data !== null ? json.data : json
    if (!target || typeof target !== 'object') return buf
    if (/\/latest-version$/.test(pathname)) {
      if ('url' in target) {
        LOG('[update] 已屏蔽安装包下载地址')
        target.url = ''
      }
      return Buffer.from(JSON.stringify(json), 'utf8')
    }
    if (target.newest) {
      LOG('[update] 已屏蔽主程序新版本 ->', target.newest.number || '(unknown)')
      target.newest = null
    }
    // 更新记录里插入移植版自己的首条记录（每次都注入，接口返回的是新对象）
    injectLinuxUpdateLog(target)
    return Buffer.from(JSON.stringify(json), 'utf8')
  } catch {
    return buf
  }
}

function parseSetCookie(raw) {
  if (!raw) return null
  const parts = String(raw).split(';')
  const first = parts.shift() || ''
  const idx = first.indexOf('=')
  if (idx < 1) return null
  const c = { name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim() }
  for (const p of parts) {
    const [k, v] = p.split('=').map((x) => (x == null ? '' : x.trim()))
    const key = k.toLowerCase()
    if (key === 'domain') c.domain = v
    else if (key === 'path') c.path = v
    else if (key === 'secure') c.secure = true
    else if (key === 'httponly') c.httpOnly = true
  }
  return c
}

// 一次性自检：工具箱接口是否还有 401（之前 oauth 被误排除导致）
let kitProbed = false
function probeToolboxAuth(auth) {
  nodeRequestOnce({
    url: 'https://www.kookapp.cn/api/v2/user-oauth/stream-kit-list',
    method: 'POST',
    headers: {
      authorization: auth,
      'user-agent': WIN_UA,
      accept: 'application/json',
      origin: 'https://www.kookapp.cn',
      referer: 'https://www.kookapp.cn/app/index.htm',
      'accept-encoding': 'identity',
    },
    body: null,
    ses: session.defaultSession,
  })
    .then((res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 300)
        LOG('[probe] stream-kit-list ->', res.statusCode, body)
      })
    })
    .catch((e) => LOG('[probe] stream-kit-list 失败', e && e.message))
}

// 透传：走 Node 原生 https，绕开 protocol handler 重入 Chromium 网络栈被禁的问题
const nodeHttps = require('https')
const nodeHttp = require('http')
const { Readable } = require('stream')
const zlib = require('zlib')

function parseSetCookie(raw) {
  if (!raw) return null
  const parts = String(raw).split(';')
  const first = parts.shift() || ''
  const idx = first.indexOf('=')
  if (idx < 1) return null
  const c = { name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim() }
  for (const p of parts) {
    const [k, v] = p.split('=').map((x) => (x == null ? '' : x.trim()))
    const key = k.toLowerCase()
    if (key === 'domain') c.domain = v
    else if (key === 'path') c.path = v
    else if (key === 'secure') c.secure = true
    else if (key === 'httponly') c.httpOnly = true
  }
  return c
}

function nodeRequestOnce({ url, method, headers, body, ses }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? nodeHttp : nodeHttps
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => resolve(res)
    )
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    if (body && body.length) req.write(body)
    req.end()
  })
}

// 跨域走 Node https（net.fetch 会按 CORS 拦截跨域，直接 ERR_BLOCKED_BY_CLIENT）
const BLOCK_FAST = /^(hm\.baidu\.com|sentry\.kookapp\.cn|log\.kookapp\.cn|experience\.kookapp\.com\.cn|quicktracking\.[a-z.]+|o\.alicdn\.com|.*\.mmstat\.com)$/

// 外部请求必须带超时：一个挂住的 <script> 就能把解析器永久阻塞
function fetchWithTimeout(net, url, opts, ms = 6000) {
  return Promise.race([
    net.fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

function nodeProxy(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? nodeHttp : nodeHttps
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers,
      },
      resolve
    )
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
    if (body && body.length) req.write(body)
    req.end()
  })
}


let cachedAuth = null

// 按魔数解压：压缩体 + 丢失 content-encoding 会让前端 JSON.parse 炸掉
// 设置界面里的 Windows 专属文案改成 Linux（只对 CDN 上的 JS 生效）
const WIN_TO_LINUX = [
  [/Windows 设置/g, 'Linux 设置'],
  [/Windows设置/g, 'Linux设置'],
  [/Windows 系统/g, 'Linux 系统'],
  [/Windows系统/g, 'Linux系统'],
  [/Windows 版/g, 'Linux 版'],
  [/仅 Windows/g, '仅 Linux'],
  [/Windows 专属/g, 'Linux 专属'],
  [/Windows 平台/g, 'Linux 平台'],
  // 屏幕分享设置里的 Windows 专属说明（远端下发的 UI 模块，本机改不到源文件）
  [/会在被分享程序或屏幕的四周显示黄色边框（关闭提示框需最新\s*Windows\s*11\s*支持）。?/g,
    'Linux 版不绘制黄色边框提示（Wayland 不允许应用绘制全局边框），该开关仅为兼容保留。'],
  [/（关闭提示框需最新\s*Windows\s*11\s*支持）/g, '（Linux 版不绘制该边框）'],
  [/关闭提示框需最新\s*Windows\s*11\s*支持/g, 'Linux 版不绘制该边框'],
  [/会尝试使用GPU硬件来加速视频编码（支持大部分NVIDIA、AMD和Intel显卡）/g,
    '会尝试用 GPU 硬件加速画面处理（Linux 下由 GStreamer 走 VA-API，显卡不支持时自动回退软件处理）'],
  [/（支持大部分NVIDIA、AMD和Intel显卡）/g, '（走 VA-API，显卡不支持时自动回退软件处理）'],
  [/支持大部分NVIDIA、AMD和Intel显卡/g, '走 VA-API，显卡不支持时自动回退软件处理'],
  [/会尝试使用GPU硬件来加速视频编码/g, '会尝试用 GPU 硬件加速画面处理'],
  [/Windows\s*11/g, 'Linux'],
  // 覆盖层 FAQ 里的 Windows 操作说明
  [/Windows\s*PowerShell/g, '终端'],
  [/按\s*Windows\s*键\s*[+＋]\s*R/g, '打开终端'],
  [/右键点击?[^。；;]{0,8}启动图标[^。；;]{0,12}以管理员身份运行[^。；;]{0,4}/g, '确认客户端已获得屏幕录制与输入设备权限'],
  [/以管理员身份运行/g, '以有权限的账号运行'],
]
function rewritePlatformText(text) {
  let out = text
  for (const [re, to] of WIN_TO_LINUX) out = out.replace(re, to)
  return out
}

const CDN_DUMP = process.env.KOOK_DUMP_CDN === '1'
function dumpCdn(pathname, buf) {
  if (!CDN_DUMP) return
  try {
    const dir = path.join(app.getPath('temp'), 'kook-cdn')
    fs.mkdirSync(dir, { recursive: true })
    const name = pathname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90)
    fs.writeFileSync(path.join(dir, name), buf)
  } catch {}
}

function sniffDecode(buf) {
  try {
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf)
    if (buf.length > 2 && buf[0] === 0x78) return zlib.inflateSync(buf)
  } catch (e) {}
  return buf
}
function isTexty(ct) {
  return /json|text|javascript|css|xml|html/i.test(ct || '')
}

async function passThrough(req, ses) {
  const url = req.url
  const u = new URL(url)

  if (BLOCK_FAST.test(u.hostname)) {
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } })
  }

  const headers = {}
  for (const [k, v] of req.headers) {
    if (/^(host|connection|content-length|accept-encoding|origin|referer|sec-fetch-)/i.test(k)) continue
    headers[k] = v
  }
  headers['origin'] = 'https://www.kookapp.cn'
  headers['referer'] = 'https://www.kookapp.cn/app/index.htm'
  headers['accept-encoding'] = 'identity'

  // token 补洞：v2 的 user-state 等接口客户端不带 authorization，被服务端判"环境异常"
  const authIn = headers['authorization'] || headers['Authorization']
  if (authIn) {
    if (cachedAuth !== authIn) {
      LOG('[auth] 捕获 token', String(authIn).slice(0, 12) + '…')
      if (!kitProbed) {
        kitProbed = true
        probeToolboxAuth(authIn)
      }
    }
    cachedAuth = authIn
  } else if (
    cachedAuth &&
    /^\/api\//.test(u.pathname) &&
    // 只排除真正的登录/授权端点；像 /api/v2/user-oauth/stream-kit-list 这类是要鉴权的，
    // 之前把带 oauth 的整段排掉 → 401 → 工具箱弹「登录环境异常」
    !/\/(user\/)?login\b|qr-code|sync-time|file\/config|oauth\/(token|authorize)/i.test(u.pathname)
  ) {
    headers['authorization'] = cachedAuth
  }

  const jar = await ses.cookies.get({ url })
  if (jar.length) headers['cookie'] = jar.map((c) => `${c.name}=${c.value}`).join('; ')

  // 加速器列表：服务端只接受 POST，旧 web 客户端发的是 GET → 401/404，
  // 而 401 会触发「登录已失效/环境异常」弹窗。这里统一改成 POST。
  let method = req.method
  if (/\/api\/v2\/user-oauth\/stream-kit-list/.test(u.pathname)) method = 'POST'

  let body
  if (!['GET', 'HEAD'].includes(method)) {
    const buf = Buffer.from(await req.arrayBuffer())
    if (buf.length) body = buf
  }

  // 同源（www.kookapp.cn）继续用 net.fetch，跨域一律 Node https
  const authHunter = /\/api\//.test(url)
  if (authHunter && process.env.KOOK_HEADERS === '1') {
    const a = headers['authorization'] || headers['Authorization']
    LOG('[hdr]', url.replace('https://www.kookapp.cn', '').slice(0, 46), 'auth=', a ? String(a).slice(0, 24) + '…' : 'NONE')
  }
  const USERSTATE = /user-state|user\/me|login-qr/.test(url)
  if (USERSTATE) {
    LOG('[probe-req]', url.replace('https://www.kookapp.cn', ''))
    LOG('             cookie=', headers['cookie'] ? 'YES' : 'NO',
        ' auth=', headers['authorization'] ? 'YES' : 'NO',
        ' ua=', String(headers['User-Agent'] || '').slice(0, 40))
  }
  const MSG_DUMP = /message\/create|message\/update/.test(u.pathname)
  const TB_DUMP = /toolbar\/index/.test(u.pathname)
  if (MSG_DUMP || TB_DUMP) {
    let txt = '[no-body]'
    try {
      if (body && body.length) txt = Buffer.from(body).toString('utf8').slice(0, 400)
    } catch {}
    LOG('[msg>] POST', u.pathname, txt)
  }
  let resp = null
  let nodeRes = null
  try {
    if (u.hostname === 'www.kookapp.cn') {
      resp = await fetchWithTimeout(net, url, { method, headers, body, bypassCustomProtocolHandlers: true })
    } else {
      nodeRes = await nodeProxy(url, method, headers, body)
    }
  } catch (e) {
    LOG('[net] 透传失败', u.hostname, e && e.message)
    return new Response('', { status: 502, headers: { 'access-control-allow-origin': '*' } })
  }

  // 统一整理成 Response + cookie 回写
  let rawSetCookie = []
  const out = new Headers()
  let status = 200
  let stream = null

  if (nodeRes) {
    status = nodeRes.statusCode || 200
    rawSetCookie = nodeRes.headers['set-cookie'] || []
    for (const [k, v] of Object.entries(nodeRes.headers)) {
      if (['set-cookie', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue
      if (Array.isArray(v)) v.forEach((x) => out.append(k, x))
      else if (v != null) out.set(k, String(v))
    }
    const ct = nodeRes.headers['content-type'] || ''
    if (isTexty(ct)) {
      const chunks = []
      for await (const c of nodeRes) chunks.push(c)
      let buf = Buffer.concat(chunks)
      buf = sniffDecode(buf)
      // 官方下发的「要检测哪些进程」清单：进程活动引擎靠它决定扫描目标
      if (/\/api\/v3\/game\/get-process-list/.test(u.pathname)) {
        try { LOG('[tasklist] get-process-list ->', buf.toString('utf8').slice(0, 800)) } catch {}
      }
      buf = rewriteUpdatePayload(u.pathname, buf)
      dumpCdn(u.pathname, buf)
      if (/\.js$/i.test(u.pathname)) {
        try {
          const before = buf.toString('utf8')
          const after = rewritePlatformText(before)
          if (after !== before) {
            LOG('[i18n] 平台文案已改写', u.pathname.split('/').slice(-1)[0])
            buf = Buffer.from(after, 'utf8')
          }
        } catch {}
      }
      out.delete('content-encoding')
      out.delete('content-length')
      stream = new Blob([buf]).stream()
    } else {
      stream = Readable.toWeb(nodeRes)
    }
  } else {
    status = resp.status
    rawSetCookie = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : []
    for (const [k, v] of resp.headers) {
      if (['set-cookie', 'content-encoding', 'content-length'].includes(k.toLowerCase())) continue
      out.set(k, v)
    }
    const ct2 = resp.headers.get('content-type') || ''
    if (isTexty(ct2)) {
      let buf = Buffer.from(await resp.arrayBuffer())
      buf = sniffDecode(buf)
      buf = rewriteUpdatePayload(u.pathname, buf)
      out.delete('content-encoding')
      out.delete('content-length')
      stream = new Blob([buf]).stream()
    } else {
      stream = resp.body
    }
  }

  if (USERSTATE) LOG('[probe-res]', status, url.replace('https://www.kookapp.cn', ''))
  out.set('access-control-allow-origin', '*')
  out.set('access-control-allow-credentials', 'true')

  for (const raw of rawSetCookie) {
    const c = parseSetCookie(raw)
    if (!c) continue
    try {
      await ses.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
      })
      LOG('[cookie] 已写入', c.name)
    } catch (e) {}
  }

  return new Response(stream, { status, headers: out })
}

function installProtocolHandler() {
  const { net } = require('electron')
  const ses = session.defaultSession

  ses.protocol.handle('https', async (req) => {
    try {
      const u = new URL(req.url)
      LOG('[req]', req.method, req.url.slice(0, 120))
      if (FIRST_PARTY_HOSTS.has(u.hostname) && u.pathname.startsWith('/__live')) {
        return liveMjpegResponse(u.pathname)
      }
      // 站内页面有两种写法：/app/xxx.htm 和根路径 /picture.htm、/popout.html、/toolbar.htm…
      // 只要本地 webapp 目录里真有这个文件，就交给它，别去请求远端（远端没有 = 白屏）
      const isAppPath = FIRST_PARTY_HOSTS.has(u.hostname) &&
        (u.pathname.startsWith('/app') ||
          (/^\/[A-Za-z0-9_.-]+\.html?$/.test(u.pathname) && fs.existsSync(path.join(WEBAPP, u.pathname.slice(1)))))
      if (isAppPath) {
        const file = u.pathname.startsWith('/app')
          ? serveWebappFile(u.pathname)
          : path.join(WEBAPP, u.pathname.slice(1))
        if (file && fs.existsSync(file)) {
          let body
          try {
            body = fs.readFileSync(file)
          } catch (e) {
            LOG('[disk] 读取失败', file, e && e.message)
            return new Response('', { status: 500 })
          }
          LOG('[disk] ok', path.basename(file), body.length)
          return new Response(new Blob([body]).stream(), {
            status: 200,
            headers: {
              'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
              'content-length': String(body.length),
              'access-control-allow-origin': '*',
            },
          })
        }
        TRACE('miss', req.url)
      }
      return await passThrough(req, ses)
    } catch (e) {
      LOG('protocol handler error', req.url, e && e.message)
      return new Response('', { status: 500 })
    }
  })
  LOG('https 同源拦截已安装：www.kookapp.cn/app/* -> 本地 webapp')
}



// 进程重启计数：坏状态在进程内是粘的，只能换进程
const RELAUNCH_FILE = path.join(app.getPath('temp'), 'kook-linux-relaunch.txt')
function relaunchCount() {
  try {
    return parseInt(fs.readFileSync(RELAUNCH_FILE, 'utf8'), 10) || 0
  } catch {
    return 0
  }
}
function setRelaunchCount(n) {
  try {
    fs.writeFileSync(RELAUNCH_FILE, String(n))
  } catch {}
}

// 偶发失败自愈：检测页面真实状态，崩了/卡了就重载，重载无效则换进程
function installLoadWatchdog(win) {
  if (process.env.KOOK_NO_WATCHDOG === '1') return
  let attempts = 0
  const expr = `(function(){try{return JSON.stringify({rs:document.readyState,t:(document.body&&document.body.innerText||'').replace(/\s+/g,' ').slice(0,60)})}catch(e){return 'err:'+e}})()`
  const tick = async () => {
    if (win.isDestroyed()) return
    let probe = 'timeout'
    try {
      probe = await Promise.race([
        win.webContents.executeJavaScript(expr),
        new Promise((r) => setTimeout(() => r('timeout'), 2000)),
      ])
    } catch (e) {
      probe = 'timeout'
    }
    const bad =
      probe === 'timeout' ||
      String(probe).startsWith('err') ||
      /程序崩溃|连接失败|重新加载|崩溃了/.test(String(probe)) ||
      (String(probe).includes('"rs":"loading"') && attempts === 0)
    if (!bad) {
      LOG('[watchdog] 页面正常', String(probe).slice(0, 60))
      setRelaunchCount(0)
      return
    }
    if (attempts >= 3) {
      const n = relaunchCount()
      if (n >= 8) {
        LOG('[watchdog] 已重启', n, '次仍未恢复，停止自动重试')
        return
      }
      setRelaunchCount(n + 1)
      LOG('[watchdog] 重载无效，重启进程（第', n + 1, '次）')
      app.relaunch({ args: process.argv.slice(1) })
      app.exit(0)
      return
    }
    attempts++
    LOG('[watchdog] 第', attempts, '次重载 · 状态=', String(probe).slice(0, 70))
    try {
      win.webContents.reloadIgnoringCache()
    } catch (e) {
      LOG('[watchdog] 重载失败', e && e.message)
    }
    setTimeout(tick, 6000)
  }
  setTimeout(tick, 7000)
}

function installProbe(win) {
  if (process.env.KOOK_PROBE !== '1') return
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch (e) {
    LOG('[probe] attach 失败', e && e.message)
    return
  }
  const q = `JSON.stringify({rs:document.readyState,res:performance.getEntriesByType('resource').length,pending:performance.getEntriesByType('resource').filter(e=>e.responseEnd===0).map(e=>e.name.split('/').pop()).slice(0,8),kai:typeof Kaiheila,state:document.documentElement.getAttribute('data-kook-startup-resource-state'),txt:(document.body&&document.body.innerText||'').replace(/\s+/g,' ').slice(0,70)})`
  const probe = async (tag) => {
    try {
      const r = await dbg.sendCommand('Runtime.evaluate', { expression: q, returnByValue: true })
      LOG('[probe]', tag, r.result && r.result.value)
    } catch (e) {
      LOG('[probe]', tag, '失败', e && e.message)
    }
  }
  setTimeout(() => probe('t8'), 8000)
  setTimeout(() => probe('t16'), 16000)
  setTimeout(() => probe('t24'), 24000)
}

function installNetLogger(win) {
  if (process.env.KOOK_NETLOG !== '1') return
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch (e) {
    LOG('[net] debugger 挂载失败', e && e.message)
    return
  }
  dbg.sendCommand('Network.enable').catch(() => {})
  dbg.on('message', async (ev, method, params) => {
    try {
      if (method === 'Network.requestWillBeSentExtraInfo') {
        const h = params.headers || {}
        LOG('[net>] headers', 'cookie=', !!(h.Cookie || h.cookie), 'auth=', !!(h.Authorization || h.authorization))
        return
      }
      if (method === 'Network.webSocketCreated') {
        LOG('[ws] 创建', params.url)
        return
      }
      if (method === 'Network.webSocketHandshakeResponseReceived') {
        LOG('[ws] 握手响应', params.response && params.response.status)
        return
      }
      if (method === 'Network.webSocketFrameError' || method === 'Network.webSocketClosed') {
        LOG('[ws]', method, JSON.stringify(params).slice(0, 200))
        return
      }
      if (method === 'Network.responseReceived') {
        const r = params.response
        if (!/kookapp\.cn/.test(r.url)) return
        const sc = r.headers['set-cookie'] || r.headers['Set-Cookie']
        LOG('[net<]', r.status, r.url.replace('https://www.kookapp.cn', '').slice(0, 70), sc ? '| SET-COOKIE' : '')
        return
      }
    } catch (e) {}
  })
  LOG('[net] CDP 抓包已开')
}


// 原生窗口控制：KOOK 自带标题栏 → 去边框 + 按钮接真窗口
// 注意：preload 里 min/max/close 用的是 invoke，不是 send，两条路都要接
function installWindowControls() {
  const BW = require('electron').BrowserWindow
  const target = (e) => BW.fromWebContents(e.sender)

  const acts = {
    WINDOW_MIN: (w) => w.minimize(),
    WINDOW_MAX: (w) => w.maximize(),
    WINDOW_UNMAX: (w) => w.unmaximize(),
    WINDOW_RESTORE: (w) => w.restore(),
    WINDOW_SHOW: (w) => w.show(),
    WINDOW_HIDE: (w) => w.hide(),
    WINDOW_FOCUS: (w) => w.focus(),
    WINDOW_MOVE_TOP: (w) => w.moveTop(),
    WINDOW_MOVE_TOP_FORCE: (w) => w.setAlwaysOnTop(true, 'screen-saver') || w.moveTop(),
    WINDOW_CLOSE: (w) => w.close(),
    WINDOW_SET_ALWAYS_ON_TOP: (w, v) => w.setAlwaysOnTop(!!v),
    WINDOW_CUT: (w) => w.webContents.cut(),
    WINDOW_COPY: (w) => w.webContents.copy(),
    WINDOW_PASTE: (w) => w.webContents.paste(),
    WINDOW_SET_SIZE: (w, width, height) => w.setSize(Number(width) || 1000, Number(height) || 700),
    WINDOW_SET_POSITION: (w, x, y) => w.setPosition(Number(x) || 0, Number(y) || 0),
    WINDOW_SET_TITLE: (w, t) => w.setTitle(String(t == null ? 'KOOK' : t)),
    WINDOW_SET_ZOOM_FACTOR: (w, f) => w.webContents.setZoomFactor(Number(f) || 1),
  }
  const queries = {
    WINDOW_IS_MAX: (w) => w.isMaximized(),
    WINDOW_IS_MIN: (w) => w.isMinimized(),
    WINDOW_IS_VISIBLE: (w) => w.isVisible(),
    WINDOW_IS_FOCUSED: (w) => w.isFocused(),
    WINDOW_GET_SIZE: (w) => w.getSize(),
    WINDOW_GET_ZOOM_FACTOR: (w) => w.webContents.getZoomFactor(),
    WINDOW_GET_CURSOR_POSITION: () => require('electron').screen.getCursorScreenPoint(),
    WINDOW_IS_ALWAY_ON_TOP: (w) => w.isAlwaysOnTop(),
  }

  const run = (ch, fn, e, args) => {
    const w = target(e)
    if (!w) return undefined
    try {
      return fn(w, ...args)
    } catch (err) {
      LOG('window 动作失败', ch, err && err.message)
      return undefined
    }
  }

  for (const [ch, fn] of Object.entries(acts)) {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, (e, ...a) => { run(ch, fn, e, a); return true })
    ipcMain.on(ch, (e, ...a) => { run(ch, fn, e, a); if (e.returnValue === undefined) e.returnValue = true })
  }
  for (const [ch, fn] of Object.entries(queries)) {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, (e, ...a) => run(ch, fn, e, a))
    ipcMain.on(ch, (e, ...a) => { e.returnValue = run(ch, fn, e, a) })
  }

  // MessagePort：进频道/消息流依赖它
  try { ipcMain.removeHandler('CREATE_MESSAGEPORT') } catch {}
  ipcMain.handle('CREATE_MESSAGEPORT', (event, message) => {
    try {
      const { MessageChannelMain } = require('electron')
      const { port1, port2 } = new MessageChannelMain()
      port1.start()
      port1.on('message', (e) => {
        try {
          const d = e.data
          const id = d && (d.id || d.msgid || d.seq)
          if (id != null) port1.postMessage({ id, code: 0, data: null, ack: true })
        } catch {}
      })
      event.sender.postMessage('CREATE_MESSAGEPORT_RESULT', message, [port2])
      LOG('[port] 已下发 MessagePort')
      return true
    } catch (e) {
      LOG('[port] 创建失败', e && e.message)
      return false
    }
  })

  // 屏幕共享选源：webapp 直接 invoke 这个通道（不在 constants 里）
  const registerCapture = (ch) => {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, async (event, opts) => {
      try {
        const { desktopCapturer, screen } = require('electron')
        const types = (opts && opts.types) || ['screen', 'window']
        const sources = await desktopCapturer.getSources({
          types,
          thumbnailSize: (opts && opts.thumbnailSize) || { width: 320, height: 180 },
          fetchWindowIcons: true,
          ...(opts && opts.fetchWindowIcons !== undefined ? { fetchWindowIcons: opts.fetchWindowIcons } : {}),
        })
        const out = sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
          display_id: s.display_id || '',
          appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
        }))
        LOG('[capture] 返回采集源', out.length, '个', JSON.stringify(out.map((o) => o.name)).slice(0, 80))
        return out
      } catch (e) {
        LOG('[capture] 列源失败', e && e.message)
        return []
      }
    })
    ipcMain.on(ch, async (event, opts) => {
      try {
        const { desktopCapturer } = require('electron')
        const types = (opts && opts.types) || ['screen', 'window']
        const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 180 } })
        event.returnValue = sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        }))
      } catch {
        event.returnValue = []
      }
    })
  }
  registerCapture('DESKTOP_CAPTURER_GET_SOURCES')
  registerCapture('DESKTOP_CAPTURER_GET_SOURCES_SYNC')

  // 官方 preload（src/browser_native/preload/window.js:129）用 send 调这个通道设置
  // 窗口初始尺寸，参数是 (width, height)。原先主进程没注册，落进 catch-all 返回 {}，
  // 表现为「设置窗口尺寸」永远空转。这里补上真实实现。
  try { ipcMain.removeAllListeners('WINDOW_SET_SIZE_ORIGIN') } catch {}
  ipcMain.on('WINDOW_SET_SIZE_ORIGIN', (e, width, height) => {
    applyContentSize(BrowserWindow.fromWebContents(e.sender), width, height, LOG)
  })
  LOG('窗口控制已接管', Object.keys(acts).length + Object.keys(queries).length, '个通道（invoke + send 双通道）')
}

function broadcastWindowEvents(win) {
  const emit = (name) => {
    try { win.webContents.send(name) } catch {}
  }
  win.on('maximize', () => emit('WINDOW_ON_MAXIMIZE'))
  win.on('unmaximize', () => emit('WINDOW_ON_UNMAXIMIZE'))
  win.on('minimize', () => emit('WINDOW_ON_MINIMIZE'))
  win.on('restore', () => emit('WINDOW_ON_RESTORE'))
  win.on('show', () => emit('WINDOW_ON_SHOW'))
  // 窗口获得焦点就清掉任务栏提醒
  win.on('focus', () => { try { flashWindow(false) } catch {} })
  // 尺寸变化留痕：排查「打开子窗口后主窗口变小」时，能看到是谁改的
  let lastSize = ''
  win.on('resize', () => {
    try {
      const cur = win.getSize().join('x')
      if (cur !== lastSize) {
        lastSize = cur
        LOG('[win] 主窗口尺寸 ->', cur, win.isMaximized() ? '(最大化)' : '')
      }
    } catch {}
  })
  try { lastSize = win.getSize().join('x') } catch {}
  win.on('hide', () => emit('WINDOW_ON_HIDE'))
  win.on('resize', () => emit('WINDOW_ON_RESIZE'))
  win.on('move', () => emit('WINDOW_ON_MOVE'))
}

// ── 持久 screen-cast 会话：一次授权同时覆盖「显示器 + 窗口」，之后静默复用 ──
// GNOME 的授权对话框本来就只有「窗口 / 显示器」两个页签 + 「记住该选择」，
// 所以用 types=3 + multiple=true 一次把两类都授权掉，再按返回流的 source_type 分流。
// 授权时机：面板第一次打开时申请（不在启动时打扰用户），记住后以后都不再弹。
let portalFrameUrl = ''
let portalFrameAt = 0

// ── 环境能力探测：各个发行版装的东西不一样，缺什么就降级，不要硬失败 ──
function hasCommand(cmd, args) {
  try {
    const r = require('child_process').spawnSync(cmd, args || ['--version'], { stdio: 'ignore', timeout: 3000 })
    if (r.error) return false
    return true
  } catch {
    return false
  }
}
const CAPS = { python: false, pyDbus: false, gst: false, xprop: false, ffmpeg: false }
function detectCaps() {
  CAPS.python = hasCommand('python3', ['-c', 'pass'])
  CAPS.gst = hasCommand('gst-launch-1.0', ['--version'])
  CAPS.xprop = hasCommand('xprop', ['-version'])
  CAPS.ffmpeg = hasCommand('ffmpeg', ['-version'])
  CAPS.pyDbus = CAPS.python && hasCommand('python3', ['-c', 'import dbus, gi'])
  LOG('环境能力: python=' + CAPS.python + ' dbus=' + CAPS.pyDbus + ' gstreamer=' + CAPS.gst + ' xprop=' + CAPS.xprop + ' ffmpeg=' + CAPS.ffmpeg)
  if (!CAPS.pyDbus) LOG('[portal] 缺少 python3-dbus / python3-gi，屏幕分享将退回系统选择框（能装就装：python3-dbus python3-gi）')
  if (!CAPS.gst) LOG('[frames] 缺少 gst-launch-1.0（gstreamer-tools / gstreamer1.0-plugins-*），分享画面将退回系统选择框')
  return CAPS
}

const portal = {
  proc: null,
  streams: [],
  node: null,
  screen: null,     // 显示器流 node
  windows: [],      // 窗口流 node 列表
  sizes: {},        // node -> {w,h} 用来和窗口列表做尺寸匹配
  ready: false,
  hadToken: false,
  retried: false,
  stage: '',
}

function notifyRenderer(ch, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(ch, payload) } catch {}
  }
}

function portalTokenFile() {
  // 用 Electron 的 userData（自己处理 XDG_CONFIG_HOME），别写死 ~/.config
  return path.join(app.getPath('userData'), 'portal-screencast-3.json')
}

// 释放投屏会话：杀掉 portal 进程并删掉恢复令牌。
// 用户要求「关闭分享即取消授权，下次投屏重新申请」，所以不再长期复用授权。
function portalTeardown(reason) {
  const had = !!portal.proc
  try { if (portal.proc) portal.proc.kill('SIGTERM') } catch (e) {}
  portal.proc = null
  portal.ready = false
  portal.stage = ''
  portal.sources = []
  try { fs.rmSync(portalTokenFile(), { force: true }) } catch (e) {}
  if (had) LOG('[portal] 已释放投屏授权（' + reason + '），下次投屏重新申请')
}

function startPortalScreencast() {
  if (process.env.KOOK_NO_PORTAL === '1') return false
  if (!CAPS.pyDbus) {
    // 没有 dbus-python：交给 Chromium 自己的 PipeWire 采集（会弹系统选择框，但能用）
    if (!portal.warned) { portal.warned = true; LOG('[portal] 跳过自建会话（缺依赖），走系统选择框') }
    return false
  }
  // 每次都重新授权：结束旧会话、清掉恢复令牌，系统对话框会重新出现
  if (portal.proc || fs.existsSync(portalTokenFile())) portalTeardown('重新申请')
  const { spawn } = require('child_process')
  const script = path.join(SRC, 'media/portal-screencast.py')
  portal.hadToken = false
  try { portal.hadToken = fs.existsSync(portalTokenFile()) } catch {}
  try {
    portal.proc = spawn('python3', [script, '--types=3'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { KOOK_PORTAL_TOKEN: portalTokenFile() }),
    })
  } catch (e) {
    LOG('[portal] 启动失败', e && e.message)
    return false
  }
  LOG('[portal] 申请 screen-cast 授权', portal.hadToken ? '(复用已记住的授权)' : '(首次：对话框里窗口和显示器都能选，勾上「记住该选择」)')
  let buf = ''
  portal.stage = ''
  portal.proc.stdout.on('data', (d) => {
    buf += String(d)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('{')) continue
      let info = null
      try { info = JSON.parse(line) } catch { continue }
      if (!info) continue
      if (info.ok === false) {
        portal.stage = info.stage || 'unknown'
        LOG('[portal] 授权未完成 stage=' + portal.stage, 'response=' + info.response)
        continue
      }
      const list = Array.isArray(info.streams) ? info.streams : []
      portal.streams = list
      portal.screen = (list.find((x) => x.source_type === 1) || {}).node_id || null
      portal.windows = list.filter((x) => x.source_type === 2).map((x) => x.node_id)
      portal.sizes = {}
      for (const x of list) portal.sizes[x.node_id] = { w: x.width || 0, h: x.height || 0 }
      portal.node = portal.screen || portal.windows[0] || null
      portal.ready = !!portal.node
      LOG('[portal] 会话就绪 共' + list.length + '条',
        list.map((x) => x.node_id + (x.source_type === 2 ? ':窗口' : ':屏幕')).join(' ') || '(空)')
      notifyRenderer('PORTAL_SESSION_READY', { screen: portal.screen, windows: portal.windows })
      ensurePreview(portal.screen)
      for (const n of portal.windows) ensurePreview(n)
    }
  })
  portal.proc.stderr.on('data', (d) => LOG('[portal]', String(d).trim().slice(0, 160)))
  portal.proc.on('exit', (code) => {
    const stage = portal.stage
    LOG('[portal] 会话退出 code=' + code, stage ? '（' + stage + '）' : '')
    portal.proc = null
    portal.ready = false
    portal.node = null
    portal.screen = null
    portal.windows = []
    liveStop('screen')
    liveStop('window')
    // 授权被系统撤销 / token 失效：清掉存档，下次打开面板重新弹一次
    if (code && portal.hadToken && !portal.retried) {
      portal.retried = true
      try { fs.unlinkSync(portalTokenFile()); LOG('[portal] 旧授权已失效，token 已清除') } catch {}
    }
  })
  return true
}

// ── 一路 gst 一条流：每条 portal 流(node) 既能喂面板 MJPEG 预览，也能喂分享画面 ──
const live = {
  proc: {},        // node -> 子进程
  sig: {},         // node -> 参数签名
  last: {},        // node -> 最近一帧 JPEG
  clients: new Set(), // { node, push }
  shareNode: null,
}

let windowSizes = {}

// 面板里选中的是屏幕还是窗口
function kindOfSource(id) {
  const s = String(id || '')
  if (/^window:/.test(s)) return 'window'
  if (/^screen:/.test(s)) return 'screen'
  return 'screen'
}

// 把面板里的项映射到一条 portal 流
function nodeForSource(id) {
  const kind = kindOfSource(id)
  if (kind !== 'window') return portal.screen || portal.windows[0] || null
  const m = /^window:(\d+):/.exec(String(id || ''))
  if (m && portal.windows.length > 1) {
    const want = windowSizes['w' + m[1]]
    if (want) {
      for (const node of portal.windows) {
        const sz = portal.sizes[node]
        if (sz && Math.abs(sz.w - want.w) <= 8 && Math.abs(sz.h - want.h) <= 8) return node
      }
    }
  }
  return portal.windows[0] || portal.screen || null
}

function liveStop(node) {
  const p = live.proc[node]
  if (!p) return
  try { p.kill('SIGKILL') } catch {}
  live.proc[node] = null
  live.sig[node] = ''
  LOG('[frames] node' + node + ' 流已停止')
}

function framePart(jpg) {
  return Buffer.concat([
    Buffer.from('--kookframe\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpg.length + '\r\n\r\n'),
    jpg,
    Buffer.from('\r\n'),
  ])
}

function pushLive(node, jpg) {
  live.last[node] = jpg
  if (live.clients.size) {
    const part = framePart(jpg)
    for (const c of live.clients) {
      if (String(c.node) !== String(node)) continue
      try { c.push(part) } catch { live.clients.delete(c) }
    }
  }
  if (String(live.shareNode) === String(node)) {
    try { notifyRenderer('PORTAL_FRAME', jpg) } catch {}
  }
}

function liveEnsure(node, fps, width, height) {
  if (!node) return false
  if (!CAPS.gst) return false
  const sig = [fps, width, height].join('|')
  if (live.proc[node] && live.sig[node] === sig) return true
  liveStop(node)
  const { spawn } = require('child_process')
  try {
    live.proc[node] = spawn('gst-launch-1.0', [
      '-q', 'pipewiresrc', 'path=' + node, '!', 'videoconvert', '!', 'videoscale',
      '!', 'video/x-raw,width=' + width + ',height=' + height,
      '!', 'videorate', '!', 'video/x-raw,framerate=' + fps + '/1',
      '!', 'jpegenc', 'quality=70', '!', 'fdsink', 'fd=1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    LOG('[frames] 启动失败', e && e.message)
    return false
  }
  live.sig[node] = sig
  LOG('[frames] node' + node + ' 开流', width + 'x' + height, fps + 'fps')
  const p = live.proc[node]
  let buf = Buffer.alloc(0)
  let sent = 0
  let errBuf = ''
  p.stderr.on('data', (d) => {
    errBuf += String(d)
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000)
  })
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]))
      if (start < 0) { if (buf.length > 1) buf = buf.slice(-1); break }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      if (end < 0) { if (start > 0) buf = buf.slice(start); break }
      const jpg = buf.slice(start, end + 2)
      buf = buf.slice(end + 2)
      sent += 1
      if (sent === 1) LOG('[frames] node' + node + ' 首帧已出，长度', jpg.length)
      pushLive(node, jpg)
    }
    if (buf.length > 8 * 1024 * 1024) buf = Buffer.alloc(0)
  })
  p.on('exit', (code) => {
    if (live.proc[node] === p) {
      LOG('[frames] node' + node + ' 采集进程退出', code, '共发帧', sent,
        errBuf ? '错误: ' + errBuf.replace(/\s+/g, ' ').slice(0, 200) : '')
      live.proc[node] = null
      live.sig[node] = ''
    }
  })
  return true
}

// 面板里的低码率预览
function ensurePreview(node) {
  if (!node) return
  if (String(live.shareNode) === String(node)) return
  liveEnsure(node, 4, 640, 360)
}

// MJPEG 长连接：/__live/n<node>.mjpg ；/__live/screen.mjpg 等价于当前显示器流
function liveNodeFromPath(p) {
  const m = /\/__live\/n(\d+)\.mjpg/.exec(String(p))
  if (m) return Number(m[1])
  if (/window/i.test(String(p))) return portal.windows[0] || null
  return portal.screen || portal.windows[0] || null
}

async function liveMjpegHandler(ctx) {
  const node = liveNodeFromPath(ctx.path)
  const res = ctx.res
  res.statusCode = 200
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--kookframe')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Connection', 'close')
  const client = { node, push: (part) => res.write(part) }
  live.clients.add(client)
  LOG('[live] 缩略图连接 node' + node, '客户端', live.clients.size)
  try { if (live.last[node]) res.write(framePart(live.last[node])) } catch {}
  if (!portal.ready) startPortalScreencast()
  ensurePreview(node)
  await new Promise((resolve) => {
    const done = () => resolve()
    try { ctx.req.on('close', done); ctx.req.on('error', done); res.on('close', done) } catch { done() }
  })
  live.clients.delete(client)
  LOG('[live] 缩略图断开 node' + node, '客户端', live.clients.size)
}

// 同源版本：页面跑在 https://www.kookapp.cn 下，缩略图必须同源才不会被 CSP/混合内容拦掉
function liveMjpegResponse(pathname) {
  const node = liveNodeFromPath(pathname)
  let ctrl = null
  let client = null
  const stream = new ReadableStream({
    start(c) { ctrl = c },
    cancel() { if (client) live.clients.delete(client) },
  })
  client = {
    node,
    push: (part) => {
      try { ctrl && ctrl.enqueue(new Uint8Array(part)) } catch {}
    },
  }
  live.clients.add(client)
  LOG('[live] 同源缩略图连接 node' + node, '客户端', live.clients.size)
  try { if (live.last[node]) client.push(framePart(live.last[node])) } catch {}
  if (!portal.ready) startPortalScreencast()
  ensurePreview(node)
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'multipart/x-mixed-replace; boundary=--kookframe',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'access-control-allow-origin': '*',
    },
  })
}

// ── 分享流：面板点「下一步」后由渲染层拉起 ──
function startFrameStream(opts) {
  const node = nodeForSource(pendingCaptureSourceId)
  const fps = Math.max(6, Math.min(15, Number(opts && opts.fps) || 10))
  const w = Number(opts && opts.width) || 1280
  const h = Number(opts && opts.height) || 720
  live.shareNode = node
  liveEnsure(node, fps, w, h)
  if (!live.proc[node]) {
    const other = portal.screen || portal.windows[0] || null
    LOG('[frames] 选中的源没有可用流，退回 node' + other)
    live.shareNode = other
    liveEnsure(other, fps, w, h)
  }
  LOG('[frames] 分享开始 node' + live.shareNode, '选择=' + (pendingCaptureSourceId || '(默认)'))
  return !!live.proc[live.shareNode]
}

function stopFrameStream() {
  const node = live.shareNode
  if (!node) return
  live.shareNode = null
  // 分享结束降到预览码率，面板里的缩略图继续动
  if (live.clients.size) ensurePreview(node)
  else liveStop(node)
  // 用户要求：停止分享就取消投屏授权，下次投屏重新申请
  try { portalTeardown('分享结束') } catch (e) {}
  LOG('[frames] 分享结束 node' + node)
}

// ────────────── 3.5 进程列表：Linux 真枚举（用户动态/游戏识别用）──────────────
let activityCatalog = []
function installTaskList() {
  // 官方通道（TASKLIST_INFO_CHANGE / TASKLIST_QUERY_SIMPLE / TASKLIST_CHANGE ...）全部由
  // src/controllers/taskList/taskList-data-manage.js 自己注册 —— 那里的数据源已经接到
  // Linux 的 /proc 实现上。这里绝不能再注册同名通道：重复 ipcMain.handle 会让官方模块
  // 初始化时直接抛错，连带整个进程活动引擎（base/process-activity）失效。
  // 本函数只负责：把官方活动库的进程名喂给 /proc 枚举，以及暴露自己的 ACTIVITY_* 通道。
  const procs = require(path.join(SRC, 'controllers/taskList/process-windows-linux'))
  const handle = (ch, fn) => {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, async (event, payload) => {
      try { return fn(payload, event) } catch (e) {
        LOG('[tasklist] 失败', ch, e && e.message)
        return []
      }
    })
  }

  // 官方活动库（游戏/应用识别表）：名字有的是原始进程名，有的是干净名，
  // 拉一次给进程枚举用，才能和客户端里显示的“已识别动态”对上。
  // 渲染层拿到的活动库才是“全”的（带登录态和客户端标识），优先用它
  try { ipcMain.removeAllListeners('ACTIVITY_SET_CATALOG') } catch {}
  ipcMain.on('ACTIVITY_SET_CATALOG', (event, list) => {
    try {
      if (!Array.isArray(list) || !list.length) return
      const names = []
      activityCatalog = list.map((g) => ({
        names: (Array.isArray(g.process_name) ? g.process_name : String(g.process_name || '').split(','))
          .map((n) => String(n).toLowerCase().replace(/\.exe$/, '')).filter(Boolean),
        name: g.name || '',
        icon: g.icon || '',
      }))
      for (const g of activityCatalog) for (const n of g.names) names.push(n)
      if (names.length) {
        procs.setKnownProcessNames(names)
        LOG('[tasklist] 活动库（来自渲染层）', activityCatalog.length, '条')
      }
    } catch (e) { LOG('[tasklist] 活动库导入失败', e && e.message) }
  })

  const loadKnownNames = async () => {
    try {
      const { net } = require('electron')
      const r = await net.fetch('https://www.kookapp.cn/api/v2/games', { credentials: 'include' })
      const list = await r.json()
      const names = []
      for (const g of Array.isArray(list) ? list : []) {
        const pn = g && g.process_name
        for (const n of Array.isArray(pn) ? pn : String(pn || '').split(',')) {
          if (n) names.push(String(n))
        }
      }
      if (names.length) {
        procs.setKnownProcessNames(names)
        activityCatalog = (Array.isArray(list) ? list : []).map((g) => ({
          names: (Array.isArray(g.process_name) ? g.process_name : String(g.process_name || '').split(','))
            .map((n) => String(n).toLowerCase().replace(/\.exe$/, '')).filter(Boolean),
          name: g.name || '',
          icon: g.icon || '',
        }))
        LOG('[tasklist] 已加载官方活动库进程名', names.length, '条')
      }
    } catch (e) {
      LOG('[tasklist] 加载官方活动库失败', e && e.message)
    }
  }

  // 本地识别出的“正在运行的活动”：给渲染层填「已识别动态」用
  handle('ACTIVITY_RUNNING_APPS', () => {
    try {
      const list = procs.getAllProcessSimpleInfo()
      LOG('[tasklist] 活动库条目', activityCatalog.length, '进程', list.length,
        '样例', JSON.stringify((activityCatalog.find((g) => g.names.includes('wechatlinux_x86_64')) || {}).names || null))
      const out = []
      for (const p of list) {
        const pn = String(p.ProcessName || '').toLowerCase().replace(/\.exe$/, '')
        const hit = activityCatalog.find((g) => g.names.includes(pn))
        out.push({
          processName: pn,
          name: hit ? hit.name : (p.ProcessName || pn),
          icon: hit ? hit.icon : '',
          matched: !!hit,
        })
      }
      // 官方库里认得的排前面
      out.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0))
      return out
    } catch (e) {
      LOG('[tasklist] 活动列表失败', e && e.message)
      return []
    }
  })

  // ── 官方进程列表通道 ──
  // 官方 src/controllers/taskList/taskList-data-manage.js 在这份构建里没有进启动链，
  // 所以这几个通道没人注册。这里补上，但数据一律走官方 taskList-execute 的
  // getWinProcess / getWinProcessSimple（它已经接到 /proc 适配层）—— 过滤规则、
  // 音乐进程名单、窗口标题合并全部沿用官方逻辑，不做第二套。
  let exe = null
  try {
    exe = require(path.join(SRC, 'controllers/taskList/taskList-execute'))
  } catch (e) {
    LOG('[tasklist] taskList-execute 加载失败', e && e.message)
  }
  const CH = require(path.join(SRC, 'browser_native/constants')).IPCEventName

  if (exe) {
    handle(CH.TASKLIST_INFO_CHANGE, () => {
      const list = exe.getWinProcess()
      LOG('[tasklist] TASKLIST_INFO_CHANGE ->', list.length)
      return list
    })
    handle(CH.TASKLIST_QUERY_SIMPLE, () => {
      const list = exe.getWinProcessSimple()
      LOG('[tasklist] TASKLIST_QUERY_SIMPLE ->', list.length,
        JSON.stringify(list.slice(0, 8).map((x) => ({
          n: x.ProcessName, t: (x.WindowTitleList || []).length,
        }))))
      return list
    })
    if (CH.TASKLIST_GET_GAME_CHANNEL_FILE_CONTENT) {
      handle(CH.TASKLIST_GET_GAME_CHANNEL_FILE_CONTENT, (params) => {
        const o = params || {}
        try {
          if (!o.pid) return ''
          const info = exe.getProcessDetailedInfo([o.pid]) || []
          const dir = info[0] && info[0].path ? path.dirname(info[0].path) : ''
          if (!dir) return ''
          return fs.readFileSync(path.join(dir, o.file_path || '', o.file_name || ''), 'utf8')
        } catch {
          return ''
        }
      })
    }
    // sendSync 通道：官方用 ipcMain.on + event.returnValue
    if (CH.TASKLIST_GET_ALL_WINDOW_TITLE) {
      try { ipcMain.removeAllListeners(CH.TASKLIST_GET_ALL_WINDOW_TITLE) } catch {}
      ipcMain.on(CH.TASKLIST_GET_ALL_WINDOW_TITLE, (event, pidList) => {
        try { event.returnValue = exe.getAllWindowTitle(pidList) } catch { event.returnValue = [] }
      })
    }
  }

  // 渲染层要求开始轮询时，按官方节奏推 TASKLIST_CHANGE
  let timer = null
  let sender = null
  try { ipcMain.removeAllListeners(CH.TASKLIST_STATE_CHANGE) } catch {}
  ipcMain.on(CH.TASKLIST_STATE_CHANGE, (event, payload) => {
    const { queue, newState } = payload || {}
    if (queue !== 'checkTaskList') return
    if (newState === 'running') {
      sender = event.sender
      if (!timer && exe) {
        const tick = () => {
          if (!sender || sender.isDestroyed()) return
          try { sender.send(CH.TASKLIST_CHANGE, exe.getWinProcess()) } catch {}
        }
        tick()
        timer = setInterval(tick, 3000)
        LOG('[tasklist] 进程轮询已启动')
      }
    } else if (newState === 'stopped') {
      if (timer) { clearInterval(timer); timer = null }
      sender = null
      LOG('[tasklist] 进程轮询已停止')
    }
  })

  loadKnownNames()
  setTimeout(loadKnownNames, 30000)
  LOG('活动库已挂到 Linux /proc 枚举；官方 TASKLIST 通道用官方 getWinProcess 实现')
}

// ────────────── 3.6 屏幕分享：真实取源 + 录制管理 ──────────────
let pendingCaptureSourceId = null
let pendingCaptureName = null

function installGoliveCapture() {
  const handle = (ch, fn) => {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, async (event, opts) => {
      try { return await fn(opts, event) } catch (e) {
        LOG('[golive] 通道失败', ch, e && e.message)
        return null
      }
    })
  }

  // 自己枚举屏幕与窗口：完全不碰 portal，所以列源时系统不弹框。
  const { screen: elecScreen } = require('electron')
  const { execFileSync } = require('child_process')

  const listScreensNative = () => {
    let displays = []
    try { displays = elecScreen.getAllDisplays() } catch { displays = [] }
    if (!displays.length) displays = [{ size: { width: 1920, height: 1080 }, scaleFactor: 1, id: 0, label: '' }]
    return displays.map((d, i) => ({
      id: 'screen:' + i + ':0',
      sourceId: 'screen:' + i + ':0',
      source_id: 'screen:' + i + ':0',
      name: '屏幕 ' + (i + 1) + ' (' + d.size.width + '×' + d.size.height + ')' + (d.label ? ' ' + d.label : ''),
      title: '屏幕 ' + (i + 1),
      source_title: '屏幕 ' + (i + 1),
      thumbnail: '',
      display_id: String(d.id || i),
      type: 'monitor',
    }))
  }

  const xprop = (args) => {
    try { return execFileSync('xprop', args, { encoding: 'utf8', timeout: 2000 }) } catch { return '' }
  }
  const listWindowsNative = () => {
    // xprop 不是每个发行版都装；缺了就用 python-xlib 兜底（win-geom.py 也带了标题）
    if (!CAPS.xprop) {
      return listWindowGeomRaw().map((g) => ({
        id: 'window:' + g.id + ':0',
        sourceId: 'window:' + g.id + ':0',
        source_id: 'window:' + g.id + ':0',
        name: g.name || ('窗口 ' + g.id),
        title: g.name || ('窗口 ' + g.id),
        source_title: g.name || ('窗口 ' + g.id),
        thumbnail: '',
        window_id: String(g.id),
        pid: 0,
        type: 'window',
      })).filter((w) => w.name && !/^KOOK/i.test(w.name))
    }
    const root = xprop(['-root', '_NET_CLIENT_LIST'])
    const ids = [...String(root).matchAll(/0x[0-9a-fA-F]+/g)].map((m) => m[0])
    const out = []
    for (const id of ids) {
      const info = xprop(['-id', id, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID'])
      if (!info) continue
      const nameMatch = /_NET_WM_NAME(?:\([^)]*\))?\s*=\s*"([^"]*)"/.exec(info) || /WM_NAME(?:\([^)]*\))?\s*=\s*"([^"]*)"/.exec(info)
      const clsMatch = /WM_CLASS(?:\([^)]*\))?\s*=\s*"?([^",]*)"?/.exec(info)
      const pidMatch = /_NET_WM_PID(?:\([^)]*\))?\s*=\s*(\d+)/.exec(info)
      const title = (nameMatch && nameMatch[1]) || (clsMatch && clsMatch[1]) || ''
      if (!title) continue
      if (/^(KOOK|kook)/.test(title)) continue
      out.push({
        id: 'window:' + parseInt(id, 16) + ':0',
        sourceId: 'window:' + parseInt(id, 16) + ':0',
        source_id: 'window:' + parseInt(id, 16) + ':0',
        name: title,
        title,
        source_title: title,
        thumbnail: '',
        window_id: String(parseInt(id, 16)),
        pid: pidMatch ? Number(pidMatch[1]) : 0,
        type: 'window',
      })
    }
    return out
  }

  const list = async (types) => {
    if (types.includes('screen') && types.length === 1) return listScreensNative()
    if (types.includes('window') && types.length === 1) return listWindowsNative()
    const { desktopCapturer } = require('electron')
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })
    return sources.map((s) => ({
      id: s.id,
      sourceId: s.id,
      source_id: s.id,
      name: s.name,
      title: s.name,
      source_title: s.name,
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      display_id: s.display_id || '',
    }))
  }

  // 无 xprop 时的窗口枚举来源（python-xlib）
  const listWindowGeomRaw = () => {
    try {
      const out = execFileSync('python3', [path.join(SRC, 'media/win-geom.py')], { encoding: 'utf8', timeout: 4000 })
      return JSON.parse(String(out || '[]')) || []
    } catch {
      return []
    }
  }

  // 窗口几何（XWayland）：给面板里的窗口项配上尺寸，用于和 portal 回来的流对号入座
  let geomCache = null
  let geomAt = 0
  const listWindowGeom = () => {
    if (geomCache && Date.now() - geomAt < 10000) return geomCache
    try {
      const out = execFileSync('python3', [path.join(SRC, 'media/win-geom.py')], { encoding: 'utf8', timeout: 4000 })
      geomCache = JSON.parse(String(out || '[]')) || []
    } catch { geomCache = [] }
    geomAt = Date.now()
    return geomCache
  }

  let srcCache = null
  let srcCacheAt = 0
  const SRC_TTL = Number(process.env.KOOK_SRC_TTL) || 8000

  // 缩略图直接给本地 MJPEG 地址：<img> 自己逐帧刷新，面板里就是实时画面，
  // 不需要去猜面板的 DOM 结构，也不用渲染层反复取图。
  // 用相对地址：页面在 https://www.kookapp.cn 下（同源拦截），本地态是 127.0.0.1，两边都通
  const liveUrl = (node) => (node ? '/__live/n' + node + '.mjpg?t=' + Date.now() : '')

  handle('GOLIVE_CAPTURE_SOURCES', async (opts) => {
    // 授权时机：面板打开 / 切页签时才申请；记住过的授权不会再弹，启动时也绝不打扰
    if (!portal.ready) startPortalScreencast()
    const force = !!(opts && opts.force)
    if (!force && srcCache && Date.now() - srcCacheAt < SRC_TTL) return srcCache
    const [screens, windows] = await Promise.all([list(['screen']), list(['window'])])

    const geom = listWindowGeom()
    windowSizes = {}
    for (const g of geom) windowSizes['w' + g.id] = { w: g.w, h: g.h }

    if (screens[0]) screens[0].thumbnail = liveUrl(portal.screen)
    // 窗口项：按尺寸把授权回来的窗口流和列表里的窗口对上号，每项单独一条实时预览
    const claimed = new Set()
    const freeWindows = portal.windows.slice()
    for (const w of windows) {
      const g = geom.find((x) => x.id === Number(w.window_id))
      w.rect = g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null
      let node = null
      if (g) {
        node = freeWindows.find((n) => {
          const sz = portal.sizes[n]
          return sz && Math.abs(sz.w - g.w) <= 8 && Math.abs(sz.h - g.h) <= 8
        }) || null
      }
      if (!node) node = freeWindows.find((n) => !claimed.has(n)) || null
      if (node) claimed.add(node)
      w.thumbnail = liveUrl(node)
      w.portal_node = node
    }

    srcCache = { screens, windows }
    srcCacheAt = Date.now()
    LOG('[golive] 列源 -> 屏幕', screens.length, '窗口', windows.length,
      portal.ready ? '(已授权 显示器=' + (portal.screen || '-') + ' 窗口流=' + portal.windows.length + ')' : '(待授权)')
    return srcCache
  })

  // 逐帧预览：拿到当前最新一帧，面板轮询时也能看到动
  handle('GOLIVE_VIDEO_FRAME', async () => {
    const jpg = live.last[portal.screen] || live.last[portal.windows[0]] || Object.values(live.last)[0]
    return jpg ? 'data:image/jpeg;base64,' + jpg.toString('base64') : ''
  })

  // 用户在面板里选定的源 → 交给 getDisplayMedia 处理器
  handle('GOLIVE_SET_PENDING_SOURCE', (o) => {
    pendingCaptureSourceId = (o && (o.id || o.sourceId)) || null
    pendingCaptureName = (o && (o.name || o.title)) || null
    LOG('[golive] 选定源', pendingCaptureSourceId, pendingCaptureName || '')
    return true
  })
  handle('GOLIVE_GET_PENDING_SOURCE', () => pendingCaptureSourceId)

  // 选中的窗口在屏幕上的位置：没有窗口流时，从整屏流里裁出这个窗口来分享
  handle('GOLIVE_PENDING_RECT', () => {
    try {
      const id = pendingCaptureSourceId
      if (!id || !/^window:/.test(String(id))) return null
      const w = (srcCache && srcCache.windows || []).find((x) => x.id === id)
      if (!w || !w.rect) return null
      const d = elecScreen.getPrimaryDisplay()
      return { rect: w.rect, screen: { w: d.size.width, h: d.size.height } }
    } catch {
      return null
    }
  })
  handle('PORTAL_CAPTURE_START', (o) => startFrameStream(o))
  handle('PORTAL_CAPTURE_STOP', () => { stopFrameStream(); return true })

  LOG('屏幕分享取源通道已接管')
}

// ────────────────────── 3.7 屏幕覆盖（overlay）──────────────────────
// 原版这套依赖 Windows 的原生 overlay（agora/volc），Linux 上没有；
// 这里自己做一个真窗口：透明、无边框、置顶、鼠标穿透，内容是「谁在说话」。
// 能力边界（如实反映，不假装支持）：
//   X11        —— 可以覆盖桌面和其它应用（包括游戏）
//   Wayland    —— 普通应用无法拿到全局置顶层（协议不允许），只能覆盖 KOOK 自己的窗口
const overlay = {
  win: null,
  cfg: {
    position: { isRight: false, isBottom: false },
    scale: 1,
    displayType: 1, // 1=总是 2=只在说话时
  },
  users: [],
  lastCount: -1,
}

function overlayMode() {
  const forced = String(process.env.KOOK_OVERLAY || '').toLowerCase()
  if (forced === 'off') return 'off'
  if (forced === 'global' || forced === 'inapp') return forced
  if (process.env.XDG_SESSION_TYPE === 'x11' || /x11/i.test(process.env.KOOK_OZONE_PLATFORM || '')) return 'global'
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') return 'inapp'
  return 'global'
}

function overlayCaps() {
  const mode = overlayMode()
  return {
    mode,                                   // global | inapp | off
    inapp: mode !== 'off',                  // 覆盖 KOOK 自己的窗口：任何桌面都能做
    global: mode === 'global',              // 覆盖桌面/游戏：仅 X11 可行
    reason: mode === 'global' ? '' : 'Wayland 下应用无法绘制全局置顶层，只能覆盖 KOOK 自身窗口',
  }
}

function overlayBoundsFor(display) {
  const d = display || require('electron').screen.getPrimaryDisplay()
  const area = d.workArea
  const scale = Number(overlay.cfg.scale) || 1
  const W = Math.min(560, Math.round(420 * Math.min(1.6, Math.max(0.8, scale))))
  const H = Math.min(240, Math.round(110 * Math.min(1.6, Math.max(0.8, scale))))
  const pad = 24
  const right = overlay.cfg.position && overlay.cfg.position.isRight
  const bottom = overlay.cfg.position && overlay.cfg.position.isBottom
  // 默认左上角，和面板里的示意图一致；isRight/isBottom 反过来
  const x = right ? area.x + area.width - W - pad : area.x + pad
  const y = bottom ? area.y + area.height - H - pad : area.y + pad
  return { x, y, width: W, height: H }
}

function overlayPush() {
  if (!overlay.win || overlay.win.isDestroyed()) return
  try { overlay.win.webContents.send('OVERLAY_CONFIG', overlay.cfg) } catch {}
  try { overlay.win.webContents.send('OVERLAY_USERS', overlay.users) } catch {}
}

function overlayCreate(opts) {
  if (overlayMode() === 'off') return ''
  if (overlay.win && !overlay.win.isDestroyed()) {
    overlayPush()
    return String(overlay.win.id)
  }
  const { BrowserWindow, screen } = require('electron')
  const b = overlayBoundsFor(screen.getPrimaryDisplay())
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    acceptFirstMouse: false,
    webPreferences: {
      preload: path.join(SRC, 'renderer/linux-overlay/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  overlay.win = win
  try {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // 鼠标穿透：完全不挡用户操作
    win.setIgnoreMouseEvents(true, { forward: true })
  } catch (e) { LOG('[overlay] 置顶设置失败', e && e.message) }
  win.webContents.once('did-finish-load', () => {
    LOG('[overlay] 窗口就绪 mode=' + overlayMode())
    if (process.env.KOOK_OVERLAY_TEST === '1' && !overlay.users.length) {
      overlay.users = [
        { name: 'KANNI', talking: true },
        { name: '小助手', talking: false, color: '#3ba55d' },
        { name: 'Teammate', talking: true, color: '#f0b232' },
      ]
    }
    overlayPush()
    if (!(opts && opts.hidden)) win.showInactive()
    if (process.env.KOOK_OVERLAY_SHOT) {
      setTimeout(async () => {
        try {
          if (!win.isVisible()) win.showInactive()
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.KOOK_OVERLAY_SHOT, img.toPNG())
          LOG('[overlay] 自测截图 ->', process.env.KOOK_OVERLAY_SHOT, img.getSize().width + 'x' + img.getSize().height)
        } catch (e) { LOG('[overlay] 截图失败', e && e.message) }
      }, 1500)
    }
  })
  win.on('closed', () => { LOG('[overlay] 窗口已关闭'); overlay.win = null })
  win.on('blur', () => { try { overlay.win && overlay.win.setAlwaysOnTop(true, 'screen-saver') } catch {} })
  win.loadFile(path.join(SRC, 'renderer/linux-overlay/index.html'))
  return String(win.id)
}

// 应用会在不需要时调 close：这里只隐藏，别把窗口销毁掉（否则会跟应用的生命周期打架）
function overlayHide(why) {
  try {
    if (overlay.win && !overlay.win.isDestroyed() && overlay.win.isVisible()) {
      overlay.win.hide()
      LOG('[overlay] 隐藏窗口 <-', why)
    }
  } catch {}
  return true
}

function overlayDestroy() {
  if (!overlay.win || overlay.win.isDestroyed()) return true
  try { LOG('[overlay] 关闭窗口 <-', (new Error().stack || '').split('\n')[2].trim().slice(0, 80)) } catch {}
  try { overlay.win.destroy() } catch {}
  overlay.win = null
  overlay.lastCount = -1
  return true
}

function overlaySetUsers(list) {
  const arr = Array.isArray(list) ? list : []
  overlay.users = arr.slice(0, 20)
  const talking = overlay.users.filter((u) => u && u.talking).length
  // 只在「只在说话时」模式下按人数显隐；总是模式常显
  if (overlay.win && !overlay.win.isDestroyed()) {
    const cfg = overlay.cfg.displayType
    const shouldShow = cfg === 1 ? overlay.users.length > 0 : talking > 0
    if (shouldShow && !overlay.win.isVisible()) overlay.win.showInactive()
    if (!shouldShow && overlay.win.isVisible()) overlay.win.hide()
  }
  if (talking !== overlay.lastCount) {
    overlay.lastCount = talking
    LOG('[overlay] 说话中', talking, '人在麦上', overlay.users.length)
  }
  overlayPush()
}

function installOverlay() {
  const handle = (ch, fn) => {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, (event, ...args) => {
      try { return fn(...args) } catch (e) {
        LOG('[overlay] 通道失败', ch, e && e.message)
        return null
      }
    })
    try { ipcMain.removeAllListeners(ch) } catch {}
    ipcMain.on(ch, (event, ...args) => {
      try {
        const r = fn(...args)
        if (event.returnValue === undefined) event.returnValue = r === undefined ? true : r
      } catch (e) { if (event.returnValue === undefined) event.returnValue = true }
    })
  }

  handle('OVERLAY_START_CREATE_WIN', () => overlayCreate())
  handle('OVERLAY_START_CLOSE_WIN', () => overlayHide('START_CLOSE'))
  handle('OVERLAY_WIDNOW_CREATE', (o) => overlayCreate(o))
  handle('OVERLAY_WIDNOW_CLOSE', () => overlayHide('WIDNOW_CLOSE'))
  handle('OVERLAY_WIDNOW_DESTROY', () => overlayDestroy())
  handle('OVERLAY_COUNTDOWN_PRECREATE', () => overlayCreate({ hidden: true }))
  handle('OVERLAY_COUNTDOWN_OPEN', () => { overlayCreate(); try { overlay.win && overlay.win.showInactive() } catch {}; return true })
  handle('GAME_OVERLAY_CREATE_WIN', () => overlayCreate())
  handle('GAME_OVERLAY_CLOSE_WIN', () => overlayHide('GAME_CLOSE'))
  handle('OVERLAY_WINDOW_EXISTS_SYNC', () => !!(overlay.win && !overlay.win.isDestroyed()))
  handle('OVERLAY_WINDOW_GET_BOUNDS', (o) => {
    // 带 id 的是「按 id 找自己」：语音悬浮工具栏（desktop-toolbar）就靠这个拿位置
    // 和高度来决定展开/收起。不带 id 的才是游戏内覆盖那一套。
    try {
      const id = o && o.id
      const map = globalThis.__kookChildWins
      if (id && map && map.has(id)) {
        const w = map.get(id)
        if (w && !w.isDestroyed()) return w.getBounds()
      }
    } catch (e) {}
    try { return overlay.win && !overlay.win.isDestroyed() ? overlay.win.getBounds() : overlayBoundsFor() } catch { return overlayBoundsFor() }
  })
  handle('OVERLAY_WINDOW_SET_BOUNDS', (b) => {
    if (!b) return true
    // 工具栏展开成 72px / 收起成 46px 都是走这条，按 id 落到对应子窗口
    try {
      const id = b.id
      const map = globalThis.__kookChildWins
      if (id && map && map.has(id)) {
        const w = map.get(id)
        if (w && !w.isDestroyed()) {
          const cur = w.getBounds()
          w.setBounds({
            x: Number.isFinite(b.x) ? Math.round(b.x) : cur.x,
            y: Number.isFinite(b.y) ? Math.round(b.y) : cur.y,
            width: Number.isFinite(b.width) && b.width ? Math.round(b.width) : cur.width,
            height: Number.isFinite(b.height) && b.height ? Math.round(b.height) : cur.height,
          })
          return true
        }
      }
    } catch (e) {}
    if (b.position) overlay.cfg.position = Object.assign({}, overlay.cfg.position, b.position)
    if (b.scale != null) overlay.cfg.scale = Number(b.scale) || 1
    if (b.displayType != null) overlay.cfg.displayType = Number(b.displayType) || 1
    try {
      const nb = overlayBoundsFor()
      if (overlay.win && !overlay.win.isDestroyed()) overlay.win.setBounds(nb)
      overlayPush()
    } catch {}
    return true
  })
  handle('OVERLAY_WINDOW_HIDE', () => { try { overlay.win && overlay.win.hide() } catch {}; return true })
  handle('OVERLAY_WINDOW_SHOW', () => { overlayCreate(); try { overlay.win && overlay.win.showInactive() } catch {}; return true })
  handle('OVERLAY_WINDOW_SET_MOVE_TOP_CHECK', () => {
    try { overlay.win && overlay.win.setAlwaysOnTop(true, 'screen-saver') } catch {}
    return true
  })
  // 配置：原版从 appConfig 读，这里接受渲染层推过来的值
  handle('OVERLAY_SET_CONFIG', (c) => {
    if (c && typeof c === 'object') overlay.cfg = Object.assign({}, overlay.cfg, c)
    overlayPush()
    return true
  })
  handle('OVERLAY_GET_CAPS', () => overlayCaps())

  // 谁在说话：渲染层采集后推给主进程
  try { ipcMain.removeAllListeners('OVERLAY_TALK_LIST') } catch {}
  ipcMain.on('OVERLAY_TALK_LIST', (event, list) => overlaySetUsers(list))

  LOG('屏幕覆盖通道已接管 mode=' + overlayMode())
}

// ────────────────────── 3.8 通知适配（跨发行版）──────────────────────
// 系统通知走系统通知服务（org.freedesktop.Notifications）；没有服务的极简桌面，
// 退回「任务栏闪烁 + 标题前缀」保证仍然有提醒。
function hasNotifyDaemon() {
  try {
    const r = require('child_process').spawnSync('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.GetNameOwner',
      'org.freedesktop.Notifications',
    ], { encoding: 'utf8', timeout: 3000 })
    return !!(r.stdout && r.stdout.trim() && !/Error/i.test(r.stdout))
  } catch {
    return false
  }
}
let notifyDaemon = false
let flashTimer = null
let baseTitle = 'KOOK'

function flashWindow(on) {
  const w = mainWin && !mainWin.isDestroyed() ? mainWin : null
  if (!w) return false
  try {
    if (on) {
      w.flashFrame(true)
      // Wayland 下 urgency hint 无效：再用标题前缀提醒一次
      if (!notifyDaemon || process.env.WAYLAND_DISPLAY) {
        try { w.setTitle('● ' + baseTitle) } catch {}
      }
    } else {
      w.flashFrame(false)
      try { w.setTitle(baseTitle) } catch {}
    }
    return true
  } catch (e) {
    LOG('[notify] 闪烁失败', e && e.message)
    return false
  }
}

function showNativeNotification(payload) {
  const o = payload || {}
  try {
    const { Notification } = require('electron')
    if (!Notification.isSupported()) return false
    const n = new Notification({
      title: String(o.title || 'KOOK'),
      body: String(o.body || ''),
      icon: o.icon || undefined,
      silent: !!o.silent,
      timeoutType: 'default',
    })
    n.on('click', () => {
      try {
        const w = mainWin && !mainWin.isDestroyed() ? mainWin : null
        if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus() }
        flashWindow(false)
        notifyRenderer('NOTIFICATION_CLICKED', { id: o.id || '' })
      } catch {}
    })
    n.show()
    return true
  } catch (e) {
    LOG('[notify] 系统通知失败', e && e.message)
    return false
  }
}

function installNotifications() {
  notifyDaemon = hasNotifyDaemon()
  LOG('[notify] 系统通知服务', notifyDaemon ? '可用' : '不可用（退回闪烁 + 标题提醒）')

  // 页面里的 new Notification() 需要显式放行，不同发行版的权限默认值不一致
  try {
    const ses = session.defaultSession
    // 权限不能无条件放行：只认官方域名与本机资源服务发起的请求。
    // 官方 webapp 从 https://www.kookapp.cn/app/* 加载，静态资源由本地同源拦截
    // 或 127.0.0.1 上的本地服务提供，正常场景不会落在白名单之外。
    // 加这层是因为一旦 webapp 里出现 XSS 或被注入的内容，无来源校验的
    // media / display-capture / clipboard-read 会被直接拿去用。
    const ORIGIN_OK = (u) => {
      const url = String(u || '')
      return (
        /^https:\/\/([a-z0-9-]+\.)*kookapp\.cn([/?#]|$)/i.test(url) ||
        /^http:\/\/127\.0\.0\.1(:\d+)?([/?#]|$)/i.test(url) ||
        /^http:\/\/localhost(:\d+)?([/?#]|$)/i.test(url) ||
        /^(file|devtools):/i.test(url)
      )
    }
    const PERMISSIONS = ['notifications', 'media', 'display-capture', 'clipboard-read',
      'clipboard-sanitized-write', 'fullscreen']
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const src = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || ''
      if (!ORIGIN_OK(src)) {
        LOG('[perm] 拒绝来源不明的权限请求', permission, String(src).slice(0, 80))
        return callback(false)
      }
      if (permission === 'background-sync' || PERMISSIONS.includes(permission)) return callback(true)
      return callback(false)
    })
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      const src = requestingOrigin || (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || ''
      if (!ORIGIN_OK(src)) return false
      return PERMISSIONS.includes(permission)
    })
  } catch (e) { LOG('[notify] 权限策略设置失败', e && e.message) }

  const handle = (ch, fn) => {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, (e, ...a) => { try { return fn(...a) } catch (err) { LOG('[notify] 通道失败', ch, err && err.message); return false } })
    try { ipcMain.removeAllListeners(ch) } catch {}
    ipcMain.on(ch, (e, ...a) => { try { const r = fn(...a); if (e.returnValue === undefined) e.returnValue = r } catch { if (e.returnValue === undefined) e.returnValue = false } })
  }

  // 任务栏闪烁：Electron 在 X11 上是 urgency hint，Wayland 会退回标题提醒
  for (const ch of ['WINDOW_FLASH_FRAME', 'FLASH_FRAME', 'WINDOW_REQUEST_ATTENTION', 'REQUEST_ATTENTION']) {
    handle(ch, (v) => {
      const on = v === undefined ? true : !!(v && v.flash !== false && v !== false && v !== 0)
      if (on) {
        if (flashTimer) clearTimeout(flashTimer)
        flashTimer = setTimeout(() => flashWindow(false), 15000)
      }
      return flashWindow(on)
    })
  }
  // 未读数角标（Unity/KDE 有效，GNOME 无效但不报错）
  handle('WINDOW_SET_BADGE', (n) => {
    try {
      const { app } = require('electron')
      if (typeof app.setBadgeCount === 'function') return app.setBadgeCount(Number(n) || 0)
    } catch {}
    return false
  })
  // 主进程直接发系统通知（有的调用点不经过页面 Notification）
  handle('NOTIFY_SHOW', (payload) => {
    const ok = showNativeNotification(payload)
    if (!ok) flashWindow(true)
    return ok
  })

  // 窗口获得焦点就自动清提醒
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.on('focus', () => flashWindow(false))
  }
  LOG('通知相关通道已接管')
}

// ────────────────────────── 4. 窗口 ──────────────────────────
let mainWin = null
// ────────── 3.7 桌面集成：托盘、关闭到托盘、硬件加速、效能模式 ──────────
let tray = null
let quitForReal = false

function installDesktopIntegration() {
  const { Tray, Menu, nativeImage } = require('electron')
  const iconPath = path.join(APP_DIR, 'resourse/kook.png')
  const handle = (ch, fn) => {
    try { ipcMain.removeHandler(ch) } catch {}
    ipcMain.handle(ch, async (event, ...args) => {
      try { return await fn(...args) } catch (e) {
        LOG('[desktop]', ch, '失败', e && e.message)
        return null
      }
    })
  }

  // 硬件加速：开关状态由渲染层的 store 保存，主进程只负责读和告知是否要重启
  handle('SYSTEM_GET_HARDWARE_ACCELERATION', () => !globalPref('disabled_hardware_acceleration', false))
  handle('SYSTEM_SET_HARDWARE_ACCELERATION', (v) => {
    const enabled = v === undefined ? true : !!v
    const changed = enabled === globalPref('disabled_hardware_acceleration', false)
    LOG('[desktop] 硬件加速 ->', enabled ? '开' : '关', changed ? '（下次启动生效）' : '（无变化）')
    return { needRestart: changed }
  })

  // 效能模式：Linux 上用 POSIX 的 nice 值让出 CPU，不需要 root
  const setPriorityAll = (nice) => {
    let n = 0
    try { os.setPriority(0, nice); n++ } catch {}
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        const pid = w.webContents.getOSProcessId()
        if (pid > 0) { try { os.setPriority(pid, nice); n++ } catch {} }
      }
    } catch {}
    return n
  }
  const enterEco = () => {
    const n = setPriorityAll(10)
    LOG('[desktop] 效能模式开启（nice 10，作用于', n, '个进程）')
    return true
  }
  const exitEco = () => {
    setPriorityAll(0)
    LOG('[desktop] 效能模式关闭（nice 0）')
    return true
  }
  handle('ENTER_POWER_SAVING_MODE_1', enterEco)
  handle('ENTER_POWER_SAVING_MODE_2', enterEco)
  handle('EXIT_POWER_SAVING_MODE', exitEco)

  // 托盘：GNOME 要装 AppIndicator 扩展才有图标区；建不起来就当作没有托盘，
  // 「关闭时最小化到托盘」自动失效、关闭按钮照常退出，不会把窗口藏没。
  try {
    const img = nativeImage.createFromPath(iconPath)
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 22, height: 22 }))
    tray.setToolTip('KOOK')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 KOOK', click: () => { try { mainWin.show(); mainWin.focus() } catch {} } },
      { type: 'separator' },
      { label: '退出', click: () => { quitForReal = true; app.quit() } },
    ]))
    tray.on('click', () => { try { mainWin.show(); mainWin.focus() } catch {} })
    LOG('[desktop] 托盘已创建')
  } catch (e) {
    tray = null
    LOG('[desktop] 托盘不可用（GNOME 需 AppIndicator 扩展），关闭按钮将直接退出：', e && e.message)
  }

  // 关闭时最小化到托盘：设置里打开且托盘真的存在才拦截，否则关就是关
  try {
    mainWin.on('close', (e) => {
      if (quitForReal) return
      if (tray && globalPref('win_close_to_tray', true) === true) {
        e.preventDefault()
        mainWin.hide()
        LOG('[desktop] 已最小化到托盘')
      }
    })
  } catch {}

  // 效能模式是持久设置：上次开着的话，这次启动就按低优先级跑
  try {
    if (globalPref('open_efficiency_mode', false) === true) enterEco()
  } catch {}

  // 自检：这个会话到底能不能用全局快捷键（X11 直接可用；Wayland 取决于
  // 桌面是否实现了 XDG GlobalShortcuts portal）
  try {
    const { globalShortcut } = require('electron')
    const probe = 'Control+Shift+F12'
    const ok = globalShortcut.register(probe, () => {})
    LOG('[desktop] 全局快捷键自检:', ok ? '可用' : '不可用（当前会话不允许注册全局热键）')
    if (ok) globalShortcut.unregister(probe)
  } catch (e) {
    LOG('[desktop] 全局快捷键自检异常', e && e.message)
  }

  LOG('[desktop] 桌面集成已挂载，托盘=', !!tray)
}

function createWindow() {
  // 开机自启时启动器会带 --hidden：配合「启动时自动最小化」直接躲到托盘
  const startHidden = process.argv.includes('--hidden')
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    // 透明窗口在页面还没渲染出内容时就是一块「什么都没有」的透明玻璃，
    // 底下露出桌面，看起来就像客户端坏了。所以先不显示，等首屏真的有节点再 show。
    show: false,
    frame: false,
    // 窗口图标：不设就会用 Electron 自带的蓝色齿轮
    icon: path.join(APP_DIR, 'resourse/kook.png'),
    titleBarStyle: 'hidden',
    // 「客户端透明」要真正生效，窗口本身必须用 transparent 创建 —— 这是构造参数，
    // 运行时改不了，所以永远开着；真正的开关是 backgroundColor：
    //   客户端透明关 → 铺 #17181c 实心底，桌面透不进来
    //   客户端透明开 → 切成 #00000000，.app-background 又已 opacity:0，桌面就露出来
    // 初始给不透明底，避免启动瞬间是一块透出桌面的空玻璃（那会被当成「一片空白」）。
    transparent: true,
    backgroundColor: '#17181c',
    hasShadow: false,
    title: 'KOOK',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload-shim.js'),
      nodeIntegration: false,
      // contextIsolation 必须保持 false：官方 preload 是原版文件，它在 preload 里
      // 直接 require('electron') 并往 window 上挂对象，开启隔离后实测页面直接白屏
      // （body 文本长度 0，DOM 只到 61 个节点）。
      contextIsolation: false,
      // sandbox 必须保持 false：preload 需要 node 能力（fs/path/child_process），
      // 而且启动参数里带 --no-sandbox（AppImage 的 chrome-sandbox 没有 SUID 位，
      // 挂载是只读 squashfs，设不上去）。
      sandbox: false,
      // webSecurity 已开启（原先关闭）。实测开启后页面加载完整（文本 5721 字符、
      // 2989 个节点），本地资源服务与同源拦截都不受影响。
      webSecurity: true,
      spellcheck: false,
    },
  })
  mainWin.setMenu(null)
  broadcastWindowEvents(mainWin)

  // ── 客户端透明（自定义主题里的 appBlur）──
  // 这条和「叠加色透明度」「背景图片透明度」完全是两件事：
  //   背景图片透明度 → 背景图自己的 alpha
  //   叠加色透明度   → 蒙在背景图上的那一层颜色的 alpha
  //   客户端透明     → 整个窗口的 alpha，透出的是桌面
  // 官方渲染层（setStyleConfig）对 appBlur 只做两件事：
  //   window.Kaiheila.ipcRenderer.send(appBlur ? 'blurbehind' : 'app_bg_disable')
  //   document.body.classList.toggle('theme-app-blur', appBlur)   // CSS: .theme-app-blur .app-background{opacity:0}
  // 主进程这边唯一要做、也只能做的是把窗口底色切成全透明，桌面才透得出来。
  // transparent 是构造参数、运行时改不了，能改的只有 backgroundColor。
  const applyClientTransparent = (on, from) => {
    try {
      if (!mainWin || mainWin.isDestroyed()) return
      mainWin.setBackgroundColor(on ? '#00000000' : '#17181c')
      LOG('[trans] 客户端透明 ->', on ? '开（透出桌面）' : '关（铺不透明底）', '来源:', from)
    } catch (e) {
      LOG('[trans] 切换客户端透明失败', e && e.message)
    }
  }
  ipcMain.on('blurbehind', () => applyClientTransparent(true, 'blurbehind'))
  ipcMain.on('app_bg_disable', () => applyClientTransparent(false, 'app_bg_disable'))
  // 真源通道：preload 盯 body 的 theme-app-blur class（只在真变化时发），
  // 上面那对官方通道会被主题重算来回重放，只当辅助信息用。
  ipcMain.on('kook-linux:app-blur', (e, on) => applyClientTransparent(!!on, 'body-class'))

  // 自检：万一 window.Kaiheila 没挂上，渲染层那段 appBlur 分支压根不会执行，
  // 主进程也就永远收不到 blurbehind。这里把三个关键事实打出来，一眼定位。
  mainWin.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      try {
        mainWin.webContents.executeJavaScript(
          "(function(){var bg=document.querySelector('.app-background');" +
          "return JSON.stringify({kaiheila:!!window.Kaiheila," +
          "ipcRenderer:!!(window.Kaiheila&&window.Kaiheila.ipcRenderer)," +
          "bodyClass:document.body.className," +
          "appBg:bg?getComputedStyle(bg).opacity:'no-node'})})()"
        ).then((s) => LOG('[trans] 自检', s)).catch((e) => LOG('[trans] 自检失败', e && e.message))
      } catch (e) {}
    }, 2500)
  })

  // 透明窗口的显示时机：等页面真的画出东西再 show，否则用户先看到一块
  // 透出桌面的空玻璃，会以为「界面一片空白」。--hidden 启动则完全不动它。
  if (!startHidden) {
    let revealed = false
    const reveal = (why) => {
      if (revealed) return
      revealed = true
      try {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.show()
          LOG('[win] 首屏已就绪，显示窗口:', why)
        }
      } catch (e) {}
    }
    const probeUntilPainted = (tries) => {
      if (revealed) return
      if (tries > 40) return reveal('超时兜底')
      let n = 0
      try {
        n = mainWin.webContents.executeJavaScript(
          "(function(){var a=document.getElementById('app')||document.body;" +
          "if(!a)return 0;var c=a.querySelectorAll('*');return c.length})()"
        )
      } catch (e) { return reveal('探测异常') }
      Promise.resolve(n)
        .then((cnt) => {
          if (revealed) return
          // 有真实节点才算画出来了；空壳或只有提示文字时继续等
          if (Number(cnt) > 20) setTimeout(() => reveal('首屏节点 ' + cnt), 120)
          else setTimeout(() => probeUntilPainted(tries + 1), 100)
        })
        .catch(() => reveal('探测失败'))
    }
    mainWin.webContents.once('did-finish-load', () => setTimeout(() => probeUntilPainted(0), 120))
    // 无论如何 8 秒后都要给用户一个窗口，不能一直藏着
    setTimeout(() => reveal('启动兜底'), 8000)
  }

  mainWin.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log('[renderer]', message)
  })
  mainWin.webContents.on('render-process-gone', (e, d) =>
    LOG('render-process-gone', JSON.stringify(d))
  )
  mainWin.webContents.on('preload-error', (e, p, err) =>
    LOG('preload-error', p, err && err.stack)
  )
  mainWin.webContents.on('did-fail-load', (e, code, desc) =>
    LOG('did-fail-load', code, desc)
  )
  mainWin.webContents.on('did-finish-load', () => {
    LOG('did-finish-load')
    // 原版每次启动都停在「发现」，这里在页面就绪后主动回一次，
    // 避免被上次的频道路由带到聊天界面。
    setTimeout(async () => {
      try {
        const p = await mainWin.webContents.executeJavaScript('location.hash || location.pathname')
        if (!/discover|invite|login/i.test(String(p))) {
          mainWin.webContents.executeJavaScript(
            "window.history.replaceState(null,'','/discover');window.dispatchEvent(new PopStateEvent('popstate'))"
          ).catch(() => {})
          LOG('[win] 已切到发现页，原路由:', String(p).slice(0, 60))
        }
      } catch (e) {}
    }, 1500)
  })

  if (process.env.KOOK_SHOT) {
    mainWin.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWin.webContents.capturePage()
          fs.writeFileSync(process.env.KOOK_SHOT, img.toPNG())
          LOG('screenshot ->', process.env.KOOK_SHOT)
        } catch (e) {
          LOG('screenshot failed', e && e.message)
        }
        setTimeout(() => app.quit(), 800)
      }, 9000)
    })
  }

  installNetLogger(mainWin)
  installProbe(mainWin)
  installLoadWatchdog(mainWin)
  const target =
    process.env.KOOK_ORIGIN === 'local'
      ? `http://127.0.0.1:${PORT}/app/index.htm`
      : `https://www.kookapp.cn/app/index.htm`
  LOG('加载入口:', target)
  mainWin.loadURL(target)
  return mainWin
}

// ────────────────────────── 5. 启动 ──────────────────────────
app.commandLine.appendSwitch('no-sandbox')
// 关键：走原生 Wayland。XWayland 下渲染进程约 2/3 概率起不来（表现为连接中/崩溃页）
if (process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'wayland')
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform')
}
// GPU 保持默认（关掉反而更不稳，实测）
app.whenReady().then(async () => {
  LOG('electron', process.versions.electron, 'chrome', process.versions.chrome)
  // 所有窗口都不要默认菜单栏（Linux 上就是那条 File/Edit/View/Window/Help）
  try {
    const { Menu } = require('electron')
    Menu.setApplicationMenu(null)
    LOG('默认菜单栏已移除')
  } catch (e) { LOG('移除菜单栏失败', e && e.message) }
  installStubs()
  installWindowControls()
  detectCaps()
  installGoliveCapture()
  // 注意：启动时**不**申请屏幕授权。授权只在用户真正打开分享面板时才申请，
  // 记住之后（restore_token）静默复用，不会在开机/登录时弹系统对话框。
  try { installTaskList() } catch (e) { LOG('进程枚举挂载失败', e && e.message) }
  try {
    require('./src/browser_native/screen-recording-main').registerScreenRecording()
    LOG('录制管理通道已挂载')
  } catch (e) {
    LOG('录制管理通道挂载失败', e && e.message)
  }
  installWindowsSpoof()
  installProtocolHandler()
  runtime = createRuntime({ app, LOG })
  // 登录凭据的存储方式要能一眼看到：没装密钥环的机器上会退到「不保存」，
  // 用户下次启动发现要重登时，日志里得有据可查。
  try {
    const ss = runtime.secretStatus && runtime.secretStatus()
    if (ss) {
      LOG('[secret] 凭据存储 mode=' + ss.mode + ' backend=' + (ss.backend || '-') +
          ' secure=' + ss.secure + (ss.needsMigration ? ' 需要迁移旧明文' : ''))
      if (!ss.secure) LOG('[secret] 当前无法安全保存登录状态，将不会落盘；装 gnome-keyring 或 kwallet 后恢复')
    }
  } catch (e) { LOG('[secret] 状态读取失败', e && e.message) }
  try { installOverlay() } catch (e) { LOG('屏幕覆盖挂载失败', e && e.message) }
  try { installNotifications() } catch (e) { LOG('通知适配挂载失败', e && e.message) }
  LOG('真实通道已挂载 ->', Object.keys(runtime.handlers).length, '个')
  try {
    await startLocalServer()
  } catch (e) {
    LOG('local server 启动失败:', e && e.message)
  }
  createWindow()
  try { installDesktopIntegration() } catch (e) { LOG('[desktop] 挂载失败', e && e.message) }
  if (process.env.KOOK_OVERLAY_TEST === '1') {
    setTimeout(() => { try { overlayCreate() } catch (e) { LOG('[overlay] 自测创建失败', e && e.message) } }, 2500)
  }
  if (process.env.KOOK_SHOT_TIMER) {
    setTimeout(async () => {
      try {
        const img = await mainWin.webContents.capturePage()
        fs.writeFileSync(process.env.KOOK_SHOT_TIMER, img.toPNG())
        LOG('定时截图 ->', process.env.KOOK_SHOT_TIMER)
      } catch (e) {
        LOG('截图失败', e && e.message)
      }
      setTimeout(() => app.quit(), 500)
    }, Number(process.env.KOOK_SHOT_DELAY || 15000))
  }
})

app.on('window-all-closed', () => app.quit())
