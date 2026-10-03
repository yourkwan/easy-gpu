import * as vscode from 'vscode';

/** 登录方式：密码 / 私钥文件 / ssh-agent（免密） */
export type AuthMethod = 'password' | 'key' | 'agent';

/**
 * 一条服务器连接配置。
 * 密码与私钥口令按「用户名@服务器:端口」分别保存，不同用户互不影响；
 * 私钥文件也记在这里，因此每个用户可以使用各自的私钥。
 */
export interface ConnectionProfile {
  /** 用户输入的地址：IP、域名，或 ~/.ssh/config 中的别名 */
  host: string;
  user: string;
  port: number;
  auth: AuthMethod;
  /** auth = key 时使用的私钥文件（绝对路径） */
  keyPath?: string;
}

export interface StoredProfile extends ConnectionProfile {
  /** user@host:port，同时作为钥匙串中凭据的键 */
  id: string;
}

const PROFILES_KEY = 'easy-gpu.profiles';
const CURRENT_KEY = 'easy-gpu.currentProfile';

export function profileId(profile: ConnectionProfile): string {
  return `${profile.user}@${profile.host}:${profile.port}`;
}

/** 面向用户的展示名：user@host（默认端口不显示） */
export function profileLabel(profile: ConnectionProfile): string {
  return profile.port === 22 ? `${profile.user}@${profile.host}` : `${profile.user}@${profile.host}:${profile.port}`;
}

export function authLabel(profile: ConnectionProfile): string {
  if (profile.auth === 'password') {
    return '密码登录';
  }
  if (profile.auth === 'key') {
    return profile.keyPath ? `私钥 ${shortPath(profile.keyPath)}` : '私钥文件';
  }
  return 'ssh-agent / 免密';
}

/** 取地址部分（去掉 user@ 与 :port），保留别名以便继续复用 ~/.ssh/config。 */
export function addressPart(input: string): string {
  let address = input.trim();
  const at = address.lastIndexOf('@');
  if (at > 0) {
    address = address.slice(at + 1);
  }
  const match = /^([^:]+):\d+$/.exec(address);
  return match ? match[1] : address;
}

/** 内置客户端使用的目标：user@host（非默认端口带 :port），由 resolveHost 再解析别名。 */
export function sshTarget(profile: ConnectionProfile): string {
  const base = `${profile.user}@${profile.host}`;
  return profile.port === 22 ? base : `${base}:${profile.port}`;
}

/** 系统 ssh 的目标：不接受 host:port，端口需用 -p 传入。 */
export function sshHostArg(profile: ConnectionProfile): string {
  return `${profile.user}@${profile.host}`;
}

function shortPath(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : file;
}

/** 连接配置的持久化（globalState，不含任何密码）。 */
export class ProfileStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): StoredProfile[] {
    const raw = this.memento.get<unknown>(PROFILES_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(isProfile).map((profile) => ({ ...profile, id: profileId(profile) }));
  }

  current(): StoredProfile | undefined {
    const id = this.memento.get<string>(CURRENT_KEY);
    const profiles = this.all();
    return profiles.find((profile) => profile.id === id) ?? profiles[0];
  }

  /** 新增或更新（按 user@host:port 去重），并设为当前连接。 */
  async save(profile: ConnectionProfile): Promise<StoredProfile> {
    const stored: StoredProfile = { ...profile, id: profileId(profile) };
    const others = this.all().filter((item) => item.id !== stored.id);
    await this.memento.update(PROFILES_KEY, [...others, stored]);
    await this.memento.update(CURRENT_KEY, stored.id);
    return stored;
  }

  async setCurrent(id: string): Promise<void> {
    await this.memento.update(CURRENT_KEY, id);
  }

  async remove(id: string): Promise<void> {
    const rest = this.all().filter((item) => item.id !== id);
    await this.memento.update(PROFILES_KEY, rest);
    if (this.memento.get<string>(CURRENT_KEY) === id) {
      await this.memento.update(CURRENT_KEY, rest[0]?.id);
    }
  }
}

function isProfile(value: unknown): value is ConnectionProfile {
  const profile = value as ConnectionProfile | undefined;
  return Boolean(
    profile &&
      typeof profile.host === 'string' &&
      profile.host.trim() &&
      typeof profile.user === 'string' &&
      profile.user.trim() &&
      (profile.auth === 'password' || profile.auth === 'key' || profile.auth === 'agent')
  );
}