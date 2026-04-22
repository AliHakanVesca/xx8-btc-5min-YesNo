import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { runPaperSession } from "../../src/analytics/paperSession.js";

describe("paper session replay", () => {
  const env = parseEnv({
    DRY_RUN: "true",
    POLY_STACK_MODE: "current-prod-v1",
  });

  it("runs the xuan-flow session with merges, completion, and positive realized merge pnl", () => {
    const report = runPaperSession(env, "xuan-flow");

    expect(report.summary).toMatchObject({
      stepCount: 6,
      entryStepCount: 3,
      completionStepCount: 1,
      mergeStepCount: 3,
      totalEntryBuyShares: 25,
      totalCompletionShares: 5,
      totalMergeShares: 15,
      finalUpShares: 0,
      finalDownShares: 0,
    });
    expect(report.summary.totalRawSpend).toBeCloseTo(14.4, 8);
    expect(report.summary.totalFeeUsd).toBeCloseTo(0.539064, 8);
    expect(report.summary.totalEffectiveSpend).toBeCloseTo(14.939064, 8);
    expect(report.summary.realizedMergeProfit).toBeCloseTo(0.060936, 8);
    expect(report.summary.roiPct).toBeCloseTo(0.4079, 4);
    expect(report.summary.footprint).toMatchObject({
      cycleCount: 3,
      cycleBucket: "2_3",
      alternatingTransitionCount: 5,
      partialRepairLatencyBucket: "10_30",
      dominantResidualSide: "FLAT",
      residualMagnitudeBucket: "flat",
      clipBucketCounts: {
        "1_5": 6,
      },
    });

    const partialFillStep = report.steps.find((step) => step.name === "partial-up-fill");
    expect(partialFillStep?.execution.fills).toHaveLength(1);
    expect(partialFillStep?.execution.fills[0]).toMatchObject({
      kind: "entry",
      side: "UP",
      size: 5,
      price: 0.48,
    });

    const completionStep = report.steps.find((step) => step.name === "completion-rebalance");
    expect(completionStep?.execution.fills).toHaveLength(1);
    expect(completionStep?.execution.fills[0]).toMatchObject({
      kind: "completion",
      side: "DOWN",
      size: 5,
      price: 0.49,
    });
    expect(completionStep?.execution.mergeShares).toBe(5);
    expect(completionStep?.execution.realizedMergeProfit).toBeLessThan(0);
  });

  it("runs the blocked-completion session and finishes with residual inventory", () => {
    const report = runPaperSession(env, "blocked-completion");

    expect(report.summary).toMatchObject({
      stepCount: 5,
      entryStepCount: 2,
      completionStepCount: 0,
      mergeStepCount: 1,
      totalEntryBuyShares: 15,
      totalCompletionShares: 0,
      totalMergeShares: 5,
      finalUpShares: 5,
      finalDownShares: 0,
    });
    expect(report.summary.totalRawSpend).toBeCloseTo(7.2, 8);
    expect(report.summary.totalFeeUsd).toBeCloseTo(0.269568, 8);
    expect(report.summary.totalEffectiveSpend).toBeCloseTo(7.469568, 8);
    expect(report.summary.realizedMergeProfit).toBeCloseTo(0.020288, 8);
    expect(report.summary.footprint).toMatchObject({
      cycleCount: 1,
      cycleBucket: "1",
      dominantResidualSide: "UP",
      residualMagnitudeBucket: "small",
      partialRepairLatencyBucket: "none",
    });

    const blockedStep = report.steps.find((step) => step.name === "expensive-completion-blocked");
    expect(blockedStep?.decision.hasCompletion).toBe(false);
    expect(blockedStep?.execution.mergeShares).toBe(0);
    expect(blockedStep?.stateAfter.upShares).toBe(5);
    expect(blockedStep?.stateAfter.downShares).toBe(0);
  });
});
