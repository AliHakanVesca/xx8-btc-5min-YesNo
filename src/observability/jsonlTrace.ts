import type { AppEnv } from "../config/schema.js";
import { appendJsonl } from "../utils/fs.js";

function buildRotationOptions(env: Pick<AppEnv, "LOG_ROTATION" | "LOG_MAX_FILE_MB" | "LOG_COMPRESS_OLD">) {
  return {
    enabled: env.LOG_ROTATION,
    maxBytes: Math.max(1, env.LOG_MAX_FILE_MB) * 1024 * 1024,
    compress: env.LOG_COMPRESS_OLD,
  };
}

export class JsonlTraceLogger {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly env: Pick<AppEnv, "LOG_JSONL" | "LOG_ROTATION" | "LOG_MAX_FILE_MB" | "LOG_COMPRESS_OLD">,
    private readonly baseContext: Record<string, unknown>,
  ) {}

  write(stream: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.env.LOG_JSONL) {
      return Promise.resolve();
    }

    const record = {
      ts: Math.floor(Date.now() / 1000),
      tsIso: new Date().toISOString(),
      ...this.baseContext,
      ...payload,
    };

    this.queue = this.queue.then(async () => {
      await appendJsonl(`logs/${stream}.jsonl`, record, {
        rotation: buildRotationOptions(this.env),
      });
    });

    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
