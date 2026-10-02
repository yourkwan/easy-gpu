import * as vscode from 'vscode';
import { DashboardPanel } from './panel';
import { readSshConfigHosts } from './ssh';
import { MonitorService } from './service';
import { StatusBar } from './statusbar';

export function activate(context: vscode.ExtensionContext): void {
  const service = new MonitorService(context);
  const statusBar = new StatusBar();

  const syncStatusBar = (state = service.getState()) => {
    const visible = vscode.workspace.getConfiguration('easy-gpu').get<boolean>('showStatusBar', true);
    statusBar.setVisible(visible);
    if (visible) {
      statusBar.update(state);
    }
  };

  context.subscriptions.push(
    service,
    statusBar,
    service.onDidChange((state) => syncStatusBar(state)),
    vscode.commands.registerCommand('easy-gpu.openDashboard', () => {
      DashboardPanel.createOrShow(context, service);
      if (!service.host) {
        void vscode.commands.executeCommand('easy-gpu.selectHost');
      }
    }),
    vscode.commands.registerCommand('easy-gpu.refreshNow', async () => {
      if (!service.host) {
        await vscode.commands.executeCommand('easy-gpu.selectHost');
        return;
      }
      await service.refresh();
    }),
    vscode.commands.registerCommand('easy-gpu.selectHost', async () => {
      const picked = await pickHost(service.host);
      if (!picked) {
        return;
      }
      await vscode.workspace
        .getConfiguration('easy-gpu')
        .update('host', picked, vscode.ConfigurationTarget.Global);
      service.start();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('easy-gpu')) {
        service.start();
        syncStatusBar();
      }
    })
  );

  syncStatusBar();
  service.start();
}

export function deactivate(): void {
  // 资源通过 context.subscriptions 统一释放
}

async function pickHost(currentHost: string): Promise<string | undefined> {
  const MANUAL = '$(edit) 手动输入主机（user@host）…';
  const entries = readSshConfigHosts();

  const items: vscode.QuickPickItem[] = entries.map((entry) => {
    const target = [entry.user, entry.hostName].filter(Boolean).join('@');
    const description = [target || '使用 ssh 默认值', entry.port ? `端口 ${entry.port}` : '']
      .filter(Boolean)
      .join(' · ');
    return {
      label: entry.alias === currentHost ? `$(check) ${entry.alias}` : entry.alias,
      description
    };
  });
  items.push({ label: MANUAL, description: '直接填写 SSH 主机名或别名' });

  const picked = await vscode.window.showQuickPick(items, {
    title: '选择要监控的服务器（来自 ~/.ssh/config）',
    placeHolder: entries.length ? '选择一个 SSH 主机' : '未读取到 ~/.ssh/config，可手动输入',
    ignoreFocusOut: true
  });
  if (!picked) {
    return undefined;
  }
  if (picked.label === MANUAL) {
    const input = await vscode.window.showInputBox({
      title: '输入 SSH 主机',
      prompt: '可以是 ~/.ssh/config 中的别名，或 user@host 形式',
      value: currentHost,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '主机不能为空')
    });
    return input?.trim() || undefined;
  }
  return picked.label.replace('$(check) ', '').trim();
}