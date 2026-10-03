import * as vscode from 'vscode';
import { BuiltinSshTransport } from './builtinSsh';
import { showStatusBar as statusBarVisible } from './config';
import { runConnectWizard, showConnectionManager } from './connectFlow';
import { HostKeyStoreAdapter, SecretCredentialStore, VsCodeAuthInteraction } from './credentials';
import { DashboardPanel } from './panel';
import { addressPart, profileId, ProfileStore } from './profiles';
import { MonitorService } from './service';
import { showSimpleSettings } from './settingsUi';
import { resolveHost, expandHome } from './sshConfig';
import { StatusBar } from './statusbar';

export function activate(context: vscode.ExtensionContext): void {
  // 密码 / 私钥口令统一保存到系统钥匙串，可在「管理连接与密码」中单独删除
  const rememberPassword = () => true;

  const credentials = new SecretCredentialStore(context.secrets);
  const store = new ProfileStore(context.globalState);
  const builtin = new BuiltinSshTransport({
    credentials,
    hostKeys: new HostKeyStoreAdapter(context.globalState),
    interaction: new VsCodeAuthInteraction(rememberPassword),
    rememberPassword
  });

  const service = new MonitorService(context, builtin, store);
  const statusBar = new StatusBar();

  const deps = {
    store,
    credentials,
    dropSession: () => builtin.dispose(),
    restart: () => service.start()
  };
  const openManager = () => showConnectionManager(deps);
  const connectNew = () => runConnectWizard(deps);

  const syncStatusBar = (state = service.getState()) => {
    const visible = statusBarVisible();
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
      if (!service.profile) {
        void openManager();
      }
    }),
    vscode.commands.registerCommand('easy-gpu.connect', () => connectNew()),
    vscode.commands.registerCommand('easy-gpu.manageConnections', () => openManager()),
    vscode.commands.registerCommand('easy-gpu.openSettings', () =>
      showSimpleSettings(() => {
        DashboardPanel.notifyConfigChanged();
        syncStatusBar();
      })
    ),
    vscode.commands.registerCommand('easy-gpu.refreshNow', async () => {
      if (!service.profile) {
        await openManager();
        return;
      }
      await service.refresh({ manual: true });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('easy-gpu')) {
        return;
      }
      if (event.affectsConfiguration('easy-gpu.refreshInterval')) {
        // 间隔变了要重新计时，顺带立即刷新一次
        service.start();
      }
      DashboardPanel.notifyConfigChanged();
      syncStatusBar();
    })
  );

  // 老版本把服务器与私钥写在设置里，这里迁移成连接配置后再启动轮询
  void migrateLegacySettings(store, credentials).finally(() => {
    syncStatusBar();
    service.start();
  });
}

export function deactivate(): void {
  // 资源通过 context.subscriptions 统一释放
}

/** 把旧设置（host / privateKeyPath / connectionMode…）迁移为连接配置，并清理这些已废弃的设置项。 */
async function migrateLegacySettings(store: ProfileStore, credentials: SecretCredentialStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('easy-gpu');
  const legacyHost = (config.get<string>('host', '') ?? '').trim();
  const legacyKeyPath = (config.get<string>('privateKeyPath', '') ?? '').trim();

  if (legacyHost && !store.all().length) {
    const resolved = resolveHost(legacyHost);
    const savedPassword = await credentials.get(legacyHost, 'password');
    const savedPassphrase = await credentials.get(legacyHost, 'passphrase');
    const auth = legacyKeyPath ? 'key' : savedPassword ? 'password' : 'agent';

    const stored = await store.save({
      host: addressPart(legacyHost),
      user: resolved.user,
      port: resolved.port,
      auth,
      keyPath: legacyKeyPath ? expandHome(legacyKeyPath) : undefined
    });

    // 把旧键下的凭据搬到新键（user@host:port），避免用户重新输一遍密码
    if (savedPassword) {
      await credentials.store(profileId(stored), 'password', savedPassword);
    }
    if (savedPassphrase) {
      await credentials.store(profileId(stored), 'passphrase', savedPassphrase);
    }

    void vscode.window.showInformationMessage(
      `Easy GPU：已把原设置中的服务器「${legacyHost}」迁移为连接配置，可在命令面板执行「Easy GPU: 管理连接与密码」修改。`
    );
  }

  // 清掉已废弃的设置项，避免设置页出现无效条目
  for (const key of ['host', 'privateKeyPath', 'sshExtraArgs', 'connectionMode', 'rememberPassword']) {
    if (config.inspect(key)?.globalValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
}