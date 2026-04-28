import { describe, expect, it } from "vitest";
import {
  buildLivePaperSample,
  buildLivePaperTick,
  computeXuanLivePaperBehaviorMetrics,
  scoreXuanConformance,
  summarizeLivePaperSamples,
  type LivePaperOrderExecution,
} from "../../src/analytics/livePaper.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { createMergeBatchTracker } from "../../src/strategy/xuan5m/mergeCoordinator.js";

function buildBook(assetId: string, market: string, bid: number, ask: number, timestamp: number) {
  return {
    market,
    assetId,
    timestamp,
    bids: [{ price: bid, size: 180 }],
    asks: [{ price: ask, size: 180 }],
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
  };
}

function buildExecution(
  timestamp: number,
  outcome: "UP" | "DOWN",
  kind: LivePaperOrderExecution["kind"],
  mode: LivePaperOrderExecution["mode"],
  reason: string,
  pairCostWithFees?: number,
): LivePaperOrderExecution {
  return {
    timestamp,
    kind,
    status: "filled",
    outcome,
    tradeSide: "BUY",
    requestedShares: 80,
    filledShares: 80,
    averagePrice: 0.48,
    limitPrice: 0.48,
    rawNotional: 38.4,
    feeUsd: 1,
    effectiveNotional: 39.4,
    fullyFilled: true,
    reason,
    orderType: "FAK",
    order: {
      tokenId: outcome,
      side: "BUY",
      amount: 38.4,
      shareTarget: 80,
      price: 0.48,
      orderType: "FAK",
    },
    consumedLevels: [{ price: 0.48, size: 80 }],
    ...(mode !== undefined ? { mode } : {}),
    ...(pairCostWithFees !== undefined ? { pairCostWithFees } : {}),
  };
}

