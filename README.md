# KOOK Linux 移植版

KOOK 官方 Windows 客户端的 **Linux 原生移植版**。直接运行官方客户端本体（解包后的 `app.asar`），
把 Windows 专属的那部分——原生模块、进程枚举、屏幕采集、托盘、全局快捷键、窗口行为——
在 Linux 上重新实现一遍，**不使用第三方网页套壳**。

- 版本：`v0.0.7`（移植线），基线：官方 PC 客户端 `0.112.0`（构建 `c5af713-kook_3321`）
- 运行时：Electron 36.7.4 / Chromium 136
- 移植与适配：KANNI（`@KANNI#0001`）· 邮箱 <cylqm@qq.com>
- 官方项目：[github.com/kaiheila](https://github.com/kaiheila)

> 本项目与 KOOK 官方无关，是社区移植，官方客户端的所有权利归其所有者。

---

## 为什么会有这个项目

KOOK 的 PC 客户端从发布到现在一直只有 Windows 和 macOS 版本，**官方从头到尾没有发布
过 Linux 客户端，也没有公开的 Linux 发布计划**。

Linux 用户想用只能拿 Wine / Proton 跑 Windows 版，结果语音链路、屏幕分享、快捷键、
托盘基本全是残的，用起来很痛苦。

既然官方没有这个打算，那就自己动手：把官方客户端拆开，把 Windows 专属的那一层
（原生模块、进程枚举、屏幕采集、托盘、全局快捷键、窗口行为）在 Linux 上重新实现一遍。
接口、协议、界面全部沿用官方，不做网页套壳。

**更新是不定期的。** 官方客户端一升级，底层就可能要跟着改，没法承诺固定节奏；
修好一版就发一版，重要的兼容性问题会优先处理。

---

## 联系

| 方式 | 地址 |
|---|---|
| 邮箱 | <cylqm@qq.com> |
| 官方仓库 | [github.com/kaiheila](https://github.com/kaiheila) |
| 本移植版 | 在这个仓库提 Issue |

报问题的时候请带上：发行版与版本、桌面环境（X11 / Wayland）、KOOK 版本号，
以及 `~/.config/KOOK/logs/` 里对应的日志片段。

---

## 为什么仓库里没有官方文件

`src/`、`webapp/`、`node_modules/` 都是官方客户端里的版权产物，不适合进版本库。
所以仓库里只放**我们自己写的移植层**（`patches/`）和**构建脚本**，
构建时从你本机已安装的 KOOK 客户端里取基础文件，和补丁拼在一起。

```
patches/            移植层：覆盖到 app 目录上的文件
├── main.js           主进程入口：窗口、IPC 真实现、桌面集成
├── handlers.js       所有 IPC 通道的真实实现（store/设置/窗口/下载/快捷键…）
├── preload-shim.js   预加载钩子：原生模块打桩、字体、文本修正、按键桥…
├── device-identity.js 设备指纹（服务端登录风控需要）
├── resourse/kook.png 官方 logo
└── src/
    ├── browser_native/screen-recording-main.js   xdg-desktop-portal 采集
    ├── controllers/taskList/process-windows-*.js 用 /proc 实现进程枚举
    ├── controllers/taskList/taskList-execute.js  改过的官方文件
    ├── media/portal-screencast.py                PipeWire 抓屏小工具
    ├── media/win-geom.py                         窗口位置计算
    ├── preload/auto-launch.js                    改过的官方文件（XDG 自启）
    └── renderer/linux-overlay/                   屏幕覆盖层页面
scripts/            组装与打包脚本
build/              打包资源（图标、desktop 模板）
docs/               说明
```

## 构建

### 依赖

- Node.js ≥ 18、npm
- 本机已安装官方 KOOK 客户端，并解包出 app 目录（默认找 `~/kook-port/linux/app`）
- Electron 36.7.4 运行时目录（默认 `~/kook-port/e36/node_modules/electron/dist`）

两处路径都可以用环境变量改：`KOOK_BASE_APP`、`electronDist`（在 `package.json` 里）。

### 出包

```bash
npm install                # 只装打包工具 electron-builder
bash scripts/stage.sh      # 组装 .stage/app（官方基础文件 + 补丁）
bash scripts/build.sh      # 三种包全打
bash scripts/build.sh deb  # 只打 deb
```

产物在 `dist/`：

| 格式 | 文件 | 适用 |
|---|---|---|
| AppImage | `KOOK-0.0.7-x86_64.AppImage` | 任何发行版，免安装 |
| deb | `kook_0.0.7_amd64.deb` | Debian / Ubuntu / Deepin / UOS |
| rpm | `kook-linux-0.0.7.x86_64.rpm` | Fedora / RHEL / openSUSE |

三个包都约 150–210 MB：客户端本体 104 MB + Electron 运行时 466 MB（含官方 `modules/`），
压缩后就是这个量级。详细构建说明见 [docs/BUILD.md](docs/BUILD.md)。

## 已实现的功能

- **登录 / 聊天 / 语音**：走官方客户端本体，接口与协议不变
- **屏幕分享**：改用 `xdg-desktop-portal` + PipeWire 采集，面板内实时预览持续刷新；
  只在点「分享屏幕」时申请授权，停止分享立即释放，每次投屏重新授权
- **用户动态**：接入官方进程活动引擎，数据源换成 Linux `/proc`，能识别本机正在运行的游戏与应用
- **屏幕覆盖**：X11 会话支持全局置顶；Wayland 会话在 KOOK 窗口内显示（协议限制）
- **客户端透明**：自定义主题的「客户端透明」真正生效，可透出桌面；个人设置保持不透明实底
- **悬浮工具栏**：语音时在桌面显示无边框、透明、置顶、可拖动的小工具条
- **快捷键**：全局快捷键 + 本地键盘桥双保险，Wayland 下按键说话等不再失灵
- **桌面集成**：开机自启（XDG autostart）、启动最小化、关闭到托盘、硬件加速、效能模式
- **托盘 / 通知 / 图片查看 / 子窗口**：按 Linux 桌面规范重做
- **界面文案**：简中 / 繁中 / 日文 / 英文四套完整覆盖
- **自动更新已禁用**：官方更新器会装 Windows 安装包，必须屏蔽

## 已知限制

- **Wayland 全局覆盖层**：协议不允许普通应用绘制全局置顶层，所以「全屏游戏时显示」和
  「在桌面上显示」两项只在 X11 会话可用；Wayland 下这两项会自动置灰并给出原因
- **Wayland 全局快捷键**：`globalShortcut` 在 Wayland 下走 XGrabKey，只能抓到 X11 客户端。
  KOOK 有焦点时由本地键盘桥兜底，无焦点时可能收不到
- **原生语音 SDK**：官方只有 Windows 版二进制，语音走官方 web/RTC 分支

## 许可

移植层代码以 MIT 发布，见 [LICENSE](LICENSE)。
官方客户端及其资源不属于本项目，请自行从官方渠道获取。
