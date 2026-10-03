import * as vscode from 'vscode';

/** 设置项的集中出口：只保留真正有用的三项。 */
export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('easy-gpu');
}

/** 自动刷新间隔（秒），范围 2–600。 */
export function refreshInterval(): number {
  const value = config().get<number>('refreshInterval', 5);
  return Math.min(600, Math.max(2, Number.isFinite(value) ? value : 5));
}

/** 状态栏是否显示概览。 */
export function showStatusBar(): boolean {
  return config().get<boolean>('showStatusBar', true);
}

/** 是否把同一用户的多个进程合并为一条（默认不合并，逐个进程显示）。 */
export function mergeProcesses(): boolean {
  return config().get<boolean>('mergeProcesses', false);
}