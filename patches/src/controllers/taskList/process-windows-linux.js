// Linux 版进程枚举：替代原版 Windows 的 node-process-windows 原生模块。
// 数据全部来自 /proc 与 .desktop 文件，不做任何伪造。
const fs = require('fs')
const path = require('path')
const os = require('os')

const CLK_TCK = 100 // Linux 用户态固定 100，足以换算启动时间
let btimeMs = 0
try {
  const stat = fs.readFileSync('/proc/stat', 'utf8')
  const m = /^btime\s+(\d+)/m.exec(stat)
  if (m) btimeMs = Number(m[1]) * 1000
} catch {}

// ── .desktop 索引：可执行名 → 显示名 ──
let desktopIndex = null
function buildDesktopIndex() {
  const map = new Map()
  const dirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
    // 用户目录放最后：Steam 生成的快捷方式会把 steam 这个可执行名覆盖成游戏名
    path.join(os.homedir(), '.local/share/applications'),
  ]
  for (const dir of dirs) {
    let names = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.desktop'))
    } catch {
      continue
    }
    for (const file of names) {
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, file), 'utf8')
      } catch {
        continue
      }
      const name = /^Name=(.+)$/m.exec(text)
      const exec = /^Exec=(.+)$/m.exec(text)
      const noDisplay = /^NoDisplay=true$/m.test(text)
      if (!name || !exec || noDisplay) continue
      // 跳过 steam://rungameid/… 这类把启动器伪装成应用的条目
      if (/:\/\//.test(exec[1])) continue
      const bin = exec[1].trim().split(/\s+/)[0].replace(/^["']|["']$/g, '')
      const base = path.basename(bin)
      if (base && !map.has(base)) map.set(base, name[1].trim())
    }
  }
  return map
}
function desktopName(bin) {
  if (!desktopIndex) desktopIndex = buildDesktopIndex()
  return desktopIndex.get(bin) || ''
}

// ── 是否 GUI 客户端：socket fd 的 readlink 只有 inode，
//    真实路径要从 /proc/net/unix 反查（Wayland / X11 都在这里列出）──
let guiInodes = null
let guiInodesAt = 0
function guiSocketInodes() {
  const now = Date.now()
  if (guiInodes && now - guiInodesAt < 3000) return guiInodes
  const set = new Set()
  try {
    const lines = fs.readFileSync('/proc/net/unix', 'utf8').split('\n')
    for (const line of lines) {
      if (!/wayland-\d+|\.X11-unix\/X\d/.test(line)) continue
      const cols = line.trim().split(/\s+/)
      const inode = cols[cols.length - 2]
      if (/^\d+$/.test(inode)) set.add(inode)
    }
  } catch {}
  guiInodes = set
  guiInodesAt = now
  return set
}

function isGuiProcess(pid) {
  const inodes = guiSocketInodes()
  if (!inodes.size) return false
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      let link = ''
      try {
        link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (m && inodes.has(m[1])) return true
    }
  } catch {}
  return false
}

function readCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return raw.split('\0').filter(Boolean)
  } catch {
    return []
  }
}

function readExe(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')
  } catch {
    return ''
  }
}

function readStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm 里可能有空格与括号，从最后一个 ')' 之后开始切
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(tail[19])
    if (!Number.isFinite(startTicks) || !btimeMs) return ''
    const d = new Date(btimeMs + (startTicks / CLK_TCK) * 1000)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  } catch {
    return ''
  }
}

