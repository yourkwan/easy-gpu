#!/usr/bin/env node
/*
 * 端到端测试：内置 SSH 客户端（ssh2）
 * 本地启动一个模拟 SSH 服务器（密码 + 公钥认证，exec 时用真实 bash 执行采集脚本），验证：
 * 密码登录、私钥文件登录、私钥口令、取消交互、主机密钥 TOFU 与变更确认、连接复用、.ppk 提示。
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ssh2 = require(path.join(projectRoot, 'node_modules', 'ssh2'));
const { Server } = ssh2;
const sshUtils = ssh2.utils;
const { BuiltinSshTransport } = require(path.join(projectRoot, 'out', 'builtinSsh.js'));
const { collectSnapshot } = require(path.join(projectRoot, 'out', 'collector.js'));
const { SshAuthError, SshHostKeyError } = require(path.join(projectRoot, 'out', 'errors.js'));

const SCRIPT = fs.readFileSync(path.join(projectRoot, 'scripts', 'collect.sh'), 'utf8');
const FAKE_BIN = path.join(projectRoot, 'dev', 'fixtures', 'fake-bin');
const SCRIPT_ENV = { ...process.env, PATH: FAKE_BIN + path.delimiter + process.env.PATH };
const USER = 'testuser';
const PASSWORD = 'secret123';
const TIMEOUT = 20000;

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function makeHostKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  return privateKey;
}

function makeClientKey(passphrase) {
  const pair = sshUtils.generateKeyPairSync(
    'ed25519',
    passphrase ? { passphrase, cipher: 'aes256-cbc' } : undefined
  );
  // 加密私钥需要口令才能解析出公钥 blob
  const parsed = sshUtils.parseKey(pair.private, passphrase);
  return { private: pair.private, publicBlob: parsed.getPublicSSH() };
}

/** 把私钥写入临时文件，返回路径 */
function writeTempKey(content, name) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-gpu-key-')), name);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

/** 启动模拟 SSH 服务器：密码认证 + 可选「只接受指定公钥」。 */
function startServer({ hostKey, port = 0, password = PASSWORD, allowPassword = true, allowedKeyBlob }) {
  const counters = { connections: 0, logins: 0, publicKeyAuth: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // 客户端拒绝主机密钥时会中止握手，真实 sshd 会容忍，这里也忽略
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        if (allowPassword && ctx.username === USER && ctx.password === password) {
          counters.logins++;
          ctx.accept();
          return;
        }
        ctx.reject(['publickey', 'password']);
        return;
      }
      if (ctx.method === 'publickey') {
        const matches = allowedKeyBlob && Buffer.compare(ctx.key.data, allowedKeyBlob) === 0;
        if (!matches) {
          ctx.reject(['publickey', 'password']);
          return;
        }
        if (ctx.signature) {
          counters.publicKeyAuth++;
        }
        ctx.accept();
        return;
      }
      ctx.reject(['publickey', 'password']);
    });
    client.on('ready', () => {
      counters.connections++;
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec) => {
          const stream = acceptExec();
          const child = spawn('bash', ['-s'], { env: SCRIPT_ENV });
          stream.pipe(child.stdin);
          child.stdout.on('data', (chunk) => stream.write(chunk));
          child.stderr.on('data', (chunk) => stream.stderr.write(chunk));
          child.on('close', (code) => {
            try {
              stream.exit(code ?? 0);
              stream.end();
            } catch {
              /* 已关闭时忽略 */
            }
          });
          stream.on('close', () => {
            try {
              child.kill();
            } catch {
              /* 忽略 */
            }
          });
        });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, counters }));
  });
}

function closeServer(handle) {
  return new Promise((resolve) => handle.server.close(() => resolve()));
}

