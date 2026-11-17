// node-process-windows 的 Linux 适配层。
// 官方客户端（明文模块和字节码两条路）都会 require('node-process-windows')，
// 而那个原生模块只有 Windows 版。这里用 /proc 实现顶上，并把返回值转成
// Windows 原版逐字段一致的形状 —— 上层 getAllProcess 是按固定位置解析扁平数组的。
const native = require('./process-windows-linux')

module.exports = {
  // 原版：pid, name, path, product, description, startTime 依次平铺
  getAllProcessesInfos() {
    const flat = []
    for (const p of native.getAllProcessesInfos()) {
      flat.push(
        p.ProcessId,
        p.ProcessName,
        p.Path || '',
        p.Product || '',
        p.Description || '',
        p.StartTime || ''
      )
    }
    return flat
  },

  // 原版：[{ pid, name }]
  getAllProcessSimpleInfo() {
    return native
      .getAllProcessSimpleInfo()
      .map((p) => ({ pid: p.ProcessId, name: p.ProcessName }))
  },

  getAllWindowsTitlesEx(pidList) {
    return native.getAllWindowsTitlesEx(pidList)
  },

  getProcessIoCountInfo(pidList) {
    return native.getProcessIoCountInfo(pidList)
  },

  getProcessDetailedInfo(pidList) {
    return native.getProcessDetailedInfo(pidList)
  },

  // 推流存活检测：该进程是否仍保持着到目标域名的 TCP 连接
  checkProcessDomainTcpAliveAsync(processId, domainList) {
    return native.checkProcessDomainTcpAliveAsync(processId, domainList)
  },

  // OBS SRT 检测：该进程的 UDP 连接
  getProcessNetstatUdpInfoAsync(processId) {
    return native.getProcessNetstatUdpInfoAsync(processId)
  },

  // 活动库进程名（官方库里写的是 wechatlinux_x86_64、yesplaymusic-0.4.11 这类原名）
  setKnownProcessNames(list) {
    return native.setKnownProcessNames(list)
  },
}
