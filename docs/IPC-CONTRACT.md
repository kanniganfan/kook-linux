# KOOK Linux 移植版 · IPC 契约表

> 适用版本：v0.0.12 发布后的 `main`（含 0.0.13 待发布改动）
> 上游基线：官方 PC 客户端 **0.112.0**（build `0.112.0`，commit `c5af7134`），通道数 **209**
> 生成日期：2026-11-19 · 生成方式：静态分析 `patches/main.js`、`patches/handlers.js`、`patches/preload-shim.js`
> 对应代码审查条目：**P1-5（IPC 空实现与降级行为）**，并附 **P2-7（上游兼容性检测）** 方案

## 0. 一页结论

| 类别 | 数量 | 含义 |
|---|---:|---|
| **A 已完整实现** | 92 | 走 Electron 跨平台 API 或真实系统调用，语义与 Windows 版等价 |
| **B Linux 替代实现** | 33 | 用 `/proc`、`pactl`、`globalShortcut`、`desktopCapturer`、独立窗口等替代 Windows 专有机制 |
| **C 明确不支持** | 28 | 返回显式的「不支持」语义，前端能识别，不会假装成功 |
| **D 临时兼容桩** | 56 | 返回常量占位，界面不报错但功能不生效（**风险集中区**） |
| 合计 | **209** | 与官方 `constants.js` 的 `IPCEventName` 一一对应 |

四条需要先知道的结论：

1. **真正会被用户感知的功能缺失集中在 D**：下载器、音频 AI 降噪、通话面板、空闲检测、日志压缩包。它们都返回"成功"，UI 上看不出异常——这正是审查报告 P1-5 指出的风险。
2. **`WINDOW_SET_SIZE_ORIGIN` 已修复**（`1165333`）：此前 `preload/window.js:129` 发 `send` 调用、主进程未注册，落到 catch-all 返回 `{}`，「设置窗口初始尺寸」静默空转；现在按发送方窗口 `setContentSize(w,h)` 真实生效，参数非法直接忽略。官方 `constants.js` 里同时存在正确与错拼两套窗口通道，preload 用的是错拼的 `WINDOW_IS_ALWAY_ON_TOP`（主进程按同名实现，返回值是真的），错拼的 `WINDOW_SET_ALWAY_ON_TOP` 无调用方、属死通道。
3. **sendSync 全部有回值**（39 条），不存在渲染进程被永久阻塞的通道；这是 preload 护栏 + catch-all 双重保证的结果，改动时不要破坏。
4. **C 类不是失败**：自动更新、迅游加速、GGPlay 游戏浮层在 Linux 上本来就不该有，返回显式不支持比伪造成功更正确。
5. **通道存在 ≠ 契约正确**：本轮又修掉三处**形状/语义**问题（`SYSTEM_GET_ACTIVE_DOMAIN` 返回形状、`SYSTEM_GET_FILE` 伪成功、`SYSTEM_SWITCH_SERVER_API` 假切换），其中 `SYSTEM_GET_UNIQUE_DETAIL` 的字段缺失仍未决（见 9.2）。这类问题静态看「通道都注册了」，运行时表现为功能静默不生效。

## 1. 分类口径

- **A 已完整实现**：实现体是真实调用（Electron API、`fs`、`session`、`dialog`、`globalShortcut`…），返回值形状与官方 preload 期望一致。
- **B Linux 替代实现**：Windows 上由原生 `.node` 完成的能力，在 Linux 用别的机制重做，**功能真的可用**，但与官方实现路径不同（如 `/proc` 取代 `node-process-windows`）。
- **C 明确不支持**：该能力在 Linux 无对应物或已被移植版主动禁用，返回值带明确的否定语义（`false` / `{ok:false,reason}` / 错误码）。
- **D 临时兼容桩**：为了让界面继续渲染而返回常量。**默认安全但语义空洞**，任何依赖其结果的新功能都会静默失效。
- **E 尚未验证**（横切视图，见第 6 节）：实现存在，但只在部分环境（X11/Wayland、有无密钥环、有无 PipeWire）验证过，**不是独立主类**，避免一条通道被重复计入两个桶。

## 2. A 类 · 已完整实现（92 条）

