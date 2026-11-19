# 安全审查响应

针对 v0.0.11 的静态代码审查，逐条记录结论与处置。
**所有「可以改」的结论都来自本机实测**，没有实测依据的一律保持原状并写明原因——
为了看起来安全而把客户端搞挂，不是安全加固。

---

## P0-1 Electron 安全隔离配置

原配置：

```js
webPreferences: {
  nodeIntegration: false,
  contextIsolation: false,
  sandbox: false,
  webSecurity: false,
}
```

### `webSecurity` → **已开启** ✅

实测对比（同一台机器、同一份官方 webapp、GNOME / Wayland 会话）：

| 配置 | 页面文本长度 | DOM 节点数 |
|---|---:|---:|
| `webSecurity: false`（原） | 337 | 1292 |
| **`webSecurity: true`（现）** | **5721** | **2989** |

开启后页面加载完整，本地资源服务与同源拦截都不受影响，也没有新增网络错误
（改变前后都有相同的 4 条 `[api] POST` 失败，属于应用本身在未登录状态下的接口调用）。

### `contextIsolation` → **保持 false** ❌ 不能开

实测 `contextIsolation: true` 的结果：**页面文本长度 0，DOM 只剩 61 个节点**，等于白屏。

原因：官方 preload 是原版文件，它在 preload 里直接 `require('electron')` 并把对象挂到
`window` 上，页面脚本依赖这些注入。开启隔离后注入全部失效，官方 webapp 起不来。

### `sandbox` → **保持 false** ❌ 不能开

两个硬约束：

1. preload 需要 Node 能力（`fs` / `path` / `child_process`），sandbox 下不可用。
2. 启动参数带 `--no-sandbox`：AppImage 的 `chrome-sandbox` 位于只读 squashfs，
   SUID 位设不上去，不加 `--no-sandbox` 时 Electron 直接静默退出
   （这正是 v0.0.7 双击没反应的原因之一）。

**结论**：这一项当前无解，除非放弃 AppImage 分发形态或要求用户手工设置 SUID。
已在 README 的已知限制里说明。

### `nodeIntegration` → 本来就是 `false` ✅

---

## P0-2 权限授权范围过宽

原实现对所有请求无条件放行 `notifications` / `media` / `display-capture` /
`clipboard-read` / `clipboard-sanitized-write` / `fullscreen` / `background-sync`，
**不校验请求来源**。

现改为：先校验发起请求的 URL，再决定是否放行。

```js
const ORIGIN_OK = (u) =>
  /^https:\/\/([a-z0-9-]+\.)*kookapp\.cn([/?#]|$)/i.test(url) ||
  /^http:\/\/127\.0\.0\.1(:\d+)?([/?#]|$)/i.test(url) ||
  /^http:\/\/localhost(:\d+)?([/?#]|$)/i.test(url) ||
  /^(file|devtools):/i.test(url)
```

- 白名单覆盖：官方域名（含子域）、本地资源服务、本地文件、devtools
- 不在白名单内的请求直接拒绝，并打日志 `[perm] 拒绝来源不明的权限请求`
- `setPermissionRequestHandler` 与 `setPermissionCheckHandler` 两处都加了校验

实测：正常使用下没有任何请求被误拒（日志里 0 条 `[perm]` 拒绝记录），页面加载完整。

**保留的弱点**：白名单是域名级的，不是每次调用都二次确认。如果 webapp 自身出现
XSS，攻击者仍能在允许的域名内申请麦克风。进一步收紧需要改官方 preload 的调用链，
风险大于收益，暂不做。

---

## P0-3 登录凭据加密降级

`safeStorage` 不可用时退化为 Base64（只是编码，不提供保密性）。

**状态**：待处理，由 YS-逆向 负责。
改造方向：优先走 libsecret / kwallet，确实不可用时显式提示，不静默降级。

---

## P1-4 硬件加速配置初始化顺序 —— **已修复** ✅

**这是审查报告里唯一可以静态确认、并且实测复现的确定性缺陷。**

原代码在第 48 行就调用 `globalPref('disabled_hardware_acceleration', false)`，
而 `const path = require('path')` 在第 55 行。`readGlobalStore()` 内部的
`try/catch` 把 `ReferenceError: path is not defined` 静默吞掉，返回 `{}`，
于是所有桌面设置读到的都是默认值。

**实测复现**：把 `disabled_hardware_acceleration` 设为 `true` 后启动，
日志里根本没有「硬件加速已按设置关闭」这一行——设置完全没被读到。

**修法**：把 `path` / `fs` / `os` 的 require 提到文件顶部，`globalPref` 之前。

**修复后实测**：

```
[linux-main] 硬件加速已按设置关闭（重启后生效）
```

同一份配置，修复后能正确读到。顺带修好了「关闭到托盘」「效能模式」这两个
同样走 `globalPref()` 的设置项。

---

## P1-5 IPC 空实现与降级行为

**状态**：待处理，由 YS-逆向分析 产出 `docs/IPC-CONTRACT.md`，
按「已完整实现 / Linux 替代实现 / 明确不支持 / 临时兼容桩 / 尚未验证」分类。

当前事实：总通道 209 个，挂载真实实现 177 个，其余为有意为之的空实现
（Windows 注册表、系统代理等 Linux 上无对应物的能力）。

---

## P2 工程质量

| 项 | 状态 |
|---|---|
| 主进程模块化（main.js 约 2600 行） | 计划中，优先级低于安全项 |
| 上游版本兼容性检测 | 待 YS-逆向分析 出方案 |
| CI 自动构建 / 测试矩阵 | 计划中 |
| SHA-256 校验 | 已在 Release 说明中提供 |

---

## 关于官方接口的注入风险

审查报告提到「官方接口可能存在注入攻击风险」。这部分**不属于本仓库范围**：

- 官方接口的问题应通过官方安全渠道提交，本仓库不做公开复现
- 本仓库能做的只是强化客户端自身边界（就是 P0-1 / P0-2 / P0-3 这几条）
- 两项工作并行，互不阻塞

---

## 审查说明

以上结论来自本机实测，测试环境：CachyOS / GNOME / Wayland / x86_64。
没有做模糊测试，也没有做实际漏洞利用验证。生产环境风险请自行评估。
