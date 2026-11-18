// preload 前置钩子：把 Windows 原生模块（.node/dll）替换为容错桩，再加载原版 preload
const Module = require('module')
const path = require('path')

const REPORT = []
function makeStub(name) {
  if (!makeStub.cache) makeStub.cache = new Map()
  const key = name
  if (makeStub.cache.has(key)) return makeStub.cache.get(key)
  const fn = function (...args) {
    return makeStub(key + '()')
  }
  const proxy = new Proxy(fn, {
    get(t, prop) {
      if (prop === 'then') {
        if (process.env.KOOK_NO_THENABLE === '1') return undefined
        // 有些调用方期望 Promise：给出安全的 then，回调一个空结果
        return (onFulfilled) => Promise.resolve().then(() => (onFulfilled ? onFulfilled({ code: 0, data: null }) : undefined))
      }
      if (prop === 'constructor') return undefined
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        // 某些模块（如 kmarkdown）返回值会被 JSON.parse：给合法 JSON
        return () => '{}'
      }
      if (prop === 'inspect') return () => `[stub:${key}]`
      if (prop === '__stubName') return key
      return makeStub(key + '.' + String(prop))
    },
    apply() {
      return makeStub(key + '()')
    },
    construct() {
      return makeStub('new:' + key)
    },
    has() {
      return true
    },
  })
  makeStub.cache.set(key, proxy)
  return proxy
}

const NATIVE_HINT = /(\.node$|^node-|^window-|^kook-windows|^volc-|^xunyou$|addon|golive|im_sdk|agora)/i
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  try {
    return origLoad.call(this, request, parent, isMain)
  } catch (err) {
    // IM 走 web 分支：让 IMLib 为假值，客户端才会用 JS WebSocket 而不是原生 SDK
    if (/im_sdk|node-im-sdk/i.test(request)) {
      console.log('[shim] IMLib -> null（强制 web 分支）', request)
      return null
    }
    if (NATIVE_HINT.test(request) || /\.node$/.test(err && err.message || '')) {
      REPORT.push(request + ' :: ' + (err && err.message))
      console.log('[shim] native stub <-', request)
      try {
        console.log('[shim]   reason:', (err && err.message || '').slice(0, 160))
      } catch {}
      return makeStub(request)
    }
    throw err
  }
}
process.on('exit', () => {
  if (REPORT.length) console.log('[shim] stubbed natives:', JSON.stringify(REPORT, null, 2))
})

// ── Windows 指纹伪装（渲染层）──
const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'KOOK/0.112.0 Chrome/136.0.7103.177 Electron/36.7.4 Safari/537.36'
try {
  const def = (k, v) => Object.defineProperty(navigator, k, { get: () => v, configurable: true })
  def('platform', 'Win32')
  def('userAgent', WIN_UA)
  def('appVersion', WIN_UA.replace('Mozilla/', ''))
  def('oscpu', 'Windows NT 10.0; Win64; x64')
  def('vendor', 'Google Inc.')
  const uad = {
    brands: [
      { brand: 'Not.A/Brand', version: '8' },
      { brand: 'Chromium', version: '136' },
      { brand: 'Google Chrome', version: '136' },
    ],
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: async () => ({
      architecture: 'x86',
      bitness: '64',
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      uaFullVersion: '136.0.7103.177',
      wow64: false,
    }),
    toJSON: () => ({ brands: uad.brands, mobile: false, platform: 'Windows' }),
  }
  Object.defineProperty(navigator, 'userAgentData', { get: () => uad, configurable: true })
  console.log('[shim] navigator 伪装为 Windows:', navigator.platform, navigator.userAgent.slice(0, 60))
} catch (e) {
  console.log('[shim] navigator 伪装失败', e && e.message)
}

// 系统版本泄露修补：不把 Linux 内核版本交给风控
try {
  Object.defineProperty(process, 'getSystemVersion', {
    value: () => '10.0.22631',
    configurable: true,
  })
  console.log('[shim] getSystemVersion -> 10.0.22631')
} catch (e) {}

// sendSync 护栏：未知通道立即返回，避免渲染进程被永久阻塞
let syncGuard = { known: null, last: '' }
try {
  const { ipcRenderer } = require('electron')
  const constants = require(path.join(__dirname, 'src/browser_native/constants.js'))
  syncGuard.known = new Set(Object.keys(constants.IPCEventName || {}))
  const origSync = ipcRenderer.sendSync.bind(ipcRenderer)
  ipcRenderer.sendSync = function (channel, ...args) {
    syncGuard.last = channel
    if (syncGuard.known && !syncGuard.known.has(channel)) {
      console.log('[shim] 未注册通道 sendSync 已拦截:', channel)
      return undefined
    }
    return origSync(channel, ...args)
  }
  console.log('[shim] sendSync 护栏就绪，已知通道', syncGuard.known.size)

  // 未注册通道探针：远端模块（如屏幕分享面板）会用到 constants 里没有的通道
  const known = syncGuard.known
  const seen = new Set()
  const wrap = (name) => {
    const orig = ipcRenderer[name].bind(ipcRenderer)
    ipcRenderer[name] = function (ch, ...args) {
      try {
        if (!known.has(ch) && !seen.has(name + ':' + ch)) {
          seen.add(name + ':' + ch)
          console.log('[ipc:unknown]', name, ch, JSON.stringify(args).slice(0, 120))
        }
      } catch {}
      return orig(ch, ...args)
    }
  }
  ;['invoke', 'send', 'sendSync'].forEach(wrap)
} catch (e) {
  console.log('[shim] sendSync 护栏失败', e && e.message)
}

// 屏幕分享：KOOK 用的是 chromeMediaSource:'desktop'，Electron 新版只认 getDisplayMedia
try {
  const md = navigator.mediaDevices
  if (md && md.getUserMedia) {
    const origGUM = md.getUserMedia.bind(md)
    md.getUserMedia = async function (constraints) {
      const v = constraints && constraints.video
      const isDesktop =
        v && (v.chromeMediaSource === 'desktop' || (v.mandatory && v.mandatory.chromeMediaSource === 'desktop'))
      if (isDesktop && md.getDisplayMedia) {
        console.log('[shim] 桌面采集转 getDisplayMedia')
        try {
          return await md.getDisplayMedia({ video: true, audio: false })
        } catch (e) {
          console.log('[shim] getDisplayMedia 失败', e && e.message)
          throw e
        }
      }
      return origGUM(constraints)
    }
    console.log('[shim] 屏幕分享转接器就绪')
  }
} catch (e) {
  console.log('[shim] 屏幕分享转接器失败', e && e.message)
}

