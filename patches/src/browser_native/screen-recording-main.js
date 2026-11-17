// Linux 移植版：屏幕分享录制管理的主进程实现。
// 全部落到真实文件系统与真实 ffmpeg，不返回任何占位数据。
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron')
const { ScreenRecordingChannels: C } = require('./screen-recording-contract')

const STATE_FILE = () => path.join(app.getPath('userData'), 'screen-recording.json')

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) || {}
  } catch {
    return {}
  }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true })
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2))
  } catch {}
}

function cacheRoot() {
  const st = readState()
  if (st.cacheDir && fs.existsSync(path.dirname(st.cacheDir))) return st.cacheDir
  return path.join(app.getPath('videos'), 'KOOK 屏幕分享录制')
}
function exportRoot() {
  const st = readState()
  if (st.exportDir && fs.existsSync(path.dirname(st.exportDir))) return st.exportDir
  return path.join(app.getPath('videos'), 'KOOK 屏幕分享导出')
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

function ok(data) {
  return { ok: true, data }
}
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function diskInfo(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const s = fs.statfsSync(dir)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    return { totalBytes: total, freeBytes: free, usedBytes: total - free }
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0 }
  }
}

// ── 目录体积 ──
function dirSize(dir) {
  let total = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      let st
      try { st = fs.statSync(p) } catch { continue }
      total += st.isDirectory() ? dirSize(p) : st.size
    }
  } catch {}
  return total
}

// ── 素材：磁盘上每个录制目录都带一个 meta.json ──
function readMaterial(dir) {
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
  const files = []
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.isFile()) files.push({ name: n, path: p, size: st.size, mtimeMs: st.mtimeMs })
    }
  } catch {}
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  const video = files.find((f) => /\.(webm|mkv|mp4|ts)$/i.test(f.name))
  return {
    recordingId: meta.recordingId || path.basename(dir),
    name: meta.name || meta.fileName || path.basename(dir),
    serverName: meta.serverName || '',
    channelName: meta.channelName || '',
    durationMs: Number(meta.durationMs) || 0,
    timelineDurationMs: Number(meta.timelineDurationMs) || Number(meta.durationMs) || 0,
    totalBytes,
    sizeBytes: totalBytes,
    startedAt: meta.startedAt || new Date(fs.statSync(dir).mtimeMs).toISOString(),
    status: video ? 'completed' : 'running',
    materialStatus: video ? 'completed' : 'running',
    available: true,
    fileName: video ? video.name : undefined,
    path: dir,
  }
}

function listMaterials() {
  const root = cacheRoot()
  ensureDir(root)
  const items = []
  const unavailableRoots = []
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name)
      let st
      try { st = fs.statSync(dir) } catch { continue }
      if (!st.isDirectory()) continue
      const m = readMaterial(dir)
      if (m) items.push(m)
    }
  } catch {
    unavailableRoots.push({ path: root, reason: 'unreadable' })
  }
  items.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  return { items, unavailableRoots, root }
}

function listExports() {
  const root = exportRoot()
  ensureDir(root)
  const items = []
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/\.mp4$/i.test(name)) continue
      const p = path.join(root, name)
      let st
      try { st = fs.statSync(p) } catch { continue }
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(p.replace(/\.mp4$/i, '.json'), 'utf8')) } catch {}
      items.push({
        exportId: meta.exportId || name.replace(/\.mp4$/i, ''),
        recordingId: meta.recordingId || '',
        fileName: name,
        status: 'completed',
        availability: 'available',
        durationMs: Number(meta.durationMs) || 0,
        sizeBytes: st.size,
        sourceStartedAt: meta.sourceStartedAt || new Date(st.mtimeMs).toISOString(),
        path: p,
      })
    }
  } catch {}
  items.sort((a, b) => String(b.sourceStartedAt).localeCompare(String(a.sourceStartedAt)))
  return items
}

// ── ffmpeg 真实探测 ──
let ffmpegCache = null
function probeFfmpeg() {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; ffmpegCache = r; resolve(r) } }
    let child
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return finish({ status: 'failed', error: { code: 'FFMPEG_NOT_FOUND', message: '未找到 ffmpeg' } })
    }
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => finish({ status: 'failed', error: { code: 'FFMPEG_NOT_FOUND', message: '未找到 ffmpeg 可执行文件' } }))
    child.on('close', (code) => {
      if (code !== 0) return finish({ status: 'failed', error: { code: 'FFMPEG_BROKEN', message: 'ffmpeg 无法运行' } })
      const first = out.split('\n')[0] || ''
      const m = /version\s+(\S+)/.exec(out)
      finish({ status: 'ready', version: (m && m[1]) || first, source: 'system', path: 'ffmpeg', progress: 1 })
    })
    setTimeout(() => { try { child.kill('SIGKILL') } catch {}; finish({ status: 'failed', error: { code: 'FFMPEG_TIMEOUT', message: 'ffmpeg 探测超时' } }) }, 4000)
  })
}

