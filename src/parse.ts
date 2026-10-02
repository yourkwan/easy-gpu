import { CpuInfo, GpuInfo, GpuProcess, MemoryInfo, Snapshot } from './types';

export const BEGIN_MARKER = '@@EASYGPU_BEGIN@@';
export const END_MARKER = '@@EASYGPU_END@@';

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 解析远程采集脚本的输出：从标记之间提取 JSON 并做一次宽松归一化，
 * 避免个别字段缺失导致整个面板渲染失败。
 */
export function parseCollectorOutput(stdout: string): Snapshot {
  const begin = stdout.indexOf(BEGIN_MARKER);
  const end = stdout.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin === -1 || end === -1) {
    throw new Error('未找到采集脚本输出标记，服务器返回内容不是预期的格式');
  }
  const raw = stdout.slice(begin + BEGIN_MARKER.length, end).trim();
  if (!raw) {
    throw new Error('采集脚本没有返回数据');
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('采集数据解析失败（JSON 格式错误）');
  }
  return normalizeSnapshot(data);
}

export function normalizeSnapshot(data: unknown): Snapshot {
  const source = (data ?? {}) as Record<string, unknown>;

  const cpuSource = (source.cpu ?? {}) as Record<string, unknown>;
  const cpu: CpuInfo = {
    usage: toNullableNumber(cpuSource.usage),
    cores: toNumber(cpuSource.cores),
    load1: toNumber(cpuSource.load1),
    load5: toNumber(cpuSource.load5),
    load15: toNumber(cpuSource.load15),
    model: toString(cpuSource.model) || undefined
  };

  const memSource = (source.memory ?? {}) as Record<string, unknown>;
  const memory: MemoryInfo = {
    total: toNumber(memSource.total),
    used: toNumber(memSource.used),
    available: toNumber(memSource.available),
    cached: toNumber(memSource.cached)
  };

  const gpusSource = Array.isArray(source.gpus) ? source.gpus : [];
  const gpus: GpuInfo[] = gpusSource.map((item, i) => {
    const gpu = (item ?? {}) as Record<string, unknown>;
    const procSource = Array.isArray(gpu.processes) ? gpu.processes : [];
    const processes: GpuProcess[] = procSource.map((p) => {
      const proc = (p ?? {}) as Record<string, unknown>;
      return {
        pid: toNumber(proc.pid),
        user: toString(proc.user, 'unknown') || 'unknown',
        memory: toNumber(proc.memory),
        command: toString(proc.command) || undefined
      };
    });
    return {
      index: toNumber(gpu.index, i),
      name: toString(gpu.name, 'GPU'),
      temperature: toNullableNumber(gpu.temperature),
      utilization: toNullableNumber(gpu.utilization),
      memoryUsed: toNumber(gpu.memoryUsed),
      memoryTotal: toNumber(gpu.memoryTotal),
      processes
    };
  });

  return {
    hostname: toString(source.hostname, 'unknown') || 'unknown',
    timestamp: toNumber(source.timestamp, Date.now()),
    nvidiaSmi: source.nvidiaSmi === true || source.nvidiaSmi === 1,
    cpu,
    memory,
    gpus
  };
}