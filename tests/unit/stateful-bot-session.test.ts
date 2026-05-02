import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { OrderBookState } from "../../src/strategy/xuan5m/orderBookState.js";
import { applyFill } from "../../src/strategy/xuan5m/inventoryState.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import {
  applyRuntimeFlowBudgetConsumption,
  applyRuntimeFlowBudgetLedgerAction,
  applyRuntimeFlowBudgetLineageLedgerAction,
  clampEntryRepairBuyDecision,
  clampMergeAmountToObservedBalances,
  botFillAccountingKey,
  botFillAccountingFingerprintKey,
  deriveRuntimeFlowCalibrationBias,
  deriveRuntimeFlowBudgetState,
  deriveArbitrationCarryExpiry,
  deriveCarryFlowConfidence,
  detectOrderResultShareOverfill,
  estimateMarketBuyTakingSharesForOrder,
  evaluateSingleLegSeedClosePath,
  expectedSharesForSubmission,
  deriveConfirmedCarryAlignmentStreak,
  applyImmediateOrderResultFill,
  BOT_OWNED_SETTLEMENT_GRACE_SEC,
  computeRecentBotOwnedSettlementLockedShares,
  createPendingCompletionSubmission,
  evaluateSessionEndMergeDecision,
  findRecentBotOwnedFillForShortfall,
  findRecentBotOwnedReductionForShortfall,
  findRecentSubmittedIntentForShortfall,
  isRecentBotOwnedShortfallMatch,
  restorePersistedArbitrationCarry,
  refreshRuntimeProtectedResidualLock,
  inferImmediateOrderResultFill,
  inferUserTradeFill,
  isNonBlockingOrderResultOverfillDust,
  orderPairEntriesForPublicFootprint,
  orderResultOverfillDustThreshold,
  postMergeReentryResidualThreshold,
  postMergeResidualBlocksReentry,
  reconcileStateWithBalances,
  resolveSessionTradingDeadline,
  runtimeFlowBudgetReleaseQuantityForResidualChange,
  shouldBlockCompletionForPendingSubmission,
  shouldAllowControlledOverlap,
  shouldRegisterSubmittedIntentForResult,
  shouldPreserveCarryDrivenOverlap,
  terminalBotOwnedCorrectionSuppressReason,
} from "../../src/live/statefulBotSession.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      BOT_MODE: "XUAN",
      ALLOW_CONTROLLED_OVERLAP: "true",
      ...overrides,
    }),
  );
}

function booksWithAsks(upAsk: number, downAsk: number): OrderBookState {
  return new OrderBookState(
    {
      market: "up",
      assetId: "up-token",
      timestamp: 0,
      bids: [],
      asks: [{ price: upAsk, size: 1_000 }],
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    },
    {
      market: "down",
      assetId: "down-token",
      timestamp: 0,
      bids: [],
      asks: [{ price: downAsk, size: 1_000 }],
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    },
  );
}

function booksWithAskLevels(
  upAsks: Array<{ price: number; size: number }>,
  downAsks: Array<{ price: number; size: number }>,
): OrderBookState {
  return new OrderBookState(
    {
      market: "up",
      assetId: "up-token",
      timestamp: 0,
      bids: [],
      asks: upAsks,
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    },
    {
      market: "down",
      assetId: "down-token",
      timestamp: 0,
      bids: [],
      asks: downAsks,
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    },
  );
}

