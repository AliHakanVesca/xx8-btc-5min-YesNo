import { describe, expect, it } from "vitest";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { applyFill, imbalance, mergeableShares, pairVwapSum } from "../../src/strategy/xuan5m/inventoryState.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { planMerge } from "../../src/strategy/xuan5m/mergeCoordinator.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";

describe("inventory state", () => {
  it("tracks pair vwap and imbalance", () => {
    let state = createMarketState(buildOfflineMarket(1713696000));
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 60,
      timestamp: 1713696010,
      makerTaker: "maker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 60,
      timestamp: 1713696011,
      makerTaker: "maker",
    });

    expect(pairVwapSum(state)).toBeCloseTo(0.97, 8);
    expect(imbalance(state)).toBeCloseTo(0, 8);
    expect(mergeableShares(state)).toBe(60);
  });

  it("queues merge when min shares reached", () => {
    const config = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
      }),
    );
    let state = createMarketState(buildOfflineMarket(1713696000));
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 30,
      timestamp: 1713696010,
      makerTaker: "maker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 30,
      timestamp: 1713696011,
      makerTaker: "maker",
    });

    const merge = planMerge(config, state);
    expect(merge.shouldMerge).toBe(true);
    expect(merge.mergeable).toBe(30);
  });
});
