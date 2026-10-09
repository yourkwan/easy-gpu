import * as vscode from 'vscode';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
}

/** 侧边栏监控页 HTML 骨架（media/main.css + main.js 驱动）。 */
export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const { webview, extensionUri } = options;
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

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${cssUri}" rel="stylesheet">
<title>Easy GPU</title>
</head>
<body data-color="blue" data-status="idle">

<div class="content">
  <header class="top">
    <div class="top-info">
      <div class="host" id="host">未配置服务器</div>
      <div class="status"><span class="dot"></span><span id="status-text">未连接</span></div>
    </div>
    <div class="top-actions">
      <button class="icon-btn" id="btn-refresh" title="立即刷新" aria-label="立即刷新">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
      <button class="icon-btn" id="btn-settings" title="设置" aria-label="设置">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56h.08a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"/></svg>
      </button>
    </div>
  </header>

  <div class="banner hidden" id="banner"></div>

  <section class="group">
    <div class="group-head">
      <span class="label">GPU</span>
      <div class="head-actions">
        <button class="pill" id="btn-servers">选择服务器</button>
        <button class="pill" id="btn-merge" title="把同一用户的多个进程合并为一条显示">合并进程</button>
      </div>
    </div>
    <div class="gpu-list" id="gpu-list"></div>
  </section>

  <section class="group">
    <div class="group-head"><span class="label">系统</span></div>
    <div class="sys-grid">
      <div class="sys-card">
        <div class="sys-top">
          <span class="label">CPU</span>
          <span class="num sys-sub" id="cpu-cores"></span>
        </div>
        <div class="sys-big num"><span id="cpu-value">—</span><small>%</small></div>
        <canvas class="cpu-chart" id="cpu-chart"></canvas>
      </div>
      <div class="sys-card">
        <div class="sys-top">
          <span class="label">内存</span>
          <span class="num sys-sub" id="mem-pct"></span>
        </div>
        <div class="sys-big num"><span id="mem-used">—</span><small>GB / <span id="mem-total">—</span> GB</small></div>
        <div class="meter"><i id="mem-meter"></i></div>
        <div class="sys-meta">
          <span id="mem-cache"></span>
          <span id="mem-avail"></span>
        </div>
      </div>
    </div>
  </section>

  <footer class="foot" id="foot">等待数据…</footer>
</div>

<div class="sheet-backdrop" id="sheet-backdrop"></div>

<!-- 设置 sheet -->
<div class="sheet" id="sheet">
  <div class="sheet-head">
    <div class="sheet-title">设置</div>
    <button class="icon-btn" id="btn-sheet-close" title="关闭" aria-label="关闭">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>
  <div class="sheet-row">
    <div class="row-label">刷新间隔 · <span class="num" id="interval-label">10s</span></div>
    <div class="chips" id="interval-chips">
      <button class="chip" data-iv="5">5s</button>
      <button class="chip on" data-iv="10">10s</button>
      <button class="chip" data-iv="30">30s</button>
      <button class="chip" data-iv="60">60s</button>
      <input class="chip-input" id="interval-custom" type="number" min="2" max="600" placeholder="自定义">
    </div>
  </div>
  <div class="sheet-row">
    <div class="row-label">颜色风格</div>
    <div class="swatches" id="swatches">
      <button class="swatch on" data-c="blue"   title="蓝"></button>
      <button class="swatch" data-c="cyan"   title="青"></button>
      <button class="swatch" data-c="green"  title="绿"></button>
      <button class="swatch" data-c="purple" title="紫"></button>
      <button class="swatch" data-c="pink"   title="粉"></button>
      <button class="swatch" data-c="orange" title="橙"></button>
      <button class="swatch" data-c="red"    title="红"></button>
    </div>
  </div>
  <div class="more-row" id="more-row">
    <span>更多设置</span>
    <span class="arrow">›</span>
  </div>
</div>

<!-- 选择服务器 sheet -->
<div class="sheet" id="server-sheet">
  <div class="sheet-head">
    <div class="sheet-title">选择服务器</div>
    <button class="icon-btn" id="btn-server-close" title="关闭" aria-label="关闭">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>
  <div class="server-list" id="server-list"></div>
  <div class="more-row" id="server-add">
    <span>新建连接</span>
    <span class="arrow">›</span>
  </div>
</div>

<div class="toast" id="toast"></div>

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