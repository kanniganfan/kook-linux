#!/usr/bin/env node
/**
 * 在 Gitee 上创建发行版并上传附件。
 *
 *   GITEE_TOKEN=xxxx node scripts/gitee-release.mjs --tag v0.0.14 --notes docs/releases/v0.0.14.md \
 *     --file dist-gitee/KOOK-0.0.14-x86_64.AppImage.7z.001 --file ...
 *
 * Gitee 的限制（决定了为什么要分卷）：
 *   - 单个附件 ≤ 100MB（GVP 200MB）
 *   - 仓库附件总量 ≤ 1GB
 * 所以大包先切 95MB 分卷再传。
 *
 * 退出码：0 成功；1 API 报错；2 参数错误。
 */
const API = 'https://gitee.com/api/v5'
const REPO = process.env.GITEE_REPO || 'kanniganfan/kook-linux'

const args = process.argv.slice(2)
function opt(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : null
}
function opts(name) {
  const out = []
  args.forEach((a, i) => { if (a === '--' + name) out.push(args[i + 1]) })
  return out
}

const token = process.env.GITEE_TOKEN
const tag = opt('tag')
const notesFile = opt('notes')
const files = opts('file')
const name = opt('name') || tag
const target = opt('target') || 'main'

if (!token) { console.error('缺少 GITEE_TOKEN'); process.exit(2) }
if (!tag) { console.error('缺少 --tag'); process.exit(2) }

const fs = await import('node:fs')
const body = notesFile ? fs.readFileSync(notesFile, 'utf8') : ''

async function api(path, init = {}) {
  const url = new URL(API + path)
  url.searchParams.set('access_token', token)
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  if (!res.ok) {
    console.error(`API ${path} → ${res.status}: ${text.slice(0, 300)}`)
    process.exit(1)
  }
  return json
}

// 已存在就复用，避免重复创建
let release = null
try {
  const list = await api(`/repos/${REPO}/releases?per_page=100`)
  release = (list || []).find((r) => r.tag_name === tag) || null
} catch {}

if (release) {
  console.log(`发行版 ${tag} 已存在（id=${release.id}），只补附件`)
} else {
  release = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name, body, target_commitish: target, prerelease: false }),
  })
  console.log(`已创建发行版 ${tag}（id=${release.id}）`)
  console.log(release.html_url || '')
}

for (const f of files) {
  const size = fs.statSync(f).size
  if (size > 100 * 1024 * 1024) {
    console.error(`附件 ${f} 有 ${(size / 1048576).toFixed(0)}MB，超过 Gitee 单附件 100MB 上限，先分卷`)
    process.exit(1)
  }
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(f)]), f.split('/').pop())
  const r = await api(`/repos/${REPO}/releases/${release.id}/attach_files`, { method: 'POST', body: fd })
  console.log(`已上传 ${f.split('/').pop()} (${(size / 1048576).toFixed(1)}MB)`)
}

console.log('完成')
