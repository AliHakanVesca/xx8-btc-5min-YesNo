import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { resolveBundledMergeClusterPrior } from "../../src/analytics/xuanExactReference.js";
import { applyFill, applyMerge } from "../../src/strategy/xuan5m/inventoryState.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { classifyFlowPressureBudget } from "../../src/strategy/xuan5m/modePolicy.js";
import {
  createMergeBatchTracker,
  evaluateDelayedMergeGate,
  syncMergeBatchTracker,
} from "../../src/strategy/xuan5m/mergeCoordinator.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      ...overrides,
    }),
  );
}

describe("merge coordinator", () => {
  it("immediately releases a profitable fixed 5/5 basket without first-merge age delay", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "5",
      LIVE_SMALL_LOT_LADDER: "5",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
      MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: "2",
      MIN_FIRST_MATCHED_AGE_BEFORE_MERGE_SEC: "45",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.32,
      size: 5,
      timestamp: market.startTs + 9,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.58,
      size: 5,
      timestamp: market.startTs + 16,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 16);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 17,
      secsFromOpen: 17,
      secsToClose: 283,
      usdcBalance: 100,
      tracker,
    });

    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(config.marketBasketMinMergeShares).toBe(5);
    expect(config.marketBasketMergeTargetMaxShares).toBe(5);
    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.pendingMatchedQty).toBe(5);
  });

  it("immediately releases a raw-positive fixed 5/5 basket even when fee-inclusive score is above one", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "5",
      LIVE_SMALL_LOT_LADDER: "5",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.37,
      size: 5.138887,
      timestamp: market.startTs + 12,
      makerTaker: "taker",
      executionMode: "POST_MERGE_RESIDUAL_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.6,
      size: 5,
      timestamp: market.startTs + 10,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 12);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 37,
      secsFromOpen: 37,
      secsToClose: 263,
      usdcBalance: 100,
      tracker,
    });

    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("does not let bounded overfill push a 15-share Xuan recycle basket out of quick merge release", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "15",
      LIVE_SMALL_LOT_LADDER: "15",
      DEFAULT_LOT: "15",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
      XUAN_RHYTHM_MAX_WAIT_SEC: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyMerge(
      applyFill(
        applyFill(state, {
          outcome: "UP",
          side: "BUY",
          price: 0.4,
          size: 15,
          timestamp: market.startTs + 5,
          makerTaker: "taker",
          executionMode: "PAIRGROUP_COVERED_SEED",
        }),
        {
          outcome: "DOWN",
          side: "BUY",
          price: 0.55,
          size: 15,
          timestamp: market.startTs + 8,
          makerTaker: "taker",
          executionMode: "PARTIAL_FAST_COMPLETION",
        },
      ),
      { amount: 15, timestamp: market.startTs + 20, simulated: true },
    );
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 16.925482,
      timestamp: market.startTs + 160,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.6,
      size: 16.925482,
      timestamp: market.startTs + 161,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 16.925482, market.startTs + 161);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 172,
      secsFromOpen: 172,
      secsToClose: 128,
      usdcBalance: 100,
      tracker,
    });

    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.pendingMatchedQty).toBeCloseTo(16.925482, 6);
  });

  it("does not immediately realize a fixed 5/5 basket with negative effective economics", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "5",
      LIVE_SMALL_LOT_LADDER: "5",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 5,
      timestamp: market.startTs + 9,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.6,
      size: 5,
      timestamp: market.startTs + 16,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 16);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 17,
      secsFromOpen: 17,
      secsToClose: 283,
      usdcBalance: 100,
      tracker,
    });

    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("negative_economics_hold");
    expect(gate.mergeVsCarryDecision).toBe("CARRY_TO_SETTLEMENT");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("releases a fixed 5/5 negative basket after the Xuan recycle wait instead of holding until close", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "5",
      LIVE_SMALL_LOT_LADDER: "5",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 5,
      timestamp: market.startTs + 9,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.6,
      size: 5,
      timestamp: market.startTs + 16,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 16);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 37,
      secsFromOpen: 37,
      secsToClose: 263,
      usdcBalance: 100,
      tracker,
    });

    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("releases a fixed 15/15 post-merge recycle after the Xuan wait instead of holding until final window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "15",
      LIVE_SMALL_LOT_LADDER: "15",
      DEFAULT_LOT: "15",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 15,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 15,
      timestamp: market.startTs + 32,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyMerge(state, {
      amount: 15,
      timestamp: market.startTs + 170,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.51,
      size: 15,
      timestamp: market.startTs + 190,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 15,
      timestamp: market.startTs + 198,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 198);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 212,
      secsFromOpen: 212,
      secsToClose: 88,
      usdcBalance: 100,
      tracker,
    });

    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(config.marketBasketMinMergeShares).toBe(15);
    expect(config.marketBasketMergeTargetMaxShares).toBe(15);
    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.pendingMatchedQty).toBe(15);
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("holds age-target merge while a material temporal planned opposite remains open", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.51,
      size: 100,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 80,
      timestamp: market.startTs + 52,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 52);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 181,
      secsFromOpen: 181,
      secsToClose: 119,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("planned_opposite_hold");
  });

  it("releases a profitable matched basket in the family merge window when the open planned opposite is stale", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.39,
      size: 100,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 80,
      timestamp: market.startTs + 52,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 52);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 181,
      secsFromOpen: 181,
      secsToClose: 119,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("age_target");
    expect(gate.basketEffectivePair).toBeLessThanOrEqual(0.995);
  });

  it("releases a raw-profitable family basket even when sunk taker fees push effective cost above the merge cap", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      LIVE_SMALL_LOT_LADDER: "5,8,12,15",
      MARKET_BASKET_MIN_MERGE_SHARES: "15",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
      MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.4,
      size: 15,
      timestamp: market.startTs + 37,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.57,
      size: 15,
      timestamp: market.startTs + 54,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 54);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 169,
      secsFromOpen: 169,
      secsToClose: 131,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("age_target");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("allows merge after the first matched window ages past the soft timer", () => {
    const config = buildConfig();
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsToClose: 180,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("age_target");
    expect(gate.completedCycles).toBe(1);
    expect(gate.pendingMatchedQty).toBe(5);
  });

  it("holds cycle-target merge until the first matched window also ages", () => {
    const config = buildConfig();
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 12);

    const earlyGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 20,
      secsToClose: 220,
      usdcBalance: 100,
      tracker,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsToClose: 194,
      usdcBalance: 100,
      tracker,
    });

    expect(earlyGate.allow).toBe(false);
    expect(earlyGate.reason).toBe("not_ready");
    expect(earlyGate.completedCycles).toBe(2);
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.forced).toBe(false);
    expect(releasedGate.reason).toBe("cycle_target");
    expect(releasedGate.pendingMatchedQty).toBe(10);
  });

  it("forces merge once the oldest matched window exceeds the hard age cap", () => {
    const config = buildConfig();
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 76,
      secsToClose: 150,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(true);
    expect(gate.reason).toBe("forced_age");
    expect(gate.oldestMatchedAgeSec).toBe(76);
  });

  it("releases small explicit aggressive public-footprint baskets immediately for fixed 15/15 recycle", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "5,8,12,15",
      LIVE_SMALL_LOT_LADDER: "5,8,12,15",
      MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC: "75",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.43,
      size: 15,
      timestamp: market.startTs + 60,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 15,
      timestamp: market.startTs + 63,
      makerTaker: "taker",
      executionMode: "HIGH_LOW_COMPLETION_CHASE",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 63);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 159,
      secsFromOpen: 159,
      secsToClose: 141,
      usdcBalance: 100,
      tracker,
    });

    expect(config.marketBasketMinMergeShares).toBe(15);
    expect(config.marketBasketMergeTargetMaxShares).toBe(15);
    expect(config.maxMatchedAgeBeforeForcedMergeSec).toBe(5);
    expect(config.mergeBatchMode).toBe("IMMEDIATE");
    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("cycle_target");
  });

  it("releases a large high-quality matched basket before the generic age target", () => {
    const config = buildConfig({
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.39,
      size: 80,
      timestamp: market.startTs + 10,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 80,
      timestamp: market.startTs + 11,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 11);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsFromOpen: 46,
      secsToClose: 254,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("basket_target");
    expect(gate.pendingMatchedQty).toBe(80);
  });

  it("holds a public-footprint strong basket below the xuan-sized merge target", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      MARKET_BASKET_MIN_MERGE_SHARES: "40",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.39,
      size: 80,
      timestamp: market.startTs + 10,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 80,
      timestamp: market.startTs + 11,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 11);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsFromOpen: 46,
      secsToClose: 254,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("public_footprint_hold");
    expect(gate.pendingMatchedQty).toBe(80);
  });

  it("holds public-footprint age merges until the market basket reaches the xuan target", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.48,
      size: 95,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.531934,
      size: 95,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 95, market.startTs + 1);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsFromOpen: 46,
      secsToClose: 254,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("basket_debt_hold");
    expect(gate.pendingMatchedQty).toBe(95);
  });

  it("uses aggressive family timing for first merge without exact prior", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.44,
      size: 40,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.45,
      size: 40,
      timestamp: market.startTs + 21,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 40, market.startTs + 21);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 170,
      secsFromOpen: 170,
      secsToClose: 130,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("age_target");
  });

  it("holds aggressive first family merge when basket economics are negative", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.56,
      size: 80,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.53,
      size: 80,
      timestamp: market.startTs + 21,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 21);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 170,
      secsFromOpen: 170,
      secsToClose: 130,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("negative_economics_hold");
    expect(gate.mergeVsCarryDecision).toBe("CARRY_TO_SETTLEMENT");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("releases aggressive family merge after partial-soft planned opposite coverage", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 110,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.38,
      size: 70,
      timestamp: market.startTs + 28,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 40,
      timestamp: market.startTs + 29,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 110, market.startTs + 29);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 170,
      secsFromOpen: 170,
      secsToClose: 130,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("age_target");
    expect(gate.pendingMatchedQty).toBe(110);
  });

  it("holds aggressive family merge before the first xuan timing window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.44,
      size: 40,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.45,
      size: 40,
      timestamp: market.startTs + 21,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 40, market.startTs + 21);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsFromOpen: 46,
      secsToClose: 254,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("not_ready");
    expect(gate.pendingMatchedQty).toBe(40);
  });

  it("holds aggressive hard-imbalance merge before the first xuan timing window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.44,
      size: 90,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.58,
      size: 30,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 30, market.startTs + 1);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 1,
      secsFromOpen: 1,
      secsToClose: 299,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("not_ready");
    expect(gate.pendingMatchedQty).toBe(30);
  });

  it("forces aggressive family merge in the final xuan window without exact prior", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.5,
      size: 10,
      timestamp: market.startTs + 180,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.48,
      size: 10,
      timestamp: market.startTs + 181,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 181);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 278,
      secsFromOpen: 278,
      secsToClose: 22,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(true);
    expect(gate.reason).toBe("final_window");
  });

  it("holds aggressive post-merge cycle-target merge when basket economics are negative", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "20",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.5,
      size: 90,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.48,
      size: 90,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    state = applyMerge(state, {
      amount: 90,
      timestamp: market.startTs + 160,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.62,
      size: 20,
      timestamp: market.startTs + 185,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.45,
      size: 20,
      timestamp: market.startTs + 186,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 20, market.startTs + 186);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 210,
      secsFromOpen: 210,
      secsToClose: 90,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("negative_economics_hold");
    expect(gate.mergeVsCarryReason).toBe("cycle_merge_negative_economics_hold");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("releases a stale fixed 15/15 negative basket as a controlled loss so recycle is not locked", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "15",
      LIVE_SMALL_LOT_LADDER: "15",
      MARKET_BASKET_MIN_MERGE_SHARES: "15",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 15,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 15,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    state = applyMerge(state, {
      amount: 15,
      timestamp: market.startTs + 160,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.73,
      size: 15,
      timestamp: market.startTs + 185,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.55,
      size: 15,
      timestamp: market.startTs + 188,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 188);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 220,
      secsFromOpen: 220,
      secsToClose: 80,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("does not let the first family merge window release a post-merge negative age-target recycle", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
      MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: "2",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.5,
      size: 100,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.48,
      size: 100,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    state = applyMerge(state, {
      amount: 100,
      timestamp: market.startTs + 160,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.43,
      size: 80,
      timestamp: market.startTs + 161,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.67,
      size: 80,
      timestamp: market.startTs + 185,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 40, market.startTs + 170);
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 185);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 185,
      secsFromOpen: 185,
      secsToClose: 115,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("negative_economics_hold");
    expect(gate.mergeVsCarryReason).toBe("cycle_merge_negative_economics_hold");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("does not forced-age merge an aggressive negative normal recycle before final flatten", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
      MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC: "70",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.56,
      size: 120,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.53,
      size: 120,
      timestamp: market.startTs + 21,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 120, market.startTs + 21);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 211,
      secsFromOpen: 211,
      secsToClose: 89,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("negative_economics_hold");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("still allows final residual flatten even when post-merge basket economics are negative", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.5,
      size: 90,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.48,
      size: 90,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    state = applyMerge(state, {
      amount: 90,
      timestamp: market.startTs + 160,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.43,
      size: 80,
      timestamp: market.startTs + 256,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.6,
      size: 80,
      timestamp: market.startTs + 276,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 80, market.startTs + 276);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 276,
      secsFromOpen: 276,
      secsToClose: 24,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(true);
    expect(gate.reason).toBe("final_window");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("holds a fresh post-merge final carry completion instead of merging immediately", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      MARKET_BASKET_MIN_MERGE_SHARES: "30",
      MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP: "1",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 214,
      timestamp: market.startTs + 126,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.23,
      size: 214,
      timestamp: market.startTs + 174,
      makerTaker: "taker",
    });
    state = applyMerge(state, {
      amount: 214,
      timestamp: market.startTs + 178,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.56,
      size: 255,
      timestamp: market.startTs + 230,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.79,
      size: 255,
      timestamp: market.startTs + 276,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 255, market.startTs + 276);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 276,
      secsFromOpen: 276,
      secsToClose: 24,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("not_ready");

    const laterGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 290,
      secsFromOpen: 290,
      secsToClose: 10,
      usdcBalance: 100,
      tracker,
    });

    expect(laterGate.allow).toBe(false);
    expect(laterGate.reason).toBe("not_ready");
  });

  it("releases a public-footprint basket once the xuan-sized merge target is reached", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.39,
      size: 320,
      timestamp: market.startTs + 10,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 320,
      timestamp: market.startTs + 11,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 320, market.startTs + 11);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsFromOpen: 46,
      secsToClose: 254,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("basket_target");
    expect(gate.pendingMatchedQty).toBe(320);
  });

  it("forces merge in the final window and under low collateral", () => {
    const config = buildConfig();
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);

    const finalWindowGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 275,
      secsToClose: 25,
      usdcBalance: 100,
      tracker,
    });
    const lowCollateralGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 15,
      secsToClose: 250,
      usdcBalance: 5,
      tracker,
    });

    expect(finalWindowGate.allow).toBe(true);
    expect(finalWindowGate.forced).toBe(true);
    expect(finalWindowGate.reason).toBe("final_window");
    expect(lowCollateralGate.allow).toBe(true);
    expect(lowCollateralGate.forced).toBe(true);
    expect(lowCollateralGate.reason).toBe("low_collateral");
  });

  it("forces a small debt-positive public-footprint basket merge in the final window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 33.25,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.52,
      size: 33.25,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 33.25, market.startTs + 1);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 275,
      secsFromOpen: 275,
      secsToClose: 25,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(true);
    expect(gate.reason).toBe("final_window");
    expect(gate.mergeVsCarryDecision).toBe("MERGE_NOW");
    expect(gate.mergeVsCarryReason).toBe("debt_positive_final_window_forced_merge");
    expect(gate.basketEffectivePair).toBeGreaterThan(1);
  });

  it("does not forced-age merge a profitable public-footprint basket below the xuan target", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      DEFAULT_LOT: "80",
      LIVE_SMALL_LOT_LADDER: "80,120",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 33.25,
      timestamp: market.startTs,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.46,
      size: 33.25,
      timestamp: market.startTs + 53,
      makerTaker: "taker",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 33.25, market.startTs + 53);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 181,
      secsFromOpen: 181,
      secsToClose: 119,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("public_footprint_hold");
    expect(gate.pendingMatchedQty).toBe(33.25);
  });

  it("defers small hard-imbalance merges briefly in xuan mode to preserve batching rhythm", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      FORCE_MERGE_ON_HARD_IMBALANCE: "true",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 5;
    state.downShares = 4.25;
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 4.25, market.startTs + 153);

    const deferredGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 153,
      secsFromOpen: 153,
      secsToClose: 147,
      usdcBalance: 100,
      tracker,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 169,
      secsFromOpen: 169,
      secsToClose: 131,
      usdcBalance: 100,
      tracker,
    });

    expect(deferredGate.allow).toBe(false);
    expect(deferredGate.reason).toBe("hard_imbalance_deferred");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("hard_imbalance");
  });

  it("keeps aggressive public-footprint hard imbalance open for completion before final window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      FORCE_MERGE_ON_HARD_IMBALANCE: "true",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 7.5;
    state.downShares = 91.25;
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 7.5, market.startTs + 60);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 160,
      secsFromOpen: 160,
      secsToClose: 140,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("hard_imbalance_deferred");
  });

  it("defers hard-imbalance flush caused by a small overlap seed", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      FORCE_MERGE_ON_HARD_IMBALANCE: "true",
      CONTROLLED_OVERLAP_SEED_MAX_QTY: "5",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.downShares = 5;
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 7);

    const deferredGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 11,
      secsFromOpen: 11,
      secsToClose: 289,
      usdcBalance: 100,
      tracker,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 23,
      secsFromOpen: 23,
      secsToClose: 277,
      usdcBalance: 100,
      tracker,
    });

    expect(deferredGate.allow).toBe(false);
    expect(deferredGate.reason).toBe("hard_imbalance_deferred");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("hard_imbalance");
  });

  it("extends hard-imbalance deferral while a bounded B2 overlap window is active", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      FORCE_MERGE_ON_HARD_IMBALANCE: "true",
      CONTROLLED_OVERLAP_SEED_MAX_QTY: "5",
      HARD_IMBALANCE_MERGE_OVERLAP_GRACE_SEC: "45",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.downShares = 5;
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 7);

    const stillDeferredGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 30,
      secsFromOpen: 30,
      secsToClose: 270,
      usdcBalance: 100,
      tracker,
      activeIndependentFlowCount: 2,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 53,
      secsFromOpen: 53,
      secsToClose: 247,
      usdcBalance: 100,
      tracker,
      activeIndependentFlowCount: 2,
    });

    expect(stillDeferredGate.allow).toBe(false);
    expect(stillDeferredGate.reason).toBe("hard_imbalance_deferred");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("hard_imbalance");
  });

  it("holds generic age merges in public-footprint mode below the basket target", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);

    const shieldedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 74,
      secsFromOpen: 74,
      secsToClose: 226,
      usdcBalance: 100,
      tracker,
    });
    const stillHeldGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 76,
      secsFromOpen: 76,
      secsToClose: 224,
      usdcBalance: 100,
      tracker,
    });

    expect(shieldedGate.allow).toBe(false);
    expect(shieldedGate.reason).toBe("public_footprint_hold");
    expect(stillHeldGate.allow).toBe(false);
    expect(stillHeldGate.reason).toBe("public_footprint_hold");
  });

  it("forces an aged debt-positive public-footprint basket instead of holding it until the final window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 95,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 95,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 95, market.startTs + 1);

    const heldGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 181,
      secsFromOpen: 181,
      secsToClose: 119,
      usdcBalance: 100,
      tracker,
    });
    const finalGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 281,
      secsFromOpen: 281,
      secsToClose: 19,
      usdcBalance: 100,
      tracker,
    });

    expect(heldGate.allow).toBe(true);
    expect(heldGate.forced).toBe(true);
    expect(heldGate.reason).toBe("forced_age");
    expect(finalGate.allow).toBe(true);
    expect(finalGate.forced).toBe(true);
    expect(finalGate.reason).toBe("final_window");
    expect(finalGate.mergeVsCarryDecision).toBe("MERGE_NOW");
    expect(finalGate.mergeVsCarryReason).toBe("debt_positive_final_window_forced_merge");
  });

  it("does not hard-imbalance merge a tiny debt-positive matched basket while residual completion can continue", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 95,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.6,
      size: 5,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs + 1);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 1,
      secsFromOpen: 1,
      secsToClose: 299,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("basket_debt_hold");
  });

  it("holds public-footprint hard-imbalance merges below the normalized base-lot basket target", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      DEFAULT_LOT: "95",
      LIVE_SMALL_LOT_LADDER: "95,190",
      FORCE_MERGE_ON_HARD_IMBALANCE: "true",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 95,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.35,
      size: 65,
      timestamp: market.startTs + 80,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 65, market.startTs + 80);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 125,
      secsFromOpen: 125,
      secsToClose: 175,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("public_footprint_hold");
    expect(gate.pendingMatchedQty).toBe(65);
  });

  it("holds generic cycle-target merges in public-footprint mode below the basket target", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 10);
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 20);
    tracker = syncMergeBatchTracker(tracker, 20, market.startTs + 30);
    tracker = syncMergeBatchTracker(tracker, 25, market.startTs + 40);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 46,
      secsFromOpen: 46,
      secsToClose: 254,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(false);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("public_footprint_hold");
    expect(gate.completedCycles).toBe(5);
  });

  it("delays non-forced merge slightly longer when strong multi-flow pressure is still active", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 10);
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 20);
    tracker = syncMergeBatchTracker(tracker, 20, market.startTs + 30);
    tracker = syncMergeBatchTracker(tracker, 25, market.startTs + 40);

    const delayedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 76,
      secsFromOpen: 76,
      secsToClose: 224,
      usdcBalance: 100,
      tracker,
      flowPressureBudget: 0.9,
      activeIndependentFlowCount: 2,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 89,
      secsFromOpen: 89,
      secsToClose: 211,
      usdcBalance: 100,
      tracker,
      flowPressureBudget: 0.9,
      activeIndependentFlowCount: 2,
    });

    expect(delayedGate.allow).toBe(false);
    expect(delayedGate.reason).toBe("public_footprint_hold");
    expect(releasedGate.allow).toBe(false);
    expect(releasedGate.reason).toBe("public_footprint_hold");
  });

  it("coalesces nearby matched windows when strong multi-flow pressure is still active", () => {
    const market = buildOfflineMarket(1713696000);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs, {
      flowPressureBudget: 0.9,
      activeIndependentFlowCount: 2,
    });
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 10, {
      flowPressureBudget: 0.9,
      activeIndependentFlowCount: 2,
    });

    expect(tracker.trackedMergeable).toBe(10);
    expect(tracker.windows).toHaveLength(1);
    expect(tracker.windows[0]).toMatchObject({
      amount: 10,
      firstAvailableAt: market.startTs,
    });
  });

  it("accepts a precomputed flow-budget state when delaying merge release under strong multi-flow pressure", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    const flowPressureState = classifyFlowPressureBudget({
      budget: 0.9,
      matchedInventoryQuality: 1,
    });
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs, {
      activeIndependentFlowCount: 2,
      flowPressureState,
    });
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 10, {
      activeIndependentFlowCount: 2,
      flowPressureState,
    });
    tracker = syncMergeBatchTracker(tracker, 15, market.startTs + 20, {
      activeIndependentFlowCount: 2,
      flowPressureState,
    });
    tracker = syncMergeBatchTracker(tracker, 20, market.startTs + 30, {
      activeIndependentFlowCount: 2,
      flowPressureState,
    });
    tracker = syncMergeBatchTracker(tracker, 25, market.startTs + 40, {
      activeIndependentFlowCount: 2,
      flowPressureState,
    });

    const delayedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 76,
      secsFromOpen: 76,
      secsToClose: 224,
      usdcBalance: 100,
      tracker,
      activeIndependentFlowCount: 2,
      flowPressureState,
    });

    expect(delayedGate.allow).toBe(false);
    expect(delayedGate.reason).toBe("public_footprint_hold");
  });

  it("uses the exact 1776253500 first merge cluster timing and qty envelope", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 127.05792, market.startTs + 6);
    tracker = syncMergeBatchTracker(tracker, 214.23151, market.startTs + 20);
    tracker = syncMergeBatchTracker(tracker, 341.31645, market.startTs + 42);
    tracker = syncMergeBatchTracker(tracker, 427.9023, market.startTs + 60);
    tracker = syncMergeBatchTracker(tracker, 513.83511, market.startTs + 70);

    const prior = resolveBundledMergeClusterPrior(market.slug, 76);
    const shieldedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 75,
      secsFromOpen: 75,
      secsToClose: 225,
      usdcBalance: 100,
      tracker,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 76,
      secsFromOpen: 76,
      secsToClose: 224,
      usdcBalance: 100,
      tracker,
    });

    expect(prior?.totalQty).toBeCloseTo(513.83511, 5);
    expect(shieldedGate.allow).toBe(false);
    expect(shieldedGate.reason).toBe("entry_shield");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("cycle_target");
    expect(releasedGate.pendingMatchedQty).toBeCloseTo(513.83511, 5);
  });

  it("keeps the exact 1776253500 second merge cluster closed until the canonical late window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 85.27977, market.startTs + 88);

    const earlyGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 200,
      secsFromOpen: 200,
      secsToClose: 100,
      usdcBalance: 100,
      tracker,
    });
    const canonicalGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 276,
      secsFromOpen: 276,
      secsToClose: 24,
      usdcBalance: 100,
      tracker,
    });

    expect(earlyGate.allow).toBe(false);
    expect(earlyGate.reason).toBe("cluster_window");
    expect(canonicalGate.allow).toBe(true);
    expect(canonicalGate.reason).toBe("final_window");
  });
});
