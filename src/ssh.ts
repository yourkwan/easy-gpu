import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { SshAuthError, SshHostKeyError } from './errors';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
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
            ? '未找到系统 ssh 命令。免密登录需要 OpenSSH 客户端；也可以在「Easy GPU: 管理连接与密码」里把该连接的登录方式改成「密码」或「私钥文件」（走内置客户端，无需系统 ssh）'
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
        reject(classifySshFailure(code, stderr.trim()));
      });
    });

    child.stdin.on('error', () => {
      // 远程命令提前退出时 stdin 可能被关闭，忽略该错误
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

/** 把 ssh 的退出码与 stderr 归类为可识别的错误类型。 */
export function classifySshFailure(code: number | null, stderr: string): Error {
  if (code === 255) {
    if (/Permission denied|Too many authentication failures|no supported authentication methods/i.test(stderr)) {
      return new SshAuthError(
        'SSH 认证失败：密钥 / ssh-agent 未通过。可在终端执行 ssh-copy-id 配置免密，或使用密码登录（命令：Easy GPU: 设置 SSH 密码）'
      );
    }
    if (/Host key verification failed/i.test(stderr)) {
      return new SshHostKeyError('主机密钥校验失败：请先在终端手动 ssh 一次并确认指纹');
    }
    if (/Could not resolve hostname/i.test(stderr)) {
      return new Error(`无法解析服务器地址：${stderr.split('\n')[0]}`);
    }
    if (/Connection refused/i.test(stderr)) {
      return new Error('连接被拒绝：请确认服务器 SSH 端口已开放');
    }
    if (/Connection timed out|No route to host/i.test(stderr)) {
      return new Error('连接超时：服务器不可达，请检查网络或地址');
    }
    return new Error(`SSH 连接失败：${stderr.split('\n').filter(Boolean).pop() ?? '未知错误'}`);
  }
  const detail = stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop();
  return new Error(`远程命令执行失败（退出码 ${code}）${detail ? `：${detail}` : ''}`);
}