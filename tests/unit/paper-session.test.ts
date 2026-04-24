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
      stepCount: 25,
      entryStepCount: 12,
      completionStepCount: 0,
      mergeStepCount: 3,
      totalBuyShares: 60.275,
      totalEntryBuyShares: 60.275,
      totalCompletionShares: 0,
      totalMergeShares: 30,
      totalRedeemShares: 0.275,
      finalUpShares: 0,
      finalDownShares: 0,
    });
    expect(report.summary.totalRawSpend).toBeCloseTo(27.51725, 8);
    expect(report.summary.totalFeeUsd).toBeCloseTo(0.95800482, 8);
    expect(report.summary.totalEffectiveSpend).toBeCloseTo(28.47525482, 8);
    expect(report.summary.realizedMergeProfit).toBeCloseTo(1.74528, 8);
    expect(report.summary.roiPct).toBeCloseTo(6.1291, 4);
    expect(report.summary.footprint).toMatchObject({
      cycleCount: 3,
      cycleBucket: "2_3",
      alternatingTransitionCount: 9,
      partialRepairLatencyBucket: "none",
      dominantResidualSide: "FLAT",
      residualMagnitudeBucket: "flat",
      clipBucketCounts: {
        "1_5": 11,
        "6_10": 1,
      },
    });

    expect(canonical).toMatchObject({
      cycleCount: 6,
      mergeCount: 3,
      redeemCount: 1,
      completionCount: 6,
      overlapClipCount: 4,
      hasOverlap: true,
      repairLatencyBucket: "0_10",
      finalResidualSide: "FLAT",
      finalResidualBucket: "flat",
      normalizedClipTierCounts: {
        "0_5x": 0,
        "1x": 12,
      },
    });
    expect(canonical.orderedClipSequence.filter((event) => event.kind === "BUY")).toHaveLength(12);
    expect(canonical.orderedClipSequence.some((event) => event.phase === "HIGH_LOW_COMPLETION")).toBe(true);

    const openingSeed = report.steps.find((step) => step.name === "open-down-seed");
    expect(openingSeed?.execution.fills).toHaveLength(1);
    expect(openingSeed?.execution.fills[0]?.kind).toBe("entry");
    expect(openingSeed?.execution.fills[0]?.side).toBe("DOWN");
    expect(openingSeed?.execution.fills[0]?.size).toBe(5);
    expect(openingSeed?.execution.fills[0]?.price).toBeCloseTo(0.44, 8);
    expect(openingSeed?.execution.skippedEntrySides).toEqual(["UP"]);

    const highLowCompletion = report.steps.find((step) => step.name === "high-low-up-completion-3");
    expect(highLowCompletion?.execution.fills).toHaveLength(1);
    expect(highLowCompletion?.execution.fills[0]?.kind).toBe("entry");
    expect(highLowCompletion?.execution.fills[0]?.side).toBe("UP");
    expect(highLowCompletion?.execution.fills[0]?.size).toBeCloseTo(5.275, 8);
    expect(highLowCompletion?.execution.fills[0]?.price).toBeCloseTo(0.79, 8);

    const residualRedeem = report.steps.find((step) => step.execution.redeemShares > 0);
    expect(residualRedeem?.execution.redeemShares).toBeCloseTo(0.275, 8);
    expect(residualRedeem?.execution.redeemSide).toBe("UP");
  });

  it("calibrates scripted completion opportunities while preserving the guarded cycle count", () => {
    const report = runPaperSession(env, "xuan-flow", {
      completionPatienceMultiplier: 0.45,
    });
    const completionStep = report.steps.find((step) => step.name === "patient-up-completion");

    expect(report.summary.stepCount).toBe(25);
    expect(buildCanonicalReferenceFromPaperSession(report).cycleCount).toBe(6);
    expect(completionStep?.timestamp).toBe(report.market.startTs + 103);
  });

  it("can replay partial pair fills using the bot's order-priority side", () => {
    const report = runPaperSession(env, "xuan-flow", {
      orderPriorityAwareFill: true,
    });
    const openingSeed = report.steps.find((step) => step.name === "open-down-seed");
    const secondCycleSeed = report.steps.find((step) => step.name === "overlap-up-seed-1");

    expect(openingSeed?.execution.fills).toHaveLength(1);
    expect(openingSeed?.execution.fills[0]?.side).toBe("UP");
    expect(openingSeed?.execution.skippedEntrySides).toEqual(["DOWN"]);
    expect(secondCycleSeed?.execution.fills).toHaveLength(1);
    expect(secondCycleSeed?.execution.fills[0]?.side).toBe("DOWN");
    expect(secondCycleSeed?.execution.skippedEntrySides).toEqual(["UP"]);
  });

  it("can apply conservative overlap seed cadence compression without changing the buy count", () => {
    const report = runPaperSession(env, "xuan-flow", {
      completionPatienceMultiplier: 0.63,
      overlapSeedOffsetShiftSec: 2,
    });
    const canonical = buildCanonicalReferenceFromPaperSession(report);
    const secondCycleSeed = report.steps.find((step) => step.name === "overlap-up-seed-1");

    expect(secondCycleSeed?.timestamp).toBe(report.market.startTs + 24);
    expect(canonical.orderedClipSequence.filter((event) => event.kind === "BUY")).toHaveLength(12);
    expect(canonical.redeemCount).toBe(1);
  });

  it("can compress intermediate forced merge flushes into a later lifecycle cohort", () => {
    const report = runPaperSession(env, "xuan-flow", {
      completionPatienceMultiplier: 0.63,
      mergeCohortCompression: true,
    });
    const canonical = buildCanonicalReferenceFromPaperSession(report);
    const mergeOffsets = canonical.orderedClipSequence
      .filter((event) => event.kind === "MERGE")
      .map((event) => event.tOffsetSec);

    expect(canonical.mergeCount).toBe(2);
    expect(new Set(mergeOffsets)).toEqual(new Set([86, 280]));
    expect(canonical.finalResidualBucket).toBe("flat");
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
      overlapClipCount: 0,
      hasOverlap: false,
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