// AppImage / .desktop 里的可执行名常带版本号、架构、日期戳（qq_3.2.35_261103_x86_64_01），
// 而 KOOK 官方游戏库是按干净名字匹配的（qq / wechat / steam），这里统一清洗。
const NAME_NOISE = new Set([
  'x86', 'x64', '64', '32', 'amd64', 'aarch64', 'arm64', 'i386', 'i686',
  'linux', 'linux64', 'gnu', 'appimage', 'portable', 'bin', 'v', 'version',
  'stable', 'beta', 'alpha', 'rc', 'release', 'setup', 'installer', 'launcher',
])
function normalizeProcessName(raw) {
  const src = String(raw || '').trim()
  if (!src) return ''
  const base = src.replace(/\.(appimage|exe|bin|sh)$/i, '')
  const tokens = base.split(/[._\-\s]+/).filter(Boolean)
  const alpha = []
  for (const t of tokens) {
    const low = t.toLowerCase()
    if (/^\d+$/.test(low)) continue          // 纯数字（版本段、日期戳）
    if (NAME_NOISE.has(low)) continue         // 架构/平台/发布状态
    if (/^\d+[a-z]*$/.test(low)) continue     // 3a 这类版本段
    alpha.push(low)
  }
  if (!alpha.length) return base.toLowerCase()
  // 多个词时取最后一段主体（google-chrome -> chrome），单个词时去掉粘连的 linux 尾巴
  let name = alpha[alpha.length - 1]
  if (!tokens.some((t) => /[._\-\s]/.test(t)) && /[a-z]linux$/.test(name)) name = name.replace(/linux$/, '')
  if (alpha.length === 1 && /^[a-z]+linux$/.test(name)) name = name.replace(/linux$/, '')
  return name || base.toLowerCase()
}

// Wine / Proton 进程的 cmdline 里带 Windows 路径的 exe，取它当 ProcessName，
// 这样 KOOK 的官方游戏库（按 xxx.exe 匹配）在 Linux 上也认得出来。
function wineExeName(argv) {
  for (const a of argv) {
    const m = /([^\\/]+\.exe)$/i.exec(a)
    if (m) return m[1]
  }
  return ''
}

const SKIP = new Set([
  'kthreadd', 'kworker', 'ksoftirqd', 'migration', 'rcu_gp', 'rcu_par_gp',
  'watchdog', 'cpuhp', 'netns', 'kauditd', 'kcompactd', 'ksmd', 'khugepaged',
  'kdevtmpfs', 'kblockd', 'kswapd', 'oom_reaper', 'jbd2', 'ext4-rsv-conver',
])

// 桌面外壳/系统组件不算“用户运行的应用”
const SHELL_SKIP = new Set([
  'gnome-shell', 'xwayland', 'magpie', 'xdg-desktop-portal', 'xdg-desktop-portal-gnome',
  'xdg-desktop-portal-gtk', 'gjs', 'gnome-session-binary', 'gnome-shell-calendar-server',
  'ibus-daemon', 'fcitx5', 'pipewire', 'wireplumber', 'pulseaudio',
])

// 官方库（/api/v2/games）里的 process_name 有的写原始名（wechatlinux_x86_64、yesplaymusic-0.4.11），
// 有的写干净名（yesplaymusic、qq），所以先拿库里的名字集合，再挑一个能对上的。
let KNOWN_NAMES = null
function setKnownProcessNames(list) {
  if (!Array.isArray(list)) return
  KNOWN_NAMES = new Set(list.map((n) => String(n).toLowerCase().replace(/\.exe$/, '')))
}
function pickName(candidates) {
  const uniq = [...new Set(candidates.filter(Boolean).map((x) => String(x).toLowerCase().replace(/\.exe$/, '')))]
  if (!uniq.length) return ''
  if (KNOWN_NAMES && KNOWN_NAMES.size) {
    const hit = uniq.find((n) => KNOWN_NAMES.has(n))
    if (hit) return hit
  }
  return uniq[0]
}

