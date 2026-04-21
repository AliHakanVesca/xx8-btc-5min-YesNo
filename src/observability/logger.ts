import pino, { type Logger } from "pino";
import type { AppEnv } from "../config/schema.js";
import { appendJsonl } from "../utils/fs.js";

export function createLogger(env: AppEnv): Logger {
  return pino({
    level: env.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.unixTime,
    base: null,
  });
}

export async function writeStructuredLog(stream: string, payload: unknown): Promise<void> {
  await appendJsonl(`logs/${stream}.jsonl`, payload);
}
