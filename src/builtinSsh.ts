import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, ConnectConfig, utils as sshUtils } from 'ssh2';
import { SshAuthError, SshHostKeyError } from './errors';
import { BEGIN_MARKER, END_MARKER } from './parse';
import { resolveHost, ResolvedHost } from './sshConfig';

/** 保存到系统钥匙串的凭据类型：登录密码 / 私钥口令 */
export type SecretKind = 'password' | 'passphrase';

/** 凭据存取（扩展里由 VS Code SecretStorage / 系统钥匙串实现）。 */
export interface CredentialStore {
  get(host: string, kind: SecretKind): Promise<string | undefined>;
  store(host: string, kind: SecretKind, value: string): Promise<void>;
  delete(host: string, kind: SecretKind): Promise<void>;
}

/** 主机密钥指纹存取（用于首次信任 TOFU 与变更检测）。 */
export interface HostKeyStore {
  get(key: string): string | undefined;
  set(key: string, fingerprint: string): void;
}

/** 需要用户参与的交互（扩展里用输入框 / 弹窗实现）。 */
export interface AuthInteraction {
  /** 登录密码，返回 undefined 表示用户取消 */
  promptPassword(host: string): Promise<string | undefined>;
  /** 私钥口令，返回 undefined 表示用户取消（这次不使用该私钥） */
  promptPassphrase(host: string, keyPath: string): Promise<string | undefined>;
  /** 主机密钥变化时询问是否信任新密钥 */
  confirmNewHostKey(host: string, fingerprint: string): Promise<boolean>;
}

export interface BuiltinSshOptions {
  credentials: CredentialStore;
  hostKeys: HostKeyStore;
  interaction: AuthInteraction;
  rememberPassword: () => boolean;
  /** 用户显式指定的私钥文件；返回空表示使用 ~/.ssh/config 与 ~/.ssh 默认密钥 */
  privateKeyPath?: () => string | undefined;
}

interface ActiveSession {
  client: Client;
  target: string;
}

interface PreparedKey {
  path: string;
  content: string;
  passphrase?: string;
}

const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function readTextFile(file: string): string | undefined {
  try {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return fs.readFileSync(file, 'utf8');
    }
  } catch {
    // 忽略不可读文件
  }
  return undefined;
}

function isPuTTYKey(content: string): boolean {
  return /PuTTY-User-Key-File/i.test(content.slice(0, 128));
}

/**
 * 内置 SSH 客户端（ssh2）：支持密码、私钥文件、私钥口令、ssh-agent 与 keyboard-interactive，
 * 复用长连接，首次连接记录主机密钥指纹（TOFU），密钥变化时要求用户确认。
 */
export class BuiltinSshTransport {
  private session?: ActiveSession;
  private pendingHostKey?: { storeKey: string; fingerprint: string };

  constructor(private readonly options: BuiltinSshOptions) {}

  async hasStoredPassword(host: string): Promise<boolean> {
    return Boolean(await this.options.credentials.get(host, 'password'));
  }

  dispose(): void {
    this.closeSession();
  }

  async exec(input: string, script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const client = await this.ensureClient(input, timeoutMs);
    try {
      return await this.execOn(client, script, timeoutMs);
    } catch (error) {
      if (isConnectionLevelError(error)) {
        this.closeSession();
      }
      throw error;
    }
  }

  // ---------------- 连接管理 ----------------