describe("live paper analytics", () => {
  it("caps xuan conformance below PASS when fill count is below the xuan minimum", () => {
    const scored = scoreXuanConformance({
      rawScore: 80,
      fillCount: 2,
      minFillCountForPass: 3,
      mergedQty: 31.9,
      mergeRealizedPnl: 0.2,
      requireProfit: true,
      pairedContinuationCount: 1,
      independentFlowCount: 1,
      requirePairedContinuation: true,
      firstFillSec: 0,
      completionSec: 1,
      imbalanceShares: 0,
      residualShares: 0.02,
    });

    expect(scored.score).toBe(74);
    expect(scored.status).toBe("WARN");
    expect(scored.blockers).toContain("insufficient_fill_count");
  });

  it("allows xuan PASS only when merge, fill count, continuation, profit, timing, and residual blockers are clear", () => {
    const scored = scoreXuanConformance({
      rawScore: 80,
      fillCount: 3,
      minFillCountForPass: 3,
      mergedQty: 31.9,
      mergeRealizedPnl: 0.01,
      requireProfit: true,
      pairedContinuationCount: 1,
      independentFlowCount: 1,
      requirePairedContinuation: true,
      firstFillSec: 0,
      completionSec: 1,
      imbalanceShares: 0,
      residualShares: 0.02,
    });

    expect(scored.score).toBe(80);
    expect(scored.status).toBe("PASS");
    expect(scored.blockers).toEqual([]);
  });

  it("treats negative merge pnl as a xuan-strict blocker", () => {
    const scored = scoreXuanConformance({
      rawScore: 90,
      fillCount: 4,
      minFillCountForPass: 3,
      mergedQty: 31.9,
      mergeRealizedPnl: -0.01,
      requireProfit: true,
      pairedContinuationCount: 1,
      independentFlowCount: 1,
      requirePairedContinuation: true,
      firstFillSec: 0,
      completionSec: 20,
      imbalanceShares: 0,
      residualShares: 0.02,
      negativeMergePnlCount: 1,
    });

    expect(scored.score).toBe(74);
    expect(scored.status).toBe("FAIL");
    expect(scored.blockers).toContain("negative_merge_pnl");
    expect(scored.economicsWarnings).toContain("negative_merge_pnl");
  });

  it("blocks xuan PASS for high-cost seeds and unclosed late seeds", () => {
    const scored = scoreXuanConformance({
      rawScore: 90,
      fillCount: 5,
      minFillCountForPass: 3,
      mergedQty: 50,
      mergeRealizedPnl: 0.2,
      requireProfit: true,
      pairedContinuationCount: 1,
      independentFlowCount: 1,
      requirePairedContinuation: true,
      firstFillSec: 0,
      completionSec: 20,
      imbalanceShares: 0,
      residualShares: 0.02,
      highCostSeedCount: 1,
      lateSeedUnclosedCount: 1,
    });

    expect(scored.score).toBe(74);
    expect(scored.status).toBe("FAIL");
    expect(scored.blockers).toEqual(expect.arrayContaining(["high_cost_seed", "late_seed_unclosed"]));
  });

  it("blocks xuan-strict PASS when staged opposite release timing misses the 20-35s band", () => {
    const scored = scoreXuanConformance({
      rawScore: 90,
      fillCount: 5,
      minFillCountForPass: 3,
      mergedQty: 80,
      mergeRealizedPnl: 0.2,
      requireProfit: true,
      pairedContinuationCount: 1,
      independentFlowCount: 1,
      requirePairedContinuation: true,
      firstFillSec: 4,
      completionSec: 50,
      imbalanceShares: 0,
      residualShares: 0.02,
      stagedOppositeReleaseRate: 0.5,
      plannedOppositeMissedDeadlineCount: 1,
      oppositeLegGapMedianSec: 61,
      firstCycleOppositeGapSec: 61,
    });

    expect(scored.score).toBe(74);
    expect(scored.status).toBe("FAIL");
    expect(scored.blockers).toEqual(
      expect.arrayContaining([
        "opposite_leg_gap_too_long",
        "first_cycle_opposite_gap_too_long",
        "staged_opposite_release_low",
        "planned_opposite_deadline_missed",
      ]),
    );
  });

  it("fails xuan-strict conformance for open planned opposite and normal 5 qty micro re-entry", () => {
    const scored = scoreXuanConformance({
      rawScore: 90,
      fillCount: 5,
      minFillCountForPass: 3,
      mergedQty: 80,
      mergeRealizedPnl: 0.2,
      requireProfit: true,
      pairedContinuationCount: 1,
      independentFlowCount: 1,
      requirePairedContinuation: true,
      firstFillSec: 4,
      completionSec: 30,
      imbalanceShares: 0,
      residualShares: 0.02,
      stagedOppositeReleaseRate: 1,
      plannedOppositeMissedDeadlineCount: 0,
      materialOpenOppositeCount: 1,
      materialOpenPlannedOppositeQty: 80,
      normalMicroReentryCount: 1,
    });

    expect(scored.score).toBe(74);
    expect(scored.status).toBe("FAIL");
    expect(scored.blockers).toEqual(
      expect.arrayContaining(["material_open_planned_opposite", "normal_micro_reentry"]),
    );
  });

  it("does not count split completions as real xuan continuation for PASS", () => {
    const scored = scoreXuanConformance({
      rawScore: 90,
      fillCount: 3,
      minFillCountForPass: 3,
      mergedQty: 31.9,
      mergeRealizedPnl: 0.02,
      requireProfit: true,
      pairedContinuationCount: 0,
      independentFlowCount: 0,
      requirePairedContinuation: true,
      firstFillSec: 0,
      completionSec: 20,
      imbalanceShares: 0,
      residualShares: 0.02,
    });

    expect(scored.score).toBe(74);
    expect(scored.status).toBe("WARN");
    expect(scored.blockers).toEqual(
      expect.arrayContaining(["missing_paired_continuation", "insufficient_independent_flow"]),
    );
  });

  it("counts delayed opposite releases as xuan staged continuation", () => {
    const metrics = computeXuanLivePaperBehaviorMetrics([
      buildExecution(100, "DOWN", "entry", "PAIRGROUP_COVERED_SEED", "balanced_pair_seed"),
      buildExecution(125, "UP", "completion", "PARTIAL_SOFT_COMPLETION", "hard", 0.98),
      buildExecution(150, "DOWN", "entry", "PARTIAL_SOFT_COMPLETION", "lagging_rebalance", 0.97),
      buildExecution(151, "UP", "entry", "PARTIAL_FAST_COMPLETION", "lagging_rebalance", 0.96),
    ]);

    expect(metrics.stagedOppositeSeedCount).toBe(1);
    expect(metrics.stagedOppositeReleaseCount).toBe(2);
    expect(metrics.stagedOppositeReleaseRate).toBe(1);
    expect(metrics.firstCycleOppositeGapSec).toBe(25);
    expect(metrics.pairedContinuationCount).toBe(2);
    expect(metrics.independentFlowCount).toBe(2);
    expect(metrics.debtReducingContinuationCount).toBe(2);
    expect(metrics.normalMicroReentryCount).toBe(0);
  });

  it("builds a live paper sample with entry-buy-first decision when books are fresh", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    });
    const market = buildOfflineMarket(1713696000);
    const nowTs = market.startTs + 20;
    const sample = buildLivePaperSample({
      env,
      market,
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(sample.hasBooks).toBe(true);
    expect(sample.allowNewEntries).toBe(true);
    expect(sample.entryBuyCount).toBe(2);
    expect(sample.balancedPairEntryCount).toBe(2);
    expect(sample.laggingRebalanceCount).toBe(0);
    expect(sample.buyShares).toBe(10);
    expect(sample.buyNotional).toBeCloseTo(4.8, 8);
    expect(sample.mergeShares).toBe(5);
    expect(sample.pairTakerCost).toBeLessThan(1);
  });

  it("summarizes live paper samples", () => {
    const summary = summarizeLivePaperSamples({
      marketSlug: "btc-updown-5m-1713696000",
      configuredDurationSec: 20,
      startedAt: 1713696000,
      endedAt: 1713696018,
      samples: [
        {
          timestamp: 1713696005,
          phase: "ENTRY",
          secsToClose: 295,
          hasBooks: true,
          entryBuyCount: 2,
          balancedPairEntryCount: 2,
          laggingRebalanceCount: 0,
          buyShares: 40,
          buyNotional: 19.2,
          hasCompletion: false,
          hasUnwind: false,
          mergeShares: 20,
          allowNewEntries: true,
          completionOnly: false,
          hardCancel: false,
          riskReasons: [],
          pairAskSum: 0.96,
          pairTakerCost: 0.9959424,
          pairEdge: 0.0040576,
        },
        {
          timestamp: 1713696015,
          phase: "HARD_CANCEL",
          secsToClose: 8,
          hasBooks: true,
          entryBuyCount: 0,
          balancedPairEntryCount: 0,
          laggingRebalanceCount: 0,
          buyShares: 0,
          buyNotional: 0,
          hasCompletion: false,
          hasUnwind: false,
          mergeShares: 0,
          allowNewEntries: false,
          completionOnly: true,
          hardCancel: true,
          riskReasons: [],
          pairAskSum: 1,
          pairTakerCost: 1.036,
          pairEdge: -0.036,
        },
      ],
    });

    expect(summary).toMatchObject({
      marketSlug: "btc-updown-5m-1713696000",
      sampleCount: 2,
      samplesWithBooks: 2,
      entryBuyReadyCount: 1,
      balancedPairReadyCount: 1,
      laggingRebalanceReadyCount: 0,
      completionOnlyCount: 1,
      hardCancelCount: 1,
      averageBuyShares: 20,
      averageBuyNotional: 9.6,
    });
    expect(summary.bestPairEdge).toBeCloseTo(0.0040576, 8);
    expect(summary.worstPairEdge).toBeCloseTo(-0.036, 8);
  });

  it("does not mark preopen next-market books as entry-ready", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    });
    const market = buildOfflineMarket(1713696300);
    const nowTs = market.startTs - 20;
    const sample = buildLivePaperSample({
      env,
      market,
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(sample.phase).toBe("PREOPEN");
    expect(sample.entryBuyCount).toBe(0);
    expect(sample.allowNewEntries).toBe(false);
    expect(sample.hardCancel).toBe(true);
    expect(sample.riskReasons).toEqual(["preopen"]);
  });

  it("applies simulated live-paper fills to state without sending orders", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
    });
    const config = buildStrategyConfig(env);
    const market = buildOfflineMarket(1713696000);
    const nowTs = market.startTs + 20;
    const tick = buildLivePaperTick({
      config,
      market,
      state: createMarketState(market),
      mergeTracker: createMergeBatchTracker(),
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(tick.executions).toHaveLength(2);
    expect(tick.executions.every((execution) => execution.status === "filled")).toBe(true);
    expect(tick.sample.simulatedFillCount).toBe(2);
    expect(tick.sample.simulatedBuyShares).toBe(10);
    expect(tick.stateAfter.upShares).toBe(5);
    expect(tick.stateAfter.downShares).toBe(5);
    expect(tick.merge?.status).toBe("skipped");
  });

  it("records simulated merge when the configured merge gate allows it", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      MERGE_BATCH_MODE: "IMMEDIATE",
      MERGE_DUST_LEAVE_SHARES: "0",
    });
    const config = buildStrategyConfig(env);
    const market = buildOfflineMarket(1713696000);
    const nowTs = market.startTs + 20;
    const tick = buildLivePaperTick({
      config,
      market,
      state: createMarketState(market),
      mergeTracker: createMergeBatchTracker(),
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(tick.merge).toMatchObject({ status: "merged", mergedShares: 5 });
    expect(tick.sample.simulatedMergeShares).toBe(5);
    expect(tick.stateAfter.upShares).toBe(0);
    expect(tick.stateAfter.downShares).toBe(0);
    expect(tick.stateAfter.mergeCount).toBe(1);
  });
});