| 通道 | 实现位置 | 行为/返回 | 备注 |
|---|---|---|---|
| `STORE_GLOBAL_INIT` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_GLOBAL_SET` | `patches/handlers.js` | 原值 / 默认值 | 写后标脏，落盘到 userData/linux-store |
| `STORE_GLOBAL_GET` | `patches/handlers.js` | 原值 / 默认值 | 同步读，返回原值或默认值 |
| `STORE_GLOBAL_REMOVE` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_GLOBAL_GET_ALL` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_USER_INIT` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_USER_SET` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_USER_GET` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_USER_REMOVE` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_IMPORTANT_GET` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_IMPORTANT_SET` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_IMPORTANT_REMOVE` | `patches/handlers.js` | 原值 / 默认值 |  |
| `STORE_SESSION_FLUSH` | `patches/handlers.js` | 原值 / 默认值 | 把内存脏页刷到磁盘 |
| `SETTING_GET` | `patches/handlers.js` | 原值 / 默认值 | setting.json 读写，替代官方注册表配置 |
| `SETTING_SET` | `patches/handlers.js` | 原值 / 默认值 |  |
| `SYSTEM_GET_PATH` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_GET_ARGV` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_GET_PCNAME` | `patches/handlers.js` | 见备注 | 伪装值 DESKTOP-K00KPC（风控需要 Windows 机器名形态） |
| `SYSTEM_GET_SYSTEM_VERSION` | `patches/handlers.js` | 见备注 | 伪装值 10.0.22631（与 systemVersion shim 一致） |
| `SYSTEM_GET_UNIQUE` | `patches/handlers.js` | 见备注 | 设备指纹：默认返回 machineId（md5）；开 KOOK_DEVICE_DETAIL_FULL=1 后返回 device-identity 的 UUID，与 DETAIL 同源 |
| `SYSTEM_GET_UNIQUE_DETAIL` | `patches/handlers.js` | 见备注 | 两态：默认 {id,type:linux}（线上行为，零漂移）；KOOK_DEVICE_DETAIL_FULL=1 时 {bios,machine,device_id}，且 device_id 与 GET_UNIQUE 同源同值 |
| `SYSTEM_GET_ACTIVE_DOMAIN` | `patches/handlers.js` | 见备注 | 返回官方形状（activeApiOrigin/activeH5Origin/activeFirstPartyOrigins），旧 {origin,api} 保留兜底；形状来源 preload/runtime-domain.js:21 |
| `SYSTEM_WAIT_ACTIVE_DOMAIN` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_GET_DNS_SERVER` | `patches/handlers.js` | 见备注 | 真实读取 /etc/resolv.conf |
| `SYSTEM_LOGOUT` | `patches/handlers.js` | 见备注 | 清 session 存储 + 清 user/important 两套持久化 |
| `SYSTEM_SET_AUTH_COOKIE` | `patches/handlers.js` | 见备注 | 经 session.cookies 写服务端下发的登录 Cookie |
| `SYSTEM_CHECK_ACCESS_FILE` | `patches/handlers.js` | 见备注 | 真实 fs.accessSync |
| `SYSTEM_COPY_IMAGE` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_SHOW_SAVE_DIALOG` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_SHOW_OPEN_DIALOG` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_OPEN_PATH` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_OPEN_EXTERNAL` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_GET_FILE` | `patches/handlers.js` | 见备注 | 真实 dialog.showOpenDialog；无窗口直接返回 code:-1（避免挂死 sendSync 调用方） |
| `SYSTEM_SWITCH_SERVER_API` | `patches/handlers.js` | 见备注 | 返回 true 但未真正切换域名（domain-switch 由 SYSTEM_GET_ACTIVE_DOMAIN 承担） |
| `SYSTEM_RELAUNCH` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_GET_HARDWARE_ACCELERATION` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_SET_HARDWARE_ACCELERATION` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_GET_MICROPHONE_PERMISSION` | `patches/handlers.js` | 见备注 | 恒 granted；实际授权由权限白名单把关 |
| `SYSTEM_REQUEST_MICROPHONE_PERMISSION` | `patches/handlers.js` | 见备注 |  |
| `SCREEN_GET_ALL_DISPLAY` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_GET_PRIMARY_DISPLAY` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_GET_DISPLAY_NEAREST_POINT` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_GET_DISPLAY_MATCHING` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_GET_CURSOR_SCREEN_POINT` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_DIP_TO_SCREEN_RECT` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_DIP_TO_SCREEN_POINT` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_SCREEN_TO_DIP_POINT` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SCREEN_SCREEN_TO_DIP_RECT` | `patches/handlers.js` | 见备注 | Electron screen API 直通，多屏/DIP 换算与官方一致 |
| `SAFE_STORAGE_ENCRYPT` | `patches/handlers.js` | 字符串（见 9.1） | 四态返回：Electron 密文 / v2: AES-GCM / v0: 明文（显式） / 空串（拒绝落盘） |
| `SAFE_STORAGE_DECRYPT` | `patches/handlers.js` | 明文字符串 | 向下兼容三种历史格式（Electron 密文、v0:、旧版裸 Base64） |
| `GLOBAL_SHORTCUT_REGISTER` | `patches/handlers.js` | 见备注 | Electron globalShortcut；Wayland 下由合成器决定是否生效 |
| `GLOBAL_SHORTCUT_UNREGISTER` | `patches/handlers.js` | 见备注 |  |
| `GLOBAL_SHORTCUT_IS_REGISTER` | `patches/handlers.js` | 见备注 |  |
| `CREATE_MESSAGEPORT` | `patches/main.js` | 见备注 | MessagePort 双向通道，语音/多窗口高频用 |
| `CREATE_MESSAGEPORT_RESULT` | `patches/main.js` | 见备注 |  |
| `COMMON_WIN_OPEN` | `patches/handlers.js` | 见备注 | 真实子窗口（BrowserWindow），由 id 管理生命周期 |
| `COMMON_WIN_CLOSE` | `patches/handlers.js` | 见备注 |  |
| `LOGGER_APP_LOG` | `patches/handlers.js` | 见备注 | 渲染侧日志落文件 |
| `LOGGER_OPEN_DIR` | `patches/handlers.js` | 见备注 | 真实打开日志目录：app.getPath(logs) → userData/logs → userData，失败返回 false |
| `WINDOW_CUT` | `patches/main.js` | 见备注 |  |
| `WINDOW_COPY` | `patches/main.js` | 见备注 |  |
| `WINDOW_PASTE` | `patches/main.js` | 见备注 |  |
| `WINDOW_IS_VISIBLE` | `patches/main.js` | 见备注 |  |
| `WINDOW_IS_FOCUSED` | `patches/main.js` | 见备注 |  |
| `WINDOW_IS_MAX` | `patches/main.js` | 见备注 |  |
| `WINDOW_IS_MIN` | `patches/main.js` | 见备注 |  |
| `WINDOW_SET_ALWAYS_ON_TOP` | `patches/main.js` | 见备注 |  |
| `WINDOW_MIN` | `patches/main.js` | 见备注 |  |
| `WINDOW_MAX` | `patches/main.js` | 见备注 |  |
| `WINDOW_UNMAX` | `patches/main.js` | 见备注 |  |
| `WINDOW_RESTORE` | `patches/main.js` | 见备注 |  |
| `WINDOW_SHOW` | `patches/main.js` | 见备注 |  |
| `WINDOW_HIDE` | `patches/main.js` | 见备注 |  |
| `WINDOW_FOCUS` | `patches/main.js` | 见备注 |  |
| `WINDOW_CLOSE` | `patches/main.js` | 见备注 |  |
| `WINDOW_MOVE_TOP` | `patches/main.js` | 见备注 |  |
| `WINDOW_MOVE_TOP_FORCE` | `patches/main.js` | 见备注 |  |
| `WINDOW_GET_SIZE` | `patches/main.js` | 见备注 |  |
| `WINDOW_SET_SIZE` | `patches/main.js` | 见备注 |  |
| `WINDOW_SET_TITLE` | `patches/main.js` | 见备注 |  |
| `WINDOW_SET_POSITION` | `patches/main.js` | 见备注 |  |
| `WINDOW_SET_SIZE_ORIGIN` | `patches/main.js` | 见备注 | 按发送方窗口 setContentSize(w,h)；非法参数忽略（v0.0.12 修复） |
| `WINDOW_SET_ZOOM_FACTOR` | `patches/main.js` | 见备注 |  |
| `WINDOW_IS_ALWAY_ON_TOP` | `patches/main.js` | 见备注 | 官方错拼（少一个 S），preload 实际在用；主进程已按此名注册，返回真实 isAlwaysOnTop() |
| `WINDOW_ON_MINIMIZE` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_RESTORE` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_MAXIMIZE` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_UNMAXIMIZE` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_RESIZE` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_HIDE` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_SHOW` | `patches/main.js` | 无返回 / `true` |  |
| `WINDOW_ON_MOVE` | `patches/main.js` | 无返回 / `true` |  |

## 3. B 类 · Linux 替代实现（33 条）

