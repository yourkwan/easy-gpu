import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshConfigEntry {
  alias: string;
  hostName?: string;
  user?: string;
  port?: string;
  identityFiles: string[];
  proxyJump?: string;
}

export interface ResolvedHost {
  /** 用户输入的原始内容（也是凭据的存储键） */
  input: string;
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
  proxyJump?: string;
}

interface SshConfigBlock {
  patterns: string[];
  options: Map<string, string[]>;
}

const DEFAULT_PORT = 22;

export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

function loadBlocks(configPath = defaultSshConfigPath()): SshConfigBlock[] {
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }

  const blocks: SshConfigBlock[] = [];
  let current: SshConfigBlock | undefined;

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
      current = { patterns: value.split(/\s+/).filter(Boolean), options: new Map() };
      blocks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const existing = current.options.get(key);
    if (existing) {
      existing.push(value);
    } else {
      current.options.set(key, [value]);
    }
  }
  return blocks;
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function blockMatches(block: SshConfigBlock, host: string): boolean {
  let positive = false;
  for (const pattern of block.patterns) {
    if (pattern.startsWith('!')) {
      if (patternToRegExp(pattern.slice(1)).test(host)) {
        return false;
      }
    } else if (patternToRegExp(pattern).test(host)) {
      positive = true;
    }
  }
  return positive;
}

function firstOption(blocks: SshConfigBlock[], key: string): string | undefined {
  for (const block of blocks) {
    const values = block.options.get(key);
    if (values && values.length) {
      return values[0];
    }
  }
  return undefined;
}

export function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** 列出 ~/.ssh/config 中的字面别名（供 QuickPick 使用，跳过通配写法）。 */
export function readSshConfigHosts(configPath?: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = [];
  for (const block of loadBlocks(configPath)) {
    const alias = block.patterns.find((p) => !p.startsWith('!') && !p.includes('*') && !p.includes('?'));
    if (!alias) {
      continue;
    }
    entries.push({
      alias,
      hostName: block.options.get('hostname')?.[0],
      user: block.options.get('user')?.[0],
      port: block.options.get('port')?.[0],
      identityFiles: (block.options.get('identityfile') ?? []).map(expandHome),
      proxyJump: block.options.get('proxyjump')?.[0]
    });
  }
  return entries;
}

function localUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'root';
  }
}

/**
 * 把用户输入（别名 / user@host / host:port）解析为真实连接参数。
 * 采用与 OpenSSH 一致的基本规则：所有匹配的 Host 块按顺序合并，同名参数「先出现者生效」。
 */
export function resolveHost(input: string, configPath?: string): ResolvedHost {
  const trimmed = input.trim();
  let explicitUser: string | undefined;
  let hostPart = trimmed;

  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex > 0) {
    explicitUser = trimmed.slice(0, atIndex);
    hostPart = trimmed.slice(atIndex + 1);
  }

  let explicitPort: number | undefined;
  const portMatch = /^([^:]+):(\d+)$/.exec(hostPart);
  if (portMatch) {
    hostPart = portMatch[1];
    explicitPort = Number(portMatch[2]);
  }

  const matched = loadBlocks(configPath).filter((block) => blockMatches(block, hostPart));
  const hostName = firstOption(matched, 'hostname') ?? hostPart;
  const configUser = firstOption(matched, 'user');
  const configPort = Number(firstOption(matched, 'port'));

  const identityFiles: string[] = [];
  for (const block of matched) {
    for (const file of block.options.get('identityfile') ?? []) {
      identityFiles.push(expandHome(file));
    }
  }

  const port = explicitPort ?? (Number.isFinite(configPort) && configPort > 0 ? configPort : DEFAULT_PORT);

  return {
    input: trimmed,
    host: hostName,
    port,
    user: explicitUser || configUser || localUser(),
    identityFiles,
    proxyJump: firstOption(matched, 'proxyjump')
  };
}