/** 构造内置客户端，依赖全部用内存实现，便于断言交互行为。 */
function createTransport(options = {}) {
  const state = options.state ?? {
    password: options.savedPassword,
    passphrase: options.savedPassphrase,
    prompts: 0,
    passphrasePrompts: 0,
    confirmPrompts: 0,
    deleted: 0,
    // 主机密钥存储由调用方共享，模拟真实环境中跨会话持久化的 globalState
    hostKeys: options.hostKeys ?? new Map()
  };
  const transport = new BuiltinSshTransport({
    credentials: {
      get: async (_host, kind) => (kind === 'password' ? state.password : state.passphrase),
      store: async (_host, kind, value) => {
        if (kind === 'password') {
          state.password = value;
        } else {
          state.passphrase = value;
        }
      },
      delete: async (_host, kind) => {
        if (kind === 'password') {
          state.password = undefined;
          state.deleted++;
        } else {
          state.passphrase = undefined;
        }
      }
    },
    hostKeys: {
      get: (key) => state.hostKeys.get(key),
      set: (key, value) => state.hostKeys.set(key, value)
    },
    interaction: {
      promptPassword: async () => {
        state.prompts++;
        return options.enteredPassword;
      },
      promptPassphrase: async () => {
        state.passphrasePrompts++;
        return options.enteredPassphrase;
      },
      confirmNewHostKey: async () => {
        state.confirmPrompts++;
        return options.trustNewHostKey !== false;
      }
    },
    rememberPassword: () => options.remember !== false
  });
  return { transport, state, auth: options.keyPath ? { keyPath: options.keyPath } : {} };
}

const target = (port) => `${USER}@127.0.0.1:${port}`;
const collectVia = (transport, port, auth = {}) =>
  collectSnapshot(SCRIPT, async (code) => (await transport.exec(target(port), code, TIMEOUT, auth)).stdout);

async function execExpectError(transport, port, timeout = TIMEOUT, auth = {}) {
  try {
    await transport.exec(target(port), SCRIPT, timeout, auth);
    return undefined;
  } catch (error) {
    return error;
  }
}

console.log('1) 密码正确（已保存的密码）→ 采集成功且不弹框');
{
  const handle = await startServer({ hostKey: makeHostKey() });
  const { transport, state } = createTransport({ savedPassword: PASSWORD });
  const snapshot = await collectVia(transport, handle.port);
  check('采集到 4 张 GPU（真实执行 collect.sh）', snapshot.gpus.length === 4, `got=${snapshot.gpus.length}`);
  check('内存与 CPU 数据有效', snapshot.memory.total > 0 && snapshot.cpu.cores > 0);
  check('GPU0 用户 lj=12454M', snapshot.gpus[0].processes[0]?.user === 'lj' && snapshot.gpus[0].processes[0]?.memory === 12454);
  check('未弹出密码框', state.prompts === 0);
  transport.dispose();
  await closeServer(handle);
}

console.log('2) 密码错误 → 认证失败，且清除失效的保存密码');
{
  const handle = await startServer({ hostKey: makeHostKey() });
  const { transport, state } = createTransport({ savedPassword: 'wrong-password', enteredPassword: 'still-wrong' });
  const error = await execExpectError(transport, handle.port);
  check('抛出 SshAuthError', error instanceof SshAuthError, String(error));
  check('不是「用户取消」类型', error instanceof SshAuthError && error.cancelled === false);
  check('失效密码已被清除', state.deleted >= 1 && state.password === undefined);
  check('提示信息友好', /认证失败|密码|密钥/.test(error?.message ?? ''));
  transport.dispose();
  await closeServer(handle);
}

console.log('3) 无保存密码 → 弹框输入成功，并按设置记住密码');
{
  const handle = await startServer({ hostKey: makeHostKey() });
  const { transport, state } = createTransport({ enteredPassword: PASSWORD, remember: true });
  const snapshot = await collectVia(transport, handle.port);
  check('采集成功', snapshot.memory.total > 0);
  check('弹了一次密码框', state.prompts === 1, `prompts=${state.prompts}`);
  check('密码已写入凭据存储', state.password === PASSWORD);
  transport.dispose();
  await closeServer(handle);
}

console.log('4) 用户取消输入 → 抛出取消标记，且不保存密码');
{
  const handle = await startServer({ hostKey: makeHostKey() });
  const { transport, state } = createTransport({ enteredPassword: undefined });
  const error = await execExpectError(transport, handle.port);
  check('抛出取消类型的 SshAuthError', error instanceof SshAuthError && error.cancelled === true, String(error));
  check('未保存密码', state.password === undefined);
  check('弹了一次密码框', state.prompts === 1);
  transport.dispose();
  await closeServer(handle);
}

