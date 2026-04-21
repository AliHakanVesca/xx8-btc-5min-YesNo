import { z } from "zod";

const booleanString = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === undefined || value === "") {
      return false;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

const optionalBooleanString = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === "") {
      return undefined;
    }
    if (typeof value === "boolean") {
      return value;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

const numberString = z
  .union([z.number(), z.string(), z.undefined()])
  .transform((value) => {
    if (typeof value === "number") {
      return value;
    }
    if (value === undefined || value === "") {
      return 0;
    }
    return Number(value);
  });

const optionalString = z
  .union([z.string(), z.undefined()])
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

const numberList = z
  .union([z.array(z.number()), z.string(), z.undefined()])
  .transform((value) => {
    if (Array.isArray(value)) {
      return value;
    }
    if (!value) {
      return [];
    }
    return value
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DRY_RUN: booleanString.default(true),
  BOT_MODE: z.enum(["STRICT", "XUAN"]).default("XUAN"),
  POLY_STACK_MODE: z.enum(["current-prod-v1", "post-cutover-v2"]).default("current-prod-v1"),
  USE_CLOB_V2: optionalBooleanString,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  BOT_WALLET_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),
  BOT_PRIVATE_KEY: optionalString,
  POLY_SIGNATURE_TYPE: numberString.default(0),
  POLY_FUNDER: optionalString,
  POLY_API_KEY: optionalString,
  POLY_API_SECRET: optionalString,
  POLY_API_PASSPHRASE: optionalString,
  POLY_RELAYER_API_KEY: optionalString,
  POLY_RELAYER_API_KEY_ADDRESS: optionalString,
  POLY_RELAYER_BASE_URL: z.string().url().default("https://relayer-v2.polymarket.com"),
  POLY_CHAIN_ID: numberString.default(137),
  POLY_RPC_URL: z.string().url().default("https://polygon-rpc.com"),
  POLY_CLOB_BASE_URL: optionalString,
  POLY_GAMMA_BASE_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLY_DATA_API_BASE_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLY_MARKET_WS_URL: z.string().url().or(z.string().startsWith("wss://")).default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  POLY_USER_WS_URL: z.string().url().or(z.string().startsWith("wss://")).default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
  POLY_USDC_TOKEN: z.string().default("0x0000000000000000000000000000000000000000"),
  POLY_PUSD_TOKEN: z.string().default("0x0000000000000000000000000000000000000000"),
  POLY_COLLATERAL_TOKEN: optionalString,
  CTF_CONTRACT_ADDRESS: z.string().default("0x0000000000000000000000000000000000000000"),
  CTF_MERGE_ENABLED: booleanString.default(true),
  CTF_AUTO_REDEEM_ENABLED: booleanString.default(true),
  MERGE_MIN_SHARES: numberString.default(5),
  ENABLE_MAKER_LAYER: booleanString.default(false),
  ENTRY_TAKER_BUY_ENABLED: booleanString.default(true),
  ENTRY_TAKER_PAIR_CAP: numberString.default(1.02),
  COMPLETION_CAP: numberString.default(0.982),
  MIN_EDGE_PER_SHARE: numberString.default(0.004),
  STRICT_PAIR_EFFECTIVE_CAP: numberString.default(0.995),
  NORMAL_PAIR_EFFECTIVE_CAP: numberString.default(1.005),
  COMPLETION_SOFT_CAP: numberString.default(1.015),
  COMPLETION_HARD_CAP: numberString.default(1.06),
  EMERGENCY_COMPLETION_MAX_QTY: numberString.default(30),
  MAX_NEGATIVE_EDGE_PER_MARKET_USDC: numberString.default(3),
  MAX_MARKET_EXPOSURE_SHARES: numberString.default(500),
  SOFT_IMBALANCE_RATIO: numberString.default(0.02),
  HARD_IMBALANCE_RATIO: numberString.default(0.05),
  LOT_LADDER: numberList.default([20, 40, 60, 80, 100]),
  LIVE_SMALL_LOTS: numberList.default([20, 40]),
  DEFAULT_LOT: numberString.default(40),
  MAX_MARKET_SHARES_PER_SIDE: numberString.default(500),
  MAX_ONE_SIDED_EXPOSURE_SHARES: numberString.default(160),
  MAX_IMBALANCE_FRAC: numberString.default(0.02),
  FORCE_REBALANCE_IMBALANCE_FRAC: numberString.default(0.05),
  REBALANCE_LEADING_FRACTION: numberString.default(0.25),
  REBALANCE_MAX_LAGGING_MULTIPLIER: numberString.default(3),
  MAX_CYCLES_PER_MARKET: numberString.default(8),
  MAX_BUYS_PER_SIDE: numberString.default(10),
  ENTER_FROM_OPEN_SEC_MIN: numberString.default(3),
  ENTER_FROM_OPEN_SEC_MAX: numberString.default(230),
  NORMAL_ENTRY_CUTOFF_SEC_TO_CLOSE: numberString.default(60),
  COMPLETION_ONLY_CUTOFF_SEC_TO_CLOSE: numberString.default(20),
  HARD_CANCEL_SEC_TO_CLOSE: numberString.default(10),
  PARTIAL_COMPLETION_FRACTIONS: numberList.default([0.5, 0.75, 1]),
  MAX_RESIDUAL_HOLD_SHARES: numberString.default(10),
  RESIDUAL_UNWIND_SEC_TO_CLOSE: numberString.default(15),
  SELL_UNWIND_ENABLED: booleanString.default(false),
  DAILY_MAX_LOSS_USDC: numberString.default(50),
  MARKET_MAX_LOSS_USDC: numberString.default(10),
  MIN_USDC_BALANCE: numberString.default(10),
  BOOK_STALE_MS: numberString.default(2000),
  BALANCE_STALE_MS: numberString.default(5000),
  RECORDER_ENABLED: booleanString.default(false),
});

export type RawAppEnv = z.infer<typeof envSchema>;

export interface AppEnv extends RawAppEnv {
  USE_CLOB_V2: boolean;
  POLY_CLOB_BASE_URL: string;
  ACTIVE_COLLATERAL_TOKEN: string;
  ACTIVE_COLLATERAL_SYMBOL: "USDC.e" | "pUSD" | "custom";
}
