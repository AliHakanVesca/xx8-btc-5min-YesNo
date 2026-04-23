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

  it("allows merge immediately after two completed matched windows accumulate", () => {
    const config = buildConfig();
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    let tracker = createMergeBatchTracker();
    tracker = syncMergeBatchTracker(tracker, 5, market.startTs);
    tracker = syncMergeBatchTracker(tracker, 10, market.startTs + 12);

    const gate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 20,
      secsToClose: 220,
      usdcBalance: 100,
      tracker,
    });

    expect(gate.allow).toBe(true);
    expect(gate.forced).toBe(false);
    expect(gate.reason).toBe("cycle_target");
    expect(gate.completedCycles).toBe(2);
    expect(gate.pendingMatchedQty).toBe(10);
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

  it("keeps clone-mode merges out of the early entry shield unless a forced condition appears", () => {
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

    expect(shieldedGate.allow).toBe(false);
    expect(shieldedGate.reason).toBe("entry_shield");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("age_target");
  });

  it("waits for five completed windows before clone-mode cycle-target merge opens", () => {
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
      nowTs: market.startTs + 76,
      secsFromOpen: 76,
      secsToClose: 224,
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

    expect(delayedGate.allow).toBe(false);
    expect(delayedGate.reason).toBe("not_ready");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("age_target");
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
    expect(delayedGate.reason).toBe("not_ready");
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
