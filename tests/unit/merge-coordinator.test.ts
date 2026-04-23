import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
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
});