| 通道 | 实现位置 | 行为/返回 | 备注 |
|---|---|---|---|
| `TASKLIST_CHANGE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_STATE_CHANGE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_OBS_SRT_MODE_CHANGE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_INFO_CHANGE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_QUERY_SIMPLE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_BOOSTER_CHANGE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_GET_GAME_CHANNEL_FILE_CONTENT` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `TASKLIST_GET_ALL_WINDOW_TITLE` | 官方 taskList + `patches/src/controllers/taskList/` | 见备注 | 官方 taskList 模块 + Linux /proc 适配层（进程名/窗口标题/PID） |
| `VOLUME_GET_MIC_VOLUME_BY_LABEL` | `patches/handlers.js` | 见备注 | pactl 直接操作 PulseAudio/PipeWire 默认 source/sink |
| `VOLUME_SET_MIC_VOLUME_BY_LABEL` | `patches/handlers.js` | 见备注 | pactl 直接操作 PulseAudio/PipeWire 默认 source/sink |
| `VOLUME_GET_MIC_BOOST_BY_LABEL` | `patches/handlers.js` | 见备注 | pactl 直接操作 PulseAudio/PipeWire 默认 source/sink |
| `VOLUME_SET_MIC_BOOST_BY_LABEL` | `patches/handlers.js` | 见备注 | pactl 直接操作 PulseAudio/PipeWire 默认 source/sink |
| `VOLUME_SET_SPEAKER_VOLUME` | `patches/handlers.js` | 见备注 | pactl 直接操作 PulseAudio/PipeWire 默认 source/sink |
| `SCREENSHOT_FULL` | `patches/handlers.js` | 见备注 | desktopCapturer 抓屏，返回 dataURL |
| `SCREENSHOT_GET_DEFAULT_PATH` | `patches/handlers.js` | 见备注 |  |
| `IO_HOOK` | `patches/handlers.js` | 见备注 | 双通道：globalShortcut 注册 + 渲染侧本地键盘桥（KOOK_VK_FIRED） |
| `IO_HOOK_RESTART` | `patches/handlers.js` | 见备注 |  |
| `OVERLAY_START_CREATE_WIN` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_START_CLOSE_WIN` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WIDNOW_CREATE` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WIDNOW_CLOSE` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WIDNOW_DESTROY` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WINDOW_GET_BOUNDS` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WINDOW_SET_BOUNDS` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WINDOW_HIDE` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WINDOW_SHOW` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WINDOW_EXISTS_SYNC` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_WINDOW_SET_MOVE_TOP_CHECK` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_COUNTDOWN_PRECREATE` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `OVERLAY_COUNTDOWN_OPEN` | `patches/main.js` installOverlay() | 见备注 | 独立透明置顶窗口 + 语音说话列表；X11 可用，Wayland 仅窗口内 |
| `ON_OVERLAY_WINDOW_CLOSE` | `patches/main.js` installOverlay() | 无返回 / `true` |  |
| `ON_OVERLAY_WINDOW_MOUSE_ENTER` | `patches/main.js` installOverlay() | 无返回 / `true` |  |
| `ON_OVERLAY_WINDOW_MOUSE_LEAVE` | `patches/main.js` installOverlay() | 无返回 / `true` |  |

## 4. C 类 · 明确不支持（28 条）

| 通道 | 实现位置 | 行为/返回 | 备注 |
|---|---|---|---|
| `DOWNLOAD_UPDATE` | `patches/handlers.js` | `{code:-1}` | 明确拒绝：返回 {code:-1,message:"Linux 移植版已禁用自动更新"} |
| `SYSTEM_IS_RELAUNCH_UPDATE` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_IS_RELAUNCH_PROACTIVE_UPDATE` | `patches/handlers.js` | 见备注 |  |
| `BOOSTER_INSTALL` | `patches/handlers.js` | `{ok:false,reason}` | 明确不支持：{ok:false,reason:"unsupported-on-linux"}（迅游加速器无 Linux 版） |
| `BOOSTER_START` | `patches/handlers.js` | `{ok:false,reason}` |  |
| `BOOSTER_DOWNLOAD` | `patches/handlers.js` | `{ok:false,reason}` |  |
| `BOOSTER_IS_INSTALL` | `patches/handlers.js` | `false` |  |
| `BOOSTER_IS_RUNING` | `patches/handlers.js` | `false` |  |
| `BOOSTER_GET_INSTALL_STATE` | `patches/handlers.js` | 见备注 |  |
| `GGPLAY_START` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `GGPLAY_LAUNCH_GAME` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `GGPLAY_EXIT` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `GGPLAY_UPLOAD_ARCHIVE` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `GGPLAY_IS_GAME_RUNNING` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `GGPLAY_ON_CALLBACK` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `GGPLAY_ON_UPLOAD_SUCCESS` | `patches/handlers.js` | `false` | Windows 游戏浮层/加速链路，接口存在但不执行 |
| `__GGPLAY_CALL` | `patches/handlers.js` | 见备注 | 内部调用占位 |
| `VOICEHOOK_setVolume` | `patches/handlers.js` | 无返回 / `true` | Windows 专有采集钩子，返回「未启用」语义 |
| `VOICEHOOK_GET_RUNING_MUSIC` | `patches/handlers.js` | 无返回 / `true` | Windows 专有采集钩子，返回「未启用」语义 |
| `VOICEHOOK_HOOK_PORT` | `patches/handlers.js` | 无返回 / `true` | Windows 专有采集钩子，返回「未启用」语义 |
| `VOICEHOOK_CALLBACK` | `patches/handlers.js` | 无返回 / `true` | Windows 专有采集钩子，返回「未启用」语义 |
| `VOICEHOOK_UNHOOK` | `patches/handlers.js` | 无返回 / `true` | Windows 专有采集钩子，返回「未启用」语义 |
| `GAME_OVERLAY_CREATE_WIN` | `patches/handlers.js` | 见备注 | 游戏内浮层不支持，仅保留窗口级覆盖 |
| `GAME_OVERLAY_CLOSE_WIN` | `patches/handlers.js` | 见备注 | 游戏内浮层不支持，仅保留窗口级覆盖 |
| `SYSTEM_GET_DXDIAGINFO` | `patches/handlers.js` | 见备注 | 返回固定假 DXDIAG（服务端仅做环境展示） |
| `SYSTEM_GET_BLUETOOTH_DEVICE` | `patches/handlers.js` | 见备注 |  |
| `SYSTEM_CHECK_ADMIN` | `patches/handlers.js` | `false` | 恒 false（Linux 无管理员令牌概念） |
| `AUDIO_AI_PIPE` | `patches/handlers.js` | 见备注 | 明确不支持：{code:-1,message:"Linux 移植版未提供音频 AI 处理"}，原实现是 {code:0} 伪成功 |

## 5. D 类 · 临时兼容桩（56 条）

以下通道返回常量，界面正常但功能不生效。**按前缀聚类**，同一簇行为一致：

