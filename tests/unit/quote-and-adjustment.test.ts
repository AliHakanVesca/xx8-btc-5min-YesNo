import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { chooseInventoryAdjustment } from "../../src/strategy/xuan5m/completionEngine.js";
import { chooseEntryBuys } from "../../src/strategy/xuan5m/entryLadderEngine.js";
import { OrderBookState } from "../../src/strategy/xuan5m/orderBookState.js";
import { Xuan5mBot } from "../../src/strategy/xuan5m/Xuan5mBot.js";

function buildBook(
  assetId: string,
  market: string,
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
) {
  return {
    market,
    assetId,
    timestamp: 1713696010,
    bids,
    asks,
    minOrderSize: 5,
    tickSize: 0.01,
    negRisk: false,
  };
}

describe("entry and inventory adjustment", () => {
  const config = buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    }),
  );

  it("keeps buying only the lagging side during the entry window instead of taker completion", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const bot = new Xuan5mBot();
    state.upShares = 40;
    state.downShares = 10;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const decision = bot.evaluateTick({
      config,
      state,
      books,
      nowTs: market.startTs + 120,
      riskContext: {
        secsToClose: 180,
        staleBookMs: 200,
        balanceStaleMs: 200,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: true,
    });

    expect(decision.risk.allowNewEntries).toBe(true);
    expect(decision.entryBuys).toHaveLength(1);
    expect(decision.entryBuys[0]?.side).toBe("DOWN");
    expect(decision.entryBuys[0]?.reason).toBe("lagging_rebalance");
    expect(decision.entryBuys[0]?.order.side).toBe("BUY");
    expect(decision.entryBuys[0]?.order.tokenId).toBe(market.tokens.DOWN.tokenId);
    expect(decision.entryBuys[0]?.size).toBeGreaterThan(0);
    expect(decision.completion).toBeUndefined();
  });

  it("does not reopen both sides when only one side is carried into the entry window", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const bot = new Xuan5mBot();
    state.upShares = 60;
    state.upCost = 28.2;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const decision = bot.evaluateTick({
      config,
      state,
      books,
      nowTs: market.startTs + 90,
      riskContext: {
        secsToClose: 210,
        staleBookMs: 200,
        balanceStaleMs: 200,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: true,
    });

    expect(decision.entryBuys).toHaveLength(1);
    expect(decision.entryBuys[0]?.side).toBe("DOWN");
    expect(decision.entryBuys[0]?.reason).toBe("lagging_rebalance");
  });

  it("opens with both-side taker buys by default when pair cost is within the entry cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const bot = new Xuan5mBot();
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const decision = bot.evaluateTick({
      config,
      state,
      books,
      nowTs: market.startTs + 15,
      riskContext: {
        secsToClose: 285,
        staleBookMs: 200,
        balanceStaleMs: 200,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: true,
    });

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.map((entry) => entry.side)).toEqual(["UP", "DOWN"]);
    expect(decision.entryBuys.every((entry) => entry.reason === "balanced_pair_seed")).toBe(true);
    expect(decision.entryBuys.every((entry) => entry.order.orderType === "FAK")).toBe(true);
    expect(decision.mergeShares).toBe(20);
  });

  it("scans the configured ladder with real ask-side vwap and keeps the largest rung within cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const vwapConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        LOT_LADDER: "20,40,60,80,100",
        LIVE_SMALL_LOTS: "20,40",
        DEFAULT_LOT: "40",
        ENTRY_TAKER_PAIR_CAP: "1.01",
      }),
    );
    const books = new OrderBookState(
      buildBook(
        market.tokens.UP.tokenId,
        market.conditionId,
        [{ price: 0.46, size: 200 }],
        [
          { price: 0.47, size: 20 },
          { price: 0.5, size: 20 },
          { price: 0.54, size: 60 },
        ],
      ),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.45, size: 200 }],
        [
          { price: 0.46, size: 20 },
          { price: 0.49, size: 20 },
          { price: 0.54, size: 60 },
        ],
      ),
    );

    const entryBuys = chooseEntryBuys(vwapConfig, state, books, {
      secsFromOpen: 15,
      secsToClose: 285,
      lot: 100,
    });

    expect(entryBuys).toHaveLength(2);
    expect(entryBuys.map((entry) => entry.size)).toEqual([40, 40]);
    expect(entryBuys.every((entry) => entry.reason === "balanced_pair_seed")).toBe(true);
    expect(entryBuys[0]?.pairCostWithFees).toBeLessThanOrEqual(1.01);
    expect(entryBuys[0]?.pairCostWithFees).toBeGreaterThan(0.99);
  });

  it("falls back to partial completion when full completion is too expensive", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.48, size: 200 }],
        [
          { price: 0.49, size: 30 },
          { price: 0.54, size: 60 },
        ],
      ),
    );

    const adjustment = chooseInventoryAdjustment(config, state, books, { secsToClose: 55 });

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 30,
      residualAfter: 30,
    });
    expect(adjustment?.unwind).toBeUndefined();
  });

  it("holds residual inventory near the close when sell unwind is disabled", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 80 }], [{ price: 0.44, size: 80 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.54, size: 80 }], [{ price: 0.55, size: 80 }]),
    );

    const adjustment = chooseInventoryAdjustment(config, state, books, { secsToClose: 12 });

    expect(adjustment).toBeNull();
  });

  it("can still sell excess inventory near the close when sell unwind is explicitly enabled", () => {
    const sellUnwindConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        SELL_UNWIND_ENABLED: "true",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 80 }], [{ price: 0.44, size: 80 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.54, size: 80 }], [{ price: 0.55, size: 80 }]),
    );

    const adjustment = chooseInventoryAdjustment(sellUnwindConfig, state, books, { secsToClose: 12 });

    expect(adjustment?.completion).toBeUndefined();
    expect(adjustment?.unwind).toMatchObject({
      sideToSell: "UP",
      unwindShares: 50,
      residualAfter: 10,
    });
  });
});
