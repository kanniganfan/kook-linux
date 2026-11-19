#!/usr/bin/env node
/**
 * 上游兼容性检测（对应代码审查 P2-7）
 *
 * 用途：官方客户端每次升级后，判断哪些移植层需要跟着改。
 *
 *   node scripts/check-upstream.mjs --app ~/kook-port/linux/app
 *   node scripts/check-upstream.mjs --app <官方安装目录>/resources/app --json
 *   node scripts/check-upstream.mjs --app ~/kook-port/linux/app --write-baseline
 *
 * 检查五件事：
 *   1. 版本三元组（version / buildVersion / config.commitId）
 *   2. IPC 通道集合（src/browser_native/constants.js 的 IPCEventName）增删
 *   3. preload 契约文件（src/preload/**、src/browser_native/preload/**）内容变化
 *   4. 移植层引用了但新版已消失的通道（会被静默吞掉的回归点）
 *   5. webapp 资源：路径增删改名 与 内容变化 分开报；契约相关的关键文件（设备指纹
 *      拼装、域名运行时）按逻辑名单独登记，路径漂移与内容漂移分别报告
 *
 * 退出码：0 = 与基线一致；1 = 有漂移；2 = 参数/读取错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DEFAULT_BASELINE = path.join(REPO, 'patches', 'upstream-baseline.json')
const PATCH_FILES = ['patches/main.js', 'patches/handlers.js', 'patches/preload-shim.js']
const SCHEMA = 3

/**
 * 移植层自己会覆盖/修改的文件。它们与官方原始文件天然不同，
 * 不能算成「上游漂移」，否则每次跑开发目录都会一片红。
 * 反过来，如果这些文件某天变得和官方一致了，说明补丁没打上，要报警。
 */
const OWN_PATCHED = [
  'webapp/build/index.htm', // 去掉官方启动资源重试门 + 注入 force-web-runtime
  'src/preload/auto-launch.js', // XDG 自启替代注册表
]

/**
 * 契约相关的关键文件：按「逻辑名」登记，避免官方换文件名后对不上。
 *  - rel:    固定相对路径
 *  - marker: 在 webapp 的 static/js 里按内容特征定位（文件名带内容哈希，会变）
 */
const KEY_FILES = [
  { name: 'webapp-entry', rel: 'webapp/build/index.htm' },
  { name: 'preload-runtime-domain', rel: 'src/preload/runtime-domain.js' },
  { name: 'preload-system', rel: 'src/browser_native/preload/system.js' },
  { name: 'device-feature-builder', webappMarker: 'x-client-username' },
  { name: 'device-detail-consumer', webappMarker: 'is_in_vm_by_cpu_id' },
]

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

function resolveApp(input) {
  const p = path.resolve(String(input).replace(/^~(?=\/)/, process.env.HOME || '~'))
  const candidates = [p, path.join(p, 'resources/app'), path.join(p, 'app')]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src', 'browser_native', 'constants.js'))) return c
  }
  throw new Error(`不是可识别的 KOOK app 目录（找不到 src/browser_native/constants.js）: ${p}`)
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** 通道名 → 定义行，用于在 diff 里给出位置提示 */
function readChannels(app) {
  const file = path.join(app, 'src', 'browser_native', 'constants.js')
  const src = fs.readFileSync(file, 'utf8')
  const req = createRequire(path.join(app, 'src', 'noop.js'))
  const mod = req(file)
  const list = Object.keys(mod.IPCEventName || {})
  const lines = {}
  for (const name of list) {
    const m = src.match(new RegExp(`\\b${name}\\s*:`))
    if (m) lines[name] = src.slice(0, m.index).split('\n').length
  }
  return { list, lines, hash: sha(fs.readFileSync(file)) }
}