// ── 界面文案：把只在 Windows 上成立的说明改成 Linux 的说法 ──
// 这些设置项来自远端下发的 UI 模块，本机改不到源文件，所以在这里按文本跟踪替换。
// 规则只针对「Windows 专属」的句子，避免误伤普通文案。
const TEXT_FIXES = [
  // 设置窗口左边那个导航项（远端语言包只给了 Windows 的说法）
  ['Windows 设置', 'Linux 设置'],
  ['Windows设置', 'Linux 设置'],
  ['Windows 設定', 'Linux 設定'],
  ['Windows設定', 'Linux 設定'],
  ['Windows の設定', 'Linux の設定'],
  ['Windows Settings', 'Linux Settings'],
  ['Windows settings', 'Linux settings'],
  // 屏幕分享设置
  ['会在被分享程序或屏幕的四周显示黄色边框（关闭提示框需最新Windows 11支持）。',
    'Linux 版不绘制黄色边框提示（Wayland 不允许应用绘制全局边框），该开关仅为兼容保留。'],
  ['（关闭提示框需最新Windows 11支持）', '（Linux 版不绘制该边框）'],
  ['关闭提示框需最新Windows 11支持', 'Linux 版不绘制该边框'],
  ['会尝试使用GPU硬件来加速视频编码（支持大部分NVIDIA、AMD和Intel显卡）',
    '会尝试用 GPU 硬件加速画面处理（Linux 下由 GStreamer 走 VA-API，显卡不支持时自动回退软件处理）'],
  ['（支持大部分NVIDIA、AMD和Intel显卡）', '（走 VA-API，显卡不支持时自动回退软件处理）'],
  ['支持大部分NVIDIA、AMD和Intel显卡', '走 VA-API，显卡不支持时自动回退软件处理'],
  // 通用：设置里所有「Windows」都按 Linux 说
  ['Windows PowerShell', '终端'],
  ['右键点击 KOOK 启动图标，选择「以管理员身份运行」', '确认客户端已获得屏幕录制与输入设备权限'],
  ['以管理员身份运行', '以有权限的账号运行'],
  ['Windows 11', 'Linux'],
  ['Windows11', 'Linux'],
  ['最新Windows', '最新 Linux'],
  ['Windows系统', 'Linux 系统'],
  ['在Windows', '在 Linux'],
  ['Windows 系统', 'Linux 系统'],
  ['不支持Windows', '不支持当前系统'],
  ['Windows平台', 'Linux 平台'],
  ['Windows 平台', 'Linux 平台'],
  ['仅支持Windows', '仅支持 Linux'],
]

// 移植线版本号：跟着官方格式走，但归属这个移植分支
const PORT_VERSION = 'v0.0.11'
const PORT_AUTHOR = '@KANNI#0001'
// （版本：0.112.0-c5af713-kook_3321） / (Version: ...) / （バージョン：...）
// 带 g 的正则 test/replace 共用 lastIndex 会互相干扰，所以拆成两个
const VERSION_LINE_TEST =
  /[（(]\s*(?:版本|バージョン|Version)\s*[:：]\s*[^）)]{1,80}[）)]/i
const VERSION_LINE_ALL =
  /[（(]\s*(?:版本|バージョン|Version)\s*[:：]\s*[^）)]{1,80}[）)]/gi

function portVersionLine(sample) {
  const isJa = /バージョン/.test(sample)
  const isEn = !isJa && /version/i.test(sample) && !/版本/.test(sample)
  if (isEn) return `(Version: ${PORT_VERSION}) Ported and adapted for Linux by ${PORT_AUTHOR}`
  if (isJa) {
    return `（バージョン：${PORT_VERSION}）本バージョンは ${PORT_AUTHOR} が移植し Linux に適応させました`
  }
  return `（版本：${PORT_VERSION}）本版本由 ${PORT_AUTHOR} 进行移植并适配Linux`
}

function fixLinuxText(s) {
  if (!s || s.length > 400) return s
  let out = s
  // 版本行：官方构建号 → 移植版版本 + 移植者署名
  // 必须幂等：替换出来的文本自己也会被正则命中，不加这道判断就会被
  // MutationObserver 反复改写、越改越长，最终把渲染进程卡死。
  if (out.indexOf(PORT_AUTHOR) < 0 && VERSION_LINE_TEST.test(out)) {
    out = out.replace(VERSION_LINE_ALL, (m) => portVersionLine(m))
  }
  if (out.indexOf('Windows') < 0 && out.indexOf('NVIDIA') < 0) return out
  for (const [from, to] of TEXT_FIXES) {
    if (from !== to && out.indexOf(from) >= 0) out = out.split(from).join(to)
  }
  return out
}

