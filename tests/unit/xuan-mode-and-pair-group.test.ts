import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import {
  applyPairOrderType,
  createPairOrderGroup,
  finalizePairExecutionResult,
  resolvePairOrderGroupStatus,
} from "../../src/execution/pairOrderGroup.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { chooseInventoryAdjustment } from "../../src/strategy/xuan5m/completionEngine.js";
import { evaluateEntryBuys } from "../../src/strategy/xuan5m/entryLadderEngine.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { OrderBookState } from "../../src/strategy/xuan5m/orderBookState.js";
import { Xuan5mBot } from "../../src/strategy/xuan5m/Xuan5mBot.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      ...overrides,
    }),
  );
}

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

describe("xuan mode and pair order groups", () => {
  it("rejects soft-negative completion in strict mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 36.8;
    state.downShares = 20;
    state.downCost = 9.2;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.519, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "STRICT",
      }),
      state,
      books,
      { secsToClose: 60 },
    );

    expect(adjustment).toBeNull();
  });

  it("allows soft-negative completion in xuan mode when imbalance is meaningful", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 36.8;
    state.downShares = 20;
    state.downCost = 9.2;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.519, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsToClose: 60,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.5,
          fairDown: 0.5,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 10,
      capMode: "soft",
    });
    expect(adjustment?.completion?.negativeEdgeUsdc).toBeGreaterThan(0);
  });

  it("allows emergency completion in xuan mode for small hard-imbalance clips", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 50;
    state.upCost = 24.5;
    state.upLots = [
      {
        size: 50,
        price: 0.49,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.54, size: 200 }],
        [{ price: 0.511, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        PARTIAL_COMPLETION_FRACTIONS: "0.1",
      }),
      state,
      books,
      {
        secsToClose: 45,
        nowTs: market.startTs + 150,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.5,
          fairDown: 0.5,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 5,
      capMode: "emergency",
    });
    expect(adjustment?.completion?.negativeEdgeUsdc).toBeGreaterThan(0);
  });

  it("keeps tiny residual completion bounded even when fair value is unavailable", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 2.5;
    state.downCost = 1.1;
    state.postMergeCompletionOnlyUntil = market.startTs + 60;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.26, size: 200 }], [{ price: 0.27, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.43, size: 200 }], [{ price: 0.44, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsFromOpen: 40,
        secsToClose: 240,
        lot: 20,
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.repairFinalQty).toBe(2.5);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      size: 2.5,
      mode: "PARTIAL_SOFT_COMPLETION",
    });
  });

  it("returns repair_size_zero only when residual gap is below repairMinQty", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 0.1;
    state.downCost = 0.044;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.26, size: 200 }], [{ price: 0.27, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.43, size: 200 }], [{ price: 0.44, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        REPAIR_MIN_QTY: "0.25",
      }),
      state,
      books,
      {
        secsFromOpen: 40,
        secsToClose: 240,
        lot: 20,
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.skipReason).toBe("repair_size_zero");
  });

  it("returns repair_qty_cap when residual gap exceeds repairMinQty but side limits block repair", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 5;
    state.upCost = 1.3;
    state.downShares = 10;
    state.downCost = 4.4;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.26, size: 200 }], [{ price: 0.27, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.43, size: 200 }], [{ price: 0.44, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        REPAIR_MIN_QTY: "0.25",
        MAX_MARKET_SHARES_PER_SIDE: "5",
      }),
      state,
      books,
      {
        secsFromOpen: 40,
        secsToClose: 240,
        lot: 20,
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.shareGap).toBeGreaterThan(0.25);
    expect(evaluation.trace.skipReason).toBe("repair_qty_cap");
  });

  it("rejects high-side completion when residual opposite average is too expensive for strict cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 30;
    state.upCost = 7.5;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.24, size: 200 }], [{ price: 0.25, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.77, size: 200 }],
        [{ price: 0.78, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      { secsToClose: 120 },
    );

    expect(adjustment).toBeNull();
  });

  it("assigns paired order type by mode and tracks partial/both-filled status", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const strictGroup = createPairOrderGroup({
      conditionId: market.conditionId,
      marketSlug: market.slug,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 20,
      maxUpPrice: 0.48,
      maxDownPrice: 0.49,
      mode: "STRICT",
      selectedMode: "STRICT_PAIR_SWEEP",
      createdAt: 1713696010,
      state,
      rawPair: 0.97,
      effectivePair: 0.995942,
      negativeEdgeUsdc: 0,
    });
    const xuanGroup = createPairOrderGroup({
      conditionId: market.conditionId,
      marketSlug: market.slug,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 20,
      maxUpPrice: 0.48,
      maxDownPrice: 0.49,
      mode: "XUAN",
      selectedMode: "XUAN_SOFT_PAIR_SWEEP",
      createdAt: 1713696010,
      state,
      rawPair: 0.97,
      effectivePair: 1.012,
      negativeEdgeUsdc: 0.24,
    });

    const groupedEntries = applyPairOrderType(
      [
        {
          side: "UP",
          size: 20,
          reason: "balanced_pair_seed",
          mode: "STRICT_PAIR_SWEEP",
          expectedAveragePrice: 0.48,
          effectivePricePerShare: 0.4979712,
          pairCostWithFees: 0.9959424,
          rawPairCost: 0.97,
          order: {
            tokenId: market.tokens.UP.tokenId,
            side: "BUY",
            amount: 9.6,
            shareTarget: 20,
            price: 0.48,
            orderType: "FAK",
            userUsdcBalance: 9.6,
          },
        },
        {
          side: "DOWN",
          size: 20,
          reason: "balanced_pair_seed",
          mode: "STRICT_PAIR_SWEEP",
          expectedAveragePrice: 0.49,
          effectivePricePerShare: 0.5079928,
          pairCostWithFees: 0.9959424,
          rawPairCost: 0.97,
          order: {
            tokenId: market.tokens.DOWN.tokenId,
            side: "BUY",
            amount: 9.8,
            shareTarget: 20,
            price: 0.49,
            orderType: "FAK",
            userUsdcBalance: 9.8,
          },
        },
      ],
      strictGroup,
    );

    expect(strictGroup.orderType).toBe("FOK");
    expect(xuanGroup.orderType).toBe("FAK");
    expect(groupedEntries.map((entry) => entry.order.orderType)).toEqual(["FOK", "FOK"]);
    expect(groupedEntries.every((entry) => entry.order.metadata?.startsWith(`${strictGroup.groupId}:`))).toBe(true);

    state.upShares = 20;
    expect(resolvePairOrderGroupStatus(xuanGroup, state)).toBe("UP_ONLY");
    state.downShares = 20;
    expect(resolvePairOrderGroupStatus(xuanGroup, state)).toBe("BOTH_FILLED");
  });

  it("does not finalize a one-sided filled pair as NONE_FILLED after reconcile", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const group = createPairOrderGroup({
      conditionId: market.conditionId,
      marketSlug: market.slug,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 5,
      maxUpPrice: 0.55,
      maxDownPrice: 0.46,
      mode: "XUAN",
      selectedMode: "XUAN_HARD_PAIR_SWEEP",
      createdAt: 1713696010,
      state,
      rawPair: 1.01,
      effectivePair: 1.0457,
      negativeEdgeUsdc: 0.22,
    });

    const finalized = finalizePairExecutionResult({
      group,
      upResult: { success: false, status: "rejected" } as never,
      downResult: { success: true, status: "matched" } as never,
      state,
      fillSnapshot: {
        upBoughtQty: 0,
        downBoughtQty: 4.91,
      },
      reconcileObservedAfterSubmit: true,
      requireReconcileBeforeNoneFilled: true,
    });

    expect(finalized.status).toBe("DOWN_ONLY");
    expect(finalized.group.status).toBe("DOWN_ONLY");
    expect(finalized.filledUpQty).toBe(0);
    expect(finalized.filledDownQty).toBe(4.91);
  });

  it("records pair-cap decision trace in strict mode when balanced scan cannot clear the effective cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "STRICT",
      }),
      state,
      books,
      nowTs: market.startTs + 20,
      riskContext: {
        secsToClose: 280,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
    });

    expect(decision.entryBuys).toHaveLength(0);
    expect(decision.trace.entry.mode).toBe("balanced_pair");
    expect(decision.trace.entry.skipReason).toBe("pair_cap");
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 5,
        verdict: "pair_cap",
      }),
    ]);
  });

  it("allows bounded soft-negative pair sweep in xuan mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      nowTs: market.startTs + 20,
      riskContext: {
        secsToClose: 280,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.5,
        fairDown: 0.5,
      },
    });

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.every((entry) => entry.mode === "XUAN_SOFT_PAIR_SWEEP")).toBe(true);
    expect(decision.trace.entry.mode).toBe("balanced_pair");
    expect(decision.trace.entry.selectedMode).toBe("XUAN_SOFT_PAIR_SWEEP");
    expect(decision.trace.entry.skipReason).toBeUndefined();
    expect(decision.trace.entry.bestEffectivePair).toBeGreaterThan(1);
  });

  it("blocks soft-negative pair sweep in xuan mode when fair value is missing", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      nowTs: market.startTs + 20,
      riskContext: {
        secsToClose: 280,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
    });

    expect(decision.entryBuys).toHaveLength(0);
    expect(decision.trace.entry.mode).toBe("balanced_pair");
    expect(decision.trace.entry.skipReason).toBe("pair_cap");
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 5,
        verdict: "pair_cap",
        gateReason: "fair_value_missing",
      }),
    ]);
  });

  it("allows strict residual completion without fair value when cost is under strict cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.upCost = 4.8;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      { secsToClose: 120 },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      capMode: "strict",
      missingShares: 10,
    });
  });

  it("allows strict residual completion in the last 10 seconds without fair value", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.upCost = 4.8;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      { secsToClose: 8 },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      capMode: "strict",
      missingShares: 10,
    });
  });

  it("blocks soft residual completion in the last 10 seconds", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 36.8;
    state.downShares = 20;
    state.downCost = 9.2;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.519, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsToClose: 8,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.5,
          fairDown: 0.5,
        },
      },
    );

    expect(adjustment).toBeNull();
  });

  it("allows only tiny fair-valued high-side emergency completion on mismatch", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.upCost = 2.2;
    state.upLots = [
      {
        size: 10,
        price: 0.22,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.21, size: 200 }], [{ price: 0.22, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.77, size: 200 }],
        [{ price: 0.78, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        PARTIAL_COMPLETION_FRACTIONS: "0.5",
      }),
      state,
      books,
      {
        secsToClose: 120,
        nowTs: market.startTs + 40,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.22,
          fairDown: 0.8,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 5,
      capMode: "emergency",
      highLowMismatch: true,
    });
  });

  it("does not open single-leg seed without opposite inventory coverage", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.19, size: 200 }], [{ price: 0.2, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.9, size: 200 }], [{ price: 0.91, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_SINGLE_LEG_SEED: "true",
        ALLOW_CHEAP_UNDERDOG_SEED: "true",
        ALLOW_XUAN_COVERED_SEED: "true",
        COVERED_SEED_REQUIRE_SAME_PAIRGROUP_OPPOSITE_ORDER: "false",
        XUAN_PAIR_SWEEP_SOFT_CAP: "0.95",
        XUAN_PAIR_SWEEP_HARD_CAP: "0.96",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 20,
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.seedCandidates).toEqual([
      expect.objectContaining({
        side: "UP",
        allowed: false,
        skipReason: "seed_missing_opposite_inventory",
      }),
      expect.objectContaining({
        side: "DOWN",
        allowed: false,
      }),
    ]);
  });
});
