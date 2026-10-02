export interface GpuProcess {
  pid: number;
  user: string;
  memory: number;
  command?: string;
}

export interface GpuInfo {
  index: number;
  name: string;
  temperature: number | null;
  utilization: number | null;
  memoryUsed: number;
  memoryTotal: number;
  processes: GpuProcess[];
}

export interface CpuInfo {
  usage: number | null;
  cores: number;
  load1: number;
  load5: number;
  load15: number;
  model?: string;
}

export interface MemoryInfo {
  total: number;
  used: number;
  available: number;
  cached: number;
}

export interface Snapshot {
  hostname: string;
  timestamp: number;
  nvidiaSmi: boolean;
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpus: GpuInfo[];
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ok' | 'error';

/** 连接方式：auto = 系统 ssh 优先、认证失败回退密码登录；systemSsh = 仅系统 ssh；builtin = 仅内置客户端 */
export type ConnectionMode = 'auto' | 'systemSsh' | 'builtin';

/** 实际使用的传输通道 */
export type Channel = 'systemSsh' | 'builtin';

export interface MonitorState {
  status: ConnectionStatus;
  host: string;
  error?: string;
  snapshot?: Snapshot;
  updatedAt?: number;
  mode?: ConnectionMode;
  /** 本次实际走的通道（系统 ssh / 内置客户端） */
  channel?: Channel;
  /** 上次刷新总耗时（毫秒） */
  durationMs?: number;
}

export interface WebviewConfig {
  refreshInterval: number;
}