// ── 更新记录：在最前面补一条移植版自己的记录 ──
// 面板是远端下发的模块，这里照它自己的 DOM 结构生成，样式跟官方记录一致；
// class 变了就找不到容器，自动跳过，不影响正常使用。
// 移植线自己的更新记录：v0.0.1 是初版，之后每版往上加，旧的一条都不删。
// PC 端的历史照样整段隐藏，这里留下的是移植线自己的历史。
const PORT_LOGS = [
  {
    date: `2026.11.18 更新记录（${PORT_VERSION}）`,
    groups: [
      ['问题修正：', [
        '修复部分桌面环境（GNOME 等）下双击客户端没有任何反应、进程启动即退出的问题。',
        '修复安装后窗口能打开但内容一片空白、界面加载不出来的问题。',
        '修复 Wayland 会话下窗口偶发打不开、渲染进程起不来的问题。',
      ]],
      ['安装包：', [
        '修正 deb / rpm 包信息中的主页地址与许可证。',
        '移除安装包内的自动更新配置，避免被官方更新器覆盖。',
      ]],
    ],
  },
  {
    date: '2026.11.18 更新记录（v0.0.7）',
    groups: [
      ['功能优化：', [
        '客户端透明：补上主界面被 app-mask-layer 挡住的那一层，开启后能真正透出桌面；个人设置保持官方的不透明实底，保证内容可读。',
        '悬浮工具栏：改成无边框、透明、置顶、跨工作区可见的独立窗口，支持拖动，也能正常关闭。',
        '快捷键：新增本地键盘桥，Wayland 下按键说话等快捷键不再失灵，所有按键配置都会送到客户端自行判断。',
        '版本号显示按实际数字，不再补零。',
      ]],
      ['问题修正：', [
        '修复迅游加速器提示串到语音控制条等界面的问题。',
        '修复悬浮工具栏偶尔不显示、关不掉的问题。',
        '修复「叠加色透明度」与「客户端透明」被混为一谈的问题。',
      ]],
    ],
  },
  {
    date: '2026.11.18 更新记录（v0.0.1）',
    groups: [
      ['产品发布：', [
        'KOOK Linux 原生移植版初版，基于官方 Windows PC 客户端 0.112.0（构建 c5af713-kook_3321）移植。',
        `本版本由 ${PORT_AUTHOR} 进行移植并适配 Linux。`,
      ]],
      ['适配功能：', [
        '屏幕分享：改用 xdg-desktop-portal 采集，一次授权同时覆盖屏幕与窗口，面板内实时预览持续刷新。',
        '用户动态：接入官方进程活动引擎，识别本机正在运行的游戏与应用并上报。',
        '屏幕覆盖：X11 会话支持全局置顶，Wayland 会话在 KOOK 窗口内显示。',
        '桌面集成：开机自动启动、启动时最小化、关闭时最小化到托盘、硬件加速、效能模式。',
        '通知、图片查看、子窗口、托盘图标均按 Linux 桌面规范重做。',
      ]],
      ['功能优化：', [
        '界面文案按 Linux 实际情况改写，覆盖简体中文、繁体中文、日文、英文。',
        '应用名统一为 KOOK，图标使用官方 logo，桌面项与任务栏保持一致。',
      ]],
      ['问题修正：', [
        '修复图片查看器打开白屏的问题。',
        '修复屏幕分享预览画面不刷新的问题。',
        '修复设置项在多语言下缺少说明的问题。',
      ]],
    ],
  },
]

// 官方 PC 端的历史记录整段隐藏，只留移植线这一条。
// 每次都要跑：React 重渲染会把节点重新插回来。
function hidePcChangelogSteps(box) {
  for (const step of box.querySelectorAll('.user-setting-mf-changelog-step')) {
    if (step.dataset.kookLinuxLog) continue
    if (step.dataset.kookLinuxHidden) continue
    step.dataset.kookLinuxHidden = '1'
    step.style.display = 'none'
  }
}

// 面板本身就是可滚动的，不需要「加载更多信息」这种分页按钮：直接把记录一次铺开。
// 全部记录都在同一个滚动区里，所以按钮隐藏掉，视觉上就是“全部显示”。
const LOAD_MORE_TEXT = /加载更多|載入更多|加載更多|もっと見る|さらに読み込む|Load more/i
function hideChangelogLoadMore() {
  // 只在更新记录面板真的存在时才动手：之前每 2 秒把整页 div/span 全扫一遍，
  // 聊天页节点一多就把渲染进程拖住，看起来就是一片空白。
  const panel = document.querySelector('.user-setting-mf-changelog-content, [class*="changelog"]')
  if (!panel) return
  // 用样式表而不是改元素 style：React 重渲染会换成新节点，style 会被丢掉
  if (!document.getElementById('kook-linux-changelog-css')) {
    try {
      const st = document.createElement('style')
      st.id = 'kook-linux-changelog-css'
      st.textContent =
        '.user-setting-mf-changelog-load-more,[class*="changelog-load"]{display:none!important}'
      ;(document.head || document.documentElement).appendChild(st)
    } catch (e) {}
  }
  // class 变了的话按文案兜底，范围只限面板内部
  for (const el of panel.querySelectorAll('div,span,button,a')) {
    if (el.children.length) continue
    const t = (el.textContent || '').trim()
    if (!t || t.length > 10 || !LOAD_MORE_TEXT.test(t)) continue
    if (el.style.display === 'none') continue
    el.style.display = 'none'
  }
}

// ── 工具箱：迅游加速器没有 Linux 版 ──
// 只做提示，不拦下载：用户想装还是能装。
const XUNYOU_TIP = {
  'zh-CN': '⚠ 目前没有支持 Linux 的迅游加速器，不推荐下载（按钮仍可用，想装可以自己装）',
  'zh-TW': '⚠ 目前沒有支援 Linux 的迅遊加速器，不建議下載（按鈕仍可用，想裝可以自己裝）',
  ja: '⚠ Linux 対応の迅游アクセラレータはありません。ダウンロードは推奨しません（ボタンは使用できます）',
  en: '⚠ No Linux build of Xunyou Accelerator exists. Downloading is not recommended (the button still works).',
}

function uiLang() {
  try {
    const raw = String((document.documentElement && document.documentElement.lang) || navigator.language || 'zh-CN')
    if (/^zh-(TW|HK|Hant)/i.test(raw)) return 'zh-TW'
    if (/^zh/i.test(raw)) return 'zh-CN'
    if (/^ja/i.test(raw)) return 'ja'
    return 'en'
  } catch (e) {
    return 'zh-CN'
  }
}

let xunyouAt = 0
function annotateXunyou() {
  // 先自愈：台账里记着这条提示当初挂在哪个卡片上，一旦 React 把那块 DOM 复用到
  // 别的界面（语音控制条之类），提示就会跟着跑过去。父节点对不上就当场删掉。
  document.querySelectorAll('.kook-linux-xunyou-tip').forEach((el) => {
    const ok = el.__host && el.parentElement === el.__host
    if (!ok) { try { el.remove() } catch (e) {} }
  })
  if (document.querySelector('.kook-linux-xunyou-tip')) return
  // 只在可能开着工具箱的时候才扫：没有这个前缀就跳过，避免每轮遍历整页
  if (!document.querySelector('[class*="tool"], [class*="plugin"], [class*="game"]')) return
  const now = Date.now()
  if (now - xunyouAt < 4000) return
  xunyouAt = now
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let n = null
  let hit = null
  let guard = 0
  while ((n = tw.nextNode()) && guard++ < 3000) {
    if ((n.nodeValue || '').trim() === '迅游加速器') {
      hit = n.parentElement
      break
    }
  }
  if (!hit) return
  // 往上找最小的、带按钮的卡片容器。原来一路找 6 层，容易一巴掌拍到整页级大容器，
  // 提示就被塞到语音控制条那种地方去了；这里限 4 层，并排除按钮过多的大容器。
  let card = null
  let p = hit.parentElement
  for (let i = 0; i < 4 && p && p !== document.body; i++) {
    if (p.querySelector('button')) { card = p; break }
    p = p.parentElement
  }
  if (!card) return
  if (card.querySelectorAll('button').length > 6) return
  if (!card.contains(hit)) return
  const tip = document.createElement('div')
  tip.className = 'kook-linux-xunyou-tip'
  tip.textContent = XUNYOU_TIP[uiLang()] || XUNYOU_TIP['zh-CN']
  tip.style.cssText = 'margin-top:8px;color:#f0b232;font-size:12px;line-height:1.6;white-space:normal'
  // 只挂在这张卡片自己身上，并记住宿主，供下一轮自愈校验
  tip.__host = card
  card.appendChild(tip)
  console.log('[shim] 已加迅游加速器的 Linux 提示')
}