/** webapp 资源指纹：路径集合与内容分别算，便于区分「改名」和「改内容」 */
function readWebapp(app) {
  const dir = path.join(app, 'webapp', 'build')
  const all = walk(dir).map((f) => path.relative(dir, f)).sort()
  const ownSet = new Set(OWN_PATCHED.map((p) => p.replace(/^webapp\/build\//, '')))
  const upstream = all.filter((rel) => !ownSet.has(rel))
  const own = all.filter((rel) => ownSet.has(rel))
  if (!all.length) {
    return { fileCount: 0, totalBytes: 0, pathDigest: null, contentDigest: null, own: {} }
  }
  const rows = []
  let totalBytes = 0
  for (const rel of upstream) {
    const buf = fs.readFileSync(path.join(dir, rel))
    totalBytes += buf.length
    rows.push(`${rel}\u0000${buf.length}\u0000${sha(buf)}`)
  }
  const ownHashes = {}
  for (const rel of own) ownHashes[rel] = sha(fs.readFileSync(path.join(dir, rel)))
  return {
    fileCount: upstream.length,
    totalBytes,
    // 只对官方文件算指纹：移植层自身的改动不算上游漂移
    pathDigest: sha(upstream.join('\n')),
    contentDigest: sha(rows.join('\n')),
    own: ownHashes,
  }
}

/** 关键文件解析：固定路径 + webapp 内容特征匹配 */
function readKeyFiles(app) {
  const out = {}
  for (const spec of KEY_FILES) {
    const entry = { paths: [], hashes: {} }
    if (spec.rel) {
      const abs = path.join(app, spec.rel)
      if (fs.existsSync(abs)) {
        entry.paths.push(spec.rel)
        entry.hashes[spec.rel] = sha(fs.readFileSync(abs))
      }
    }
    if (spec.webappMarker) {
      const jsDir = path.join(app, 'webapp', 'build', 'static', 'js')
      const marker = Buffer.from(spec.webappMarker)
      for (const f of walk(jsDir)) {
        if (!f.endsWith('.js')) continue
        let buf
        try {
          const st = fs.statSync(f)
          if (st.size > 24 * 1024 * 1024) continue
          buf = fs.readFileSync(f)
        } catch {
          continue
        }
        if (buf.includes(marker)) {
          const rel = path.relative(app, f)
          entry.paths.push(rel)
          entry.hashes[rel] = sha(buf)
        }
      }
      entry.paths.sort()
    }
    out[spec.name] = entry
  }
  return out
}

function snapshot(app) {
  const appPkg = path.join(app, 'package.json')
  const pkg = fs.existsSync(appPkg) ? JSON.parse(fs.readFileSync(appPkg, 'utf8')) : {}
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(app, 'src', 'config.json'), 'utf8'))
  } catch {}

  let chan
  try {
    chan = readChannels(app)
  } catch (e) {
    throw new Error(`constants.js 无法解析（上游可能重构了结构）：${e.message.split('\n')[0]}`)
  }

  const contractFiles = [
    ...walk(path.join(app, 'src', 'preload')),
    ...walk(path.join(app, 'src', 'browser_native', 'preload')),
    path.join(app, 'src', 'browser_native', 'constants.js'),
  ].filter((f) => fs.existsSync(f))

  const hashes = {}
  for (const f of contractFiles) hashes[path.relative(app, f)] = sha(fs.readFileSync(f))

  return {
    schema: SCHEMA,
    app,
    version: pkg.version || null,
    buildVersion: pkg.buildVersion || null,
    commitId: cfg.commitId || null,
    channelCount: chan.list.length,
    channels: chan.list,
    channelLines: chan.lines,
    constantsHash: chan.hash,
    hashes,
    webapp: readWebapp(app),
    keyFiles: readKeyFiles(app),
    generatedAt: new Date().toISOString(),
  }
}

/** 移植层源码里出现过的通道字符串 —— 用来发现「我们引用了、新版删了」的漂移 */
function patchReferences() {
  const refs = new Set()
  for (const rel of PATCH_FILES) {
    const file = path.join(REPO, rel)
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]{5,})\b/g)) refs.add(m[1])
  }
  return refs
}

