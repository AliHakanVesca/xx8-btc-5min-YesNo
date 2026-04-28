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
import { applyFill, applyMerge } from "../../src/strategy/xuan5m/inventoryState.js";
import { chooseInventoryAdjustment } from "../../src/strategy/xuan5m/completionEngine.js";
import { evaluateEntryBuys } from "../../src/strategy/xuan5m/entryLadderEngine.js";
import { chooseLot } from "../../src/strategy/xuan5m/lotLadder.js";
import {
  createMergeBatchTracker,
  evaluateDelayedMergeGate,
  syncMergeBatchTracker,
} from "../../src/strategy/xuan5m/mergeCoordinator.js";
import {
  countActiveIndependentFlowCount,
  createMarketState,
  plannedOppositeCompletionState,
} from "../../src/strategy/xuan5m/marketState.js";
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
      STRICT_NEW_CYCLE_CAP: "1.25",
      SOFT_NEW_CYCLE_CAP: "1.25",
      HARD_NEW_CYCLE_CAP: "1.25",
      ALLOW_HARD_NEW_CYCLE_ONLY_IF_PREVIOUS_CYCLE_POSITIVE: "true",
      REQUIRE_REEVALUATION_AFTER_EACH_CYCLE: "false",
      MAX_NEW_CYCLES_PER_30S: "99",
      FORBID_FLAT_BAD_CYCLE_SPAM: "false",
      FLAT_STATE_SOFT_PAIR_MAX_QTY: "130",
      FLAT_STATE_HARD_PAIR_MAX_QTY: "130",
      COVERED_SEED_REQUIRES_FAIR_VALUE: "false",
      SINGLE_LEG_FAIR_VALUE_VETO: "false",
      BLOCK_NEW_PAIR_WHILE_PARTIAL_OPEN: "false",
      MAX_OPEN_GROUPS_PER_MARKET: "4",
      MAX_OPEN_PARTIAL_GROUPS_PER_MARKET: "3",
      ALLOW_OVERLAP_ONLY_AFTER_PARTIAL_CLASSIFIED: "false",
      ALLOW_OVERLAP_ONLY_WHEN_COMPLETION_ENGINE_ACTIVE: "false",
      REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: "false",
      WORST_CASE_AMPLIFICATION_TOLERANCE_SHARES: "125",
      MAX_WORST_CASE_AMPLIFICATION_SHARES: "125",
      COMPLETION_QUALITY_MAX_EFFECTIVE_COST: "1.2",
      COMPLETION_QUALITY_MAX_NEGATIVE_EDGE_USDC: "100",
      ...overrides,
    }),
  );
}

