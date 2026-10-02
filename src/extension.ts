import * as vscode from 'vscode';
import { BuiltinSshTransport } from './builtinSsh';
import { HostKeyStoreAdapter, SecretCredentialStore, VsCodeAuthInteraction } from './credentials';
import { DashboardPanel } from './panel';
import { MonitorService } from './service';
import { readSshConfigHosts } from './sshConfig';
import { StatusBar } from './statusbar';

export function activate(context: vscode.ExtensionContext): void {
  const rememberPassword = () =>
    vscode.workspace.getConfiguration('easy-gpu').get<boolean>('rememberPassword', true);

  const credentials = new SecretCredentialStore(context.secrets);
  const readPrivateKeyPath = () =>
    vscode.workspace.getConfiguration('easy-gpu').get<string>('privateKeyPath', '').trim() || undefined;
  const builtin = new BuiltinSshTransport({
    credentials,
    hostKeys: new HostKeyStoreAdapter(context.globalState),
    interaction: new VsCodeAuthInteraction(rememberPassword),
    rememberPassword,
    privateKeyPath: readPrivateKeyPath
  });

  const service = new MonitorService(context, builtin);
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
    builtin,
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
      await service.refresh({ manual: true });
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
    vscode.commands.registerCommand('easy-gpu.setPassword', async () => {
      const picked = await pickHost(service.host || undefined);
      if (!picked) {
        return;
      }
      const password = await vscode.window.showInputBox({
        title: `Easy GPU：设置 ${picked} 的 SSH 密码`,
        prompt: '密码会保存到系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux 密钥环）',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value ? undefined : '密码不能为空')
      });
      if (!password) {
        return;
      }
      await credentials.store(picked, 'password', password);
      if (!service.host) {
        await vscode.workspace
          .getConfiguration('easy-gpu')
          .update('host', picked, vscode.ConfigurationTarget.Global);
      }
      builtin.dispose();
      void vscode.window.showInformationMessage(`Easy GPU：已保存 ${picked} 的登录密码`);
      await service.refresh({ manual: true });
    }),
    vscode.commands.registerCommand('easy-gpu.forgetPassword', async () => {
      const candidates = Array.from(
        new Set([service.host, ...readSshConfigHosts().map((entry) => entry.alias)].filter(Boolean) as string[])
      );
      if (!candidates.length) {
        void vscode.window.showInformationMessage('Easy GPU：没有可清除的已保存凭据');
        return;
      }
      const picked = await vscode.window.showQuickPick(candidates, {
        title: '清除已保存的凭据',
        placeHolder: '选择要清除登录密码 / 私钥口令的服务器',
        ignoreFocusOut: true
      });
      if (!picked) {
        return;
      }
      await credentials.delete(picked, 'password');
      await credentials.delete(picked, 'passphrase');
      builtin.dispose();
      const keyPath = readPrivateKeyPath();
      const note = keyPath
        ? `注意：当前仍在使用私钥文件 ${keyPath}，如需停用请在设置中清空 easy-gpu.privateKeyPath`
        : '若仍能自动连接，说明正在使用私钥文件或 ssh-agent，它们不需要保存密码';
      void vscode.window.showInformationMessage(`Easy GPU：已清除 ${picked} 的登录密码与私钥口令。${note}`);
    }),
    vscode.commands.registerCommand('easy-gpu.selectPrivateKey', async () => {
      const picked = await vscode.window.showOpenDialog({
        title: '选择 SSH 私钥文件（OpenSSH 格式）',
        openLabel: '使用这个私钥',
        canSelectMany: false,
        filters: { '所有文件': ['*'], '常见私钥': ['pem', 'key', 'ppk'] }
      });
      const file = picked?.[0];
      if (!file) {
        return;
      }
      const keyPath = file.fsPath;
      await vscode.workspace
        .getConfiguration('easy-gpu')
        .update('privateKeyPath', keyPath, vscode.ConfigurationTarget.Global);
      builtin.dispose();
      if (keyPath.toLowerCase().endsWith('.ppk')) {
        void vscode.window.showWarningMessage(
          'Easy GPU：这是 PuTTY 的 .ppk 私钥格式，OpenSSH 与内置客户端都无法直接使用。请用 PuTTYgen 打开它，通过「Conversions → Export OpenSSH key」导出 OpenSSH 格式后再选择。'
        );
        return;
      }
      void vscode.window.showInformationMessage(`Easy GPU：已使用私钥 ${keyPath}`);
      await service.refresh({ manual: true });
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

async function pickHost(currentHost?: string): Promise<string | undefined> {
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
    title: '选择服务器（来自 ~/.ssh/config）',
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