// ── 导出进度 ──
let exportProgress = { status: 'idle' }
let exportSeq = 0
function emitToAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload) } catch {}
  }
}

function probeDurationMs(file) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
    } catch { return resolve(0) }
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve(0))
    child.on('close', () => {
      const sec = parseFloat(out.trim())
      resolve(Number.isFinite(sec) ? Math.round(sec * 1000) : 0)
    })
    setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve(0) }, 5000)
  })
}

async function materialVideoFile(recordingId) {
  const { items } = listMaterials()
  const m = items.find((i) => String(i.recordingId) === String(recordingId))
  if (!m) throw Object.assign(new Error('找不到该录制素材'), { code: 'RECORDING_NOT_FOUND' })
  const files = fs.readdirSync(m.path).filter((n) => /\.(webm|mkv|mp4|ts)$/i.test(n)).sort()
  if (!files.length) throw Object.assign(new Error('该素材尚未产生可导出的视频'), { code: 'RECORDING_NO_SEGMENT' })
  return { material: m, files: files.map((n) => path.join(m.path, n)) }
}

function buildPlan(recordingId) {
  const { items } = listMaterials()
  const m = items.find((i) => String(i.recordingId) === String(recordingId))
  if (!m) throw Object.assign(new Error('找不到该录制素材'), { code: 'RECORDING_NOT_FOUND' })
  const outDir = ensureDir(exportRoot())
  const safe = String(m.name || m.recordingId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return {
    recordingId: m.recordingId,
    outputPath: path.join(outDir, safe + '.mp4'),
    durationMs: m.durationMs,
    totalBytes: m.totalBytes,
    segmentCount: fs.readdirSync(m.path).filter((n) => /\.(webm|mkv|mp4|ts)$/i.test(n)).length,
  }
}

async function startExport(opts) {
  const recordingId = opts && opts.recordingId
  const plan = buildPlan(recordingId)
  const { material, files } = await materialVideoFile(recordingId)
  const exportId = `exp_${Date.now()}_${++exportSeq}`
  ensureDir(path.dirname(plan.outputPath))

  const listFile = path.join(material.path, '.concat.txt')
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))

  exportProgress = { status: 'running', exportId, recordingId, progress: 0, phase: 'exporting' }
  emitToAll(C.EXPORT_PROGRESS, exportProgress)

  const child = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', plan.outputPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += String(d)
    if (stderr.length > 4000) stderr = stderr.slice(-2000)
    const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(stderr)
    if (m) {
      const done = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
      const total = (material.durationMs || 0) / 1000
      const progress = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 50
      exportProgress = { ...exportProgress, progress }
      emitToAll(C.EXPORT_PROGRESS, exportProgress)
    }
  })

  const result = await new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: 1, err: e }))
    child.on('close', (code) => resolve({ code }))
  })

  if (result.code !== 0) {
    exportProgress = { status: 'failed', exportId, recordingId, progress: 0, error: { code: 'RECORDING_EXPORT_FAILED', message: stderr.split('\n').filter(Boolean).slice(-1)[0] || '导出失败' } }
    emitToAll(C.EXPORT_PROGRESS, exportProgress)
    return fail('RECORDING_EXPORT_FAILED', exportProgress.error.message)
  }

  const durationMs = await probeDurationMs(plan.outputPath)
  const st = fs.statSync(plan.outputPath)
  fs.writeFileSync(plan.outputPath.replace(/\.mp4$/i, '.json'), JSON.stringify({
    exportId, recordingId, durationMs, sourceStartedAt: material.startedAt, sizeBytes: st.size,
  }))
  try { fs.unlinkSync(listFile) } catch {}
  exportProgress = { status: 'completed', exportId, recordingId, progress: 100, outputPath: plan.outputPath }
  emitToAll(C.EXPORT_PROGRESS, exportProgress)
  emitToAll(C.EXPORT_CHANGED, listExports())
  return ok({ exportId, outputPath: plan.outputPath, durationMs, sizeBytes: st.size })
}

// ── 素材写入（录制时用） ──
function materialDir(recordingId) {
  return path.join(cacheRoot(), String(recordingId))
}