| 通道 | 当前返回 | 用户可见影响 |
|---|---|---|
| `DOWNLOAD_GET_LIST` `DOWNLOAD_DOWNLAOD` `DOWNLOAD_CANCEL` `DOWNLOAD_ERROR` `DOWNLOAD_OPEN_PATH` | `[]` / `{id:'0'}` / `true` | 应用内下载器不工作（文件下载需走浏览器） |
| `AUDIO_AI_PIPE` `AUDIO_AI_ENABLE_AGC` `AUDIO_AI_ENABLE_DENOISE` `AUDIO_AI_ENABLE_RECORD` `AUDIO_AI_GET_PROCESS_CPU_USAGE_BY_NAME` | `{code:0}` / `true` / `0` | 无 AI 降噪与回声处理，开关拨了没效果 |
| `VOICE_CALL_PANEL_INIT` `VOICE_CALL_PANEL_ON_RECEIVE_INVITE` `VOICE_CALL_PANEL_ON_RECEIVE_REMOVE_INVITE` `VOICE_CALL_PANEL_DESTORY` | `true`（无窗口） | 私聊语音来电面板不弹 |
| `PC_INACTIVE_START` `PC_INACTIVE_STOP` `PC_INACTIVE_CHANGE` | `true` | 挂机/空闲状态不检测 |
| `PERFORMANCE_LOG_START` `PERFORMANCE_LOG_RENDER` | `true` | 性能日志不落盘 |
| `ENTER_POWER_SAVING_MODE_1` `ENTER_POWER_SAVING_MODE_2` `EXIT_POWER_SAVING_MODE` `CLEAR_RENDER_FRAME_CACHE` `SEND_RENDER_WRITE_LOG` `SCREEN_ON_METRICS_CHANGED` | `true` / 空 | 省电模式、帧缓存清理为空操作 |
| `CHECK_FULLSCREEN_START` `CHECK_FULLSCREEN_STOP` `CHECK_FULLSCREEN_CHANGE` | `{}` / `false` | 全屏检测未接入（影响游戏覆盖判定） |
| `PROCESS_TCP_ALIVE_DATA` `PROCESS_DOMAIN_TCP_ALIVE_CHANGE` | `[]` / `true` | TCP 保活探测无数据 |
| `REGEDIT_GET` `REGEDIT_SET` `REGEDIT_DELETE` | `null` | 注册表语义由 STORE/SETTING 替代，等价可用 |
| `BOOSTER_SET_CONFIG` `BOOSTER_TEST_SPEED` `BOOSTER_EVENTS` `BOOSTER_GET_GAME_INFO` `BOOSTER_STOP_DOWNLOAD` `BOOSTER_DEFAULT_INSTALL_PATH` `BOOSTER_CLEAN_CACHE` | 常量 | 加速器周边接口（主能力已在 C 类明确拒绝） |
| `STORE_AUTH_BACKFILL_COOKIE` `STORE_IS_AUTH_COOKIE_MISSING` | `null` / `false` | 登录态回填逻辑未实现（当前不影响登录） |
| `LOGGER_GET_ZIP_FILE` `LOGGER_UPDATE_COMMON_PARAMS` | `null` / 空 | 「打包日志」未实现（`LOGGER_OPEN_DIR` 已实现真实打开目录，移入 A 类） |
| `GLOBAL_ON_ROUTER_JUMP` `GLOBAL_SHORTCUT_CALLBACK` `VOICEHOOK_CALLBACK` `VOICEHOOK_UNHOOK` `SYSTEM_ON_SECOND_INSTANCE` | 空 | 事件型通道，空实现可接受 |
| `VOLUME_SET_MIC_AGC_ALL` `VOLUME_REFRESH_DEVICE_LIST` `VOLUME_REFRESH_CHILDREN_PROCESS` | 空 | 设备热插拔与 AGC 批量设置未接 |
| `SCREENSHOT_START` `SCREENSHOT_ON_CONFIRM` `SCREENSHOT_ON_SAVE` | `true` / 空 | 截图确认链未完成（`SCREENSHOT_FULL` 抓屏本身可用） |
| `COMMON_WIN_RESET_POSITION` `COMMON_WIN_ON_CLOSED` | `true` / 空 | 子窗口位置重置、关闭回调为空 |
| `WINDOW_SET_ALWAY_ON_TOP` | catch-all `{}` | 官方错拼死通道，preload 无调用方，保留现状即可 |
| `SYSTEM_GET_FILE` `SYSTEM_SWITCH_SERVER_API` `__GGPLAY_CALL` | `{code:0,data:null}` / `true` / `null` | 伪成功：取文件、切域名实际未发生 |

D 类完整名单（56 条，供 grep 对账）：

```
GLOBAL_GET_GLOBAL GLOBAL_ON_ROUTER_JUMP STORE_AUTH_BACKFILL_COOKIE STORE_IS_AUTH_COOKIE_MISSING LOGGER_GET_ZIP_FILE LOGGER_UPDATE_COMMON_PARAMS PROCESS_TCP_ALIVE_DATA CHECK_FULLSCREEN_START CHECK_FULLSCREEN_STOP CHECK_FULLSCREEN_CHANGE SYSTEM_ON_SECOND_INSTANCE GLOBAL_SHORTCUT_CALLBACK VOLUME_SET_MIC_AGC_ALL VOLUME_REFRESH_CHILDREN_PROCESS VOLUME_REFRESH_DEVICE_LIST WINDOW_SET_ALWAY_ON_TOP COMMON_WIN_RESET_POSITION COMMON_WIN_ON_CLOSED AUDIO_AI_ENABLE_AGC AUDIO_AI_ENABLE_DENOISE AUDIO_AI_GET_PROCESS_CPU_USAGE_BY_NAME AUDIO_AI_ENABLE_RECORD DOWNLOAD_GET_LIST DOWNLOAD_DOWNLAOD DOWNLOAD_CANCEL DOWNLOAD_ERROR DOWNLOAD_OPEN_PATH PC_INACTIVE_START PC_INACTIVE_STOP PC_INACTIVE_CHANGE SCREENSHOT_START SCREENSHOT_ON_CONFIRM SCREENSHOT_ON_SAVE VOICE_CALL_PANEL_INIT VOICE_CALL_PANEL_ON_RECEIVE_INVITE VOICE_CALL_PANEL_ON_RECEIVE_REMOVE_INVITE VOICE_CALL_PANEL_DESTORY PERFORMANCE_LOG_START PERFORMANCE_LOG_RENDER PROCESS_DOMAIN_TCP_ALIVE_CHANGE ENTER_POWER_SAVING_MODE_1 ENTER_POWER_SAVING_MODE_2 CLEAR_RENDER_FRAME_CACHE SEND_RENDER_WRITE_LOG EXIT_POWER_SAVING_MODE SCREEN_ON_METRICS_CHANGED BOOSTER_SET_CONFIG BOOSTER_TEST_SPEED BOOSTER_EVENTS BOOSTER_DEFAULT_INSTALL_PATH BOOSTER_GET_GAME_INFO BOOSTER_STOP_DOWNLOAD BOOSTER_CLEAN_CACHE REGEDIT_GET REGEDIT_SET REGEDIT_DELETE
```

## 6. E · 尚未验证（横切视图）

| 通道 | 已验证环境 | 缺验证的环境 | 风险 |
|---|---|---|---|
| `GLOBAL_SHORTCUT_REGISTER` `GLOBAL_SHORTCUT_UNREGISTER` `GLOBAL_SHORTCUT_IS_REGISTER` `IO_HOOK` `IO_HOOK_RESTART` | X11 | Wayland（合成器可能拒绝 grab） | 按键说话/快捷键失效，且 `isRegistered` 返回值失真 |
| `SAFE_STORAGE_ENCRYPT` `SAFE_STORAGE_DECRYPT` | gnome_libsecret | 无密钥环、KWallet、`basic_text` 后端 | 无密钥环时拒绝落盘 → 每次启动重登 |
| `VOLUME_*` | PipeWire + pactl | 纯 ALSA、无声卡容器 | 麦克风/扬声器音量读写失败 |
| `SCREENSHOT_FULL` `OVERLAY_*` | X11 | Wayland（仅窗口内可覆盖） | 覆盖面板位置/置顶行为退化 |
| `TASKLIST_*` | x86_64 `/proc` | 非 Linux、受限容器（hidepid） | 进程识别为空，用户动态不显示游戏 |
| `DOWNLOAD_OPEN_PATH` | 已装 xdg-open | 精简桌面环境 | 失效 |

## 7. sendSync 专项（39 条）

渲染侧 `ipcRenderer.sendSync` 在**没有主进程监听时会永久阻塞**，所以同步通道必须逐条保证有回值。

- 主进程侧：`installStubs()` 为全部 209 条注册 `ipcMain.on`，并在 `event.returnValue` 未设置时写入 `stubValue()` 结果。
- 渲染侧：`patches/preload-shim.js` 的护栏拦截**不在 `constants.js` 里的**同步通道，直接返回 `undefined` 并打 `[shim] 未注册通道 sendSync 已拦截`。

同步通道清单：

