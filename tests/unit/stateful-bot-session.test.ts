import { describe, expect, it } from "vitest";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { applyFill } from "../../src/strategy/xuan5m/inventoryState.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import {
  inferImmediateOrderResultFill,
  inferUserTradeFill,
  reconcileStateWithBalances,
} from "../../src/live/statefulBotSession.js";

describe("stateful bot session helpers", () => {
  it("infers taker fills from user trade websocket events", () => {
    const market = buildOfflineMarket(1713696000);
    const fill = inferUserTradeFill({
      event: {
        event_type: "trade",
        asset_id: market.tokens.UP.tokenId,
        id: "trade-1",
        market: market.conditionId,
        maker_orders: [
          { order_id: "maker-1", matched_amount: "12.5", price: "0.48", side: "SELL" },
          { order_id: "maker-2", matched_amount: "7.5", price: "0.49", side: "SELL" },
        ],
      },
      market,
      nowTs: 1713696010,
      submittedPrices: {},
    });

    expect(fill).toMatchObject({
      outcome: "UP",
      side: "BUY",
      size: 20,
    });
    expect(fill?.price).toBeCloseTo(0.48375, 8);
  });

  it("prefers submitted BUY intent side over maker-side inversion", () => {
    const market = buildOfflineMarket(1713696000);
    const fill = inferUserTradeFill({
      event: {
        event_type: "trade",
        asset_id: market.tokens.DOWN.tokenId,
        id: "trade-2",
        market: market.conditionId,
        maker_orders: [{ order_id: "maker-3", matched_amount: "5", price: "0.44", side: "BUY" }],
      },
      market,
      nowTs: 1713696012,
      submittedPrices: {
        DOWN: [
          {
            side: "BUY",
            submittedAt: 1713696011,
            groupId: "pair-1",
            orderId: "order-1",
            attributedShares: 0,
            active: true,
          },
        ],
      },
    });

    expect(fill).toMatchObject({
      outcome: "DOWN",
      side: "BUY",
      size: 5,
    });
  });

  it("infers immediate taker fills from matched order results", () => {
    const market = buildOfflineMarket(1713696000);
    const fill = inferImmediateOrderResultFill({
      outcome: "UP",
      nowTs: 1713696015,
      mode: "XUAN_HARD_PAIR_SWEEP",
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.42,
        amount: 2.1,
        shareTarget: 5,
        orderType: "FAK",
      },
      result: {
        success: true,
        simulated: false,
        orderId: "order-1",
        status: "matched",
        requestedAt: 1713696015,
        raw: {
          takingAmount: "5",
          makingAmount: "2.1",
        },
      },
    });

    expect(fill).toMatchObject({
      outcome: "UP",
      side: "BUY",
      price: 0.42,
      size: 5,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
  });

  it("reconciles state from observed balances by inferring missing buys and scaling down reductions", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state.upShares = 30;
    state.upCost = 14.4;
    state.downShares = 10;
    state.downCost = 4.9;

    const reconciled = reconcileStateWithBalances({
      state,
      observed: { up: 45, down: 6 },
      nowTs: 1713696020,
      fallbackPrices: { UP: 0.5, DOWN: 0.52 },
    });

    expect(reconciled.inferredFills).toHaveLength(1);
    expect(reconciled.inferredFills[0]).toMatchObject({
      outcome: "UP",
      side: "BUY",
      size: 15,
      price: 0.5,
    });
    expect(reconciled.corrections).toEqual([
      {
        outcome: "DOWN",
        fromShares: 10,
        toShares: 6,
      },
    ]);
    expect(reconciled.state.upShares).toBe(45);
    expect(reconciled.state.downShares).toBe(6);
    expect(reconciled.state.downCost).toBeCloseTo(2.94, 8);
  });

  it("can ignore a transient zero balance shortfall for a recent bot-owned fill", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 5.125,
      timestamp: 1713696012,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });

    const reconciled = reconcileStateWithBalances({
      state,
      observed: { up: 0, down: 0 },
      nowTs: 1713696013,
      fallbackPrices: { UP: 0.41, DOWN: 0.6 },
      shouldIgnoreShortfall: (candidate) =>
        candidate.outcome === "UP" &&
        candidate.fromShares === 5.125 &&
        candidate.toShares === 0 &&
        candidate.nowTs === 1713696013,
    });

    expect(reconciled.corrections).toEqual([]);
    expect(reconciled.inferredFills).toEqual([]);
    expect(reconciled.state.upShares).toBe(5.125);
    expect(reconciled.state.upCost).toBeCloseTo(2.10125, 8);
  });

  it("shrinks a bot-owned order-result fill to the settled on-chain share quantity without adding a duplicate buy", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 5.125,
      timestamp: 1713696012,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });

    const reconciled = reconcileStateWithBalances({
      state,
      observed: { up: 4.9036, down: 0 },
      nowTs: 1713696017,
      fallbackPrices: { UP: 0.41, DOWN: 0.6 },
    });

    expect(reconciled.inferredFills).toEqual([]);
    expect(reconciled.corrections).toEqual([
      {
        outcome: "UP",
        fromShares: 5.125,
        toShares: 4.9036,
      },
    ]);
    expect(reconciled.state.upShares).toBe(4.9036);
    expect(reconciled.state.upLots).toEqual([
      expect.objectContaining({
        size: 4.9036,
        price: 0.41,
      }),
    ]);
    expect(reconciled.state.upCost).toBeCloseTo(2.010476, 8);
  });
});
