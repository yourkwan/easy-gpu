import * as vscode from 'vscode';
import { MonitorState, Snapshot } from './types';

function formatGB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0';
  }
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1);
}

function formatMB(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) {
    return '0';
  }
  const gb = mb / 1024;
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1);
}

/** 状态栏概览：GPU 显存/温度 + CPU + 内存。 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'easy-gpu.openDashboard';
    this.item.name = 'Easy GPU';
  }

  setVisible(visible: boolean): void {
    if (visible) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  update(state: MonitorState): void {
    this.item.backgroundColor = undefined;

    if (state.status === 'idle' || !state.host) {
      this.item.text = '$(server) Easy GPU · 未配置服务器';
      this.item.tooltip = '点击打开监控面板并选择 SSH 服务器';
      return;
    }

    if (state.status === 'connecting' && !state.snapshot) {
      this.item.text = '$(sync~spin) Easy GPU · 连接中…';
      this.item.tooltip = `正在连接 ${state.host}`;
      return;
    }

    if (state.status === 'error') {
      this.item.text = '$(server) Easy GPU · 连接失败';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**Easy GPU 连接失败**\n\n\`${state.host}\`\n\n${state.error ?? '未知错误'}\n\n点击查看详情`);
      this.item.tooltip = tooltip;
      return;
    }

    const snapshot = state.snapshot;
    if (!snapshot) {
      this.item.text = '$(server) Easy GPU · 等待数据';
      return;
    }

    this.item.text = this.formatSummary(snapshot);
    this.item.tooltip = this.buildTooltip(state.host, snapshot);
  }

  private formatSummary(snapshot: Snapshot): string {
    const parts: string[] = [];

    if (snapshot.gpus.length) {
      // 以显存为主：GPU 显存用量 + 最高温度
      const used = snapshot.gpus.reduce((a, g) => a + g.memoryUsed, 0);
      const total = snapshot.gpus.reduce((a, g) => a + g.memoryTotal, 0);
      const temps = snapshot.gpus.map((g) => g.temperature).filter((v): v is number => typeof v === 'number');
      const maxTemp = temps.length ? Math.max(...temps) : null;
      const prefix = snapshot.gpus.length > 1 ? `GPU×${snapshot.gpus.length}` : 'GPU';
      const segments = [`${prefix} 显存 ${formatMB(used)}/${formatMB(total)}G`];
      if (maxTemp !== null) {
        segments.push(`${maxTemp}°C`);
      }
      parts.push(segments.join(' · '));
    } else {
      parts.push('无 GPU');
    }

    if (snapshot.cpu.usage !== null) {
      parts.push(`CPU ${snapshot.cpu.usage.toFixed(0)}%`);
    }

    if (snapshot.memory.total > 0) {
      parts.push(`RAM ${formatGB(snapshot.memory.used)}/${formatGB(snapshot.memory.total)}G`);
    }

    return `$(server) ${parts.join(' | ')}`;
  }

  private buildTooltip(host: string, snapshot: Snapshot): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${snapshot.hostname}** \`${host}\`\n\n`);

    if (snapshot.gpus.length) {
      const used = snapshot.gpus.reduce((a, g) => a + g.memoryUsed, 0);
      const total = snapshot.gpus.reduce((a, g) => a + g.memoryTotal, 0);
      tooltip.appendMarkdown(`显存合计 **${formatMB(used)} / ${formatMB(total)} GB**（${snapshot.gpus.length} 张卡）\n\n`);
    }

    for (const gpu of snapshot.gpus) {
      const temp = gpu.temperature !== null ? `${gpu.temperature}°C` : '—';
      const util = gpu.utilization !== null ? `${gpu.utilization}%` : '—';
      // 与 gpustat 一致：逐进程展示，不按用户合并
      const procText = gpu.processes.length
        ? gpu.processes.map((p) => `${p.user}(${p.memory}M)`).join(' ')
        : '空闲';
      tooltip.appendMarkdown(
        `- \`[${gpu.index}]\` ${gpu.name} · ${temp} · ${util} · ${gpu.memoryUsed}/${gpu.memoryTotal} MB · ${procText}\n`
      );
    }

    if (!snapshot.gpus.length) {
      tooltip.appendMarkdown(snapshot.nvidiaSmi ? '- 无 GPU 记录\n' : '- 未检测到 nvidia-smi\n');
    }

    if (snapshot.cpu.usage !== null) {
      tooltip.appendMarkdown(`\nCPU ${snapshot.cpu.usage.toFixed(1)}%（${snapshot.cpu.cores} 核）\n`);
    }
    tooltip.appendMarkdown(
      `内存 ${formatGB(snapshot.memory.used)} / ${formatGB(snapshot.memory.total)} GB（可用 ${formatGB(snapshot.memory.available)} GB）\n\n`
    );
    tooltip.appendMarkdown('点击打开监控面板');
    return tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}