```
BOOSTER_GET_INSTALL_STATE BOOSTER_IS_INSTALL BOOSTER_IS_RUNING COMMON_WIN_OPEN DOWNLOAD_GET_LIST
GGPLAY_IS_GAME_RUNNING GLOBAL_GET_GLOBAL OVERLAY_WINDOW_EXISTS_SYNC REGEDIT_DELETE REGEDIT_GET
REGEDIT_SET SAFE_STORAGE_DECRYPT SAFE_STORAGE_ENCRYPT SCREEN_DIP_TO_SCREEN_POINT SCREEN_DIP_TO_SCREEN_RECT
SCREEN_GET_ALL_DISPLAY SCREEN_GET_CURSOR_SCREEN_POINT SCREEN_GET_DISPLAY_MATCHING SCREEN_GET_PRIMARY_DISPLAY
SCREEN_SCREEN_TO_DIP_POINT SCREENSHOT_GET_DEFAULT_PATH SETTING_GET STORE_USER_GET SYSTEM_CHECK_ACCESS_FILE
SYSTEM_GET_ACTIVE_DOMAIN SYSTEM_GET_ARGV SYSTEM_GET_DNS_SERVER SYSTEM_GET_HARDWARE_ACCELERATION
SYSTEM_GET_MICROPHONE_PERMISSION SYSTEM_GET_PATH SYSTEM_GET_PCNAME SYSTEM_GET_SYSTEM_VERSION
SYSTEM_IS_RELAUNCH_UPDATE WINDOW_GET_SIZE WINDOW_IS_ALWAY_ON_TOP WINDOW_IS_FOCUSED WINDOW_IS_MAX
WINDOW_IS_MIN WINDOW_IS_VISIBLE
```

维护要求：新增同步通道时必须同时确认 ① 在 `constants.js` 里（否则被护栏拦成 `undefined`）② 主进程有监听。

## 8. 契约外通道（`constants.js` 里没有，但前端/移植层在用）

| 通道 | 用途 | 归属 |
|---|---|---|
| `DESKTOP_CAPTURER_GET_SOURCES` | 屏幕分享列源（替代官方原生模块） | B |
| `PORTAL_CAPTURE_START` `PORTAL_CAPTURE_STOP` `PORTAL_FRAME` `PORTAL_SESSION_READY` | xdg-desktop-portal 抓屏帧流 | B |
| `GOLIVE_CAPTURE_SOURCES` `GOLIVE_VIDEO_FRAME` `GOLIVE_SET_PENDING_SOURCE` `GOLIVE_PENDING_RECT` | 直播/录制取源 | B |
| `ACTIVITY_SET_CATALOG` | 官方进程活动库（2000 条）注入 | B |
| `SESSION_GET_COOKIES` | 登录态读取 | A |
| `KOOK_VK_FIRED` | 本地键盘桥（preload → 主进程） | B |
| `WINDOW_FLASH_FRAME` `WINDOW_REQUEST_ATTENTION` `FLASH_FRAME` `REQUEST_ATTENTION` | 任务栏闪烁/提醒 | A |
| `OVERLAY_GET_CAPS` `OVERLAY_TALK_LIST` | 覆盖面板能力与说话列表 | B |

## 9. 降级语义规范（建议）

审查报告要求「关键功能用明确错误状态，而不是统一返回成功」。现状是 A/B/C 已满足，D 是主要缺口。建议按下面三条收敛：

1. **可判定的失败必须带原因**：沿用 `{ok:false,reason:'unsupported-on-linux'}` 形态，禁止裸 `true`。
2. **纯通知型通道可以保持空实现**（`ON_*`、`*_CALLBACK`、`LOGGER_*`），但要在本文档 D 表里登记，避免下次审查重复发现。
3. **伪成功要清理**：`SYSTEM_GET_FILE`（返回 `code:0` 但没有数据）、`SYSTEM_SWITCH_SERVER_API`（返回 true 但没切域名）应改成显式失败或真正实现；`DOWNLOAD_UPDATE` 已经是正确示范。

### 9.1 `SAFE_STORAGE_ENCRYPT` 的四种返回（P0-3 落地后）

| 形态 | 触发条件 | 说明 |
|---|---|---|
| Electron 密文（base64） | `safeStorage` 且后端是 `gnome_libsecret` / `kwallet*` | 与官方行为一致 |
| `v2:iv:tag:ct` | 无可用 safeStorage，但 `secret-tool` 可用 | AES-256-GCM，主密钥存密钥环不落盘 |
| 空串 | 两者都没有 | **拒绝落盘**（显式失败），弹窗提示安装密钥环 |
| `v0:...` | 显式设置 `KOOK_INSECURE_STORE=1` | 明文，仅调试/救援用，带警告 |

`SAFE_STORAGE_DECRYPT` 向下兼容：Electron 密文、`v2:`、`v0:`、旧版裸 Base64（读到时若已有安全后端会**当场重加密回写**）。

### 9.2 形状契约（字段级对齐）

「通道注册了」和「返回形状对」是两件事。本轮确认的三处：

| 通道 | 问题 | 证据 | 状态 |
|---|---|---|---|
| `SYSTEM_GET_ACTIVE_DOMAIN` | 原返回 `{origin, api}`，官方读 `activeApiOrigin` / `activeH5Origin` / `activeFirstPartyOrigins` → 取到 `undefined`，一路回落 `config.appServer`，**域名切换从未真正生效** | `src/preload/runtime-domain.js:21`（`selection.activeApiOrigin \|\| config.appServer`） | 已修：返回官方形状，旧键保留兜底 |
| `SYSTEM_GET_FILE` | 返回 `{code:0,data:null}`：声称成功但无数据 | `patches/handlers.js` 原实现 | 已修：真实 `dialog.showOpenDialog`；**无窗口时返回 `code:-1`**，避免无头环境弹窗挂死 `sendSync` 调用方 |
| `SYSTEM_SWITCH_SERVER_API` | 恒 `return true`，从未切换 | 原实现 | 已修：白名单 + 写 `linux-store/domain.json` + 重启生效 |
| `SYSTEM_GET_UNIQUE_DETAIL` | 官方取 `{bios, machine, device_id}`，原实现只回 `{id, type:'linux'}` → 前两项 `undefined` | `webapp/build/static/js/2557.*.js`：构造请求头时取 `n.bios` / `n.machine` / `n.device_id` | **已实现 · 真机验证通过**（灰度默认关，见 9.2.1） |

结论：新增/修改通道时，**必须回读官方 preload 或 webapp 的实际取值方式**，不能只看通道名对不对。

#### 9.2.1 `GET_UNIQUE_DETAIL` 灰度开关

| 状态 | `SYSTEM_GET_UNIQUE` | `SYSTEM_GET_UNIQUE_DETAIL` |
|---|---|---|
| 默认（未设环境变量） | `machineId`（md5，线上行为） | `{id: machineId, type:'linux'}` |
| `KOOK_DEVICE_DETAIL_FULL=1` | `device-identity` 的 UUID | `{bios, machine, device_id}`，`device_id` 与上一列**同源同值** |

