import { describe, expect, it } from "vitest";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { applyFill, applyMerge, imbalance, mergeableShares, pairVwapSum } from "../../src/strategy/xuan5m/inventoryState.js";
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
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 60,
      timestamp: 1713696011,
      makerTaker: "taker",
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
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.49,
      size: 30,
      timestamp: 1713696011,
      makerTaker: "taker",
    });

    const merge = planMerge(config, state);
    expect(merge.shouldMerge).toBe(true);
    expect(merge.mergeable).toBe(30);
  });

  it("reduces shares and keeps remaining average cost stable on sell fills", () => {
    let state = createMarketState(buildOfflineMarket(1713696000));
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 60,
      timestamp: 1713696010,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "SELL",
      price: 0.52,
      size: 20,
      timestamp: 1713696015,
      makerTaker: "taker",
    });

    expect(state.upShares).toBe(40);
    expect(state.upCost).toBeCloseTo(19.2, 8);
  });

  it("reduces both shares and costs on merge", () => {
    let state = createMarketState(buildOfflineMarket(1713696000));
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.48,
      size: 40,
      timestamp: 1713696010,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 40,
      timestamp: 1713696011,
      makerTaker: "taker",
    });

    state = applyMerge(state, {
      amount: 20,
      timestamp: 1713696020,
      simulated: true,
    });

    expect(state.upShares).toBe(20);
    expect(state.downShares).toBe(20);
    expect(state.upCost).toBeCloseTo(9.6, 8);
    expect(state.downCost).toBeCloseTo(9.4, 8);
  });
});