console.log('5) 关闭记住密码时不落盘');
{
  const handle = await startServer({ hostKey: makeHostKey() });
  const { transport, state } = createTransport({ enteredPassword: PASSWORD, remember: false });
  await transport.exec(target(handle.port), SCRIPT, TIMEOUT);
  check('密码未被保存', state.password === undefined);
  transport.dispose();
  await closeServer(handle);
}

console.log('6) 连接复用：多次采集只建立一条连接');
{
  const handle = await startServer({ hostKey: makeHostKey() });
  const { transport } = createTransport({ savedPassword: PASSWORD });
  await transport.exec(target(handle.port), SCRIPT, TIMEOUT);
  await transport.exec(target(handle.port), SCRIPT, TIMEOUT);
  await transport.exec(target(handle.port), SCRIPT, TIMEOUT);
  check('服务器只看到 1 次连接', handle.counters.connections === 1, `connections=${handle.counters.connections}`);
  check('认证只发生 1 次', handle.counters.logins === 1, `logins=${handle.counters.logins}`);
  transport.dispose();
  await closeServer(handle);
}

console.log('7) 主机密钥：首次信任（TOFU）与变更拦截');
{
  const keyA = makeHostKey();
  const keyB = makeHostKey();
  const sharedKeys = new Map();
  const first = await startServer({ hostKey: keyA });
  const port = first.port;

  const { transport, state } = createTransport({ savedPassword: PASSWORD, hostKeys: sharedKeys });
  await transport.exec(target(port), SCRIPT, TIMEOUT);
  check('首次连接后记录了主机密钥', state.hostKeys.size === 1);
  const fingerprintA = [...state.hostKeys.values()][0];
  transport.dispose();
  await closeServer(first);

  // 同一端口换成另一把主机密钥（模拟服务器重装 / 中间人）
  const second = await startServer({ hostKey: keyB, port });

  const rejected = createTransport({ savedPassword: PASSWORD, trustNewHostKey: false, hostKeys: sharedKeys });
  const keyError = await execExpectError(rejected.transport, port);
  check('密钥变化时抛出 SshHostKeyError', keyError instanceof SshHostKeyError, String(keyError));
  check('向用户询问了是否信任新密钥', rejected.state.confirmPrompts === 1);
  check('拒绝信任时指纹未被改写', [...sharedKeys.values()][0] === fingerprintA);
  rejected.transport.dispose();

  const accepted = createTransport({ savedPassword: PASSWORD, trustNewHostKey: true, hostKeys: sharedKeys });
  const trustedError = await execExpectError(accepted.transport, port);
  check('信任新密钥后连接成功', trustedError === undefined, String(trustedError));
  check('新指纹已替换旧记录', [...sharedKeys.values()][0] !== fingerprintA);
  accepted.transport.dispose();
  await closeServer(second);
}

console.log('8) 端口不可达 → 友好错误提示');
{
  const { transport } = createTransport({ savedPassword: PASSWORD });
  const error = await execExpectError(transport, 1, 5000);
  check('提示拒绝了连接或超时', /连接被拒绝|连接超时|ECONNREFUSED|ETIMEDOUT/i.test(error?.message ?? ''), String(error));
  transport.dispose();
}

console.log('9) 私钥文件登录（未加密私钥，密码登录被禁用）');
{
  const clientKey = makeClientKey();
  const keyFile = writeTempKey(clientKey.private, 'id_ed25519');
  const handle = await startServer({ hostKey: makeHostKey(), allowPassword: false, allowedKeyBlob: clientKey.publicBlob });
  const { transport, state, auth } = createTransport({ keyPath: keyFile });
  const snapshot = await collectVia(transport, handle.port, auth);
  check('用私钥文件采集成功', snapshot.memory.total > 0);
  check('服务器确认收到该公钥认证', handle.counters.publicKeyAuth >= 1, `publicKeyAuth=${handle.counters.publicKeyAuth}`);
  check('未弹密码框', state.prompts === 0);
  transport.dispose();
  await closeServer(handle);
}

