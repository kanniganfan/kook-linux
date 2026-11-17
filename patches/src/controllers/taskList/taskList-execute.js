const { processWindows } = require('../../support')
const requireModule = require('../../requireModule')
// 官方日志器在这份构建里是字节码，普通 require 拿不到；缺失时降级到 console。
let appLogger
try {
  appLogger = require('../../log/logger').appLogger.label('[main]')
} catch {
  const noop = () => {}
  appLogger = { info: noop, debug: noop, warn: noop, error: noop }
}

let process_windows = {
  getAllProcessesInfos() {
    return []
  },
}
if (processWindows()) {
  process_windows = requireModule('node-process-windows').process_windows
} else {
  // Linux：原生 node-process-windows 不存在，用 /proc 适配层顶上
  process_windows = require('./process-windows-adapter')
  console.log('[tasklist] 进程枚举走 Linux /proc 实现')
}
const { getAllProcessesInfos, getAllProcessSimpleInfo } = process_windows
const ignoreProcess = [
  'svchost',
  'ApplicationFrameHost',
  'explorer',
  'kaiheila',
  'kook',
  'KOOK',
  'WindowsInternal.ComposableShell.Experiences.TextInput.InputApp',
  'Calculator',
  'ShellExperienceHost',
  'cmd',
  'SystemSettings',
]
// 性能优先 - 获取进程列表时直接筛选对应音乐进程的隐藏窗口 （webapp 中也有一份音乐进程列表应同步修改）
const MusicAppProcessList = [
  'cloudmusic',
  'qqmusic',
  'kugou',
  'xiamipc',
  'kwmusic',
  'applemusic',
  'spotify',
  'sodamusic',
]

/**
 * @typedef {Object} ProcessInfo
 * @property {number} ProcessId - 进程ID
 * @property {string} ProcessName - 进程名称
 * @property {string} Path - 进程路径
 * @property {string} Product - 产品名称
 * @property {string} Description - 进程描述
 * @property {string} StartTime - 进程启动时间
 * @property {Array<string>} WindowTitleList - 窗口标题列表
 * @property {string} MainWindowTitle - 主窗口标题
 * @property {Array<string>} WindowClassNameList - 窗口类名列表
 */

/**
 * 补充进程信息：窗口 title & 窗口 className
 * @param {ProcessInfo[]} processList
 */
function patchTitleClassname(processList, musicAppPidList) {
  /** @type {{pid: number, title: string, className: string}[]} */
  let winTitle = process_windows.getAllWindowsTitlesEx(musicAppPidList)
  /** @type {Map<number, {WindowTitleList: string[], WindowClassNameList: string[]}>} */
  let winInfoMap = new Map()
  winTitle.forEach((item) => {
    let winInfo = winInfoMap.get(item.pid)
    if (winInfo) {
      item.title && winInfo.WindowTitleList.push(item.title)
      item.className && winInfo.WindowClassNameList.push(item.className)
    } else {
      winInfoMap.set(item.pid, {
        WindowTitleList: item.title ? [item.title] : [],
        WindowClassNameList: item.className ? [item.className] : [],
      })
    }
  })
  processList.forEach((item) => {
    let winInfo = winInfoMap.get(item.ProcessId) || {
      WindowTitleList: [],
      WindowClassNameList: [],
    }
    Object.assign(item, winInfo)
    item.MainWindowTitle = item.WindowTitleList[0] || ''
  })
}

/**
 * @description 组合进程和窗口信息
 * @param
 * @returns {result} array
 * from zhaojian
 */
function getWinProcess() {
  let result = getAllProcess()
  appLogger.info('[tasklist] getWinProcess ->', result.length)
  result = result.filter((item) => {
    return !ignoreProcess.includes(item.ProcessName)
  })
  patchTitleClassname(result)
  return result
}

/**
 * @description 组合进程和窗口信息
 * @param
 * @returns {result} array
 * from zhaojian
 */
function getWinProcessSimple() {
  let result = getAllProcessSimple()
  appLogger.info('[tasklist] getWinProcessSimple ->', result.length)
  result = result.filter((item) => {
    return !ignoreProcess.includes(item.ProcessName)
  })
  const musicAppPidList = []
  for (let i = 0; i < result.length; i++) {
    let item = result[i]
    let processName = item.ProcessName.toLowerCase()
    processName = processName.endsWith('.exe')
      ? processName.slice(0, -4)
      : processName
    if (MusicAppProcessList.includes(processName)) {
      musicAppPidList.push(item.ProcessId)
    }
  }
  patchTitleClassname(result, musicAppPidList)
  return result
}

