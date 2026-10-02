import * as fs from 'fs';
import { parseCollectorOutput } from './parse';
import { runRemoteScript } from './ssh';
import { Snapshot } from './types';

export const COLLECT_TIMEOUT_MS = 25000;

/** 读取本地的采集脚本，通过 ssh 管道在远程执行并解析为快照。 */
export async function collectSnapshot(
  host: string,
  scriptPath: string,
  extraArgs: string[],
  timeoutMs = COLLECT_TIMEOUT_MS
): Promise<Snapshot> {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const result = await runRemoteScript(host, script, extraArgs, timeoutMs);
  return parseCollectorOutput(result.stdout);
}