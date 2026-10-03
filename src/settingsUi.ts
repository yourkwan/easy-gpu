import * as vscode from 'vscode';
import { config, mergeProcesses, refreshInterval, showStatusBar } from './config';

interface SettingItem extends vscode.QuickPickItem {
  key?: 'refreshInterval' | 'showStatusBar' | 'mergeProcesses' | 'advanced';
}

/**
 * 面板右上角「设置」打开的一处式简洁设置：
 * 只用三项（刷新间隔 / 状态栏概览 / 进程合并），回车即可切换，不必去 VS Code 设置里翻。
 */
export async function showSimpleSettings(onChange: () => void): Promise<void> {
  const build = (): SettingItem[] => {
    const interval = refreshInterval();
    return [
      {
        label: '刷新间隔',
        description: `${interval} 秒`,
        detail: '自动刷新间隔，2–600 秒；回车后直接输入新值',
        key: 'refreshInterval'
      },
      {
        label: '状态栏显示概览',
        description: showStatusBar() ? '开' : '关',
        detail: '在编辑器左下角显示 GPU / CPU / 内存概览',
        picked: showStatusBar(),
        key: 'showStatusBar'
      },
      {
        label: '合并同一用户的进程',
        description: mergeProcesses() ? '开（同一用户合计显存）' : '关（每个进程单独显示）',
        detail: '例如 wzs 的三个进程合并为「wzs 16412M」；默认关闭，与 gpustat 一致',
        picked: mergeProcesses(),
        key: 'mergeProcesses'
      },
      { label: '在 VS Code 设置中打开', description: '上述三项之外的更多选项', key: 'advanced' }
    ];
  };

  return new Promise<void>((resolve) => {
    const quickPick = vscode.window.createQuickPick<SettingItem>();
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      quickPick.hide();
      quickPick.dispose();
      resolve();
    };

    quickPick.title = 'Easy GPU 设置';
    quickPick.placeholder = '回车切换开关；「刷新间隔」回车可直接输入新值';
    quickPick.items = build();
    quickPick.ignoreFocusOut = true;

    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];
      if (!picked?.key) {
        return;
      }
      if (picked.key === 'advanced') {
        finish();
        void vscode.commands.executeCommand('workbench.action.openSettings', 'easy-gpu');
        return;
      }
      if (picked.key === 'refreshInterval') {
        const value = await vscode.window.showInputBox({
          title: '自动刷新间隔（秒）',
          prompt: '2–600 之间的整数；间隔从每次刷新结束后开始计算',
          value: String(refreshInterval()),
          ignoreFocusOut: true,
          validateInput: (input) => {
            const seconds = Number(input.trim());
            if (!Number.isFinite(seconds) || seconds < 2 || seconds > 600) {
              return '请输入 2–600 之间的数字';
            }
            return undefined;
          }
        });
        if (value === undefined) {
          return;
        }
        await config().update('refreshInterval', Number(value.trim()), vscode.ConfigurationTarget.Global);
      } else {
        await config().update(picked.key, !picked.picked, vscode.ConfigurationTarget.Global);
      }
      onChange();
      quickPick.items = build();
    });

    quickPick.onDidHide(() => finish());
    quickPick.show();
  });
}