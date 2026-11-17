// 设备身份（开发期模拟层）：给 webapp 的 device-feature 提供稳定、非空、
// 且与真实硬件绑定的取值。官方实现 = BIOS UUID + MachineGuid + PC 名
// → system.bytecode 拼装成 device_id。这里用 Linux 的 DMI 数据同构复刻。
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

function readDmi(name) {
  try {
    return fs.readFileSync(path.join('/sys/class/dmi/id', name), 'utf8').trim()
  } catch (e) {
    return ''
  }
}

function pick(...vals) {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim()
  return ''
}

// MachineGuid：官方取自注册表 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid，
// 首次生成后持久化，保证跨重启稳定（这是服务端判定"同一台机器"的关键）。
function machineGuid(userDataDir) {
  const file = path.join(userDataDir, 'machine-guid')
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(v)) return v
  } catch (e) {}
  const guid = crypto.randomUUID()
  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.writeFileSync(file, guid + '\n', { mode: 0o600 })
  } catch (e) {}
  return guid
}

function stableUuidFrom(...parts) {
  const h = crypto.createHash('sha1').update(parts.join('|')).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function machineId() {
  try {
    return fs.readFileSync('/etc/machine-id', 'utf8').trim()
  } catch (e) {
    return ''
  }
}

function createDeviceIdentity(app) {
  const dmiUuid = readDmi('product_uuid')
  const boardSerial = pick(readDmi('board_serial'), readDmi('product_serial'))
  // product_uuid / *_serial 在 Linux 上是 root-only（0400）。
  // 非 root 时用 machine-id + 主板/BIOS 型号确定性地合成一个 SMBIOS 形态的 UUID：
  // 对服务端而言等价于"这台机器的固定硬件号"，且跨重启不变。
  const synth = stableUuidFrom(
    'smbios',
    machineId() || os.hostname(),
    readDmi('product_name'),
    readDmi('bios_version'),
    readDmi('board_name')
  )
  const bios = pick(dmiUuid, boardSerial, synth)
  const machine = machineGuid(app.getPath('userData'))
  // device_id 必须稳定：只用不会变的东西（BIOS + MachineGuid）
  const deviceId = stableUuidFrom('kook-linux', bios, machine)
  const pcName = pick(os.hostname(), 'KOOK-PC')
  return { bios, machine, device_id: deviceId, pcName }
}

module.exports = { createDeviceIdentity }
