import { describe, expect, it } from "vitest";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { applyFill, applyMerge } from "../../src/strategy/xuan5m/inventoryState.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";

describe("inventory state fifo accounting", () => {
  it("keeps residual lot cost basis after merge", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);

    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.2,
      size: 10,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.4,
      size: 10,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.6,
      size: 20,
      timestamp: market.startTs + 3,
      makerTaker: "taker",
    });

    state = applyMerge(state, {
      amount: 15,
      timestamp: market.startTs + 10,
      simulated: false,
    });

    expect(state.upShares).toBe(5);
    expect(state.downShares).toBe(5);
    expect(state.upCost).toBeCloseTo(2, 8);
    expect(state.downCost).toBeCloseTo(3, 8);
    expect(state.upLots).toEqual([
      expect.objectContaining({
        size: 5,
        price: 0.4,
      }),
    ]);
    expect(state.downLots).toEqual([
      expect.objectContaining({
        size: 5,
        price: 0.6,
      }),
    ]);
    expect(state.mergeHistory.at(-1)).toMatchObject({
      matchedUpCost: 4,
      matchedDownCost: 9,
      mergeReturn: 15,
      realizedPnl: 2,
      remainingUpShares: 5,
      remainingDownShares: 5,
    });
  });
});
