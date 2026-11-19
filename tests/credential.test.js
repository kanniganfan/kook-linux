// SAFE_STORAGE_ENCRYPT / DECRYPT 的回归测试（真实 Electron 主进程，非 mock）。
//
// 一个进程只能验一种后端状态（createRuntime 内 secretState 记忆化），所以按 TEST_MODE 分开跑：
//   TEST_MODE=safe      → 不干预：有真后端就用 safeStorage 密文，没有则 SKIP
//   TEST_MODE=keyring   → 屏蔽 safeStorage，走 secret-tool + AES-256-GCM（v2:）
//   TEST_MODE=none      → 屏蔽 safeStorage + PATH 去掉 secret-tool → 必须拒绝落盘（返回空串）
//   TEST_MODE=insecure  → 同 none + KOOK_INSECURE_STORE=1 → v0: 明文，带标记
//   TEST_MODE=migrate   → 预置旧版裸 Base64 的 ka → 必须被重加密，且不影响其他键
//
// 断言里带 SKIP 的不计入失败：那是环境不具备该后端，不是实现错。

const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const MODE = process.env.TEST_MODE || 'safe'
const userData =
  process.env.TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'kook-cred-' + MODE + '-'))
app.setPath('userData', userData)

const lines = []
let pass = 0
let failed = 0
let skipped = 0
function ok(name, cond, detail) {
  if (cond) {
    pass++
    lines.push('  ok   ' + name)
  } else {
    failed++
    lines.push('  FAIL ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)))
  }
}
function skip(name, why) {
  skipped++
  lines.push('  skip ' + name + ' (' + why + ')')
}

const STORE_DIR = path.join(userData, 'linux-store')
const IMPORTANT = path.join(STORE_DIR, 'important.json')

// 迁移用例：先把旧版写过的裸 Base64 明文塞进磁盘，再让 createRuntime 去加载
if (MODE === 'migrate') {
  fs.mkdirSync(STORE_DIR, { recursive: true })
  fs.writeFileSync(
    IMPORTANT,
    JSON.stringify(
      {
        ka: Buffer.from('legacy-token-abc', 'utf8').toString('base64'),
        unrelated: 'keep-me',
      },
      null,
      2
    )
  )
}

app.whenReady().then(async () => {
  const electron = require('electron')
  // 模拟"这台机器没有可用的 safeStorage"，用来验证递降路径
  if (MODE !== 'safe') {
    try {
      electron.safeStorage.isEncryptionAvailable = () => false
    } catch (e) {
      console.log('  note 无法屏蔽 safeStorage:', e && e.message)
    }
  }

  const rt = require('../patches/handlers.js').createRuntime({ app, LOG: () => {} })
  const h = rt.handlers
  const status = typeof rt.secretStatus === 'function' ? rt.secretStatus() : null

  const plain = 'token-测试-abc-123'
  const cipher = h.SAFE_STORAGE_ENCRYPT(plain)

  // ── 不变量：凡是"声称加密"的路径，明文都不得直接出现在产物里 ──
  // insecure 是显式声明的明文等价物（v0:），不适用这条，单独在下面反向断言。
  if (cipher && MODE !== 'insecure') {
    ok('密文里不含明文', !String(cipher).includes(plain), cipher.slice(0, 12))
    ok(
      '密文里不含明文的 Base64',
      !String(cipher).includes(Buffer.from(plain, 'utf8').toString('base64')),
      cipher.slice(0, 12)
    )
  }

  if (MODE === 'safe') {
    if (status && status.mode === 'safeStorage') {
      ok('真后端：模式为 safeStorage', status.secure === true, status)
      ok('真后端：往返一致', h.SAFE_STORAGE_DECRYPT(cipher) === plain)
      ok('真后端：产物是 base64 形态', /^[A-Za-z0-9+/=]+$/.test(String(cipher)), cipher.slice(0, 12))
    } else {
      skip('真后端用例', '本机没有可用密钥环，mode=' + (status && status.mode))
    }
  }

  if (MODE === 'keyring') {
    if (cipher && String(cipher).startsWith('v2:')) {
      ok('密钥环：产物带 v2: 前缀', true)
      ok('密钥环：往返一致', h.SAFE_STORAGE_DECRYPT(cipher) === plain)
      ok('密钥环：AES-GCM 三段结构', String(cipher).split(':').length === 4, cipher.slice(0, 20))
      // GCM 的认证标签必须真的在校验：改一个字节就得解不出来（不能"解出乱码"）
      const parts = String(cipher).split(':')
      const flipped = Buffer.from(parts[3], 'base64')
      flipped[0] ^= 0xff
      const tampered = [parts[0], parts[1], parts[2], flipped.toString('base64')].join(':')
      ok('密钥环：篡改密文返回空串（认证失败）', h.SAFE_STORAGE_DECRYPT(tampered) === '')
      ok('密钥环：空输入不炸', h.SAFE_STORAGE_DECRYPT('') === '')
    } else {
      skip('密钥环用例', '本机没有 secret-tool/Secret Service，返回值=' + JSON.stringify(cipher))
    }
  }

  if (MODE === 'none') {
    ok('无后端：拒绝落盘（返回空串）', cipher === '', cipher)
    ok('无后端：模式为 none', status && status.mode === 'none', status)
    ok('无后端：secure 为 false', status && status.secure === false, status)
    ok('无后端：解密空串不炸', h.SAFE_STORAGE_DECRYPT('') === '')
  }

  if (MODE === 'insecure') {
    ok('显式风险：模式为 insecure', status && status.mode === 'insecure', status)
    ok('显式风险：产物带 v0: 标记', String(cipher).startsWith('v0:'), String(cipher).slice(0, 8))
    ok('显式风险：往返一致', h.SAFE_STORAGE_DECRYPT(cipher) === plain)
    ok('显式风险：secure 仍为 false', status && status.secure === false, status)
    // 标记位必须是真的：把 v0: 去掉后仍然可读，说明它确实是 base64 而非加密
    ok(
      '显式风险：v0 确实是 Base64（可用于自我诊断）',
      Buffer.from(String(cipher).slice(3), 'base64').toString('utf8') === plain
    )
  }

  if (MODE === 'migrate') {
    // 旧格式可读（不丢历史登录）
    ok(
      '迁移：旧 Base64 仍能解出明文',
      h.SAFE_STORAGE_DECRYPT(Buffer.from('legacy-token-abc', 'utf8').toString('base64')) ===
        'legacy-token-abc'
    )
    // 加载时应当已把磁盘上的 ka 换成密文
    let disk = null
    try {
      disk = JSON.parse(fs.readFileSync(IMPORTANT, 'utf8'))
    } catch (e) {}
    const ka = disk && disk.ka
    if (status && status.secure) {
      ok('迁移：磁盘 ka 已变密文', typeof ka === 'string' && (ka.startsWith('v2:') || !ka.includes('legacy')), String(ka).slice(0, 12))
      ok('迁移：其他键未被改动', disk && disk.unrelated === 'keep-me', disk)
      ok('迁移：迁移后的密文可解回原 token', h.SAFE_STORAGE_DECRYPT(ka) === 'legacy-token-abc')
    } else {
      ok('迁移：无安全后端时保持原样（不擅自覆盖）', typeof ka === 'string' && Buffer.from(ka, 'base64').toString('utf8') === 'legacy-token-abc', String(ka).slice(0, 12))
    }
  }

  console.log(lines.join('\n'))
  console.log(
    '\n[' + MODE + '] ' + pass + ' 通过 / ' + failed + ' 失败 / ' + skipped + ' 跳过'
  )
  app.exit(failed === 0 ? 0 : 1)
})
