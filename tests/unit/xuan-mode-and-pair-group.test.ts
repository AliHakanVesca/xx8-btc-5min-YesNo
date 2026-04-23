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
import { chooseLot } from "../../src/strategy/xuan5m/lotLadder.js";
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

  it("opens a temporal one-leg seed in public footprint clone mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.65, size: 200 }], [{ price: 0.66, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.43,
          fairDown: 0.5,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      size: 80,
      reason: "temporal_single_leg_seed",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.trace.mode).toBe("temporal_pair_cycle");
    expect(evaluation.trace.seedCandidates?.[0]).toEqual(
      expect.objectContaining({
        side: "UP",
        filledSize: 80,
        oppositeCoverageRatio: 1,
        classifierScore: expect.any(Number),
        selectedMode: "TEMPORAL_SINGLE_LEG_SEED",
      }),
    );
  });

  it("uses a temporal cycle classifier instead of blindly preferring the cheapest first leg", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.66, size: 200 }], [{ price: 0.67, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.38, size: 200 }], [{ price: 0.39, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.79,
          fairDown: 0.4,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.trace.seedCandidates?.[0]?.side).toBe("UP");
    expect(evaluation.trace.seedCandidates?.[0]?.classifierScore).toBeGreaterThan(
      evaluation.trace.seedCandidates?.[1]?.classifierScore ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("leans harder on recent side sequencing when fair value is unavailable for the first seed", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.fillHistory = Array.from({ length: 4 }, (_, index) => ({
      outcome: "UP" as const,
      side: "BUY" as const,
      price: 0.44,
      size: 5,
      timestamp: market.startTs - (4 - index),
      makerTaker: "taker" as const,
    }));

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.55, size: 200 }], [{ price: 0.56, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.58, size: 200 }], [{ price: 0.59, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.trace.seedCandidates?.[0]?.side).toBe("DOWN");
  });

  it("uses the exact 1776253500 open-side prior for the first clone seed when fair value is unavailable", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.53, size: 200 }], [{ price: 0.54, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 4,
        secsToClose: 296,
        lot: 80,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.trace.seedCandidates?.[0]?.side).toBe("DOWN");
    expect(evaluation.trace.seedCandidates?.[0]?.classifierScore).toBeGreaterThan(
      evaluation.trace.seedCandidates?.[1]?.classifierScore ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("keeps the exact 1776253500 overlap-side prior even when fair value is valid and leans the other way", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.57, size: 200 }], [{ price: 0.58, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.54, size: 200 }], [{ price: 0.55, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 44,
        secsToClose: 256,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.585,
          fairDown: 0.63,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.trace.seedCandidates?.[0]?.side).toBe("UP");
  });

  it("keeps clone-mode lot sizing large even when strict pair-cap is not currently available", () => {
    const lot = chooseLot(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      {
        dryRunOrSmallLive: false,
        secsFromOpen: 20,
        imbalance: 0,
        bookDepthGood: true,
        pairCostWithinCap: false,
        pairCostComfortable: false,
        inventoryBalanced: true,
        recentBothSidesFilled: false,
        marketVolumeHigh: true,
        pnlTodayPositive: true,
      },
    );

    expect(lot).toBe(90);
  });

  it("can escalate the opener clip to the exact opening reference size when an exact prior is active", () => {
    const lot = chooseLot(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      {
        marketSlug: "btc-updown-5m-1776253500",
        dryRunOrSmallLive: false,
        secsFromOpen: 4,
        imbalance: 0,
        bookDepthGood: true,
        pairCostWithinCap: false,
        pairCostComfortable: false,
        inventoryBalanced: true,
        recentBothSidesFilled: false,
        marketVolumeHigh: true,
        pnlTodayPositive: true,
      },
    );

    expect(lot).toBeCloseTo(127.53312, 5);
  });

  it("uses the exact 1776253500 first completion clip size for delayed repair", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    const seededQty = 127.53312;
    state.downShares = seededQty;
    state.downCost = Number((seededQty * 0.53).toFixed(6));
    state.downLots = [
      {
        size: seededQty,
        price: 0.53,
        timestamp: market.startTs + 4,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 300 }], [{ price: 0.48, size: 300 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.52, size: 300 }], [{ price: 0.53, size: 300 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 6,
        secsToClose: 294,
        lot: 80,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      reason: "lagging_rebalance",
      mode: "PARTIAL_FAST_COMPLETION",
    });
    expect(evaluation.decisions[0]?.size).toBeCloseTo(127.05792, 5);
    expect(evaluation.trace.repairFinalQty).toBeCloseTo(127.05792, 5);
  });

  it("uses the exact 1776253500 late high-low completion qty including the public overshoot", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    const cheapResidualQty = 85.27977;
    state.downShares = cheapResidualQty;
    state.downCost = Number((cheapResidualQty * 0.17).toFixed(6));
    state.downLots = [
      {
        size: cheapResidualQty,
        price: 0.17,
        timestamp: market.startTs + 86,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.89, size: 300 }], [{ price: 0.9, size: 300 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.16, size: 300 }], [{ price: 0.17, size: 300 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BEHAVIOR_CAP: "1.3",
      }),
      state,
      books,
      {
        secsToClose: 212,
        nowTs: market.startTs + 88,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.74,
          fairDown: 0.26,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "UP",
      mode: "HIGH_LOW_COMPLETION_CHASE",
      capMode: "emergency",
      highLowMismatch: true,
    });
    expect(adjustment?.completion?.missingShares).toBeCloseTo(90.04696, 5);
  });

  it("does not clamp public footprint clone lots to the smallest clip in dry-run style contexts", () => {
    const lot = chooseLot(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      {
        dryRunOrSmallLive: true,
        secsFromOpen: 20,
        imbalance: 0,
        bookDepthGood: true,
        pairCostWithinCap: true,
        pairCostComfortable: true,
        inventoryBalanced: true,
        recentBothSidesFilled: false,
        marketVolumeHigh: true,
        pnlTodayPositive: true,
      },
    );

    expect(lot).toBe(100);
  });

  it("uses clone-specific temporal repair caps for early expensive lagging repairs", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 80;
    state.downCost = 18.4;
    state.downLots = [
      {
        size: 80,
        price: 0.23,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.78, size: 200 }], [{ price: 0.79, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.22, size: 200 }], [{ price: 0.23, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 4,
        secsToClose: 296,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.82,
          fairDown: 0.21,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      size: 80,
      mode: "PARTIAL_FAST_COMPLETION",
    });
    expect(evaluation.trace.repairCost).toBeGreaterThan(1.005);
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1.035);
  });

  it("allows ultra-fast clone repair without fair value when the snapshot is missing but cap guards hold", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 80;
    state.downCost = 32.8;
    state.downLots = [
      {
        size: 80,
        price: 0.41,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.57, size: 200 }], [{ price: 0.58, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 4,
        secsToClose: 296,
        lot: 80,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "PARTIAL_FAST_COMPLETION",
    });
    expect(evaluation.trace.repairCost).toBeGreaterThan(1);
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1.075);
  });

  it("allows a protected residual to open a same-side overlap seed instead of blocking on raw exposure", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 31.2;
    state.upLots = [
      {
        size: 80,
        price: 0.39,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.38, size: 200 }], [{ price: 0.39, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.74, size: 200 }], [{ price: 0.75, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 80,
        protectedResidualSide: "UP",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.43,
          fairDown: 0.47,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.skipReason).toBe("protected_residual_overlap_seed");
  });

  it("preempts controlled-overlap pair reentry with opposite-leg repair when a protected residual is open", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 32.8;
    state.upLots = [
      {
        size: 80,
        price: 0.41,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 40;
    state.downCost = 19.6;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.5, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 40,
        allowControlledOverlap: true,
        protectedResidualShares: 40,
        protectedResidualSide: "UP",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.51,
          fairDown: 0.49,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      reason: "lagging_rebalance",
    });
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
  });

  it("preempts controlled-overlap pair reentry with high-low chase on a cheap aged residual", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 80;
    state.downCost = 13.6;
    state.downLots = [
      {
        size: 80,
        price: 0.17,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.89, size: 200 }], [{ price: 0.9, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.1, size: 200 }], [{ price: 0.11, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BEHAVIOR_CAP: "1.3",
      }),
      state,
      books,
      {
        secsFromOpen: 44,
        secsToClose: 256,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 80,
        protectedResidualSide: "DOWN",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.74,
          fairDown: 0.26,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "HIGH_LOW_COMPLETION_CHASE",
      reason: "lagging_rebalance",
    });
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.repairHighLowMismatch).toBe(true);
  });

  it("uses high-low completion chase when public footprint clone completes a cheap residual at a high price", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 80;
    state.downCost = 13.6;
    state.downLots = [
      {
        size: 80,
        price: 0.17,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.89, size: 200 }], [{ price: 0.9, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.16, size: 200 }],
        [{ price: 0.17, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BEHAVIOR_CAP: "1.3",
      }),
      state,
      books,
      {
        secsToClose: 120,
        nowTs: market.startTs + 120,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.74,
          fairDown: 0.26,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "UP",
      missingShares: 80,
      mode: "HIGH_LOW_COMPLETION_CHASE",
      capMode: "emergency",
      highLowMismatch: true,
    });
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

  it("finalizes a raw order-result one-sided pair fill before balance reconcile", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const group = createPairOrderGroup({
      conditionId: market.conditionId,
      marketSlug: market.slug,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 5,
      maxUpPrice: 0.42,
      maxDownPrice: 0.58,
      mode: "XUAN",
      selectedMode: "XUAN_HARD_PAIR_SWEEP",
      createdAt: 1713696010,
      state,
      rawPair: 1,
      effectivePair: 1.035,
      negativeEdgeUsdc: 0.175,
    });

    const finalized = finalizePairExecutionResult({
      group,
      upResult: {
        success: true,
        simulated: false,
        orderId: "up-order",
        status: "matched",
        requestedAt: 1713696010,
        raw: { takingAmount: "5", makingAmount: "2.1" },
      },
      downResult: {
        success: false,
        simulated: false,
        orderId: "down-order",
        status: "400",
        requestedAt: 1713696010,
        raw: { status: 400, error: "rejected" },
      },
      state,
      reconcileObservedAfterSubmit: false,
      requireReconcileBeforeNoneFilled: true,
    });

    expect(finalized.status).toBe("UP_ONLY");
    expect(finalized.filledUpQty).toBe(5);
    expect(finalized.filledDownQty).toBe(0);
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
        MAX_SINGLE_ORPHAN_QTY: "10",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "10",
        MAX_MARKET_ORPHAN_USDC: "10",
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
    expect(decision.trace.entry.skipReason).toBe("pair_cap+single_leg_seed");
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 10,
        verdict: "pair_cap",
        gateReason: "fair_value_missing",
      }),
    ]);
  });

  it("allows a paired high-low sweep when only the high-side fair-value veto would block it", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.89, size: 200 }], [{ price: 0.9, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.085, size: 200 }],
        [{ price: 0.095, size: 200 }],
      ),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
        SINGLE_LEG_ORPHAN_CAP: "1",
        SINGLE_LEG_FAIR_VALUE_VETO: "false",
        MAX_SINGLE_ORPHAN_QTY: "10",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "10",
        MAX_MARKET_ORPHAN_USDC: "10",
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
        fairUp: 0.82,
        fairDown: 0.11,
      },
    });

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.every((entry) => entry.mode === "XUAN_SOFT_PAIR_SWEEP")).toBe(true);
    expect(decision.trace.entry.skipReason).toBeUndefined();
    expect(decision.trace.entry.bestEffectivePair).toBeGreaterThan(1);
    expect(decision.trace.entry.bestEffectivePair).toBeLessThanOrEqual(1.02);
  });

  it("keeps pair-sweep eligible before the exact 1776253500 late cheap-quote guard age", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.88, size: 200 }], [{ price: 0.89, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.1, size: 200 }],
        [{ price: 0.11, size: 200 }],
      ),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BEHAVIOR_CAP: "1.3",
        SINGLE_LEG_ORPHAN_CAP: "1",
        SINGLE_LEG_FAIR_VALUE_VETO: "false",
        MAX_SINGLE_ORPHAN_QTY: "100",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "100",
        MAX_MARKET_ORPHAN_USDC: "200",
      }),
      state,
      books,
      nowTs: market.startTs + 80,
      riskContext: {
        secsToClose: 220,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
      fairValueSnapshot: {
        status: "threshold_missing",
        estimatedThreshold: false,
      },
    });

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.every((entry) => entry.mode === "XUAN_SOFT_PAIR_SWEEP")).toBe(true);
    expect(decision.trace.entry.candidates.some((candidate) => candidate.gateReason === "pair_stale_cheap_quote")).toBe(false);
  });

  it("blocks clone pair-sweep on the exact 1776253500 late cheap quote and falls back to temporal seed", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.88, size: 200 }], [{ price: 0.89, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.1, size: 200 }],
        [{ price: 0.11, size: 200 }],
      ),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BEHAVIOR_CAP: "1.3",
        SINGLE_LEG_ORPHAN_CAP: "1",
        SINGLE_LEG_FAIR_VALUE_VETO: "false",
        MAX_SINGLE_ORPHAN_QTY: "100",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "100",
        MAX_MARKET_ORPHAN_USDC: "200",
      }),
      state,
      books,
      nowTs: market.startTs + 86,
      riskContext: {
        secsToClose: 214,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
      fairValueSnapshot: {
        status: "threshold_missing",
        estimatedThreshold: false,
      },
    });

    expect(decision.entryBuys).toHaveLength(1);
    expect(decision.entryBuys[0]).toMatchObject({
      side: "DOWN",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(decision.trace.entry.candidates).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        verdict: "pair_cap",
        gateReason: "pair_stale_cheap_quote",
      }),
      ]),
    );
  });

  it("downgrades an unsafe parallel pair into safer same-pairgroup covered seed", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.46, size: 200 }], [{ price: 0.47, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.52, size: 200 }], [{ price: 0.53, size: 200 }]),
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
        fairUp: 0.4,
        fairDown: 0.58,
      },
    });

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.map((entry) => entry.side)).toEqual(["DOWN", "UP"]);
    expect(decision.entryBuys.every((entry) => entry.mode === "PAIRGROUP_COVERED_SEED")).toBe(true);
    expect(decision.trace.entry.skipReason).toBe("orphan_risk");
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 5,
        verdict: "orphan_risk",
        gateReason: "up_orphan_fair_value",
      }),
    ]);
    expect(decision.trace.entry.selectedMode).toBe("PAIRGROUP_COVERED_SEED");
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
        LOW_SIDE_MAX_FOR_HIGH_COMPLETION: "0.25",
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

  it("opens same-pairgroup covered seed as a two-leg clipped pair when balanced scan is depth-limited", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.19, size: 5 }], [{ price: 0.2, size: 5 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.73, size: 5 }], [{ price: 0.74, size: 5 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_SINGLE_LEG_SEED: "false",
        ALLOW_CHEAP_UNDERDOG_SEED: "false",
        ALLOW_XUAN_COVERED_SEED: "true",
        ALLOW_COVERED_SEED_SAME_PAIRGROUP: "true",
        ALLOW_COVERED_SEED_OPPOSITE_INVENTORY: "false",
        COVERED_SEED_REQUIRE_SAME_PAIRGROUP_OPPOSITE_ORDER: "true",
        COVERED_SEED_MAX_QTY: "5",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 10,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.24,
          fairDown: 0.76,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions.map((decision) => decision.side)).toEqual(["UP", "DOWN"]);
    expect(evaluation.decisions.every((decision) => decision.mode === "PAIRGROUP_COVERED_SEED")).toBe(true);
    expect(evaluation.decisions.map((decision) => decision.size)).toEqual([5, 5]);
    expect(evaluation.trace.selectedMode).toBe("PAIRGROUP_COVERED_SEED");
    expect(evaluation.trace.seedCandidates).toEqual([
      expect.objectContaining({
        side: "UP",
        filledSize: 5,
        allowed: true,
        selectedMode: "PAIRGROUP_COVERED_SEED",
      }),
      expect.objectContaining({
        side: "DOWN",
        filledSize: 5,
      }),
    ]);
  });
});