function injectPortChangelog() {
  const box = document.querySelector('.user-setting-mf-changelog-content')
  if (!box) return
  hideChangelogLoadMore()
  hidePcChangelogSteps(box)
  // 一版一条：全都插在最前面，旧的记录不删
  if (box.querySelector('[data-kook-linux-log]')) return
  const div = (cls, text) => {
    const d = document.createElement('div')
    d.className = cls
    d.textContent = text
    return d
  }
  const anchor = box.firstChild
  PORT_LOGS.forEach((log, i) => {
    const step = document.createElement('div')
    step.className = 'user-setting-mf-changelog-step'
    step.id = 'kook-linux-changelog-' + i
    step.dataset.kookLinuxLog = '1'
    step.appendChild(div('user-setting-mf-changelog-date', log.date))
    for (const [title, items] of log.groups) {
      const wrap = document.createElement('div')
      wrap.appendChild(div('user-setting-mf-changelog-title', title))
      const ul = document.createElement('ul')
      for (const it of items) {
        const li = document.createElement('li')
        li.className = 'user-setting-mf-changelog-item'
        li.textContent = it
        ul.appendChild(li)
      }
      wrap.appendChild(ul)
      step.appendChild(wrap)
    }
    box.insertBefore(step, anchor)
  })
  hidePcChangelogSteps(box)
  console.log('[shim] 更新记录已换成移植版记录，共', PORT_LOGS.length, '条')
}

