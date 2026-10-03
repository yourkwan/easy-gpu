import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { utils as sshUtils } from 'ssh2';
import { SecretCredentialStore } from './credentials';
import { authLabel, addressPart, ConnectionProfile, profileId, profileLabel, ProfileStore, StoredProfile } from './profiles';
import { readSshConfigHosts, resolveHost } from './sshConfig';

export interface ConnectFlowDeps {
  store: ProfileStore;
  credentials: SecretCredentialStore;
  /** 配置变化后丢弃缓存的 SSH 会话，让新凭据立即生效 */
  dropSession: () => void;
  /** 重新启动轮询（新的当前连接生效） */
  restart: () => void;
}

/** 连接向导：地址 → 用户名 → 登录方式 → 密码 / 私钥。 */
export async function runConnectWizard(
  deps: ConnectFlowDeps,
  options: { existing?: StoredProfile; prefill?: Partial<ConnectionProfile> } = {}
): Promise<void> {
  const existing = options.existing;
  const base: Partial<ConnectionProfile> = existing ?? options.prefill ?? {};
  const editing = Boolean(existing);
  const step = (index: number) => `${editing ? '修改连接' : '新建连接'}（${index}/3）`;

  // 1. 服务器地址（可带 user@ 与 :端口）
  const address = await vscode.window.showInputBox({
    title: `${step(1)}：服务器地址`,
    prompt: 'IP、域名，或 ~/.ssh/config 中的别名；也可以直接写 user@host:端口',
    placeHolder: '10.0.0.8 或 gpu-lab',
    value: base.host ? (base.port && base.port !== 22 ? `${base.host}:${base.port}` : base.host) : '',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : '请输入服务器地址')
  });
  if (address === undefined) {
    return;
  }
  const rawAddress = address.trim();
  const resolved = resolveHost(rawAddress);
  // 保留别名（而非解析后的 IP），这样连接时仍能复用 ~/.ssh/config 的 IdentityFile、ProxyJump 等
  const host = addressPart(rawAddress);
  const port = resolved.port;

  // 2. 用户名（地址里已写 user@ 时跳过，避免多余一步）
  let user = base.user?.trim() || resolved.user;
  const hasInlineUser = rawAddress.includes('@');
  if (!hasInlineUser || editing) {
    const input = await vscode.window.showInputBox({
      title: `${step(2)}：登录用户名`,
      prompt: `登录 ${host} 使用的账号`,
      placeHolder: resolved.user,
      value: hasInlineUser ? resolved.user : base.user ?? '',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请输入用户名')
    });
    if (input === undefined) {
      return;
    }
    user = input.trim();
  }

  // 3. 登录方式
  const method = await vscode.window.showQuickPick(
    [
      {
        label: '$(key) 密码登录',
        description: '推荐：密码存入系统钥匙串，之后自动连接',
        value: 'password' as const
      },
      {
        label: '$(file) 私钥文件',
        description: '选择本机的私钥文件（OpenSSH 格式），每个用户可用各自的私钥',
        value: 'key' as const
      },
      {
        label: '$(plug) ssh-agent / 免密',
        description: '复用 ~/.ssh/config、ssh-agent 与已有密钥，不保存任何密码',
        value: 'agent' as const
      }
    ],
    {
      title: `${step(3)}：${user}@${host} 的登录方式`,
      placeHolder: '选择一种登录方式',
      ignoreFocusOut: true
    }
  );
  if (!method) {
    return;
  }

  const profile: ConnectionProfile = { host, user, port, auth: method.value, keyPath: existing?.keyPath };
  const id = profileId(profile);

  if (profile.auth === 'key') {
    const keyPath = await pickPrivateKey(existing?.keyPath);
    if (!keyPath) {
      return;
    }
    profile.keyPath = keyPath;
    const unlocked = await ensurePassphrase(deps, profile, keyPath);
    if (!unlocked) {
      return;
    }
  }

  if (profile.auth === 'password') {
    const saved = await deps.credentials.get(id, 'password');
    const keepHint = saved ? '直接回车可保持不变' : '密码会保存到系统钥匙串（不会写进设置文件）';
    const password = await vscode.window.showInputBox({
      title: `${user}@${host} 的登录密码`,
      prompt: keepHint,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value || saved ? undefined : '请输入密码')
    });
    if (password === undefined) {
      return;
    }
    if (password) {
      await deps.credentials.store(id, 'password', password);
    }
  }

  const stored = await deps.store.save(profile);
  const existingSaved = await deps.credentials.get(id, 'password');
  deps.dropSession();

  if (profile.auth === 'password' && !existingSaved) {
    void vscode.window.showWarningMessage('Easy GPU：这条连接选择了密码登录，但还没有保存密码。连接时会再提示输入。');
  } else {
    void vscode.window.showInformationMessage(`Easy GPU：已保存连接 ${profileLabel(stored)}（${authLabel(stored)}）`);
  }
  deps.restart();
}

