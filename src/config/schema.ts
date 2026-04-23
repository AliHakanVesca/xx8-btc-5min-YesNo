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
  XUAN_CLONE_MODE: z.enum(["OFF", "PUBLIC_FOOTPRINT"]).default("OFF"),
  STATE_STORE: z.enum(["SQLITE", "JSON"]).default("SQLITE"),
  STATE_DB_PATH: z.string().default("data/xuan_state.sqlite"),
  STARTUP_INVENTORY_POLICY: z.enum(["IGNORE", "ADOPT_AND_RECONCILE"]).default("ADOPT_AND_RECONCILE"),
  UNKNOWN_INVENTORY_POLICY: z.enum(["WARN", "BLOCK_NEW_ENTRY"]).default("BLOCK_NEW_ENTRY"),
  RESOLVED_INVENTORY_POLICY: z.enum(["MANUAL", "AUTO_REDEEM"]).default("AUTO_REDEEM"),
  MERGEABLE_INVENTORY_POLICY: z.enum(["MANUAL", "AUTO_MERGE"]).default("AUTO_MERGE"),
  STARTUP_RESIDUAL_POLICY: z.enum(["REPORT_ONLY", "AUTO_MANAGE"]).default("AUTO_MANAGE"),
  LOW_COLLATERAL_MODE: z.enum(["STOP", "NO_NEW_ENTRY_BUT_MANAGE"]).default("NO_NEW_ENTRY_BUT_MANAGE"),
  POLY_STACK_MODE: z.enum(["current-prod-v1", "post-cutover-v2"]).default("current-prod-v1"),
  USE_CLOB_V2: optionalBooleanString,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_JSONL: booleanString.default(true),
  LOG_ROTATION: booleanString.default(true),
  LOG_MAX_FILE_MB: numberString.default(100),
  LOG_COMPRESS_OLD: booleanString.default(true),
  STATE_STORE_PATH: z.string().default("data/runtime/xuan-state.sqlite"),
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
  MERGE_MIN_SHARES: numberString.default(1),
  MIN_MERGE_SHARES: numberString.default(1),
  MERGE_MODE: z.enum(["MANUAL", "AUTO"]).default("AUTO"),
  MERGE_DEBOUNCE_MS: numberString.default(2500),
  MERGE_BATCH_MODE: z.enum(["IMMEDIATE", "HYBRID_DELAYED"]).default("HYBRID_DELAYED"),
  MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: numberString.default(2),
  MIN_FIRST_MATCHED_AGE_BEFORE_MERGE_SEC: numberString.default(45),
  MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC: numberString.default(75),
  FORCE_MERGE_IN_LAST_30S: booleanString.default(true),
  FORCE_MERGE_ON_HARD_IMBALANCE: booleanString.default(true),
  FORCE_MERGE_ON_LOW_COLLATERAL: booleanString.default(true),
  MERGE_ON_EACH_RECONCILE: booleanString.default(true),
  MERGE_ON_MARKET_CLOSE: booleanString.default(true),
  MERGE_MAX_TX_PER_MARKET: numberString.default(10),
  MERGE_DUST_LEAVE_SHARES: numberString.default(0.01),
  ALLOW_MERGE_WITH_PENDING_GROUPS: booleanString.default(true),
  MERGE_ONLY_CONFIRMED_MATCHED_UNLOCKED_LOTS: booleanString.default(true),
  LOCK_RESERVED_QTY_FOR_PENDING_ORDERS: booleanString.default(true),
  REDEEM_MODE: z.enum(["MANUAL", "AUTO"]).default("AUTO"),
  REDEEM_ON_RESOLUTION: booleanString.default(true),
  REDEEM_RETRY_ENABLED: booleanString.default(true),
  REDEEM_RETRY_MAX: numberString.default(10),
  REDEEM_MIN_SHARES: numberString.default(0.5),
  DUST_SHARES_THRESHOLD: numberString.default(0.5),
  INVENTORY_POSITION_LIMIT: numberString.default(250),
  INVENTORY_SIZE_THRESHOLD: numberString.default(0.1),
  ENABLE_MAKER_LAYER: booleanString.default(false),
  ENTRY_TAKER_BUY_ENABLED: booleanString.default(true),
  ENTRY_TAKER_PAIR_CAP: numberString.default(1.02),
  COMPLETION_CAP: numberString.default(0.982),
  MIN_EDGE_PER_SHARE: numberString.default(0.004),
  STRICT_PAIR_EFFECTIVE_CAP: numberString.default(1.006),
  NORMAL_PAIR_EFFECTIVE_CAP: numberString.default(1.02),
  PAIR_SWEEP_STRICT_CAP: numberString.default(1.006),
  XUAN_PAIR_SWEEP_SOFT_CAP: numberString.default(1.02),
  XUAN_PAIR_SWEEP_HARD_CAP: numberString.default(1.045),
  ENABLE_XUAN_HARD_PAIR_SWEEP: booleanString.default(true),
  MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC: numberString.default(0.3),
  MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: numberString.default(1),
  MAX_NEGATIVE_DAILY_BUDGET_USDC: numberString.default(5),
  XUAN_SOFT_SWEEP_MAX_QTY: numberString.default(10),
  XUAN_HARD_SWEEP_MAX_QTY: numberString.default(5),
  XUAN_MIN_TIME_LEFT_FOR_SOFT_SWEEP: numberString.default(45),
  XUAN_MIN_TIME_LEFT_FOR_HARD_SWEEP: numberString.default(90),
  ALLOW_INITIAL_NEGATIVE_PAIR_SWEEP: booleanString.default(true),
  ALLOW_SINGLE_LEG_SEED: booleanString.default(false),
  ALLOW_TEMPORAL_SINGLE_LEG_SEED: booleanString.default(false),
  ALLOW_CHEAP_UNDERDOG_SEED: booleanString.default(false),
  ALLOW_NAKED_SINGLE_LEG_SEED: booleanString.default(false),
  ALLOW_XUAN_COVERED_SEED: booleanString.default(true),
  ALLOW_COVERED_SEED_SAME_PAIRGROUP: booleanString.default(true),
  ALLOW_COVERED_SEED_OPPOSITE_INVENTORY: booleanString.default(false),
  COVERED_SEED_ALLOW_SAME_PAIRGROUP_OPPOSITE_ORDER: booleanString.default(true),
  COVERED_SEED_ALLOW_OPPOSITE_INVENTORY_COVER: booleanString.default(false),
  COVERED_SEED_REQUIRE_SAME_PAIRGROUP_OPPOSITE_ORDER: booleanString.default(true),
  COVERED_SEED_MIN_OPPOSITE_COVERAGE_RATIO: numberString.default(0.9),
  COVERED_SEED_MAX_QTY: numberString.default(5),
  COVERED_SEED_REQUIRES_FAIR_VALUE: booleanString.default(true),
  SINGLE_LEG_ORPHAN_CAP: numberString.default(0.62),
  SINGLE_LEG_FAIR_VALUE_VETO: booleanString.default(true),
  SINGLE_LEG_ORPHAN_MAX_FAIR_PREMIUM: numberString.default(0.035),
  TEMPORAL_SINGLE_LEG_TTL_SEC: numberString.default(90),
  TEMPORAL_SINGLE_LEG_MIN_OPPOSITE_DEPTH_RATIO: numberString.default(0.9),
  XUAN_BEHAVIOR_CAP: numberString.default(1.08),
  ORPHAN_LEG_MAX_NOTIONAL_USDC: numberString.default(5),
  ORPHAN_LEG_MAX_AGE_SEC: numberString.default(90),
  MAX_MARKET_ORPHAN_USDC: numberString.default(5),
  MAX_SINGLE_ORPHAN_QTY: numberString.default(5),
  SINGLE_LEG_SEED_MAX_QTY: numberString.default(20),
  MAX_CONSECUTIVE_SINGLE_LEG_SEEDS_PER_SIDE: numberString.default(1),
  COMPLETION_QTY_MODE: z.enum(["MISSING_ONLY", "ALLOW_OVERSHOOT"]).default("MISSING_ONLY"),
  PARTIAL_COMPLETION_QTY_MODE: z.enum(["MISSING_ONLY", "ALLOW_OVERSHOOT"]).default("MISSING_ONLY"),
  POST_MERGE_MAX_COMPLETION_QTY_MODE: z.enum(["MISSING_ONLY", "RESIDUAL_ONLY"]).default("RESIDUAL_ONLY"),
  REPAIR_MIN_QTY: numberString.default(0.25),
  COMPLETION_MIN_QTY: numberString.default(0.25),
  MAX_COMPLETION_OVERSHOOT_SHARES: numberString.default(0.25),
  FORBID_BUY_THAT_INCREASES_IMBALANCE: booleanString.default(true),
  PARTIAL_COMPLETION_REQUIRES_IMBALANCE_REDUCTION: booleanString.default(true),
  BLOCK_NEW_PAIR_WHILE_PARTIAL_OPEN: booleanString.default(true),
  MAX_OPEN_GROUPS_PER_MARKET: numberString.default(2),
  MAX_OPEN_PARTIAL_GROUPS: numberString.default(1),
  MAX_OPEN_PARTIAL_GROUPS_PER_MARKET: numberString.default(1),
  PARTIAL_OPEN_ACTION: z.enum(["COMPLETION_ONLY", "ALLOW_OVERLAP"]).default("COMPLETION_ONLY"),
  ALLOW_CONTROLLED_OVERLAP: booleanString.default(true),
  ALLOW_OVERLAP_ONLY_AFTER_PARTIAL_CLASSIFIED: booleanString.default(true),
  ALLOW_OVERLAP_ONLY_WHEN_COMPLETION_ENGINE_ACTIVE: booleanString.default(true),
  ALLOW_OVERLAP_IN_LAST_30S: booleanString.default(false),
  REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: booleanString.default(true),
  WORST_CASE_AMPLIFICATION_TOLERANCE_SHARES: numberString.default(0.25),
  POST_MERGE_NEW_SEED_COOLDOWN_MS: numberString.default(15000),
  POST_MERGE_PAIR_REOPEN_COOLDOWN_MS: numberString.default(5000),
  POST_MERGE_ONLY_COMPLETION: booleanString.default(true),
  POST_MERGE_ONLY_COMPLETION_WHILE_RESIDUAL: booleanString.default(true),
  POST_MERGE_ALLOW_NEW_PAIR_IF_FLAT: booleanString.default(true),
  POST_MERGE_FLAT_DUST_SHARES: numberString.default(0.5),
  COMPLETION_STRICT_CAP: numberString.default(1),
  COMPLETION_SOFT_CAP: numberString.default(1.015),
  COMPLETION_HARD_CAP: numberString.default(1.03),
  EMERGENCY_COMPLETION_HARD_CAP: numberString.default(1.045),
  EMERGENCY_COMPLETION_MAX_QTY: numberString.default(5),
  EMERGENCY_REQUIRES_HARD_IMBALANCE: booleanString.default(true),
  MAX_NEGATIVE_EDGE_PER_MARKET_USDC: numberString.default(3),
  MAX_MARKET_EXPOSURE_SHARES: numberString.default(500),
  SOFT_IMBALANCE_RATIO: numberString.default(0.02),
  HARD_IMBALANCE_RATIO: numberString.default(0.05),
  HIGH_SIDE_PRICE_THRESHOLD: numberString.default(0.75),
  LOW_SIDE_MAX_FOR_HIGH_COMPLETION: numberString.default(0.2),
  REQUIRE_STRICT_CAP_FOR_HIGH_LOW_MISMATCH: booleanString.default(true),
  ALLOW_HIGH_SIDE_EMERGENCY_CHASE: booleanString.default(true),
  HIGH_SIDE_EMERGENCY_MAX_QTY: numberString.default(5),
  HIGH_SIDE_EMERGENCY_REQUIRES_FAIR_VALUE: booleanString.default(true),
  HIGH_SIDE_EMERGENCY_REQUIRES_HARD_IMBALANCE: booleanString.default(true),
  HIGH_SIDE_EMERGENCY_CAP: numberString.default(1.035),
  ENABLE_RESIDUAL_SELL: booleanString.default(false),
  ALLOW_UNRESOLVED_SELL: booleanString.default(false),
  ALLOW_EMERGENCY_SELL: booleanString.default(false),
  ALLOW_RESIDUAL_COMPLETION: booleanString.default(true),
  LOT_LADDER: numberList.default([20, 40, 60, 80, 100]),
  LIVE_SMALL_LOTS: numberList.default([20, 40]),
  DEFAULT_LOT: numberString.default(5),
  MAX_MARKET_SHARES_PER_SIDE: numberString.default(500),
  MAX_ONE_SIDED_EXPOSURE_SHARES: numberString.default(150),
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
  FINAL_WINDOW_SOFT_START_SEC: numberString.default(60),
  FINAL_WINDOW_COMPLETION_ONLY_SEC: numberString.default(30),
  FINAL_WINDOW_NO_CHASE_SEC: numberString.default(10),
  ALLOW_NEW_PAIR_IN_LAST_60S: booleanString.default(true),
  ALLOW_NEW_PAIR_IN_LAST_30S: booleanString.default(false),
  ALLOW_SINGLE_LEG_SEED_IN_LAST_60S: booleanString.default(false),
  ALLOW_SOFT_COMPLETION_IN_LAST_30S: booleanString.default(true),
  ALLOW_HARD_COMPLETION_IN_LAST_30S: booleanString.default(true),
  ALLOW_HARD_COMPLETION_IN_LAST_10S: booleanString.default(false),
  ALLOW_ANY_NEW_BUY_IN_LAST_10S: booleanString.default(false),
  FINAL_HARD_COMPLETION_MAX_QTY: numberString.default(15),
  FINAL_HARD_COMPLETION_MAX_NEGATIVE_EDGE_USDC: numberString.default(0.75),
  FINAL_HARD_COMPLETION_REQUIRES_HARD_IMBALANCE: booleanString.default(true),
  PARTIAL_FAST_WINDOW_SEC: numberString.default(10),
  PARTIAL_SOFT_WINDOW_SEC: numberString.default(30),
  PARTIAL_PATIENT_WINDOW_SEC: numberString.default(90),
  PARTIAL_FAST_CAP: numberString.default(1.005),
  PARTIAL_SOFT_CAP: numberString.default(1.02),
  PARTIAL_HARD_CAP: numberString.default(1.035),
  PARTIAL_EMERGENCY_CAP: numberString.default(1.045),
  PARTIAL_SOFT_MAX_QTY: numberString.default(10),
  PARTIAL_HARD_MAX_QTY: numberString.default(5),
  PARTIAL_EMERGENCY_MAX_QTY: numberString.default(5),
  PARTIAL_EMERGENCY_REQUIRES_FAIR_VALUE: booleanString.default(true),
  PARTIAL_NO_CHASE_LAST_SEC: numberString.default(10),
  PARTIAL_COMPLETION_FRACTIONS: numberList.default([0.5, 0.75, 1]),
  MAX_RESIDUAL_HOLD_SHARES: numberString.default(10),
  RESIDUAL_UNWIND_SEC_TO_CLOSE: numberString.default(15),
  SELL_UNWIND_ENABLED: booleanString.default(false),
  DAILY_MAX_LOSS_USDC: numberString.default(50),
  MARKET_MAX_LOSS_USDC: numberString.default(10),
  MIN_USDC_BALANCE: numberString.default(10),
  MIN_USDC_BALANCE_FOR_NEW_ENTRY: numberString.default(25),
  MIN_USDC_BALANCE_FOR_COMPLETION: numberString.default(5),
  MIN_USDC_BALANCE_FOR_MERGE_REDEEM: numberString.default(0),
  ALLOW_COMPLETION_UNDER_MIN_BALANCE: booleanString.default(true),
  ALLOW_NEW_ENTRY_UNDER_MIN_BALANCE: booleanString.default(false),
  LOW_BALANCE_COMPLETION_MAX_QTY: numberString.default(15),
  LOW_BALANCE_COMPLETION_BUDGET_USDC: numberString.default(0.5),
  ENABLE_FAIR_VALUE_FILTER: booleanString.default(true),
  PRICE_TO_BEAT_POLICY: z.enum(["EXPLICIT_ONLY", "EXPLICIT_OR_START_CAPTURE"]).default("EXPLICIT_OR_START_CAPTURE"),
  PRICE_TO_BEAT_START_CAPTURE_WINDOW_MS: numberString.default(3000),
  PRICE_TO_BEAT_MAX_FEED_AGE_MS: numberString.default(1000),
  PRICE_TO_BEAT_PROVISIONAL_ALLOWED: booleanString.default(true),
  PRICE_TO_BEAT_EXPLICIT_OVERRIDE_ALLOWED: booleanString.default(true),
  PRICE_TO_BEAT_FAIL_CLOSED_AFTER_SEC: numberString.default(15),
  PRICE_TO_BEAT_LATE_START_FALLBACK_ENABLED: booleanString.default(false),
  PRICE_TO_BEAT_LATE_START_MAX_MARKET_AGE_SEC: numberString.default(90),
  PRICE_TO_BEAT_LATE_START_MAX_FEED_AGE_MS: numberString.default(1000),
  MAX_FAIR_PREMIUM_FOR_SEED: numberString.default(0.03),
  MAX_FAIR_PREMIUM_FOR_COMPLETION: numberString.default(0.06),
  MAX_FAIR_PREMIUM_FOR_EMERGENCY: numberString.default(0.1),
  FAIR_VALUE_FAIL_CLOSED_FOR_SEED: booleanString.default(true),
  FAIR_VALUE_FAIL_CLOSED_FOR_NEGATIVE_PAIR: booleanString.default(true),
  FAIR_VALUE_FAIL_CLOSED_FOR_HIGH_SIDE_CHASE: booleanString.default(true),
  ALLOW_STRICT_RESIDUAL_COMPLETION_WITHOUT_FAIR_VALUE: booleanString.default(true),
  STRICT_RESIDUAL_COMPLETION_CAP: numberString.default(1),
  SOFT_RESIDUAL_COMPLETION_CAP: numberString.default(1.015),
  FORBID_UNDERDOG_BUY_IF_FAIR_BELOW_PRICE: booleanString.default(true),
  FAIR_VALUE_UNDERDOG_PRICE_THRESHOLD: numberString.default(0.35),
  FAIR_VALUE_MAX_SOURCE_DIVERGENCE_FRAC: numberString.default(0.0025),
  FAIR_VALUE_MAX_SOURCE_DIVERGENCE_USD: numberString.default(25),
  PAIRGROUP_REPAIR_REQUIRED_SCOPE: z.enum(["MARKET", "GLOBAL"]).default("MARKET"),
  PAIRGROUP_REPAIR_REPEAT_ESCALATION: z.enum(["NONE", "GLOBAL_SAFE_HALT"]).default("GLOBAL_SAFE_HALT"),
  MAX_GROUPLESS_FILL_EVENTS_BEFORE_GLOBAL_HALT: numberString.default(2),
  BLOCK_NEW_ENTRY_ON_EXTERNAL_ACTIVITY: booleanString.default(true),
  REQUIRE_RECONCILE_AFTER_MANUAL_TRADE: booleanString.default(true),
  EXTERNAL_ACTIVITY_MODE: z.enum(["NO_NEW_ENTRY", "SAFE_HALT"]).default("SAFE_HALT"),
  ALLOW_AUTO_RESUME_AFTER_EXTERNAL_ACTIVITY: booleanString.default(false),
  REQUIRE_MANUAL_RESUME_CONFIRM: booleanString.default(true),
  RESTART_RESTORE_PARTIAL_AS_COMPLETION_ONLY: booleanString.default(true),
  BLOCK_NEW_PAIR_WHEN_RESTORED_PARTIAL_EXISTS: booleanString.default(true),
  RESTORED_PARTIAL_ALLOW_SEED: booleanString.default(false),
  RESTORED_PARTIAL_ALLOW_SAME_SIDE_BUY: booleanString.default(false),
  STATE_RECONCILE_TOLERANCE_SHARES: numberString.default(0.5),
  LOT_SCALING_MODE: z.enum(["FIXED", "BANKROLL_ADJUSTED"]).default("BANKROLL_ADJUSTED"),
  XUAN_BASE_LOT_LADDER: numberList.default([30, 60, 90, 120]),
  LIVE_SMALL_LOT_LADDER: numberList.default([5, 10, 15]),
  MAX_MARKET_NOTIONAL_PCT: numberString.default(0.25),
  MAX_SINGLE_ORDER_NOTIONAL_PCT: numberString.default(0.05),
  REJECT_UNCLASSIFIED_BUY: booleanString.default(true),
  VALIDATION_SEQUENCE: z.enum(["NONE", "REPLAY_THEN_LIVE"]).default("REPLAY_THEN_LIVE"),
  REPLAY_REQUIRED_BEFORE_LIVE: booleanString.default(true),
  LIVE_SMOKE_MAX_QTY: numberString.default(2),
  LIVE_SMOKE_DISABLE_HARD_SWEEP: booleanString.default(true),
  LIVE_SMOKE_DISABLE_SEED: booleanString.default(true),
  PAIRGROUP_FINALIZE_AFTER_BALANCE_SYNC: booleanString.default(true),
  PAIRGROUP_FINALIZE_TIMEOUT_MS: numberString.default(3000),
  PAIRGROUP_REQUIRE_RECONCILE_BEFORE_NONE_FILLED: booleanString.default(true),
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