function enumerate() {
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))
  } catch {
    return []
  }
  const self = process.pid
  const out = []
  for (const pidStr of pids) {
    const pid = Number(pidStr)
    if (pid === self) continue
    const argv = readCmdline(pid)
    if (!argv.length) continue // 内核线程没有 cmdline
    const exePath = readExe(pid)
    const comm = path.basename(argv[0] || exePath || '')
    if (!comm || SKIP.has(comm) || SHELL_SKIP.has(String(comm).toLowerCase())) continue
    if (comm === 'kook' || /kook-port/.test(exePath) || /kook-port/.test(argv.join(' '))) continue

    const wine = wineExeName(argv)
    const cleanComm = comm.replace(/\.appimage$/i, '')
    // 优先用 .desktop 里的 StartupWMClass（就是发行版给这个应用的干净名字），
    // 其次清洗可执行名；Wine/Proton 用 exe 名，正好命中原生游戏库
    const dn0 = wine ? '' : desktopName(cleanComm) || desktopName(comm) || ''
    const processName = pickName([
      wine,
      cleanComm,                              // 原始名：官方库里就是按这个写的
      dn0,                                    // .desktop 的 StartupWMClass
      normalizeProcessName(cleanComm),        // 清洗后的干净名
    ])
    // GUI 判定：Wine/Proton 的 exe、有 .desktop 条目的桌面应用、或确实连着 Wayland/X11
    const dn = wine ? '' : desktopName(cleanComm) || desktopName(comm)
    const gui = !!wine || !!dn || isGuiProcess(pid)
    if (!gui) continue
    const appName = wine ? wine.replace(/\.exe$/i, '') : dn || cleanComm
    const title = appName
    out.push({
      ProcessId: pid,
      ProcessName: processName,
      Path: wine ? argv.find((a) => /\.exe$/i.test(a)) || '' : exePath,
      Product: wine ? 'Wine/Proton' : '',
      Description: title,
      StartTime: readStartTime(pid),
      // 渲染层会过滤掉 WindowTitleList 为空的项目：这里只在确认是 GUI 客户端时才填
      WindowTitleList: gui ? [title] : [],
      MainWindowTitle: gui ? title : '',
      WindowClassNameList: [],
    })
  }
  // 同名进程（Electron 多进程、Steam 多实例）合并成一条，保留最早启动的那个
  const byName = new Map()
  for (const p of out) {
    const prev = byName.get(p.ProcessName)
    if (!prev || (p.StartTime && prev.StartTime && p.StartTime < prev.StartTime)) byName.set(p.ProcessName, p)
  }
  return [...byName.values()]
}

function getAllProcessesInfos() {
  return enumerate()
}

function getAllProcessSimpleInfo() {
  return enumerate().map((p) => ({
    ProcessId: p.ProcessId,
    ProcessName: p.ProcessName,
    Path: p.Path,
    Product: p.Product,
    StartTime: p.StartTime,
  }))
}

function getAllWindowsTitlesEx(pidList) {
  const want = Array.isArray(pidList) && pidList.length ? new Set(pidList.map(Number)) : null
  return enumerate()
    .filter((p) => (want ? want.has(p.ProcessId) : true))
    .filter((p) => p.WindowTitleList.length)
    .map((p) => ({ pid: p.ProcessId, title: p.WindowTitleList[0], className: '' }))
}

// IO 计数：/proc/pid/io 是真实读写字节数
function getProcessIoCountInfo(pidList) {
  const list = Array.isArray(pidList) ? pidList : [pidList]
  return list.map((pid) => {
    try {
      const text = fs.readFileSync(`/proc/${Number(pid)}/io`, 'utf8')
      const read = Number((/^read_bytes:\s+(\d+)/m.exec(text) || [])[1] || 0)
      const write = Number((/^write_bytes:\s+(\d+)/m.exec(text) || [])[1] || 0)
      return { pid: Number(pid), success: true, read_transfer_count: read, write_transfer_count: write }
    } catch {
      return { pid: Number(pid), success: false, read_transfer_count: 0, write_transfer_count: 0 }
    }
  })
}

function getProcessDetailedInfo(pidList) {
  const list = Array.isArray(pidList) ? pidList : [pidList]
  return list.map((pid) => {
    const exe = readExe(Number(pid))
    return {
      process_id: Number(pid),
      path: exe,
      start_time: readStartTime(Number(pid)),
      desp: path.basename(exe || ''),
      product: '',
    }
  })
}

// ── 进程的套接字：按 socket inode 反查 /proc/net/{tcp,tcp6,udp,udp6} ──
function socketInodesOf(pid) {
  const set = new Set()
  let fds = []
  try {
    fds = fs.readdirSync(`/proc/${Number(pid)}/fd`)
  } catch {
    return set
  }
  for (const fd of fds) {
    let link = ''
    try {
      link = fs.readlinkSync(`/proc/${Number(pid)}/fd/${fd}`)
    } catch {
      continue
    }
    const m = /^socket:\[(\d+)\]$/.exec(link)
    if (m) set.add(m[1])
  }
  return set
}