- 两条通道共用同一份进程内记忆化指纹，运行期间不会抖动；开启时打一行 `[device] 灰度开启…`（带三个值）便于对照日志。
- **开关不是幂等的**：开启后指纹从 `machineId` 变成 UUID，**关回去还会再变一次**，两个方向都可能被服务端判成新设备。真机验证应当「开着跑一轮并保持」，不要来回切。
- 默认值保证老用户指纹零漂移，这也是它默认关闭的原因。
- **真机验证（0.0.12 → 开发版，真实账号）**：开启灰度后 `device_id=d8da83cc-47e6-469d-aaa1-ad9b7cd14d94`、`bios=21d1589c…`、`machine=7953cf63…`，页面文本 5718 / 节点 2977，`api/v3/user/settings`、`guild/index`、`feature-gray/match` 全部 200，**无 401/403、无风控页、无需重登**。
- 验证结束后已把指纹**恢复原状**：关闭灰度时 `GET_UNIQUE` 回到 `0c68b3cf…`（与 0.0.12 安装版一致），避免两个版本来回切换时反复变更指纹。

### 9.3 注册唯一性（实现归属）

同一通道**只能有一处权威实现**。本轮差点踩到的坑：`SYSTEM_GET_HARDWARE_ACCELERATION` / `SYSTEM_SET_HARDWARE_ACCELERATION` 的权威实现在 `patches/main.js` 的 `installDesktopIntegration()`（有真实 `globalPref` 读写与 `needRestart` 语义），而 `patches/handlers.js` 里还留着一对同名空实现（`true` / `{}`）。靠 `installStubs()` 之后的 `removeHandler` + `handle` 覆盖来保证「后者胜」，**一旦注册顺序变动，空实现就会反盖真实实现**——表现正是「开关点了没反应」。

现在两条空实现已删除，并加了断言把「handlers 不得注册硬件加速通道」钉成不变量。通用规则：

1. 权威实现只写一处，其余位置若需要同名通道，必须显式注释说明「此处不注册，见 X」；
2. 依赖覆盖的通道要在本表标注归属文件，避免下次重构时被搬动；
3. 回归测试里对「权威实现存在且返回非空语义」断言，而不是只断言通道存在。

## 10. 上游兼容性检测（P2-7）

两个文件：

| 文件 | 作用 |
|---|---|
| `patches/upstream-baseline.json` | 基线快照（schema 2）：版本三元组、209 个通道名、43 个契约文件哈希、webapp 路径/内容双指纹、5 个关键契约文件 |
| `scripts/check-upstream.mjs` | 与基线比对并输出漂移报告；`--write-baseline` 重建基线 |

> 基线应当是**官方原始安装**（解包后的 `resources/app`）的快照，不要拿打过补丁的开发目录去生成——否则我们的改动会被当成上游基线，真实上游变化反而被掩盖。

用法：

```bash
# 官方升级后（指向新装的客户端目录，或 resources/app）
node scripts/check-upstream.mjs --app ~/kook-port/linux/app

# CI / 脚本里判定
node scripts/check-upstream.mjs --app <dir> --json ; echo $?   # 0=一致 1=漂移 2=读不了

# 处理完漂移后更新基线
node scripts/check-upstream.mjs --app <dir> --write-baseline
```

检测六个维度：

| 维度 | 说明 |
|---|---|
| 版本 | `version` / `buildVersion` / `config.commitId` 任一变化即报告 |
| 通道集合 | 新增（默认落 catch-all，需补实现）与删除（移植层再返回旧值即成死分支） |
| 移植层断链 | 🔴 `patches/*.js` 里仍在引用、但新版已删除的通道名 |
| 契约文件 | `src/preload/**`、`src/browser_native/preload/**`、`constants.js` 逐文件哈希 |
| **webapp 路径** | 文件集合指纹（`pathDigest`）：新增/删除/改名 |
| **webapp 内容** | 逐文件 `path\0size\0sha` 汇总指纹（`contentDigest`）：**文件名没变但内容被替换** |

**关键契约文件**按逻辑名单独登记，避免官方改文件名后对不上：

| 逻辑名 | 定位方式 | 关注的契约 |
|---|---|---|
| `webapp-entry` | 固定路径 | 前端入口 |
| `preload-runtime-domain` | 固定路径 | 域名切换返回形状（`activeApiOrigin` 等） |
| `preload-system` | 固定路径 | `GET_UNIQUE` / `GET_UNIQUE_DETAIL` 调用方式 |
| `device-feature-builder` | 内容特征 `x-client-username` | 设备指纹请求头拼装 |
| `device-detail-consumer` | 内容特征 `is_in_vm_by_cpu_id` | `bios` / `machine` / `device_id` 消费点 |

### 10.1 修复的漏检（旧实现的问题）

旧版 `webappHash = sha(文件路径列表.join('
'))` **只对路径做哈希**：官方替换了某个 chunk 的内容但文件名不变时（内容哈希通常也在文件名里，但内联小文件、`index.htm`、`assets/` 下的资源不会变名），完全检测不到。这正是「webapp 内容变化可能漏检」的根因。

现在 webapp 分成两个指纹，报告也分开：

- 路径变了 → 「webapp 文件增删 / 改名」
- 只有内容变 → 「🔴 webapp 内容变化（文件名没变）」，并提示对照本表复核通道形状

### 10.2 已验证的三种漂移

| 构造的场景 | 输出 | 退出码 |
|---|---|---|
| 同名 chunk 追加一行（内容变） | 🔴 webapp 内容变化 + 关键文件 `device-feature-builder` 内容变化 | 1 |
| 改 `src/preload/runtime-domain.js` | 关键契约文件漂移 → `preload-runtime-domain` 内容变化 | 1 |
| 把 chunk 改名 | webapp 路径漂移 + 关键文件「路径新增/路径消失」 | 1 |
| 未改动的原始客户端 | ✅ 与基线一致（209 通道 / 485 文件 / 30.0 MB） | 0 |

### 10.3 移植层自改文件的处理

有两个文件是我们**有意**与官方不同的，不能算上游漂移，否则每次扫开发目录都会一片红：

| 文件 | 我们改了什么 |
|---|---|
| `webapp/build/index.htm` | 去掉官方「启动资源重试门」，注入 `__KOOK_FORCE_WEB_RUNTIME__` 判定 |
| `src/preload/auto-launch.js` | 用 XDG autostart 替代注册表自启 |

处理方式：

- webapp 指纹**只对官方文件计算**（基线里是 484 个文件，不是 485），自改文件单独记哈希；
- 报告里给出「移植层补丁状态」：`已打 2/2`（说明这是一份打好补丁的构建）或 `本目录是官方原始目录`（说明适合对比上游）；部分缺失时用 🟠 报警「构建可能漏了补丁」；
- 因此 `~/kook-port/linux/app`（打过补丁）与官方原始目录**都会输出 ✅ 一致**，区别只在补丁状态那一行。

### 10.4 后续可接的两步（尚未做）

- GitHub Actions 在 `workflow_dispatch` 里跑本脚本，产出漂移报告 artifact；
- 启动自检：`patches/main.js` 启动时比对 `constants.js` 通道数与基线，不一致就告警（不阻塞启动）。

## 附录 · 209 条全量索引