try {
  if (!window.__kookLinuxChangelog) {
    window.__kookLinuxChangelog = true
    const tick = () => {
      try { injectPortChangelog() } catch (e) {}
    }
    const start = () => {
      tick()
      try {
        new MutationObserver(tick).observe(document.body, { childList: true, subtree: true })
      } catch (e) {}
      // 打字栏/列表这类高频改动能第一时间补上；页面重新挂 body 时观察器会失效，
      // 这个低频兜底保证面板打开后一定会被处理到。
      setInterval(tick, 2000)
      // 迅游提示单独一个更慢的轮询，且自带前置判断，不影响主界面渲染
      setInterval(() => { try { annotateXunyou() } catch (e) {} }, 6000)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
    else start()
  }
} catch (e) {}

try {
  if (!window.__kookLinuxTextFix) {
    window.__kookLinuxTextFix = true
    const walker = () => {
      try {
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
        let n
        let guard = 0
        while ((n = tw.nextNode()) && guard++ < 4000) {
          const fixed = fixLinuxText(n.nodeValue)
          if (fixed !== n.nodeValue) n.nodeValue = fixed
        }
        for (const el of document.querySelectorAll('[title],[placeholder]')) {
          for (const attr of ['title', 'placeholder']) {
            const v = el.getAttribute && el.getAttribute(attr)
            if (!v) continue
            const fixed = fixLinuxText(v)
            if (fixed !== v) el.setAttribute(attr, fixed)
          }
        }
      } catch (e) {}
    }
    const start = () => {
      walker()
      try {
        const mo = new MutationObserver(() => walker())
        mo.observe(document.body, { childList: true, subtree: true, characterData: true })
      } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
    else start()
    setTimeout(walker, 1500)
    setTimeout(walker, 5000)
    console.log('[shim] Windows 专属文案已改为 Linux 说法')
  }
} catch (e) {}

// Linux 字体：显式给中文字体族，避免回退到缺字的默认字体
try {
  const injectFont = () => {
    if (document.getElementById('kook-linux-font')) return
    const st = document.createElement('style')
    st.id = 'kook-linux-font'
    st.textContent = `
      html, body {
        font-family: "Noto Sans CJK SC","Source Han Sans SC","Sarasa Gothic SC",
                     "WenQuanYi Zen Hei","文泉驿正黑","Droid Sans Fallback",
                     "Microsoft YaHei",Cantarell,Ubuntu,"DejaVu Sans",system-ui,sans-serif !important;
      }
      code, pre, .k-markdown-code, .markdown-code {
        font-family: "Noto Sans Mono CJK SC","Sarasa Mono SC","文泉驿等宽正黑",
                     "DejaVu Sans Mono","Liberation Mono",monospace !important;
      }
    `
    document.head && document.head.appendChild(st)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectFont)
  else injectFont()
  console.log('[shim] Linux 中文字体已注入')
} catch (e) {}

const target = path.join(__dirname, 'src/preload/preload.js')
console.log('[shim] loading original preload:', target)
require(target)

// 原版 preload 跑完后统一收口：requireModule 走 process.dlopen，绕过了 Module._load，
// 这里直接把无法在 Linux 上提供的原生依赖置空，让客户端走自己的 JS/WASM 实现。
setTimeout(() => {
  try {
    const K = global.Kaiheila
    if (K) {
      if (K.addonKmarkdown) {
        K.addonKmarkdown = null
        console.log('[shim] 收口: addonKmarkdown -> null')
      }
      if (K.IMLib) {
        K.IMLib = null
        console.log('[shim] 收口: IMLib -> null（web 分支）')
      }
      // 官方的 Kaiheila.OverlayWin 挂的是 overlay-bootstrap，只有 create/close/hide/show/
      // setBounds/existsSync，偏偏没有 getBounds —— 而语音悬浮工具栏（toolbar.htm）正是用
      // OverlayWin.getBounds({id:'desktop-toolbar'}) 算展开/收起位置的，缺了就直接抛
      // "e8.getBounds is not a function"，工具栏整块白屏。这里按 overlay-window 的契约补齐。
      if (K.OverlayWin) {
        const ipcWin = K.ipcRenderer
        if (typeof K.OverlayWin.getBounds !== 'function') {
          K.OverlayWin.getBounds = (o) => ipcWin.invoke('OVERLAY_WINDOW_GET_BOUNDS', o || {})
        }
        if (typeof K.OverlayWin.destroy !== 'function') {
          K.OverlayWin.destroy = (o) => ipcWin.invoke('OVERLAY_WIDNOW_DESTROY', o || {})
        }
        if (typeof K.OverlayWin.setMoveTopCheck !== 'function') {
          K.OverlayWin.setMoveTopCheck = (o) => ipcWin.invoke('OVERLAY_WINDOW_SET_MOVE_TOP_CHECK', o || {})
        }
        if (typeof K.OverlayWin.on !== 'function') {
          const OW_EVENTS = {
            close: 'ON_OVERLAY_WINDOW_CLOSE',
            mouseEnter: 'ON_OVERLAY_WINDOW_MOUSE_ENTER',
            mouseLeave: 'ON_OVERLAY_WINDOW_MOUSE_LEAVE',
          }
          K.OverlayWin.on = (name, fn) => { if (OW_EVENTS[name]) ipcWin.on(OW_EVENTS[name], fn) }
          K.OverlayWin.off = (name, fn) => { if (OW_EVENTS[name]) ipcWin.removeListener(OW_EVENTS[name], fn) }
        }
        console.log('[shim] 收口: OverlayWin 已补齐 getBounds/destroy/setMoveTopCheck/on')
      }
      // 屏幕共享：远端面板直接调 Screen.getSources / desktopCapturer.getSources
      const { ipcRenderer: ipc } = require('electron')
      const getSources = (opts) => {
        console.log('[shim] getSources 被调用', JSON.stringify(opts || {}).slice(0, 80))
        return ipc.invoke('DESKTOP_CAPTURER_GET_SOURCES', opts || {})
      }
      if (!K.Screen) K.Screen = {}
      K.Screen.getSources = getSources
      K.desktopCapturer = { getSources }
      K.getSources = getSources

      // 语音：Linux 没有声网 Electron 原生库，摘掉原生媒体层逼它走 Agora Web SDK
      for (const key of ['createMedia', 'createGoliveMedia']) {
        if (K[key]) {
          K[key] = null
          console.log('[shim] 收口: ' + key + ' -> null（web RTC 分支）')
        }
      }

      // 屏幕分享取源：原版走 agora/volc 的 Windows 原生 SDK，Linux 换成 desktopCapturer 真实现。
      // 面板读的是 Kaiheila.goliveHelper（原版被我们置空 → 直接 return [] → 暂无可共享的源）。
      let cache = null
      let cacheAt = 0
      const loadSources = async (force, types) => {
        if (!force && !types && cache && Date.now() - cacheAt < 2000) return cache
        const r = await ipc.invoke('GOLIVE_CAPTURE_SOURCES', types ? { force: true, types } : { force })
        cache = r || { screens: [], windows: [] }
        cacheAt = Date.now()
        console.log('[shim] 取源: 屏幕', cache.screens.length, '窗口', cache.windows.length)
        return cache
      }
      const withType = (arr, t) => arr.map((s) => Object.assign({}, s, { type: t, sourceType: t }))
      K.goliveHelper = {
        getCanvas: () => null,
        getMonitorScreenshot: async () => (await loadSources(true, 'screen')).screens,
        getWindowScreenshot: async () => (await loadSources(true, 'window')).windows,
        // agora: type 1 = 屏幕, 2 = 窗口
        getAgoraSources: async () => {
          const { screens, windows } = await loadSources(true)
          return [...withType(screens, 1), ...withType(windows, 2)]
        },
        // volc: type 2 = 屏幕, 1 = 窗口
        getVolcSources: async () => {
          const { screens, windows } = await loadSources(true)
          return [...withType(screens, 2), ...withType(windows, 1)]
        },
        getVideoScreenshot: async () => ipc.invoke('GOLIVE_VIDEO_FRAME'),
        getVolcVideo: () => null,
        selectSource: (id) => ipc.invoke('GOLIVE_SET_PENDING_SOURCE', { id }),
      }
      console.log('[shim] goliveHelper 已换成 desktopCapturer 实现')

      // ── 通知：页面用 web Notification 发系统通知，这里顺手让任务栏提醒一下 ──
      try {
        const NativeNotification = window.Notification
        if (NativeNotification && !NativeNotification.__kookWrapped) {
          const Wrapped = function (title, opts) {
            const n = new NativeNotification(title, opts)
            try { ipc.send('WINDOW_FLASH_FRAME', true) } catch {}
            n.addEventListener('click', () => { try { ipc.send('WINDOW_FOCUS') } catch {} })
            return n
          }
          Wrapped.__kookWrapped = true
          Wrapped.permission = NativeNotification.permission
          Wrapped.requestPermission = NativeNotification.requestPermission.bind(NativeNotification)
          Wrapped.maxActions = NativeNotification.maxActions
          window.Notification = Wrapped
          console.log('[shim] 系统通知已接管（附带任务栏提醒）')
        }
      } catch (e) {}

      // 活动库要带登录态拿才全（主进程直连拿到的少 8 条，且缺微信/YesPlayMusic 这类），
      // 所以由渲染层拉一次交给主进程做匹配。
      try {
        const pushCatalog = () => {
          fetch('/api/v2/games', { credentials: 'include' })
            .then((r) => r.json())
            .then((list) => { if (Array.isArray(list) && list.length) ipc.send('ACTIVITY_SET_CATALOG', list) })
            .catch(() => {})
        }
        setTimeout(pushCatalog, 4000)
        setTimeout(pushCatalog, 20000)
      } catch (e) {}

      // ── 用户动态 ──
      // 官方进程活动引擎（base/process-activity）现在跑在真实的 /proc 进程数据上：
      // 主进程的 TASKLIST_QUERY_SIMPLE / TASKLIST_CHANGE 走官方 getWinProcess，
      // 引擎自己算 runningActivities 并渲染「已识别动态」。这里不再伪造填充，
      // 由平台通道自己显示。

      // 覆盖层在 Linux 上能做什么、不能做什么：直接写在设置面板里（不只写在聊天里）
      // 面板文案是远端模块下发的、多语言各不相同，所以这里不认文字，只认结构：
      // 一个区域里正好 4 个开关 + 出现 "KOOK" ⇒ 就是「屏幕覆盖」面板。
      try {
        console.log('[shim] 覆盖说明模块启动')
        const NOTE_ID = 'kook-linux-overlay-note'
        const T = {
          'zh-CN': {
            na: '（仅 X11 会话可用）',
            note: 'Linux 版说明：当前是 Wayland 会话——覆盖层在 KOOK 窗口内、以及全屏观看屏幕分享时可以正常显示；「在桌面上显示」和「全屏游戏时显示」需要 X11，Wayland 不允许普通应用绘制全局置顶层，所以这两项在这个会话里不会生效。',
            noteX11: 'Linux 版说明：当前是 X11 会话——四项覆盖都可以正常使用。',
          },
          'zh-TW': {
            na: '（僅 X11 工作階段可用）',
            note: 'Linux 版說明：目前是 Wayland 工作階段——覆蓋層在 KOOK 視窗內、以及全螢幕觀看螢幕分享時可以正常顯示；「在桌面上顯示」和「全螢幕遊戲時顯示」需要 X11，Wayland 不允許一般應用程式繪製全域置頂層，所以這兩項在這個工作階段不會生效。',
            noteX11: 'Linux 版說明：目前是 X11 工作階段——四項覆蓋都可以正常使用。',
          },
          ja: {
            na: '（X11 セッションのみ）',
            note: 'Linux 版の説明：現在は Wayland セッションです。オーバーレイは KOOK のウィンドウ内と、画面共有を全画面で見るときに表示できます。「デスクトップに表示」「全画面ゲーム時に表示」は X11 が必要で、Wayland では一般アプリがグローバルな最前面レイヤーを描画できないため、このセッションでは有効になりません。',
            noteX11: 'Linux 版の説明：現在は X11 セッションです。4 つのオーバーレイはすべて利用できます。',
          },
          en: {
            na: ' (X11 sessions only)',
            note: 'Linux build note: this is a Wayland session. The overlay works inside the KOOK window and while watching a screen share full screen. “Show on desktop” and “Show during full-screen games” need X11 — Wayland does not let a normal app draw a global always-on-top layer, so those two do nothing in this session.',
            noteX11: 'Linux build note: this is an X11 session — all four overlay options work.',
          },
        }
        // preload 执行时 documentElement 可能还没建好，语言要在真正用时才读
        const langOf = () => {
          try {
            const el = document.documentElement
            const raw = String((el && el.lang) || navigator.language || 'zh-CN')
            if (/^zh-(TW|HK|Hant)/i.test(raw)) return 'zh-TW'
            if (/^zh/i.test(raw)) return 'zh-CN'
            if (/^ja/i.test(raw)) return 'ja'
            return 'en'
          } catch {
            return 'en'
          }
        }

        // 开关识别：优先用 KOOK 自己的类名（ui-switch），类名变了再退回尺寸/圆角判断
        const isToggle = (el) => {
          const cls = String((el && el.className) || '')
          if (/\bui-switch\b/.test(cls)) return true
          const r = el.getBoundingClientRect()
          if (r.width < 26 || r.width > 70 || r.height < 12 || r.height > 34) return false
          const st = getComputedStyle(el)
          const radius = parseFloat(st.borderRadius) || 0
          return radius >= Math.min(r.height / 2, 8) && el.children.length <= 2
        }
        const togglesIn = (root) => [...root.querySelectorAll('*')].filter(isToggle)
        const OVERLAY_WORD = /(覆盖|覆蓋|overlay|オーバーレイ|오버레이|оверлей|uperposición|superposition)/i
        // 面板 = 最深的、正好包含 4 个开关、且文字里出现 overlay 与 KOOK 的容器
        const findPanel = () => {
          const all = [...document.querySelectorAll('*')].filter(isToggle)
          if (all.length < 4) return null
          let best = null
          for (const t of all) {
            let p = t.parentElement
            for (let i = 0; i < 10 && p; i++, p = p.parentElement) {
              const n = togglesIn(p).length
              if (n === 4) {
                const txt = p.textContent || ''
                if (/KOOK/i.test(txt) && OVERLAY_WORD.test(txt)) {
                  if (!best || best.contains(p)) best = p
                }
                break
              }
              if (n > 4) break
            }
          }
          return best
        }
        const countIn = (el, all) => {
          let n = 0
          for (const t of all) if (el.contains(t)) n++
          return n
        }
        // 一行 = 只包含这一个开关的最大子树
        const rowOf = (t, all) => {
          const byClass = t.closest('[class*="form-item"]')
          if (byClass) return byClass
          let row = t.parentElement || t
          let p = row
          let guard = 0
          while (p && countIn(p, all) < 2 && guard++ < 8) {
            row = p
            p = p.parentElement
          }
          return row
        }
        const makeTag = (dict) => {
          const tag = document.createElement('span')
          tag.className = 'kook-overlay-na'
          tag.textContent = dict.na
          tag.style.cssText = 'color:#f0b232;font-size:12px;margin-left:6px;white-space:nowrap'
          return tag
        }
        const labelHost = (row) => {
          const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null)
          let n = null
          while ((n = tw.nextNode())) {
            if ((n.nodeValue || '').trim().length > 1) return n.parentElement
          }
          return row
        }

        const annotate = (caps) => {
          if (!caps || !document.body) return
          const lang = langOf()
          const dict = T[lang] || T.en
          const panel = findPanel()
          if (!panel) return
          // 顶部说明：插在面板标题区下面（只插一次）
          if (!document.getElementById(NOTE_ID)) {
            const box = document.createElement('div')
            box.id = NOTE_ID
            box.textContent = caps.global ? dict.noteX11 : dict.note
            box.style.cssText = [
              'margin:8px 10px 4px', 'padding:8px 10px', 'border-radius:6px',
              'border-left:3px solid #f0b232', 'background:rgba(240,178,50,.10)',
              'color:#e6d3a3', 'font-size:12px', 'line-height:1.5',
            ].join(';')
            panel.insertBefore(box, panel.firstChild)
            console.log('[shim] 已写入屏幕覆盖的 Linux 说明（' + lang + '）')
          }
          if (caps.global) return

          // 会话不支持全局覆盖（Wayland）：这两项直接关掉并置灰不可点。
          // 用属性 + 样式表，React 重渲染换了节点也会按新属性重新生效。
          if (!document.getElementById('kook-linux-switch-css')) {
            try {
              const st = document.createElement('style')
              st.id = 'kook-linux-switch-css'
              st.textContent = [
                '.ui-switch[data-kook-linux-off="1"]{opacity:.4!important;filter:grayscale(1)!important;pointer-events:none!important;cursor:not-allowed!important}',
                '[data-kook-linux-row-off="1"]{pointer-events:none!important;cursor:not-allowed!important}',
              ].join('')
              ;(document.head || document.documentElement).appendChild(st)
            } catch (e) {}
          }

          // 前两行（全屏游戏 / 系统桌面）在 Wayland 下不可用
          const toggles = togglesIn(panel)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          const rows = []
          for (const t of toggles.slice(0, 2)) {
            try {
              // 状态也真的置为关闭，否则界面上是开的、功能却不起作用
              const input = t.querySelector('input[type="checkbox"]')
              if (input && input.checked) input.checked = false
              t.setAttribute('data-kook-linux-off', '1')
              t.setAttribute('aria-disabled', 'true')
            } catch (e) {}
            const row = rowOf(t, toggles)
            if (row && !rows.includes(row)) rows.push(row)
          }
          for (const row of rows) {
            try { row.setAttribute('data-kook-linux-row-off', '1') } catch (e) {}
            const host = labelHost(row)
            if (!host || host.querySelector('.kook-overlay-na')) continue
            host.appendChild(makeTag(dict))
          }
        }

        window.__kookOverlayNote = annotate
        let pending = null
        const schedule = () => {
          if (pending) return
          pending = setTimeout(() => {
            pending = null
            annotate(window.__kookOverlayCaps || null)
          }, 350)
        }
        ipc.invoke('OVERLAY_GET_CAPS').then((caps) => {
          window.__kookOverlayCaps = caps
          annotate(caps)
          new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
        }).catch(() => {})
      } catch (e) { console.log('[shim] 覆盖说明模块失败', e && e.message) }

      // ── 屏幕覆盖：把「谁在说话」推给主进程的覆盖窗口 ──
      // 原版靠 Windows 原生 overlay SDK 提供活跃说话人；Linux 上从界面状态里读，
      // 识别不到就当作没人说话（覆盖窗口会自己隐藏），不会报错。
      try {
        let lastSig = ''
        const nameOf = (el) => {
          const n = el.querySelector('[class*="name"],[class*="username"],[class*="nickname"]')
          return ((n && n.textContent) || '').trim().slice(0, 24)
        }
        const avatarOf = (el) => {
          const img = el.querySelector('img')
          return (img && img.src) || ''
        }
        const isSpeaking = (el) => {
          const c = String((el && el.className) || '')
          if (/not-speaking|nospeaking/i.test(c)) return false
          return /(^|\s)(is-)?speaking(\s|$)/.test(c)
        }
        const collect = () => {
          // 只在「确实有人在说话」时才认为界面处于语音频道，避免误判把覆盖层长期挂出来
          const speakEls = [...document.querySelectorAll('[class*="speaking"]')].filter(isSpeaking)
          if (!speakEls.length) return []
          const cards = new Set()
          for (const el of speakEls) cards.add(el.closest('[class*="user"],[class*="member"],li') || el)
          const first = [...cards][0]
          const container = first && first.parentElement
          // 「总是」模式要显示频道里其他人，就顺着同一个列表补全
          if (container) for (const c of container.children) cards.add(c)
          const out = []
          const seen = new Set()
          for (const card of cards) {
            const name = nameOf(card) || nameOf(card.firstElementChild || card)
            if (!name || seen.has(name)) continue
            seen.add(name)
            out.push({ name, talking: isSpeaking(card) || [...card.querySelectorAll('[class*="speaking"]')].some(isSpeaking),
              avatar: avatarOf(card) })
          }
          return out.slice(0, 12)
        }
        const tick = () => {
          try {
            const list = collect()
            const sig = JSON.stringify(list)
            if (sig !== lastSig) {
              lastSig = sig
              ipc.send('OVERLAY_TALK_LIST', list)
            }
          } catch (e) {}
        }
        setInterval(tick, 900)
        console.log('[shim] 屏幕覆盖数据源已启动')
      } catch (e) {}

      // 授权到位后重新取一次源，让面板立刻拿到缩略图
      try {
        ipc.on('PORTAL_SESSION_READY', () => {
          console.log('[shim] screen-cast 授权就绪，刷新源列表')
          loadSources(true).catch(() => {})
        })
      } catch {}

      // 面板缩略图实时刷新：主进程持续出帧，这里把选中项的图换成最新一帧
      try {
        ipc.on('PORTAL_FRAME', (_e, buf) => {
          if (!buf) return
          const img = document.querySelector('.ssd-item.selected img.ssd-thumb, .ssd-item img.ssd-thumb')
          if (!img) return
          // 已经是 MJPEG 实时流的话别覆盖，否则反而把实时画面换成一张定格图
          if (String(img.src || '').indexOf('/__live/') >= 0) return
          const blob = new Blob([buf], { type: 'image/jpeg' })
          const url = URL.createObjectURL(blob)
          const prev = img.dataset.kookPrev
          img.src = url
          img.dataset.kookPrev = url
          if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1000)
        })
        console.log('[shim] 面板缩略图已接实时帧')
      } catch (e) {}


      // 分享画面统一走自己的 PipeWire 会话：不再让 Chromium 单独弹授权，
      // 也避开了它抓单个窗口黑屏的问题；预览与分享用的是同一条真实画面流。
      try {
        const md = navigator.mediaDevices
        const W = 1280
        const H = 720
        const FPS = 10
        const nativeGetDisplayMedia = md.getDisplayMedia && md.getDisplayMedia.bind(md)
        md.getDisplayMedia = async function (constraints) {
          try {
            const c = constraints || {}
            const v = c.video
            const id = (v && v.mandatory && (v.mandatory.chromeMediaSourceId || v.mandatory.sourceId)) || (v && v.deviceId && v.deviceId.exact)
            if (id) await ipc.invoke('GOLIVE_SET_PENDING_SOURCE', { id })
          } catch {}
          const canvas = document.createElement('canvas')
          canvas.width = W
          canvas.height = H
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, W, H)
          let alive = true
          // 没有单独的窗口流时：从整屏画面里按窗口位置裁剪，保证「程序」分享有画面
          let crop = null
          try {
            const geo = await ipc.invoke('GOLIVE_PENDING_RECT')
            if (geo && geo.rect && geo.screen && geo.screen.w) {
              crop = {
                x: (geo.rect.x / geo.screen.w) * W,
                y: (geo.rect.y / geo.screen.h) * H,
                w: (geo.rect.w / geo.screen.w) * W,
                h: (geo.rect.h / geo.screen.h) * H,
              }
              window.__kookLastCrop = crop
              console.log('[shim] 程序分享按窗口裁剪', JSON.stringify(crop))
            }
          } catch (e) {}
          const onFrame = (event, buf) => {
            if (!alive || !buf) return
            createImageBitmap(new Blob([buf], { type: 'image/jpeg' }))
              .then((bmp) => {
                if (!crop) return ctx.drawImage(bmp, 0, 0, W, H)
                // 按比例换算到实际帧尺寸，再放大铺满画布
                const sx = (crop.x / W) * bmp.width
                const sy = (crop.y / H) * bmp.height
                const sw = Math.max(1, (crop.w / W) * bmp.width)
                const sh = Math.max(1, (crop.h / H) * bmp.height)
                ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, W, H)
              })
              .catch(() => {})
          }
          ipc.on('PORTAL_FRAME', onFrame)
          const started = await ipc.invoke('PORTAL_CAPTURE_START', { fps: FPS, width: W, height: H })
          console.log('[shim] getDisplayMedia -> PieWire 自采集, started=', started)
          if (!started && nativeGetDisplayMedia) {
            // 本机缺 gstreamer / portal 依赖：退回浏览器原生采集（会弹一次系统选择框，但功能可用）
            console.log('[shim] 自采集不可用，退回原生 getDisplayMedia')
            try { ipc.removeListener('PORTAL_FRAME', onFrame) } catch {}
            return nativeGetDisplayMedia(constraints)
          }
          const stream = canvas.captureStream(FPS)
          const stop = () => {
            if (!alive) return
            alive = false
            try { ipc.removeListener('PORTAL_FRAME', onFrame) } catch {}
            ipc.invoke('PORTAL_CAPTURE_STOP').catch(() => {})
            console.log('[shim] 分享流已停止')
          }
          stream.getVideoTracks().forEach((t) => t.addEventListener('ended', stop))
          return stream
        }
        console.log('[shim] getDisplayMedia 已接管（PipeWire 自采集）')
      } catch (e) {
        console.log('[shim] getDisplayMedia 接管失败', e && e.message)
      }
    }
  } catch (e) {
    console.log('[shim] 收口失败', e && e.message)
  }
}, 0)


