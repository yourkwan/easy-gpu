import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshHostEntry {
  alias: string;
  hostName?: string;
  user?: string;
  port?: string;
}

/** 解析 ~/.ssh/config（仅处理常见字段），用于在 QuickPick 中列出可选服务器。 */
export function readSshConfigHosts(configPath = path.join(os.homedir(), '.ssh', 'config')): SshHostEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }

  const entries: SshHostEntry[] = [];
  let current: SshHostEntry | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === 'host') {
      // 一个 Host 行可能带多个别名，仅取第一个非通配别名
      const aliases = value.split(/\s+/).filter((a) => !a.includes('*') && !a.includes('?'));
      if (aliases.length) {
        current = { alias: aliases[0] };
        entries.push(current);
      } else {
        current = undefined;
      }
    } else if (current) {
      if (key === 'hostname') {
        current.hostName = value;
      } else if (key === 'user') {
        current.user = value;
      } else if (key === 'port') {
        current.port = value;
      }
    }
  }
  return entries;
}

function baseSshArgs(): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=15'
  ];
  // Windows 自带 OpenSSH 不支持连接复用，仅在类 Unix 平台启用
  if (process.platform !== 'win32') {
    const controlPath = path.join(os.tmpdir(), 'easy-gpu-%r@%h-%p');
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=120');
  }
  return args;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * 通过系统 ssh 在远程执行脚本（脚本从 stdin 以 `bash -s` 方式传入），
 * 复用 ~/.ssh/config、私钥与 ssh-agent，不处理任何密码输入。
 */
export function runRemoteScript(
  host: string,
  script: string,
  extraArgs: string[],
  timeoutMs: number
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const args = [...baseSshArgs(), ...extraArgs, host, 'bash -s'];
    const child = spawn('ssh', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
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

    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒），请检查服务器地址或网络`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      finish(() => {
        const message =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? '未找到系统 ssh 命令，请先安装 OpenSSH 客户端'
            : `无法启动 ssh：${err.message}`;
        reject(new Error(message));
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr, code });
          return;
        }
        const detail = friendlySshError(code, stderr.trim());
        reject(new Error(detail));
      });
    });

    child.stdin.on('error', () => {
      // 远程命令提前退出时 stdin 可能被关闭，忽略该错误
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

function friendlySshError(code: number | null, stderr: string): string {
  if (code === 255) {
    if (/Permission denied/i.test(stderr)) {
      return 'SSH 认证失败：请确认已配置免密登录（ssh-copy-id 或 ssh-agent），本扩展不支持交互式输入密码';
    }
    if (/Could not resolve hostname/i.test(stderr)) {
      return `无法解析服务器地址：${stderr.split('\n')[0]}`;
    }
    if (/Connection refused/i.test(stderr)) {
      return '连接被拒绝：请确认服务器 SSH 端口已开放';
    }
    if (/Connection timed out|No route to host/i.test(stderr)) {
      return '连接超时：服务器不可达，请检查网络或地址';
    }
    if (/Host key verification failed/i.test(stderr)) {
      return '主机密钥校验失败：请先在终端手动 ssh 一次并确认指纹';
    }
    return `SSH 连接失败：${stderr.split('\n').filter(Boolean).pop() ?? '未知错误'}`;
  }
  const firstLine = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return `远程命令执行失败（退出码 ${code}）${firstLine ? `：${firstLine}` : ''}`;
}