  private async ensureClient(input: string, timeoutMs: number): Promise<Client> {
    const resolved = resolveHost(input);
    const target = `${resolved.user}@${resolved.host}:${resolved.port}`;
    if (this.session && this.session.target === target) {
      return this.session.client;
    }
    this.closeSession();

    const prepared = await this.prepareKey(input, resolved);
    let password = await this.options.credentials.get(input, 'password');
    let client: Client | undefined;

    // 第一次尝试：已保存的密码 + 私钥（或私钥口令）+ ssh-agent
    try {
      client = await this.connectWithHostKeyRetry(resolved, {
        password,
        privateKey: prepared?.content,
        passphrase: prepared?.passphrase,
        timeoutMs
      });
    } catch (error) {
      if (!(error instanceof SshAuthError)) {
        throw error;
      }
      if (password) {
        // 保存的密码可能已失效，清掉后让用户重新输入
        await this.options.credentials.delete(input, 'password');
        password = undefined;
      }
    }

    // 第二次尝试：弹框输入登录密码
    if (!client) {
      const entered = await this.options.interaction.promptPassword(input);
      if (!entered) {
        throw new SshAuthError('已取消输入密码', true);
      }
      client = await this.connectWithHostKeyRetry(resolved, {
        password: entered,
        privateKey: prepared?.content,
        passphrase: prepared?.passphrase,
        timeoutMs
      });
      if (this.options.rememberPassword()) {
        await this.options.credentials.store(input, 'password', entered);
      }
    }

    const active = client;
    this.session = { client: active, target };
    active.on('close', () => this.clearIfCurrent(active));
    active.on('error', () => this.clearIfCurrent(active));
    return active;
  }

  /**
   * 准备私钥：显式配置的路径优先，否则用 ssh config 的 IdentityFile 与 ~/.ssh 默认密钥。
   * 未加密的私钥直接使用；加密私钥先用已保存口令解锁，必要时弹框询问。
   */
  private async prepareKey(input: string, resolved: ResolvedHost): Promise<PreparedKey | undefined> {
    const configured = this.options.privateKeyPath?.()?.trim();
    const configuredPath = configured ? expandHome(configured) : undefined;
    const candidates = configuredPath
      ? [configuredPath]
      : [...resolved.identityFiles, ...DEFAULT_IDENTITY_FILES.map((name) => path.join(os.homedir(), '.ssh', name))];

    let encrypted: { path: string; content: string } | undefined;

    for (const file of candidates) {
      const content = readTextFile(file);
      if (!content) {
        if (configuredPath && file === configuredPath) {
          throw new Error(`找不到私钥文件：${configuredPath}（请在设置 easy-gpu.privateKeyPath 中检查路径）`);
        }
        continue;
      }
      if (isPuTTYKey(content)) {
        if (configuredPath && file === configuredPath) {
          throw new Error(
            `私钥 ${file} 是 PuTTY 的 .ppk 格式，OpenSSH 与内置客户端都无法直接使用：请用 PuTTYgen 打开它，通过「Conversions → Export OpenSSH key」导出 OpenSSH 格式后再选择`
          );
        }
        continue;
      }
      const parsed = sshUtils.parseKey(content);
      if (!(parsed instanceof Error)) {
        return { path: file, content };
      }
      if (/Encrypted private/i.test(parsed.message) && !encrypted) {
        encrypted = { path: file, content };
      }
    }

    if (!encrypted) {
      return undefined;
    }

    // 加密私钥：先试保存的口令
    let passphrase = await this.options.credentials.get(input, 'passphrase');
    if (passphrase) {
      if (!(sshUtils.parseKey(encrypted.content, passphrase) instanceof Error)) {
        return { path: encrypted.path, content: encrypted.content, passphrase };
      }
      await this.options.credentials.delete(input, 'passphrase');
      passphrase = undefined;
    }

    // 弹框询问私钥口令
    const entered = await this.options.interaction.promptPassphrase(input, encrypted.path);
    if (!entered) {
      return undefined;
    }
    if (sshUtils.parseKey(encrypted.content, entered) instanceof Error) {
      throw new Error(`私钥口令不正确，无法解锁 ${encrypted.path}`);
    }
    if (this.options.rememberPassword()) {
      await this.options.credentials.store(input, 'passphrase', entered);
    }
    return { path: encrypted.path, content: encrypted.content, passphrase: entered };
  }

  private async connectWithHostKeyRetry(
    resolved: ResolvedHost,
    auth: { password?: string; privateKey?: string; passphrase?: string; timeoutMs: number }
  ): Promise<Client> {
    try {
      return await this.connect(resolved, auth);
    } catch (error) {
      const pending = this.pendingHostKey;
      this.pendingHostKey = undefined;
      if (error instanceof SshHostKeyError && pending) {
        const trusted = await this.options.interaction.confirmNewHostKey(resolved.input, pending.fingerprint);
        if (trusted) {
          this.options.hostKeys.set(pending.storeKey, pending.fingerprint);
          return await this.connect(resolved, auth);
        }
      }
      throw error;
    }
  }

