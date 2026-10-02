import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuiltinSshTransport } from './builtinSsh';
import { COLLECT_TIMEOUT_MS, collectSnapshot } from './collector';
import { SshAuthError } from './errors';
import { runRemoteScript } from './ssh';
import { ConnectionMode, Channel, MonitorState } from './types';

/** 负责按配置的间隔轮询远程服务器（系统 ssh 或内置客户端），并广播最新状态。 */
export class MonitorService implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<MonitorState>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private state: MonitorState = { status: 'idle', host: '' };
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  /** 用户取消过密码输入的主机：自动刷新时不再反复弹框，手动刷新会重置 */
  private declinedHost?: string;
  /** 本次刷新实际使用的通道，用于诊断耗时 */
  private lastChannel?: Channel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly builtin: BuiltinSshTransport
  ) {}

  getState(): MonitorState {
    return this.state;
  }

  get host(): string {
    return vscode.workspace.getConfiguration('easy-gpu').get<string>('host', '').trim();
  }

  get refreshInterval(): number {
    const value = vscode.workspace.getConfiguration('easy-gpu').get<number>('refreshInterval', 5);
    return Math.min(600, Math.max(2, Number.isFinite(value) ? value : 5));
  }

  get connectionMode(): ConnectionMode {
    const value = vscode.workspace.getConfiguration('easy-gpu').get<string>('connectionMode', 'auto');
    return value === 'systemSsh' || value === 'builtin' ? value : 'auto';
  }

  private get extraArgs(): string[] {
    const value = vscode.workspace.getConfiguration('easy-gpu').get<string[]>('sshExtraArgs', []);
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  }

  private get privateKeyPath(): string {
    return vscode.workspace.getConfiguration('easy-gpu').get<string>('privateKeyPath', '').trim();
  }

  /** 系统 ssh 的参数：额外参数 + 显式指定的私钥文件（-i） */
  private systemSshArgs(): string[] {
    const args = [...this.extraArgs];
    const keyPath = this.privateKeyPath;
    if (keyPath) {
      args.push('-i', keyPath);
    }
    return args;
  }

  /** 启动（或重启）轮询。 */
  start(): void {
    this.stop();
    const host = this.host;
    if (!host) {
      this.update({ status: 'idle', host: '', error: undefined });
      return;
    }
    this.declinedHost = undefined;
    this.update({ status: this.state.snapshot ? 'ok' : 'connecting', host, error: undefined });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshInterval * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(options: { manual?: boolean } = {}): Promise<void> {
    const host = this.host;
    if (!host) {
      this.update({ status: 'idle', host: '', error: undefined });
      return;
    }
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.lastChannel = undefined;
    const startedAt = Date.now();
    this.update({ status: 'connecting', host, error: undefined, mode: this.connectionMode });

    try {
      const script = this.readScript();
      const snapshot = await collectSnapshot(script, (code) => this.runCollect(host, code, options));
      this.update({
        status: 'ok',
        host,
        snapshot,
        updatedAt: Date.now(),
        error: undefined,
        mode: this.connectionMode,
        channel: this.lastChannel,
        durationMs: Date.now() - startedAt
      });
      this.declinedHost = undefined;
    } catch (error) {
      if (error instanceof SshAuthError && error.cancelled) {
        this.declinedHost = host;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.update({
        status: 'error',
        host,
        error: message,
        mode: this.connectionMode,
        channel: this.lastChannel,
        durationMs: Date.now() - startedAt
      });
    } finally {
      this.inFlight = false;
    }
  }

  /** 依据连接方式选择传输通道，并在需要时回退到内置客户端的密码登录。 */
  private async runCollect(host: string, script: string, options: { manual?: boolean }): Promise<string> {
    const mode = this.connectionMode;
    if (options.manual) {
      // 手动重试时允许重新弹出密码框
      this.declinedHost = undefined;
    }
    if (this.declinedHost === host) {
      throw new SshAuthError('需要密码登录：点击「立即重试」可再次弹出密码输入框', false);
    }

    const viaBuiltin = async () => {
      this.lastChannel = 'builtin';
      return (await this.builtin.exec(host, script, COLLECT_TIMEOUT_MS)).stdout;
    };

    if (mode === 'builtin') {
      return viaBuiltin();
    }
    // auto：已保存密码说明用户选择了密码登录，直接用内置客户端
    if (mode === 'auto' && (await this.builtin.hasStoredPassword(host))) {
      return viaBuiltin();
    }
    try {
      const result = await runRemoteScript(host, script, this.systemSshArgs(), COLLECT_TIMEOUT_MS);
      this.lastChannel = 'systemSsh';
      return result.stdout;
    } catch (error) {
      if (mode === 'auto' && error instanceof SshAuthError) {
        // 密钥 / agent 走不通：回退到内置客户端，必要时弹出密码框
        return viaBuiltin();
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