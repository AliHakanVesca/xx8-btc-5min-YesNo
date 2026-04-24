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
import { applyFill } from "../../src/strategy/xuan5m/inventoryState.js";
import { chooseInventoryAdjustment } from "../../src/strategy/xuan5m/completionEngine.js";
import { evaluateEntryBuys } from "../../src/strategy/xuan5m/entryLadderEngine.js";
import { chooseLot } from "../../src/strategy/xuan5m/lotLadder.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import {
  classifyFlowPressureBudget,
  completionReleasePatienceMultiplier,
  pairSweepAllowance,
  resolveResidualCompletionDelayProfile,
  resolveResidualBehaviorState,
  shouldDelayResidualCompletion,
} from "../../src/strategy/xuan5m/modePolicy.js";
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
  it("classifies flow-pressure budgets into shared strategy bands", () => {
    const supportive = classifyFlowPressureBudget({ budget: 0.45, matchedInventoryQuality: 0.9 });
    const confirmed = classifyFlowPressureBudget({ budget: 0.9, matchedInventoryQuality: 0.9 });
    const elite = classifyFlowPressureBudget({ budget: 1.1, matchedInventoryQuality: 0.9 });

    expect(supportive.supportive).toBe(true);
    expect(supportive.assertive).toBe(false);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.pairGateRelief).toBe(0.0015);
    expect(elite.elite).toBe(true);
    expect(elite.pairGateRelief).toBe(0.003);
  });

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
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
        ALLOW_XUAN_COVERED_SEED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
        completionRoleReleaseOrderBias: "role_order",
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
        completionRoleOrderScore: expect.any(Number),
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
        ALLOW_XUAN_COVERED_SEED: "false",
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

  it("tries a smaller rhythm-side temporal seed when the standard lot is blocked by orphan qty", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.fillHistory = [
      {
        outcome: "DOWN",
        side: "BUY",
        price: 0.49,
        size: 40,
        timestamp: market.startTs + 12,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.5, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
        XUAN_PAIR_SWEEP_SOFT_CAP: "0.95",
        XUAN_PAIR_SWEEP_HARD_CAP: "0.96",
        XUAN_BEHAVIOR_CAP: "1.1",
        SINGLE_LEG_SEED_MAX_QTY: "80",
        MAX_SINGLE_ORPHAN_QTY: "50",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "100",
        MAX_MARKET_ORPHAN_USDC: "100",
        MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC: "10",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "10",
        MAX_NEGATIVE_DAILY_BUDGET_USDC: "10",
      }),
      state,
      books,
      {
        secsFromOpen: 30,
        secsToClose: 240,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.51,
          fairDown: 0.5,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      size: 40,
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.trace.sideRhythmDecision).toBe("rhythm_micro_fallback");
    expect(evaluation.trace.seedCandidates?.[0]).toMatchObject({
      side: "UP",
      sizingMode: "rhythm_micro",
      requestedSize: 40,
      allowed: true,
    });
    expect(evaluation.trace.seedCandidates?.some((candidate) => candidate.skipReason === "orphan_qty")).toBe(true);
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

  it("uses the exact 1776248100 open-side prior for the first clone seed", () => {
    const market = buildOfflineMarket(1776248100);
    const state = createMarketState(market);

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 300 }], [{ price: 0.5, size: 300 }]),
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
        secsFromOpen: 4,
        secsToClose: 296,
        lot: 116.0656,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    expect(evaluation.decisions[0]?.size).toBeCloseTo(116.0656, 5);
  });

  it("prefers the exact 1776248100 staggered overlap seed over pair reentry in the mid-sequence cluster", () => {
    const market = buildOfflineMarket(1776248100);
    const state = createMarketState(market);
    state.fillHistory = [
      { outcome: "UP", side: "BUY", price: 0.5, size: 116.0656, timestamp: market.startTs + 4, makerTaker: "taker" },
      { outcome: "DOWN", side: "BUY", price: 0.526921096345515, size: 116.29898, timestamp: market.startTs + 6, makerTaker: "taker" },
      { outcome: "DOWN", side: "BUY", price: 0.55, size: 116.49904, timestamp: market.startTs + 8, makerTaker: "taker" },
      { outcome: "UP", side: "BUY", price: 0.4502948504983389, size: 115.63472, timestamp: market.startTs + 12, makerTaker: "taker" },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 300 }], [{ price: 0.49, size: 300 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 300 }], [{ price: 0.49, size: 300 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 16,
        secsToClose: 284,
        lot: 88.3988,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.49,
          fairDown: 0.53,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.skipReason).toBe("clone_temporal_priority_over_pair_reentry");
  });

  it("uses the exact 1776248100 late taper clip size for clone lot selection", () => {
    const lot = chooseLot(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      {
        marketSlug: "btc-updown-5m-1776248100",
        dryRunOrSmallLive: false,
        secsFromOpen: 50,
        imbalance: 0,
        bookDepthGood: true,
        pairCostWithinCap: false,
        pairCostComfortable: false,
        inventoryBalanced: true,
        recentBothSidesFilled: true,
        marketVolumeHigh: true,
        pnlTodayPositive: true,
      },
    );

    expect(lot).toBeCloseTo(60.82812, 5);
  });

  it("uses a cheap-late completion chase mode for the exact 1776248100 expensive-first residual", () => {
    const market = buildOfflineMarket(1776248100);
    const state = createMarketState(market);
    state.downShares = 61.37359;
    state.downCost = Number((61.37359 * 0.62).toFixed(6));
    state.downLots = [
      {
        size: 61.37359,
        price: 0.62,
        timestamp: market.startTs + 58,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.24, size: 300 }], [{ price: 0.2461664025356577, size: 300 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.61, size: 300 }], [{ price: 0.62, size: 300 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsToClose: 232,
        nowTs: market.startTs + 68,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "UP",
      mode: "CHEAP_LATE_COMPLETION_CHASE",
      highLowMismatch: false,
    });
    expect(adjustment?.completion?.missingShares).toBeCloseTo(59.67519, 5);
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

  it("tapers public-footprint clone lot sizing over time even without an exact reference", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const earlyLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 15,
      imbalance: 0,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: true,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });
    const laterLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 140,
      imbalance: 0,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: true,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: false,
      pnlTodayPositive: true,
    });

    expect(earlyLot).toBeGreaterThan(laterLot);
    expect(earlyLot).toBe(125);
    expect(laterLot).toBe(80);
  });

  it("keeps more stacking appetite for small residuals when recent seed flow density is active", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const baseLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "small",
      recentSeedFlowCount: 0,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });
    const stackedLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "small",
      recentSeedFlowCount: 1,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(baseLot).toBe(80);
    expect(stackedLot).toBe(90);
  });

  it("keeps overlap lot appetite elevated when sticky carry has stayed aligned", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const baseLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.7,
      recentSeedFlowCount: 1,
      arbitrationCarryAlignmentStreak: 0,
      arbitrationCarryFlowConfidence: 0.2,
      matchedInventoryQuality: 0.45,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });
    const carryLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.7,
      recentSeedFlowCount: 1,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 0.9,
      matchedInventoryQuality: 0.95,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(baseLot).toBe(80);
    expect(carryLot).toBe(90);
  });

  it("only unlocks the higher overlap lot when carry alignment and matched inventory quality are both strong", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const moderateQualityLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.52,
      recentSeedFlowCount: 2,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 0.82,
      matchedInventoryQuality: 0.9,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });
    const eliteQualityLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.52,
      recentSeedFlowCount: 2,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 1.08,
      matchedInventoryQuality: 1,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(moderateQualityLot).toBe(90);
    expect(eliteQualityLot).toBe(100);
  });

  it("lets a strong combined flow-pressure budget keep overlap lot appetite elevated even before elite carry confidence", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const pressureBudgetLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.42,
      recentSeedFlowCount: 2,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 0.74,
      matchedInventoryQuality: 1,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(pressureBudgetLot).toBe(90);
  });

  it("treats active independent flows as a first-class lot signal even when raw recent seed fill count is low", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const conservativeLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.42,
      recentSeedFlowCount: 0,
      activeIndependentFlowCount: 0,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 0.74,
      matchedInventoryQuality: 1,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });
    const multiFlowLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.42,
      recentSeedFlowCount: 0,
      activeIndependentFlowCount: 2,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 0.74,
      matchedInventoryQuality: 1,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(conservativeLot).toBe(80);
    expect(multiFlowLot).toBe(90);
  });

  it("suppresses carry-driven lot lift when the flow confidence is weak even if the streak is long", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
    });

    const weakConfidenceLot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "medium",
      residualSeverityPressure: 0.52,
      recentSeedFlowCount: 2,
      arbitrationCarryAlignmentStreak: 3,
      arbitrationCarryFlowConfidence: 0.55,
      matchedInventoryQuality: 1,
      bookDepthGood: true,
      pairCostWithinCap: true,
      pairCostComfortable: false,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(weakConfidenceLot).toBe(80);
  });

  it("keeps a non-minimal lot in general xuan mode when pair gate is only mildly negative and recent flow exists", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });

    const lot = chooseLot(config, {
      dryRunOrSmallLive: false,
      secsFromOpen: 70,
      imbalance: 0.03,
      residualSeverityLevel: "small",
      residualSeverityPressure: 0.42,
      recentSeedFlowCount: 1,
      bookDepthGood: true,
      pairCostWithinCap: false,
      pairCostComfortable: false,
      pairGatePressure: 0.3,
      inventoryBalanced: true,
      recentBothSidesFilled: true,
      marketVolumeHigh: true,
      pnlTodayPositive: true,
    });

    expect(lot).toBe(15);
  });

  it("favors independent overlap for small residuals in general xuan mode once flow density is active", () => {
    const behavior = resolveResidualBehaviorState({
      config: buildConfig({
        BOT_MODE: "XUAN",
      }),
      residualShares: 1.5,
      shareGap: 1.5,
      recentSeedFlowCount: 1,
    });

    expect(behavior.severity.level).toBe("small");
    expect(behavior.overlapRepairArbitration).toBe("favor_independent_overlap");
  });

  it("raises residual behavior tuning bias under dense small-residual flow", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const sparseBehavior = resolveResidualBehaviorState({
      config,
      residualShares: 1.5,
      shareGap: 1.5,
      recentSeedFlowCount: 0,
    });
    const denseBehavior = resolveResidualBehaviorState({
      config,
      residualShares: 1.5,
      shareGap: 1.5,
      recentSeedFlowCount: 2,
    });

    expect(denseBehavior.riskToleranceBias).toBeGreaterThan(sparseBehavior.riskToleranceBias);
    expect(denseBehavior.carryPersistenceBias).toBeGreaterThan(sparseBehavior.carryPersistenceBias);
    expect(denseBehavior.completionPatienceBias).toBeGreaterThan(sparseBehavior.completionPatienceBias);
  });

  it("uses calibration multiplier to release delayed residual completion earlier", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const baseArgs = {
      config,
      residualShares: 1.5,
      partialAgeSec: 35,
      secsToClose: 180,
      oppositeAveragePrice: 0.42,
      missingSidePrice: 0.58,
      exactPriorActive: false,
      exceptionalMode: false,
      recentSeedFlowCount: 1,
      activeIndependentFlowCount: 1,
    };

    expect(shouldDelayResidualCompletion(baseArgs)).toBe(true);
    expect(shouldDelayResidualCompletion({ ...baseArgs, completionPatienceMultiplier: 0.78 })).toBe(false);
  });

  it("releases high-low residual completion earlier without changing mid-pair patience", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const baseArgs = {
      config,
      residualShares: 1.25,
      partialAgeSec: 35,
      secsToClose: 240,
      exactPriorActive: false,
      exceptionalMode: false,
    };

    expect(
      shouldDelayResidualCompletion({
        ...baseArgs,
        oppositeAveragePrice: 0.42,
        missingSidePrice: 0.58,
      }),
    ).toBe(true);
    expect(
      shouldDelayResidualCompletion({
        ...baseArgs,
        oppositeAveragePrice: 0.23,
        missingSidePrice: 0.78,
      }),
    ).toBe(false);
  });

  it("guards role-aware completion release when calibration asks for more patience", () => {
    expect(
      completionReleasePatienceMultiplier({
        role: "high_low_setup",
        severity: "micro",
        calibrationPatienceMultiplier: 1,
      }),
    ).toBe(0.78);
    expect(
      completionReleasePatienceMultiplier({
        role: "high_low_setup",
        severity: "small",
        calibrationPatienceMultiplier: 1,
      }),
    ).toBe(0.86);
    expect(
      completionReleasePatienceMultiplier({
        role: "high_low_setup",
        severity: "micro",
        calibrationPatienceMultiplier: 1.2,
      }),
    ).toBe(1);
  });

  it("exposes effective completion patience profile for trace/debug", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const profile = resolveResidualCompletionDelayProfile({
      config,
      residualShares: 1.25,
      partialAgeSec: 35,
      secsToClose: 240,
      oppositeAveragePrice: 0.23,
      missingSidePrice: 0.78,
      exactPriorActive: false,
      exceptionalMode: false,
    });

    expect(profile.completionReleaseRole).toBe("high_low_setup");
    expect(profile.residualSeverityLevel).toBe("small");
    expect(profile.rolePatienceMultiplier).toBe(0.86);
    expect(profile.effectivePatienceMultiplier).toBe(0.86);
    expect(profile.shouldDelay).toBe(false);
  });

  it("traces completion release role on high-low entry-side repair waits", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 81.25;
    state.downCost = 18.6875;
    state.downLots = [
      {
        size: 81.25,
        price: 0.23,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.77, size: 200 }], [{ price: 0.78, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.22, size: 200 }], [{ price: 0.23, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsFromOpen: 35,
        secsToClose: 265,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.8,
          fairDown: 0.22,
        },
      },
    );

    expect(evaluation.trace.completionReleaseRole).toBe("high_low_setup");
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
      mode: "PARTIAL_FAST_COMPLETION",
    });
    expect(evaluation.decisions[0]?.size).toBeCloseTo(84.4, 5);
    expect(evaluation.trace.repairCost).toBeGreaterThan(1.005);
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1.035);
  });

  it("waits on an expensive micro residual instead of forcing immediate completion in clone mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 82;
    state.upCost = 32.8;
    state.upLots = [
      {
        size: 82,
        price: 0.4,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 80;
    state.downCost = 40;
    state.downLots = [
      {
        size: 80,
        price: 0.5,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.39, size: 200 }], [{ price: 0.4, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.59, size: 200 }], [{ price: 0.6, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsToClose: 295,
        nowTs: market.startTs + 5,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.41,
          fairDown: 0.58,
        },
      },
    );

    expect(adjustment).toBeNull();
  });

  it("extends completion patience under dense small-residual flow conditions in general xuan mode", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const partialAgeSec = Math.ceil(config.partialSoftWindowSec * 1.35);

    const defaultDecision = shouldDelayResidualCompletion({
      config,
      residualShares: 1.25,
      partialAgeSec,
      secsToClose: 240,
      oppositeAveragePrice: 0.41,
      missingSidePrice: 0.6,
      exactPriorActive: false,
      exceptionalMode: false,
    });
    const denseFlowDecision = shouldDelayResidualCompletion({
      config,
      residualShares: 1.25,
      partialAgeSec,
      secsToClose: 240,
      oppositeAveragePrice: 0.41,
      missingSidePrice: 0.6,
      exactPriorActive: false,
      exceptionalMode: false,
      recentSeedFlowCount: 2,
    });

    expect(defaultDecision).toBe(false);
    expect(denseFlowDecision).toBe(true);
  });

  it("extends entry-side repair patience under dense small-residual flow conditions in general xuan mode", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const market = buildOfflineMarket(1713696000);
    const partialAgeSec = Math.ceil(config.partialSoftWindowSec * 1.35);
    const secsToClose = Math.max(1, market.endTs - market.startTs - partialAgeSec);
    const state = createMarketState(market);
    state.upShares = 81.25;
    state.upCost = 32.5;
    state.upLots = [
      {
        size: 81.25,
        price: 0.4,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 80;
    state.downCost = 40;
    state.downLots = [
      {
        size: 80,
        price: 0.5,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.39, size: 200 }], [{ price: 0.4, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.57, size: 200 }], [{ price: 0.58, size: 200 }]),
    );
    const context = {
      secsFromOpen: partialAgeSec,
      secsToClose,
      lot: 1.25,
      allowControlledOverlap: false,
      fairValueSnapshot: {
        status: "valid" as const,
        estimatedThreshold: false,
        fairUp: 0.41,
        fairDown: 0.65,
      },
    };

    const defaultEvaluation = evaluateEntryBuys(
      config,
      state,
      books,
      context,
    );
    const denseFlowEvaluation = evaluateEntryBuys(
      config,
      state,
      books,
      {
        ...context,
        recentSeedFlowCount: 2,
      },
    );

    expect(defaultEvaluation.decisions).toHaveLength(1);
    expect(defaultEvaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      reason: "lagging_rebalance",
    });
    expect(defaultEvaluation.trace.overlapRepairOutcome).toBe("repair");
    expect(denseFlowEvaluation.decisions).toHaveLength(0);
    expect(denseFlowEvaluation.trace.overlapRepairOutcome).toBe("wait");
    expect(denseFlowEvaluation.trace.skipReason).toBe("repair_patience_wait");
  });

  it("applies micro residual patience in general xuan mode even without public-footprint clone settings", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 82;
    state.upCost = 32.8;
    state.upLots = [
      {
        size: 82,
        price: 0.4,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 80;
    state.downCost = 40;
    state.downLots = [
      {
        size: 80,
        price: 0.5,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.39, size: 200 }], [{ price: 0.4, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.59, size: 200 }], [{ price: 0.6, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsToClose: 295,
        nowTs: market.startTs + 5,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.41,
          fairDown: 0.58,
        },
      },
    );

    expect(adjustment).toBeNull();
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
    expect(evaluation.trace.overlapRepairOutcome).toBe("overlap_seed");
  });

  it("treats a micro protected residual as eligible for a new overlap seed instead of forcing immediate repair", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 82;
    state.upCost = 31.98;
    state.upLots = [
      {
        size: 82,
        price: 0.39,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 80;
    state.downCost = 44;
    state.downLots = [
      {
        size: 80,
        price: 0.55,
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
        protectedResidualShares: 2,
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
    expect(evaluation.trace.overlapRepairOutcome).toBe("overlap_seed");
  });

  it("uses sticky overlap carry to steer seed side without letting residual bookkeeping dominate direction choice", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 82;
    state.upCost = 31.98;
    state.upLots = [
      {
        size: 82,
        price: 0.39,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 80;
    state.downCost = 44;
    state.downLots = [
      {
        size: 80,
        price: 0.55,
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
        protectedResidualShares: 2,
        protectedResidualSide: "UP",
        forcedOverlapRepairArbitration: "favor_independent_overlap",
        preferredOverlapSeedSide: "DOWN",
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
      side: "DOWN",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.overlapRepairReason).toBe("sticky_arbitration_carry");
    expect(evaluation.trace.overlapRepairOutcome).toBe("overlap_seed");
  });

  it("keeps overlap path alive under sticky carry even if the immediate runtime overlap gate is closed", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 82;
    state.upCost = 31.98;
    state.upLots = [
      {
        size: 82,
        price: 0.39,
        timestamp: market.startTs,
      },
    ];
    state.downShares = 80;
    state.downCost = 44;
    state.downLots = [
      {
        size: 80,
        price: 0.55,
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
        allowControlledOverlap: false,
        protectedResidualShares: 2,
        protectedResidualSide: "UP",
        forcedOverlapRepairArbitration: "favor_independent_overlap",
        preferredOverlapSeedSide: "DOWN",
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
      side: "DOWN",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.overlapRepairReason).toBe("sticky_arbitration_carry");
    expect(evaluation.trace.overlapRepairOutcome).toBe("overlap_seed");
  });

  it("keeps an exact overlap-side prior dominant even when a micro protected residual points the other way", () => {
    const market = buildOfflineMarket(1776253500);
    const state = createMarketState(market);
    state.downShares = 82;
    state.downCost = 45.1;
    state.downLots = [
      {
        size: 82,
        price: 0.55,
        timestamp: market.startTs + 10,
      },
    ];
    state.upShares = 80;
    state.upCost = 46.4;
    state.upLots = [
      {
        size: 80,
        price: 0.58,
        timestamp: market.startTs + 10,
      },
    ];

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
        allowControlledOverlap: true,
        protectedResidualShares: 2,
        protectedResidualSide: "DOWN",
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
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.overlapRepairArbitration).toBe("favor_independent_overlap");
    expect(evaluation.trace.residualSeverityLevel).toBe("micro");
    expect(evaluation.trace.overlapRepairOutcome).toBe("overlap_seed");
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
    expect(evaluation.trace.overlapRepairOutcome).toBe("repair");
  });

  it("falls back to a smaller residual repair clip when the standard lot exceeds completion edge budget", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 41.6;
    state.upLots = [
      {
        size: 80,
        price: 0.52,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.51, size: 200 }], [{ price: 0.52, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.52, size: 200 }], [{ price: 0.53, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        MAX_NEGATIVE_EDGE_PER_MARKET_USDC: "3",
        COMPLETION_SOFT_CAP: "1.08",
        SOFT_RESIDUAL_COMPLETION_CAP: "1.08",
        COMPLETION_HARD_CAP: "1.1",
        EMERGENCY_COMPLETION_HARD_CAP: "1.1",
        PARTIAL_HARD_CAP: "1.08",
        PARTIAL_HARD_MAX_QTY: "80",
      }),
      state,
      books,
      {
        secsFromOpen: 60,
        secsToClose: 240,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.5,
          fairDown: 0.5,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      reason: "lagging_rebalance",
    });
    expect(evaluation.decisions[0]?.size).toBeLessThan(80);
    expect(evaluation.trace.repairSizingMode).toBe("micro_fallback");
    expect(evaluation.trace.repairCandidateCount).toBeGreaterThan(1);
    expect(evaluation.trace.overlapRepairOutcome).toBe("repair");
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

  it("prefers a bounded expensive-first temporal seed when a cheap opposite completion setup is visible", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 5;
    state.downCost = 1;
    state.downLots = [
      {
        size: 5,
        price: 0.2,
        timestamp: market.startTs + 30,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.6, size: 200 }], [{ price: 0.61, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.15, size: 200 }],
        [{ price: 0.16, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 80,
        secsToClose: 220,
        lot: 80,
        allowControlledOverlap: true,
        forcedOverlapRepairArbitration: "favor_independent_overlap",
        protectedResidualShares: 5,
        protectedResidualSide: "DOWN",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.54,
          fairDown: 0.46,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.overlapRepairOutcome).toBe("overlap_seed");
  });

  it("orders asymmetric balanced-pair entries with the expensive leg first in xuan mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.16, size: 200 }], [{ price: 0.17, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.79, size: 200 }],
        [{ price: 0.8, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        SINGLE_LEG_ORPHAN_CAP: "1",
        MAX_SINGLE_ORPHAN_QTY: "100",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "100",
        MAX_MARKET_ORPHAN_USDC: "200",
      }),
      state,
      books,
      {
        secsFromOpen: 84,
        secsToClose: 216,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.17,
          fairDown: 0.8,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      mode: "STRICT_PAIR_SWEEP",
    });
    expect(evaluation.decisions[1]).toMatchObject({
      side: "UP",
      mode: "STRICT_PAIR_SWEEP",
    });
  });

  it("uses flow-intent child order for balanced pairs when child-order micro timing is calibrated", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.fillHistory = [
      {
        outcome: "DOWN",
        side: "BUY",
        price: 0.32,
        size: 80,
        timestamp: market.startTs + 70,
        makerTaker: "taker",
        executionMode: "PARTIAL_FAST_COMPLETION",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.5, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.48, size: 200 }],
        [{ price: 0.49, size: 200 }],
      ),
    );
    const baseArgs = {
      secsFromOpen: 84,
      secsToClose: 216,
      lot: 5,
      fairValueSnapshot: {
        status: "valid" as const,
        estimatedThreshold: false,
        fairUp: 0.5,
        fairDown: 0.49,
      },
    };

    const defaultEvaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_XUAN_COVERED_SEED: "false",
        MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC: "100",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "100",
        MAX_NEGATIVE_DAILY_BUDGET_USDC: "100",
      }),
      state,
      books,
      baseArgs,
    );
    const calibratedEvaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_XUAN_COVERED_SEED: "false",
        MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC: "100",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "100",
        MAX_NEGATIVE_DAILY_BUDGET_USDC: "100",
      }),
      state,
      books,
      {
        ...baseArgs,
        childOrderMicroTimingBias: "flow_intent",
      },
    );

    expect(defaultEvaluation.decisions[0]?.side).toBe("UP");
    expect(calibratedEvaluation.decisions[0]?.side).toBe("DOWN");
    expect(calibratedEvaluation.decisions[1]?.side).toBe("UP");
    expect(calibratedEvaluation.trace).toMatchObject({
      childOrderIntendedSide: "DOWN",
      childOrderSelectedSide: "DOWN",
      childOrderReason: "flow_intent",
      semanticRoleTarget: "mid_pair",
    });
  });

  it("can carry a residual completion and independent overlap seed in the same xuan decision window", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 40;
    state.upLots = [
      {
        size: 80,
        price: 0.5,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.54, size: 200 }], [{ price: 0.55, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.31, size: 200 }],
        [{ price: 0.32, size: 200 }],
      ),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BEHAVIOR_CAP: "1.3",
      }),
      state,
      books,
      nowTs: market.startTs + 30,
      riskContext: {
        secsToClose: 270,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
      allowControlledOverlap: true,
      protectedResidualShares: 80,
      protectedResidualSide: "UP",
      recentSeedFlowCount: 2,
      activeIndependentFlowCount: 1,
      completionPatienceMultiplier: 0.25,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.52,
        fairDown: 0.48,
      },
    });

    expect(decision.completion).toMatchObject({
      sideToBuy: "DOWN",
    });
    expect(decision.entryBuys).toHaveLength(1);
    expect(decision.entryBuys[0]).toMatchObject({
      side: "DOWN",
      reason: "temporal_single_leg_seed",
    });
    expect(decision.trace.protectedResidualContext).toBe(true);
    expect(decision.trace.flowRotationRetryAttempted).toBe(true);
    expect(decision.trace.flowRotationRetrySelected).toBe(true);
    expect(decision.trace.sameWindowCompletionAndOverlap).toBe(true);
    expect(decision.trace.entry.overlapRepairOutcome).toBe("overlap_seed");
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
      mode: "HIGH_LOW_COMPLETION_CHASE",
      capMode: "emergency",
      highLowMismatch: true,
    });
    expect(adjustment?.completion?.missingShares).toBeCloseTo(84.4, 5);
    expect(adjustment?.completion?.newGap).toBeCloseTo(4.4, 5);
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
        ENABLE_XUAN_HARD_PAIR_SWEEP: "false",
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

  it("eases the soft-negative pair gate when carry confidence and matched inventory quality are both strong", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.48,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 5,
      price: 0.48,
      timestamp: market.startTs + 7,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const config = buildConfig({
      BOT_MODE: "XUAN",
      MAX_SINGLE_ORPHAN_QTY: "10",
      ORPHAN_LEG_MAX_NOTIONAL_USDC: "10",
      MAX_MARKET_ORPHAN_USDC: "10",
    });
    const pairCost = 1.021992944;
    const baseAllowance = pairSweepAllowance({
      config,
      state,
      costWithFees: pairCost,
      candidateSize: 10,
      secsToClose: 280,
      dailyNegativeEdgeSpentUsdc: 0,
    });
    const carryAllowance = pairSweepAllowance({
      config,
      state,
      costWithFees: pairCost,
      candidateSize: 10,
      secsToClose: 280,
      dailyNegativeEdgeSpentUsdc: 0,
      carryFlowConfidence: 1.08,
      matchedInventoryQuality: 1,
    });

    expect(baseAllowance.allowed).toBe(false);
    expect(carryAllowance).toMatchObject({
      allowed: true,
      mode: "XUAN_SOFT_PAIR_SWEEP",
    });
  });

  it("keeps soft-negative pair reentry unclamped when xuan flow is already active", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.48,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 5,
      price: 0.48,
      timestamp: market.startTs + 7,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
        ENABLE_XUAN_HARD_PAIR_SWEEP: "false",
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

    expect(decision.trace.lot).toBe(10);
    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.every((entry) => entry.mode === "XUAN_SOFT_PAIR_SWEEP")).toBe(true);
  });

  it("lets a precomputed runtime flow-budget state suppress nibble completion without needing local fill-history counts", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 20;
    state.upCost = 8.4;
    state.upLots = [{ size: 20, price: 0.42, timestamp: market.endTs - 130 }];

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

    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      PARTIAL_SOFT_CAP: "1.04",
      COMPLETION_SOFT_CAP: "1.04",
    });
    const baseAdjustment = chooseInventoryAdjustment(config, state, books, {
      secsToClose: 80,
      nowTs: market.endTs - 80,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.42,
        fairDown: 0.6,
      },
    });
    const runtimeStateAdjustment = chooseInventoryAdjustment(config, state, books, {
      secsToClose: 80,
      nowTs: market.endTs - 80,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.42,
        fairDown: 0.6,
      },
      recentSeedFlowCount: 2,
      activeIndependentFlowCount: 2,
      flowPressureState: classifyFlowPressureBudget({
        budget: 0.6,
        matchedInventoryQuality: 0.95,
      }),
    });

    expect(baseAdjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 10,
      residualAfter: 10,
    });
    expect(runtimeStateAdjustment).toBeNull();
  });

  it("lets a precomputed runtime flow-budget state push entry selection toward temporal continuation instead of soft pair reentry", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.48,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 5,
      price: 0.48,
      timestamp: market.startTs + 7,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
    );
    const config = buildConfig({
      BOT_MODE: "XUAN",
      ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
      ENABLE_XUAN_HARD_PAIR_SWEEP: "false",
      MAX_SINGLE_ORPHAN_QTY: "10",
      ORPHAN_LEG_MAX_NOTIONAL_USDC: "10",
      MAX_MARKET_ORPHAN_USDC: "10",
    });

    const baseEvaluation = evaluateEntryBuys(config, state, books, {
      secsFromOpen: 20,
      secsToClose: 280,
      lot: 10,
      recentSeedFlowCount: 0,
      activeIndependentFlowCount: 1,
      pairGatePressure: 0.01,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.5,
        fairDown: 0.5,
      },
    });
    const runtimeStateEvaluation = evaluateEntryBuys(config, state, books, {
      secsFromOpen: 20,
      secsToClose: 280,
      lot: 10,
      recentSeedFlowCount: 0,
      activeIndependentFlowCount: 1,
      pairGatePressure: 0.01,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.5,
        fairDown: 0.5,
      },
      flowPressureState: classifyFlowPressureBudget({
        budget: 0.9,
        matchedInventoryQuality: 0.95,
      }),
    });

    expect(baseEvaluation.decisions).toHaveLength(2);
    expect(baseEvaluation.decisions.every((entry) => entry.mode === "XUAN_SOFT_PAIR_SWEEP")).toBe(true);
    expect(baseEvaluation.trace.skipReason).not.toBe("clone_temporal_priority_over_pair_reentry");

    expect(runtimeStateEvaluation.decisions).toHaveLength(1);
    expect(runtimeStateEvaluation.decisions[0]).toMatchObject({
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(runtimeStateEvaluation.trace.skipReason).toBe("clone_temporal_priority_over_pair_reentry");
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
    expect(["orphan_risk", "pair_cycle_budget"]).toContain(decision.trace.entry.skipReason);
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 10,
        verdict: "pair_cap",
        gateReason: "pair_cycle_budget",
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

  it("holds small high-low overshoot residual for lifecycle redeem instead of adding repair buys", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 4.95;
    state.upCost = Number((4.95 * 0.79).toFixed(6));
    state.upLots = [
      {
        size: 4.95,
        price: 0.79,
        timestamp: market.startTs + 184,
        executionMode: "HIGH_LOW_COMPLETION_CHASE",
      },
    ];
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.6, size: 200 }], [{ price: 0.61, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.34, size: 200 }],
        [{ price: 0.35, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_CONTROLLED_OVERLAP: "true",
      }),
      state,
      books,
      {
        secsFromOpen: 190,
        secsToClose: 110,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.6,
          fairDown: 0.4,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("high_low_residual_redeem_hold");
    expect(evaluation.trace.overlapRepairOutcome).toBe("wait");
  });
});
