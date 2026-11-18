<div align="center">

# KOOK Linux

**KOOK 官方 Windows 客户端的 Linux 原生移植版**

直接运行官方客户端本体，把 Windows 专属的那一层在 Linux 上重新实现一遍——不是网页套壳。

[![Release](https://img.shields.io/github/v/release/kanniganfan/kook-linux?label=release&color=2ea44f)](https://github.com/kanniganfan/kook-linux/releases)
[![Downloads](https://img.shields.io/github/downloads/kanniganfan/kook-linux/total?color=2ea44f)](https://github.com/kanniganfan/kook-linux/releases)
[![License](https://img.shields.io/github/license/kanniganfan/kook-linux?color=2ea44f)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux-2ea44f?logo=linux&logoColor=white)]()
[![Electron](https://img.shields.io/badge/Electron-36.7.4-47848f?logo=electron&logoColor=white)]()
[![Stars](https://img.shields.io/github/stars/kanniganfan/kook-linux?style=social)](https://github.com/kanniganfan/kook-linux/stargazers)

[下载](#安装) · [功能](#功能) · [常见问题](#常见问题) · [从源码构建](#从源码构建) · [反馈](#反馈)

</div>

---

## 简介

KOOK（原开黑啦）的 PC 客户端从发布至今只有 Windows 和 macOS 版本，**官方没有发布过
Linux 客户端，也没有公开的 Linux 发布计划**。Linux 用户只能拿 Wine / Proton 跑 Windows
版，语音链路、屏幕分享、快捷键、托盘基本全是残的。

这个项目换了个做法：把官方客户端拆开，**原封不动地运行它自己的 `app.asar`**
（原版 webapp、原版 preload、原版业务逻辑），只把 Windows 专属的那一层——原生模块、
进程枚举、屏幕采集、托盘、全局快捷键、窗口行为——在 Linux 上重新实现一遍。

所以它不是一个"仿 KOOK 的客户端"，也不是把网页塞进 Electron 的壳：
**协议、接口、界面全部来自官方本体**，209 个 IPC 通道逐个真实现，没有任何空壳占位。

| | |
|---|---|
| **版本** | 跟随最新 [Release](https://github.com/kanniganfan/kook-linux/releases) |
| **移植基线** | 官方 PC 客户端 `0.112.0`（构建 `c5af713-kook_3321`） |
| **运行时** | Electron 36.7.4 / Chromium 136 |
| **支持架构** | x86_64 |
| **许可** | MIT（仅移植层） |
| **移植与适配** | KANNI（KOOK 昵称 KANNI#0001）· <cylqm@qq.com> |

> 本项目与 KOOK 官方无关，是社区移植作品。官方客户端及其资源的所有权利归其所有者。

---

## 目录

- [简介](#简介)
- [功能](#功能)
- [安装](#安装)
- [兼容性](#兼容性)
- [常见问题](#常见问题)
- [从源码构建](#从源码构建)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [更新节奏](#更新节奏)
- [反馈](#反馈)
- [致谢](#致谢)
- [许可](#许可)

---

## 功能

| 功能 | 状态 | 说明 |
|---|:---:|---|
| 登录 / 账号 | ✅ | 走官方接口，补齐 Linux 设备指纹 |
| 文字聊天 / 频道 / 服务器 | ✅ | 官方业务逻辑，不改协议 |
| 语音频道 | ✅ | 官方 RTC 链路 |
| 屏幕分享 | ✅ | `xdg-desktop-portal` + PipeWire 采集，面板内实时预览持续刷新 |
| 屏幕覆盖 | ⚠️ | X11 全局置顶；Wayland 限制在 KOOK 窗口内 |
| 客户端透明 | ✅ | 真正透出桌面，个人设置保持不透明实底 |
| 叠加色透明 / 菜单毛玻璃 | ✅ | 与客户端透明相互独立 |
| 悬浮工具栏 | ✅ | 无边框、透明、置顶、可拖动 |
| 全局快捷键 | ⚠️ | 自带本地键盘桥，Wayland 下需窗口有焦点 |
| 用户动态（游戏识别） | ✅ | 接官方进程活动引擎，数据源换成 `/proc` |
| 桌面通知 | ✅ | `libnotify`，点击可跳转 |
| 托盘常驻 / 关闭到托盘 | ✅ | 按 StatusNotifier 规范实现 |
| 开机自启 | ✅ | XDG autostart，不用 systemd 也能用 |
| 多语言界面 | ✅ | 简体中文 / 繁体中文 / 日文 / 英文 |
| 自动更新 | ❌ | **主动屏蔽**——官方更新器会装 Windows 安装包，覆盖掉移植版 |

细节：

- **屏幕分享授权**：只在点「分享屏幕」时申请一次系统授权，停止分享立即释放（杀掉 portal
  会话、删除 restore token），下次投屏重新申请，不会静默复用旧授权。
- **透明效果**：官方渲染层对「客户端透明」只做了两个动作（发 IPC + 给 `body` 加
  `theme-app-blur`）。移植版把这两条通道真正接上，并补掉了压在背景之上的遮罩层。
- **快捷键**：`globalShortcut` 在 Wayland 下走 XGrabKey，只能抓到 X11 客户端。移植版
  额外加了一条本地键盘桥，把 `keydown/keyup` 按官方 `IO_HOOK` 的形状转发给客户端。

---

## 安装

去 [Releases](https://github.com/kanniganfan/kook-linux/releases/latest) 下载对应格式的包。

### AppImage（任何发行版）

```bash
chmod +x KOOK-*-x86_64.AppImage
./KOOK-*-x86_64.AppImage
```

免安装。启动器会自动适配会话环境（Wayland / X11、GTK 版本、sandbox），不需要手动加参数。

### Debian / Ubuntu / Deepin / UOS

```bash
sudo dpkg -i kook_*_amd64.deb
sudo apt -f install   # 补依赖
```

### Fedora / RHEL / openSUSE

```bash
sudo rpm -i kook-linux-*.x86_64.rpm
```

### 包的大小

三个包都在 160–230 MB。客户端本体约 104 MB，Electron 运行时约 466 MB（含官方
`modules/`），压缩后就是这个量级——这是完整运行官方本体的代价，不是打包失误。

---

## 兼容性

| 项目 | 支持情况 |
|---|---|
| 架构 | x86_64 |
| 发行版 | 任何 glibc 发行版（Arch / Debian / Fedora / openSUSE 实测） |
| 桌面环境 | GNOME / KDE Plasma / XFCE / Cinnamon / MATE |
| 会话 | X11、Wayland 都可用 |
| 语音 | PipeWire / PulseAudio |
| 屏幕分享 | `xdg-desktop-portal` + 对应桌面的后端 |

> 不写死任何路径，全部走 XDG 规范；依赖缺失时会降级并给出提示，不会直接崩溃。

---

## 常见问题

<details>
<summary><b>双击 AppImage 没有任何反应</b></summary>

先确认有执行权限：`chmod +x KOOK-*.AppImage`。

仍无反应的话，从终端运行一次看报错：

```bash
./KOOK-*-x86_64.AppImage
```

早期版本在 GNOME 下会因为 GTK3/GTK4 符号冲突直接退出（连日志都不留），现已修复：
启动器固定 `--gtk-version=3`。如果用的是旧包，请更新到最新 Release。
</details>

<details>
<summary><b>窗口能打开，但里面一片空白</b></summary>

这是早期打包漏了运行依赖导致的，0.0.11 起已修复。确认你下载的是最新版本。
</details>

<details>
<summary><b>Wayland 下「在桌面上显示」「全屏游戏时显示」不可用</b></summary>

Wayland 协议不允许普通应用绘制全局置顶层，这两项只在 X11 会话生效。设置面板里会自动
置灰并给出原因，不会假装成功。需要全局覆盖层可以登录 X11 会话。
</details>

<details>
<summary><b>快捷键不生效</b></summary>

Wayland 下全局抓键受限。KOOK 窗口有焦点时由本地键盘桥接管，无焦点时可能收不到。
X11 会话下全局快捷键正常。
</details>

<details>
<summary><b>提示更新、要求下载安装包</b></summary>

自动更新已被主动屏蔽。官方更新器分发的是 Windows 安装包，装上去会覆盖移植版，所以更新
提示被改写成移植线的更新记录。需要新版请直接来 Releases 下载。
</details>

<details>
<summary><b>想反馈问题，需要提供什么</b></summary>

- 发行版与版本（`cat /etc/os-release`）
- 桌面环境与会话类型（`echo $XDG_CURRENT_DESKTOP $XDG_SESSION_TYPE`）
- KOOK 版本号
- `~/.config/KOOK/logs/` 下对应的日志片段
</details>

---

## 从源码构建

### 前置

- Node.js ≥ 18、npm
- 本机已安装官方 KOOK 客户端，并解包出 app 目录（默认 `~/kook-port/linux/app`）
- Electron 36.7.4 运行时目录（默认 `~/kook-port/e36/node_modules/electron/dist`）

路径可用环境变量覆盖：`KOOK_BASE_APP`、`electronDist`（在 `package.json` 里）。

### 出包

```bash
npm install                     # 只装打包工具 electron-builder
bash scripts/stage.sh           # 组装 .stage/app（官方基础文件 + 移植层补丁）
bash scripts/build.sh           # 三种包全打
bash scripts/build.sh AppImage  # 只打指定格式
bash scripts/build-rpm.sh       # 单独出 rpm（绕开 fpm）
```

产物在 `dist/`：

| 格式 | 文件名 | 适用 |
|---|---|---|
| AppImage | `KOOK-<ver>-x86_64.AppImage` | 任何发行版，免安装 |
| deb | `kook_<ver>_amd64.deb` | Debian / Ubuntu / Deepin / UOS |
| rpm | `kook-linux-<ver>.x86_64.rpm` | Fedora / RHEL / openSUSE |

详细步骤、依赖和踩坑记录见 [docs/BUILD.md](docs/BUILD.md)。

---

## 项目结构

仓库里**不含**官方客户端的 `src/`、`webapp/`、`node_modules/`——那些是有版权的产物。
这里只有我们自己写的移植层和构建脚本，构建时从你本机的官方客户端里取基础文件再拼起来。

```
patches/              移植层：覆盖到 app 目录上的文件
├── main.js             主进程入口：窗口、IPC 真实现、桌面集成
├── handlers.js         209 个 IPC 通道的真实实现
├── preload-shim.js     预加载钩子：原生模块打桩、字体、按键桥
├── device-identity.js  设备指纹（服务端登录风控需要）
├── resourse/kook.png   官方 logo
└── src/
    ├── browser_native/screen-recording-main.js   xdg-desktop-portal 采集
    ├── controllers/taskList/process-windows-*.js 用 /proc 实现进程枚举
    ├── controllers/taskList/taskList-execute.js  改过的官方文件
    ├── media/portal-screencast.py                PipeWire 抓屏小工具
    ├── media/win-geom.py                         窗口位置计算
    ├── preload/auto-launch.js                    改过的官方文件（XDG 自启）
    └── renderer/linux-overlay/                   屏幕覆盖层页面
scripts/              组装与打包脚本
build/                打包资源（图标、desktop 模板、afterPack 钩子）
docs/                 构建与实现说明
```

---

## 已知限制

- **Wayland 全局覆盖层**：协议层限制，需要 X11 会话。
- **Wayland 全局快捷键**：无焦点时可能收不到，有焦点时由本地键盘桥兜底。
- **原生语音 SDK**：官方只提供 Windows 二进制，语音走官方 web/RTC 分支。
- **迅游加速器**：官方合作方没有 Linux 版，工具箱里保留了入口但加了提示，不推荐下载。
- **自动更新**：主动禁用，见上文。

---

## 更新节奏

**不定期更新。** 官方客户端一升级，底层就可能要跟着改，没法承诺固定周期；
修好一版就发一版，影响登录和语音的兼容性问题优先处理。

每个版本都会在客户端内的更新记录里写清楚改了什么，历史记录一版一条、只增不删。

---

## 反馈

| 渠道 | 地址 |
|---|---|
| Issue | [提交问题](https://github.com/kanniganfan/kook-linux/issues) |
| 邮箱 | <cylqm@qq.com> |
| 官方项目 | [github.com/kaiheila](https://github.com/kaiheila) |

提 Issue 前请先看 [常见问题](#常见问题)，并附上上面要求的排障信息。

---

## 致谢

- [KOOK / 开黑啦](https://github.com/kaiheila) — 官方客户端
- [Electron](https://www.electronjs.org/)、[Chromium](https://www.chromium.org/) — 运行时
- [xdg-desktop-portal](https://github.com/flatpak/xdg-desktop-portal)、[PipeWire](https://pipewire.org/) — 屏幕采集

---

## 许可

移植层代码以 **MIT** 发布，见 [LICENSE](LICENSE)。
官方客户端及其资源不属于本项目，请自行从官方渠道获取。
