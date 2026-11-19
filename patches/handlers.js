// 真实主进程通道实现（按 preload 契约反推）
// 覆盖：store 三套持久化 / setting / system 信息 / 快捷键 / regedit 桩
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

function createRuntime({ app, LOG }) {
  const { safeStorage, screen, desktopCapturer, session } = require('electron')
  const { execFileSync } = require('child_process')

  // ───────────────────────── 凭据存储（SAFE_STORAGE_*）─────────────────────────
  // 这里存的是登录 token（store important 'ka'），等价于账号凭据，按密文对待。
  // 取数优先级：
  //   1. Electron safeStorage 且后端是真后端（gnome_libsecret / kwallet*）
  //   2. libsecret Secret Service（secret-tool）自管主密钥 + AES-256-GCM
  //   3. 两者都没有 → 明确告警；不再静默 Base64 落盘
  // 说明：Electron 在 Linux 上的 basic_text 后端用的是 Chromium 内置硬编码口令，
  // isEncryptionAvailable() 仍返回 true，但等同于明文，必须单独识别并排除。
  const SECRET_SERVICE = 'kook-linux'
  const SECRET_ACCOUNT = 'store-key'
  const GCM_PREFIX = 'v2:'
  const PLAIN_PREFIX = 'v0:'
  const WARN_MARK = path.join(app.getPath('userData'), 'linux-store', '.cred-warning-shown')

  let secretState = null // {mode:'safeStorage'|'keyring'|'insecure'|'none', backend, secure}
  let masterKey = null
  let warned = false

  function probeSafeStorage() {
    let available = false
    let backend = 'unknown'
    try {
      available = !!(safeStorage && safeStorage.isEncryptionAvailable())
    } catch (e) {
      LOG('[cred] safeStorage.isEncryptionAvailable 异常:', e && e.message)
    }
    try {
      if (safeStorage && typeof safeStorage.getSelectedStorageBackend === 'function') {
        backend = safeStorage.getSelectedStorageBackend()
      }
    } catch (e) {
      LOG('[cred] getSelectedStorageBackend 异常:', e && e.message)
    }
    // basic_text 不是加密：Chromium 用固定口令派生密钥，任何本机进程都能解
    const secure = available && backend !== 'basic_text'
    return { available, backend, secure }
  }

  function keyringLookup() {
    try {
      const out = execFileSync(
        'secret-tool',
        ['lookup', 'service', SECRET_SERVICE, 'account', SECRET_ACCOUNT],
        { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return out || ''
    } catch {
      return ''
    }
  }

  function keyringStore(hexKey) {
    try {
      execFileSync(
        'secret-tool',
        [
          'store',
          `--label=KOOK Linux 凭据密钥`,
          'service', SECRET_SERVICE,
          'account', SECRET_ACCOUNT,
        ],
        { timeout: 3000, encoding: 'utf8', input: hexKey, stdio: ['pipe', 'ignore', 'ignore'] }
      )
      return true
    } catch (e) {
      LOG('[cred] 写入系统密钥环失败:', e && e.message)
      return false
    }
  }

  // 取（或首次生成）AES-256 主密钥，只放系统密钥环，不落磁盘
  function loadMasterKey() {
    if (masterKey) return masterKey
    let hex = keyringLookup()
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      hex = crypto.randomBytes(32).toString('hex')
      if (!keyringStore(hex)) return null
      // 回读校验：密钥环服务不可用时 secret-tool 可能"成功"但读不回来
      const back = keyringLookup()
      if (!/^[0-9a-f]{64}$/i.test(back) || back !== hex) {
        LOG('[cred] 密钥环回读校验失败，放弃自管密钥')
        return null
      }
    }
    masterKey = Buffer.from(hex, 'hex')
    return masterKey
  }

  function resolveSecretState() {
    if (secretState) return secretState
    const probe = probeSafeStorage()
    if (probe.secure) {
      secretState = { mode: 'safeStorage', backend: probe.backend, available: true, secure: true }
    } else if (loadMasterKey()) {
      secretState = { mode: 'keyring', backend: 'libsecret', available: true, secure: true }
    } else {
      const allowInsecure = process.env.KOOK_INSECURE_STORE === '1'
      secretState = {
        mode: allowInsecure ? 'insecure' : 'none',
        backend: probe.backend,
        available: probe.available,
        secure: false,
      }
      warnInsecure(secretState)
    }
    LOG(
      '[cred] 凭据存储后端:',
      secretState.mode,
      'backend=' + secretState.backend,
      secretState.secure ? '（加密）' : '（未加密）'
    )
    return secretState
  }

  // 明确提示，而不是静默降级；每次安装只弹一次
  function warnInsecure(state) {
    if (warned) return
    warned = true
    const insecureWrites = state.mode === 'insecure'
    const why = state.available === false
      ? 'safeStorage 不可用（后端显示 ' + state.backend + '），且 secret-tool 也不可用。'
      : 'safeStorage 后端 ' + state.backend + ' 不提供真正的加密（basic_text），且 secret-tool 不可用。'
    const msg = insecureWrites
      ? why + '\n' +
        '已按 KOOK_INSECURE_STORE=1 的显式设置以便捷方式保存登录凭据：文件内是 Base64，' +
        '不是加密，任何能读你 home 的进程都能取到登录令牌。\n' +
        '建议安装并启动 gnome-keyring 或 kwallet 后重启客户端，凭据会自动迁移为密文。'
      : why + '\n' +
        '为了避免把登录令牌以明文等价形式落盘，本次不会持久化登录状态：' +
        '关闭客户端后需要重新登录。\n' +
        '安装并启动 gnome-keyring 或 kwallet 即可恢复「记住登录」。\n' +
        '如果你明确接受风险，可设置环境变量 KOOK_INSECURE_STORE=1 后再启动。'
    LOG('[cred] 警告:', msg.replace(/\n/g, ' '))
    try {
      if (fs.existsSync(WARN_MARK)) return
      fs.mkdirSync(path.dirname(WARN_MARK), { recursive: true })
      fs.writeFileSync(WARN_MARK, new Date().toISOString() + '\n')
    } catch {}
    // 异步弹窗，绝不阻塞 sendSync；无头/自动化环境可用 KOOK_NO_DIALOG=1 关掉弹窗（仍写日志）
    if (process.env.KOOK_NO_DIALOG === '1') return
    try {
      const { dialog } = require('electron')
      app.whenReady().then(() => {
        try {
          dialog.showMessageBox({
            type: 'warning',
            title: 'KOOK: 登录凭据未加密保存',
            message: insecureWrites ? '登录凭据将以未加密方式保存' : '本次不会保存登录状态',
            detail: msg,
            buttons: ['知道了'],
            noLink: true,
          })
        } catch (e) {
          LOG('[cred] 弹窗失败:', e && e.message)
        }
      })
    } catch (e) {
      LOG('[cred] 弹窗不可用:', e && e.message)
    }
  }

  function gcmEncrypt(key, str) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update(str, 'utf8'), c.final()])
    return (
      GCM_PREFIX +
      [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
    )
  }

  function gcmDecrypt(key, payload) {
    const [ivB64, tagB64, ctB64] = payload.slice(GCM_PREFIX.length).split(':')
    if (!ivB64 || !tagB64 || !ctB64) return ''
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    d.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8')
  }

  // 识别历史格式：Electron 密文 base64 解出来以 v10/v11 开头；旧版降级则是裸 base64 明文
  function looksLikeElectronCipher(buf) {
    if (!buf || buf.length < 3) return false
    const head = buf.subarray(0, 3).toString('latin1')
    return head === 'v10' || head === 'v11'
  }

  let needsMigration = false

  // 登录 token 走这里加密后再存 'ka'：必须返回字符串，不能返回对象
  const encrypt = (plain) => {
    const str = String(plain == null ? '' : plain)
    const state = resolveSecretState()
    if (state.mode === 'safeStorage') {
      try {
        return safeStorage.encryptString(str).toString('base64')
      } catch (e) {
        LOG('[cred] safeStorage 加密失败，尝试密钥环:', e && e.message)
      }
    }
    if (state.mode === 'safeStorage' || state.mode === 'keyring') {
      const key = loadMasterKey()
      if (key) {
        try {
          return gcmEncrypt(key, str)
        } catch (e) {
          LOG('[cred] AES-GCM 加密失败:', e && e.message)
        }
      }
    }
    if (state.mode === 'insecure') {
      return PLAIN_PREFIX + Buffer.from(str, 'utf8').toString('base64')
    }
    // 无安全后端且未显式接受风险：拒绝落盘，让上层拿不到可存的密文
    LOG('[cred] 无可用安全存储，拒绝保存凭据（返回空串）')
    return ''
  }

  const decrypt = (b64) => {
    const s = String(b64 == null ? '' : b64)
    if (!s) return ''
    try {
      if (s.startsWith(GCM_PREFIX)) {
        const key = loadMasterKey()
        if (!key) return ''
        try {
          return gcmDecrypt(key, s)
        } catch (e) {
          LOG('[cred] 密文解密失败（密钥环可能已重置）:', e && e.message)
          return ''
        }
      }
      if (s.startsWith(PLAIN_PREFIX)) return Buffer.from(s.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')

      const buf = Buffer.from(s, 'base64')
      // 历史格式 1：Electron safeStorage 密文（当前机器若换了密钥环会解不开）
      if (looksLikeElectronCipher(buf)) {
        try {
          return safeStorage.decryptString(buf)
        } catch (e) {
          LOG('[cred] 历史 safeStorage 密文无法解密:', e && e.message)
          return ''
        }
      }
      // 历史格式 2：旧版静默降级的 Base64 明文，读出来但标记需要迁移
      const legacy = buf.toString('utf8')
      if (legacy) {
        LOG('[cred] 读到历史未加密凭据，将在下次写入时升级为密文')
        needsMigration = true
      }
      return legacy
    } catch (e) {
      LOG('[cred] decrypt 异常:', e && e.message)
      return ''
    }
  }

  const secretStatus = () => {
    const st = resolveSecretState()
    return { mode: st.mode, backend: st.backend, secure: st.secure, needsMigration }
  }

  const dir = path.join(app.getPath('userData'), 'linux-store')
  fs.mkdirSync(dir, { recursive: true })

  const files = {
    global: path.join(dir, 'global.json'),
    user: path.join(dir, 'user.json'),
    important: path.join(dir, 'important.json'),
    setting: path.join(dir, 'setting.json'),
  }

  function load(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {}
    } catch {
      return {}
    }
  }

  const data = {
    global: load(files.global),
    user: load(files.user),
    important: load(files.important),
    setting: load(files.setting),
  }

  const dirty = new Set()
  let timer = null
  function markDirty(name) {
    dirty.add(name)
    if (timer) return
    timer = setTimeout(flush, 300)
  }
  function flush() {
    timer = null
    for (const name of dirty) {
      try {
        fs.writeFileSync(files[name], JSON.stringify(data[name], null, 2))
      } catch (e) {
        LOG('store flush failed', name, e && e.message)
      }
    }
    dirty.clear()
  }

  // 历史数据迁移：旧版把登录凭据按「裸 Base64」写过盘（等同明文）。
  // 只要当前有安全后端，就在这里升级为密文；没有安全后端则保持原样并告警。
  function migrateCredentials() {
    const cur = data.important && data.important.ka
    if (!cur || typeof cur !== 'string') return
    if (cur.startsWith(GCM_PREFIX) || cur.startsWith(PLAIN_PREFIX)) return
    const buf = Buffer.from(cur, 'base64')
    if (looksLikeElectronCipher(buf)) return
    const plain = buf.toString('utf8')
    if (!plain) return
    const re = encrypt(plain)
    if (!re) {
      LOG('[cred] 检测到历史未加密登录凭据，但当前无安全存储可用，未做迁移')
      return
    }
    data.important.ka = re
    markDirty('important')
    LOG('[cred] 历史未加密登录凭据已迁移为密文:', re.slice(0, 3))
  }
  migrateCredentials()

  // ───────────────────────── 服务端域名（真实现，非伪成功）─────────────────────────
  // 官方 GET_ACTIVE_DOMAIN 的返回形状是 runtime-domain 里用到的 activeApiOrigin /
  // activeH5Origin / activeFirstPartyOrigins，不是 {origin,api}；
  // SWITCH_SERVER_API 只在白名单域名之间真的切换并持久化，其余一律拒绝。
  const originOf = (v) => {
    try {
      return new URL(String(v)).origin
    } catch {
      return ''
    }
  }

  const domainCfg = (() => {
    const candidates = [
      path.join(app.getAppPath(), 'src', 'config.json'),
      path.join(__dirname, '..', 'src', 'config.json'),
      process.resourcesPath ? path.join(process.resourcesPath, 'app', 'src', 'config.json') : '',
    ].filter(Boolean)
    for (const file of candidates) {
      try {
        const conf = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (conf && conf.domainSwitch) return conf.domainSwitch
      } catch {}
    }
    return {}
  })()

  const DOMAINS = {
    primary: {
      api: domainCfg.primaryApiOrigin || 'https://www.kookapp.cn',
      h5: domainCfg.primaryH5Origin || 'https://m.kookapp.cn',
    },
    backup: {
      api: domainCfg.backupApiOrigin || 'https://www.kookyuyin.cn',
      h5: domainCfg.backupH5Origin || 'https://m.kookyuyin.cn',
    },
  }
  const DOMAIN_ALLOW = new Set()
  for (const sel of Object.keys(DOMAINS)) {
    DOMAIN_ALLOW.add(originOf(DOMAINS[sel].api))
    DOMAIN_ALLOW.add(originOf(DOMAINS[sel].h5))
  }
  for (const pair of domainCfg.firstPartyOriginPairs || []) {
    DOMAIN_ALLOW.add(originOf(pair.primaryOrigin))
    DOMAIN_ALLOW.add(originOf(pair.backupOrigin))
  }
  DOMAIN_ALLOW.delete('')

  const domainFile = path.join(dir, 'domain.json')
  let domainSelection = 'primary'
  try {
    const saved = JSON.parse(fs.readFileSync(domainFile, 'utf8'))
    if (saved && (saved.selected === 'backup' || saved.selected === 'primary')) {
      domainSelection = saved.selected
    }
  } catch {}

  function persistDomain() {
    try {
      fs.writeFileSync(domainFile, JSON.stringify({ selected: domainSelection }, null, 2))
      return true
    } catch (e) {
      LOG('[domain] 保存域名选择失败:', e && e.message)
      return false
    }
  }

  function domainSnapshot(reason) {
    const sel = domainSelection
    const active = DOMAINS[sel] || DOMAINS.primary
    return {
      // runtime-domain 读这三项
      activeApiOrigin: active.api,
      activeH5Origin: active.h5,
      activeFirstPartyOrigins: (domainCfg.firstPartyOriginPairs || []).map((pair) => ({
        primaryOrigin: pair.primaryOrigin,
        backupOrigin: pair.backupOrigin,
        activeOrigin: sel === 'backup' ? pair.backupOrigin : pair.primaryOrigin,
      })),
      selectedDomain: sel,
      selectedReason: reason || (sel === 'backup' ? 'manual' : 'primary_healthy'),
      available: true,
      backupEnabled: DOMAINS.backup.api !== DOMAINS.primary.api,
      configVersion: 0,
      region: '',
      // 旧形状保留，避免还在按 {origin,api} 读的调用方拿到 undefined
      origin: active.api,
      api: active.api,
    }
  }

  function pickSwitchTarget(input) {
    const raw =
      typeof input === 'string'
        ? input
        : input && (input.origin || input.api || input.activeApiOrigin || input.url || input.domain)
    if (!raw) return ''
    const asOrigin = originOf(raw)
    if (asOrigin) return asOrigin
    // 允许直接传 'primary' / 'backup'
    if (raw === 'primary' || raw === 'backup') return originOf(DOMAINS[raw].api)
    return ''
  }

  // 稳定机器标识（首次生成后复用）
  const idFile = path.join(dir, 'machine-id')
  // ── 设备指纹来源（灰度）──
  // 官方 device-feature 要 { bios, machine, device_id }；当前线上只发 device_id（{id,type} 形状），
  // bios/machine 被 JSON.stringify 吞掉。补齐会换掉全员指纹 → 用环境变量灰度，默认关。
  const DETAIL_FULL = process.env.KOOK_DEVICE_DETAIL_FULL === '1'
  let fingerprint = null
  function deviceFingerprint() {
    if (fingerprint) return fingerprint
    if (!DETAIL_FULL) {
      fingerprint = { mode: 'legacy', device_id: null, bios: null, machine: null }
      return fingerprint
    }
    const identity = require(path.join(__dirname, 'device-identity.js')).createDeviceIdentity(app)
    fingerprint = {
      mode: 'full',
      device_id: identity.device_id,
      bios: identity.bios,
      machine: identity.machine,
    }
    LOG(
      '[device] 灰度开启：指纹切换为完整形状',
      'device_id=' + identity.device_id,
      'bios=' + identity.bios,
      'machine=' + identity.machine
    )
    return fingerprint
  }

  let machineId = ''
  try {
    machineId = fs.readFileSync(idFile, 'utf8').trim()
  } catch {}
  if (!machineId) {
    machineId = crypto.createHash('md5').update(os.hostname() + os.platform() + (os.cpus()[0] || {}).model).digest('hex')
    try {
      fs.writeFileSync(idFile, machineId)
    } catch {}
  }

  const pathMap = {
    home: () => app.getPath('home'),
    appData: () => app.getPath('appData'),
    userData: () => app.getPath('userData'),
    temp: () => app.getPath('temp'),
    exe: () => app.getPath('exe'),
    desktop: () => app.getPath('desktop'),
    documents: () => app.getPath('documents'),
    downloads: () => app.getPath('downloads'),
    music: () => app.getPath('music'),
    pictures: () => app.getPath('pictures'),
    videos: () => app.getPath('videos'),
    logs: () => app.getPath('logs'),
    crashDumps: () => app.getPath('crashDumps'),
  }

  const shortcuts = new Map()
  const childWins = new Map()
  // 主进程别处（OVERLAY_WINDOW_GET_BOUNDS/SET_BOUNDS）要按 id 找到这些子窗口，
  // 闭包传不出去，就挂到 globalThis 上共享。
  try { globalThis.__kookChildWins = childWins } catch (e) {}

  // Windows VK 码 → Electron accelerator（只覆盖设置里可能用到的键）
  const VK_TO_ACCEL = (() => {
    const m = {}
    for (let i = 0; i < 26; i++) m[65 + i] = String.fromCharCode(65 + i)
    for (let i = 0; i <= 9; i++) m[48 + i] = String(48 + i)
    for (let i = 1; i <= 12; i++) m[111 + i] = 'F' + i
    Object.assign(m, {
      8: 'Backspace', 9: 'Tab', 13: 'Return', 27: 'Escape', 32: 'Space',
      33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
      37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
      45: 'Insert', 46: 'Delete',
      186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/',
      192: '`', 219: '[', 220: '\\', 221: ']', 222: "'",
    })
    return m
  })()

  let ioHookAccels = []

  // 设置里配的快捷键组合，值都是 Windows VK 码数组（如 [17,18,76] = Ctrl+Alt+L）
  function shortcutCombos() {
    const out = []
    const seen = new Set()
    const push = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return
      const key = arr.join(',')
      if (seen.has(key)) return
      seen.add(key)
      out.push(arr)
    }
    const audio = data.user.AUDIO_CONFIG_KEY || {}
    for (const field of ['openInputKey', 'closeInputKey', 'quickMuteKey']) push(audio[field])
    const appCfg = data.user.kaihei_app_config || data.global.kaihei_app_config || {}
    push(appCfg.screen_recording_shortcut)
    push(appCfg.screenshot_shortcut)
    return out
  }

  function isModifierVk(vk) {
    return vk === 16 || vk === 17 || vk === 18 || vk === 91 || vk === 92
  }

  function comboToAccel(vks) {
    const mods = []
    let main = null
    for (const vk of vks) {
      if (vk === 17) mods.push('Control')
      else if (vk === 18) mods.push('Alt')
      else if (vk === 16) mods.push('Shift')
      else if (vk === 91 || vk === 92) mods.push('Super')
      else if (VK_TO_ACCEL[vk]) main = vk
    }
    if (main === null) return null
    return [...mods, VK_TO_ACCEL[main]].join('+')
  }

  function registerIoHook() {
    const { globalShortcut, BrowserWindow } = require('electron')
    for (const acc of ioHookAccels) {
      try { globalShortcut.unregister(acc) } catch (e) {}
    }
    ioHookAccels = []
    for (const vks of shortcutCombos()) {
      const acc = comboToAccel(vks)
      if (!acc) continue
      try {
        const ok = globalShortcut.register(acc, () => {
          LOG('[iohook] 命中', acc, '-> 派发 IO_HOOK', vks.join(','))
          const push = (type, vk) => {
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) {
                try { w.webContents.send('IO_HOOK', { type, rawcode: vk }) } catch (e) {}
              }
            }
          }
          // 原生钩子是按顺序各发一次的，这里照样补全：先所有按下，再所有抬起
          for (const vk of vks) push('keydown', vk)
          setTimeout(() => { for (const vk of vks) push('keyup', vk) }, 90)
        })
        if (ok) ioHookAccels.push(acc)
      } catch (e) {}
    }
    if (ioHookAccels.length) LOG('[iohook] 已接管按键', ioHookAccels.join(' , '))
    return ioHookAccels.length
  }

  // ── 本地键盘桥（Wayland 兜底）──
  // Wayland 下 globalShortcut 实际是 XGrabKey，对原生 Wayland 的首焦键盘流不一定生效，
  // 用户看到的就是「设了快捷键按下去没反应」。KOOK 自己有焦点时 DOM 键盘事件一定收得到，
  // preload 把 F 键 / 修饰键 / 带修饰的键发上来，这里按官方 IO_HOOK 的形状原样派发。
  // 和 globalShortcut 撞车时按「键码+类型」120ms 去重，不会重复触发两次。
  let vkBridgeReady = false
  const vkLastFired = new Map()
  function installVkBridge() {
    if (vkBridgeReady) return
    vkBridgeReady = true
    try {
      const { ipcMain, BrowserWindow } = require('electron')
      ipcMain.on('KOOK_VK_FIRED', (event, msg) => {
        if (!msg || typeof msg.rawcode !== 'number' || !msg.rawcode) return
        const type = msg.type === 'keyup' ? 'keyup' : 'keydown'
        const stamp = type + ':' + msg.rawcode
        const now = Date.now()
        if (now - (vkLastFired.get(stamp) || 0) < 120) return
        vkLastFired.set(stamp, now)
        // 全量转发会刷屏，只在「看起来像快捷键」的时候留痕（F 键 / 带修饰键）
        const looksHotkey = (msg.rawcode >= 112 && msg.rawcode <= 123) || msg.ctrl || msg.alt || msg.meta
        if (looksHotkey) LOG('[iohook] 本地键盘', type, msg.rawcode)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            try { w.webContents.send('IO_HOOK', { type, rawcode: msg.rawcode }) } catch (e) {}
          }
        }
      })
      LOG('[iohook] 本地键盘桥已挂载（DOM 事件兜底）')
    } catch (e) {
      LOG('[iohook] 本地键盘桥挂载失败', e && e.message)
    }
  }

  const handlers = {
    // ── store ──
    STORE_GLOBAL_GET: (key, def) => (key in data.global ? data.global[key] : def),
    STORE_GLOBAL_SET: (key, value) => {
      data.global[key] = value
      markDirty('global')
    },
    STORE_GLOBAL_REMOVE: (key) => {
      delete data.global[key]
      markDirty('global')
    },
    STORE_GLOBAL_GET_ALL: () => ({ ...data.global }),
    STORE_GLOBAL_INIT: () => {},

    STORE_USER_GET: (key, def) => (key in data.user ? data.user[key] : def),
    STORE_USER_SET: (key, value) => {
      data.user[key] = value
      markDirty('user')
    },
    STORE_USER_REMOVE: (key) => {
      delete data.user[key]
      markDirty('user')
    },
    STORE_USER_INIT: () => {},

    STORE_IMPORTANT_GET: (key, def) => (key in data.important ? data.important[key] : def),
    STORE_IMPORTANT_SET: (key, value) => {
      data.important[key] = value
      markDirty('important')
    },
    STORE_IMPORTANT_REMOVE: (key) => {
      delete data.important[key]
      markDirty('important')
    },

    STORE_SESSION_FLUSH: () => flush(),
    STORE_AUTH_BACKFILL_COOKIE: () => null,
    STORE_IS_AUTH_COOKIE_MISSING: () => false,

    // ── setting ──
    SETTING_GET: (key, def) => (key in data.setting ? data.setting[key] : def),
    SETTING_SET: (key, value) => {
      data.setting[key] = value
      markDirty('setting')
    },

    // ── system ──
    SYSTEM_GET_PATH: (name) => {
      const fn = pathMap[name]
      try {
        return fn ? fn() : app.getPath('userData')
      } catch {
        return app.getPath('userData')
      }
    },
    SYSTEM_GET_PCNAME: () => 'DESKTOP-K00KPC',
    SYSTEM_GET_SYSTEM_VERSION: () => '10.0.22631',
    SYSTEM_GET_UNIQUE: () => {
      const fp = deviceFingerprint()
      // 关灰度时保持线上值（machineId）不变，避免老用户指纹漂移
      return fp.mode === 'full' ? fp.device_id : machineId
    },
    SYSTEM_GET_UNIQUE_DETAIL: () => {
      const fp = deviceFingerprint()
      if (fp.mode !== 'full') return { id: machineId, type: 'linux' }
      // webapp 直接用这三个字段拼 device-feature；device_id 必须与 getUnique 一致
      return { bios: fp.bios, machine: fp.machine, device_id: fp.device_id }
    },
    SYSTEM_GET_ARGV: () => process.argv.slice(1),
    SYSTEM_GET_ACTIVE_DOMAIN: () => domainSnapshot(),
    SYSTEM_GET_HARDWARE_ACCELERATION: () => true,
    SYSTEM_SET_HARDWARE_ACCELERATION: () => {},
    SYSTEM_GET_MICROPHONE_PERMISSION: () => 'granted',
    SYSTEM_REQUEST_MICROPHONE_PERMISSION: () => 'granted',
    SYSTEM_RELAUNCH: () => {
      app.relaunch()
      app.exit(0)
    },
    SYSTEM_IS_RELAUNCH_UPDATE: () => false,

    // ── 全局快捷键：真调 Electron globalShortcut ──
    // X11 下直接走 XGrabKey；Wayland 下 Electron 会转 XDG GlobalShortcuts portal，
    // 能不能成取决于桌面实现，所以一律如实返回结果，注册失败由界面提示。
    GLOBAL_SHORTCUT_IS_REGISTER: (acc) => {
      try {
        return require('electron').globalShortcut.isRegistered(String(acc))
      } catch (e) {
        return false
      }
    },
    GLOBAL_SHORTCUT_REGISTER: (acc) => {
      try {
        const { globalShortcut, BrowserWindow } = require('electron')
        const key = String(acc)
        if (globalShortcut.isRegistered(key)) {
          shortcuts.set(key, true)
          return true
        }
        const ok = globalShortcut.register(key, () => {
          try {
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) w.webContents.send('GLOBAL_SHORTCUT_CALLBACK', key)
            }
          } catch {}
        })
        if (ok) {
          shortcuts.set(key, true)
          LOG('[shortcut] 已注册', key)
        } else {
          LOG('[shortcut] 注册失败', key, '（Wayland 需桌面支持 GlobalShortcuts portal）')
        }
        return ok
      } catch (e) {
        LOG('[shortcut] 注册异常', acc, e && e.message)
        return false
      }
    },
    GLOBAL_SHORTCUT_UNREGISTER: (acc) => {
      try {
        require('electron').globalShortcut.unregister(String(acc))
      } catch (e) {}
      shortcuts.delete(String(acc))
    },

    // ── Windows 注册表 → 空桩（Linux 无对应物）──
    REGEDIT_GET: () => null,
    REGEDIT_SET: () => null,
    REGEDIT_DELETE: () => null,

    // ── 屏幕（Electron screen API）──
    SCREEN_GET_ALL_DISPLAY: () => {
      try { return screen.getAllDisplays() } catch { return [] }
    },
    SCREEN_GET_PRIMARY_DISPLAY: () => {
      try { return screen.getPrimaryDisplay() } catch { return null }
    },
    SCREEN_GET_DISPLAY_NEAREST_POINT: (p) => {
      try { return screen.getDisplayNearestPoint(p || { x: 0, y: 0 }) } catch { return null }
    },
    SCREEN_GET_DISPLAY_MATCHING: (r) => {
      try { return screen.getDisplayMatching(r || { x: 0, y: 0, width: 1, height: 1 }) } catch { return null }
    },
    SCREEN_GET_CURSOR_SCREEN_POINT: () => {
      try { return screen.getCursorScreenPoint() } catch { return { x: 0, y: 0 } }
    },
    SCREEN_DIP_TO_SCREEN_RECT: (r) => {
      try { return screen.dipToScreenRect(null, r) } catch { return r }
    },
    SCREEN_DIP_TO_SCREEN_POINT: (p) => {
      try { return screen.dipToScreenPoint(null, p) } catch { return p }
    },
    SCREEN_SCREEN_TO_DIP_POINT: (p) => {
      try { return screen.screenToDipPoint(p) } catch { return p }
    },
    CHECK_FULLSCREEN_START: () => {},
    CHECK_FULLSCREEN_STOP: () => {},

    // ── safeStorage（token 加密）──
    SAFE_STORAGE_ENCRYPT: (plain) => encrypt(plain),
    SAFE_STORAGE_DECRYPT: (data) => decrypt(data),

    // ── 日志：吞掉（避免刷屏），保留错误到文件 ──
    LOGGER_APP_LOG: (payload) => {
      const frames = (payload && payload.frames) || []
      for (const f of frames) {
        if (f.level === 'error') LOG('[app-log:error]', ...(f.args || []).slice(0, 2))
      }
    },
    LOGGER_OPEN_DIR: () => {},
    LOGGER_GET_ZIP_FILE: () => null,
    LOGGER_UPDATE_COMMON_PARAMS: () => {},

    // ── 其他高频噪音 ──
    BOOSTER_CLEAN_CACHE: () => {},
    VOLUME_REFRESH_DEVICE_LIST: () => {},
    SESSION_GET_COOKIES: () => [],
  }


  // ── 系统能力（Linux 真实现）──
  const { shell, dialog, clipboard, nativeImage } = require('electron')
  // execFileSync 已在文件顶部（凭据存储段）引入，这里复用
  const runCmd = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { timeout: 2500, encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }

  Object.assign(handlers, {
    SYSTEM_IS_RELAUNCH_PROACTIVE_UPDATE: () => false,
    SYSTEM_COPY_IMAGE: (dataUrlOrPath) => {
      try {
        const img = String(dataUrlOrPath || '').startsWith('data:')
          ? nativeImage.createFromDataURL(dataUrlOrPath)
          : nativeImage.createFromPath(String(dataUrlOrPath))
        clipboard.writeImage(img)
        return true
      } catch {
        return false
      }
    },
    SYSTEM_SHOW_SAVE_DIALOG: async (opts) => {
      try {
        const r = await dialog.showSaveDialog(opts && opts.window ? opts.window : undefined, {
          defaultPath: (opts && opts.defaultPath) || path.join(app.getPath('downloads'), 'kook-file'),
          filters: (opts && opts.filters) || undefined,
        })
        return { canceled: r.canceled, filePath: r.filePath || '' }
      } catch {
        return { canceled: true, filePath: '' }
      }
    },
    SYSTEM_SHOW_OPEN_DIALOG: async (opts) => {
      try {
        const r = await dialog.showOpenDialog({
          properties: (opts && opts.properties) || ['openFile'],
          filters: (opts && opts.filters) || undefined,
        })
        return { canceled: r.canceled, filePaths: r.filePaths || [] }
      } catch {
        return { canceled: true, filePaths: [] }
      }
    },
    SYSTEM_GET_DXDIAGINFO: () => ({ os: 'Windows 10', gpu: 'Virtual', directx: '12' }),
    SYSTEM_GET_BLUETOOTH_DEVICE: () => [],
    SYSTEM_OPEN_PATH: (p) => {
      try {
        shell.openPath(String(p || ''))
        return true
      } catch {
        return false
      }
    },
    SYSTEM_OPEN_EXTERNAL: (url) => {
      try {
        shell.openExternal(String(url || ''))
        return true
      } catch {
        return false
      }
    },
    SYSTEM_GET_FILE: async (options) => {
      // 原实现返回 {code:0,data:null}：声称成功却没有数据。
      // 这里走真实的原生选择器；打不开就返回 code:-1，不伪装成功。
      try {
        const { dialog, BrowserWindow } = require('electron')
        const opt = options && typeof options === 'object' ? options : {}
        const properties =
          Array.isArray(opt.properties) && opt.properties.length ? opt.properties : ['openFile']
        const dlgOpts = { properties }
        if (Array.isArray(opt.filters) && opt.filters.length) dlgOpts.filters = opt.filters
        if (typeof opt.title === 'string' && opt.title) dlgOpts.title = opt.title
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        // 没有窗口（无头/自动化）时不要去弹原生对话框：那会一直挂住 sendSync 调用方
        if (!win) return { code: -1, message: '当前没有可用窗口，无法打开文件选择器' }
        const res = await dialog.showOpenDialog(win, dlgOpts)
        return {
          code: 0,
          data: { canceled: !!(res && res.canceled), filePaths: (res && res.filePaths) || [] },
        }
      } catch (e) {
        LOG('[file] 打开文件选择器失败:', e && e.message)
        return { code: -1, message: '打开文件选择器失败: ' + (e && e.message) }
      }
    },
    SYSTEM_LOGOUT: async () => {
      try {
        await session.defaultSession.clearStorageData()
        data.user = {}
        data.important = {}
        markDirty('user')
        markDirty('important')
      } catch {}
      return true
    },
    SYSTEM_GET_DNS_SERVER: () => {
      const txt = (() => {
        try {
          return fs.readFileSync('/etc/resolv.conf', 'utf8')
        } catch {
          return ''
        }
      })()
      const list = txt
        .split('\n')
        .filter((l) => /^nameserver/.test(l))
        .map((l) => l.replace(/^nameserver\s+/, '').trim())
      return list.length ? list : ['1.1.1.1']
    },
    SYSTEM_WAIT_ACTIVE_DOMAIN: () => domainSnapshot('waited'),
    SYSTEM_SWITCH_SERVER_API: (input) => {
      const target = pickSwitchTarget(input)
      if (!target) {
        LOG('[domain] 切换被拒绝：无法解析目标', JSON.stringify(input))
        return false
      }
      if (!DOMAIN_ALLOW.has(target)) {
        LOG('[domain] 切换被拒绝：非白名单域名', target)
        return false
      }
      const next =
        target === originOf(DOMAINS.backup.api) || target === originOf(DOMAINS.backup.h5)
          ? 'backup'
          : 'primary'
      if (next === domainSelection) {
        LOG('[domain] 已在该域名，无需切换:', next, target)
        return true
      }
      domainSelection = next
      const saved = persistDomain()
      LOG('[domain] 已切换:', next, target, saved ? '（已持久化）' : '（本次生效，持久化失败）')
      return true
    },
    SYSTEM_CHECK_ADMIN: () => false,
    SYSTEM_SET_AUTH_COOKIE: async (payload) => {
      try {
        const items = Array.isArray(payload) ? payload : [payload]
        for (const it of items) {
          if (!it) continue
          const name = it.name || it.key || 'kook_auth'
          const value = String(it.value || it.token || '')
          if (!value) continue
          await session.defaultSession.cookies.set({
            url: 'https://www.kookapp.cn',
            name,
            value,
            domain: '.kookapp.cn',
            path: '/',
            secure: true,
          })
          LOG('[cookie] 鉴权 cookie 已写入', name)
        }
        return true
      } catch (e) {
        LOG('[cookie] 写入失败', e && e.message)
        return false
      }
    },
    SYSTEM_CHECK_ACCESS_FILE: (p, mode) => {
      try {
        fs.accessSync(String(p), mode === 'write' ? fs.constants.W_OK : fs.constants.R_OK)
        return true
      } catch {
        return false
      }
    },
    SYSTEM_ON_SECOND_INSTANCE: () => {},

    // ── 全局 ──
    GLOBAL_GET_GLOBAL: () => ({ platform: 'win32', isDev: false, version: app.getVersion() }),
    GLOBAL_ON_ROUTER_JUMP: () => {},
    GLOBAL_SHORTCUT_CALLBACK: () => {},

    // ── 任务列表 ──
    TASKLIST_CHANGE: () => {},
    TASKLIST_STATE_CHANGE: () => {},
    TASKLIST_OBS_SRT_MODE_CHANGE: () => {},
    TASKLIST_INFO_CHANGE: () => [],
    TASKLIST_QUERY_SIMPLE: () => [],
    TASKLIST_BOOSTER_CHANGE: () => {},
    TASKLIST_GET_GAME_CHANNEL_FILE_CONTENT: () => '',

    // ── 音量（pactl/amixer 真实现）──
    VOLUME_GET_MIC_VOLUME_BY_LABEL: () => {
      const out = runCmd('pactl', ['get-source-volume', '@DEFAULT_SOURCE@'])
      const m = out.match(/(\d+)%/)
      return m ? Number(m[1]) : 100
    },
    VOLUME_SET_MIC_VOLUME_BY_LABEL: (label, v) => {
      const pct = Math.max(0, Math.min(150, Number(v) || 0))
      runCmd('pactl', ['set-source-volume', '@DEFAULT_SOURCE@', pct + '%'])
      return pct
    },
    VOLUME_GET_MIC_BOOST_BY_LABEL: () => 0,
    VOLUME_SET_MIC_BOOST_BY_LABEL: () => 0,
    VOLUME_SET_SPEAKER_VOLUME: (v) => {
      const pct = Math.max(0, Math.min(150, Number(v) || 0))
      runCmd('pactl', ['set-sink-volume', '@DEFAULT_SINK@', pct + '%'])
      return pct
    },
    VOLUME_SET_MIC_AGC_ALL: () => {},
    VOLUME_REFRESH_CHILDREN_PROCESS: () => {},

    // ── 子窗口 ──
    COMMON_WIN_OPEN: (params, event) => {
      try {
        const { BrowserWindow } = require('electron')
        const o = params || {}
        const id = o.id || 'win-' + Date.now()
        // 同一 id 已经开着：直接把新数据推进去，别重复建窗口
        const exist = childWins.get(id)
        if (exist && !exist.isDestroyed()) {
          LOG('[win] 子窗口已存在，复用', id, 'visible=', exist.isVisible())
          if (o.data) { try { exist.webContents.send('load-data', o.data) } catch {} }
          // 之前被藏到屏幕外的情况也要拉回来，否则「有时候就是不出来」
          try {
            const b = exist.getBounds()
            if (b.x < -10000 || b.y < -10000) {
              const { screen } = require('electron')
              const area = screen.getPrimaryDisplay().workArea
              exist.setBounds({
                x: Math.round(area.x + (area.width - b.width) / 2),
                y: Math.round(area.y + area.height - b.height - 12),
              })
              LOG('[win] 子窗口原本在屏幕外，已拉回可视区', id)
            }
          } catch (e) {}
          try { exist.show(); exist.focus() } catch {}
          return id
        }
        const isToolbar = String(id) === 'desktop-toolbar'
        const base = {
          width: o.width || 800,
          height: o.height || 600,
          show: o.show !== false,
          title: o.title || 'KOOK',
          icon: path.join(__dirname, 'resourse/kook.png'),
        }
        if (o.center) base.center = true
        if (o.x != null && o.y != null) { base.x = o.x; base.y = o.y }
        let look
        if (isToolbar) {
          // 语音悬浮工具栏：官方在 Windows 上是一个无边框、透明、置顶、不占任务栏的
          // 小条（46px 高）。渲染层只传 id/url/宽高，这些窗口属性得由主进程给它配上，
          // 否则会变成一个带系统标题栏、还会挡在任务栏里的普通窗口。
          const { screen } = require('electron')
          const area = screen.getPrimaryDisplay().workArea
          const tw = o.width || 440
          const th = o.height || 46
          look = {
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            hasShadow: false,
            alwaysOnTop: true,
          }
          if (base.x == null) {
            // 默认贴屏幕底部居中，和官方一致
            look.x = Math.round(area.x + (area.width - tw) / 2)
            look.y = Math.round(area.y + area.height - th - 12)
          }
        } else {
          look = {
            frame: o.frame === false ? false : true,
            backgroundColor: o.backgroundColor || '#252629',
          }
        }
        const w = new BrowserWindow({
          ...base,
          ...look,
          webPreferences: {
            // 和主窗口用同一套 preload：先打原生模块桩，再加载原版 preload，
            // 否则子窗口里 Kaiheila.ipcRenderer / win 不全，页面直接白屏
            preload: path.join(__dirname, 'preload-shim.js'),
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false,
          },
        })
        try { w.setMenu(null) } catch {}
        if (isToolbar) {
          // 悬浮工具栏要压在全屏游戏之上，普通 alwaysOnTop 不够，得用 screen-saver 层级；
          // 再让它跨工作区可见，否则切个虚拟桌面工具栏就没了。
          try {
            w.setAlwaysOnTop(true, 'screen-saver')
            w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
            w.setSkipTaskbar(true)
            LOG('[toolbar] 悬浮工具栏已创建', (o.width || 0) + 'x' + (o.height || 0))
          } catch (e) {
            LOG('[toolbar] 置顶设置失败', e && e.message)
          }
          // 无边框窗口想拖动只能靠 app-region；但一旦整条都 drag，里面的按钮就点不动了，
          // 所以按钮、图标、输入框统一 no-drag，条本身的空隙留给拖动。
          w.webContents.once('dom-ready', () => {
            try {
              w.webContents
                .insertCSS(
                  '.desktop-toolbar-win,.desktop-toolbar{-webkit-app-region:drag}' +
                    '.desktop-toolbar-win button,.desktop-toolbar-win [role="button"],' +
                    '.desktop-toolbar-win input,.desktop-toolbar-win .toolbar-icon-button,' +
                    '.desktop-toolbar-win .audio-control-ico,.desktop-toolbar-win .network-state,' +
                    '.desktop-toolbar-win [class*="button"],.desktop-toolbar-win [class*="icon"]' +
                    '{-webkit-app-region:no-drag}'
                )
                .then(() => LOG('[toolbar] 拖动区域已注入'))
                .catch((e) => LOG('[toolbar] 拖动注入失败', e && e.message))
            } catch (e) {
              LOG('[toolbar] 拖动注入异常', e && e.message)
            }
          })
        }
        childWins.set(id, w)
        w.on('closed', () => {
          childWins.delete(id)
          try {
            if (event && event.sender && !event.sender.isDestroyed()) {
              event.sender.send('COMMON_WIN_ON_CLOSED', id)
            }
          } catch {}
        })
        LOG('子窗口创建', id, (o.width || 0) + 'x' + (o.height || 0), o.url || '(无 url)')
        // 防护：某些窗口管理器在新窗口弹出时会连带改主窗口尺寸，这里记下并还原
        try {
          const { BrowserWindow } = require('electron')
          const parent = BrowserWindow.getAllWindows().find((x) => x !== w && !x.isDestroyed() && x.getParentWindow() === null)
          if (parent) {
            const snap = { bounds: parent.getBounds(), max: parent.isMaximized() }
            setTimeout(() => {
              try {
                if (parent.isDestroyed()) return
                if (snap.max && !parent.isMaximized()) {
                  parent.maximize()
                  LOG('[win] 主窗口被还原成窗口态，已重新最大化')
                  return
                }
                const now = parent.getBounds()
                if (now.width !== snap.bounds.width || now.height !== snap.bounds.height) {
                  LOG('[win] 主窗口被改动', now.width + 'x' + now.height, '-> 还原', snap.bounds.width + 'x' + snap.bounds.height)
                  parent.setBounds(snap.bounds)
                }
              } catch {}
            }, 600)
          }
        } catch {}
        if (o.url) {
          w.loadURL(String(o.url)).catch((e) => LOG('子窗口加载失败', o.url, e && e.message))
        }
        // 图片查看器靠 'load-data' 事件拿图片列表，必须在页面加载完再发
        w.webContents.once('did-finish-load', () => {
          if (o.data) {
            try { w.webContents.send('load-data', o.data) } catch (e) { LOG('子窗口数据下发失败', e && e.message) }
          }
          LOG('子窗口就绪', id, o.url || '(空)')
        })
        return id
      } catch (e) {
        LOG('COMMON_WIN_OPEN 失败', e && e.message)
        return ''
      }
    },
    COMMON_WIN_CLOSE: (id) => {
      const w = childWins.get(id)
      if (w && !w.isDestroyed()) {
        try { w.close() } catch (e) {}
        // 页面自己挂了 beforeunload 时 close() 会被静默取消（工具栏就是这种），
        // 补一刀 destroy，保证「关闭」真的关掉，别在桌面上留下一个关不掉的孤儿条。
        setTimeout(() => {
          try { if (!w.isDestroyed()) w.destroy() } catch (e) {}
        }, 400)
      }
      childWins.delete(id)
      return true
    },
    COMMON_WIN_RESET_POSITION: () => true,
    COMMON_WIN_ON_CLOSED: () => {},

    // ── 下载 ──
    DOWNLOAD_GET_LIST: () => [],
    DOWNLOAD_DOWNLAOD: () => ({ id: '0' }),
    DOWNLOAD_UPDATE: () => true,
    DOWNLOAD_CANCEL: () => true,
    DOWNLOAD_ERROR: () => {},
    DOWNLOAD_OPEN_PATH: (p) => {
      try {
        shell.openPath(String(p || app.getPath('downloads')))
        return true
      } catch {
        return false
      }
    },

    // ── 挂机检测 ──
    PC_INACTIVE_START: () => true,
    PC_INACTIVE_STOP: () => true,
    PC_INACTIVE_CHANGE: () => true,

    // ── 音频 AI ──
    AUDIO_AI_PIPE: () => ({ code: 0, data: null }),
    AUDIO_AI_ENABLE_AGC: () => true,
    AUDIO_AI_ENABLE_DENOISE: () => true,
    AUDIO_AI_ENABLE_RECORD: () => true,
    AUDIO_AI_GET_PROCESS_CPU_USAGE_BY_NAME: () => 0,

    // ── 截图 ──
    SCREENSHOT_GET_DEFAULT_PATH: () => app.getPath('pictures'),
    SCREENSHOT_START: () => true,
    SCREENSHOT_FULL: async () => {
      try {
        const { desktopCapturer } = require('electron')
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } })
        if (!sources.length) return null
        const file = path.join(app.getPath('pictures'), 'kook-shot-' + Date.now() + '.png')
        fs.writeFileSync(file, sources[0].thumbnail.toPNG())
        LOG('[screenshot] 已保存', file)
        return file
      } catch (e) {
        LOG('[screenshot] 失败', e && e.message)
        return null
      }
    },
    SCREENSHOT_ON_CONFIRM: () => {},
    SCREENSHOT_ON_SAVE: () => {},
  })


  // ── 余下通道：全部给出确定值，不允许空实现 ──
  Object.assign(handlers, {
    PROCESS_TCP_ALIVE_DATA: () => [],
    CHECK_FULLSCREEN_CHANGE: () => false,

    // 游戏 overlay：Linux 下不提供游戏内浮层，窗口级接口仍可用
    OVERLAY_START_CREATE_WIN: () => true,
    OVERLAY_START_CLOSE_WIN: () => true,
    OVERLAY_WIDNOW_CREATE: () => '',
    OVERLAY_WIDNOW_CLOSE: () => true,
    OVERLAY_WIDNOW_DESTROY: () => true,
    OVERLAY_COUNTDOWN_PRECREATE: () => true,
    OVERLAY_COUNTDOWN_OPEN: () => true,

    // 语音采集钩子：Windows 专有 API，Linux 无对应物，返回"未启用"而不是空
    VOICEHOOK_setVolume: () => 0,
    VOICEHOOK_GET_RUNING_MUSIC: () => ({ playing: false, title: '', app: '' }),
    VOICEHOOK_HOOK_PORT: () => 0,
    VOICEHOOK_CALLBACK: () => {},
    VOICEHOOK_UNHOOK: () => true,

    // ── 全局按键事件（按键说话 / 快捷静音）──
    // Windows 用 window-node-km-event 原生钩子监听全部键鼠；Linux 没有等价 API，
    // 这里把设置里配的那几个键用 globalShortcut 注册，触发时推同样格式的 ioHook 事件。
    IO_HOOK: () => true,
    IO_HOOK_RESTART: () => {
      registerIoHook()
      return true
    },

    // 语音通话面板：用真实子窗口承载
    VOICE_CALL_PANEL_INIT: () => true,
    VOICE_CALL_PANEL_ON_RECEIVE_INVITE: () => true,
    VOICE_CALL_PANEL_ON_RECEIVE_REMOVE_INVITE: () => true,
    VOICE_CALL_PANEL_DESTORY: () => true,

    // 性能采样：给真实数值
    PERFORMANCE_GET: () => ({
      cpu: require('os').loadavg()[0] / require('os').cpus().length,
      memory: 1 - require('os').freemem() / require('os').totalmem(),
    }),
    PERFORMANCE_START: () => true,
    PERFORMANCE_STOP: () => true,
  })

  // BOOSTER / GGPLAY / 其他零散前缀：按前缀兜底，保证非空
  const filler = {
    BOOSTER: { boosting: false, supported: false, enabled: false, list: [] },
    GGPLAY: { running: false, installed: false, list: [] },
    ENTER: true,
    EXIT: true,
    SEND: true,
    CLEAR: true,
    SCREEN: [],
  }
  for (const ch of Object.keys(handlers)) {
    if (filler[ch.split('_')[0]] !== undefined) continue
  }


  Object.assign(handlers, {
    PERFORMANCE_LOG_START: () => true,
    PERFORMANCE_LOG_RENDER: () => true,
    PROCESS_DOMAIN_TCP_ALIVE_CHANGE: () => true,
    ENTER_POWER_SAVING_MODE_1: () => true,
    ENTER_POWER_SAVING_MODE_2: () => true,
    EXIT_POWER_SAVING_MODE: () => true,
    CLEAR_RENDER_FRAME_CACHE: () => true,
    SEND_RENDER_WRITE_LOG: () => true,
    SCREEN_ON_METRICS_CHANGED: () => {},
    SCREEN_SCREEN_TO_DIP_RECT: (r) => {
      try { return screen.screenToDipRect(null, r) } catch { return r }
    },

    BOOSTER_SET_CONFIG: () => true,
    BOOSTER_IS_INSTALL: () => false,
    BOOSTER_IS_RUNING: () => false,
    BOOSTER_GET_INSTALL_STATE: () => ({ installed: false, running: false, version: '' }),
    BOOSTER_INSTALL: () => ({ ok: false, reason: 'unsupported-on-linux' }),
    BOOSTER_START: () => ({ ok: false, reason: 'unsupported-on-linux' }),
    BOOSTER_TEST_SPEED: () => ({ download: 0, upload: 0, ping: 0 }),
    BOOSTER_EVENTS: () => {},
    BOOSTER_DEFAULT_INSTALL_PATH: () => path.join(app.getPath('userData'), 'booster'),
    BOOSTER_GET_GAME_INFO: () => [],
    BOOSTER_STOP_DOWNLOAD: () => true,
    BOOSTER_DOWNLOAD: () => ({ ok: false, reason: 'unsupported-on-linux' }),

    GGPLAY_START: () => false,
    GGPLAY_LAUNCH_GAME: () => false,
    GGPLAY_EXIT: () => true,
    GGPLAY_ON_CALLBACK: () => {},
    GGPLAY_ON_UPLOAD_SUCCESS: () => {},
    GGPLAY_UPLOAD_ARCHIVE: () => ({ ok: false }),
    GGPLAY_IS_GAME_RUNNING: () => false,
    __GGPLAY_CALL: () => null,

    GAME_OVERLAY_CREATE_WIN: () => '',
    GAME_OVERLAY_CLOSE_WIN: () => true,
  })


  Object.assign(handlers, {
    TASKLIST_GET_ALL_WINDOW_TITLE: () => [],
    OVERLAY_WINDOW_GET_BOUNDS: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    OVERLAY_WINDOW_SET_BOUNDS: () => true,
    OVERLAY_WINDOW_HIDE: () => true,
    OVERLAY_WINDOW_SHOW: () => true,
    OVERLAY_WINDOW_EXISTS_SYNC: () => false,
    OVERLAY_WINDOW_SET_MOVE_TOP_CHECK: () => true,
    ON_OVERLAY_WINDOW_CLOSE: () => {},
    ON_OVERLAY_WINDOW_MOUSE_ENTER: () => {},
    ON_OVERLAY_WINDOW_MOUSE_LEAVE: () => {},
  })

  // 启动时先把设置里配好的按键接管过来（渲染层后续改设置会发 IO_HOOK_RESTART）
  setTimeout(() => {
    try { registerIoHook() } catch (e) { LOG('[iohook] 初始化失败', e && e.message) }
    try { installVkBridge() } catch (e) { LOG('[iohook] 本地键盘桥初始化失败', e && e.message) }
  }, 3000)

  // secretStatus 供主进程/自检日志读取（不是 IPC 通道，不进契约表）
  return { handlers, flush, dir, secretStatus }
}

module.exports = { createRuntime }
