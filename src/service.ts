import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuiltinSshTransport } from './builtinSsh';
import { COLLECT_TIMEOUT_MS, collectSnapshot } from './collector';
import { SshAuthError } from './errors';
import { refreshInterval as configuredRefreshInterval } from './config';
import { profileLabel, ProfileStore, sshHostArg, sshTarget, StoredProfile } from './profiles';
import { runRemoteScript } from './ssh';
import { Channel, MonitorState } from './types';

/** 按配置的间隔轮询当前连接（密码 / 私钥走内置客户端，免密走系统 ssh），并广播最新状态。 */
export class MonitorService implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<MonitorState>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private state: MonitorState = { status: 'idle', host: '' };
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  /** 用户取消过密码输入的连接：自动刷新时不再反复弹框，手动刷新会重置 */
  private declinedProfile?: string;
  /** 本次刷新实际使用的通道，用于诊断耗时 */
  private lastChannel?: Channel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly builtin: BuiltinSshTransport,
    private readonly profiles: ProfileStore
  ) {}

  getState(): MonitorState {
    return this.state;
  }

  get profile(): StoredProfile | undefined {
    return this.profiles.current();
  }

  /** 当前连接的展示名（user@host），未配置时为空 */
  get host(): string {
    const profile = this.profile;
    return profile ? profileLabel(profile) : '';
  }

  get refreshInterval(): number {
    return configuredRefreshInterval();
  }

  /** 启动（或重启）轮询。 */
  start(): void {
    this.stop();
    const profile = this.profile;
    if (!profile) {
      this.update({ status: 'idle', host: '', error: undefined });
      return;
    }
    this.declinedProfile = undefined;
    this.update({ status: this.state.snapshot ? 'ok' : 'connecting', host: profileLabel(profile), error: undefined });
    void this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 本次刷新结束后再等一个间隔。
   * 用 setTimeout 链而不是 setInterval：间隔锚定在「数据到达」这一刻，面板倒计时才与实际节奏一致；
   * 刷新本身耗时超过间隔时也不会叠加重试（同一时间只跑一个刷新）。
   */
  private scheduleNext(): void {
    this.stop();
    if (!this.profile) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.refreshInterval * 1000);
  }

  async refresh(options: { manual?: boolean } = {}): Promise<void> {
    const profile = this.profile;
    if (!profile) {
      this.update({ status: 'idle', host: '', error: undefined });
      return;
    }
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.stop();
    this.lastChannel = undefined;
    const startedAt = Date.now();
    const host = profileLabel(profile);
    this.update({ status: 'connecting', host, error: undefined });

    try {
      const script = this.readScript();
      const snapshot = await collectSnapshot(script, (code) => this.runCollect(profile, code, options));
      this.update({
        status: 'ok',
        host,
        snapshot,
        updatedAt: Date.now(),
        error: undefined,
        channel: this.lastChannel,
        durationMs: Date.now() - startedAt
      });
      this.declinedProfile = undefined;
    } catch (error) {
      if (error instanceof SshAuthError && error.cancelled) {
        this.declinedProfile = profile.id;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.update({
        status: 'error',
        host,
        error: message,
        channel: this.lastChannel,
        durationMs: Date.now() - startedAt
      });
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }

  /** 按连接配置的登录方式选择传输通道。 */
  private async runCollect(
    profile: StoredProfile,
    script: string,
    options: { manual?: boolean }
  ): Promise<string> {
    if (options.manual) {
      // 手动重试时允许重新弹出密码框
      this.declinedProfile = undefined;
    }
    if (this.declinedProfile === profile.id) {
      throw new SshAuthError('需要密码登录：点击「立即重试」可再次弹出密码输入框', false);
    }

    // 密码 / 指定私钥：走内置客户端，认证信息与错误提示都更明确
    if (profile.auth === 'password' || profile.auth === 'key') {
      this.lastChannel = 'builtin';
      const result = await this.builtin.exec(sshTarget(profile), script, COLLECT_TIMEOUT_MS, {
        credentialKey: profile.id,
        keyPath: profile.keyPath
      });
      return result.stdout;
    }

    // ssh-agent / 免密：复用系统 ssh 的 ~/.ssh/config、ssh-agent、ProxyJump 等
    try {
      const target = sshHostArg(profile);
      const portArgs = profile.port !== 22 ? ['-p', String(profile.port)] : [];
      const result = await runRemoteScript(target, script, portArgs, COLLECT_TIMEOUT_MS);
      this.lastChannel = 'systemSsh';
      return result.stdout;
    } catch (error) {
      if (error instanceof SshAuthError) {
        throw new SshAuthError(
          '免密登录（密钥 / ssh-agent）未通过。执行「Easy GPU: 管理连接与密码」，把这条连接的登录方式改成密码或指定私钥即可。'
        );
      }
      throw error;
    }
  }

  private readScript(): string {
    const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'scripts', 'collect.sh').fsPath;
    return fs.readFileSync(scriptPath, 'utf8');
  }

  private update(patch: Partial<MonitorState>): void {
    this.state = { ...this.state, ...patch };
    this.onDidChangeEmitter.fire(this.state);
  }

  dispose(): void {
    this.stop();
    this.onDidChangeEmitter.dispose();
  }
}