// ── 客户端透明（自定义主题里的 appBlur）真源同步 ──
// 官方渲染层对 appBlur 只做两件事：发 blurbehind / app_bg_disable，
// 以及给 body 加/去掉 theme-app-blur（CSS: .theme-app-blur .app-background{opacity:0}）。
// 前者在主题被反复重算时会被来回重放，谁最后到就听谁的，窗口透明度就会抖成「失效」。
// 这里改成以 body 上的 class 为唯一真源：有 class → 窗口透明，没有 → 铺不透明底；
// 只在真变化时通知一次，重放不产生任何副作用。
;(function installAppBlurSync() {
  try {
    const { ipcRenderer } = require('electron')
    let last = null
    const sync = () => {
      if (!document.body) return
      const on = document.body.classList.contains('theme-app-blur')
      if (on === last) return
      last = on
      try { ipcRenderer.send('kook-linux:app-blur', on) } catch {}
      console.log('[shim] 客户端透明:', on ? '开（透出桌面）' : '关（不透明底）')
    }
    const boot = () => {
      sync()
      try {
        new MutationObserver(sync).observe(document.body, {
          attributes: true,
          attributeFilter: ['class'],
        })
      } catch (e) {
        console.log('[shim] 透明同步挂载失败', e && e.message)
      }
    }
    if (document.body) boot()
    else document.addEventListener('DOMContentLoaded', boot, { once: true })
  } catch (e) {
    console.log('[shim] 透明同步初始化失败', e && e.message)
  }
})()

