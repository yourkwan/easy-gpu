import * as vscode from 'vscode';
import { collectSnapshot } from './collector';
import { MonitorState } from './types';

/** 负责按配置的间隔轮询远程服务器，并广播最新状态。 */
export class MonitorService implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<MonitorState>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private state: MonitorState = { status: 'idle', host: '' };
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

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

  private get extraArgs(): string[] {
    const value = vscode.workspace.getConfiguration('easy-gpu').get<string[]>('sshExtraArgs', []);
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  }

  /** 启动（或重启）轮询。 */
  start(): void {
    this.stop();
    const host = this.host;
    if (!host) {
      this.update({ status: 'idle', host: '', error: undefined });
      return;
    }
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

  async refresh(): Promise<void> {
    const host = this.host;
    if (!host) {
      this.update({ status: 'idle', host: '', error: undefined });
      return;
    }
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.update({ status: 'connecting', host, error: undefined });
    try {
      const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'scripts', 'collect.sh').fsPath;
      const snapshot = await collectSnapshot(host, scriptPath, this.extraArgs);
      this.update({ status: 'ok', host, snapshot, updatedAt: Date.now(), error: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ status: 'error', host, error: message });
    } finally {
      this.inFlight = false;
    }
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