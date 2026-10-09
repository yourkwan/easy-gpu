import * as vscode from 'vscode';

/** webview 宿主：panel = 编辑器监控面板（双视图）；sidebar = 侧边栏状态胶囊。 */
export type WebviewHost = 'panel' | 'sidebar';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  host: WebviewHost;
  /** 面板初始视图（仅 panel 生效），默认胶囊页。 */
  initialView?: 'capsule' | 'window';
}

/** 悬浮胶囊（灵动岛）：两处宿主共用，仅「窗口」按钮的提示文案不同。 */
function islandHtml(host: WebviewHost): string {
  const windowTitle = host === 'sidebar' ? '打开监控面板' : '打开窗口页面';
  return `<!-- 悬浮胶囊（灵动岛） -->
<div class="island" id="island" role="button" tabindex="0" aria-label="状态胶囊，点击展开或收起">
  <div class="island-short">
    <span class="dot idle" id="dot"></span>
    <span class="short-text" id="short-text">未连接</span>
  </div>
  <div class="island-long">
    <div class="long-head">
      <span class="host" id="long-host">未配置服务器</span>
      <span class="count" id="countdown"></span>
    </div>
    <div class="long-summary" id="long-summary">--</div>
    <div class="long-icons">
      <button class="icon-btn" id="btn-host" title="切换服务器" aria-label="切换服务器">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="7" rx="2"/><rect x="2" y="13" width="20" height="7" rx="2"/><path d="M6 7.5h.01M6 16.5h.01"/></svg>
      </button>
      <button class="icon-btn" id="btn-refresh" title="立即刷新" aria-label="立即刷新">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
      <button class="icon-btn" id="btn-settings" title="设置" aria-label="设置">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56h.08a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"/></svg>
      </button>
      <button class="icon-btn window" id="btn-window" title="${windowTitle}" aria-label="${windowTitle}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>
      </button>
    </div>
  </div>
</div>`;
}

/** 胶囊页：面板（含显存 hero）与侧边栏（极简提示）两种形态。 */
function capsulePageHtml(host: WebviewHost): string {
  const hint = host === 'sidebar'
    ? `  <div class="hint">
    <span><b>点击胶囊</b> 展开 / 收起</span>
    <span><b>窗口图标</b> 打开监控面板</span>
  </div>`
    : `  <div class="capsule-hero">
    <div class="kicker">Easy GPU</div>
    <h2 class="headline">显存 <span class="num" id="hero-mem">——</span></h2>
    <p class="sub" id="hero-sub">尚未连接服务器</p>
  </div>
  <div class="hint">
    <span><b>点击胶囊</b> 展开 / 收起</span>
    <span><b>蓝色图标</b> 进入窗口页</span>
  </div>`;

  return `<!-- 胶囊页（默认视图） -->
<section class="view view-capsule" id="view-capsule">
  <div class="ambient"></div>
${hint}
  <div class="wordmark">Easy GPU</div>
</section>`;
}

const WINDOW_PAGE = `<!-- 窗口页（监控详情） -->
<section class="view view-window hidden" id="view-window">
  <header class="win-head">
    <h1 id="win-host">未配置服务器</h1>
    <div class="head-row">
      <span class="badge idle" id="win-badge"><span class="dot idle"></span><span id="win-badge-text">未连接</span></span>
      <span class="diag" id="win-diag"></span>
    </div>
  </header>
  <div class="banner hidden" id="banner"></div>
  <section class="group">
    <div class="group-label">GPU</div>
    <div class="gpu-list" id="gpu-list"></div>
  </section>
  <section class="group">
    <div class="group-label">系统</div>
    <div class="sys-grid" id="sys-grid"></div>
  </section>
  <footer class="foot" id="foot">等待数据…</footer>
</section>`;

/** 生成 webview HTML 骨架（编辑器面板 / 侧边栏共用，media/main.css + main.js 驱动）。 */
export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const { webview, extensionUri, host } = options;
  const nonce = createNonce();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  const bodyHost = host === 'sidebar' ? ' data-host="sidebar"' : '';
  const bodyView = host === 'panel' && options.initialView === 'window' ? ' data-view="window"' : '';
  const windowPage = host === 'panel' ? `\n${WINDOW_PAGE}\n` : '\n';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${cssUri}" rel="stylesheet">
<title>Easy GPU</title>
</head>
<body data-color="blue"${bodyHost}${bodyView}>

${islandHtml(host)}

${capsulePageHtml(host)}
${windowPage}
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}