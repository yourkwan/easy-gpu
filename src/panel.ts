import * as vscode from 'vscode';
import { accentColor, mergeProcesses, refreshInterval } from './config';
import { MonitorService } from './service';
import { WebviewConfig } from './types';

/** Webview 仪表盘（单例）。 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  /** 设置变化时只推送新配置，不必重新采集一次数据。 */
  static notifyConfigChanged(): void {
    DashboardPanel.current?.postState();
  }

  static createOrShow(context: vscode.ExtensionContext, service: MonitorService): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DashboardPanel.current;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'easy-gpu.dashboard',
      'Easy GPU 监控',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot]
      }
    );
    DashboardPanel.current = new DashboardPanel(panel, context, service);
    return DashboardPanel.current;
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: MonitorService
  ) {
    this.panel.iconPath = undefined;
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string }) => {
        switch (message?.type) {
          case 'ready':
            this.postState();
            break;
          case 'refresh':
            void this.service.refresh({ manual: true });
            break;
          case 'selectHost':
            void vscode.commands.executeCommand('easy-gpu.manageConnections');
            break;
          case 'openSettings':
            void vscode.commands.executeCommand('easy-gpu.openSettings');
            break;
        }
      },
      undefined,
      this.disposables
    );

    this.disposables.push(this.service.onDidChange(() => this.postState()));

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private postState(): void {
    const config: WebviewConfig = {
      refreshInterval: refreshInterval(),
      mergeProcesses: mergeProcesses(),
      accentColor: accentColor()
    };
    void this.panel.webview.postMessage({
      type: 'state',
      state: this.service.getState(),
      config
    });
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
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
<body data-color="blue">

<!-- 悬浮胶囊（灵动岛） -->
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
      <button class="icon-btn window" id="btn-window" title="打开窗口页面" aria-label="打开窗口页面">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>
      </button>
    </div>
  </div>
</div>

<!-- 胶囊页（默认视图） -->
<section class="view view-capsule" id="view-capsule">
  <div class="ambient"></div>
  <div class="capsule-hero">
    <div class="kicker">Easy GPU</div>
    <h2 class="headline">显存 <span class="num" id="hero-mem">——</span></h2>
    <p class="sub" id="hero-sub">尚未连接服务器</p>
  </div>
  <div class="hint">
    <span><b>点击胶囊</b> 展开 / 收起</span>
    <span><b>蓝色图标</b> 进入窗口页</span>
  </div>
  <div class="wordmark">Easy GPU</div>
</section>

<!-- 窗口页（监控详情） -->
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
</section>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}