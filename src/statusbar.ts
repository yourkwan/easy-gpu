import * as vscode from 'vscode';
import { MonitorService } from './service';
import { Snapshot } from './types';

/**
 * 原生状态栏：状态点 + 显存合计（如「● 72.0/96.0G」）。
 * 状态点按连接状态变色；点击展开侧边栏「监控」；悬停看每卡显存进度条。
 */
export class MonitorStatusBar implements vscode.Disposable {
  private readonly dot: vscode.StatusBarItem;
  private readonly text: vscode.StatusBarItem;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly service: MonitorService) {
    // priority 越大越靠左：状态点在显存文本左侧
    this.dot = vscode.window.createStatusBarItem('easy-gpu.statusDot', vscode.StatusBarAlignment.Right, 200);
    this.text = vscode.window.createStatusBarItem('easy-gpu.statusVram', vscode.StatusBarAlignment.Right, 199);
    this.dot.name = 'Easy GPU 状态';
    this.text.name = 'Easy GPU 显存';
    const command = 'workbench.view.extension.easy-gpu';
    this.dot.command = command;
    this.text.command = command;

    this.disposable = this.service.onDidChange(() => this.update());
    this.update();
    this.dot.show();
    this.text.show();
  }

  update(): void {
    const state = this.service.getState();
    const snapshot = state.snapshot;

    if (state.status === 'ok' && snapshot) {
      this.dot.text = '●';
      this.dot.color = new vscode.ThemeColor('terminal.ansiGreen');
      this.text.text = vramTotal(snapshot);
      this.text.color = undefined;
    } else if (state.status === 'connecting') {
      this.dot.text = '●';
      this.dot.color = new vscode.ThemeColor('terminal.ansiBlue');
      this.text.text = '连接中…';
      this.text.color = undefined;
    } else if (state.status === 'error') {
      this.dot.text = '●';
      this.dot.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      this.text.text = '连接失败';
      this.text.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    } else {
      this.dot.text = '●';
      this.dot.color = undefined;
      this.text.text = '未连接';
      this.text.color = undefined;
    }

    const tooltip = this.buildTooltip(state.status, state.error, snapshot);
    this.dot.tooltip = tooltip;
    this.text.tooltip = tooltip;
  }

  private buildTooltip(status: string, error: string | undefined, snapshot: Snapshot | undefined): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    if (status === 'ok' && snapshot) {
      md.appendMarkdown(`**显存 ${vramTotal(snapshot)}**\n\n`);
      md.appendCodeblock(snapshot.gpus.map((gpu) => gpuBar(gpu)).join('\n'), '');
    } else if (status === 'connecting') {
      md.appendMarkdown('连接中…');
    } else if (status === 'error') {
      md.appendMarkdown(`连接失败：${error || '未知错误'}`);
    } else {
      md.appendMarkdown('未连接');
    }
    return md;
  }

  dispose(): void {
    this.disposable.dispose();
    this.dot.dispose();
    this.text.dispose();
  }
}

function vramTotal(snapshot: Snapshot): string {
  let used = 0;
  let total = 0;
  snapshot.gpus.forEach((gpu) => {
    used += gpu.memoryUsed;
    total += gpu.memoryTotal;
  });
  return `${fmtGB(used * 1024 * 1024)}/${fmtGB(total * 1024 * 1024)}G`;
}

function gpuBar(gpu: Snapshot['gpus'][number]): string {
  const pct = gpu.memoryTotal > 0 ? Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100) : 0;
  const filled = Math.round((pct / 100) * 16);
  const bar = '■'.repeat(filled) + '□'.repeat(16 - filled);
  const used = fmtGB((gpu.memoryUsed || 0) * 1024 * 1024);
  const total = fmtGB((gpu.memoryTotal || 0) * 1024 * 1024);
  return `GPU ${gpu.index}  ${bar}  ${used}/${total}G`;
}

function fmtGB(bytes: number): string {
  const gb = (bytes || 0) / 1024 / 1024 / 1024;
  return gb >= 100 ? gb.toFixed(0) : gb >= 10 ? gb.toFixed(1) : gb.toFixed(2);
}