/**
 * @description 获取所有进程简要信息
 * @param
 * @returns {procInfo} array
 * from zhaojian
 */
function getAllProcessSimple() {
  const procInfoArray = getAllProcessSimpleInfo()

  let procInfo = []
  for (let i = 0; i < procInfoArray.length; i++) {
    procInfo.push({
      ProcessId: procInfoArray[i].pid,
      ProcessName: procInfoArray[i].name,
      Path: '',
      Product: '',
      Description: '',
      StartTime: '', //注意是UTC时间
    })
  }
  return procInfo
}

/**
 * @description 获取所有进程信息
 * @param
 * @returns {procInfo} array
 * from zhaojian
 */
function getAllProcess() {
  const procInfoArray = getAllProcessesInfos()

  let procInfo = []
  for (let i = 0; i < procInfoArray.length; i += 6) {
    let processname = procInfoArray[i + 1]
    procInfo.push({
      ProcessId: procInfoArray[i],
      ProcessName: processname.toLowerCase().endsWith('.exe')
        ? processname.slice(0, -4)
        : processname,
      Path: procInfoArray[i + 2],
      Product: procInfoArray[i + 3],
      Description: procInfoArray[i + 4],
      StartTime: procInfoArray[i + 5], //注意是UTC时间
    })
  }
  procInfo = procInfo.filter(
    (item) => item.Product != 'Microsoft® Windows® Operating System'
  )
  return procInfo
}

/**
 * @description 获取直播状态信息
 * @param
 * @returns
 * from zhaojian
 */
function getProcessDomainTcpAlive(processId, domainList) {
  return process_windows.checkProcessDomainTcpAliveAsync(processId, domainList)
}

/**
 * @description 获取直播状态信息
 * @param
 * @returns
 * from zhaojian
 */
function getProcessNetstatUdpInfoAsync(processId) {
  return process_windows.getProcessNetstatUdpInfoAsync(processId)
}

const BANDWIDTH_TIMEINTERVAL = 5 * 1000
function getProcessIoCountInfo(processId) {
  return new Promise((resolve) => {
    let bandwidth = 0
    try {
      let beforeInfo = process_windows.getProcessIoCountInfo(processId)
      let beforeBit = processListSumBit(beforeInfo)
      setTimeout(() => {
        try {
          let afterInfo = process_windows.getProcessIoCountInfo(processId)
          let afterBit = processListSumBit(afterInfo)
          bandwidth = Math.floor(
            (afterBit - beforeBit) / (BANDWIDTH_TIMEINTERVAL / 1000)
          )
        } catch {}
        resolve(bandwidth)
      }, BANDWIDTH_TIMEINTERVAL)
    } catch (err) {
      appLogger.debug('[ProcessBandwidth]', err)
      resolve(bandwidth)
    }
  })
}

/**
 * 进程写入总流量
 * @param {Array} arr
 * @returns {number}
 */
function processListSumBit(arr) {
  if (!Array.isArray(arr)) return 0
  return arr
    .filter((item) => item.success)
    .reduce((preValue, currentItem) => {
      return preValue + currentItem.write_transfer_count
    }, 0)
}

/**
 * @typedef {Object} ProcessDetailInfo
 * @property {number} process_id
 * @property {string} path
 * @property {string} start_time
 * @property {string} desp
 * @property {string} product
 */
/**
 *
 * @param {number[]} pidList
 * @returns {ProcessDetailInfo[]}
 */
function getProcessDetailedInfo(pidList) {
  return process_windows.getProcessDetailedInfo(pidList)
}

function getAllWindowTitle(pidList) {
  return process_windows.getAllWindowsTitlesEx(pidList)
}

module.exports = {
  getWinProcess,
  getProcessDomainTcpAlive,
  getWinProcessSimple,
  getProcessNetstatUdpInfoAsync,
  getProcessIoCountInfo,
  getProcessDetailedInfo,
  getAllWindowTitle,
}
