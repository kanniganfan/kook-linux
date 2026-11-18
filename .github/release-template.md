<div align="center">

# KOOK Linux 移植版 vX.Y.Z

**一句话概括这一版最重要的变化**

</div>

> 基于官方 Windows PC 客户端 `<官方版本>`（构建 `<构建号>`）移植
> 社区作品，与 KOOK 官方无关 · 官方从未发布 Linux 版

---

## 这一版做了什么

用两三句话讲清楚「为什么要发这一版」：如果是修 bug，说清楚现象和根因；
如果是新功能，说清楚它解决什么问题。不要罗列提交记录。

| 现象 | 真实原因 |
|---|---|
| 用户看到的问题 | 代码里的根因 |

## 新功能

- **功能名**
  一两句说明它怎么用、有什么限制

## 修复

- **问题描述**
  根因 + 修法，必要时贴关键日志

## 打包

- 影响安装包的改动（元信息、依赖、启动器逻辑等）

## 下载

| 格式 | 文件 | 大小 |
|---|---|---|
| AppImage | `KOOK-X.Y.Z-x86_64.AppImage` | xxx MiB |
| deb | `kook_X.Y.Z_amd64.deb` | xxx MiB |
| rpm | `kook-linux-X.Y.Z.x86_64.rpm` | xxx MiB |

<details>
<summary><b>SHA-256 校验</b></summary>

```
<sha256>  KOOK-X.Y.Z-x86_64.AppImage
<sha256>  kook_X.Y.Z_amd64.deb
<sha256>  kook-linux-X.Y.Z.x86_64.rpm
```

生成方式：`sha256sum dist/*`

</details>

## 安装

```bash
# AppImage —— 任何 glibc 发行版
chmod +x KOOK-X.Y.Z-x86_64.AppImage
./KOOK-X.Y.Z-x86_64.AppImage

# Debian / Ubuntu / Deepin / UOS
sudo dpkg -i kook_X.Y.Z_amd64.deb && sudo apt -f install

# Fedora / RHEL / openSUSE
sudo rpm -i kook-linux-X.Y.Z.x86_64.rpm
```

AppImage 不需要手加 `--no-sandbox` 之类的参数，启动器会自己判断会话环境。

## 已知限制

- 与上一版相同则写「无新增限制」，有变化才重列

## 从旧版本升级

说明是否需要先卸载、配置会不会丢、能否直接覆盖。

## 了解更多

- 功能清单与环境要求：[README](https://github.com/kanniganfan/kook-linux#readme)
- 完整提交记录：[vA.B.C...vX.Y.Z](https://github.com/kanniganfan/kook-linux/compare/vA.B.C...vX.Y.Z)
- 问题反馈：[Issues](https://github.com/kanniganfan/kook-linux/issues) 或 <cylqm@qq.com>

<!--
写 Release 时的硬性要求：
1. 正文里不得出现裸的 @KANNI#0001 —— GitHub 会解析成对 kanni 账号的提及，
   Release 页的 Contributors 就会冒出别人。要写就写「KANNI（KOOK 昵称 KANNI#0001）」。
2. SHA-256 必须与本次上传的附件一致，上传完用 sha256sum 重新核一遍。
3. 文件名、版本号、大小三处必须和实际附件对得上。
4. 不要忘记说明是否需要卸载旧版。
-->
