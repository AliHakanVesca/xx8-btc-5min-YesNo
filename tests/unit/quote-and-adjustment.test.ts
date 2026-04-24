import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { chooseInventoryAdjustment } from "../../src/strategy/xuan5m/completionEngine.js";
import { classifyFlowPressureBudget } from "../../src/strategy/xuan5m/modePolicy.js";
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

  it("can reopen a balanced pair while partial inventory exists when controlled overlap is allowed", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const bot = new Xuan5mBot();
    const overlapConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "10",
        MAX_MARKET_ORPHAN_USDC: "10",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
      }),
    );
    state.downShares = 10;
    state.downCost = 4.8;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
    );

    const decision = bot.evaluateTick({
      config: overlapConfig,
      state,
      books,
      nowTs: market.startTs + 40,
      riskContext: {
        secsToClose: 260,
        staleBookMs: 200,
        balanceStaleMs: 200,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
      allowControlledOverlap: true,
      arbitrationCarry: {
        recommendation: "favor_independent_overlap",
      },
    });

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.every((entry) => entry.reason === "balanced_pair_reentry")).toBe(true);
    expect(decision.entryBuys.map((entry) => entry.side)).toEqual(["UP", "DOWN"]);
  });

  it("opens with both-side taker buys by default when pair cost is within the entry cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const bot = new Xuan5mBot();
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
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
    expect(decision.mergeShares).toBe(5);
  });

  it("scans the configured ladder with real ask-side vwap and keeps the largest rung within cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const vwapConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        XUAN_BASE_LOT_LADDER: "20,40,60,80,100",
        LIVE_SMALL_LOT_LADDER: "20,40",
        DEFAULT_LOT: "40",
        CLIP_SPLIT_MODE: "OFF",
        NORMAL_PAIR_EFFECTIVE_CAP: "1.01",
        FLAT_STATE_SOFT_PAIR_MAX_QTY: "40",
        FLAT_STATE_HARD_PAIR_MAX_QTY: "40",
        MAX_SINGLE_ORPHAN_QTY: "40",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "40",
        MAX_MARKET_ORPHAN_USDC: "40",
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
          { price: 0.6, size: 60 },
        ],
      ),
    );

    const adjustment = chooseInventoryAdjustment(config, state, books, { secsToClose: 55 });

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 10,
      residualAfter: 50,
      capMode: "strict",
      arbitrationOutcome: "completion",
    });
    expect(adjustment?.unwind).toBeUndefined();
  });

  it("avoids tiny nibble completions while confirmed multi-flow pressure is still active", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        PARTIAL_SOFT_CAP: "1.04",
        COMPLETION_SOFT_CAP: "1.04",
        COMPLETION_QUALITY_MAX_EFFECTIVE_COST: "1.2",
        COMPLETION_QUALITY_MAX_NEGATIVE_EDGE_USDC: "100",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    const weakState = createMarketState(market);
    weakState.upShares = 20;
    weakState.upCost = 8.4;
    weakState.upLots = [{ size: 20, price: 0.42, timestamp: market.endTs - 130 }];

    const strongState = createMarketState(market);
    strongState.upShares = 20;
    strongState.upCost = 8.4;
    strongState.upLots = [{ size: 20, price: 0.42, timestamp: market.endTs - 130 }];
    strongState.fillHistory = [
      {
        outcome: "UP",
        side: "BUY",
        size: 20,
        price: 0.46,
        timestamp: market.endTs - 70,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
        flowLineage: "favor_independent_overlap|UP|DOWN",
      },
      {
        outcome: "DOWN",
        side: "BUY",
        size: 20,
        price: 0.54,
        timestamp: market.endTs - 68,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
        flowLineage: "favor_independent_overlap|DOWN|UP",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.41, size: 120 }], [{ price: 0.42, size: 120 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.55, size: 120 }],
        [
          { price: 0.56, size: 10 },
          { price: 0.74, size: 110 },
        ],
      ),
    );

    const weakAdjustment = chooseInventoryAdjustment(xuanConfig, weakState, books, {
      secsToClose: 80,
      nowTs: market.endTs - 80,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.42,
        fairDown: 0.6,
      },
    });
    const strongAdjustment = chooseInventoryAdjustment(xuanConfig, strongState, books, {
      secsToClose: 80,
      nowTs: market.endTs - 80,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.42,
        fairDown: 0.6,
      },
    });

    expect(weakAdjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 10,
      residualAfter: 10,
      arbitrationOutcome: "completion",
    });
    expect(strongAdjustment).toBeNull();
  });

  it("holds residual inventory near the close when sell unwind is disabled", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 80 }], [{ price: 0.44, size: 80 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.58, size: 80 }], [{ price: 0.59, size: 80 }]),
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
        ALLOW_UNRESOLVED_SELL: "true",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 80 }], [{ price: 0.44, size: 80 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.58, size: 80 }], [{ price: 0.59, size: 80 }]),
    );

    const adjustment = chooseInventoryAdjustment(sellUnwindConfig, state, books, { secsToClose: 12 });

    expect(adjustment?.completion).toBeUndefined();
    expect(adjustment?.unwind).toMatchObject({
      sideToSell: "UP",
      unwindShares: 50,
      residualAfter: 10,
      arbitrationOutcome: "unwind",
    });
  });

  it("waits a bit longer before unwind when multi-flow pressure is still strong", () => {
    const sellUnwindConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        SELL_UNWIND_ENABLED: "true",
        ALLOW_UNRESOLVED_SELL: "true",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;
    state.fillHistory = [
      {
        outcome: "UP",
        side: "BUY",
        size: 20,
        price: 0.46,
        timestamp: market.endTs - 40,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
        flowLineage: "favor_independent_overlap|UP|DOWN",
      },
      {
        outcome: "DOWN",
        side: "BUY",
        size: 20,
        price: 0.54,
        timestamp: market.endTs - 38,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
        flowLineage: "favor_independent_overlap|DOWN|UP",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 80 }], [{ price: 0.44, size: 80 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.58, size: 80 }], [{ price: 0.59, size: 80 }]),
    );

    const adjustment = chooseInventoryAdjustment(sellUnwindConfig, state, books, {
      secsToClose: 20,
      nowTs: market.endTs - 20,
    });

    expect(adjustment).toBeNull();
  });

  it("does not hold unwind when the injected flow-budget state shows low remaining budget", () => {
    const sellUnwindConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        SELL_UNWIND_ENABLED: "true",
        ALLOW_UNRESOLVED_SELL: "true",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 60;
    state.upCost = 27.6;
    state.fillHistory = [
      {
        outcome: "UP",
        side: "BUY",
        size: 20,
        price: 0.46,
        timestamp: market.endTs - 40,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
        flowLineage: "favor_independent_overlap|UP|DOWN",
      },
      {
        outcome: "DOWN",
        side: "BUY",
        size: 20,
        price: 0.54,
        timestamp: market.endTs - 38,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
        flowLineage: "favor_independent_overlap|DOWN|UP",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 80 }], [{ price: 0.44, size: 80 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.58, size: 80 }], [{ price: 0.59, size: 80 }]),
    );

    const adjustment = chooseInventoryAdjustment(sellUnwindConfig, state, books, {
      secsToClose: 12,
      nowTs: market.endTs - 12,
      recentSeedFlowCount: 2,
      activeIndependentFlowCount: 2,
      flowPressureState: classifyFlowPressureBudget({
        budget: 0.5,
        matchedInventoryQuality: 1,
      }),
    });

    expect(adjustment?.completion).toBeUndefined();
    expect(adjustment?.unwind).toMatchObject({
      sideToSell: "UP",
      arbitrationOutcome: "unwind",
    });
  });
});