/** 连接管理：列出全部连接，回车连接，右侧按钮修改 / 删除。 */
export async function showConnectionManager(deps: ConnectFlowDeps): Promise<void> {
  for (;;) {
    const action = await pickManagerAction(deps);
    if (!action) {
      return;
    }
    switch (action.kind) {
      case 'connect': {
        await connectTo(deps, action.profile);
        return;
      }
      case 'edit': {
        await runConnectWizard(deps, { existing: action.profile });
        return;
      }
      case 'delete': {
        await removeProfile(deps, action.profile);
        break;
      }
      case 'new': {
        await runConnectWizard(deps);
        return;
      }
      case 'sshConfig': {
        const prefill = await pickFromSshConfig();
        if (prefill) {
          await runConnectWizard(deps, { prefill });
          return;
        }
        break;
      }
    }
  }
}

type ManagerAction =
  | { kind: 'connect'; profile: StoredProfile }
  | { kind: 'edit'; profile: StoredProfile }
  | { kind: 'delete'; profile: StoredProfile }
  | { kind: 'new' }
  | { kind: 'sshConfig' };

type ManagerItem = vscode.QuickPickItem & {
  profile?: StoredProfile;
  action?: ManagerAction['kind'];
};

const BTN_EDIT: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: '修改' };
const BTN_DELETE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: '删除' };

async function pickManagerAction(deps: ConnectFlowDeps): Promise<ManagerAction | undefined> {
  const profiles = deps.store.all();
  const currentId = deps.store.current()?.id;
  const savedPasswords = await Promise.all(profiles.map((profile) => deps.credentials.get(profile.id, 'password')));

  const items: ManagerItem[] = profiles.map((profile, index) => ({
    label: profile.id === currentId ? `$(check) ${profileLabel(profile)}` : profileLabel(profile),
    description:
      authLabel(profile) + (savedPasswords[index] ? ' · 已保存密码' : profile.auth === 'password' ? ' · 密码未保存' : ''),
    profile,
    buttons: [BTN_EDIT, BTN_DELETE]
  }));

  items.push({ label: '$(add) 新建连接', description: '输入服务器地址与用户名，再选择密码或私钥', action: 'new' });
  items.push({ label: '$(server) 从 ~/.ssh/config 选择', description: '复用已有的 SSH 配置', action: 'sshConfig' });

  return new Promise<ManagerAction | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<ManagerItem>();
    let done = false;
    const finish = (action?: ManagerAction) => {
      if (done) {
        return;
      }
      done = true;
      quickPick.hide();
      quickPick.dispose();
      resolve(action);
    };

    quickPick.title = profiles.length ? '连接管理' : '连接管理（还没有保存的连接）';
    quickPick.placeholder = profiles.length
      ? '回车连接选中的服务器；每行右侧按钮可修改或删除'
      : '选择一个入口开始：新建连接，或从 ~/.ssh/config 选择';
    quickPick.items = items;
    quickPick.ignoreFocusOut = true;

    quickPick.onDidTriggerItemButton((event) => {
      const profile = event.item.profile;
      if (!profile) {
        return;
      }
      if (event.button === BTN_DELETE) {
        finish({ kind: 'delete', profile });
      } else {
        finish({ kind: 'edit', profile });
      }
    });

    quickPick.onDidAccept(() => {
      const picked = quickPick.selectedItems[0];
      if (!picked) {
        return;
      }
      if (picked.profile) {
        finish({ kind: 'connect', profile: picked.profile });
        return;
      }
      if (picked.action === 'new') {
        finish({ kind: 'new' });
      } else if (picked.action === 'sshConfig') {
        finish({ kind: 'sshConfig' });
      }
    });

    quickPick.onDidHide(() => finish(undefined));
    quickPick.show();
  });
}

