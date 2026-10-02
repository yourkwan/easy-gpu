import * as vscode from 'vscode';
import { AuthInteraction, CredentialStore, HostKeyStore, SecretKind } from './builtinSsh';

const SECRET_PREFIX: Record<SecretKind, string> = {
  password: 'easy-gpu.password.',
  passphrase: 'easy-gpu.passphrase.'
};
const HOST_KEY_PREFIX = 'easy-gpu.hostkey.';

/** 登录密码与私钥口令都存入 VS Code SecretStorage（背后是系统钥匙串）。 */
export class SecretCredentialStore implements CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(host: string, kind: SecretKind): Promise<string | undefined> {
    return this.secrets.get(SECRET_PREFIX[kind] + host);
  }

  async store(host: string, kind: SecretKind, value: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX[kind] + host, value);
  }

  async delete(host: string, kind: SecretKind): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX[kind] + host);
  }
}

/** 主机密钥指纹存到 globalState（不是敏感数据）。 */
export class HostKeyStoreAdapter implements HostKeyStore {
  constructor(private readonly memento: vscode.Memento) {}

  get(key: string): string | undefined {
    return this.memento.get<string>(HOST_KEY_PREFIX + key);
  }

  set(key: string, fingerprint: string): void {
    void this.memento.update(HOST_KEY_PREFIX + key, fingerprint);
  }
}

/** 用输入框收集登录密码 / 私钥口令，用弹窗确认主机密钥变化。 */
export class VsCodeAuthInteraction implements AuthInteraction {
  constructor(private readonly rememberPassword: () => boolean) {}

  async promptPassword(host: string): Promise<string | undefined> {
    const suffix = this.rememberPassword() ? '（连接成功后会保存到系统钥匙串）' : '';
    const password = await vscode.window.showInputBox({
      title: `Easy GPU：输入 ${host} 的 SSH 密码`,
      prompt: `密钥 / ssh-agent 未通过，请输入密码${suffix}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value ? undefined : '密码不能为空')
    });
    return password || undefined;
  }

  async promptPassphrase(host: string, keyPath: string): Promise<string | undefined> {
    const suffix = this.rememberPassword() ? '（会保存到系统钥匙串）' : '';
    const passphrase = await vscode.window.showInputBox({
      title: `Easy GPU：输入私钥口令（${host}）`,
      prompt: `私钥已加密：${keyPath}，请输入它的口令${suffix}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value ? undefined : '口令不能为空')
    });
    return passphrase || undefined;
  }

  async confirmNewHostKey(host: string, fingerprint: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Easy GPU：${host} 的主机密钥与上次记录不一致，已阻止连接。\n新指纹：${fingerprint}\n\n只有在你确认服务器重装或更换过密钥时才应信任。`,
      { modal: true },
      '信任并继续'
    );
    return choice === '信任并继续';
  }
}