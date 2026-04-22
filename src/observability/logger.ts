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
  const enabled = ["1", "true", "yes", "on"].includes(String(process.env.LOG_ROTATION ?? "true").toLowerCase());
  const compress = ["1", "true", "yes", "on"].includes(String(process.env.LOG_COMPRESS_OLD ?? "true").toLowerCase());
  const maxFileMb = Number(process.env.LOG_MAX_FILE_MB ?? "100");
  await appendJsonl(`logs/${stream}.jsonl`, payload, {
    rotation: {
      enabled,
      maxBytes: Math.max(1, Number.isFinite(maxFileMb) ? maxFileMb : 100) * 1024 * 1024,
      compress,
    },
  });
}
