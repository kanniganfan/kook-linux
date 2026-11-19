#!/usr/bin/env node
/**
 * 注册唯一性检查（对应 IPC 契约表 §9.3）
 *
 * 背景：同一个通道在两处注册时，谁生效完全取决于注册顺序（removeHandler + handle 覆盖）。
 * 曾经因此出过两次问题——真实实现被空实现反盖（硬件加速），以及「注册了但永远是空转」。
 *
 * 规则：跨文件重复注册必须显式登记在 ALLOWED_OVERRIDES 里，并写明为什么必须覆盖。
 * 新增重复而不登记 → 退出码 1。
 *
 *   node scripts/check-registration.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 窗口 / 覆盖层这一组是有意覆盖：handlers 里是通用实现，main.js 里按真实 BrowserWindow 重写。
// 数量与归属若变化，必须回来改这张表——这正是这条检查存在的意义。
const ALLOWED_OVERRIDES = new Set([
  'OVERLAY_START_CREATE_WIN',
  'OVERLAY_START_CLOSE_WIN',
  'OVERLAY_WIDNOW_CREATE',
  'OVERLAY_WIDNOW_CLOSE',
  'OVERLAY_WIDNOW_DESTROY',
  'OVERLAY_COUNTDOWN_PRECREATE',
  'OVERLAY_COUNTDOWN_OPEN',
  'ENTER_POWER_SAVING_MODE_1',
  'ENTER_POWER_SAVING_MODE_2',
  'EXIT_POWER_SAVING_MODE',
  'GAME_OVERLAY_CREATE_WIN',
  'GAME_OVERLAY_CLOSE_WIN',
  'OVERLAY_WINDOW_GET_BOUNDS',
  'OVERLAY_WINDOW_SET_BOUNDS',
  'OVERLAY_WINDOW_HIDE',
  'OVERLAY_WINDOW_SHOW',
  'OVERLAY_WINDOW_EXISTS_SYNC',
  'OVERLAY_WINDOW_SET_MOVE_TOP_CHECK',
])

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

const handlersSrc = read('patches/handlers.js')
const mainSrc = read('patches/main.js')

// handlers.js 里 handlers 对象的键：缩进 4 空格的 NAME: (...) =>
const inHandlers = new Set(
  [...handlersSrc.matchAll(/^\s{4}([A-Z][A-Z0-9_]{2,}):\s*(?:async\s*)?\(/gm)].map((m) => m[1])
)
// main.js 里通过 handle('X') / ipcMain.handle('X') / ipcMain.on('X') 注册的
const inMain = new Set(
  [...mainSrc.matchAll(/(?:handle|ipcMain\.handle|ipcMain\.on)\(\s*'([A-Z][A-Z0-9_]{2,})'/g)].map((m) => m[1])
)

const overlap = [...inHandlers].filter((x) => inMain.has(x)).sort()
const unexpected = overlap.filter((x) => !ALLOWED_OVERRIDES.has(x))
const stale = [...ALLOWED_OVERRIDES].filter((x) => !overlap.includes(x)).sort()

console.log(`handlers.js 通道 ${inHandlers.size} 个`)
console.log(`main.js    通道 ${inMain.size} 个`)
console.log(`重复注册 ${overlap.length} 个（允许 ${ALLOWED_OVERRIDES.size} 个）`)

let bad = false
if (unexpected.length) {
  bad = true
  console.error('\n未登记的重复注册（谁生效取决于注册顺序，必须显式说明归属）：')
  for (const n of unexpected) console.error('  ' + n)
}
if (stale.length) {
  bad = true
  console.error('\n白名单里有、实际已不再重复的通道（表过期，应删掉）：')
  for (const n of stale) console.error('  ' + n)
}
if (bad) process.exit(1)
console.log('\n注册唯一性检查通过')
