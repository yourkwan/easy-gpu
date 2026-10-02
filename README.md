# Easy GPU

> 在 TraeCode / VS Code 中查看远程 SSH 服务器的 GPU、CPU 与内存状态 —— gpustat 风格面板，带逐进程显存占用统计。

![version](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![platform](https://img.shields.io/badge/platform-TraeCode%20%7C%20VS%20Code-7c3aed)

![面板概览](docs/screenshot-overview.png)

## 功能

- **显存优先**：每张 GPU 的显存以橙色大号数值 + 粗进度条突出显示，型号、温度、利用率作为辅助信息，温度/利用率按阈值自动变色
- **逐进程显存占用**：gpustat 风格 `wzs(6876M) lj(814M)`，每个进程单独一条、不按用户合并；同一账号多个任务一目了然
- **CPU 与内存**：CPU 实时占用 + 历史曲线；内存已用/总量橙色高亮（`94.9 GB / 126 GB`），附缓存与可用容量
- **状态栏常驻概览**：`GPU×4 显存 72.0/96.0G · 89°C | CPU 62% | RAM 94.6/126G`，点击直达面板
- **自动刷新**：默认每 5 秒，可配置；面板带刷新倒计时与手动刷新按钮
- **四种登录方式**：自动（密钥优先，失败转密码）/ 密码 / 私钥文件（任意路径，含加密私钥口令）/ `~/.ssh` 密钥与 ssh-agent；密码与私钥口令保存在系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux 密钥环）

![GPU 显存与用户 / CPU 与内存](docs/screenshot-details.png)

## 安装

### TraeCode / VS Code（导入 VSIX）

1. 下载仓库中的 [easy-gpu-1.0.0.vsix](easy-gpu-1.0.0.vsix)
2. 打开扩展面板（`Ctrl+Shift+X` / `Cmd+Shift+X`），点击右上角 `···` → **从 VSIX 安装…**
   （也可在命令面板执行 `Extensions: Install from VSIX...`）
3. 重新加载窗口，左下角出现 `Easy GPU · 未配置服务器`

### 从源码构建

```bash
npm install
npm run package   # 生成 easy-gpu-1.0.0.vsix
```

## 使用

1. 点击状态栏 `Easy GPU`，或执行命令 `Easy GPU: 选择 SSH 服务器`
2. 从 `~/.ssh/config` 的别名中选择服务器（也支持手动输入 `user@host`；非 22 端口可用 `user@host:2222`）
3. 面板自动刷新，实时显示 GPU / CPU / 内存状态

> 服务器需要密码时：密钥 / ssh-agent 不通会自动弹出密码输入框，输入一次即保存到系统钥匙串。
> 用私钥文件登录：执行 `Easy GPU: 选择私钥文件（登录方式）` 选中文件即可（加密私钥会提示口令）。

| 命令 | 说明 |
| --- | --- |
| `Easy GPU: 打开监控面板` | 打开可视化仪表盘 |
| `Easy GPU: 选择 SSH 服务器` | 从 `~/.ssh/config` 中挑选或手动输入主机 |
| `Easy GPU: 立即刷新` | 立即采集一次数据（会重新弹出密码框） |
| `Easy GPU: 设置 SSH 密码` | 为某台服务器预先保存密码到系统钥匙串 |
| `Easy GPU: 选择私钥文件（登录方式）` | 文件对话框选择私钥（`.ppk` 会提示先转格式） |
| `Easy GPU: 清除已保存的密码 / 私钥口令` | 删除已保存的凭据并断开连接 |

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `easy-gpu.host` | 空 | SSH 主机，可为 `~/.ssh/config` 别名或 `user@host` |
| `easy-gpu.refreshInterval` | `5` | 自动刷新间隔（秒），范围 2–600 |
| `easy-gpu.connectionMode` | `auto` | `auto`：系统 ssh 优先、认证失败回退密码登录；`systemSsh`：仅免密；`builtin`：内置客户端（密码 / 私钥 / agent） |
| `easy-gpu.privateKeyPath` | 空 | 指定私钥文件路径（支持 `~`）；留空则用 `~/.ssh/config` 的 `IdentityFile` 与 `~/.ssh/id_*` |
| `easy-gpu.rememberPassword` | `true` | 密码 / 私钥口令保存到系统钥匙串 |
| `easy-gpu.sshExtraArgs` | `[]` | 传给系统 `ssh` 的额外参数，如 `["-p", "2222"]` |
| `easy-gpu.showStatusBar` | `true` | 是否在状态栏显示概览 |

## 工作原理

扩展把 [`scripts/collect.sh`](scripts/collect.sh) 经 stdin 交给远程 `bash -s` 执行，采集完成后输出带标记的 JSON，由扩展解析渲染。脚本投递方式有两种，由 `easy-gpu.connectionMode` 决定：

- **系统 ssh**（默认优先）：调用本机 `ssh`，完整复用 `~/.ssh/config`（含 ProxyJump、Include 等写法）、密钥与 ssh-agent；若设置了 `easy-gpu.privateKeyPath` 会自动附加 `-i <私钥>`
- **内置客户端**：基于 [ssh2](https://github.com/mscdex/ssh2) 实现 SSH 协议，支持密码、私钥文件（含加密私钥口令）、ssh-agent 与 keyboard-interactive 认证；首次连接记录主机密钥指纹（TOFU），密钥变化时弹窗确认；PuTTY 的 `.ppk` 会被识别并提示转换；连接可复用，刷新时无需重新握手

采集内容（两种方式一致）：

- GPU：`nvidia-smi --query-gpu`（型号/温度/利用率/显存）与 `--query-compute-apps`（进程显存），再用 `ps` 把 PID 映射到用户名
- CPU：两次采样 `/proc/stat` 计算实时占用；内存：`/proc/meminfo`

远程仅需 `bash` 与 coreutils（`awk`/`ps`），GPU 部分依赖 `nvidia-smi`（随 NVIDIA 驱动提供），无需 `jq`、Python 等额外依赖。

## 常见问题

| # | 问题 |
| --- | --- |
| 1 | [怎么用密码登录？](#1-怎么用密码登录) |
| 2 | [怎么用私钥文件登录？](#2-怎么用私钥文件登录) |
| 3 | [私钥有口令（passphrase）怎么办？](#3-私钥有口令passphrase怎么办) |
| 4 | [提示「SSH 认证失败」怎么办？](#4-提示ssh-认证失败怎么办) |
| 5 | [忘记已保存的密码 / 想换密码怎么办？](#5-忘记已保存的密码--想换密码怎么办) |
| 6 | [密码存在哪里，安全吗？](#6-密码存在哪里安全吗) |
| 7 | [提示「主机密钥与已记录的不一致」怎么办？](#7-提示主机密钥与已记录的不一致怎么办) |
| 8 | [为什么清除了密码 / 卸载了扩展还能自动连接？](#8-为什么清除了密码--卸载了扩展还能自动连接) |
| 9 | [怎么彻底清理已保存的配置与凭据？](#9-怎么彻底清理已保存的配置与凭据) |
| 10 | [未检测到 nvidia-smi 怎么办？](#10-未检测到-nvidia-smi-怎么办) |
| 11 | [想监控 TraeCode Remote-SSH 当前连接的服务器怎么办？](#11-想监控-traecode-remote-ssh-当前连接的服务器怎么办) |
| 12 | [为什么设了 5 秒刷新，实际每次都更久？](#12-为什么设了-5-秒刷新实际每次都更久) |

### 1. 怎么用密码登录？
默认不用任何配置：密钥 / ssh-agent 连不上时会自动弹出密码输入框，输入一次即保存到系统钥匙串，之后自动连接。也可以提前设置：命令面板执行 `Easy GPU: 设置 SSH 密码`。

### 2. 怎么用私钥文件登录？
两种方式任选：

1. 命令面板执行 `Easy GPU: 选择私钥文件（登录方式）`，在文件对话框里选中私钥（例如桌面上的 `密钥`），会自动写入设置 `easy-gpu.privateKeyPath`
2. 或写进 `~/.ssh/config` 的 `IdentityFile`，两种连接方式都会读取

注意：PuTTY 的 `.ppk` 文件无法直接使用，需先用 **PuTTYgen → Conversions → Export OpenSSH key** 转成 OpenSSH 格式（扩展检测到 `.ppk` 会给出这个提示）。

### 3. 私钥有口令（passphrase）怎么办？
检测到加密私钥会自动弹框输入口令，输入一次保存到系统钥匙串；口令失效会清除并重新询问。不想保存就把 `easy-gpu.rememberPassword` 设为 `false`。

### 4. 提示「SSH 认证失败」怎么办？
- 默认的 `auto` 模式会先试系统 ssh（密钥 / agent），失败后自动改用密码登录；如果你取消过密码输入，点击面板上的「立即重试」可再次弹出
- 想彻底免密：在终端执行 `ssh-copy-id your-server`（或把私钥加入 ssh-agent），确认 `ssh your-server 'echo ok'` 无需密码

### 5. 忘记已保存的密码 / 想换密码怎么办？
执行 `Easy GPU: 清除已保存的密码 / 私钥口令` 后重新连接；或再次执行 `Easy GPU: 设置 SSH 密码` 覆盖。

### 6. 密码存在哪里，安全吗？
存储在 VS Code 的 SecretStorage（macOS Keychain / Windows 凭据管理器 / Linux libsecret），不会写入 `settings.json`；卸载扩展或执行「清除已保存的密码」即删除。若不想保存，把 `easy-gpu.rememberPassword` 设为 `false`（密码只在本次输入中使用）。

### 7. 提示「主机密钥与已记录的不一致」怎么办？
内置客户端首次连接会记住服务器指纹；服务器重装或更换过密钥时会弹窗，确认后才继续连接（防止中间人攻击）。

### 8. 为什么清除了密码 / 卸载了扩展还能自动连接？
- 「选择私钥文件」这类**私钥登录本来就不需要保存密码**：扩展直接读磁盘上的私钥文件（`easy-gpu.privateKeyPath`、`~/.ssh/config` 的 `IdentityFile`、或 `~/.ssh/id_*` 默认密钥），或使用 ssh-agent 里已加载的密钥。要停用请清空 `easy-gpu.privateKeyPath`、移走密钥文件，或禁用扩展
- `清除已保存的密码 / 私钥口令` 只删除系统钥匙串里的密码与口令，**不会**改动设置项
- **卸载扩展不会删除** `settings.json` 里的 `easy-gpu.*` 配置（VS Code 通用行为），且卸载后需要重新加载窗口才真正停止运行

### 9. 怎么彻底清理已保存的配置与凭据？
1. 卸载**前**先执行 `Easy GPU: 清除已保存的密码 / 私钥口令`（卸载后就执行不了这个命令了）
2. 卸载扩展 → 命令面板执行 `Developer: Reload Window`
3. `Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)`，删除 `easy-gpu.*` 相关行（尤其 `easy-gpu.privateKeyPath`、`easy-gpu.host`）

### 10. 未检测到 nvidia-smi 怎么办？
服务器没有 NVIDIA 驱动，或当前账号无执行权限（容器内还需映射 GPU）；CPU 与内存监控不受影响。

### 11. 想监控 TraeCode Remote-SSH 当前连接的服务器怎么办？
在 `~/.ssh/config` 中找到对应别名并选择即可；若使用 `user@host` 直连，手动输入同一地址。

### 12. 为什么设了 5 秒刷新，实际每次都更久？
5 秒是**间隔**不是**超时**：如果一次刷新本身耗时超过 5 秒，下一次会等它结束后才触发（同一时间只跑一个刷新），所以实际节奏 = 单次耗时 + 5 秒。单次耗时来自两部分：

- **SSH 连接**：类 Unix 的系统 ssh 会复用连接（`ControlMaster`，很快）；**Windows 自带 OpenSSH 不支持连接复用，每次刷新都要重新握手**（局域网 1–3 秒，跨公网更久）；内置客户端则复用长连接，只有脚本执行时间
- **远程采集脚本**：CPU 采样固定 0.4 秒 + 2 次 `nvidia-smi`（GPU 繁忙或驱动异常时单次可达数秒）

诊断方法：**面板底部**会显示「实际通道 + 上次刷新耗时」（如 `内置客户端 · 上次刷新 0.9s`），状态栏悬停也能看到。若显示走的是系统 ssh 且耗时高，把 `easy-gpu.connectionMode` 设为 `builtin` 即可复用连接；也可以把 `easy-gpu.refreshInterval` 调大（如 10–15 秒）。

## 开发

```bash
npm install          # 安装依赖
npm run compile      # 编译 TypeScript
npm run watch        # 监听编译
node dev/test-collect.mjs      # 采集脚本 + ssh config 解析 + 系统 ssh 链路自测（含假 GPU 数据）
node dev/test-builtin-ssh.mjs  # 内置 SSH 客户端端到端测试（本地模拟 SSH 服务器：密码、主机密钥、连接复用）
python3 -m http.server 8090    # 浏览器预览面板（mock 数据）：dev/preview.html
```

## License

[MIT](LICENSE)