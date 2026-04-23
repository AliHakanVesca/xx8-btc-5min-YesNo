import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { runPaperSession } from "../../src/analytics/paperSession.js";
import { buildCanonicalReferenceFromPaperSession } from "../../src/analytics/xuanCanonicalReference.js";

describe("paper session replay", () => {
  const env = parseEnv({
    DRY_RUN: "true",
    POLY_STACK_MODE: "current-prod-v1",
  });

  it("runs the xuan-flow session with xuan-like overlap, high/low completion, and flat ending inventory", () => {
    const report = runPaperSession(env, "xuan-flow");
    const canonical = buildCanonicalReferenceFromPaperSession(report);

    expect(report.summary).toMatchObject({
      stepCount: 24,
      entryStepCount: 18,
      completionStepCount: 0,
      mergeStepCount: 4,
      totalBuyShares: 90,
      totalEntryBuyShares: 90,
      totalCompletionShares: 0,
      totalMergeShares: 45,
      finalUpShares: 0,
      finalDownShares: 0,
    });
    expect(report.summary.totalRawSpend).toBeCloseTo(41.65, 8);
    expect(report.summary.totalFeeUsd).toBeCloseTo(1.320228, 8);
    expect(report.summary.totalEffectiveSpend).toBeCloseTo(42.970228, 8);
    expect(report.summary.realizedMergeProfit).toBeCloseTo(2.029772, 8);
    expect(report.summary.roiPct).toBeCloseTo(4.7237, 4);
    expect(report.summary.footprint).toMatchObject({
      cycleCount: 4,
      cycleBucket: "4_plus",
      alternatingTransitionCount: 12,
      partialRepairLatencyBucket: "none",
      dominantResidualSide: "FLAT",
      residualMagnitudeBucket: "flat",
      clipBucketCounts: {
        "1_5": 18,
      },
    });

    expect(canonical).toMatchObject({
      cycleCount: 9,
      mergeCount: 4,
      completionCount: 9,
      overlapClipCount: 6,
      hasOverlap: true,
      repairLatencyBucket: "0_10",
      finalResidualSide: "FLAT",
      finalResidualBucket: "flat",
      normalizedClipTierCounts: {
        "0_5x": 0,
        "1x": 18,
      },
    });
    expect(canonical.orderedClipSequence.filter((event) => event.kind === "BUY")).toHaveLength(18);
    expect(canonical.orderedClipSequence.some((event) => event.phase === "HIGH_LOW_COMPLETION")).toBe(true);

    const openingSeed = report.steps.find((step) => step.name === "open-down-seed");
    expect(openingSeed?.execution.fills).toHaveLength(1);
    expect(openingSeed?.execution.fills[0]?.kind).toBe("entry");
    expect(openingSeed?.execution.fills[0]?.side).toBe("DOWN");
    expect(openingSeed?.execution.fills[0]?.size).toBe(5);
    expect(openingSeed?.execution.fills[0]?.price).toBeCloseTo(0.44, 8);
    expect(openingSeed?.execution.skippedEntrySides).toEqual(["UP"]);

    const highLowCompletion = report.steps.find((step) => step.name === "high-low-up-completion-1");
    expect(highLowCompletion?.execution.fills).toHaveLength(1);
    expect(highLowCompletion?.execution.fills[0]?.kind).toBe("entry");
    expect(highLowCompletion?.execution.fills[0]?.side).toBe("UP");
    expect(highLowCompletion?.execution.fills[0]?.size).toBe(5);
    expect(highLowCompletion?.execution.fills[0]?.price).toBeCloseTo(0.8, 8);

    const lastMerge = report.steps.find((step) => step.name === "merge-flush-3");
    expect(lastMerge?.execution.mergeShares).toBe(5);
    expect(lastMerge?.execution.realizedMergeProfit).toBeGreaterThan(0);
  });

  it("runs the blocked-completion session and finishes with residual inventory", () => {
    const report = runPaperSession(env, "blocked-completion");
    const canonical = buildCanonicalReferenceFromPaperSession(report);

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
    expect(canonical).toMatchObject({
      cycleCount: 2,
      mergeCount: 1,
      completionCount: 1,
      overlapClipCount: 1,
      hasOverlap: true,
      repairLatencyBucket: "0_10",
      finalResidualSide: "UP",
      finalResidualBucket: "small",
      normalizedClipTierCounts: {
        "1x": 3,
      },
    });

    const blockedStep = report.steps.find((step) => step.name === "expensive-completion-blocked");
    expect(blockedStep?.decision.hasCompletion).toBe(false);
    expect(blockedStep?.execution.mergeShares).toBe(0);
    expect(blockedStep?.stateAfter.upShares).toBe(5);
    expect(blockedStep?.stateAfter.downShares).toBe(0);
  });
});
