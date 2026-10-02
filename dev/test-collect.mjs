#!/usr/bin/env node
/* 开发自测：验证 collect.sh + parse.js 的端到端数据管线 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { parseCollectorOutput, normalizeSnapshot } = require(path.join(projectRoot, 'out', 'parse.js'));

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function runCollector(withFakeGpu) {
  const env = { ...process.env };
  if (withFakeGpu) {
    env.PATH = path.join(projectRoot, 'dev', 'fixtures', 'fake-bin') + path.delimiter + env.PATH;
  }
  return execFileSync('bash', [path.join(projectRoot, 'scripts', 'collect.sh')], {
    env,
    encoding: 'utf8'
  });
}

console.log('1) 无 GPU 环境（真实本机）');
{
  const snapshot = parseCollectorOutput(runCollector(false));
  check('nvidiaSmi=false', snapshot.nvidiaSmi === false);
  check('gpus 为空', snapshot.gpus.length === 0);
  check('cpu.cores > 0', snapshot.cpu.cores > 0, `cores=${snapshot.cpu.cores}`);
  check('cpu.usage 在 0-100', snapshot.cpu.usage !== null && snapshot.cpu.usage >= 0 && snapshot.cpu.usage <= 100, `usage=${snapshot.cpu.usage}`);
  check('memory.total > 0', snapshot.memory.total > 0, `total=${snapshot.memory.total}`);
  check('memory.used <= total', snapshot.memory.used <= snapshot.memory.total);
}

console.log('2) 模拟 4×RTX 3090（gpustat 风格）');
{
  const smiLog = path.join(os.tmpdir(), 'easy-gpu-smi-calls.log');
  fs.rmSync(smiLog, { force: true });
  process.env.FAKE_SMI_LOG = smiLog;
  const snapshot = parseCollectorOutput(runCollector(true));
  delete process.env.FAKE_SMI_LOG;
  check('nvidiaSmi=true', snapshot.nvidiaSmi === true);
  check('4 张 GPU', snapshot.gpus.length === 4, `got=${snapshot.gpus.length}`);

  const g0 = snapshot.gpus[0];
  check('GPU0 名称', g0.name === 'NVIDIA GeForce RTX 3090', g0.name);
  check('GPU0 温度 71', g0.temperature === 71, String(g0.temperature));
  check('GPU0 利用率 61', g0.utilization === 61, String(g0.utilization));
  check('GPU0 显存 18610/24576', g0.memoryUsed === 18610 && g0.memoryTotal === 24576);
  check('GPU0 两个用户进程', g0.processes.length === 2);
  check('GPU0 lj=12454M', g0.processes[0].user === 'lj' && g0.processes[0].memory === 12454);
  check('GPU0 wzs=6140M', g0.processes[1].user === 'wzs' && g0.processes[1].memory === 6140);

  const g3 = snapshot.gpus[3];
  check('GPU3 六个进程', g3.processes.length === 6, `got=${g3.processes.length}`);
  check('GPU3 温度 83', g3.temperature === 83);
  check('GPU3 进程命令解析', g3.processes.every((p) => typeof p.command === 'string' && p.command.length > 0));

  // 性能回归：每次刷新只调用 2 次 nvidia-smi（uuid 与其它字段合并查询）
  const calls = fs.existsSync(smiLog)
    ? fs.readFileSync(smiLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  check('nvidia-smi 只调用 2 次（GPU 信息 + 进程）', calls.length === 2, `calls=${calls.length}`);
  check('GPU 查询已合并 uuid', calls.some((line) => line.includes('memory.total,uuid')), calls.join(' | '));
  fs.rmSync(smiLog, { force: true });
}

console.log('3) 容错：脏数据与缺失字段');
{
  const dirty = parseCollectorOutput(
    'Warning: motd banner\n@@EASYGPU_BEGIN@@\n{"hostname":"n1","gpus":[{"name":"A100","temperature":null,"utilization":"N/A"}]}\n@@EASYGPU_END@@\ntrailing'
  );
  check('标记外噪声被忽略', dirty.hostname === 'n1');
  check('temperature null 保留', dirty.gpus[0].temperature === null);
  check('非法 utilization 归一为 null', dirty.gpus[0].utilization === null);
  check('缺失字段有默认值', dirty.cpu.cores === 0 && dirty.memory.total === 0 && dirty.nvidiaSmi === false);

  let threw = false;
  try {
    parseCollectorOutput('no markers here');
  } catch {
    threw = true;
  }
  check('无标记时抛错', threw);

  const normalized = normalizeSnapshot({ gpus: [{ memoryUsed: 1024 }] });
  check('默认名称', normalized.gpus[0].name === 'GPU');
  check('timestamp 兜底', typeof normalized.timestamp === 'number' && normalized.timestamp > 0);
}

console.log('4) 经由 out/collector.js 的完整链路（假 ssh 本地执行）');
{
  const { collectSnapshot } = require(path.join(projectRoot, 'out', 'collector.js'));
  const { runRemoteScript } = require(path.join(projectRoot, 'out', 'ssh.js'));
  const script = fs.readFileSync(path.join(projectRoot, 'scripts', 'collect.sh'), 'utf8');
  process.env.PATH = path.join(projectRoot, 'dev', 'fixtures', 'fake-bin') + path.delimiter + process.env.PATH;
  const run = async (code) => (await runRemoteScript('fake-host', code, [], 25000)).stdout;
  const snapshot = await collectSnapshot(script, run);
  check('ssh 管道链路返回 4 张 GPU', snapshot.gpus.length === 4, `got=${snapshot.gpus.length}`);
  check('GPU2 显存来自真实脚本解析', snapshot.gpus[2].memoryUsed === 20319);
  check('GPU3 温度 83', snapshot.gpus[3].temperature === 83);
  check('hostname 解析', typeof snapshot.hostname === 'string' && snapshot.hostname.length > 0);
}

console.log('5) SSH 认证失败的友好提示（系统 ssh 路径）');
{
  const { collectSnapshot } = require(path.join(projectRoot, 'out', 'collector.js'));
  const { runRemoteScript } = require(path.join(projectRoot, 'out', 'ssh.js'));
  const { SshAuthError } = require(path.join(projectRoot, 'out', 'errors.js'));
  const script = fs.readFileSync(path.join(projectRoot, 'scripts', 'collect.sh'), 'utf8');
  process.env.EASYGUP_TEST_FAIL = '1';
  let error;
  try {
    await collectSnapshot(script, async (code) => (await runRemoteScript('fake-host', code, [], 25000)).stdout);
  } catch (err) {
    error = err;
  }
  delete process.env.EASYGUP_TEST_FAIL;
  check('抛出 SshAuthError 类型', error instanceof SshAuthError, String(error));
  check('提示免密或密码登录', /免密|密码/.test(error?.message ?? ''), error?.message);
}

console.log('6) ~/.ssh/config 解析与主机解析');
{
  const { resolveHost, readSshConfigHosts } = require(path.join(projectRoot, 'out', 'sshConfig.js'));
  const configPath = path.join(os.tmpdir(), 'easy-gpu-test-ssh-config');
  fs.writeFileSync(
    configPath,
    [
      'Host gpu',
      '  HostName 192.168.1.100',
      '  User yourkwan',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_work',
      '',
      'Host *',
      '  User defaultuser',
      ''
    ].join('\n')
  );

  const resolved = resolveHost('gpu', configPath);
  check('别名解析为真实地址', resolved.host === '192.168.1.100', resolved.host);
  check('端口来自配置', resolved.port === 2222, String(resolved.port));
  check('用户来自配置', resolved.user === 'yourkwan', resolved.user);
  check('IdentityFile 展开 ~', resolved.identityFiles[0] === path.join(os.homedir(), '.ssh', 'id_work'), resolved.identityFiles[0]);

  check('user@别名 中显式用户优先', resolveHost('someone@gpu', configPath).user === 'someone');
  check('host:port 覆盖配置端口', resolveHost('gpu:2200', configPath).port === 2200);

  const other = resolveHost('other-host', configPath);
  check('Host * 提供默认用户', other.user === 'defaultuser', other.user);
  check('未命中别名时主机名原样使用', other.host === 'other-host');

  const entries = readSshConfigHosts(configPath);
  check('别名列表只含字面别名', entries.length === 1 && entries[0].alias === 'gpu', JSON.stringify(entries.map((e) => e.alias)));

  fs.unlinkSync(configPath);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);