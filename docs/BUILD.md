# 构建说明

本文写给要自己编译 / 打包的人。仓库里不含官方客户端的任何文件，
所有官方资源都在构建时从你本机已安装的 KOOK 客户端里取。

## 1. 前置条件

| 需要 | 说明 |
|---|---|
| Node.js ≥ 18 | 跑脚本和打包工具 |
| 官方 KOOK 客户端 | 已解包成 app 目录（含 `src/`、`webapp/`、`node_modules/`） |
| Electron 36.7.4 | 解包后的 `electron/dist` 目录 |
| rsync | `stage.sh` 用来复制基础文件 |

两处路径用环境变量指定：

```bash
export KOOK_BASE_APP=/path/to/kook/app        # 默认 ~/kook-port/linux/app
export ELECTRON_SRC=/path/to/electron/dist    # 默认 ~/kook-port/e36/node_modules/electron/dist
```

## 2. 装打包工具

```bash
npm install        # 只装 electron-builder，不会去装客户端的依赖
```

打包 rpm 需要 `rpmbuild`：

- Debian / Ubuntu：`sudo apt install rpm`
- Fedora / RHEL：`sudo dnf install rpm-build`
- Arch / CachyOS：没有 root 就用 `bash scripts/fetch-rpm-tools.sh`，
  它会把 rpm-tools 和对应 ABI 的 nettle 下到 `~/.local/rpm-tools`，不动系统

## 3. 一次性准备

```bash
bash scripts/prepare-electron.sh   # 生成 .electron-dist（把 modules 软链解引用成真实目录）
bash scripts/stage.sh              # 组装 .stage/app（官方基础文件 + patches/ 里的补丁）
```

`prepare-electron.sh` 这一步不能省。开发机上 `electron/dist/modules` 往往是个
软链，指向 Steam 里的官方客户端目录；原样打包出去，别人机器上没有那个路径，
客户端加载原生模块会直接失败。

## 4. 出包

```bash
bash scripts/build.sh              # AppImage + deb + rpm
bash scripts/build.sh AppImage deb # 只出指定格式
bash scripts/build-rpm.sh          # 单独用 rpmbuild 出 rpm（不走 fpm）
```

产物在 `dist/`：

| 格式 | 文件名 |
|---|---|
| AppImage | `KOOK-<version>-x86_64.AppImage` |
| deb | `kook_<version>_amd64.deb` |
| rpm | `kook-linux-<version>.x86_64.rpm` |

`build-rpm.sh` 依赖 `dist/linux-unpacked`，所以要先跑过一次 `build.sh`。

## 5. 几个刻意的选择

**`asar: false`**
客户端的 `webapp/` 需要本地 HTTP 服务器从磁盘读取，`portal-screencast.py` 也要
真实文件路径才能 spawn。打进 asar 这些都会失效，所以整个应用保持散文件。

**`npmRebuild: false`**
官方 `node_modules` 里是一堆预编译好的原生模块，重装/重编只会把能用的版本换坏。

**不用 fpm 打 rpm**
electron-builder 内部用 fpm，它生成的 spec 在 rpm 6.x 上跑不通，而且错误被吞掉
看不见。`scripts/build-rpm.sh` 自己写 spec，依赖和路径都写在 `build/kook.spec.in`。

**依赖手写而不是自动扫描**
Electron 自带一批私有 `.so`，自动扫描既慢又容易误报，所以 spec 里是
`AutoReqProv: no` + 显式 `Requires:`。

## 6. 改版本号

改两处，保持一致：

- `package.json` 的 `version`（打包用）
- `patches/main.js`、`patches/preload-shim.js` 里的 `PORT_VERSION`（界面显示用）

更新记录在 `patches/preload-shim.js` 的 `PORT_LOGS` 数组最前面加一项，
旧版本记录不要删。