// /proc/net/tcp 的地址是十六进制、主机字节序（每个 32 位字按小端存）
function hexToIPv4(hex) {
  const b = []
  for (let i = 6; i >= 0; i -= 2) b.push(parseInt(hex.substr(i, 2), 16))
  return b.join('.')
}
function hexToIPv6(hex) {
  const words = []
  for (let i = 0; i < 32; i += 8) {
    const w = hex.substr(i, 8)
    words.push(w.substr(6, 2) + w.substr(4, 2) + w.substr(2, 2) + w.substr(0, 2))
  }
  return words.join('').replace(/(.{4})(?!$)/g, '$1:')
}

function parseNetTable(file, v6) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  const lines = text.split('\n')
  for (let li = 1; li < lines.length; li++) {
    const c = lines[li].trim().split(/\s+/)
    if (c.length < 10) continue
    const [lp, lport] = String(c[1]).split(':')
    const [rip, rport] = String(c[2]).split(':')
    if (!/^[0-9A-Fa-f]+$/.test(lp || '') || !/^[0-9A-Fa-f]+$/.test(rip || '')) continue
    const conv = v6 ? hexToIPv6 : hexToIPv4
    rows.push({
      inode: c[9],
      state: c[3],
      local_addr_str: conv(lp),
      local_port: parseInt(lport, 16),
      remote_addr_str: conv(rip),
      remote_port: parseInt(rport, 16),
    })
  }
  return rows
}

function allSockets() {
  return [
    ...parseNetTable('/proc/net/tcp', false),
    ...parseNetTable('/proc/net/tcp6', true),
  ]
}
function allUdpSockets() {
  return [
    ...parseNetTable('/proc/net/udp', false),
    ...parseNetTable('/proc/net/udp6', true),
  ]
}

function resolveHost(host) {
  return new Promise((resolve) => {
    try {
      require('dns').lookup(host, { all: true }, (err, list) => {
        if (err || !Array.isArray(list)) return resolve([])
        resolve(list.map((x) => x.address))
      })
    } catch {
      resolve([])
    }
  })
}

// 推流存活检测：进程是否仍保持着到目标域名的 TCP 连接（ESTABLISHED）
async function checkProcessDomainTcpAliveAsync(processId, domainList) {
  const domains = (Array.isArray(domainList) ? domainList : [])
    .map((d) => String(d || '').trim())
    .filter(Boolean)
  const inodes = socketInodesOf(processId)
  const socks = inodes.size ? allSockets().filter((s) => inodes.has(s.inode)) : []
  const arr = []
  for (const domain of domains) {
    const ips = new Set(await resolveHost(domain))
    const alive =
      ips.size > 0 &&
      socks.some((s) => s.state === '01' && ips.has(s.remote_addr_str))
    arr.push({ domain, tcp_alive: alive })
  }
  return {
    arr,
    udp: getProcessNetstatUdpInfoAsync(processId),
    bandwidth: await ioBandwidth(processId),
  }
}

// OBS 的 SRT 检测用：该进程的 UDP 连接，渲染层看 local_addr_str 是否不是 127.0.0.1
function getProcessNetstatUdpInfoAsync(processId) {
  const inodes = socketInodesOf(processId)
  if (!inodes.size) return []
  return allUdpSockets()
    .filter((s) => inodes.has(s.inode))
    .map((s) => ({
      local_addr_str: s.local_addr_str,
      local_port: s.local_port,
      remote_addr_str: s.remote_addr_str,
      remote_port: s.remote_port,
    }))
}

// 带宽：/proc/pid/io 的 write_bytes 两次采样的差，换算成 bit/s
function ioReadBit(pid) {
  try {
    const text = fs.readFileSync(`/proc/${Number(pid)}/io`, 'utf8')
    return Number((/^write_bytes:\s+(\d+)/m.exec(text) || [])[1] || 0)
  } catch {
    return 0
  }
}
function ioBandwidth(pid, windowMs = 1000) {
  return new Promise((resolve) => {
    const before = ioReadBit(pid)
    setTimeout(() => {
      const after = ioReadBit(pid)
      const delta = Math.max(0, after - before)
      resolve(Math.floor((delta * 8) / (windowMs / 1000)))
    }, windowMs)
  })
}

module.exports = {
  setKnownProcessNames,
  checkProcessDomainTcpAliveAsync,
  getProcessNetstatUdpInfoAsync,
  getAllProcessesInfos,
  getAllProcessSimpleInfo,
  getAllWindowsTitlesEx,
  getProcessIoCountInfo,
  getProcessDetailedInfo,
}
