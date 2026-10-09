import * as vscode from 'vscode';
import { webviewConfig } from './config';
import { MonitorService } from './service';
import { buildWebviewHtml } from './webviewHtml';

/** Webview 仪表盘（单例）。 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  /** 设置变化时只推送新配置，不必重新采集一次数据。 */
  static notifyConfigChanged(): void {
    DashboardPanel.current?.postState();
  }

  static createOrShow(
    context: vscode.ExtensionContext,
    service: MonitorService,
    initialView: 'capsule' | 'window' = 'capsule'
  ): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (initialView === 'window') {
        DashboardPanel.current.showView('window');
      }
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
    DashboardPanel.current = new DashboardPanel(panel, context, service, initialView);
    return DashboardPanel.current;
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly service: MonitorService,
    initialView: 'capsule' | 'window'
  ) {
    this.panel.iconPath = undefined;
    this.panel.webview.html = buildWebviewHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      host: 'panel',
      initialView
    });

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

  /** 面板已存在时切换其视图（胶囊页 / 窗口页）。 */
  showView(view: 'capsule' | 'window'): void {
    void this.panel.webview.postMessage({ type: 'showView', view });
  }

  private postState(): void {
    void this.panel.webview.postMessage({
      type: 'state',
      state: this.service.getState(),
      config: webviewConfig()
    });
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}