console.log('10) 加密私钥：弹框输入口令并保存，第二次连接不再询问');
{
  const clientKey = makeClientKey('key-passphrase');
  const keyFile = writeTempKey(clientKey.private, 'id_encrypted');
  const handle = await startServer({ hostKey: makeHostKey(), allowPassword: false, allowedKeyBlob: clientKey.publicBlob });

  const first = createTransport({ keyPath: keyFile, enteredPassphrase: 'key-passphrase' });
  const snapshot = await collectVia(first.transport, handle.port, first.auth);
  check('输入口令后采集成功', snapshot.memory.total > 0);
  check('弹了一次口令框', first.state.passphrasePrompts === 1, `prompts=${first.state.passphrasePrompts}`);
  check('口令已保存', first.state.passphrase === 'key-passphrase');
  first.transport.dispose();

  const second = createTransport({ keyPath: keyFile, state: first.state });
  const secondSnapshot = await collectVia(second.transport, handle.port, second.auth);
  check('第二次连接成功', secondSnapshot.memory.total > 0);
  check('不再弹口令框', second.state.passphrasePrompts === 1, `prompts=${second.state.passphrasePrompts}`);
  second.transport.dispose();
  await closeServer(handle);
}

console.log('11) 保存的私钥口令失效 → 自动清除并重新询问');
{
  const clientKey = makeClientKey('right-passphrase');
  const keyFile = writeTempKey(clientKey.private, 'id_encrypted2');
  const handle = await startServer({ hostKey: makeHostKey(), allowPassword: false, allowedKeyBlob: clientKey.publicBlob });
  const { transport, state, auth } = createTransport({
    keyPath: keyFile,
    savedPassphrase: 'stale-passphrase',
    enteredPassphrase: 'right-passphrase'
  });
  const snapshot = await collectVia(transport, handle.port, auth);
  check('重新输入口令后连接成功', snapshot.memory.total > 0);
  check('弹了一次口令框', state.passphrasePrompts === 1, `prompts=${state.passphrasePrompts}`);
  check('口令已更新为新值', state.passphrase === 'right-passphrase');
  transport.dispose();
  await closeServer(handle);
}

console.log('12) 取消输入私钥口令 → 不使用该私钥（回退密码流程，不崩溃）');
{
  const clientKey = makeClientKey('key-passphrase');
  const keyFile = writeTempKey(clientKey.private, 'id_encrypted3');
  const handle = await startServer({ hostKey: makeHostKey(), allowPassword: false, allowedKeyBlob: clientKey.publicBlob });
  const { transport, state, auth } = createTransport({ keyPath: keyFile, enteredPassphrase: undefined });
  const error = await execExpectError(transport, handle.port, TIMEOUT, auth);
  check('未成功连接', error !== undefined);
  check('抛出认证类错误（已回退到密码流程）', error instanceof SshAuthError, String(error));
  check('弹过一次口令框', state.passphrasePrompts === 1);
  check('口令未被保存', state.passphrase === undefined);
  check('服务器未收到公钥认证', handle.counters.publicKeyAuth === 0);
  transport.dispose();
  await closeServer(handle);
}

console.log('13) PuTTY .ppk 私钥 → 给出转换提示');
{
  const ppkFile = writeTempKey(
    'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: test\nPublic-Lines: 2\nAAAA\n',
    'key.ppk'
  );
  const handle = await startServer({ hostKey: makeHostKey(), allowPassword: false });
  const { transport, auth } = createTransport({ keyPath: ppkFile });
  const error = await execExpectError(transport, handle.port, TIMEOUT, auth);
  check('提示 .ppk 需要转换', /PuTTY|ppk/i.test(error?.message ?? '') && /PuTTYgen/.test(error?.message ?? ''), String(error));
  transport.dispose();
  await closeServer(handle);
}

console.log('14) 私钥文件路径不存在 → 明确报错');
{
  const { transport, auth } = createTransport({ keyPath: path.join(os.tmpdir(), 'easy-gpu-missing-key-xyz') });
  const error = await execExpectError(transport, 22, 5000, auth);
  check('提示找不到私钥文件', /找不到私钥文件/.test(error?.message ?? ''), String(error));
  transport.dispose();
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);