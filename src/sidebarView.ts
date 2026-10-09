import * as vscode from 'vscode';
import { webviewConfig } from './config';
import { MonitorService } from './service';
import { buildWebviewHtml } from './webviewHtml';

/**
 * 侧边栏「状态胶囊」视图：常驻灵动岛胶囊 + 精简背景。
 * 点击胶囊最后一个「窗口」图标时发送 openWindow，由扩展打开编辑器监控面板。
 */
export class CapsuleSidebarView implements vscode.WebviewViewProvider {
  static readonly viewId = 'easy-gpu.capsule';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: MonitorService
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.context.extensionUri,
      host: 'sidebar'
    });

    const disposables: vscode.Disposable[] = [];
    const postState = (): void => {
      void view.webview.postMessage({
        type: 'state',
        state: this.service.getState(),
        config: webviewConfig()
      });
    };

    disposables.push(
      view.webview.onDidReceiveMessage((message: { type?: string }) => {
        switch (message?.type) {
          case 'ready':
            postState();
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
          case 'openWindow':
            void vscode.commands.executeCommand('easy-gpu.openDashboard', { view: 'window' });
            break;
        }
      }),
      this.service.onDidChange(postState),
      view.onDidChangeVisibility(() => postState())
    );

    view.onDidDispose(() => {
      while (disposables.length) {
        disposables.pop()?.dispose();
      }
    });
  }
}