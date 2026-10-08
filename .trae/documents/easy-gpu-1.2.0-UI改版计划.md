# Easy GPU 1.2.0 UI 改版计划

## 概要

将 easy-gpu 从 1.1.0 升级到 1.2.0，核心为 webview UI 结构改版：

1. **双视图结构**：默认「胶囊页」（极简背景 + 灵动岛式悬浮胶囊）+「窗口页」（现有 GPU/CPU/内存监控详情，仅重构视觉与布局）。
2. **状态栏改为悬浮胶囊**：短胶囊 ⇄ 长胶囊点击切换；长胶囊最后一个「窗口」图标进入窗口页。
3. **视觉**：极简科技、iOS 原生感、高对比度、强调色、专业冷静、干净无冗余、高度结构化。
4. **强调色**：iOS 系统色，共 **7 种**可切换（默认系统蓝）。
5. **设置精简为 3 项**：刷新间隔 / 颜色风格（7 色）/ 合并进程。

**交付节奏（重要）**：先出自包含 UI 原型给用户过目 → 用户确认后再改完整代码并本地打包 vsix。**全程不做任何 git 提交/推送，不上传 GitHub。**

## 现状分析（1.1.0）

- 架构：VS Code 扩展，`src/` 为 tsc 编译的 TypeScript（无 bundler），webview UI 全部在 `media/main.css`（613 行）+ `media/main.js`（656 行 IIFE），HTML 骨架由 [panel.ts](file:///workspace/src/panel.ts#L83-L127) 的 `buildHtml()` 生成：`.wrap > header.topbar（brand + actions：status-pill/countdown/刷新/切换服务器/设置） + div#banner + main#content + footer#footer`。
- 消息协议（保持不变）：webview → 扩展 `ready | refresh | selectHost | openSettings`（[panel.ts L45-L64](file:///workspace/src/panel.ts#L45-L64)）；扩展 → webview `state { state: MonitorState, config: WebviewConfig }`（[panel.ts L71-L81](file:///workspace/src/panel.ts#L71-L81)）。
- 状态显示现有两处：webview 顶栏 `.status-pill`（[main.css L141-L180](file:///workspace/media/main.css#L141-L180)）与 VS Code 原生状态栏项 [statusbar.ts](file:///workspace/src/statusbar.ts)（原生样式，**技术上无法做成胶囊**）。
- 设置现有 3 项：`refreshInterval` / `mergeProcesses` / `showStatusBar`（[config.ts](file:///workspace/src/config.ts)、[settingsUi.ts](file:///workspace/src/settingsUi.ts)、[package.json L63-L84](file:///workspace/package.json#L63-L84)）。
- 浏览器 mock 预览机制：[dev/preview.html](file:///workspace/dev/preview.html) 复制 panel.ts 同一套 DOM，`dev/mock-data.js` 伪造 `state` 消息（4×RTX 3090 数据），`?theme=dark`、`?merge=1` 参数。
- 构建/打包：`npm run compile`（tsc → out/）、`npm run package`（vsce），当前版本 1.1.0。

## 目标 UI 设计规范（原型与实现共同依据）

### 1. 悬浮胶囊（灵动岛，取代状态栏）

- **位置**：webview 顶部居中、`position: fixed` 悬浮覆盖内容之上；两视图中均常驻。
- **外观**：全圆角胶囊、毛玻璃高架底（深色近黑 `#1C1C1E` 系 + 细亮边框；浅色纯白 + 强投影）、高对比、离散状态点用语义色（ok/warn/err，connecting 呼吸动画）。
- **短胶囊（初始态，高约 34px）**：状态点 + 显存合计 `72.0/96.0G`；无 GPU/未连接/出错时显示状态文案（未连接 / 连接中… / 连接失败）。
- **点击展开长胶囊**：宽度/高度弹性过渡（iOS spring 缓动），内容为：
  - 概览行：主机名 + `GPU×4 显存 72.0/96.0G · 89°C | CPU 62% | RAM 94.6/126G`（复用现 `formatSummary` 语义）+ 刷新倒计时；
  - 图标行（从左到右）：切换服务器、立即刷新、设置、**窗口**。
- **交互规则**：点击胶囊非图标区域 = 长/短切换（再次点击恢复短胶囊）；点击图标 = 执行动作且**不触发折叠**；最后一个「窗口」图标 = 进入窗口页（在窗口页内点击则返回胶囊页，作为视图切换开关）。
- **状态联动**：error 时胶囊状态点变红、短胶囊显示「连接失败」；错误详情 banner 仍显示在窗口页内。

### 2. 胶囊页（webview 默认视图）

- 极简背景：纯净底色 + 极淡光晕/网格装饰（可选，不喧宾夺主），胶囊居中偏上；页面底部极小字标 `Easy GPU`。无任何冗余控件。

### 3. 窗口页（现有监控详情，视觉重构）

内容功能不变（GPU 卡片、gpustat 风格进程列表、mergeProcesses 合并、+N 折叠、CPU 历史曲线 canvas、内存行、倒计时、页脚诊断），布局与视觉改为 iOS 风格结构化区块：

- **头部区**：主机名大标题 + 连接状态徽标 + 小字诊断（通道 内置客户端/系统 ssh、耗时 X.XXs）；顶部留出胶囊悬浮的避让空间。
- **GPU 区**：每 GPU 一个结构化块——`GPU 0 · RTX 3090` 名称行、TEMP/UTIL 标签化等宽数值（仅异常用语义色）、显存大号等宽数字 + 细进度条（强调色）、进程列表（用户名 + 显存，`wzs 6876M ǀ lj 814M` 语义保留）。
- **系统区**：CPU 行（数值 + 历史曲线）与内存行（已用/总量 + 缓存/可用 + 细进度条）。
- **页脚**：数据时间 + 刷新耗时。
- **风格**：无重卡片描边，用高架底色块 + 发丝分隔线 + 大留白分组（iOS inset-grouped 感）；数字全部等宽 tabular-nums；小标签大写、字距拉开；整体高对比。

### 4. 颜色系统（7 种强调色）

每色给浅/深主题两套高对比值，写入 CSS 变量 `--accent` / `--accent-soft`：

| 风格 | 浅色 | 深色 |
|---|---|---|
| 蓝（默认） | `#007AFF` | `#0A84FF` |
| 青 | `#32ADE6` | `#64D2FF` |
| 绿 | `#34C759` | `#30D158` |
| 紫 | `#AF52DE` | `#BF5AF2` |
| 粉 | `#FF2D55` | `#FF375F` |
| 橙 | `#FF9500` | `#FF9F0A` |
| 红 | `#FF3B30` | `#FF453A` |

- 语义色 ok/warn/err 仅用于状态/异常，不作装饰。
- 设置项 `easy-gpu.accentColor`：enum `blue|cyan|green|purple|pink|orange|red`，默认 `blue`；经 `WebviewConfig` 下发，webview 启动/变更时覆盖 `--accent`、`--accent-soft`。

### 5. 设置（极简 3 项）

刷新间隔 / 颜色风格（7 色选择）/ 合并进程。**移除 `showStatusBar`**（原生状态栏项已被胶囊取代）。

## 阶段 A：UI 原型（先做，等待用户确认）

新建 **`dev/ui-1.2.0.html`**（自包含单文件，内联 CSS/JS + mock 数据；不动 `media/` 与现有 1.1.0 预览）：

- 完整实现：短/长胶囊（含展开收起动画与全部交互规则）、胶囊页、窗口页全部区块（4×RTX 3090、多用户进程、CPU 曲线、内存、倒计时、异常值着色）。
- 演示能力：页面内 7 色切换器（也支持 `?color=`）、`?theme=dark|light` 主题、`?view=capsule|window` 初始视图。
- 预览交付：`python3 -m http.server 8090` 起本地服务，用 OpenPreview 给出可点击预览链接；并截取关键态截图（浅/深主题 × 短/长胶囊 × 窗口页）。
- **Gate：用户确认 UI 后才进入阶段 B。**

## 阶段 B：完整实现（用户确认后执行）

| 文件 | 改动 | 说明 |
|---|---|---|
| `media/main.css` | 重写设计系统 | 新变量（7 色 accent 映射、高对比中性色、语义色）、胶囊短/长态样式与过渡、胶囊页、窗口页结构化区块、深浅主题覆盖；删除旧 topbar/status-pill 样式 |
| `media/main.js` | 双视图渲染 + 胶囊交互 | 保留全部数据渲染逻辑（GPU 卡片缓存更新、阈值着色、mergeProcesses、+N 折叠、CPU 90 样本曲线、倒计时），改为新 DOM 结构渲染；新增胶囊短/长切换、视图切换（窗口图标）、accent 应用；消息协议不变 |
| `src/panel.ts` | `buildHtml()` 骨架替换 | 顶层改为 `胶囊（fixed）+ #view-capsule + #view-window` 双视图容器（与 `dev/ui-1.2.0.html` 结构一致）；消息分支不变 |
| `src/types.ts` | `WebviewConfig` 增加 `accentColor` | 类型收窄为 7 值联合 |
| `src/config.ts` | 增 `accentColor()`、删 `showStatusBar()` | 集中读取出口同步 |
| `src/settingsUi.ts` | 设置改 3 项 | 刷新间隔 / 颜色风格（QuickPick 7 色，含中文名）/ 合并进程 |
| `src/extension.ts` | 移除状态栏集成 | 删除 `syncStatusBar`、`StatusBar` 组装与 `showStatusBar` 相关代码 |
| `src/statusbar.ts` | **删除文件** | 状态栏功能由胶囊取代（决策见下） |
| `package.json` | 版本 1.2.0 + 配置项 | `version: "1.2.0"`；配置改为 `refreshInterval` / `mergeProcesses` / `accentColor`（enum 7 值）；删除 `showStatusBar` |
| `dev/preview.html` + `dev/mock-data.js` | 同步新骨架 | 与 panel.ts DOM 一致，支持 `?view=` / `?color=`，用于回归预览 |
| `README.md` | 1.2.0 文档同步 | 版本徽章/下载链接改 1.2.0；功能节改写（悬浮胶囊、双视图、7 色风格）；设置说明改 3 项；删除「状态栏常驻概览」表述 |

## 阶段 C：验证与交付

1. `npm run compile` 通过（strict 模式无错误）。
2. `dev/preview.html` 浏览器回归：双视图切换、胶囊短/长交互、7 色、`?theme=dark`、`?merge=1`、倒计时与 CPU 曲线正常。
3. `npm run package` 生成 `easy-gpu-1.2.0.vsix`（仅本地产物）。
4. **不执行任何 git commit / push，不上传 GitHub**，等用户确认后再处理。

## 假设与决策

1. **胶囊实现于 webview 内**：VS Code 原生状态栏项无法定制为胶囊样式；据此**移除 `src/statusbar.ts` 与 `showStatusBar` 设置**，与「设置仅 3 项」的要求一致。
2. **「窗口」图标为视图切换开关**：胶囊页 → 窗口页；窗口页内点击 → 返回胶囊页（用户仅指定"打开窗口页面"，返回交互取对称方案）。
3. **短胶囊主指标为显存合计**（`72.0/96.0G`）：延续 1.1.0「显存优先」定位；未连接/出错/无 GPU 时退化为状态文案。
4. **消息协议、数据链路不变**（`ready/refresh/selectHost/openSettings` ↔ `state`；service/collector/ssh 层零改动），本次纯 UI/设置层改版。
5. **阶段 A 原型为自包含文件**（`dev/ui-1.2.0.html`），不复用 `media/main.css`，避免影响现有 1.1.0 预览；确认后才把设计移植进 `media/`。

## 验证步骤（对应阶段 A/B/C）

- 阶段 A：本地 http 服务 + OpenPreview 打开 `dev/ui-1.2.0.html`，逐项检查交互（胶囊展开/收起/图标不误触折叠/窗口图标切视图/7 色/深浅主题），截图给用户确认。
- 阶段 B：`npm run compile`；`dev/preview.html` 回归上述交互 + mock 数据渲染正确。
- 阶段 C：`npm run package` 出 1.2.0 vsix；确认仓库无 git 变更推送动作。