| # | 通道 | 类别 |
|---:|---|---|
| 1 | `SYSTEM_GET_SYSTEM_VERSION` | A |
| 2 | `SYSTEM_GET_MICROPHONE_PERMISSION` | A |
| 3 | `SYSTEM_REQUEST_MICROPHONE_PERMISSION` | A |
| 4 | `GLOBAL_GET_GLOBAL` | D |
| 5 | `GLOBAL_ON_ROUTER_JUMP` | D |
| 6 | `SETTING_SET` | A |
| 7 | `SETTING_GET` | A |
| 8 | `STORE_GLOBAL_INIT` | A |
| 9 | `STORE_GLOBAL_SET` | A |
| 10 | `STORE_GLOBAL_GET` | A |
| 11 | `STORE_GLOBAL_REMOVE` | A |
| 12 | `STORE_USER_INIT` | A |
| 13 | `STORE_USER_SET` | A |
| 14 | `STORE_USER_GET` | A |
| 15 | `STORE_USER_REMOVE` | A |
| 16 | `STORE_IMPORTANT_GET` | A |
| 17 | `STORE_IMPORTANT_SET` | A |
| 18 | `STORE_IMPORTANT_REMOVE` | A |
| 19 | `STORE_SESSION_FLUSH` | A |
| 20 | `STORE_AUTH_BACKFILL_COOKIE` | D |
| 21 | `STORE_IS_AUTH_COOKIE_MISSING` | D |
| 22 | `LOGGER_OPEN_DIR` | A |
| 23 | `LOGGER_GET_ZIP_FILE` | D |
| 24 | `LOGGER_APP_LOG` | A |
| 25 | `LOGGER_UPDATE_COMMON_PARAMS` | D |
| 26 | `TASKLIST_CHANGE` | B |
| 27 | `PROCESS_TCP_ALIVE_DATA` | D |
| 28 | `TASKLIST_STATE_CHANGE` | B |
| 29 | `TASKLIST_OBS_SRT_MODE_CHANGE` | B |
| 30 | `TASKLIST_INFO_CHANGE` | B |
| 31 | `TASKLIST_QUERY_SIMPLE` | B |
| 32 | `TASKLIST_BOOSTER_CHANGE` | B |
| 33 | `TASKLIST_GET_GAME_CHANNEL_FILE_CONTENT` | B |
| 34 | `TASKLIST_GET_ALL_WINDOW_TITLE` | B |
| 35 | `CHECK_FULLSCREEN_START` | D |
| 36 | `CHECK_FULLSCREEN_STOP` | D |
| 37 | `CHECK_FULLSCREEN_CHANGE` | D |
| 38 | `SYSTEM_GET_PCNAME` | A |
| 39 | `SYSTEM_GET_HARDWARE_ACCELERATION` | A |
| 40 | `SYSTEM_SET_HARDWARE_ACCELERATION` | A |
| 41 | `SYSTEM_GET_ARGV` | A |
| 42 | `SYSTEM_RELAUNCH` | A |
| 43 | `SYSTEM_IS_RELAUNCH_UPDATE` | C |
| 44 | `SYSTEM_IS_RELAUNCH_PROACTIVE_UPDATE` | C |
| 45 | `SYSTEM_COPY_IMAGE` | A |
| 46 | `SYSTEM_SHOW_SAVE_DIALOG` | A |
| 47 | `SYSTEM_SHOW_OPEN_DIALOG` | A |
| 48 | `SYSTEM_GET_DXDIAGINFO` | C |
| 49 | `SYSTEM_GET_BLUETOOTH_DEVICE` | C |
| 50 | `SYSTEM_OPEN_PATH` | A |
| 51 | `SYSTEM_GET_UNIQUE` | A |
| 52 | `SYSTEM_GET_UNIQUE_DETAIL` | A |
| 53 | `SYSTEM_GET_FILE` | A |
| 54 | `SYSTEM_OPEN_EXTERNAL` | A |
| 55 | `SYSTEM_LOGOUT` | A |
| 56 | `SYSTEM_GET_PATH` | A |
| 57 | `SYSTEM_GET_DNS_SERVER` | A |
| 58 | `SYSTEM_GET_ACTIVE_DOMAIN` | A |
| 59 | `SYSTEM_WAIT_ACTIVE_DOMAIN` | A |
| 60 | `SYSTEM_SWITCH_SERVER_API` | A |
| 61 | `SYSTEM_CHECK_ADMIN` | C |
| 62 | `SYSTEM_SET_AUTH_COOKIE` | A |
| 63 | `SYSTEM_CHECK_ACCESS_FILE` | A |
| 64 | `SYSTEM_ON_SECOND_INSTANCE` | D |
| 65 | `GLOBAL_SHORTCUT_REGISTER` | A |
| 66 | `GLOBAL_SHORTCUT_UNREGISTER` | A |
| 67 | `GLOBAL_SHORTCUT_IS_REGISTER` | A |
| 68 | `GLOBAL_SHORTCUT_CALLBACK` | D |
| 69 | `VOLUME_SET_MIC_BOOST_BY_LABEL` | B |
| 70 | `VOLUME_GET_MIC_BOOST_BY_LABEL` | B |
| 71 | `VOLUME_SET_MIC_VOLUME_BY_LABEL` | B |
| 72 | `VOLUME_GET_MIC_VOLUME_BY_LABEL` | B |
| 73 | `VOLUME_SET_SPEAKER_VOLUME` | B |
| 74 | `VOLUME_SET_MIC_AGC_ALL` | D |
| 75 | `VOLUME_REFRESH_CHILDREN_PROCESS` | D |
| 76 | `VOLUME_REFRESH_DEVICE_LIST` | D |
| 77 | `WINDOW_CUT` | A |
| 78 | `WINDOW_COPY` | A |
| 79 | `WINDOW_PASTE` | A |
| 80 | `WINDOW_IS_VISIBLE` | A |
| 81 | `WINDOW_IS_FOCUSED` | A |
| 82 | `WINDOW_IS_MAX` | A |
| 83 | `WINDOW_IS_MIN` | A |
| 84 | `WINDOW_SET_ALWAYS_ON_TOP` | A |
| 85 | `WINDOW_MIN` | A |
| 86 | `WINDOW_MAX` | A |
| 87 | `WINDOW_UNMAX` | A |
| 88 | `WINDOW_RESTORE` | A |
| 89 | `WINDOW_SHOW` | A |
| 90 | `WINDOW_HIDE` | A |
| 91 | `WINDOW_FOCUS` | A |
| 92 | `WINDOW_CLOSE` | A |
| 93 | `WINDOW_MOVE_TOP` | A |
| 94 | `WINDOW_MOVE_TOP_FORCE` | A |
| 95 | `WINDOW_GET_SIZE` | A |
| 96 | `WINDOW_SET_SIZE` | A |
| 97 | `WINDOW_SET_TITLE` | A |
| 98 | `WINDOW_SET_POSITION` | A |
| 99 | `WINDOW_SET_SIZE_ORIGIN` | A |
| 100 | `WINDOW_SET_ZOOM_FACTOR` | A |
| 101 | `WINDOW_SET_ALWAY_ON_TOP` | D |
| 102 | `WINDOW_IS_ALWAY_ON_TOP` | A |
| 103 | `WINDOW_ON_MINIMIZE` | A |
| 104 | `WINDOW_ON_RESTORE` | A |
| 105 | `WINDOW_ON_MAXIMIZE` | A |
| 106 | `WINDOW_ON_UNMAXIMIZE` | A |
| 107 | `WINDOW_ON_RESIZE` | A |
| 108 | `WINDOW_ON_HIDE` | A |
| 109 | `WINDOW_ON_SHOW` | A |
| 110 | `WINDOW_ON_MOVE` | A |
| 111 | `COMMON_WIN_OPEN` | A |
| 112 | `COMMON_WIN_CLOSE` | A |
| 113 | `COMMON_WIN_RESET_POSITION` | D |
| 114 | `COMMON_WIN_ON_CLOSED` | D |
| 115 | `AUDIO_AI_PIPE` | C |
| 116 | `AUDIO_AI_ENABLE_AGC` | D |
| 117 | `AUDIO_AI_ENABLE_DENOISE` | D |
| 118 | `AUDIO_AI_GET_PROCESS_CPU_USAGE_BY_NAME` | D |
| 119 | `AUDIO_AI_ENABLE_RECORD` | D |
| 120 | `CREATE_MESSAGEPORT` | A |
| 121 | `CREATE_MESSAGEPORT_RESULT` | A |
| 122 | `OVERLAY_START_CREATE_WIN` | B |
| 123 | `OVERLAY_START_CLOSE_WIN` | B |
| 124 | `OVERLAY_WIDNOW_CREATE` | B |
| 125 | `OVERLAY_WIDNOW_CLOSE` | B |
| 126 | `OVERLAY_WIDNOW_DESTROY` | B |
| 127 | `OVERLAY_WINDOW_GET_BOUNDS` | B |
| 128 | `OVERLAY_WINDOW_SET_BOUNDS` | B |
| 129 | `OVERLAY_WINDOW_HIDE` | B |
| 130 | `OVERLAY_WINDOW_SHOW` | B |
| 131 | `OVERLAY_WINDOW_EXISTS_SYNC` | B |
| 132 | `OVERLAY_COUNTDOWN_PRECREATE` | B |
| 133 | `OVERLAY_COUNTDOWN_OPEN` | B |
| 134 | `OVERLAY_WINDOW_SET_MOVE_TOP_CHECK` | B |
| 135 | `ON_OVERLAY_WINDOW_CLOSE` | B |
| 136 | `ON_OVERLAY_WINDOW_MOUSE_ENTER` | B |
| 137 | `ON_OVERLAY_WINDOW_MOUSE_LEAVE` | B |
| 138 | `SCREEN_GET_DISPLAY_NEAREST_POINT` | A |
| 139 | `SCREEN_GET_ALL_DISPLAY` | A |
| 140 | `DOWNLOAD_GET_LIST` | D |
| 141 | `DOWNLOAD_DOWNLAOD` | D |
| 142 | `DOWNLOAD_UPDATE` | C |
| 143 | `DOWNLOAD_CANCEL` | D |
| 144 | `DOWNLOAD_ERROR` | D |
| 145 | `DOWNLOAD_OPEN_PATH` | D |
| 146 | `PC_INACTIVE_START` | D |
| 147 | `PC_INACTIVE_STOP` | D |
| 148 | `PC_INACTIVE_CHANGE` | D |
| 149 | `VOICEHOOK_setVolume` | C |
| 150 | `VOICEHOOK_GET_RUNING_MUSIC` | C |
| 151 | `VOICEHOOK_HOOK_PORT` | C |
| 152 | `VOICEHOOK_CALLBACK` | C |
| 153 | `VOICEHOOK_UNHOOK` | C |
| 154 | `SCREENSHOT_START` | D |
| 155 | `SCREENSHOT_FULL` | B |
| 156 | `SCREENSHOT_GET_DEFAULT_PATH` | B |
| 157 | `SCREENSHOT_ON_CONFIRM` | D |
| 158 | `SCREENSHOT_ON_SAVE` | D |
| 159 | `IO_HOOK` | B |
| 160 | `IO_HOOK_RESTART` | B |
| 161 | `VOICE_CALL_PANEL_INIT` | D |
| 162 | `VOICE_CALL_PANEL_ON_RECEIVE_INVITE` | D |
| 163 | `VOICE_CALL_PANEL_ON_RECEIVE_REMOVE_INVITE` | D |
| 164 | `VOICE_CALL_PANEL_DESTORY` | D |
| 165 | `PERFORMANCE_LOG_START` | D |
| 166 | `PERFORMANCE_LOG_RENDER` | D |
| 167 | `PROCESS_DOMAIN_TCP_ALIVE_CHANGE` | D |
| 168 | `ENTER_POWER_SAVING_MODE_1` | D |
| 169 | `ENTER_POWER_SAVING_MODE_2` | D |
| 170 | `CLEAR_RENDER_FRAME_CACHE` | D |
| 171 | `SEND_RENDER_WRITE_LOG` | D |
| 172 | `EXIT_POWER_SAVING_MODE` | D |
| 173 | `SCREEN_DIP_TO_SCREEN_RECT` | A |
| 174 | `SCREEN_DIP_TO_SCREEN_POINT` | A |
| 175 | `SCREEN_SCREEN_TO_DIP_POINT` | A |
| 176 | `SCREEN_GET_DISPLAY_MATCHING` | A |
| 177 | `SCREEN_GET_PRIMARY_DISPLAY` | A |
| 178 | `SCREEN_GET_CURSOR_SCREEN_POINT` | A |
| 179 | `SCREEN_ON_METRICS_CHANGED` | D |
| 180 | `SCREEN_SCREEN_TO_DIP_RECT` | A |
| 181 | `BOOSTER_SET_CONFIG` | D |
| 182 | `BOOSTER_IS_INSTALL` | C |
| 183 | `BOOSTER_IS_RUNING` | C |
| 184 | `BOOSTER_GET_INSTALL_STATE` | C |
| 185 | `BOOSTER_INSTALL` | C |
| 186 | `BOOSTER_START` | C |
| 187 | `BOOSTER_TEST_SPEED` | D |
| 188 | `BOOSTER_EVENTS` | D |
| 189 | `BOOSTER_DEFAULT_INSTALL_PATH` | D |
| 190 | `BOOSTER_GET_GAME_INFO` | D |
| 191 | `BOOSTER_STOP_DOWNLOAD` | D |
| 192 | `BOOSTER_DOWNLOAD` | C |
| 193 | `BOOSTER_CLEAN_CACHE` | D |
| 194 | `GGPLAY_START` | C |
| 195 | `GGPLAY_LAUNCH_GAME` | C |
| 196 | `GGPLAY_EXIT` | C |
| 197 | `GGPLAY_ON_CALLBACK` | C |
| 198 | `GGPLAY_ON_UPLOAD_SUCCESS` | C |
| 199 | `GGPLAY_UPLOAD_ARCHIVE` | C |
| 200 | `GGPLAY_IS_GAME_RUNNING` | C |
| 201 | `__GGPLAY_CALL` | C |
| 202 | `REGEDIT_GET` | D |
| 203 | `REGEDIT_SET` | D |
| 204 | `REGEDIT_DELETE` | D |
| 205 | `SAFE_STORAGE_ENCRYPT` | A |
| 206 | `SAFE_STORAGE_DECRYPT` | A |
| 207 | `STORE_GLOBAL_GET_ALL` | A |
| 208 | `GAME_OVERLAY_CREATE_WIN` | C |
| 209 | `GAME_OVERLAY_CLOSE_WIN` | C |

---

维护约定：新增/修改通道时同步更新本表与 `patches/upstream-baseline.json`；`check-upstream.mjs` 报漂移而本表未更新，视为文档过期。