  private connect(
    resolved: ResolvedHost,
    auth: { password?: string; privateKey?: string; passphrase?: string; timeoutMs: number }
  ): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        client.end();
        reject(error);
      };
      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(client);
      };

      const config: ConnectConfig = {
        host: resolved.host,
        port: resolved.port,
        username: resolved.user,
        readyTimeout: Math.min(20000, Math.max(5000, auth.timeoutMs)),
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        hostVerifier: (key: Buffer) => this.verifyHostKey(resolved, key)
      };

      if (auth.password) {
        config.password = auth.password;
      }
      if (auth.privateKey) {
        config.privateKey = auth.privateKey;
        if (auth.passphrase) {
          config.passphrase = auth.passphrase;
        }
      }

      const agentPath = process.env.SSH_AUTH_SOCK;
      if (agentPath && fs.existsSync(agentPath)) {
        config.agent = agentPath;
      }

      // 部分服务器的「密码登录」实际走 keyboard-interactive，这里直接回填密码
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => auth.password ?? ''));
      });

      client.on('ready', succeed);
      client.on('error', (error: Error & { level?: string }) => fail(this.describeError(error)));
      client.connect(config);
    });
  }

  private verifyHostKey(resolved: ResolvedHost, key: Buffer): boolean {
    const fingerprint = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const storeKey = `${resolved.host}:${resolved.port}`;
    const known = this.options.hostKeys.get(storeKey);
    if (!known) {
      // 首次连接：信任并记录（TOFU）
      this.options.hostKeys.set(storeKey, fingerprint);
      return true;
    }
    if (known === fingerprint) {
      return true;
    }
    this.pendingHostKey = { storeKey, fingerprint };
    return false;
  }

  private describeError(error: Error & { level?: string }): Error {
    const message = error.message ?? String(error);
    if (/All configured authentication methods failed/i.test(message) || error.level === 'client-authentication') {
      return new SshAuthError('SSH 认证失败：用户名、密码或密钥不正确');
    }
    if (/Host denied|verification failed|Host verification failed|Host key verification/i.test(message)) {
      return new SshHostKeyError('主机密钥与已记录的不一致，已阻止连接', this.pendingHostKey?.fingerprint);
    }
    if (/Encrypted private key/i.test(message)) {
      return new Error('私钥已加密：请设置私钥口令，或先用 ssh-add 加入 ssh-agent');
    }
    if (/Timed out while waiting for handshake|ETIMEDOUT/i.test(message)) {
      return new Error('连接超时：服务器不可达，请检查网络或地址');
    }
    if (/ECONNREFUSED/i.test(message)) {
      return new Error('连接被拒绝：请确认服务器 SSH 端口已开放');
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      return new Error(`无法解析服务器地址：${message}`);
    }
    return new Error(message);
  }

  // ---------------- 远程执行 ----------------

  private execOn(client: Client, script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        fn();
      };

      timer = setTimeout(
        () => finish(() => reject(new Error(`远程命令执行超时（${Math.round(timeoutMs / 1000)} 秒）`))),
        timeoutMs
      );

      client.exec('bash -s', (error, stream) => {
        if (error) {
          finish(() => reject(new Error(`无法执行远程命令：${error.message}`)));
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', () => {
          finish(() => {
            if (stdout.includes(BEGIN_MARKER) && stdout.includes(END_MARKER)) {
              resolve({ stdout, stderr });
              return;
            }
            const detail = stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop();
            reject(new Error(`远程采集失败${detail ? `：${detail}` : '：未找到采集脚本输出标记'}`));
          });
        });
        stream.end(script);
      });
    });
  }

  private clearIfCurrent(client: Client): void {
    if (this.session && this.session.client === client) {
      this.session = undefined;
    }
  }

  private closeSession(): void {
    const current = this.session;
    this.session = undefined;
    if (current) {
      try {
        current.client.end();
      } catch {
        // 连接已断开时忽略
      }
    }
  }
}

function isConnectionLevelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Not connected|Connection lost|No response from server|Channel open failure|ECONNRESET|EPIPE|socket hang up/i.test(
    message
  );
}