function registerScreenRecording() {
  const reg = (channel, fn) => {
    try { ipcMain.removeHandler(channel) } catch {}
    ipcMain.handle(channel, async (event, opts) => {
      try {
        return await fn(opts, event)
      } catch (e) {
        return fail(e && e.code ? e.code : 'RECORDING_IPC_FAILED', (e && e.message) || '录制请求失败')
      }
    })
  }

  reg(C.CACHE_GET, () => {
    const root = ensureDir(cacheRoot())
    const d = diskInfo(root)
    return ok({ path: root, ...d, usedBytes: dirSize(root) })
  })

  reg(C.CACHE_SELECT_DIRECTORY, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择屏幕分享录制缓存位置' })
    if (r.canceled || !r.filePaths[0]) return ok({ canceled: true })
    const st = readState()
    st.cacheDir = r.filePaths[0]
    writeState(st)
    ensureDir(st.cacheDir)
    const info = { path: st.cacheDir, ...diskInfo(st.cacheDir) }
    emitToAll(C.CACHE_CHANGED, info)
    return ok(info)
  })

  reg(C.MATERIAL_LIST, () => ok(listMaterials()))
  reg(C.MATERIAL_REMOVE, (o) => {
    const id = o && (o.recordingId || o.id)
    const dir = materialDir(id)
    if (!fs.existsSync(dir)) return fail('RECORDING_NOT_FOUND', '找不到该录制素材')
    fs.rmSync(dir, { recursive: true, force: true })
    emitToAll(C.MATERIAL_CHANGED, listMaterials())
    return ok({ recordingId: id, removed: true })
  })
  reg(C.MATERIAL_REVEAL, (o) => {
    const id = o && (o.recordingId || o.id)
    const dir = materialDir(id)
    if (fs.existsSync(dir)) shell.showItemInFolder(dir)
    return ok(true)
  })

  reg(C.SEGMENT_PREPARE, (o) => {
    const id = (o && o.recordingId) || `rec_${Date.now()}`
    const dir = ensureDir(materialDir(id))
    const metaPath = path.join(dir, 'meta.json')
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch {}
    meta = { ...meta, ...(o || {}), recordingId: id, startedAt: meta.startedAt || new Date().toISOString() }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    emitToAll(C.MATERIAL_CHANGED, listMaterials())
    return ok({ recordingId: id, path: dir })
  })
  reg(C.SEGMENT_FINALIZE, (o) => ok({ recordingId: o && o.recordingId, finalized: true }))
  reg(C.MATERIAL_COMPLETE, (o) => {
    const id = o && o.recordingId
    const dir = materialDir(id)
    if (fs.existsSync(dir)) {
      const metaPath = path.join(dir, 'meta.json')
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch {}
      meta = { ...meta, ...(o || {}), completedAt: new Date().toISOString() }
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    }
    emitToAll(C.MATERIAL_CHANGED, listMaterials())
    return ok({ recordingId: id })
  })
  reg(C.MATERIAL_ABORT, (o) => {
    const id = o && o.recordingId
    const dir = materialDir(id)
    if (dir && fs.existsSync(dir) && fs.readdirSync(dir).filter((n) => /\.(webm|mkv|mp4|ts)$/i.test(n)).length === 0) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    emitToAll(C.MATERIAL_CHANGED, listMaterials())
    return ok({ recordingId: id, aborted: true })
  })

  reg(C.EXPORT_PLAN, (o) => {
    const plan = buildPlan(o && o.recordingId)
    return ok(plan)
  })
  reg(C.EXPORT_START, (o) => startExport(o))
  reg(C.EXPORT_PROGRESS_GET, () => ok(exportProgress))
  reg(C.EXPORT_LIST, () => ok(listExports()))
  reg(C.EXPORT_REMOVE, (o) => {
    const file = path.join(exportRoot(), String((o && o.fileName) || ''))
    const id = o && o.exportId
    const target = fs.existsSync(file) ? file : path.join(exportRoot(), String(id) + '.mp4')
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target)
        try { fs.unlinkSync(target.replace(/\.mp4$/i, '.json')) } catch {}
      }
    } catch (e) {
      return fail('RECORDING_EXPORT_REMOVE_FAILED', e.message)
    }
    emitToAll(C.EXPORT_CHANGED, listExports())
    return ok({ removed: true })
  })
  reg(C.EXPORT_REVEAL, (o) => {
    const id = o && o.exportId
    const p = path.join(exportRoot(), String((o && o.fileName) || id + '.mp4'))
    if (fs.existsSync(p)) shell.showItemInFolder(p)
    else if (fs.existsSync(exportRoot())) shell.openPath(exportRoot())
    return ok(true)
  })

  reg(C.FFMPEG_STATE_GET, async () => ok(await probeFfmpeg()))
  reg(C.FFMPEG_INSTALL, async () => {
    const st = await probeFfmpeg()
    if (st.status === 'ready') return ok(st)
    // Linux 上 ffmpeg 由发行版包管理器提供，交给系统安装；这里给出真实结果而不是假装安装成功。
    return fail('FFMPEG_NOT_INSTALLED', '系统未提供 ffmpeg，请先通过发行版的包管理器安装')
  })
  reg(C.FFMPEG_INSTALL_CANCEL, () => ok({ status: 'cancelled' }))

  reg(C.LIFECYCLE_RELOAD, () => {
    setTimeout(() => { try { const w = BrowserWindow.getAllWindows()[0]; if (w) w.reload() } catch {} }, 0)
    return ok(true)
  })

  ipcMain.on(C.LIFECYCLE_STOP_COMPLETED, () => {})
  ipcMain.on(C.LIFECYCLE_HANDLER_CHANGED, () => {})

  probeFfmpeg().then((st) => emitToAll(C.FFMPEG_STATE_CHANGED, st)).catch(() => {})
}

module.exports = { registerScreenRecording, cacheRoot, exportRoot }