function diff(base, cur) {
  const b = new Set(base.channels || [])
  const c = new Set(cur.channels || [])
  const added = [...c].filter((x) => !b.has(x))
  const removed = [...b].filter((x) => !c.has(x))

  const ownSet = new Set(OWN_PATCHED)
  const filesChanged = []
  const filesAdded = []
  const ownApplied = []
  const ownAbsent = []
  for (const [f, h] of Object.entries(cur.hashes)) {
    if (!(f in (base.hashes || {}))) filesAdded.push(f)
    else if (base.hashes[f] !== h) (ownSet.has(f) ? ownApplied : filesChanged).push(f)
    else if (ownSet.has(f)) ownAbsent.push(f)
  }
  const filesRemoved = Object.keys(base.hashes || {})
    .filter((f) => !(f in cur.hashes) && !ownSet.has(f))

  // 移植层补丁状态：与官方一致 = 补丁没打上（本目录是官方原始目录，或构建漏了）
  for (const rel of Object.keys((base.webapp && base.webapp.own) || {})) {
    const curHash = ((cur.webapp && cur.webapp.own) || {})[rel]
    const baseHash = base.webapp.own[rel]
    if (!curHash) ownAbsent.push('webapp/build/' + rel)
    else if (curHash === baseHash) ownAbsent.push('webapp/build/' + rel)
    else ownApplied.push('webapp/build/' + rel)
  }
  const ownTotal = ownApplied.length + ownAbsent.length

  const versionChanged =
    base.version !== cur.version ||
    base.buildVersion !== cur.buildVersion ||
    base.commitId !== cur.commitId

  const refs = patchReferences()
  const brokenRefs = removed.filter((ch) => refs.has(ch))

  // webapp：路径集合变化（增删/改名）与内容变化分开
  const bw = base.webapp || null
  const cw = cur.webapp
  const webappLegacy = !bw
  const webappPathChanged = !!bw && bw.pathDigest !== cw.pathDigest
  const webappContentChanged = !!bw && !webappPathChanged && bw.contentDigest !== cw.contentDigest
  const webappAnyChange =
    !!bw &&
    (webappPathChanged ||
      webappContentChanged ||
      bw.fileCount !== cw.fileCount ||
      bw.totalBytes !== cw.totalBytes)

  // 关键文件：按逻辑名比对路径漂移与内容漂移
  const keyDrift = []
  for (const spec of KEY_FILES) {
    const bk = (base.keyFiles || {})[spec.name] || { paths: [], hashes: {} }
    const ck = cur.keyFiles[spec.name] || { paths: [], hashes: {} }
    // 移植层自改文件（如 webapp/build/index.htm）不参与上游漂移判定
    const bPaths = bk.paths.filter((p) => !ownSet.has(p))
    const cPaths = ck.paths.filter((p) => !ownSet.has(p))
    const bset = new Set(bPaths)
    const cset = new Set(cPaths)
    const pathAdded = cPaths.filter((p) => !bset.has(p))
    const pathRemoved = bPaths.filter((p) => !cset.has(p))
    const contentChanged = cPaths.filter((p) => bset.has(p) && bk.hashes[p] !== ck.hashes[p])
    const missing = ck.paths.length === 0
    if (pathAdded.length || pathRemoved.length || contentChanged.length || missing) {
      keyDrift.push({ name: spec.name, pathAdded, pathRemoved, contentChanged, missing })
    }
  }

  return {
    versionChanged,
    added,
    removed,
    filesAdded,
    filesChanged,
    filesRemoved,
    ownApplied,
    ownAbsent,
    ownTotal,
    brokenRefs,
    webappLegacy,
    webappPathChanged,
    webappContentChanged,
    webappAnyChange,
    keyDrift,
    clean:
      !versionChanged &&
      added.length === 0 &&
      removed.length === 0 &&
      filesAdded.length === 0 &&
      filesChanged.length === 0 &&
      filesRemoved.length === 0 &&
      !webappAnyChange &&
      keyDrift.length === 0,
  }
}

