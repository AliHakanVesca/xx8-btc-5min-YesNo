import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { resolveBundledMergeClusterPrior } from "../../src/analytics/xuanExactReference.js";
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

  it("uses generic age and forced-age merge gates when clone mode has no exact merge prior", () => {
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
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 76,
      secsFromOpen: 76,
      secsToClose: 224,
      usdcBalance: 100,
      tracker,
    });

    expect(shieldedGate.allow).toBe(true);
    expect(shieldedGate.reason).toBe("age_target");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("forced_age");
  });

  it("uses generic cycle-target merge when clone mode has no exact merge prior", () => {
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

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("cycle_target");
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

    expect(delayedGate.allow).toBe(true);
    expect(delayedGate.reason).toBe("forced_age");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("forced_age");
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

    expect(delayedGate.allow).toBe(true);
    expect(delayedGate.reason).toBe("forced_age");
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
