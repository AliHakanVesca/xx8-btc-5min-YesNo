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
      nowTs: market.startTs + 80,
      secsFromOpen: 80,
      secsToClose: 220,
      usdcBalance: 100,
      tracker,
    });
    const releasedGate = evaluateDelayedMergeGate(config, state, {
      nowTs: market.startTs + 121,
      secsFromOpen: 121,
      secsToClose: 179,
      usdcBalance: 100,
      tracker,
    });

    expect(shieldedGate.allow).toBe(false);
    expect(shieldedGate.reason).toBe("entry_shield");
    expect(releasedGate.allow).toBe(true);
    expect(releasedGate.reason).toBe("age_target");
  });
});