function buildRuntimeConfig(overrides: Record<string, string> = {}) {
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
  it("tracks temporal single-leg seeds as strict planned-opposite duty", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 110,
      price: 0.49,
      timestamp: market.startTs + 40,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const planned = plannedOppositeCompletionState(state, market.startTs + 76, 1e-6, true);

    expect(planned?.plannedOppositeSide).toBe("DOWN");
    expect(planned?.plannedOppositeQty).toBe(110);
    expect(planned?.plannedOppositeMissingQty).toBe(110);
    expect(planned?.plannedOppositeAgeSec).toBe(36);
  });

  it("releases closeable temporal planned-opposite completion after the strict deadline", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 110,
      price: 0.49,
      timestamp: market.startTs + 25,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 300 }], [{ price: 0.49, size: 300 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.459, size: 300 }], [{ price: 0.469, size: 300 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
      }),
      state,
      books,
      {
        secsFromOpen: 61,
        secsToClose: 239,
        lot: 110,
        allowControlledOverlap: true,
      },
    );

    expect(evaluation.decisions.length).toBeGreaterThan(0);
    expect(evaluation.decisions[0]?.side).toBe("DOWN");
    expect(evaluation.trace.plannedOppositeDeadlineReached).toBe(true);
    expect(evaluation.trace.plannedOppositeCloseableRelease).toBe(true);
    expect(evaluation.trace.skipReason).not.toBe("xuan_pair_cost_wait");
  });

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

  it("does not use aggressive small-continuation budget bypass for non-improving pair cost", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.5,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const allowance = pairSweepAllowance({
      config: buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC: "0.1",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "0.1",
        MAX_NEGATIVE_DAILY_BUDGET_USDC: "0.1",
      }),
      state,
      costWithFees: 1.06,
      candidateSize: 20,
      secsToClose: 120,
      dailyNegativeEdgeSpentUsdc: 0,
    });

    expect(allowance.allowed).toBe(false);
  });

  it("counts a fast paired seed as one active flow and a later seed as B2", () => {
    const nowTs = 1713696030;
    const fillHistory = [
      {
        outcome: "UP" as const,
        side: "BUY" as const,
        price: 0.4,
        size: 5,
        timestamp: nowTs - 17,
        makerTaker: "taker" as const,
        executionMode: "PAIRGROUP_COVERED_SEED" as const,
        flowLineage: "flow-up",
      },
      {
        outcome: "DOWN" as const,
        side: "BUY" as const,
        price: 0.6,
        size: 5,
        timestamp: nowTs - 16,
        makerTaker: "taker" as const,
        executionMode: "TEMPORAL_SINGLE_LEG_SEED" as const,
        flowLineage: "flow-down",
      },
      {
        outcome: "UP" as const,
        side: "BUY" as const,
        price: 0.32,
        size: 5,
        timestamp: nowTs - 6,
        makerTaker: "taker" as const,
        executionMode: "PAIRGROUP_COVERED_SEED" as const,
        flowLineage: "flow-up-b2",
      },
    ];

    expect(countActiveIndependentFlowCount(fillHistory, nowTs)).toBe(2);
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

  it("delays early debt-positive temporal completion but releases it when the opposite leg becomes cost-reducing", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 33.25,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const earlyBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.5, size: 200 }], [{ price: 0.51, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.49, size: 200 }],
        [{ price: 0.5, size: 200 }],
      ),
    );
    const config = buildConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_TEMPORAL_COMPLETION_MIN_AGE_SEC: "15",
    });

    const earlyAdjustment = chooseInventoryAdjustment(config, state, earlyBooks, {
      secsToClose: 299,
      nowTs: market.startTs + 1,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.51,
        fairDown: 0.5,
      },
    });
    expect(earlyAdjustment).toBeNull();

    const laterBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.42, size: 200 }], [{ price: 0.43, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.5, size: 200 }],
        [{ price: 0.51, size: 200 }],
      ),
    );
    const laterAdjustment = chooseInventoryAdjustment(config, state, laterBooks, {
      secsToClose: 281,
      nowTs: market.startTs + 19,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.43,
        fairDown: 0.51,
      },
    });

    expect(laterAdjustment?.completion).toMatchObject({
      sideToBuy: "UP",
      missingShares: 33.25,
    });
    expect(laterAdjustment?.completion?.costWithFees).toBeLessThan(1);
  });

  it("releases a controlled negative completion for an aged temporal orphan instead of leaving one leg alone", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.53,
      size: 33.25,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.46, size: 200 }], [{ price: 0.47, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.53, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsToClose: 240,
        nowTs: market.startTs + 60,
        fairValueSnapshot: {
          status: "live_missing",
          estimatedThreshold: false,
          note: "test_missing",
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "UP",
      missingShares: 33.25,
      residualCompletionFairValueFallback: true,
      residualCompletionFallbackReason: "temporal_orphan_terminal_carry",
    });
    expect(adjustment?.completion?.costWithFees).toBeGreaterThan(1);
    expect(adjustment?.completion?.negativeEdgeUsdc).toBeGreaterThan(0);
  });

  it("does not chase an aged temporal orphan when the opposite leg is far outside xuan carry caps", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.53,
      size: 33.25,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.84, size: 200 }], [{ price: 0.85, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.53, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsToClose: 240,
        nowTs: market.startTs + 60,
        fairValueSnapshot: {
          status: "live_missing",
          estimatedThreshold: false,
          note: "test_missing",
        },
      },
    );

    expect(adjustment).toBeNull();
  });

  it("blocks fee-inclusive completion when the effective merged result exceeds the quality cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 5;
    state.upCost = 2.2;
    state.upLots = [
      {
        size: 5,
        price: 0.44,
        timestamp: market.startTs + 5,
        executionMode: "PAIRGROUP_COVERED_SEED",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 200 }], [{ price: 0.44, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.52, size: 200 }], [{ price: 0.53, size: 200 }]),
    );

    const guarded = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsToClose: 147,
        nowTs: market.startTs + 153,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.45,
          fairDown: 0.55,
        },
      },
    );
    const loosened = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        COMPLETION_QUALITY_MAX_EFFECTIVE_COST: "1.01",
      }),
      state,
      books,
      {
        secsToClose: 147,
        nowTs: market.startTs + 153,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.45,
          fairDown: 0.55,
        },
      },
    );

    expect(guarded).toBeNull();
    expect(loosened?.completion).toMatchObject({
      sideToBuy: "DOWN",
      capMode: "soft",
    });
  });

  it("completes a material post-profit low-side setup as a planned opposite pairgroup", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.54,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 33.25,
      price: 0.42,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 80,
      price: 0.12,
      timestamp: market.startTs + 181,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.11, size: 200 }], [{ price: 0.12, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.73, size: 200 }], [{ price: 0.74, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsToClose: 104,
        nowTs: market.startTs + 196,
        fairValueSnapshot: {
          status: "live_missing",
          estimatedThreshold: false,
          note: "planned-opposite-test",
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 80,
      mode: "HIGH_LOW_COMPLETION_CHASE",
      residualCompletionFallbackReason: "planned_opposite_debt_reducing",
      plannedOppositeSide: "DOWN",
      plannedOppositeQty: 80,
      plannedOppositeMissingQty: 80,
      plannedOppositeCompletionOpenedCount: 1,
    });
  });

  it("waits for the planned opposite price target instead of completing a debt-positive pair", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 80,
      price: 0.12,
      timestamp: market.startTs + 181,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const expensiveBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.89, size: 200 }], [{ price: 0.9, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.11, size: 200 }], [{ price: 0.12, size: 200 }]),
    );

    const held = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      expensiveBooks,
      {
        secsToClose: 94,
        nowTs: market.startTs + 206,
        fairValueSnapshot: {
          status: "live_missing",
          estimatedThreshold: false,
          note: "planned-opposite-cost-target-test",
        },
      },
    );

    const targetBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.73, size: 200 }], [{ price: 0.74, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.11, size: 200 }], [{ price: 0.12, size: 200 }]),
    );
    const released = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      targetBooks,
      {
        secsToClose: 94,
        nowTs: market.startTs + 206,
        fairValueSnapshot: {
          status: "live_missing",
          estimatedThreshold: false,
          note: "planned-opposite-cost-target-test",
        },
      },
    );

    expect(held).toBeNull();
    expect(released?.completion).toMatchObject({
      sideToBuy: "UP",
      mode: "HIGH_LOW_COMPLETION_CHASE",
      residualCompletionFallbackReason: "planned_opposite_debt_reducing",
    });
    expect(released?.completion?.costWithFees).toBeLessThan(1);
    expect(released?.completion?.plannedOppositeMaxPrice).toBeLessThan(0.9);
  });

  it("does not treat micro staged residual as planned opposite campaign duty", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 5;
    state.upCost = 2.2;
    state.upLots = [
      {
        size: 5,
        price: 0.44,
        timestamp: market.startTs + 5,
        executionMode: "PAIRGROUP_COVERED_SEED",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.43, size: 200 }], [{ price: 0.44, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.52, size: 200 }], [{ price: 0.53, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildRuntimeConfig({ BOT_MODE: "XUAN" }),
      state,
      books,
      {
        secsToClose: 147,
        nowTs: market.startTs + 153,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.45,
          fairDown: 0.55,
        },
      },
    );

    expect(adjustment).toBeNull();
  });

  it("strict aggressive clone does not release late planned opposite before the 20s wait", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 20,
      price: 0.03,
      timestamp: market.startTs + 264,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.94, size: 200 }], [{ price: 0.95, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.02, size: 200 }], [{ price: 0.03, size: 200 }]),
    );

    const adjustment = chooseInventoryAdjustment(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      books,
      {
        secsToClose: 35,
        nowTs: market.startTs + 265,
        fairValueSnapshot: {
          status: "live_missing",
          estimatedThreshold: false,
          note: "late-planned-opposite",
        },
      },
    );

    expect(adjustment).toBeNull();
  });

  it("holds small merge while a material planned opposite pairgroup is still open", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.54,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 33.25,
      price: 0.42,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 80,
      price: 0.12,
      timestamp: market.startTs + 181,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    const tracker = syncMergeBatchTracker(createMergeBatchTracker(), 33.25, market.startTs + 196);

    const gate = evaluateDelayedMergeGate(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      {
        nowTs: market.startTs + 240,
        secsFromOpen: 240,
        secsToClose: 60,
        usdcBalance: 1000,
        tracker,
      },
    );

    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe("planned_opposite_hold");
    expect(gate.mergeVsCarryReason).toBe("merge_held_for_planned_opposite_completion");
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

  it("paces consecutive temporal single-leg seeds in public footprint mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.fillHistory = [{
      outcome: "DOWN",
      side: "BUY",
      price: 0.53,
      size: 30,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    }];
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.53, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
      }),
      state,
      books,
      {
        secsFromOpen: 1,
        secsToClose: 299,
        lot: 30,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.cycleSkippedReason).toBe("xuan_seed_rhythm_wait");
    expect(evaluation.trace.seedCandidates?.some((candidate) => candidate.xuanSeedDelayedCount === 1)).toBe(true);
  });

  it("allows paced temporal seed early when it would complete residual profitably", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.47,
      size: 30,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.68, size: 200 }],
        [{ price: 0.7, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
        ALLOW_CONTROLLED_OVERLAP: "true",
      }),
      state,
      books,
      {
        secsFromOpen: 1,
        secsToClose: 299,
        lot: 30,
        allowControlledOverlap: false,
        protectedResidualShares: 30,
        protectedResidualSide: "DOWN",
        preferredOverlapSeedSide: "UP",
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]?.side).toBe("UP");
    expect(evaluation.trace.cycleSkippedReason).not.toBe("xuan_seed_rhythm_wait");
  });

  it("blocks fee-negative fresh temporal cycles with runtime xuan defaults", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.41, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.65, size: 200 }], [{ price: 0.66, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
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

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.freshCycleRequestedLotCap).toBe(10);
    expect(evaluation.trace.cycleSkippedReason).toBe("fresh_cycle_bad_pair");
    expect(evaluation.trace.seedCandidates?.[0]).toMatchObject({
      cycleQualityLabel: "BAD_PAIR",
      cycleSkippedReason: "fresh_cycle_bad_pair",
    });
  });

  it("opens a staged same-pairgroup covered seed for early borderline fresh entries", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.505, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.505, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
        HARD_NEW_CYCLE_CAP: "1.05",
        OPENING_WEAK_PAIR_RAW_THRESHOLD: "1.02",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions.every((decision) => decision.size === 5)).toBe(true);
    expect(evaluation.decisions.every((decision) => decision.mode === "PAIRGROUP_COVERED_SEED")).toBe(true);
    expect(evaluation.trace.selectedMode).toBe("PAIRGROUP_COVERED_SEED");
    expect(evaluation.trace.cycleQualityLabel).toBe("BORDERLINE_PAIR");
    expect(evaluation.trace.stagedEntry).toBe(true);
    expect(evaluation.trace.plannedOppositeQty).toBe(5);
    expect(evaluation.trace.freshCycleRequestedLotCap).toBe(10);
    expect(evaluation.trace.seedCandidates?.some((candidate) =>
      candidate.allowed &&
      candidate.selectedMode === "PAIRGROUP_COVERED_SEED" &&
      candidate.cycleQualityLabel === "BORDERLINE_PAIR",
    )).toBe(true);
    expect(evaluation.trace.seedCandidates?.some((candidate) =>
      candidate.allowed &&
      candidate.fairValueFallbackReason === "missing_fair_value_allowed_by_pair_reference_cap" &&
      candidate.xuanBorderlinePhase === "aggressive",
    )).toBe(true);
  });

  it("waits before completing a staged borderline covered seed residual", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.34,
      size: 5,
      timestamp: market.startTs + 12,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.33, size: 200 }], [{ price: 0.34, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.66, size: 200 }], [{ price: 0.67, size: 200 }]),
    );
    const improvedBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.33, size: 200 }], [{ price: 0.34, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.34, size: 200 }], [{ price: 0.35, size: 200 }]),
    );
    const config = buildRuntimeConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      COVERED_SEED_REQUIRES_FAIR_VALUE: "false",
      FAIR_VALUE_FAIL_CLOSED_FOR_SEED: "false",
      FAIR_VALUE_FAIL_CLOSED_FOR_HIGH_SIDE_CHASE: "false",
    });

    const waiting = evaluateEntryBuys(config, state, books, {
      secsFromOpen: 13,
      secsToClose: 287,
      lot: 80,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.34,
        fairDown: 0.66,
      },
    });
    const released = evaluateEntryBuys(config, state, improvedBooks, {
      secsFromOpen: 17,
      secsToClose: 283,
      lot: 80,
      fairValueSnapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.34,
        fairDown: 0.66,
      },
    });

    expect(waiting.decisions).toHaveLength(0);
    expect(waiting.trace.skipReason).toBe("borderline_staged_completion_wait");
    expect(released.decisions).toHaveLength(1);
    expect(released.decisions[0]?.side).toBe("DOWN");
  });

  it("keeps mid borderline seed flat when no launch recovery path exists", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.495, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.495, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        HARD_NEW_CYCLE_CAP: "1.05",
        OPENING_FOLLOWUP_PLAN_MAX_AGE_SEC: "150",
        OPENING_WEAK_PAIR_RAW_THRESHOLD: "1.02",
      }),
      state,
      books,
      {
        secsFromOpen: 120,
        secsToClose: 180,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.campaignLaunchMode).toBe("HARD_SKIP");
    expect(evaluation.trace.campaignMode).toBe("WATCH_FOR_DEBT_REDUCER");
    expect(evaluation.trace.visibleRecoveryPath).toBe(false);
    expect(evaluation.trace.minEffectivePairAcrossTiers).toBeCloseTo(1.025996, 6);
    expect(evaluation.trace.skipReason).toBe("watch_for_debt_reducer");
    expect(evaluation.trace.cycleSkippedReason).toBe("no_visible_recovery_path");
  });

  it("blocks fresh seed entries after the hard late-market cutoff", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const expensiveBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.505, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.505, size: 200 }]),
    );

    const expensiveEvaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
      }),
      state,
      expensiveBooks,
      {
        secsFromOpen: 210,
        secsToClose: 90,
        lot: 80,
      },
    );

    expect(expensiveEvaluation.decisions).toHaveLength(0);
    expect(expensiveEvaluation.trace.cycleSkippedReason).toBe("late_fresh_seed_cutoff");

    const selectiveBooks = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.955, size: 200 }], [{ price: 0.97, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.025, size: 200 }], [{ price: 0.04, size: 200 }]),
    );

    const selectiveEvaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      createMarketState(market),
      selectiveBooks,
      {
        secsFromOpen: 210,
        secsToClose: 90,
        lot: 80,
      },
    );

    expect(selectiveEvaluation.decisions).toHaveLength(0);
    expect(selectiveEvaluation.trace.cycleSkippedReason).toBe("late_fresh_seed_cutoff");
  });

  it("blocks borderline fresh entries after the late xuan window", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.955, size: 200 }], [{ price: 0.97, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.025, size: 200 }], [{ price: 0.04, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 245,
        secsToClose: 55,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.cycleSkippedReason).toBe("late_fresh_seed_cutoff");
  });

  it("caps acceptable fresh runtime pairs to soft flat-state clip size", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.485, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.485, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
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
          fairUp: 0.5,
          fairDown: 0.5,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions.every((decision) => decision.size === 5)).toBe(true);
    expect(evaluation.trace.cycleQualityLabel).toBe("ACCEPTABLE_PAIR");
    expect(evaluation.trace.expectedNetIfMerged).toBeGreaterThanOrEqual(-0.11);
    expect(evaluation.trace.freshCycleRequestedLotCap).toBe(10);
  });

  it("switches to completion-only after two recent fee-negative runtime cycles", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.6,
      size: 10,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.45,
      size: 10,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    state = applyMerge(state, {
      amount: 33.24,
      timestamp: market.startTs + 200,
      simulated: true,
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.6,
      size: 10,
      timestamp: market.startTs + 3,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.45,
      size: 10,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.485, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.485, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MAX_NEW_CYCLES_PER_30S: "99",
      }),
      state,
      books,
      {
        secsFromOpen: 10,
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

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("bad_cycle_completion_only");
    expect(evaluation.trace.recentBadCycleCount).toBe(2);
    expect(evaluation.trace.lastCycleNet).toBeLessThan(0);
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
        HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD: "0.8",
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
        HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD: "0.8",
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

    expect(lot).toBe(60);
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

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("xuan_rhythm_wait");
    expect(evaluation.trace.repairFinalQty).toBeCloseTo(127.05792, 5);
    expect(evaluation.trace.xuanRhythmWaitSec).toBeGreaterThanOrEqual(10);
  });

  it("delays early xuan lagging rebalance when the opposite leg is still debt-positive", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 33.25;
    state.downCost = Number((33.25 * 0.64).toFixed(6));
    state.downLots = [
      {
        size: 33.25,
        price: 0.64,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.37, size: 200 }], [{ price: 0.38, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.63, size: 200 }], [{ price: 0.64, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 2,
        secsToClose: 298,
        lot: 33.25,
        fairValueSnapshot: {
          status: "threshold_missing",
          estimatedThreshold: false,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.skipReason).toBe("xuan_rhythm_wait");
    expect(evaluation.trace.completionHoldSec).toBeGreaterThanOrEqual(10);
    expect(evaluation.trace.xuanRhythmWaitSec).toBeGreaterThanOrEqual(10);
    expect(evaluation.trace.repairCost).toBeGreaterThan(1);
  });

  it("allows delayed xuan lagging rebalance once the candidate reduces basket debt", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 33.25;
    state.downCost = Number((33.25 * 0.53).toFixed(6));
    state.downLots = [
      {
        size: 33.25,
        price: 0.53,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.38, size: 200 }], [{ price: 0.39, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.52, size: 200 }], [{ price: 0.53, size: 200 }]),
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
        secsToClose: 280,
        lot: 33.25,
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
    });
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1);
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

    expect(lot).toBe(90);
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
    expect(earlyLot).toBe(120);
    expect(laterLot).toBe(30);
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

    expect(baseLot).toBe(30);
    expect(stackedLot).toBe(60);
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

    expect(baseLot).toBe(30);
    expect(carryLot).toBe(60);
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

    expect(moderateQualityLot).toBe(60);
    expect(eliteQualityLot).toBe(90);
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

    expect(pressureBudgetLot).toBe(60);
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

    expect(conservativeLot).toBe(30);
    expect(multiFlowLot).toBe(60);
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

    expect(weakConfidenceLot).toBe(30);
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
      COMPLETION_TARGET_MAX_DELAY_SEC: "45",
      COMPLETION_URGENCY_PATIENT_SEC: "45",
      COMPLETION_URGENCY_FORCE_SEC: "90",
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

  it("allows micro residual janitor in the final minute when it unlocks sub-min mergeable inventory", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 0.7875;
    state.downShares = 0.76;
    state.upCost = Number((0.7875 * 0.49).toFixed(6));
    state.downCost = Number((0.76 * 0.44).toFixed(6));
    state.upLots = [{ size: 0.7875, price: 0.49, timestamp: market.startTs + 155 }];
    state.downLots = [{ size: 0.76, price: 0.44, timestamp: market.startTs + 86 }];
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.01, size: 20 }], [{ price: 0.98, size: 20 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.01, size: 20 }], [{ price: 0.98, size: 20 }]),
    );

    const bot = new Xuan5mBot();
    const decision = bot.evaluateTick({
      config: buildConfig({
        BOT_MODE: "XUAN",
        RESIDUAL_JANITOR_MAX_EFFECTIVE_PAIR: "1.003",
        RESIDUAL_JANITOR_UNLOCK_MAX_EFFECTIVE_PAIR: "2.05",
        RESIDUAL_JANITOR_MIN_UNLOCK_NET_USDC: "0.02",
      }),
      state,
      books,
      nowTs: market.endTs - 45,
      riskContext: {
        secsToClose: 45,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
    });

    expect(decision.risk.allowNewEntries).toBe(false);
    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.trace.entry.skipReason).toBe("micro_residual_janitor_pair");
    expect(decision.trace.entry.residualJanitorProjectedMergeable).toBeGreaterThanOrEqual(1);
    expect(decision.trace.entry.residualJanitorUnlockNetUsdc).toBeGreaterThan(0.02);
  });

  it("caps xuan residual completion patience at the urgency patient window", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
      COMPLETION_URGENCY_PATIENT_SEC: "45",
      COMPLETION_URGENCY_FORCE_SEC: "90",
    });
    const profile = resolveResidualCompletionDelayProfile({
      config,
      residualShares: 1.5,
      partialAgeSec: 50,
      secsToClose: 180,
      oppositeAveragePrice: 0.42,
      missingSidePrice: 0.58,
      exactPriorActive: false,
      exceptionalMode: false,
      recentSeedFlowCount: 1,
      activeIndependentFlowCount: 1,
    });

    expect(profile.waitUntilSec).toBeLessThanOrEqual(45);
    expect(profile.shouldDelay).toBe(false);
  });

  it("ranks patient completion candidates by quality before taking the largest clip", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.upCost = 4.5;
    state.upLots = [
      {
        size: 10,
        price: 0.45,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.44, size: 200 }], [{ price: 0.45, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.48, size: 200 }],
        [
          { price: 0.49, size: 5 },
          { price: 0.55, size: 5 },
        ],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        PARTIAL_SOFT_CAP: "1.1",
        COMPLETION_URGENCY_MAX_PRICE_PREMIUM: "0.05",
      }),
      state,
      books,
      {
        secsToClose: 280,
        nowTs: market.startTs + 20,
        usdcBalance: 100,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.5,
          fairDown: 0.5,
        },
      },
    );

    expect(adjustment?.completion?.sideToBuy).toBe("DOWN");
    expect(adjustment?.completion?.missingShares).toBe(5);
    expect(adjustment?.completion?.missingSideAveragePrice).toBeCloseTo(0.49, 6);
  });

  it("releases high-low residual completion earlier without changing mid-pair patience", () => {
    const config = buildConfig({
      BOT_MODE: "XUAN",
    });
    const baseArgs = {
      config,
      residualShares: 1.25,
      partialAgeSec: 25,
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
        partialAgeSec: 31,
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

  it("blocks large high-side repair even inside clone-specific early repair windows", () => {
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
        XUAN_TEMPORAL_COMPLETION_MIN_AGE_SEC: "0",
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

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("high_side_completion_qty_cap");
    expect(evaluation.trace.repairCost).toBeGreaterThan(1.005);
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1.05);
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
      COMPLETION_TARGET_MAX_DELAY_SEC: "60",
      COMPLETION_URGENCY_PATIENT_SEC: "60",
      COMPLETION_URGENCY_FORCE_SEC: "90",
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
      SOFT_IMBALANCE_RATIO: "0.005",
      COMPLETION_TARGET_MAX_DELAY_SEC: "60",
      COMPLETION_URGENCY_PATIENT_SEC: "60",
      COMPLETION_URGENCY_FORCE_SEC: "90",
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

  it("delays ultra-fast clone repair without fair value when the candidate is still debt-positive", () => {
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

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("xuan_rhythm_wait");
    expect(evaluation.trace.repairCost).toBeGreaterThan(1);
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1.075);
  });

  it("blocks protected-residual overlap seed when the opposite leg would worsen cost basis", () => {
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
        HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD: "0.8",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 240,
        lot: 80,
        allowControlledOverlap: false,
        protectedResidualShares: 80,
        protectedResidualSide: "UP",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.43,
          fairDown: 0.76,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.repairCost).toBeGreaterThan(1.005);
    expect(evaluation.trace.skipReason).toBe("repair_phase_cap");
  });

  it("treats a micro protected residual as eligible for opposite-side overlap seed instead of immediate repair", () => {
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
        HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD: "0.8",
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
          fairDown: 0.76,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
        HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD: "0.8",
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
          fairDown: 0.76,
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
        HIGH_SIDE_COMPLETION_MAX_COST: "1.2",
        HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD: "0.8",
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
          fairDown: 0.76,
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

  it("scales a debt-reducing protected residual overlap seed beyond the micro cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.downShares = 80;
    state.downCost = 48;
    state.downLots = [
      {
        size: 80,
        price: 0.6,
        timestamp: market.startTs + 1,
      },
    ];
    state.upShares = 55;
    state.upCost = 28.6;
    state.upLots = [
      {
        size: 55,
        price: 0.52,
        timestamp: market.startTs + 1,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.18, size: 200 }], [{ price: 0.19, size: 200 }]),
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
        CONTROLLED_OVERLAP_SEED_MAX_QTY: "5",
        SINGLE_LEG_SEED_MAX_QTY: "120",
        MAX_SINGLE_ORPHAN_QTY: "120",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "120",
        MAX_MARKET_ORPHAN_USDC: "120",
      }),
      state,
      books,
      {
        secsFromOpen: 90,
        secsToClose: 210,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 25,
        protectedResidualSide: "DOWN",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.2,
          fairDown: 0.8,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "PARTIAL_SOFT_COMPLETION",
      reason: "lagging_rebalance",
    });
    expect(evaluation.decisions[0]!.size).toBeGreaterThan(5);
    expect(evaluation.trace.skipReason).toBeUndefined();
    expect(evaluation.trace.repairCost).toBeLessThan(1);
  });

  it("blocks a non-dust protected residual overlap seed when it worsens basket cost basis", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 38.25,
      price: 0.501182,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 44.25,
      price: 0.473815,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.53, size: 200 }], [{ price: 0.54, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.46, size: 200 }],
        [{ price: 0.47, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        CONTROLLED_OVERLAP_SEED_MAX_QTY: "5",
        SINGLE_LEG_SEED_MAX_QTY: "120",
        MAX_SINGLE_ORPHAN_QTY: "120",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "120",
        MAX_MARKET_ORPHAN_USDC: "120",
      }),
      state,
      books,
      {
        secsFromOpen: 183,
        secsToClose: 117,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 6,
        protectedResidualSide: "DOWN",
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.54,
          fairDown: 0.47,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      reason: "temporal_single_leg_seed",
    });
    expect([
      evaluation.trace.skipReason,
      ...(evaluation.trace.seedCandidates ?? []).map((candidate) => candidate.skipReason),
    ]).toEqual(expect.arrayContaining([expect.stringMatching(/protected_residual_overlap_seed|overlap_same_side_amplification/)]));
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
        PARTIAL_HARD_CAP: "1.09",
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

  it("blocks oversized high-low chase before controlled-overlap fallback can amplify residual side", () => {
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

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.mode).toBe("lagging_rebalance");
    expect(evaluation.trace.repairHighLowMismatch).toBe(true);
    expect(evaluation.trace.skipReason).toBe("high_side_completion_qty_cap");
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

  it("prioritizes residual completion over same-side overlap when the new flow is not recoverable", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.524,
      size: 33.25,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.37, size: 200 }], [{ price: 0.38, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.64, size: 200 }],
        [{ price: 0.65, size: 200 }],
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
      nowTs: market.startTs + 9,
      riskContext: {
        secsToClose: 291,
        staleBookMs: 100,
        balanceStaleMs: 100,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: false,
      allowControlledOverlap: true,
      protectedResidualShares: 33.25,
      protectedResidualSide: "DOWN",
      recentSeedFlowCount: 1,
      activeIndependentFlowCount: 1,
      completionPatienceMultiplier: 0.25,
      fairValueSnapshot: {
        status: "threshold_missing",
        estimatedThreshold: false,
      },
      arbitrationCarry: {
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "UP",
        flowConfidence: 0.9,
      },
    });

    expect(decision.completion).toMatchObject({
      sideToBuy: "UP",
    });
    expect(decision.entryBuys).toHaveLength(0);
    expect(decision.trace.sameWindowCompletionAndOverlap).toBe(true);
    expect(decision.trace.sameSideOverlapPrunedForCompletion).toBe(true);
    expect(decision.trace.sameSideOverlapRecoveryPairCost).toBeGreaterThan(1.015);
    expect(decision.trace.entry.skipReason).toBe("same_side_overlap_pruned_for_completion");
  });

  it("blocks public-footprint high-low completion chase when the high-side clip is oversized", () => {
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

    expect(adjustment).toBeNull();
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

  it("routes missing-fair-value soft-negative entry through bounded same-pairgroup covered seed", () => {
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

    expect(decision.entryBuys).toHaveLength(2);
    expect(decision.entryBuys.every((entry) => entry.mode === "PAIRGROUP_COVERED_SEED")).toBe(true);
    expect(decision.trace.entry.mode).toBe("balanced_pair");
    expect(decision.trace.entry.selectedMode).toBe("PAIRGROUP_COVERED_SEED");
    expect(decision.trace.entry.seedCandidates?.some((candidate) =>
      candidate.allowed &&
      candidate.fairValueFallbackReason === "missing_fair_value_allowed_by_pair_reference_cap",
    )).toBe(true);
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 5,
        verdict: "pair_cap",
        gateReason: "fair_value_missing",
      }),
      expect.objectContaining({
        requestedSize: 10,
        verdict: "pair_cap",
        gateReason: "fair_value_missing",
      }),
    ]);
  });

  it("blocks micro covered-seed fallback as the opening public-footprint campaign", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(
        market.tokens.UP.tokenId,
        market.conditionId,
        [{ price: 0.4, size: 200 }],
        [
          { price: 0.41, size: 5 },
          { price: 0.42, size: 200 },
        ],
      ),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.59, size: 200 }],
        [
          { price: 0.58, size: 5 },
          { price: 0.65, size: 200 },
        ],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 0,
        secsToClose: 300,
        lot: 95,
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.cycleSkippedReason).toBe("xuan_micro_covered_seed_fallback");
    expect(evaluation.trace.seedCandidates?.some((candidate) =>
      candidate.cycleSkippedReason === "xuan_micro_covered_seed_fallback" &&
      candidate.requestedSize === 5,
    )).toBe(true);
  });

  it("strict aggressive clone waits through xuan opening delay before the first flat-market seed", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
    );

    const config = buildRuntimeConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
    });
    const blocked = evaluateEntryBuys(config, state, books, {
      secsFromOpen: 0,
      secsToClose: 300,
      lot: 80,
    });
    const released = evaluateEntryBuys(config, state, books, {
      secsFromOpen: 4,
      secsToClose: 296,
      lot: 80,
    });

    expect(blocked.decisions).toHaveLength(0);
    expect(blocked.trace.skipReason).toBe("xuan_open_wait");
    expect(released.trace.skipReason).not.toBe("xuan_open_wait");
  });

  it("keeps same-pairgroup covered seed fail-closed when missing fair-value mode demands it", () => {
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
        COVERED_SEED_MISSING_FAIR_VALUE_MODE: "FAIL_CLOSED",
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
    expect(decision.trace.entry.seedCandidates?.some((candidate) =>
      candidate.skipReason === "fair_value_missing",
    )).toBe(true);
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
        FAIR_VALUE_FAIL_CLOSED_FOR_NEGATIVE_PAIR: "false",
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

  it("clips an unsafe larger parallel pair into a smaller xuan-biased pair", () => {
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
    expect([...decision.entryBuys.map((entry) => entry.side)].sort()).toEqual(["DOWN", "UP"]);
    expect(decision.entryBuys.every((entry) => entry.mode === "XUAN_HARD_PAIR_SWEEP")).toBe(true);
    expect(decision.entryBuys.every((entry) => entry.size === 5)).toBe(true);
    expect(decision.trace.entry.candidates).toEqual([
      expect.objectContaining({
        requestedSize: 5,
        verdict: "ok",
      }),
      expect.objectContaining({
        requestedSize: 10,
        verdict: "pair_cap",
        gateReason: "pair_cycle_budget",
      }),
    ]);
    expect(decision.trace.entry.selectedMode).toBe("XUAN_HARD_PAIR_SWEEP");
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

  it("allows only tiny fair-valued high-side completion when it stays inside the strict cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 10;
    state.upCost = 1.8;
    state.upLots = [
      {
        size: 10,
        price: 0.18,
        timestamp: market.startTs,
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.17, size: 200 }], [{ price: 0.18, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.75, size: 200 }],
        [{ price: 0.76, size: 200 }],
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
          fairUp: 0.18,
          fairDown: 0.78,
        },
      },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 5,
      capMode: "strict",
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

  it("blocks a repeated early neutral mid-pair after an already matched seed", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 5;
    state.downShares = 5;
    state.upCost = 2.5;
    state.downCost = 2.55;
    state.upLots = [
      {
        size: 5,
        price: 0.5,
        timestamp: market.startTs + 3,
        executionMode: "PAIRGROUP_COVERED_SEED",
      },
    ];
    state.downLots = [
      {
        size: 5,
        price: 0.51,
        timestamp: market.startTs + 4,
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
      },
    ];
    state.fillHistory = [
      {
        outcome: "UP",
        side: "BUY",
        price: 0.5,
        size: 5,
        timestamp: market.startTs + 3,
        makerTaker: "taker",
        executionMode: "PAIRGROUP_COVERED_SEED",
      },
      {
        outcome: "DOWN",
        side: "BUY",
        price: 0.51,
        size: 5,
        timestamp: market.startTs + 4,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.5, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.5, size: 200 }],
        [{ price: 0.51, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        STRICT_NEW_CYCLE_CAP: "1",
        SOFT_NEW_CYCLE_CAP: "1.01",
        HARD_NEW_CYCLE_CAP: "1.025",
        ALLOW_HARD_NEW_CYCLE_ONLY_IF_PREVIOUS_CYCLE_POSITIVE: "false",
        COVERED_SEED_MAX_QTY: "5",
      }),
      state,
      books,
      {
        secsFromOpen: 23,
        secsToClose: 277,
        lot: 5,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.5,
          fairDown: 0.51,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.cycleSkippedReason).toBe("early_mid_pair_repeat_fee_guard");
    expect(
      evaluation.trace.seedCandidates?.some((candidate) => candidate.skipReason === "early_mid_pair_repeat_fee_guard"),
    ).toBe(true);
  });

  it("blocks a weak opening pair when there is no xuan follow-up shape", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.62, size: 200 }], [{ price: 0.63, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.37, size: 200 }],
        [{ price: 0.38, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsFromOpen: 3,
        secsToClose: 297,
        lot: 5,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.63,
          fairDown: 0.38,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.cycleSkippedReason).toBe("opening_weak_pair_no_followup_plan");
    expect(
      evaluation.trace.seedCandidates?.every(
        (candidate) => candidate.skipReason === "opening_weak_pair_no_followup_plan",
      ),
    ).toBe(true);
  });

  it("blocks a weak high-low opening pair when the projected basket remains negative", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.3, size: 200 }], [{ price: 0.31, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.69, size: 200 }],
        [{ price: 0.7, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsFromOpen: 3,
        secsToClose: 297,
        lot: 5,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.31,
          fairDown: 0.7,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.cycleSkippedReason).toBe("opening_weak_pair_no_followup_plan");
    expect(evaluation.trace.bestRawPair).toBeCloseTo(1.01, 8);
  });

  it("scales a strong opening market basket pair beyond the flat-state soft cap", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.38, size: 250 }], [{ price: 0.39, size: 250 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.49, size: 250 }],
        [{ price: 0.5, size: 250 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 18,
        secsToClose: 282,
        lot: 120,
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions.every((decision) => decision.size > 10)).toBe(true);
    expect(evaluation.trace.cycleQualityLabel).toBe("STRONG_PAIR");
    expect(evaluation.trace.marketBasketProjectedMatchedQty).toBeGreaterThanOrEqual(90);
    expect(evaluation.trace.marketBasketProjectedEffectivePair).toBeLessThan(1);
  });

  it("starts a bounded xuan probe for an early recovery-less public-footprint bootstrap basket", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.53, size: 240 }], [{ price: 0.54, size: 240 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.46, size: 240 }],
        [{ price: 0.47, size: 240 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 5,
        secsToClose: 295,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.54,
          fairDown: 0.47,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions.every((decision) => decision.size === 33.25)).toBe(true);
    expect(evaluation.trace.initialBasketRecoveryPlan).toBe("none");
    expect(evaluation.trace.campaignLaunchMode).toBe("XUAN_PROBE_LAUNCH");
    expect(evaluation.trace.visibleRecoveryPath).toBe(false);
    expect(evaluation.trace.minEffectivePairAcrossTiers).toBeCloseTo(1.04582, 6);
    expect(evaluation.trace.recoveryPathReason).toBe("no_visible_recovery_path");
    expect(evaluation.trace.initialBasketRecoveryReason).toBe("xuan_probe_launch_no_visible_recovery_path");
    expect(evaluation.trace.initialBasketQtyCap).toBeCloseTo(33.25, 6);
    expect(evaluation.trace.campaignMode).toBe("BASKET_CAMPAIGN_ACTIVE");
    expect(evaluation.trace.campaignBaseLot).toBe(95);
    expect(evaluation.trace.executedProbeQty).toBeCloseTo(33.25, 6);
    expect(evaluation.trace.effectivePair).toBeCloseTo(1.04582, 6);
  });

  it("allows Xuan-strict staged low-side probes to use large clips when the opposite path reaches the pair-cost target", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.53, size: 240 }], [{ price: 0.54, size: 240 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.46, size: 240 }],
        [{ price: 0.47, size: 240 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      books,
      {
        secsFromOpen: 5,
        secsToClose: 295,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.54,
          fairDown: 0.47,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "DOWN",
      size: 95,
      mode: "PAIRGROUP_COVERED_SEED",
    });
    expect(evaluation.trace.stagedEntry).toBe(true);
    expect(evaluation.trace.plannedOppositeSide).toBe("UP");
    expect(evaluation.trace.plannedOppositeQty).toBeCloseTo(95, 6);
    expect(evaluation.trace.plannedOppositeMinWaitSec).toBeGreaterThanOrEqual(20);
    expect(evaluation.trace.plannedOppositeMinWaitSec).toBeLessThanOrEqual(35);
    expect(evaluation.trace.plannedOppositeMaxPrice).toBeLessThan(0.51);
    expect(evaluation.trace.campaignLaunchMode).toBe("XUAN_PROBE_LAUNCH");
    expect(evaluation.trace.initialBasketQtyCap).toBeCloseTo(95, 6);
    expect(evaluation.trace.executedProbeQty).toBeCloseTo(95, 6);
  });

  it("removes partial-open overlap locks in aggressive public-footprint intensity", () => {
    const config = buildRuntimeConfig({
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      BLOCK_NEW_PAIR_WHILE_PARTIAL_OPEN: "true",
      ALLOW_CONTROLLED_OVERLAP: "false",
      PARTIAL_OPEN_ACTION: "COMPLETION_ONLY",
      MAX_OPEN_GROUPS_PER_MARKET: "2",
      MAX_OPEN_PARTIAL_GROUPS_PER_MARKET: "1",
      ALLOW_OVERLAP_ONLY_AFTER_PARTIAL_CLASSIFIED: "true",
      ALLOW_OVERLAP_ONLY_WHEN_COMPLETION_ENGINE_ACTIVE: "true",
      REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: "true",
    });

    expect(config.blockNewPairWhilePartialOpen).toBe(false);
    expect(config.allowControlledOverlap).toBe(true);
    expect(config.partialOpenAction).toBe("ALLOW_OVERLAP");
    expect(config.maxMarketExposureShares).toBeGreaterThanOrEqual(2400);
    expect(config.maxMarketSharesPerSide).toBeGreaterThanOrEqual(2400);
    expect(config.maxOneSidedExposureShares).toBeGreaterThanOrEqual(720);
    expect(config.maxCyclesPerMarket).toBeGreaterThanOrEqual(45);
    expect(config.maxBuysPerSide).toBeGreaterThanOrEqual(45);
    expect(config.maxOpenGroupsPerMarket).toBeGreaterThanOrEqual(10);
    expect(config.maxOpenPartialGroups).toBeGreaterThanOrEqual(4);
    expect(config.allowOverlapOnlyAfterPartialClassified).toBe(false);
    expect(config.allowOverlapOnlyWhenCompletionEngineActive).toBe(false);
    expect(config.requireMatchedInventoryBeforeSecondGroup).toBe(false);
    expect(config.campaignMinClipPct).toBeGreaterThanOrEqual(0.75);
    expect(config.campaignCompletionMinPct).toBeGreaterThanOrEqual(0.75);
    expect(config.campaignDefaultClipPct).toBeGreaterThanOrEqual(1);
    expect(config.completionTargetMaxDelaySec).toBeLessThanOrEqual(35);
    expect(config.cloneChildPreferredShares).toBeGreaterThanOrEqual(80);
  });

  it("turns a debt-positive probe into an average-improving basket campaign", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 5,
      price: 0.46,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.61,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.19, size: 240 }], [{ price: 0.2, size: 240 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.77, size: 240 }],
        [{ price: 0.78, size: 240 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 18,
        secsToClose: 282,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.52,
          fairDown: 0.52,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions.every((decision) => decision.size > 0)).toBe(true);
    expect(evaluation.trace.campaignMode).toBe("ACCUMULATING_CONTINUATION");
    expect(evaluation.trace.campaignBaseLot).toBe(95);
    expect(evaluation.trace.marketBasketContinuation).toBe(true);
    expect(evaluation.trace.continuationClass).toBe("AVG_IMPROVING");
    expect(evaluation.trace.currentBasketEffectiveAvg).toBeGreaterThan(evaluation.trace.candidateEffectivePair ?? 0);
    expect(evaluation.trace.deltaAverageCost).toBeGreaterThan(0);
    expect(evaluation.trace.deltaAbsoluteDebt).toBeLessThan(0);
    expect(evaluation.trace.addedDebtUSDC).toBeLessThanOrEqual(2);
  });

  it("completes an unbalanced campaign residual without fair value when cost basis improves", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 19,
      price: 0.48,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.53,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 120 }], [{ price: 0.46, size: 120 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.53, size: 120 }],
        [{ price: 0.54, size: 120 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 45,
        secsToClose: 255,
        lot: 95,
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]!.side).toBe("UP");
    expect(evaluation.decisions[0]!.size).toBe(7.5);
    expect(evaluation.trace.campaignMode).toBe("RESIDUAL_COMPLETION_ACTIVE");
    expect(evaluation.trace.campaignClipType).toBe("CAMPAIGN_COMPLETION");
    expect(evaluation.trace.campaignMinClipQty).toBeCloseTo(6, 6);
    expect(evaluation.trace.microRepairMaxQty).toBe(5);
    expect(evaluation.trace.residualCompletionFairValueFallback).toBe(true);
    expect(evaluation.trace.residualCompletionFallbackReason).toBe("residual_cost_basis_cap");
    expect(evaluation.trace.repairCost).toBeLessThanOrEqual(1.005);
    expect(evaluation.trace.repairNewGap).toBeLessThan(evaluation.trace.repairOldGap ?? Infinity);
  });

  it("keeps full bootstrap size when a strong terminal fair-value edge exists", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.53, size: 240 }], [{ price: 0.54, size: 240 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.46, size: 240 }],
        [{ price: 0.47, size: 240 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 5,
        secsToClose: 295,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.62,
          fairDown: 0.38,
        },
      },
    );

    expect(evaluation.decisions.length).toBeGreaterThan(0);
    expect(evaluation.decisions[0]!.size).toBeGreaterThanOrEqual(90);
    expect(evaluation.trace.initialBasketRecoveryPlan).toBe("strong");
    expect(evaluation.trace.initialBasketRecoveryReason).toBe("strong_terminal_fair_value_edge");
  });

  it("allows a large xuan continuation clip when it reduces basket debt", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 240,
      price: 0.19,
      timestamp: market.startTs + 8,
      makerTaker: "taker",
      executionMode: "STRICT_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 240,
      price: 0.25,
      timestamp: market.startTs + 9,
      makerTaker: "taker",
      executionMode: "STRICT_PAIR_SWEEP",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.19, size: 220 }], [{ price: 0.2, size: 220 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.75, size: 220 }],
        [{ price: 0.76, size: 220 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 64,
        secsToClose: 236,
        lot: 120,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.2,
          fairDown: 0.76,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.decisions.every((decision) => decision.size >= 80)).toBe(true);
    expect(evaluation.decisions.every((decision) => decision.mode === "XUAN_HARD_PAIR_SWEEP")).toBe(true);
    expect(evaluation.decisions.every((decision) => decision.negativeEdgeUsdc === 0)).toBe(true);
    expect(evaluation.trace.marketBasketContinuation).toBe(true);
    expect(evaluation.trace.continuationClass).toBe("DEBT_REDUCING");
    expect(evaluation.trace.marketBasketProjectedMatchedQty).toBeGreaterThanOrEqual(320);
    expect(evaluation.trace.marketBasketProjectedEffectivePair).toBeLessThan(1);
    expect(evaluation.trace.cycleQualityLabel).toBe("STRONG_PAIR");
  });

  it("allows a high-low continuation clip when it rescues a weak bootstrap basket", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 95,
      price: 0.531934,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 95,
      price: 0.48,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.02, size: 220 }], [{ price: 0.03, size: 220 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.9, size: 220 }],
        [{ price: 0.91, size: 220 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 259,
        secsToClose: 41,
        lot: 120,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.03,
          fairDown: 0.91,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.trace.balancedButDebted).toBe(true);
    expect(evaluation.trace.qtyNeededToRepayDebt).toBeGreaterThan(80);
    const continuationSize = evaluation.decisions[0]!.size;
    expect(continuationSize).toBeGreaterThan(80);
    expect(continuationSize).toBeLessThanOrEqual((evaluation.trace.qtyNeededToRepayDebt ?? 0) + 1e-6);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.stagedDebtReducingFlow).toBe(true);
    expect(evaluation.trace.plannedOppositeSide).toBe("DOWN");
    expect(evaluation.trace.plannedOppositeQty).toBe(continuationSize);
    expect(evaluation.trace.marketBasketContinuation).toBe(true);
    expect(evaluation.trace.continuationClass).toBe("DEBT_REDUCING");
    expect(evaluation.trace.marketBasketImprovement).toBeGreaterThan(0.04);
    expect(evaluation.trace.marketBasketProjectedMatchedQty).toBeGreaterThan(175);
    expect(evaluation.trace.marketBasketProjectedEffectivePair).toBeLessThanOrEqual(1.000001);
    expect(evaluation.trace.deltaBasketDebt).toBeGreaterThan(4);
  });

  it("scales true debt-reducing campaign continuation to the large VWAP tier", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 250,
      price: 0.55,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 250,
      price: 0.55,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.02, size: 500 }], [{ price: 0.03, size: 500 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.9, size: 500 }],
        [{ price: 0.91, size: 500 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        LIVE_SMALL_LOT_LADDER: "200,300",
        MARKET_BASKET_CONTINUATION_MAX_QTY: "300",
        MAX_ONE_SIDED_EXPOSURE_SHARES: "1000",
        MAX_MARKET_EXPOSURE_SHARES: "1200",
        MAX_MARKET_SHARES_PER_SIDE: "1000",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "500",
        MAX_MARKET_ORPHAN_USDC: "500",
      }),
      state,
      books,
      {
        secsFromOpen: 120,
        secsToClose: 180,
        lot: 400,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.03,
          fairDown: 0.91,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      size: 300,
      mode: "TEMPORAL_SINGLE_LEG_SEED",
      reason: "temporal_single_leg_seed",
    });
    expect(evaluation.trace.stagedDebtReducingFlow).toBe(true);
    expect(evaluation.trace.plannedOppositeSide).toBe("DOWN");
    expect(evaluation.trace.plannedOppositeQty).toBe(300);
    expect(evaluation.trace.marketBasketContinuation).toBe(true);
    expect(evaluation.trace.continuationClass).toBe("DEBT_REDUCING");
    expect(evaluation.trace.campaignClipType).toBe("STRONG_HIGH_LOW_CONTINUATION");
    expect(evaluation.trace.marketBasketProjectedMatchedQty).toBe(550);
    expect(evaluation.trace.deltaBasketDebt).toBeGreaterThan(15);
  });

  it("scales a post-profit low-side setup instead of leaving the second flow at min order", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.49,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 33.25,
      price: 0.46,
      timestamp: market.startTs + 53,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.1, size: 300 }], [{ price: 0.11, size: 300 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.89, size: 300 }],
        [{ price: 0.9, size: 300 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        DEFAULT_LOT: "80",
        LIVE_SMALL_LOT_LADDER: "80,120",
        MARKET_BASKET_CONTINUATION_MAX_QTY: "120",
        MAX_ONE_SIDED_EXPOSURE_SHARES: "1000",
        MAX_MARKET_EXPOSURE_SHARES: "1200",
        MAX_MARKET_SHARES_PER_SIDE: "1000",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "500",
        MAX_MARKET_ORPHAN_USDC: "500",
      }),
      state,
      books,
      {
        secsFromOpen: 134,
        secsToClose: 166,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]).toMatchObject({
      side: "UP",
      size: 80,
      mode: "PAIRGROUP_COVERED_SEED",
      reason: "balanced_pair_seed",
    });
    expect(evaluation.trace.stagedEntry).toBe(true);
    expect(evaluation.trace.plannedOppositeSide).toBe("DOWN");
    expect(evaluation.trace.plannedOppositeQty).toBe(80);
    expect(evaluation.trace.campaignMode).toBe("BASKET_CAMPAIGN_ACTIVE");
    expect(evaluation.trace.marketBasketNeedsContinuation).toBe(true);
    expect(evaluation.trace.seedCandidates?.some((candidate) => candidate.postProfitLowSideSetup)).toBe(true);
  });

  it("allows an average-improving basket campaign continuation without fair value", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 19,
      price: 0.49,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.51,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 14,
      price: 0.5,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.19, size: 220 }], [{ price: 0.2, size: 220 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.77, size: 220 }],
        [{ price: 0.78, size: 220 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 258,
        secsToClose: 42,
        lot: 95,
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.trace.marketBasketContinuation).toBe(true);
    expect([undefined, "market_basket_continuation", "xuan_balanced_pair_continuation"]).toContain(
      evaluation.trace.fairValueFallbackReason,
    );
    expect(evaluation.trace.campaignMode).toBe("ACCUMULATING_CONTINUATION");
    expect(evaluation.trace.continuationClass).toBe("AVG_IMPROVING");
    expect(evaluation.trace.currentBasketEffectiveAvg).toBeGreaterThan(evaluation.trace.candidateEffectivePair ?? 0);
    expect(evaluation.trace.deltaAverageCost).toBeGreaterThanOrEqual(0.002);
    expect(evaluation.decisions.every((decision) => decision.size > 0)).toBe(true);
  });

  it("blocks normal 5 qty xuan micro continuation in strict aggressive mode", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 31.9375,
      price: 0.48,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 31.9375,
      price: 0.45,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.52, size: 200 }], [{ price: 0.53, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.5, size: 200 }],
        [{ price: 0.51, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
        XUAN_MICRO_PAIR_PROJECTED_EFFECTIVE_CAP: "1.01",
        XUAN_MICRO_PAIR_MAX_QTY: "5",
      }),
      state,
      books,
      {
        secsFromOpen: 46,
        secsToClose: 254,
        lot: 90,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.cycleSkippedReason).toBe("xuan_strict_micro_reentry_disabled");
    expect(evaluation.trace.skipReason).toBe("xuan_strict_micro_reentry_disabled");
    expect(evaluation.trace.xuanMicroPairContinuation).not.toBe(true);
  });

  it("waits on expensive opening completion according to xuan rhythm instead of completing in the first seconds", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 30,
      price: 0.48,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.51, size: 200 }], [{ price: 0.52, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.47, size: 200 }],
        [{ price: 0.48, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
        XUAN_RHYTHM_MIN_WAIT_SEC: "10",
        XUAN_RHYTHM_BASE_WAIT_SEC: "15",
        XUAN_RHYTHM_MAX_WAIT_SEC: "25",
        XUAN_COMPLETION_EARLY_RELEASE_MAX_EFFECTIVE_PAIR: "1",
      }),
      state,
      books,
      {
        secsFromOpen: 2,
        secsToClose: 298,
        lot: 30,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("xuan_rhythm_wait");
    expect(evaluation.trace.xuanRhythmWaitSec).toBeGreaterThanOrEqual(10);
    expect(evaluation.trace.xuanCompletionDelayedCount).toBe(1);
  });

  it("releases opening completion early only when effective pair is profitable", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 30,
      price: 0.47,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.68, size: 200 }],
        [{ price: 0.7, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
        XUAN_COMPLETION_EARLY_RELEASE_MAX_EFFECTIVE_PAIR: "1",
      }),
      state,
      books,
      {
        secsFromOpen: 2,
        secsToClose: 298,
        lot: 30,
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]?.reason).toBe("lagging_rebalance");
    expect(evaluation.trace.xuanEarlyCompletionReason).toBe("profitable_completion");
  });

  it("does not use xuan micro continuation when the projected basket is too expensive", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 31.9375,
      price: 0.5,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 31.9375,
      price: 0.47,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.57, size: 200 }], [{ price: 0.58, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.55, size: 200 }],
        [{ price: 0.56, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
        XUAN_MICRO_PAIR_PROJECTED_EFFECTIVE_CAP: "1.01",
        XUAN_MICRO_PAIR_MAX_QTY: "5",
      }),
      state,
      books,
      {
        secsFromOpen: 46,
        secsToClose: 254,
        lot: 90,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.cycleSkippedReason).toBe("projected_basket_too_expensive");
    expect(evaluation.trace.xuanMicroPairContinuation).not.toBe(true);
  });

  it("blocks repeated average-improving high-low continuations after the market budget is spent", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 5,
      price: 0.46,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.61,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    for (const [offset, upPrice, downPrice] of [
      [36, 0.2, 0.78],
      [102, 0.19, 0.79],
    ] as const) {
      state = applyFill(state, {
        outcome: "UP",
        side: "BUY",
        size: 5,
        price: upPrice,
        timestamp: market.startTs + offset,
        makerTaker: "taker",
        executionMode: "PAIRGROUP_COVERED_SEED",
      });
      state = applyFill(state, {
        outcome: "DOWN",
        side: "BUY",
        size: 5,
        price: downPrice,
        timestamp: market.startTs + offset,
        makerTaker: "taker",
        executionMode: "PAIRGROUP_COVERED_SEED",
      });
    }
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.18, size: 220 }], [{ price: 0.19, size: 220 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.79, size: 220 }],
        [{ price: 0.8, size: 220 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 133,
        secsToClose: 167,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.19,
          fairDown: 0.8,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.cycleSkippedReason).toBe("avg_improving_clip_budget_exhausted");
    expect(evaluation.trace.candidates.some((candidate) => candidate.continuationClass === "AVG_IMPROVING")).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => candidate.avgImprovingClipBudgetRemaining === 0)).toBe(true);
  });

  it("allows a bounded negative continuation only when terminal fair-value EV beats added debt", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 95,
      price: 0.5,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 95,
      price: 0.51,
      timestamp: market.startTs + 3,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 220 }], [{ price: 0.5, size: 220 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.49, size: 220 }],
        [{ price: 0.5, size: 220 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 120,
        secsToClose: 180,
        lot: 80,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.57,
          fairDown: 0.57,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(2);
    expect(evaluation.trace.balancedButDebted).toBe(true);
    expect(evaluation.trace.terminalCarryMode).toBe(true);
    expect(evaluation.trace.edgePerPair).toBeLessThan(0);
    expect(evaluation.trace.deltaTerminalExpectedPnl).toBeGreaterThan(evaluation.trace.addedDebtUSDC ?? 0);
  });

  it("keeps flow-shaping covered seeds trace-only instead of using them as the profit engine", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 95,
      price: 0.486804,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 95,
      price: 0.52,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.15, size: 160 }], [{ price: 0.16, size: 160 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.83, size: 160 }],
        [{ price: 0.84, size: 160 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_BORDERLINE_ENTRY_MID_MAX_QTY: "120",
        XUAN_BORDERLINE_MID_RAW_PAIR_CAP: "1.03",
        XUAN_BORDERLINE_MID_EFFECTIVE_PAIR_CAP: "1.05",
        COVERED_SEED_MAX_QTY: "120",
        SINGLE_LEG_SEED_MAX_QTY: "120",
      }),
      state,
      books,
      {
        secsFromOpen: 94,
        secsToClose: 206,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.17,
          fairDown: 0.84,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.campaignMode).toBe("BASKET_CAMPAIGN_ACTIVE");
    expect(evaluation.trace.candidates.some((candidate) => candidate.continuationClass === "FLOW_SHAPING")).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => candidate.cycleSkippedReason === "flow_shaping_trace_only")).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => (candidate.addedDebtUSDC ?? Infinity) <= 0.25)).toBe(true);
    expect(evaluation.trace.marketBasketDebtUSDC).toBeGreaterThan(3);
  });

  it("blocks flow-shaping continuation while campaign flow target is behind unless it reduces debt", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 95,
      price: 0.52,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 95,
      price: 0.52,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.15, size: 160 }], [{ price: 0.16, size: 160 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.83, size: 160 }],
        [{ price: 0.84, size: 160 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        SINGLE_LEG_ORPHAN_CAP: "0.9",
        MAX_SINGLE_ORPHAN_QTY: "120",
        MAX_MARKET_ORPHAN_USDC: "120",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "120",
      }),
      state,
      books,
      {
        secsFromOpen: 94,
        secsToClose: 206,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.17,
          fairDown: 0.84,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.campaignMode).toBe("BASKET_CAMPAIGN_ACTIVE");
    expect(evaluation.trace.candidates.some((candidate) => candidate.marketBasketContinuation === true)).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => candidate.continuationClass === "FLOW_SHAPING")).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => candidate.cycleSkippedReason === "flow_shaping_trace_only")).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => candidate.campaignFlowCount === 1)).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => candidate.campaignFlowTarget === 3)).toBe(true);
    expect(evaluation.trace.candidates.some((candidate) => (candidate.addedDebtUSDC ?? Infinity) <= 0.25)).toBe(true);
  });

  it("does not turn campaign-residual flow-shaping into paired buys when it only adds debt", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 95,
      price: 0.52,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 80,
      price: 0.52,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.15, size: 160 }], [{ price: 0.16, size: 160 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.83, size: 160 }],
        [{ price: 0.84, size: 160 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        SINGLE_LEG_ORPHAN_CAP: "0.9",
        MAX_SINGLE_ORPHAN_QTY: "120",
        MAX_MARKET_ORPHAN_USDC: "120",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "120",
      }),
      state,
      books,
      {
        secsFromOpen: 94,
        secsToClose: 206,
        lot: 95,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.17,
          fairDown: 0.84,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.campaignMode).toBe("UNBALANCED_CAMPAIGN_RESIDUAL");
    expect(["repair_qty_cap", "campaign_residual_pair_continuation"]).toContain(evaluation.trace.skipReason);
  });

  it("blocks a large continuation clip when it would break the market basket cap", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 80,
      price: 0.39,
      timestamp: market.startTs + 8,
      makerTaker: "taker",
      executionMode: "STRICT_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 80,
      price: 0.5,
      timestamp: market.startTs + 9,
      makerTaker: "taker",
      executionMode: "STRICT_PAIR_SWEEP",
    });
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.79, size: 220 }], [{ price: 0.8, size: 220 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.38, size: 220 }],
        [{ price: 0.39, size: 220 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 64,
        secsToClose: 236,
        lot: 120,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.8,
          fairDown: 0.39,
        },
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.marketBasketContinuation).toBeUndefined();
    expect(evaluation.trace.cycleSkippedReason).toBe("continuation_not_debt_reducing_or_avg_improving");
    expect(evaluation.trace.bestEffectivePair).toBeGreaterThan(1.2);
  });

  it("blocks a weak mid-window high-low opening when the follow-up plan window has expired", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.21, size: 200 }], [{ price: 0.22, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.78, size: 200 }],
        [{ price: 0.79, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      {
        secsFromOpen: 136,
        secsToClose: 164,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.campaignLaunchMode).toBe("HARD_SKIP");
    expect(evaluation.trace.campaignMode).toBe("WATCH_FOR_DEBT_REDUCER");
    expect(evaluation.trace.visibleRecoveryPath).toBe(false);
    expect(evaluation.trace.minEffectivePairAcrossTiers).toBeCloseTo(1.0343, 6);
    expect(evaluation.trace.cycleSkippedReason).toBe("no_visible_recovery_path");
  });

  it("scores protected residual overlap completion against existing inventory cost", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 5.01;
    state.downShares = 0.01;
    state.upCost = Number((5.01 * 0.49).toFixed(6));
    state.downCost = Number((0.01 * 0.41).toFixed(6));
    state.upLots = [
      {
        size: 5,
        price: 0.49,
        timestamp: market.startTs + 50,
        executionMode: "PAIRGROUP_COVERED_SEED",
      },
      {
        size: 0.01,
        price: 0.49,
        timestamp: market.startTs + 49,
      },
    ];
    state.downLots = [
      {
        size: 0.01,
        price: 0.41,
        timestamp: market.startTs + 49,
      },
    ];
    state.fillHistory = [
      {
        outcome: "UP",
        side: "BUY",
        price: 0.49,
        size: 5,
        timestamp: market.startTs + 50,
        makerTaker: "taker",
        executionMode: "PAIRGROUP_COVERED_SEED",
      },
    ];

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.3, size: 200 }], [{ price: 0.31, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.69, size: 200 }],
        [{ price: 0.7, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildConfig({
        BOT_MODE: "XUAN",
        ALLOW_CONTROLLED_OVERLAP: "true",
        MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC: "100",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "100",
        MAX_NEGATIVE_DAILY_BUDGET_USDC: "100",
      }),
      state,
      books,
      {
        secsFromOpen: 125,
        secsToClose: 175,
        lot: 80,
        allowControlledOverlap: true,
        forcedOverlapRepairArbitration: "favor_independent_overlap",
        protectedResidualShares: 5,
        protectedResidualSide: "UP",
      },
    );

    expect(evaluation.decisions).toEqual([]);
    expect(evaluation.trace.skipReason).toBe("repair_phase_cap");
    expect(evaluation.trace.repairCost).toBeGreaterThan(1.08);
  });

  it("does not force a xuan-divergent high-low residual redeem hold", () => {
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
    expect(evaluation.trace.skipReason).not.toBe("high_low_residual_redeem_hold");
  });

  it("keeps orphan temporal seed in campaign duty and releases missing-side completion", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.53,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.48, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.53, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 30,
        secsToClose: 270,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 33.25,
        protectedResidualSide: "DOWN",
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]?.side).toBe("UP");
    expect(evaluation.decisions[0]?.reason).toBe("lagging_rebalance");
    expect(evaluation.trace.campaignMode).toBe("RESIDUAL_COMPLETION_ACTIVE");
    expect(evaluation.trace.orphanCompletionDutyActive).toBe(true);
    expect(evaluation.trace.residualCompletionFallbackReason).toBe("residual_cost_basis_cap");
    expect(evaluation.trace.skipReason).toBeUndefined();
  });

  it("lets staged low-side pairgroup completion scale beyond the generic high-side cap", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 90,
      price: 0.1,
      timestamp: market.startTs + 121,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.09, size: 200 }], [{ price: 0.1, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.91, size: 200 }],
        [{ price: 0.92, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 150,
        secsToClose: 150,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 90,
        protectedResidualSide: "UP",
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]?.side).toBe("DOWN");
    expect(evaluation.decisions[0]?.size).toBeGreaterThanOrEqual(5);
    expect(evaluation.trace.stagedLowSideOpenedButOppositeMissing).toBe(true);
    expect(evaluation.trace.skipReason).not.toBe("high_side_completion_qty_cap");
    expect(evaluation.trace.skipReason).not.toBe("residual_completion_cost_basis_cap");
  });

  it("does not allow visual high-low hard sweep unless it is debt-reducing or terminal-carry improving", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 33.25,
      price: 0.62,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.48,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.98, size: 200 }], [{ price: 0.99, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.03, size: 200 }],
        [{ price: 0.04, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_XUAN_COVERED_SEED: "false",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 150,
        secsToClose: 150,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect([
      "high_low_effective_not_debt_reducing",
      "avg_improving_pair_too_expensive",
      "pair_cap+single_leg_seed",
    ]).toContain(evaluation.trace.skipReason);
  });

  it("keeps post-completion debt campaign active and opens avg-improving continuation under budget", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 10,
      price: 0.6,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 10,
      price: 0.5,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 10,
      price: 0.6,
      timestamp: market.startTs + 3,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 10,
      price: 0.5,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.29, size: 200 }], [{ price: 0.3, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.67, size: 200 }],
        [{ price: 0.68, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        MAX_CONSECUTIVE_BAD_CYCLES: "1",
        ALLOW_XUAN_COVERED_SEED: "false",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 120,
        secsToClose: 180,
        lot: 80,
      },
    );

    expect(evaluation.decisions.length).toBeGreaterThan(0);
    expect(evaluation.trace.mode).toBe("balanced_pair");
    expect(evaluation.trace.selectedMode).toBe("XUAN_HARD_PAIR_SWEEP");
    expect(evaluation.trace.campaignMode).toBe("ACCUMULATING_CONTINUATION");
    expect(evaluation.trace.cycleSkippedReason).not.toBe("bad_cycle_completion_only");
    expect(evaluation.trace.continuationClass).toBe("AVG_IMPROVING");
    expect(evaluation.decisions[0]?.size).toBeGreaterThanOrEqual(5);
    expect(evaluation.trace.postCompletionRepairOpenedCount).toBeGreaterThan(0);
    expect(evaluation.trace.avgImprovingActionCount).toBeGreaterThan(0);
  });

  it("opens a second balanced repair flow after an expensive completion even without a high-low spread", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.51,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 21.6125,
      price: 0.69,
      timestamp: market.startTs + 113,
      makerTaker: "taker",
      executionMode: "PARTIAL_EMERGENCY_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 11.6375,
      price: 0.47,
      timestamp: market.startTs + 162,
      makerTaker: "taker",
      executionMode: "PARTIAL_EMERGENCY_COMPLETION",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.49, size: 200 }], [{ price: 0.5, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.46, size: 200 }],
        [{ price: 0.47, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        LIVE_SMALL_LOT_LADDER: "80,90,100,125",
        DEFAULT_LOT: "80",
        MAX_CONSECUTIVE_BAD_CYCLES: "1",
        ALLOW_XUAN_COVERED_SEED: "false",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 205,
        secsToClose: 95,
        lot: 80,
      },
    );

    expect(evaluation.decisions.length).toBeGreaterThan(0);
    expect(evaluation.decisions.map((decision) => decision.side).sort()).toEqual(["DOWN", "UP"]);
    expect(evaluation.trace.mode).toBe("balanced_pair");
    expect(evaluation.trace.campaignMode).toBe("ACCUMULATING_CONTINUATION");
    expect(evaluation.trace.postCompletionDebtRepairActive).toBe(true);
    expect(evaluation.trace.continuationClass).toBe("AVG_IMPROVING");
    expect(evaluation.trace.cycleSkippedReason).not.toBe("avg_improving_spread_too_small");
    expect(evaluation.decisions[0]?.size).toBeGreaterThan(5);
    expect(evaluation.trace.postCompletionRepairOpenedCount).toBeGreaterThan(0);
    expect(evaluation.trace.pairCapBlockedRepairCount ?? 0).toBeLessThan(evaluation.trace.postCompletionRepairAttemptCount ?? 1);
  });

  it("does not block late post-merge covered seed with an artificial xuan-divergent guard", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.5105,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 33.25,
      price: 0.44,
      timestamp: market.startTs + 10,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.1, size: 200 }], [{ price: 0.11, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.88, size: 200 }],
        [{ price: 0.89, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 228,
        secsToClose: 72,
        lot: 80,
      },
    );

    expect(evaluation.trace.cycleSkippedReason).not.toBe("late_post_merge_micro_seed");
    expect(
      evaluation.decisions.length > 0 ||
        evaluation.trace.cycleSkippedReason === "continuation_not_debt_reducing_or_avg_improving" ||
        evaluation.trace.cycleSkippedReason === undefined,
    ).toBe(true);
  });

  it("does not hold late xuan residual when completion can still manage it", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 5,
      price: 0.11,
      timestamp: market.startTs + 228,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.1, size: 200 }], [{ price: 0.11, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.85, size: 200 }],
        [{ price: 0.86, size: 200 }],
      ),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
      state,
      books,
      {
        secsFromOpen: 250,
        secsToClose: 50,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 5,
        protectedResidualSide: "UP",
      },
    );

    expect(evaluation.trace.skipReason).not.toBe("late_small_residual_hold");
  });

  it("strict aggressive clone bypasses bad-cycle lock inside a xuan family seed slot", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    for (const offset of [0, 2]) {
      state = applyFill(state, {
        outcome: "UP",
        side: "BUY",
        price: 0.6,
        size: 10,
        timestamp: market.startTs + offset,
        makerTaker: "taker",
        executionMode: "TEMPORAL_SINGLE_LEG_SEED",
      });
      state = applyFill(state, {
        outcome: "DOWN",
        side: "BUY",
        price: 0.45,
        size: 10,
        timestamp: market.startTs + offset + 1,
        makerTaker: "taker",
        executionMode: "PARTIAL_FAST_COMPLETION",
      });
    }

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.485, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.485, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        MAX_NEW_CYCLES_PER_30S: "99",
      }),
      state,
      books,
      {
        secsFromOpen: 10,
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

    expect(evaluation.trace.skipReason).not.toBe("bad_cycle_completion_only");
  });

  it("strict aggressive clone waits before releasing family-prior residual completion", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 91.25,
      price: 0.48,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.72, size: 200 }], [{ price: 0.74, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      books,
      {
        secsFromOpen: 6,
        secsToClose: 294,
        lot: 90,
        allowControlledOverlap: false,
        protectedResidualShares: 91.25,
        protectedResidualSide: "DOWN",
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("xuan_planned_opposite_wait");
    expect(evaluation.trace.skipReason).not.toBe("residual_completion_cost_basis_cap");
  });

  it("strict aggressive clone takes a closeable protective opposite before hard min-wait expires", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 91.25,
      price: 0.49,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      books,
      {
        secsFromOpen: 20,
        secsToClose: 280,
        lot: 90,
        allowControlledOverlap: false,
        protectedResidualShares: 91.25,
        protectedResidualSide: "DOWN",
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]?.side).toBe("UP");
    expect(evaluation.trace.plannedOppositeProtectiveRelease).toBe(true);
    expect(evaluation.trace.skipReason).not.toBe("xuan_planned_opposite_wait");
  });

  it("strict aggressive clone releases family-prior residual completion after planned opposite wait", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 91.25,
      price: 0.48,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.47, size: 200 }], [{ price: 0.49, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      books,
      {
        secsFromOpen: 26,
        secsToClose: 274,
        lot: 90,
        allowControlledOverlap: false,
        protectedResidualShares: 91.25,
        protectedResidualSide: "DOWN",
      },
    );

    expect(evaluation.decisions).toHaveLength(1);
    expect(evaluation.decisions[0]?.side).toBe("UP");
    expect(evaluation.trace.skipReason).not.toBe("xuan_planned_opposite_wait");
    expect(evaluation.trace.skipReason).not.toBe("residual_completion_cost_basis_cap");
  });

  it("blocks post-merge dust re-entry when the strict late pair-cost target is not reachable", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 33.25,
      price: 0.51,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 33.25,
      price: 0.49,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyMerge(state, {
      amount: 33.24,
      timestamp: market.startTs + 160,
      simulated: true,
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.54, size: 200 }], [{ price: 0.56, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.47, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 218,
        secsToClose: 82,
        lot: 90,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("pair_cap+single_leg_seed");
    expect(evaluation.trace.candidates?.[0]?.gateReason).toBe("xuan_late_seed_pair_cost_wait");
  });

  it("blocks post-merge re-entry before t+200 when the current pair cost is not closeable", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 80,
      price: 0.25,
      timestamp: market.startTs + 70,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 80,
      price: 0.65,
      timestamp: market.startTs + 120,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    state = applyMerge(state, {
      amount: 79.99,
      timestamp: market.startTs + 160,
      simulated: true,
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.67, size: 200 }], [{ price: 0.68, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.31, size: 200 }], [{ price: 0.32, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 161,
        secsToClose: 139,
        lot: 80,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.candidates?.[0]?.gateReason).toBe("xuan_post_merge_seed_pair_cost_wait");
  });

  it("keeps strict late pair-cost discipline even when the old blocker would have been daily budget", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 30,
      price: 0.51,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 30,
      price: 0.49,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyMerge(state, {
      amount: 29.99,
      timestamp: market.startTs + 160,
      simulated: true,
    });
    state.negativePairEdgeConsumedUsdc = 999;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.54, size: 200 }], [{ price: 0.56, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.47, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
        MAX_NEGATIVE_DAILY_BUDGET_USDC: "1",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "1",
      }),
      state,
      books,
      {
        secsFromOpen: 218,
        secsToClose: 82,
        lot: 90,
        dailyNegativeEdgeSpentUsdc: 999,
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("pair_cap+single_leg_seed");
    expect(evaluation.trace.candidates?.[0]?.gateReason).toBe("xuan_late_seed_pair_cost_wait");
  });

  it("blocks late post-merge re-entry when projected pair cost is above strict closeable target", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 90,
      price: 0.5,
      timestamp: market.startTs,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 90,
      price: 0.48,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyMerge(state, {
      amount: 89.99,
      timestamp: market.startTs + 160,
      simulated: true,
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.92, size: 200 }], [{ price: 0.93, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.05, size: 200 }], [{ price: 0.06, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        MARKET_BASKET_BOOTSTRAP_ENABLED: "false",
      }),
      state,
      books,
      {
        secsFromOpen: 264,
        secsToClose: 36,
        lot: 90,
        fairValueSnapshot: {
          status: "valid",
          estimatedThreshold: false,
          fairUp: 0.93,
          fairDown: 0.06,
        },
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("pair_cap+single_leg_seed");
    expect(evaluation.trace.candidates?.[0]?.gateReason).toBe("xuan_late_seed_deadline_after_final_merge");
  });

  it("blocks high-cost temporal residual completion before the final residual-duty window", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    const fills = [
      { outcome: "DOWN" as const, size: 20, price: 0.5, timestamp: market.startTs + 4, executionMode: "PAIRGROUP_COVERED_SEED" as const },
      { outcome: "UP" as const, size: 20, price: 0.43, timestamp: market.startTs + 28, executionMode: "PARTIAL_SOFT_COMPLETION" as const },
      { outcome: "DOWN" as const, size: 5, price: 0.58, timestamp: market.startTs + 29, executionMode: "XUAN_HARD_PAIR_SWEEP" as const },
      { outcome: "UP" as const, size: 5, price: 0.43, timestamp: market.startTs + 29, executionMode: "XUAN_HARD_PAIR_SWEEP" as const },
      { outcome: "DOWN" as const, size: 20, price: 0.49, timestamp: market.startTs + 31, executionMode: "PAIRGROUP_COVERED_SEED" as const },
      { outcome: "UP" as const, size: 20, price: 0.52, timestamp: market.startTs + 55, executionMode: "PARTIAL_SOFT_COMPLETION" as const },
      { outcome: "DOWN" as const, size: 20, price: 0.49, timestamp: market.startTs + 56, executionMode: "PAIRGROUP_COVERED_SEED" as const },
      { outcome: "UP" as const, size: 20, price: 0.62, timestamp: market.startTs + 80, executionMode: "PARTIAL_SOFT_COMPLETION" as const },
      { outcome: "UP" as const, size: 85.27977, price: 0.63, timestamp: market.startTs + 81, executionMode: "TEMPORAL_SINGLE_LEG_SEED" as const },
    ];
    for (const fill of fills) {
      state = applyFill(state, {
        ...fill,
        side: "BUY",
        makerTaker: "taker",
      });
    }

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.58, size: 300 }], [{ price: 0.59, size: 300 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.67, size: 300 }], [{ price: 0.68, size: 300 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        ALLOW_TEMPORAL_SINGLE_LEG_SEED: "true",
      }),
      state,
      books,
      {
        secsFromOpen: 135,
        secsToClose: 165,
        lot: 80,
        allowControlledOverlap: true,
        protectedResidualShares: 85.27977,
        protectedResidualSide: "DOWN",
      },
    );

    expect(evaluation.decisions).toHaveLength(0);
    expect(evaluation.trace.skipReason).toBe("xuan_open_planned_opposite_no_closeable_path");
  });

	  it("strict aggressive clone releases campaign residual completion instead of repair_qty_cap", () => {
	    const market = buildOfflineMarket(1713696000);
	    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 1064.29154,
      price: 0.52,
      timestamp: market.startTs + 8,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 1064.29154,
      price: 0.49,
      timestamp: market.startTs + 9,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 85.76828,
      price: 0.73,
      timestamp: market.startTs + 107,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.72, size: 200 }], [{ price: 0.74, size: 200 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.37, size: 200 }], [{ price: 0.38, size: 200 }]),
    );

    const evaluation = evaluateEntryBuys(
      buildRuntimeConfig({
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
      state,
      books,
      {
        secsFromOpen: 132,
        secsToClose: 168,
        lot: 90,
        allowControlledOverlap: true,
        protectedResidualShares: 85.76828,
        protectedResidualSide: "DOWN",
      },
    );

    expect(evaluation.decisions.length).toBeGreaterThan(0);
    expect(evaluation.decisions[0]?.side).toBe("DOWN");
	    expect(evaluation.trace.skipReason).not.toBe("repair_qty_cap");
	    expect(evaluation.trace.aggressiveResidualDutyReleaseActive).toBe(true);
	  });

	  it("caps non-exact family residual completion at the missing qty when the cheap opposite target arrives", () => {
	    const market = buildOfflineMarket(1713696000);
	    let state = createMarketState(market);
	    state = applyFill(state, {
	      outcome: "UP",
	      side: "BUY",
	      size: 175.08098,
	      price: 0.4,
	      timestamp: market.startTs + 31,
	      makerTaker: "taker",
	      executionMode: "PARTIAL_SOFT_COMPLETION",
	    });
	    state = applyFill(state, {
	      outcome: "DOWN",
	      side: "BUY",
	      size: 232.24743,
	      price: 0.64,
	      timestamp: market.startTs + 56,
	      makerTaker: "taker",
	      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
	    });

	    const books = new OrderBookState(
	      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.18, size: 200 }], [{ price: 0.19, size: 200 }]),
	      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.63, size: 200 }], [{ price: 0.64, size: 200 }]),
	    );

	    const evaluation = evaluateEntryBuys(
	      buildRuntimeConfig({
	        BOT_MODE: "XUAN",
	        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
	        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
	      }),
	      state,
	      books,
	      {
	        secsFromOpen: 80,
	        secsToClose: 220,
	        lot: 90,
	        fairValueSnapshot: {
	          status: "live_missing",
	          estimatedThreshold: false,
	          note: "xuan-family-missing-qty-cap",
	        },
	      },
	    );

	    expect(evaluation.decisions).toHaveLength(1);
	    expect(evaluation.decisions[0]?.side).toBe("UP");
	    expect(evaluation.decisions[0]?.size).toBeCloseTo(57.16645, 6);
	    expect(evaluation.trace.repairOldGap).toBeCloseTo(57.16645, 6);
	    expect(evaluation.trace.repairNewGap).toBeLessThanOrEqual(0.01);
	    expect(evaluation.trace.residualCompletionFallbackReason).toBe("planned_opposite_debt_reducing");
	    expect(evaluation.trace.skipReason).not.toBe("xuan_pair_cost_wait");
	  });

	  it("does not same-second sweep a high-low avg-improving continuation above the strict pair-cost target", () => {
	    const market = buildOfflineMarket(1713696000);
	    let state = createMarketState(market);
	    state = applyFill(state, {
	      outcome: "UP",
	      side: "BUY",
	      size: 449.88452,
	      price: 0.695939,
	      timestamp: market.startTs + 194,
	      makerTaker: "taker",
	      executionMode: "PAIRGROUP_COVERED_SEED",
	    });
	    state = applyFill(state, {
	      outcome: "DOWN",
	      side: "BUY",
	      size: 469.88452,
	      price: 0.32941,
	      timestamp: market.startTs + 219,
	      makerTaker: "taker",
	      executionMode: "PAIRGROUP_COVERED_SEED",
	    });

	    const books = new OrderBookState(
	      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.98, size: 500 }], [{ price: 0.99, size: 500 }]),
	      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.01, size: 500 }], [{ price: 0.02, size: 500 }]),
	    );

	    const evaluation = evaluateEntryBuys(
	      buildRuntimeConfig({
	        BOT_MODE: "XUAN",
	        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
	        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
	      }),
	      state,
	      books,
	      {
	        secsFromOpen: 220,
	        secsToClose: 80,
	        lot: 80,
	        allowControlledOverlap: true,
	        protectedResidualShares: 20,
	        protectedResidualSide: "DOWN",
	      },
	    );

	    expect(evaluation.decisions.filter((decision) => decision.mode === "XUAN_HARD_PAIR_SWEEP")).toHaveLength(0);
	    expect(evaluation.trace.skipReason).not.toBe("controlled_overlap_pair");
	  });
	});
