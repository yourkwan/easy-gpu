# Easy GPU 1.3.0 架构重构计划：侧边栏监控页 + 原生状态栏

## 概要

按用户 7 点要求重设 UI 架构（版本 1.2.0 → 1.3.0）：

1. **去掉悬浮胶囊**（灵动岛、胶囊页整体删除），**窗口页变成侧边栏页面**：监控功能（GPU 卡片 / 进程显存 / CPU 曲线 / 内存 / 倒计时）全部移入侧边栏 webview 视图；**编辑器大面板完全移除**（已确认）。
2. **新增原生状态栏**：`● 显存合计`（如 `● 72.0/96.0G`），状态点按连接状态变色；点击展开侧边栏；悬停 tooltip 显示全量摘要（已确认）。
3. **风格**（借鉴用户 iOS 小组件截图）：极简科技、iOS 原生感、高对比度、强调色、专业冷静、干净无冗余、高度结构化 —— 深色圆角卡片、大号等宽数字、细进度条、小号大写标签、微型时间戳。
4. **设置极简 3 项**：刷新间隔 / 颜色风格 / 更多设置；**合并进程改为侧边栏页面上的开关按钮**；**刷新间隔默认 10s**（现 5s）。
5. **设置双入口**：命令面板「设置」QuickPick 与侧边栏内嵌设置面板**同时可用**，改同一份配置、实时互同步。
6. **交付节奏**：先出 UI 原型给用户过目 → 确认后再生成完整代码 + README。
7. **全程极简**，不新增冗余元素；**不上传 GitHub**，等用户确认后另行处理。

## 现状分析（1.2.0，基于实际勘察）

