import * as vscode from 'vscode';
import { BuiltinSshTransport } from './builtinSsh';
import { runConnectWizard, showConnectionManager } from './connectFlow';
import { HostKeyStoreAdapter, SecretCredentialStore, VsCodeAuthInteraction } from './credentials';
import { DashboardPanel } from './panel';
import { addressPart, profileId, ProfileStore } from './profiles';
import { MonitorService } from './service';
import { showSimpleSettings } from './settingsUi';
import { CapsuleSidebarView } from './sidebarView';
import { resolveHost, expandHome } from './sshConfig';

export function activate(context: vscode.ExtensionContext): void {
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

  const deps = {
    store,
    credentials,
    dropSession: () => builtin.dispose(),
    restart: () => service.start()
  };
  const openManager = () => showConnectionManager(deps);
  const connectNew = () => runConnectWizard(deps);

  context.subscriptions.push(
    service,
    builtin,
    vscode.window.registerWebviewViewProvider(
      CapsuleSidebarView.viewId,
      new CapsuleSidebarView(context, service),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('easy-gpu.openDashboard', (arg?: { view?: 'capsule' | 'window' }) => {
      DashboardPanel.createOrShow(context, service, arg?.view === 'window' ? 'window' : 'capsule');
      if (!service.profile) {
        void openManager();
      }
    }),
    vscode.commands.registerCommand('easy-gpu.connect', () => connectNew()),
    vscode.commands.registerCommand('easy-gpu.manageConnections', () => openManager()),
    vscode.commands.registerCommand('easy-gpu.openSettings', () =>
      showSimpleSettings(() => {
        DashboardPanel.notifyConfigChanged();
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
        service.start();
      }
      DashboardPanel.notifyConfigChanged();
    })
  );

  void migrateLegacySettings(store, credentials).finally(() => {
    service.start();
  });

  // 启动后自动展开侧边栏「状态胶囊」视图，打开 IDE 即可看到胶囊
  void vscode.commands.executeCommand('workbench.view.extension.easy-gpu');
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

  for (const key of ['host', 'privateKeyPath', 'sshExtraArgs', 'connectionMode', 'rememberPassword']) {
    if (config.inspect(key)?.globalValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
}
