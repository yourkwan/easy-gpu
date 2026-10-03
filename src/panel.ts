import * as vscode from 'vscode';
import { MonitorService } from './service';
import { WebviewConfig } from './types';

/** Webview 仪表盘（单例）。 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

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
            void vscode.commands.executeCommand('workbench.action.openSettings', 'easy-gpu');
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
    const config: WebviewConfig = { refreshInterval: this.service.refreshInterval };
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
<body>
<div class="wrap">
<header class="topbar">
  <div class="brand">
    <span class="title">Easy GPU</span>
    <span class="subtitle" id="host-line">未配置服务器</span>
  </div>
  <div class="actions">
    <span class="status-pill" id="status-pill"><span class="dot"></span><span id="status-text">初始化…</span></span>
    <span class="countdown" id="countdown"></span>
    <button class="btn primary" id="btn-refresh">刷新</button>
    <button class="btn" id="btn-host" title="连接 / 切换服务器，管理密码与私钥">切换服务器</button>
    <button class="btn" id="btn-settings">设置</button>
  </div>
</header>
<div class="banner hidden" id="banner"></div>
<main id="content"></main>
<footer class="footer" id="footer"></footer>
</div>
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