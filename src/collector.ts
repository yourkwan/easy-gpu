import { parseCollectorOutput } from './parse';
import { Snapshot } from './types';

export const COLLECT_TIMEOUT_MS = 25000;

/** 执行采集脚本的方式：返回脚本的 stdout（系统 ssh 或内置客户端）。 */
export type ScriptRunner = (script: string) => Promise<string>;

/** 通过给定的传输方式执行采集脚本，并把输出解析为快照。 */
export async function collectSnapshot(script: string, run: ScriptRunner): Promise<Snapshot> {
  const stdout = await run(script);
  return parseCollectorOutput(stdout);
}