function connectTo(deps: ConnectFlowDeps, profile: StoredProfile): Promise<void> {
  return (async () => {
    await deps.store.setCurrent(profile.id);
    deps.dropSession();
    deps.restart();
  })();
}

async function removeProfile(deps: ConnectFlowDeps, profile: StoredProfile): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `删除连接 ${profileLabel(profile)}？\n\n该服务器保存在系统钥匙串里的密码 / 私钥口令也会一并清除。`,
    { modal: true },
    '删除'
  );
  if (choice !== '删除') {
    return;
  }
  await deps.credentials.delete(profile.id, 'password');
  await deps.credentials.delete(profile.id, 'passphrase');
  await deps.store.remove(profile.id);
  deps.dropSession();
  deps.restart();
  void vscode.window.showInformationMessage(`Easy GPU：已删除连接 ${profileLabel(profile)}`);
}

async function pickPrivateKey(current?: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: '选择私钥文件（OpenSSH 格式）',
    openLabel: '使用这个私钥',
    defaultUri: current ? vscode.Uri.file(path.dirname(current)) : undefined,
    canSelectMany: false,
    filters: { '所有文件': ['*'], '常见私钥': ['pem', 'key', 'ppk', 'rsa', 'ed25519'] }
  });
  const file = picked?.[0];
  if (!file) {
    return undefined;
  }
  const keyPath = file.fsPath;
  if (!fs.existsSync(keyPath)) {
    void vscode.window.showErrorMessage(`Easy GPU：找不到私钥文件 ${keyPath}`);
    return undefined;
  }
  if (keyPath.toLowerCase().endsWith('.ppk')) {
    const choice = await vscode.window.showWarningMessage(
      '这是 PuTTY 的 .ppk 私钥，OpenSSH 无法直接使用。请用 PuTTYgen 打开它，通过「Conversions → Export OpenSSH key」导出 OpenSSH 格式后再选择。',
      { modal: true },
      '仍要使用'
    );
    if (choice !== '仍要使用') {
      return undefined;
    }
  }
  return keyPath;
}

/** 加密私钥先问口令（可跳过，连接时再问），未加密私钥直接通过。 */
async function ensurePassphrase(
  deps: ConnectFlowDeps,
  profile: ConnectionProfile,
  keyPath: string
): Promise<boolean> {
  let content: string;
  try {
    content = fs.readFileSync(keyPath, 'utf8');
  } catch (error) {
    void vscode.window.showErrorMessage(`Easy GPU：无法读取私钥 ${keyPath}：${(error as Error).message}`);
    return false;
  }
  if (!(sshUtils.parseKey(content) instanceof Error)) {
    return true;
  }
  if (!/Encrypted private/i.test(String((sshUtils.parseKey(content) as Error).message))) {
    return true;
  }

  const id = profileId(profile);
  const saved = await deps.credentials.get(id, 'passphrase');
  const passphrase = await vscode.window.showInputBox({
    title: `私钥口令（${keyPath.split(/[\\/]/).pop()}）`,
    prompt: saved ? '私钥已加密，直接回车可保持已保存的口令' : '私钥已加密，输入口令后可自动连接；留空则连接时再输入',
    password: true,
    ignoreFocusOut: true
  });
  if (passphrase === undefined) {
    return false;
  }
  if (passphrase) {
    await deps.credentials.store(id, 'passphrase', passphrase);
  }
  return true;
}

/** 从 ~/.ssh/config 选一个别名，作为新建连接的预填信息。 */
async function pickFromSshConfig(): Promise<Partial<ConnectionProfile> | undefined> {
  const entries = readSshConfigHosts();
  if (!entries.length) {
    void vscode.window.showInformationMessage('Easy GPU：~/.ssh/config 里没有可用的主机别名，请手动输入服务器地址。');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.alias,
      description: [entry.user && `用户 ${entry.user}`, entry.hostName, entry.port && `端口 ${entry.port}`]
        .filter(Boolean)
        .join(' · '),
      entry
    })),
    { title: '从 ~/.ssh/config 选择服务器', placeHolder: '选择后继续设置用户名与登录方式', ignoreFocusOut: true }
  );
  if (!picked) {
    return undefined;
  }
  const resolved = resolveHost(picked.entry.alias);
  return { host: picked.entry.alias, user: resolved.user, port: resolved.port };
}