- 双 webview 宿主共用一份 HTML/CSS/JS（[webviewHtml.ts](file:///workspace/src/webviewHtml.ts) L94-129），靠 `body[data-host=sidebar]` / `data-view` / `data-color` 区分；本次**删除 panel 宿主**，只留 sidebar。
- 消息协议（webview→ext）：`ready / refresh / selectHost / openSettings / openWindow`；ext→webview：`state`、`showView`。本次扩展为配置写入消息（见下）。
- 灵动岛 DOM 在 [webviewHtml.ts](file:///workspace/src/webviewHtml.ts) L15-45（`islandHtml`），CSS 在 [main.css](file:///workspace/media/main.css) L124-283（`.island*`），JS 在 [main.js](file:///workspace/media/main.js) L110-160（`toggleIsland/renderIsland`）——全部删除。
- 编辑器面板 [panel.ts](file:///workspace/src/panel.ts)（单例 `DashboardPanel`）+ 命令 `easy-gpu.openDashboard`——全部删除。
- 窗口页功能（保留、平移）：GPU 卡片缓存增删（[main.js](file:///workspace/media/main.js) L362-381）、整卡点击收起/展开进程芯片（L244-246）、`mergeProcessesByUser` 合并（L87-102）、`MAX_PROCESS_CHIPS=12` + `+N` 折叠（L292-307）、CPU 90 点曲线 canvas（L410-470）、内存行、倒计时（L472-483）。
- 设置现 3 项 `refreshInterval`(默认 5) / `mergeProcesses` / `accentColor`（[config.ts](file:///workspace/src/config.ts)）；QuickPick 设置在 [settingsUi.ts](file:///workspace/src/settingsUi.ts)（4 条目含「合并进程」「在 VS Code 设置中打开」）。
- 状态栏：`src/statusbar.ts` 已在 1.2.0 删除，需按新规格重建。
- 服务层 [service.ts](file:///workspace/src/service.ts) 接口不变：`getState() / profile / start() / refresh() / onDidChange`。
- dev 预览链路：[dev/preview.html](file:///workspace/dev/preview.html)（DOM 手工副本 + `?host=sidebar/?theme=/?color=/?view=`）+ [dev/mock-data.js](file:///workspace/dev/mock-data.js)（4×RTX 3090 mock，`?merge=1`）。

## 目标设计规范

### 1. 侧边栏监控页（唯一 webview，view id `easy-gpu.monitor`）

单页无切换，自上而下（高度结构化、无冗余）：

1. **头部行**：主机名 `wzszju@gpu-lab`（粗体、截断）+ 状态徽标（色点 + 文案：已连接/连接中…/连接失败/未连接）；右侧图标按钮：**立即刷新**、**设置（齿轮）**。
2. **GPU 区**：小号大写标签 `GPU`（右侧放**合并进程开关按钮**，见 3）；每卡一张 widget 风卡片：
   - 行 1：`GPU 0` 徽章 + 显卡名（截断）；右侧 `TEMP 71°C / UTIL 61%` 小标签等宽数值（仅超阈值着色，≥65 warm / ≥80 hot，util ≥90 warm / ≥98 hot）。
   - 行 2：显存大号等宽数字 `18.1` + `GB / 24.0 GB` 小字 + 右侧百分比（强调色）。
   - 行 3：细进度条（强调色，7px 胶囊轨道，延续 1.2.0「加粗」决定）。
   - 行 4：用户显存芯片流 `wzs 6876M ǀ lj 814M`（`MAX_PROCESS_CHIPS=12` + `+N 进程 · xM` 折叠、悬停明细、mergeProcesses 合并逻辑全部保留）；**整卡点击收起/展开该行 + 箭头旋转**（保留现有交互）。
3. **合并进程开关**：GPU 区标签行右侧小号 pill 按钮「合并进程」，开=强调色底、关=中性底；点击写配置并即时重渲染进程行。
4. **系统区**：小号大写标签 `系统`；CPU 卡（大号数值 + `%` + `64 核` 小字 + 迷你曲线 canvas 52px 高）与内存卡（大号已用 + `GB / 126GB` + 进度条 + `缓存 xG / 可用 xG` 小字），沿用两列→窄栏单列。
5. **底部**：微型时间戳 `数据 02:33:26 · 0.71s`（等宽、灰）。
6. **空/异常态**：无服务器→「未添加服务器，点击右上连接」+ 提供连接入口；连接失败→红色细 banner（无图标堆砌）；无 nvidia-smi→提示行。

### 2. 内嵌设置面板（齿轮按钮 → 滑出/覆盖式 sheet）

极简 3 行，与命令 QuickPick **同一份配置、实时互同步**：

1. **刷新间隔**：预设 chips `5s / 10s / 30s / 60s`（当前值高亮；默认 10s），自定义值走命令 QuickPick 输入（2–600）。
2. **颜色风格**：7 色圆点（蓝/青/绿/紫/粉/橙/红），当前色带描边；点击即时生效。
3. **更多设置**：行尾箭头，点击发 `openMoreSettings` → 扩展执行 `workbench.action.openSettings` 参数 `easy-gpu`。

合并进程**不进设置**，只留页面开关（符合第 4 点要求）。

### 3. 原生状态栏（新建 `src/statusbar.ts`）

- 文本：`● 72.0/96.0G`（显存合计；`●` 为状态点），状态着色：ok 绿 / connecting 强调色（可 1s 闪烁切换文本模拟呼吸）/ error 红 / idle 灰；未连接时 `● 未连接`。
- 点击 → `workbench.view.extension.easy-gpu`（展开侧边栏监控视图）。
- tooltip：`Easy GPU · GPU×4 显存 72.0/96.0G · 71°C · CPU 62% · RAM 94.6/126G`（复用 `summaryText` 语义）+ 换行 `点击打开监控`；error 时显示错误文本。
- 同步：`service.onDidChange` + `onDidChangeConfiguration` 均刷新；无 `showStatusBar` 开关（极简，始终显示）。

### 4. 设置（全局极简）

- 命令 QuickPick（`easy-gpu.openSettings`）改为 **3 条目**：刷新间隔（输入）/ 颜色风格（7 选 1）/ 更多设置（跳 VS Code 设置）。
- 配置项仅 3 个不变（`refreshInterval` 默认 **10**、`mergeProcesses`、`accentColor`），**不新增任何配置**。
- 双入口同步链路：任一入口写 `config().update(..., Global)` → `onDidChangeConfiguration` → 侧边栏 `postState()` + 状态栏刷新（单一同步路径）。

### 5. 消息协议（重定）

- webview → ext：`ready | refresh | selectHost | openSettings | openMoreSettings | updateConfig { key, value }`（key ∈ refreshInterval/accentColor/mergeProcesses）。
- ext → webview：`state { state, config }`（唯一出向消息）。
- `openWindow / showView` 消息删除。

### 6. 视觉风格（对照用户截图）

- 卡片：`--elev` 圆角 18px 深色/浅色自适应（深色走描边变体，沿用 1.2.0 决定）；无装饰性光晕/网格（删 `.ambient`）。
- 数字：等宽 tabular-nums、大号（显存 27px→卡片主数字同级）；小标签 8.5-10px 大写 + 字距 0.22em；微型时间戳 10px。
- 进度条：7px 胶囊轨道 + 强调色填充（保留 1.2.0「加粗」决定，不因参考图改细）。
- 7 强调色 + 深浅主题双套变量**原样保留**（[main.css](file:///workspace/media/main.css) L6-106）；状态点语义色 ok/warn/err 仅用于状态与异常。

## 阶段 A：UI 原型（先做，等用户确认）

新建 **`dev/ui-1.3.0.html`**（自包含单文件：内联 CSS/JS + mock 数据；不动 `media/`）：

- 模拟 VS Code 外壳：左侧活动栏图标条 + 320px 侧边栏 + 窗口底部状态栏条，一眼看全两处新 UI 的关系。
- 完整实现侧边栏监控页全部区块 + 内嵌设置 sheet（可交互：7 色切换、间隔 chips、合并开关）+ GPU 卡收起/展开 + 状态栏实时联动（mock 数据驱动显存合计与状态点变色）。
- `?theme=dark|light`、`?color=`、`?merge=1`；浅/深两主题默认深色（贴近参考图）。
- 交付：`python3 -m http.server` + OpenPreview 链接；浏览器回归 + 截图（深/浅 × 侧边栏全页 × 设置 sheet × 状态栏各状态）。
- **Gate：用户确认 UI 后才进入阶段 B。**

## 阶段 B：完整实现（用户确认后执行）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/panel.ts` | **删除文件** | 编辑器大面板移除（已确认） |
| `src/sidebarView.ts` | 重写 | 改名 `MonitorSidebarView`（viewId `easy-gpu.monitor`）；处理新消息协议（含 `updateConfig` 写 Global 配置）；`state` 推送不变 |
| `src/statusbar.ts` | **新建** | `MonitorStatusBar`：按 3. 规格；`service.onDidChange` + 配置变更刷新 |
| `src/webviewHtml.ts` | 重写 | 单宿主（sidebar）HTML：头部/GPU 区/系统区/设置 sheet/底部；删除 `islandHtml / capsulePageHtml / WINDOW_PAGE / initialView / data-view` |
| `src/extension.ts` | 改 | 删 `DashboardPanel`/`openDashboard`/`openWindow`；注册 `MonitorStatusBar`；命令保留 `connect / manageConnections / openSettings / refreshNow` |
| `src/config.ts` | 改 | `refreshInterval()` 默认 5→**10**；`webviewConfig()` 不变 |
| `src/settingsUi.ts` | 改 | QuickPick 4 条目 → **3 条目**（刷新间隔/颜色风格/更多设置），删「合并进程」条目 |
| `media/main.js` | 重写 | 单页渲染（头部/GPU 卡/系统卡/设置 sheet/合并开关/倒计时/曲线）；保留 GPU 卡缓存、`mergeProcessesByUser`、`MAX_PROCESS_CHIPS`、`pushHistory/drawChart`、`tickCountdown` 逻辑；删 island/setView/hero |
| `media/main.css` | 重写 | 保留变量体系（L6-106）与 7 强调色；删 `.island*`/`.view-capsule`/`body.island-expanded`；按 6. 重排卡片与标签样式 |
| `package.json` | 改 | `version 1.3.0`；view id→`easy-gpu.monitor` name「监控」；删 `easy-gpu.openDashboard` 命令；`refreshInterval` 默认 10 |
| `dev/preview.html` + `dev/mock-data.js` | 同步 | 新 DOM 回归副本；`mockConfig()` 补 `accentColor`、默认 10 |
| `README.md` | 重写 | 极简、数字分点：作者/仓库 · 整体预览 · 功能 · 安装 · 使用；截图换新 |

## 阶段 C：验证与交付

1. `npm run compile` 通过（strict 无错误）。
2. `dev/preview.html` 浏览器回归：GPU 卡收起/展开、合并开关即时生效、设置 sheet 三行、7 色、`?theme=dark`、倒计时与 CPU 曲线、状态栏 mock 联动。
3. `npm run package` 出 `easy-gpu-1.3.0.vsix`（仅本地产物，`.vscodeignore` 维持现状：`docs/` 保留供 README 插图）。
4. **不执行任何 git commit / push，不上传 GitHub**，等用户确认。

## 假设与决策

1. **状态栏内容已确认**：显存合计 + 状态点，点击展开侧边栏，tooltip 全量摘要；无显示/隐藏开关。
2. **编辑器大面板已确认完全移除**：`easy-gpu.openDashboard` 命令一并删除，窗口页功能 100% 由侧边栏承接。
3. **view id 从 `easy-gpu.capsule` 改为 `easy-gpu.monitor`**：UI 语义已变（不再有胶囊），直接改名；活动栏容器 id `easy-gpu` 与图标不变（用户拖动布局会重置一次，可接受）。
4. **合并进程只做页面开关**，不进任何设置列表；但仍写入原配置 `easy-gpu.mergeProcesses`（「更多设置」的原生设置页仍可见，属兜底不属冗余）。
5. **刷新间隔侧边栏用预设 chips（5/10/30/60s）**，自定义值走 QuickPick 输入；默认 10s 由 package.json + config.ts 双处兜底。
6. **进度条维持 7px**：用户 1.2.0 明确要求「变粗」，参考图的细条不覆盖该既有决定。
7. **消息协议单向极简**：出向仅 `state`；配置写入走 `updateConfig` 后由 `onDidChangeConfiguration` 统一回推，避免双通道。
8. **阶段 A 原型自包含**（`dev/ui-1.3.0.html`），确认后才移植进 `media/`，与 1.2.0 流程一致。

## 验证步骤（对应阶段 A/B/C）

- 阶段 A：OpenPreview 打开 `dev/ui-1.3.0.html`，逐项检查（设置 sheet 三行交互 / 合并开关 / GPU 卡收起展开 / 状态栏变色与 tooltip / 深浅主题 / 7 色），截图给用户确认。
- 阶段 B：`npm run compile`；`dev/preview.html` 回归上述交互 + mock 数据渲染正确。
- 阶段 C：`npm run package` 出 1.3.0 vsix；确认无任何 git 远端操作。
