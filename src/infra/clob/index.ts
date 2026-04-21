import type { AppEnv } from "../../config/schema.js";
import type { ClobAdapter } from "./types.js";
import { V1Adapter } from "./v1Adapter.js";
import { V2Adapter } from "./v2Adapter.js";

export function createClobAdapter(env: AppEnv): ClobAdapter {
  return env.USE_CLOB_V2 ? new V2Adapter(env) : new V1Adapter(env);
}

export * from "./types.js";
