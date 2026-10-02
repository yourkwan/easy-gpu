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

export interface MonitorState {
  status: ConnectionStatus;
  host: string;
  error?: string;
  snapshot?: Snapshot;
  updatedAt?: number;
}

export interface WebviewConfig {
  refreshInterval: number;
}