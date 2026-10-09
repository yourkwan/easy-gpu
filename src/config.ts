import * as vscode from 'vscode';
import { AccentColor } from './types';

/** 设置项的集中出口：刷新间隔 / 颜色风格 / 合并进程。 */
export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('easy-gpu');
}

/** 自动刷新间隔（秒），范围 2–600。 */
export function refreshInterval(): number {
  const value = config().get<number>('refreshInterval', 5);
  return Math.min(600, Math.max(2, Number.isFinite(value) ? value : 5));
}

/** 强调色风格（默认蓝）。 */
export function accentColor(): AccentColor {
  const value = config().get<string>('accentColor', 'blue');
  const valid: AccentColor[] = ['blue', 'cyan', 'green', 'purple', 'pink', 'orange', 'red'];
  return (valid as readonly string[]).includes(value) ? (value as AccentColor) : 'blue';
}

/** 是否把同一用户的多个进程合并为一条（默认不合并，逐个进程显示）。 */
export function mergeProcesses(): boolean {
  return config().get<boolean>('mergeProcesses', false);
}