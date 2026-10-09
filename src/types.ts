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

/** 实际使用的传输通道 */
export type Channel = 'systemSsh' | 'builtin';

export interface MonitorState {
  status: ConnectionStatus;
  /** 当前连接（user@host），未配置时为空 */
  host: string;
  error?: string;
  snapshot?: Snapshot;
  updatedAt?: number;
  /** 本次实际走的通道（系统 ssh / 内置客户端） */
  channel?: Channel;
  /** 上次刷新总耗时（毫秒） */
  durationMs?: number;
}

export type AccentColor = 'blue' | 'cyan' | 'green' | 'purple' | 'pink' | 'orange' | 'red';

export interface WebviewConfig {
  refreshInterval: number;
  /** 是否把同一用户的多个进程合并为一条 */
  mergeProcesses: boolean;
  /** 强调色风格 */
  accentColor: AccentColor;
}

/** 「选择服务器」sheet 的条目 */
export interface ProfileSummary {
  id: string;
  label: string;
  sub: string;
  current: boolean;
}