// ── 客户端透明的最后一块：.app-mask-layer ──
// 官方 CSS 对 theme-app-blur 只写了 `.theme-app-blur .app-background{opacity:0}`，
// 可主界面还有一层 .app-mask-layer（z-index:1、background:var(--color-bg-setting-sunken)
// 也就是 #17181a 纯不透明）压在 app-background 上面。底下透明了，这层照样把桌面挡死，
// 表现就是「客户端透明怎么点都没反应」。这里补一条，只在 theme-app-blur 生效时一起透明。
;(function installAppMaskTransparentCss() {
  try {
    const CSS_ID = 'kook-linux-app-mask-css'
    const apply = () => {
      if (document.getElementById(CSS_ID)) return
      const st = document.createElement('style')
      st.id = CSS_ID
      st.textContent =
        '.theme-app-blur .app-mask-layer{background-color:transparent!important}'

      ;(document.head || document.documentElement).appendChild(st)
      console.log('[shim] 已注入 app-mask-layer 透明补丁')
    }
    if (document.head) apply()
    else document.addEventListener('DOMContentLoaded', apply, { once: true })
  } catch (e) {
    console.log('[shim] 覆盖层透明补丁注入失败', e && e.message)
  }
})()

// ── 按键兜底：把所有键盘事件按官方 IO_HOOK 的形状回环给渲染层 ──
// Wayland 下 globalShortcut 走的是 XGrabKey，对原生 Wayland 的首焦键盘流不一定生效，
// 表现就是「设了快捷键，按下去没反应」。KOOK 自己有焦点时 DOM 的 keydown/keyup 一定收得到，
// 而且 DOM 的 keyCode 就是 Windows VK 码（F2=113、Ctrl=17、Alt=18、Shift=16、Super=91），
// 和设置里存的值完全一致，不用换算。
// 官方 iohook 本来就是全局钩子、抓所有键，所以这里也全发，让渲染层按用户自己配的
// 快捷键去判断 —— 我们猜一份白名单反而会让没猜到的键失灵（氛围音、全屏截图之类）。
;(function installLocalKeyFallback() {
  try {
    const { ipcRenderer } = require('electron')
    const send = (type, ev) => {
      if (!ev.keyCode) return
      try {
        ipcRenderer.send('KOOK_VK_FIRED', {
          type,
          rawcode: ev.keyCode,
          ctrl: !!ev.ctrlKey,
          alt: !!ev.altKey,
          shift: !!ev.shiftKey,
          meta: !!ev.metaKey,
        })
      } catch (e) {}
    }
    // 捕获阶段：输入框里也照样收得到，和全局钩子行为一致
    window.addEventListener('keydown', (ev) => { if (!ev.repeat) send('keydown', ev) }, true)
    window.addEventListener('keyup', (ev) => send('keyup', ev), true)
  } catch (e) {
    console.log('[shim] 本地按键兜底初始化失败', e && e.message)
  }
})()