function report(cur, d, base) {
  const L = []
  const tag = d.clean ? '✅ 与基线一致' : '⚠️ 检测到上游漂移'
  L.push(`# 上游兼容性检测 · ${tag}`)
  L.push('')
  L.push(`- 目标目录：\`${cur.app}\``)
  L.push(
    `- 版本：${base.version} → **${cur.version}**（build ${base.buildVersion} → ${cur.buildVersion}）`
  )
  L.push(`- commitId：${base.commitId} → ${cur.commitId}`)
  L.push(`- IPC 通道：${base.channelCount} → **${cur.channelCount}**`)
  L.push(
    `- webapp：${base.webapp ? base.webapp.fileCount : '?'} → ${cur.webapp.fileCount} 个官方文件，` +
      `${(cur.webapp.totalBytes / 1048576).toFixed(1)} MB（移植层自改文件已排除：${OWN_PATCHED.length} 个）`
  )
  L.push('')
  if (d.webappLegacy) {
    L.push('> 基线是旧格式（没有 webapp 内容指纹），本次不做 webapp 比对；处理后请 `--write-baseline`。\n')
  }
  if (d.added.length) {
    L.push(`## 新增通道（${d.added.length}）— 移植层默认落到 catch-all 桩，需补实现`)
    L.push(d.added.map((x) => `- \`${x}\``).join('\n'))
    L.push('')
  }
  if (d.removed.length) {
    L.push(`## 移除通道（${d.removed.length}）`)
    L.push(d.removed.map((x) => `- \`${x}\``).join('\n'))
    L.push('')
  }
  if (d.brokenRefs.length) {
    L.push(`## 🔴 移植层仍在引用的已删除通道（${d.brokenRefs.length}）— 必须处理`)
    L.push(d.brokenRefs.map((x) => `- \`${x}\`（见 ${PATCH_FILES.join(' / ')}）`).join('\n'))
    L.push('')
  }
  if (d.filesChanged.length || d.filesAdded.length || d.filesRemoved.length) {
    L.push('## preload / constants 契约文件变化')
    for (const f of d.filesChanged) L.push(`- 修改：\`${f}\``)
    for (const f of d.filesAdded) L.push(`- 新增：\`${f}\``)
    for (const f of d.filesRemoved) L.push(`- 删除：\`${f}\``)
    L.push('')
  }
  if (d.webappPathChanged) {
    L.push('## webapp 文件增删 / 改名')
    L.push('路径集合变了，说明前端资源整体换代或分块重命名；`[chunk]` 名带内容哈希是正常的。')
    L.push('')
  } else if (d.webappContentChanged) {
    L.push('## 🔴 webapp 内容变化（文件名没变）')
    L.push('**这正是旧版脚本漏检的情况**：路径列表一样，内容被替换。前端的 IPC 调用形状可能一起变了，')
    L.push('请对照 `docs/IPC-CONTRACT.md` 复核受影响的通道。')
    L.push('')
  }
  if (d.keyDrift.length) {
    L.push('## 关键契约文件漂移')
    for (const k of d.keyDrift) {
      L.push(`### ${k.name}`)
      if (k.missing) L.push('- ⚠️ 新版里找不到（特征串消失或文件被删）')
      for (const p of k.pathAdded) L.push(`- 路径新增：\`${p}\``)
      for (const p of k.pathRemoved) L.push(`- 路径消失：\`${p}\``)
      for (const p of k.contentChanged) L.push(`- 内容变化：\`${p}\``)
      L.push('')
    }
  }
  if (d.ownTotal) {
    L.push('## 移植层补丁状态')
    if (d.ownAbsent.length === d.ownTotal) {
      L.push(`- 本目录是官方原始目录（${d.ownTotal} 个自改文件均与官方一致），适合用来对比上游。`)
    } else if (d.ownAbsent.length) {
      L.push(`- 🟠 部分补丁缺失（${d.ownApplied.length}/${d.ownTotal} 已打）：`)
      for (const p of d.ownAbsent) L.push(`  - \`${p}\` 与官方一致，构建可能漏了`)
    } else {
      L.push(`- 已打移植层补丁：${d.ownApplied.length}/${d.ownTotal}（这些文件与官方不同属预期）`)
    }
    L.push('')
  }
  if (d.clean) L.push('无需改动移植层。\n')
  L.push('## 建议动作')
  if (d.clean) {
    L.push('1. 跑一遍冒烟：启动客户端，检查 `[ipc:unknown]` 与 `handler error` 日志。')
  } else {
    ;[
      '1. 先看 `brokenRefs`：这些通道在新版消失，移植层再返回旧值会变成无效分支。',
      '2. `added` 里的通道逐个确认前端是否真的调用；被调用的补进 `patches/handlers.js`。',
      '3. 关键契约文件漂移优先处理（设备指纹、域名运行时），形状错了功能会静默失效。',
      '4. `preload` 变化通常意味着 IPC 入参/回参形状变了，对照 `docs/IPC-CONTRACT.md` 更新。',
      '5. 全绿后 `--write-baseline` 更新基线并提交。',
    ].forEach((s) => L.push(s))
  }
  return L.join('\n')
}

function main() {
  const appArg = arg('app')
  if (!appArg || appArg === true) {
    console.error(
      '用法：node scripts/check-upstream.mjs --app <KOOK app 目录> [--baseline 路径] [--json] [--write-baseline]'
    )
    process.exit(2)
  }
  let app
  try {
    app = resolveApp(appArg)
  } catch (e) {
    console.error(String(e.message))
    process.exit(2)
  }

  let cur
  try {
    cur = snapshot(app)
  } catch (e) {
    console.error(String(e.message))
    process.exit(2)
  }

  const baselinePath = path.resolve(String(arg('baseline', DEFAULT_BASELINE)))

  if (arg('write-baseline', false)) {
    const out = { ...cur }
    delete out.app
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, JSON.stringify(out, null, 2) + '\n')
    console.log(
      `基线已写入 ${path.relative(REPO, baselinePath)}（${cur.channelCount} 通道，` +
        `webapp ${cur.webapp.fileCount} 文件 / ${(cur.webapp.totalBytes / 1048576).toFixed(1)} MB）`
    )
    return
  }

  if (!fs.existsSync(baselinePath)) {
    console.error(`找不到基线 ${baselinePath}，先跑一次 --write-baseline`)
    process.exit(2)
  }
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  const d = diff(base, cur)

  if (arg('json', false)) {
    console.log(
      JSON.stringify(
        {
          target: cur.app,
          current: { version: cur.version, channels: cur.channelCount, webapp: cur.webapp.fileCount },
          drift: d,
        },
        null,
        2
      )
    )
  } else {
    console.log(report(cur, d, base))
  }
  process.exit(d.clean ? 0 : 1)
}

main()
