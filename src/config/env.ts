import { config as loadDotEnv } from "dotenv";
import { envSchema, type AppEnv, type RawAppEnv } from "./schema.js";

let cachedEnv: AppEnv | undefined;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ParseEnvOptions {
  enforceLiveRequirements?: boolean;
}

function defaultClobBaseUrl(stackMode: RawAppEnv["POLY_STACK_MODE"]): string {
  return stackMode === "current-prod-v1"
    ? "https://clob.polymarket.com"
    : "https://clob.polymarket.com";
}

function defaultUseClobV2(stackMode: RawAppEnv["POLY_STACK_MODE"]): boolean {
  return stackMode === "post-cutover-v2";
}

function defaultCollateralToken(raw: RawAppEnv): { token: string; symbol: AppEnv["ACTIVE_COLLATERAL_SYMBOL"] } {
  if (raw.POLY_COLLATERAL_TOKEN) {
    return {
      token: raw.POLY_COLLATERAL_TOKEN,
      symbol: "custom",
    };
  }

  if (raw.POLY_STACK_MODE === "post-cutover-v2") {
    return {
      token: raw.POLY_PUSD_TOKEN,
      symbol: "pUSD",
    };
  }

  return {
    token: raw.POLY_USDC_TOKEN,
    symbol: "USDC.e",
  };
}

function assertStackConsistency(raw: RawAppEnv, useClobV2: boolean): void {
  if (raw.POLY_STACK_MODE === "current-prod-v1" && useClobV2) {
    throw new Error("POLY_STACK_MODE=current-prod-v1 iken USE_CLOB_V2=true olamaz.");
  }
  if (raw.POLY_STACK_MODE === "post-cutover-v2" && !useClobV2) {
    throw new Error("POLY_STACK_MODE=post-cutover-v2 iken USE_CLOB_V2=false olamaz.");
  }
}

function assertLiveRequirements(env: AppEnv): void {
  if (env.DRY_RUN) {
    return;
  }

  const missing: string[] = [];

  if (!env.BOT_PRIVATE_KEY) missing.push("BOT_PRIVATE_KEY");
  if (!env.POLY_API_KEY) missing.push("POLY_API_KEY");
  if (!env.POLY_API_SECRET) missing.push("POLY_API_SECRET");
  if (!env.POLY_API_PASSPHRASE) missing.push("POLY_API_PASSPHRASE");
  if (env.BOT_WALLET_ADDRESS === ZERO_ADDRESS) missing.push("BOT_WALLET_ADDRESS");
  if (env.CTF_CONTRACT_ADDRESS === ZERO_ADDRESS) missing.push("CTF_CONTRACT_ADDRESS");
  if (env.ACTIVE_COLLATERAL_TOKEN === ZERO_ADDRESS) missing.push("ACTIVE_COLLATERAL_TOKEN");
  if (env.CTF_MERGE_ENABLED && env.POLY_SIGNATURE_TYPE !== 0) {
    if (!env.POLY_RELAYER_API_KEY) missing.push("POLY_RELAYER_API_KEY");
    if (!env.POLY_RELAYER_API_KEY_ADDRESS) missing.push("POLY_RELAYER_API_KEY_ADDRESS");
    if (!env.POLY_RELAYER_BASE_URL) missing.push("POLY_RELAYER_BASE_URL");
  }

  if (missing.length > 0) {
    throw new Error(`Live mod icin eksik veya placeholder env alanlari: ${missing.join(", ")}`);
  }
}

export function parseEnv(input: NodeJS.ProcessEnv, options: ParseEnvOptions = {}): AppEnv {
  const { enforceLiveRequirements = true } = options;
  const raw = envSchema.parse(input);
  const useClobV2 = raw.USE_CLOB_V2 ?? defaultUseClobV2(raw.POLY_STACK_MODE);
  assertStackConsistency(raw, useClobV2);

  const collateral = defaultCollateralToken(raw);
  const resolved: AppEnv = {
    ...raw,
    USE_CLOB_V2: useClobV2,
    POLY_CLOB_BASE_URL: raw.POLY_CLOB_BASE_URL ?? defaultClobBaseUrl(raw.POLY_STACK_MODE),
    ACTIVE_COLLATERAL_TOKEN: collateral.token,
    ACTIVE_COLLATERAL_SYMBOL: collateral.symbol,
  };

  if (enforceLiveRequirements) {
    assertLiveRequirements(resolved);
  }
  return resolved;
}

export function loadEnv(options: ParseEnvOptions = {}): AppEnv {
  const { enforceLiveRequirements = true } = options;

  if (enforceLiveRequirements && cachedEnv) {
    return cachedEnv;
  }

  loadDotEnv({ quiet: true });
  const env = parseEnv(process.env, options);

  if (enforceLiveRequirements) {
    cachedEnv = env;
  }

  return env;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}