describe("stateful bot session helpers", () => {
  it("blocks strict Xuan re-entry when the planned opposite completion cannot clear CLOB min-notional safely", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      LIVE_SMALL_LOT_LADDER: "15",
      XUAN_BASE_LOT_LADDER: "15",
      DEFAULT_LOT: "15",
      MAX_COMPLETION_OVERSHOOT_SHARES: "0.5",
    });
    const state = createMarketState(buildOfflineMarket(1713696000));
    state.downShares = 3.5;
    state.downCost = 0.14;

    const evaluation = evaluateSingleLegSeedClosePath({
      config,
      state,
      books: booksWithAsks(0.95, 0.04),
      usdcBalance: 100,
      entryBuy: {
        side: "UP",
        size: 15,
        mode: "PAIRGROUP_COVERED_SEED",
        order: {
          tokenId: state.market.tokens.UP.tokenId,
          side: "BUY",
          price: 0.95,
          amount: 14.25,
          shareTarget: 15,
          orderType: "FAK",
        },
      },
    });

    expect(evaluation.block).toBe(true);
    expect(evaluation.reason).toBe("below_min_market_buy_amount");
    expect(evaluation.projectedMissingShares).toBe(11.5);
    expect(evaluation.oppositeSide).toBe("DOWN");
  });

  it("allows strict Xuan re-entry when the planned opposite completion can bridge min-notional with bounded overshoot", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      LIVE_SMALL_LOT_LADDER: "15",
      XUAN_BASE_LOT_LADDER: "15",
      DEFAULT_LOT: "15",
      MAX_COMPLETION_OVERSHOOT_SHARES: "0.5",
    });
    const state = createMarketState(buildOfflineMarket(1713696000));
    state.downShares = 3.5;
    state.downCost = 0.28;

    const evaluation = evaluateSingleLegSeedClosePath({
      config,
      state,
      books: booksWithAsks(0.92, 0.08),
      usdcBalance: 100,
      entryBuy: {
        side: "UP",
        size: 15,
        mode: "PAIRGROUP_COVERED_SEED",
        order: {
          tokenId: state.market.tokens.UP.tokenId,
          side: "BUY",
          price: 0.92,
          amount: 13.8,
          shareTarget: 15,
          orderType: "FAK",
        },
      },
    });

    expect(evaluation.block).toBe(false);
    expect(evaluation.reason).toBe("opposite_completion_executable");
    expect(evaluation.finalShares).toBe(12.5);
  });

  it("blocks aggressive strict Xuan single-leg seed when the planned opposite is executable but not closeable by pair cost", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      LIVE_SMALL_LOT_LADDER: "15",
      XUAN_BASE_LOT_LADDER: "15",
      DEFAULT_LOT: "15",
    });
    const state = createMarketState(buildOfflineMarket(1713696000));

    const evaluation = evaluateSingleLegSeedClosePath({
      config,
      state,
      books: booksWithAsks(0.52, 0.52),
      usdcBalance: 100,
      entryBuy: {
        side: "DOWN",
        size: 15,
        mode: "TEMPORAL_SINGLE_LEG_SEED",
        order: {
          tokenId: state.market.tokens.DOWN.tokenId,
          side: "BUY",
          price: 0.52,
          amount: 7.8,
          shareTarget: 15,
          orderType: "FAK",
        },
      },
    });

    expect(evaluation.block).toBe(true);
    expect(evaluation.reason).toBe("opposite_completion_pair_cost_cap");
    expect(evaluation.oppositeSide).toBe("UP");
    expect(evaluation.projectedPairCost ?? 0).toBeGreaterThan(evaluation.closeablePairCostCap ?? 0);
  });

  it("detects bridge completion raw-fill overrun risk from executable book depth", () => {
    const market = buildOfflineMarket(1713696000);
    const estimatedTakingShares = estimateMarketBuyTakingSharesForOrder({
      outcome: "UP",
      books: booksWithAskLevels([{ price: 0.05, size: 1_000 }], [{ price: 0.96, size: 1_000 }]),
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.06,
        amount: 1.02,
        shareTarget: 17,
        orderType: "FAK",
      },
    });

    expect(estimatedTakingShares).toBe(20.4);
  });

  it("does not let tiny post-merge dust make Xuan pair sweep send the expensive child first", () => {
    const market = buildOfflineMarket(1713696000);
    const upEntry = {
      side: "UP",
      size: 15,
      mode: "XUAN_SOFT_PAIR_SWEEP",
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.09,
        amount: 1.35,
        shareTarget: 15,
        orderType: "FAK",
      },
    } as any;
    const downEntry = {
      side: "DOWN",
      size: 15,
      mode: "XUAN_SOFT_PAIR_SWEEP",
      order: {
        tokenId: market.tokens.DOWN.tokenId,
        side: "BUY",
        price: 0.92,
        amount: 13.8,
        shareTarget: 15,
        orderType: "FAK",
      },
    } as any;

    const ordered = orderPairEntriesForPublicFootprint({
      config: { botMode: "XUAN", xuanCloneMode: "PUBLIC_FOOTPRINT" },
      state: { upShares: 0.51, downShares: 0.451175 },
      group: { selectedMode: "XUAN_SOFT_PAIR_SWEEP" },
      groupedEntries: [downEntry, upEntry],
      controlledOverlapActive: false,
      missingSide: "DOWN",
      minOrderSize: 5,
    });

    expect(ordered.map((entry) => entry.side)).toEqual(["UP", "DOWN"]);
  });

  it("suppresses false external halt when a terminal wallet collapse consumes a persisted bot-owned lot", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      POST_MERGE_FLAT_DUST_SHARES: "0.25",
    });
    const state = createMarketState(buildOfflineMarket(1713696000));

    const reason = terminalBotOwnedCorrectionSuppressReason({
      config,
      state,
      books: booksWithAsks(0.99, 0.03),
      correction: {
        outcome: "DOWN",
        fromShares: 15.294116,
        toShares: 0.004116,
      },
      persistedConsumedQty: 15.29,
      botOwnedCorrection: false,
    });

    expect(reason).toBe("terminal_bot_owned_wallet_collapse");
  });

  it("does not suppress mid-market balance shrink as a terminal bot-owned wallet collapse", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      POST_MERGE_FLAT_DUST_SHARES: "0.25",
    });
    const state = createMarketState(buildOfflineMarket(1713696000));

    const reason = terminalBotOwnedCorrectionSuppressReason({
      config,
      state,
      books: booksWithAsks(0.51, 0.5),
      correction: {
        outcome: "DOWN",
        fromShares: 15,
        toShares: 0,
      },
      persistedConsumedQty: 15,
      botOwnedCorrection: false,
    });

    expect(reason).toBeUndefined();
  });

  it("counts duration from market open when the selected market has not started yet", () => {
    expect(
      resolveSessionTradingDeadline({
        startedAt: 900,
        marketStartTs: 1000,
        marketEndTs: 1300,
        durationSec: 305,
      }),
    ).toBe(1300);
  });

  it("keeps duration anchored to session start for already-open markets", () => {
    expect(
      resolveSessionTradingDeadline({
        startedAt: 1100,
        marketStartTs: 1000,
        marketEndTs: 1300,
        durationSec: 60,
      }),
    ).toBe(1160);
  });

  it("does not session-end safety merge before market close even for a balanced low-cost pair", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      LIVE_SMALL_LOT_LADDER: "5,8,12,15",
      XUAN_BASE_LOT_LADDER: "5,8,12,15",
      MARKET_BASKET_MIN_MERGE_SHARES: "15",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "45",
      POST_MERGE_ONLY_COMPLETION: "false",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.34,
      size: 15,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.33,
      size: 15,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "HIGH_LOW_COMPLETION_CHASE",
    });

    const decision = evaluateSessionEndMergeDecision({
      config,
      state,
      endedAt: market.startTs + 159,
      pendingPairExecutionActive: false,
      mergeTxCount: 0,
    });

    expect(decision).toMatchObject({
      allow: false,
      trigger: "session_end_safety_merge",
      reason: "session_end_before_market_close",
      amount: 14.99,
      mergeable: 15,
    });
    expect(decision.basketEffectivePair).toBeCloseTo(0.702076, 6);
  });

  it("allows a market-close merge for a balanced low-cost pair", () => {
    const config = buildConfig({
      LIVE_SMALL_LOT_LADDER: "5,8,12,15",
      XUAN_BASE_LOT_LADDER: "5,8,12,15",
      MARKET_BASKET_MIN_MERGE_SHARES: "15",
      MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "45",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.34,
      size: 15,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.33,
      size: 15,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "HIGH_LOW_COMPLETION_CHASE",
    });

    const decision = evaluateSessionEndMergeDecision({
      config,
      state,
      endedAt: market.endTs,
      pendingPairExecutionActive: false,
      mergeTxCount: 0,
    });

    expect(decision).toMatchObject({
      allow: true,
      trigger: "market_close",
      reason: "market_close",
      amount: 14.99,
      mergeable: 15,
    });
  });

  it("does not safety-merge an imbalanced pair when the session ends early", () => {
    const config = buildConfig({
      LIVE_SMALL_LOT_LADDER: "5,8,12,15",
      XUAN_BASE_LOT_LADDER: "5,8,12,15",
      MARKET_BASKET_MIN_MERGE_SHARES: "15",
    });
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.34,
      size: 15,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.33,
      size: 10,
      timestamp: market.startTs + 20,
      makerTaker: "taker",
      executionMode: "HIGH_LOW_COMPLETION_CHASE",
    });

    const decision = evaluateSessionEndMergeDecision({
      config,
      state,
      endedAt: market.startTs + 159,
      pendingPairExecutionActive: false,
      mergeTxCount: 0,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("session_end_before_market_close");
  });

  it("derives a shared runtime flow-budget state from carry, quality, density, and pressure", () => {
    const state = deriveRuntimeFlowBudgetState({
      matchedInventoryQuality: 0.82,
      unlockedMatchedInventoryQuality: 0.94,
      carryFlowConfidence: 0.92,
      recentSeedFlowCount: 2,
      activeIndependentFlowCount: 2,
      residualSeverityPressure: 0.3,
    });

    expect(state.budget).toBeGreaterThanOrEqual(1);
    expect(state.confirmed).toBe(true);
    expect(state.elite).toBe(true);
    expect(state.pairGateRelief).toBe(0.003);
    expect(state.unlockedMatchedInventoryQuality).toBe(0.94);
    expect(state.remainingBudget).toBeGreaterThan(0.7);
    expect(state.consumedBudget).toBeLessThan(0.3);
  });

  it("derives soft runtime bias from replay flow calibration focus", () => {
    const warnBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: [
        "increase_lineage_preservation",
        "allow_more_parallel_flow_when_budget_supports",
        "tune_completion_patience_and_release",
        "compress_overlap_seed_rhythm",
      ],
    });
    const passBias = deriveRuntimeFlowCalibrationBias({
      status: "PASS",
      recommendedFocus: [
        "increase_lineage_preservation",
        "allow_more_parallel_flow_when_budget_supports",
        "tune_completion_patience_and_release",
      ],
    });
    const strongOverlapCompressionBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["compress_overlap_seed_rhythm"],
      averageSideSequenceMismatchOffsetDeltaSec: 24,
    });

    expect(warnBias).toMatchObject({
      lineageFlowCountBonus: 1,
      activeFlowCountBonus: 1,
      overlapCadenceCompressionBonus: 1,
      completionPatienceFlowCountBonus: 1,
      semanticRoleFlowCountBonus: 0,
      completionPatienceMultiplier: 1,
      completionReleaseBias: "neutral",
      semanticRoleAlignmentBias: "neutral",
      childOrderMicroTimingBias: "neutral",
      completionRoleReleaseOrderBias: "neutral",
      openingSeedReleaseBias: "neutral",
      openingSeedOffsetShiftSec: 0,
    });
    expect(passBias).toMatchObject({
      lineageFlowCountBonus: 0,
      activeFlowCountBonus: 0,
      overlapCadenceCompressionBonus: 0,
      completionPatienceFlowCountBonus: 0,
      semanticRoleFlowCountBonus: 0,
      completionPatienceMultiplier: 1,
      completionReleaseBias: "neutral",
      semanticRoleAlignmentBias: "neutral",
      childOrderMicroTimingBias: "neutral",
      completionRoleReleaseOrderBias: "neutral",
      openingSeedReleaseBias: "neutral",
      openingSeedOffsetShiftSec: 0,
    });
    expect(strongOverlapCompressionBias.overlapCadenceCompressionBonus).toBe(2);

    const releaseEarlierBias = deriveRuntimeFlowCalibrationBias({
      status: "FAIL",
      recommendedFocus: ["release_completion_earlier"],
      completionLatencyDirection: "candidate_late",
      averageCycleCompletionLatencyDeltaSec: 7,
    });
    const tailDampedReleaseEarlierBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["release_completion_earlier"],
      completionLatencyDirection: "candidate_late",
      averageCycleCompletionLatencyDeltaSec: 2,
      averageCycleCompletionLatencyDeltaP50Sec: 0,
      averageCycleCompletionLatencyDeltaP75Sec: 6,
    });
    const tailDampedTuneBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["tune_completion_patience_and_release"],
      completionLatencyDirection: "aligned",
      averageCycleCompletionLatencyDeltaSec: 0,
      averageCycleCompletionLatencyDeltaP50Sec: 0,
      averageCycleCompletionLatencyDeltaP75Sec: 4,
    });
    const mildlyShiftedTailDampedTuneBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["tune_completion_patience_and_release"],
      completionLatencyDirection: "aligned",
      averageCycleCompletionLatencyDeltaSec: 0,
      averageCycleCompletionLatencyDeltaP50Sec: 1.5,
      averageCycleCompletionLatencyDeltaP75Sec: 5,
    });
    const waitLongerBias = deriveRuntimeFlowCalibrationBias({
      status: "FAIL",
      recommendedFocus: ["increase_completion_patience"],
      completionLatencyDirection: "candidate_early",
      averageCycleCompletionLatencyDeltaSec: -7,
    });
    const coldStartBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["collect_replay_flow_samples"],
    });
    const openingEarlierBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["release_opening_seed_earlier"],
      openingEntryTimingDirection: "candidate_late",
      averageFirstEntryOffsetDeltaSec: 6,
    });
    const openingEarlierMinimumBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["release_opening_seed_earlier"],
      openingEntryTimingDirection: "candidate_late",
      averageFirstEntryOffsetDeltaSec: 4,
    });
    const maintainOpeningBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["maintain_opening_seed_early"],
    });

    expect(releaseEarlierBias.completionPatienceMultiplier).toBe(0.25);
    expect(releaseEarlierBias.completionReleaseBias).toBe("earlier");
    expect(tailDampedReleaseEarlierBias.completionPatienceMultiplier).toBe(0.63);
    expect(tailDampedReleaseEarlierBias.completionReleaseBias).toBe("earlier");
    expect(tailDampedTuneBias.completionPatienceMultiplier).toBe(0.63);
    expect(tailDampedTuneBias.completionReleaseBias).toBe("neutral");
    expect(mildlyShiftedTailDampedTuneBias.completionPatienceMultiplier).toBe(0.63);
    expect(mildlyShiftedTailDampedTuneBias.completionReleaseBias).toBe("neutral");
    expect(waitLongerBias.completionPatienceMultiplier).toBe(1.28);
    expect(waitLongerBias.completionReleaseBias).toBe("later");
    expect(coldStartBias.completionPatienceMultiplier).toBe(0.63);
    expect(coldStartBias.completionReleaseBias).toBe("earlier");
    expect(coldStartBias.openingSeedReleaseBias).toBe("earlier");
    expect(coldStartBias.openingSeedOffsetShiftSec).toBe(6);
    expect(openingEarlierBias.openingSeedReleaseBias).toBe("earlier");
    expect(openingEarlierBias.openingSeedOffsetShiftSec).toBe(6);
    expect(openingEarlierMinimumBias.openingSeedOffsetShiftSec).toBe(6);
    expect(maintainOpeningBias.openingSeedReleaseBias).toBe("earlier");
    expect(maintainOpeningBias.openingSeedOffsetShiftSec).toBe(6);

    const semanticRoleBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["align_high_low_role_sequence"],
    });
    const preserveRawSideBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["align_high_low_role_sequence", "preserve_raw_side_before_role_override"],
    });
    const guardedRoleBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["align_high_low_role_sequence", "guard_role_alignment_against_side_regression"],
    });
    const cycleRoleArbitrationBias = deriveRuntimeFlowCalibrationBias({
      status: "WARN",
      recommendedFocus: ["align_high_low_role_sequence", "improve_seed_side_rhythm", "improve_child_order_micro_timing"],
    });
    expect(semanticRoleBias.semanticRoleFlowCountBonus).toBe(1);
    expect(semanticRoleBias.semanticRoleAlignmentBias).toBe("align_high_low_role");
    expect(preserveRawSideBias.semanticRoleAlignmentBias).toBe("preserve_raw_side");
    expect(guardedRoleBias.semanticRoleAlignmentBias).toBe("preserve_raw_side");
    expect(cycleRoleArbitrationBias.semanticRoleAlignmentBias).toBe("cycle_role_arbitration");
    expect(
      deriveRuntimeFlowCalibrationBias({
        status: "WARN",
        recommendedFocus: ["tune_completion_role_release_order"],
      }).completionRoleReleaseOrderBias,
    ).toBe("role_order");
    expect(
      deriveRuntimeFlowCalibrationBias({
        status: "WARN",
        recommendedFocus: ["improve_child_order_micro_timing"],
      }).childOrderMicroTimingBias,
    ).toBe("flow_intent");
  });

  it("reserves runtime flow budget for active flows, protected residuals, and pending merge windows", () => {
    const state = deriveRuntimeFlowBudgetState({
      matchedInventoryQuality: 1,
      unlockedMatchedInventoryQuality: 1,
      carryFlowConfidence: 1,
      recentSeedFlowCount: 3,
      activeIndependentFlowCount: 3,
      residualSeverityPressure: 0.45,
    });
    const consumedState = applyRuntimeFlowBudgetConsumption(state, {
      activeIndependentFlowCount: 3,
      pendingMergeWindowCount: 2,
      protectedResidualShares: 18,
      residualSeverityPressure: 0.45,
      pendingPairExecutionActive: true,
      realizedActionBudgetLoad: 0.12,
      lineageActionBudgetLoad: 0.08,
    });

    expect(consumedState.reservedBudget).toBeGreaterThan(0.3);
    expect(consumedState.remainingBudget).toBeLessThan(state.remainingBudget);
    expect(consumedState.consumedBudget).toBeGreaterThan(state.consumedBudget);
    expect(consumedState.confirmed).toBe(state.confirmed);
    expect(consumedState.flowLoadReserve).toBeGreaterThan(0);
    expect(consumedState.mergeReserve).toBeGreaterThan(0);
    expect(consumedState.residualReserve).toBeGreaterThan(0);
    expect(consumedState.pendingExecutionReserve).toBeGreaterThan(0);
    expect(consumedState.realizedActionReserve).toBe(0.12);
    expect(consumedState.lineageActionReserve).toBe(0.08);
  });

  it("updates runtime flow-budget ledger load from realized actions and releases it after merge", () => {
    const afterPair = applyRuntimeFlowBudgetLedgerAction(0, "pair_submit", {
      quantityShares: 100,
      baseLot: 100,
    });
    const afterSeed = applyRuntimeFlowBudgetLedgerAction(afterPair, "seed_submit", {
      quantityShares: 100,
      baseLot: 100,
    });
    const afterCompletion = applyRuntimeFlowBudgetLedgerAction(afterSeed, "completion_submit", {
      quantityShares: 100,
      baseLot: 100,
    });
    const afterMerge = applyRuntimeFlowBudgetLedgerAction(afterCompletion, "merge", {
      quantityShares: 100,
      baseLot: 100,
    });

    expect(afterPair).toBeGreaterThan(0);
    expect(afterSeed).toBeGreaterThan(afterPair);
    expect(afterCompletion).toBeLessThan(afterSeed);
    expect(afterMerge).toBe(0);
  });

  it("scales runtime flow-budget ledger deltas by clip size and keeps lineage loads separate", () => {
    const smallPair = applyRuntimeFlowBudgetLedgerAction(0, "pair_submit", {
      quantityShares: 25,
      baseLot: 100,
    });
    const largePair = applyRuntimeFlowBudgetLedgerAction(0, "pair_submit", {
      quantityShares: 225,
      baseLot: 100,
    });
    let lineageLoads = applyRuntimeFlowBudgetLineageLedgerAction({}, "pair_submit", {
      lineage: "favor_independent_overlap|DOWN|UP",
      quantityShares: 225,
      baseLot: 100,
    });
    lineageLoads = applyRuntimeFlowBudgetLineageLedgerAction(lineageLoads, "pair_submit", {
      lineage: "favor_independent_overlap|UP|DOWN",
      quantityShares: 25,
      baseLot: 100,
    });
    lineageLoads = applyRuntimeFlowBudgetLineageLedgerAction(lineageLoads, "merge", {
      lineage: "favor_independent_overlap|DOWN|UP",
      quantityShares: 225,
      baseLot: 100,
    });

    expect(largePair).toBeGreaterThan(smallPair);
    expect(lineageLoads["favor_independent_overlap|UP|DOWN"]).toBeGreaterThan(0);
    expect(lineageLoads["favor_independent_overlap|DOWN|UP"]).toBeUndefined();
  });

  it("releases runtime flow budget according to realized residual shrink quality", () => {
    const cleanShrink = runtimeFlowBudgetReleaseQuantityForResidualChange({
      requestedShares: 20,
      oldGap: 24,
      newGap: 4,
    });
    const weakShrink = runtimeFlowBudgetReleaseQuantityForResidualChange({
      requestedShares: 20,
      oldGap: 24,
      newGap: 22,
    });
    const noShrink = runtimeFlowBudgetReleaseQuantityForResidualChange({
      requestedShares: 20,
      oldGap: 24,
      newGap: 26,
    });

    expect(cleanShrink).toBe(20);
    expect(weakShrink).toBe(2);
    expect(noShrink).toBe(9);
  });

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

  it("caps order-result overfill in the strategy ledger and records the excess separately", () => {
    const market = buildOfflineMarket(1713696000);
    const order = {
      tokenId: market.tokens.UP.tokenId,
      side: "BUY" as const,
      price: 0.5,
      amount: 7.5,
      shareTarget: 15,
      orderType: "FAK" as const,
    };
    const result = {
      success: true,
      simulated: false,
      orderId: "overfill-order-1",
      status: "matched",
      requestedAt: 1713696015,
      raw: {
        takingAmount: "17.857141",
        makingAmount: "7.499999",
      },
    };

    const fill = inferImmediateOrderResultFill({
      outcome: "UP",
      nowTs: 1713696015,
      mode: "PAIRGROUP_COVERED_SEED",
      order,
      result,
    });

    expect(expectedSharesForSubmission(order.shareTarget, result)).toBe(15);
    expect(fill).toMatchObject({
      outcome: "UP",
      side: "BUY",
      price: 0.5,
      size: 15,
    });
    expect(
      detectOrderResultShareOverfill({
        order,
        fill: fill!,
        result,
        orderId: "overfill-order-1",
        groupId: "pair-1",
      }),
    ).toEqual({
      orderId: "overfill-order-1",
      groupId: "pair-1",
      outcome: "UP",
      shareTarget: 15,
      filledShares: 17.857141,
      excessShares: 2.857141,
    });
    expect(botFillAccountingKey(fill!, { orderId: "overfill-order-1" })).toBe(
      "order:overfill-order-1:UP:BUY",
    );
  });

  it("does not let a cheap raw takingAmount spike become normal ledger inventory", () => {
    const market = buildOfflineMarket(1713696000);
    const order = {
      tokenId: market.tokens.DOWN.tokenId,
      side: "BUY" as const,
      price: 0.5,
      amount: 7.5,
      shareTarget: 15,
      orderType: "FAK" as const,
    };
    const result = {
      success: true,
      simulated: false,
      orderId: "cheap-spike-order",
      status: "matched",
      requestedAt: 1713696015,
      raw: {
        takingAmount: "750",
        makingAmount: "7.5",
      },
    };

    const fill = inferImmediateOrderResultFill({
      outcome: "DOWN",
      nowTs: 1713696015,
      mode: "POST_MERGE_RESIDUAL_COMPLETION",
      order,
      result,
    });

    expect(expectedSharesForSubmission(order.shareTarget, result)).toBe(15);
    expect(fill).toMatchObject({
      outcome: "DOWN",
      side: "BUY",
      price: 0.5,
      size: 15,
    });
    expect(
      detectOrderResultShareOverfill({
        order,
        fill: fill!,
        result,
        orderId: "cheap-spike-order",
      }),
    ).toMatchObject({
      outcome: "DOWN",
      shareTarget: 15,
      filledShares: 750,
      excessShares: 735,
    });
  });

  it("classifies sub-minimum Xuan overfill as non-blocking dust but keeps material overfill protected", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "15",
      LIVE_SMALL_LOT_LADDER: "15",
      MAX_COMPLETION_OVERSHOOT_SHARES: "0.25",
    });

    expect(orderResultOverfillDustThreshold({ config, minOrderSize: 5, shareTarget: 15 })).toBe(5);
    expect(
      isNonBlockingOrderResultOverfillDust({
        config,
        minOrderSize: 5,
        overfill: {
          shareTarget: 15,
          excessShares: 0.692305,
        },
      }),
    ).toBe(true);
    expect(
      isNonBlockingOrderResultOverfillDust({
        config,
        minOrderSize: 5,
        overfill: {
          shareTarget: 15,
          excessShares: 3.333332,
        },
      }),
    ).toBe(true);
    expect(
      isNonBlockingOrderResultOverfillDust({
        config,
        minOrderSize: 5,
        overfill: {
          shareTarget: 15,
          excessShares: 5.1,
        },
      }),
    ).toBe(false);
  });

  it("treats post-merge overfill dust below the CLOB minimum as non-blocking for Xuan recycle", () => {
    const config = buildConfig({
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      POST_MERGE_FLAT_DUST_SHARES: "0.05",
      POST_MERGE_ALLOW_NEW_PAIR_IF_FLAT: "true",
      POST_MERGE_ONLY_COMPLETION_WHILE_RESIDUAL: "true",
    });
    let state = createMarketState(buildOfflineMarket(1713696000));
    state = {
      ...state,
      upShares: 0,
      downShares: 1.43857,
      reentryDisabled: true,
    };

    expect(postMergeReentryResidualThreshold(config, state)).toBe(5);
    expect(postMergeResidualBlocksReentry(config, state)).toBe(false);

    state = {
      ...state,
      downShares: 5.01,
    };
    expect(postMergeResidualBlocksReentry(config, state)).toBe(true);
  });

  it("keeps strict post-merge residual blocking tied to configured dust", () => {
    const config = buildConfig({
      BOT_MODE: "STRICT",
      POST_MERGE_FLAT_DUST_SHARES: "0.05",
      POST_MERGE_ALLOW_NEW_PAIR_IF_FLAT: "true",
      POST_MERGE_ONLY_COMPLETION_WHILE_RESIDUAL: "true",
    });
    const state = {
      ...createMarketState(buildOfflineMarket(1713696000)),
      upShares: 0,
      downShares: 1.43857,
      reentryDisabled: true,
    };

    expect(postMergeReentryResidualThreshold(config, state)).toBe(0.05);
    expect(postMergeResidualBlocksReentry(config, state)).toBe(true);
  });

  it("dedupes repeated bot fill accounting by order id instead of timestamp or price drift", () => {
    const fill = {
      outcome: "UP" as const,
      side: "BUY" as const,
      price: 0.42,
      size: 15,
      timestamp: 1713696015,
    };

    expect(botFillAccountingKey(fill, { orderId: "same-order" })).toBe("order:same-order:UP:BUY");
    expect(
      botFillAccountingKey(
        {
          ...fill,
          price: 0.421,
          size: 14.9999,
          timestamp: 1713696017,
        },
        { orderId: "same-order" },
      ),
    ).toBe("order:same-order:UP:BUY");
  });

  it("builds a fallback fill accounting fingerprint when the user websocket has no order id", () => {
    const fill = {
      outcome: "DOWN" as const,
      side: "BUY" as const,
      price: 0.25,
      size: 15.2,
      timestamp: 1777581418,
    };

    expect(botFillAccountingKey(fill, { orderId: undefined })).toBeUndefined();
    expect(botFillAccountingFingerprintKey(fill)).toBe("fill:DOWN:BUY:15.2000:0.2500:888790709");
    expect(
      botFillAccountingFingerprintKey({
        ...fill,
        timestamp: 1777581419,
      }),
    ).toBe("fill:DOWN:BUY:15.2000:0.2500:888790709");
  });

  it("does not register submitted fill intents for rejected child orders", () => {
    expect(
      shouldRegisterSubmittedIntentForResult({
        success: false,
        simulated: false,
        orderId: "rejected-child",
        status: "400",
        requestedAt: 1713696015,
        raw: {
          error: "no match",
        },
      }),
    ).toBe(false);
    expect(
      shouldRegisterSubmittedIntentForResult({
        success: true,
        simulated: false,
        orderId: "accepted-child",
        status: "accepted",
        requestedAt: 1713696015,
        raw: {},
      }),
    ).toBe(true);
  });

  it("applies matched completion order results to state immediately", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.47,
      size: 40,
      timestamp: 1713696004,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const applied = applyImmediateOrderResultFill({
      state,
      outcome: "DOWN",
      nowTs: 1713696034,
      mode: "PARTIAL_SOFT_COMPLETION",
      order: {
        tokenId: market.tokens.DOWN.tokenId,
        side: "BUY",
        price: 0.48,
        amount: 19.2,
        shareTarget: 40,
        orderType: "FAK",
      },
      result: {
        success: true,
        simulated: false,
        orderId: "completion-1",
        status: "matched",
        requestedAt: 1713696034,
        raw: {
          takingAmount: "40",
          makingAmount: "19.2",
        },
      },
      flowLineage: "completion-flow",
    });

    expect(applied.fill).toMatchObject({
      outcome: "DOWN",
      side: "BUY",
      size: 40,
      price: 0.48,
      executionMode: "PARTIAL_SOFT_COMPLETION",
      flowLineage: "completion-flow",
    });
    expect(applied.state.upShares).toBe(40);
    expect(applied.state.downShares).toBe(40);
    expect(Math.abs(applied.state.upShares - applied.state.downShares)).toBe(0);
  });

  it("clamps entry repair orders to the traced repair quantity before execution", () => {
    const market = buildOfflineMarket(1713696000);
    const clamped = clampEntryRepairBuyDecision({
      minOrderSize: 5,
      entryTrace: {
        repairRequestedQty: 15,
        repairSize: 15,
      },
      entryBuy: {
        side: "DOWN",
        size: 71.325,
        reason: "lagging_rebalance",
        mode: "HIGH_LOW_COMPLETION_CHASE",
        expectedAveragePrice: 0.48,
        effectivePricePerShare: 0.497,
        order: {
          tokenId: market.tokens.DOWN.tokenId,
          side: "BUY",
          price: 0.48,
          amount: 34.236,
          shareTarget: 71.325,
          orderType: "FAK",
        },
      },
    });

    expect(clamped.clamped).toBe(true);
    expect(clamped.originalShares).toBe(71.325);
    expect(clamped.capShares).toBe(15);
    expect(clamped.entryBuy.size).toBe(15);
    expect(clamped.entryBuy.order.shareTarget).toBe(15);
    expect(clamped.entryBuy.order.amount).toBe(7.2);
  });

  it("tops up near-minimum entry repair gaps instead of sending a zero-sized skipped order", () => {
    const market = buildOfflineMarket(1713696000);
    const clamped = clampEntryRepairBuyDecision({
      minOrderSize: 5,
      maxCompletionOvershootShares: 0.25,
      entryTrace: {
        repairRequestedQty: 5,
        repairSize: 4.953805,
        repairFinalQty: 4.953805,
      },
      entryBuy: {
        side: "UP",
        size: 4.953805,
        reason: "lagging_rebalance",
        mode: "PARTIAL_SOFT_COMPLETION",
        expectedAveragePrice: 0.24,
        effectivePricePerShare: 0.24,
        order: {
          tokenId: market.tokens.UP.tokenId,
          side: "BUY",
          price: 0.24,
          amount: 1.188913,
          shareTarget: 4.953805,
          orderType: "FAK",
        },
      },
    });

    expect(clamped.clamped).toBe(true);
    expect(clamped.originalShares).toBe(4.953805);
    expect(clamped.capShares).toBe(5);
    expect(clamped.entryBuy.size).toBe(5);
    expect(clamped.entryBuy.order.shareTarget).toBe(5);
    expect(clamped.entryBuy.order.amount).toBe(1.2);
  });

  it("preserves CLOB precision when entry repair clamps a fractional completion quantity", () => {
    const market = buildOfflineMarket(1713696000);
    const clamped = clampEntryRepairBuyDecision({
      minOrderSize: 5,
      entryTrace: {
        repairRequestedQty: 14.535716,
        repairSize: 14.535716,
        repairFinalQty: 14.535716,
      },
      entryBuy: {
        side: "UP",
        size: 15,
        reason: "lagging_rebalance",
        mode: "HIGH_LOW_COMPLETION_CHASE",
        expectedAveragePrice: 0.41,
        effectivePricePerShare: 0.41,
        order: {
          tokenId: market.tokens.UP.tokenId,
          side: "BUY",
          price: 0.41,
          amount: 6.15,
          shareTarget: 15,
          orderType: "FAK",
        },
      },
    });

    expect(clamped.clamped).toBe(true);
    expect(clamped.entryBuy.size).toBe(14);
    expect(clamped.entryBuy.order.shareTarget).toBe(14);
    expect(clamped.entryBuy.order.amount).toBe(5.74);
    expect(Number.isInteger(Number((clamped.entryBuy.order.shareTarget! * 0.41 * 100).toFixed(6)))).toBe(true);
  });

  it("applies matched entry repair order results to state immediately", () => {
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.41,
      size: 71.325,
      timestamp: 1713696004,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });

    const applied = applyImmediateOrderResultFill({
      state,
      outcome: "DOWN",
      nowTs: 1713696061,
      mode: "HIGH_LOW_COMPLETION_CHASE",
      order: {
        tokenId: market.tokens.DOWN.tokenId,
        side: "BUY",
        price: 0.48,
        amount: 7.2,
        shareTarget: 15,
        orderType: "FAK",
      },
      result: {
        success: true,
        simulated: false,
        orderId: "entry-repair-1",
        status: "matched",
        requestedAt: 1713696061,
        raw: {
          takingAmount: "15",
          makingAmount: "7.2",
        },
      },
      flowLineage: "entry-repair-flow",
    });

    expect(applied.fill).toMatchObject({
      outcome: "DOWN",
      side: "BUY",
      size: 15,
      price: 0.48,
      executionMode: "HIGH_LOW_COMPLETION_CHASE",
      flowLineage: "entry-repair-flow",
    });
    expect(applied.state.upShares).toBe(71.325);
    expect(applied.state.downShares).toBe(15);
    expect(Math.abs(applied.state.upShares - applied.state.downShares)).toBe(56.325);
  });

  it("blocks duplicate completion submissions while an accepted result has no immediate fill quantity", () => {
    const pending = createPendingCompletionSubmission({
      side: "DOWN",
      requestedShares: 40,
      nowTs: 1713696034,
      maxAgeSec: 17,
      result: {
        success: true,
        simulated: false,
        orderId: "completion-pending",
        status: "accepted",
        requestedAt: 1713696034,
        raw: {},
      },
    });

    expect(pending).toMatchObject({
      side: "DOWN",
      orderId: "completion-pending",
      requestedShares: 40,
      submittedAt: 1713696034,
      expiresAt: 1713696051,
    });
    expect(
      shouldBlockCompletionForPendingSubmission({
        pending,
        side: "DOWN",
        nowTs: 1713696035,
      }),
    ).toBe(true);
    expect(
      shouldBlockCompletionForPendingSubmission({
        pending,
        side: "DOWN",
        nowTs: 1713696052,
      }),
    ).toBe(false);
    expect(
      shouldBlockCompletionForPendingSubmission({
        pending,
        side: "UP",
        nowTs: 1713696035,
      }),
    ).toBe(false);
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

  it("keeps recent bot-owned order-result fills locked during settlement lag", () => {
    const fills = [
      {
        outcome: "UP" as const,
        size: 15,
        price: 0.38,
        timestamp: 1777491010,
        expiresAt: 1777491030,
        orderId: "up-1",
      },
      {
        outcome: "UP" as const,
        size: 15,
        price: 0.26,
        timestamp: 1777491016,
        expiresAt: 1777491036,
        orderId: "up-2",
      },
      {
        outcome: "DOWN" as const,
        size: 15,
        price: 0.63,
        timestamp: 1777491004,
        expiresAt: 1777491024,
        orderId: "down-1",
      },
    ];

    expect(
      findRecentBotOwnedFillForShortfall(fills, {
        outcome: "DOWN",
        fromShares: 15,
        toShares: 0,
        nowTs: 1777491010,
      }),
    ).toMatchObject({ orderId: "down-1" });
    expect(
      findRecentBotOwnedFillForShortfall(fills, {
        outcome: "UP",
        fromShares: 30,
        toShares: 4.9036,
        nowTs: 1777491019,
      }),
    ).toMatchObject({ orderId: "up-2" });
    expect(
      findRecentBotOwnedFillForShortfall(fills, {
        outcome: "UP",
        fromShares: 30,
        toShares: 0,
        nowTs: 1777491019,
      }),
    ).toMatchObject({ orderId: "up-2" });
    expect(computeRecentBotOwnedSettlementLockedShares(fills, 1777491019)).toEqual({
      up: 30,
      down: 15,
    });
    expect(
      findRecentBotOwnedFillForShortfall(fills, {
        outcome: "UP",
        fromShares: 30,
        toShares: 0,
        nowTs: 1777491016 + BOT_OWNED_SETTLEMENT_GRACE_SEC + 1,
      }),
    ).toBeUndefined();
  });

  it("clamps merge execution to observed wallet mergeable and skips dust below CTF minimum", () => {
    expect(
      clampMergeAmountToObservedBalances({
        requestedAmount: 5,
        observed: { up: 0.218332, down: 5.01 },
        minShares: 5,
      }),
    ).toEqual({
      requestedAmount: 5,
      observedMergeable: 0.218332,
      executableAmount: 0.218332,
      skipped: true,
      reason: "observed_balance_below_min",
    });

    expect(
      clampMergeAmountToObservedBalances({
        requestedAmount: 5,
        observed: { up: 4.75, down: 10 },
        minShares: 1,
      }),
    ).toEqual({
      requestedAmount: 5,
      observedMergeable: 4.75,
      executableAmount: 4.75,
      skipped: false,
      reason: "clamped_to_observed_balance",
    });
  });

  it("marks confirmed CTF merge balance reductions as bot-owned reconcile corrections", () => {
    const reductions = [
      {
        outcome: "UP" as const,
        size: 5,
        timestamp: 1777569755,
        expiresAt: 1777569800,
        reason: "ctf_merge" as const,
        txHash: "0xmerge",
      },
      {
        outcome: "DOWN" as const,
        size: 5,
        timestamp: 1777569755,
        expiresAt: 1777569800,
        reason: "ctf_merge" as const,
        txHash: "0xmerge",
      },
    ];

    expect(
      findRecentBotOwnedReductionForShortfall(reductions, {
        outcome: "UP",
        fromShares: 5.218332,
        toShares: 0.218332,
        nowTs: 1777569768,
      }),
    ).toMatchObject({
      outcome: "UP",
      size: 5,
      reason: "ctf_merge",
      txHash: "0xmerge",
    });
    expect(
      findRecentBotOwnedReductionForShortfall(reductions, {
        outcome: "UP",
        fromShares: 5.218332,
        toShares: 0.218332,
        nowTs: 1777569801,
      }),
    ).toBeUndefined();
  });

  it("keeps inactive submitted intents owned during balance settlement lag", () => {
    const intents = [
      {
        side: "BUY" as const,
        price: 0.37,
        submittedAt: 1777565712,
        mode: "POST_MERGE_RESIDUAL_COMPLETION" as const,
        orderId: "completion-1",
        expectedShares: 5.138887,
        attributedShares: 5.138887,
        active: false,
      },
    ];

    const nowTs = 1777565745;
    const submittedIntentSettlementGraceSec = 45;
    const candidate = {
      outcome: "UP",
      fromShares: 5.138887,
      toShares: 0,
      nowTs,
    } as const;
    const matchedIntent = findRecentSubmittedIntentForShortfall(
      intents,
      candidate,
      submittedIntentSettlementGraceSec,
    );
    expect(matchedIntent).toMatchObject({ orderId: "completion-1" });
    expect(matchedIntent && isRecentBotOwnedShortfallMatch(matchedIntent, nowTs)).toBe(true);

    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.37,
      size: 5.138887,
      timestamp: 1777565712,
      makerTaker: "taker",
      executionMode: "POST_MERGE_RESIDUAL_COMPLETION",
    });

    const reconciled = reconcileStateWithBalances({
      state,
      observed: { up: 0, down: 0 },
      nowTs,
      fallbackPrices: { UP: 0.37, DOWN: 0.6 },
      shouldIgnoreShortfall: (shortfall) => {
        if (shortfall.outcome !== "UP") {
          return false;
        }
        const matched = findRecentSubmittedIntentForShortfall(
          intents,
          shortfall,
          submittedIntentSettlementGraceSec,
        );
        return matched !== undefined && isRecentBotOwnedShortfallMatch(matched, shortfall.nowTs);
      },
    });

    expect(reconciled.corrections).toEqual([]);
    expect(reconciled.state.upShares).toBe(5.138887);
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

  it("opens a runtime protected residual lock after a temporal seed creates an imbalance", () => {
    const lock = refreshRuntimeProtectedResidualLock({
      lock: undefined,
      state: {
        upShares: 116.0656,
        downShares: 0,
      },
      nowTs: 1776248104,
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    expect(lock).toEqual({
      openedAt: 1776248104,
      protectedSide: "UP",
      protectedShares: 116.0656,
      sourceMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
  });

  it("keeps a runtime protected residual lock alive while a delayed completion still leaves residual exposure", () => {
    const initialLock = refreshRuntimeProtectedResidualLock({
      lock: undefined,
      state: {
        upShares: 116.0656,
        downShares: 0,
      },
      nowTs: 1776248104,
      mode: "TEMPORAL_SINGLE_LEG_SEED",
    });

    const refreshedLock = refreshRuntimeProtectedResidualLock({
      lock: initialLock,
      state: {
        upShares: 116.0656,
        downShares: 60.87384,
      },
      nowTs: 1776248156,
      mode: "PARTIAL_FAST_COMPLETION",
    });

    expect(refreshedLock).toEqual({
      openedAt: 1776248104,
      protectedSide: "UP",
      protectedShares: 55.19176,
      sourceMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
  });

  it("extends arbitration carry longer when the same overlap recommendation stays aligned across ticks", () => {
    const config = buildConfig();
    const baseExpiry = deriveArbitrationCarryExpiry({
      config,
      carry: {
        createdAt: 100,
        recommendation: "favor_independent_overlap",
        protectedResidualSide: "UP",
        referenceShareGap: 2,
        alignmentStreak: 1,
        lastObservedAt: 110,
        lastProtectedShares: 2,
        expiresAt: 118,
      },
      protectedResidualShares: 1.95,
      nowTs: 112,
      recentSeedFlowCount: 1,
      residualBehaviorState: {
        carryPersistenceBias: 1.35,
        riskToleranceBias: 0.72,
        severityPressure: 0.2,
      },
    });
    const alignedExpiry = deriveArbitrationCarryExpiry({
      config,
      carry: {
        createdAt: 100,
        recommendation: "favor_independent_overlap",
        protectedResidualSide: "UP",
        referenceShareGap: 2,
        alignmentStreak: 3,
        lastObservedAt: 110,
        lastProtectedShares: 2,
        expiresAt: 118,
      },
      protectedResidualShares: 1.95,
      nowTs: 112,
      recentSeedFlowCount: 2,
      residualBehaviorState: {
        carryPersistenceBias: 1.35,
        riskToleranceBias: 0.72,
        severityPressure: 0.2,
      },
    });

    expect(alignedExpiry).toBeGreaterThan(baseExpiry);
  });

  it("preserves overlap eligibility from sticky carry when matched inventory is briefly below target", () => {
    const config = buildConfig({
      REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: "true",
      MAX_OPEN_GROUPS_PER_MARKET: "3",
      MAX_OPEN_PARTIAL_GROUPS: "2",
    });

    const withoutCarry = shouldPreserveCarryDrivenOverlap({
      config,
      carry: undefined,
      nowTs: 120,
      secsToClose: 240,
      protectedResidualShares: 1.5,
      completionActive: true,
      linkageHealthy: true,
      matchedInventoryTargetMet: false,
      matchedInventoryQuality: 0.55,
      recentSeedFlowCount: 1,
    });
    const withCarry = shouldPreserveCarryDrivenOverlap({
      config,
      carry: {
        recommendation: "favor_independent_overlap",
        expiresAt: 150,
        alignmentStreak: 3,
      },
      nowTs: 120,
      secsToClose: 240,
      protectedResidualShares: 1.5,
      completionActive: true,
      linkageHealthy: true,
      matchedInventoryTargetMet: false,
      matchedInventoryQuality: 0.72,
      recentSeedFlowCount: 1,
    });

    expect(withoutCarry).toBe(false);
    expect(withCarry).toBe(true);
  });

  it("blocks controlled overlap when the protected residual is below actionable repair size", () => {
    const market = buildOfflineMarket(1713696000);
    const config = buildConfig({
      REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: "false",
      MAX_OPEN_GROUPS_PER_MARKET: "3",
      MAX_OPEN_PARTIAL_GROUPS: "2",
      REPAIR_MIN_QTY: "5",
      COMPLETION_MIN_QTY: "5",
      LIVE_SMALL_LOT_LADDER: "5,8,12,15",
    });

    const entryBuys = (["UP", "DOWN"] as const).map((side) => ({
      side,
      size: 5,
      reason: "balanced_pair_reentry" as const,
      mode: "PAIRGROUP_COVERED_SEED" as const,
      expectedAveragePrice: 0.5,
      effectivePricePerShare: 0.5,
      order: {
        tokenId: side === "UP" ? market.tokens.UP.tokenId : market.tokens.DOWN.tokenId,
        side: "BUY" as const,
        price: 0.5,
        amount: 2.5,
        shareTarget: 5,
        orderType: "FAK" as const,
      },
    }));

    expect(
      shouldAllowControlledOverlap({
        config,
        nowTs: market.startTs + 40,
        secsToClose: 260,
        protectedResidualLock: {
          openedAt: market.startTs + 5,
        },
        protectedResidualShares: 2.857141,
        completionActive: true,
        linkageHealthy: true,
        entryBuys,
        matchedInventoryTargetMet: true,
        worstCaseAmplificationShares: 0,
        recentSeedFlowCount: 1,
        activeIndependentFlowCount: 1,
      }),
    ).toBe(false);
  });

  it("still blocks carry-preserved overlap when matched inventory quality is too weak", () => {
    const config = buildConfig({
      REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: "true",
      MAX_OPEN_GROUPS_PER_MARKET: "3",
      MAX_OPEN_PARTIAL_GROUPS: "2",
    });

    const withWeakQuality = shouldPreserveCarryDrivenOverlap({
      config,
      carry: {
        recommendation: "favor_independent_overlap",
        expiresAt: 150,
        alignmentStreak: 3,
      },
      nowTs: 120,
      secsToClose: 240,
      protectedResidualShares: 1.5,
      completionActive: true,
      linkageHealthy: true,
      matchedInventoryTargetMet: false,
      matchedInventoryQuality: 0.35,
      recentSeedFlowCount: 1,
    });

    expect(withWeakQuality).toBe(false);
  });

  it("clips carry alignment streak when recent execution confirmation is weak", () => {
    const confirmed = deriveConfirmedCarryAlignmentStreak({
      carry: { alignmentStreak: 4 },
      state: {
        fillHistory: [
          {
            outcome: "UP",
            side: "BUY",
            size: 10,
            price: 0.48,
            timestamp: 100,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
          },
          {
            outcome: "DOWN",
            side: "BUY",
            size: 10,
            price: 0.49,
            timestamp: 110,
            makerTaker: "taker",
            executionMode: "PAIRGROUP_COVERED_SEED",
          },
        ],
        mergeHistory: [
          {
            amount: 10,
            timestamp: 115,
            simulated: true,
            matchedUpCost: 4.8,
            matchedDownCost: 4.9,
            mergeReturn: 10,
            realizedPnl: 0.3,
            remainingUpShares: 0,
            remainingDownShares: 0,
          },
        ],
      },
      nowTs: 120,
      matchedInventoryQuality: 1,
      unlockedMatchedInventoryQuality: 1,
    });
    const weak = deriveConfirmedCarryAlignmentStreak({
      carry: { alignmentStreak: 4 },
      state: {
        fillHistory: [
          {
            outcome: "UP",
            side: "BUY",
            size: 10,
            price: 0.48,
            timestamp: 100,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
          },
        ],
        mergeHistory: [],
      },
      nowTs: 120,
      matchedInventoryQuality: 0.3,
      unlockedMatchedInventoryQuality: 0.2,
    });

    expect(confirmed).toBe(4);
    expect(weak).toBe(1);
  });

  it("raises flow confidence when the same overlap lineage gets side-aligned seed fills and merge confirmation", () => {
    const strongConfidence = deriveCarryFlowConfidence({
      carry: {
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "DOWN",
        protectedResidualSide: "UP",
        alignmentStreak: 3,
      },
      state: {
        fillHistory: [
          {
            outcome: "DOWN",
            side: "BUY",
            size: 10,
            price: 0.52,
            timestamp: 100,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
          },
          {
            outcome: "UP",
            side: "BUY",
            size: 9,
            price: 0.41,
            timestamp: 110,
            makerTaker: "taker",
            executionMode: "PAIRGROUP_COVERED_SEED",
          },
        ],
        mergeHistory: [
          {
            amount: 9,
            timestamp: 118,
            simulated: true,
          },
        ],
      },
      nowTs: 120,
      matchedInventoryQuality: 0.92,
      unlockedMatchedInventoryQuality: 1,
      recentSeedFlowCount: 2,
    });
    const weakConfidence = deriveCarryFlowConfidence({
      carry: {
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "DOWN",
        protectedResidualSide: "UP",
        alignmentStreak: 3,
      },
      state: {
        fillHistory: [
          {
            outcome: "UP",
            side: "BUY",
            size: 10,
            price: 0.48,
            timestamp: 100,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
          },
        ],
        mergeHistory: [],
      },
      nowTs: 120,
      matchedInventoryQuality: 0.4,
      unlockedMatchedInventoryQuality: 0.3,
      recentSeedFlowCount: 0,
    });

    expect(strongConfidence).toBeGreaterThan(weakConfidence);
    expect(strongConfidence).toBeGreaterThanOrEqual(1);
    expect(weakConfidence).toBeLessThan(0.82);
  });

  it("prefers same-lineage fills over unrelated recent flow when deriving carry confidence", () => {
    const sameLineage = deriveCarryFlowConfidence({
      carry: {
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "DOWN",
        protectedResidualSide: "UP",
        alignmentStreak: 3,
      },
      state: {
        fillHistory: [
          {
            outcome: "DOWN",
            side: "BUY",
            size: 10,
            price: 0.52,
            timestamp: 100,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
            flowLineage: "favor_independent_overlap|DOWN|UP",
          },
          {
            outcome: "UP",
            side: "BUY",
            size: 8,
            price: 0.41,
            timestamp: 110,
            makerTaker: "taker",
            executionMode: "PAIRGROUP_COVERED_SEED",
            flowLineage: "favor_independent_overlap|DOWN|UP",
          },
          {
            outcome: "UP",
            side: "BUY",
            size: 8,
            price: 0.41,
            timestamp: 112,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
            flowLineage: "favor_independent_overlap|UP|DOWN",
          },
        ],
        mergeHistory: [
          {
            amount: 8,
            timestamp: 118,
            simulated: true,
            flowLineage: "favor_independent_overlap|DOWN|UP",
          },
        ],
      },
      nowTs: 120,
      matchedInventoryQuality: 0.88,
      unlockedMatchedInventoryQuality: 1,
      recentSeedFlowCount: 2,
    });
    const mismatchedLineage = deriveCarryFlowConfidence({
      carry: {
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "DOWN",
        protectedResidualSide: "UP",
        alignmentStreak: 3,
      },
      state: {
        fillHistory: [
          {
            outcome: "UP",
            side: "BUY",
            size: 8,
            price: 0.41,
            timestamp: 112,
            makerTaker: "taker",
            executionMode: "TEMPORAL_SINGLE_LEG_SEED",
            flowLineage: "favor_independent_overlap|UP|DOWN",
          },
        ],
        mergeHistory: [],
      },
      nowTs: 120,
      matchedInventoryQuality: 0.88,
      unlockedMatchedInventoryQuality: 1,
      recentSeedFlowCount: 2,
    });

    expect(sameLineage).toBeGreaterThan(mismatchedLineage);
  });

  it("restores persisted carry when residual side and gap still support the same flow", () => {
    const restored = restorePersistedArbitrationCarry({
      snapshot: {
        createdAt: 100,
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "DOWN",
        protectedResidualSide: "UP",
        referenceShareGap: 8,
        alignmentStreak: 3,
        lastObservedAt: 115,
        lastProtectedShares: 7.5,
        expiresAt: 160,
        residualSeverityLevel: "small",
      },
      state: {
        upShares: 8,
        downShares: 1,
      },
      nowTs: 120,
      minResidualShares: 1,
    });

    expect(restored).toMatchObject({
      recommendation: "favor_independent_overlap",
      preferredSeedSide: "DOWN",
      protectedResidualSide: "UP",
      alignmentStreak: 3,
      lastProtectedShares: 7,
      residualSeverityLevel: "small",
    });
  });

  it("drops persisted carry when the residual side no longer matches the prior flow", () => {
    const restored = restorePersistedArbitrationCarry({
      snapshot: {
        createdAt: 100,
        recommendation: "favor_independent_overlap",
        preferredSeedSide: "DOWN",
        protectedResidualSide: "UP",
        referenceShareGap: 8,
        alignmentStreak: 3,
        lastObservedAt: 115,
        lastProtectedShares: 7.5,
        expiresAt: 160,
        residualSeverityLevel: "small",
      },
      state: {
        upShares: 1,
        downShares: 8,
      },
      nowTs: 120,
      minResidualShares: 1,
    });

    expect(restored).toBeUndefined();
  });

  it("lets strong flow confidence preserve overlap slightly below the default matched-inventory floor", () => {
    const config = buildConfig({
      REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP: "true",
      MAX_OPEN_GROUPS_PER_MARKET: "3",
      MAX_OPEN_PARTIAL_GROUPS: "2",
    });

    const withStrongConfidence = shouldPreserveCarryDrivenOverlap({
      config,
      carry: {
        recommendation: "favor_independent_overlap",
        expiresAt: 150,
        alignmentStreak: 3,
      },
      nowTs: 120,
      secsToClose: 240,
      protectedResidualShares: 1.5,
      completionActive: true,
      linkageHealthy: true,
      matchedInventoryTargetMet: false,
      matchedInventoryQuality: 0.52,
      carryFlowConfidence: 1.05,
      recentSeedFlowCount: 1,
    });

    expect(withStrongConfidence).toBe(true);
  });

});
