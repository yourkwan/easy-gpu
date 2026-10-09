import * as vscode from 'vscode';
import { config, refreshInterval } from './config';
import { AccentColor } from './types';

interface SettingItem extends vscode.QuickPickItem {
  key?: 'refreshInterval' | 'accentColor' | 'advanced';
}

const ACCENT_COLORS: { value: AccentColor; label: string }[] = [
  { value: 'blue', label: '蓝（默认）' },
  { value: 'cyan', label: '青' },
  { value: 'green', label: '绿' },
  { value: 'purple', label: '紫' },
  { value: 'pink', label: '粉' },
  { value: 'orange', label: '橙' },
  { value: 'red', label: '红' }
];

/** 极简 3 项设置：刷新间隔 / 颜色风格 / 更多设置（合并进程在侧边栏页面开关）。 */
export async function showSimpleSettings(onChange: () => void): Promise<void> {
  const build = (): SettingItem[] => {
    const interval = refreshInterval();
    const color = config().get<string>('accentColor', 'blue');
    const colorLabel = ACCENT_COLORS.find((c) => c.value === color)?.label ?? '蓝（默认）';
    return [
      {
        label: '刷新间隔',
        description: `${interval} 秒`,
        detail: '自动刷新间隔，2–600 秒；回车后直接输入新值',
        key: 'refreshInterval'
      },
      {
        label: '颜色风格',
        description: colorLabel,
        detail: '强调色：蓝 / 青 / 绿 / 紫 / 粉 / 橙 / 红',
        key: 'accentColor'
      },
      { label: '更多设置', description: '在 VS Code 设置中打开', key: 'advanced' }
    ];
  };

  return new Promise<void>((resolve) => {
    const quickPick = vscode.window.createQuickPick<SettingItem>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      quickPick.hide();
      quickPick.dispose();
      resolve();
    };

    quickPick.title = 'Easy GPU 设置';
    quickPick.placeholder = '「刷新间隔」回车可直接输入新值';
    quickPick.items = build();
    quickPick.ignoreFocusOut = true;

    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];
      if (!picked?.key) return;
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
        if (value === undefined) return;
        await config().update('refreshInterval', Number(value.trim()), vscode.ConfigurationTarget.Global);
      } else if (picked.key === 'accentColor') {
        const items = ACCENT_COLORS.map((c) => ({
          label: c.label,
          description: c.value === config().get<string>('accentColor', 'blue') ? '当前' : '',
          value: c.value
        }));
        const picked = await vscode.window.showQuickPick(items, {
          title: '选择强调色',
          ignoreFocusOut: true
        });
        if (!picked) return;
        await config().update('accentColor', picked.value, vscode.ConfigurationTarget.Global);
      }
      onChange();
      quickPick.items = build();
    });

    quickPick.onDidHide(() => finish());
    quickPick.show();
  });
}
