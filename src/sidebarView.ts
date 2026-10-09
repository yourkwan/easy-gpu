import * as vscode from 'vscode';
import { config, webviewConfig } from './config';
import { authLabel, profileLabel, ProfileStore } from './profiles';
import { MonitorService } from './service';
import { ProfileSummary } from './types';
import { buildWebviewHtml } from './webviewHtml';

/**
 * 侧边栏「监控」视图（唯一 webview）：
 * 头部 / GPU 卡片 / 系统 / 内嵌设置 sheet / 选择服务器 sheet。
 */
export class MonitorSidebarView implements vscode.WebviewViewProvider {
  static readonly viewId = 'easy-gpu.monitor';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: MonitorService,
    private readonly store: ProfileStore
  ) {}

  /** 配置变化等场景下主动推送最新状态。 */
  refresh(): void {
    this.postState();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.context.extensionUri
    });
    this.view = view;

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      view.webview.onDidReceiveMessage((message: { type?: string; key?: string; value?: unknown; id?: string }) => {
        void this.onMessage(message);
      }),
      this.service.onDidChange(() => this.postState()),
      view.onDidChangeVisibility(() => this.postState())
    );

    view.onDidDispose(() => {
      this.view = undefined;
      while (disposables.length) {
        disposables.pop()?.dispose();
      }
    });
  }

  private async onMessage(message: { type?: string; key?: string; value?: unknown; id?: string }): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.postState();
        break;
      case 'refresh':
        void this.service.refresh({ manual: true });
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('easy-gpu.openSettings');
        break;
      case 'openMoreSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'easy-gpu');
        break;
      case 'openConnect':
        void vscode.commands.executeCommand('easy-gpu.connect');
        break;
      case 'switchProfile': {
        const id = String(message.id ?? '');
        if (id && this.store.all().some((p) => p.id === id)) {
          await this.store.setCurrent(id);
          this.service.start();
        }
        break;
      }
      case 'updateConfig':
        await this.updateConfig(String(message.key ?? ''), message.value);
        break;
    }
  }

  private async updateConfig(key: string, value: unknown): Promise<void> {
    if (key === 'refreshInterval') {
      const seconds = Math.round(Number(value));
      if (Number.isFinite(seconds) && seconds >= 2 && seconds <= 600) {
        await config().update('refreshInterval', seconds, vscode.ConfigurationTarget.Global);
      }
      return;
    }
    if (key === 'accentColor') {
      const valid = ['blue', 'cyan', 'green', 'purple', 'pink', 'orange', 'red'];
      const color = String(value ?? '');
      if (valid.includes(color)) {
        await config().update('accentColor', color, vscode.ConfigurationTarget.Global);
      }
      return;
    }
    if (key === 'mergeProcesses') {
      await config().update('mergeProcesses', Boolean(value), vscode.ConfigurationTarget.Global);
    }
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'state',
      state: this.service.getState(),
      config: webviewConfig(),
      profiles: this.summaries()
    });
  }

  private summaries(): ProfileSummary[] {
    const currentId = this.store.current()?.id;
    return this.store.all().map((profile) => ({
      id: profile.id,
      label: profileLabel(profile),
      sub: `${profile.port === 22 ? profile.host : `${profile.host}:${profile.port}`} · ${authLabel(profile)}`,
      current: profile.id === currentId
    }));
  }
}