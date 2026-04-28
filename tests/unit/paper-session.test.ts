import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { runPaperSession } from "../../src/analytics/paperSession.js";
import { buildCanonicalReferenceFromPaperSession } from "../../src/analytics/xuanCanonicalReference.js";
import { exact1776253500Reference } from "../../src/analytics/xuanExactReference.js";

describe("paper session replay", () => {
  const env = parseEnv({
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
  });

  it("runs the xuan-flow session with early overlap, late-seed cutoff, and flat ending inventory", () => {
    const report = runPaperSession(env, "xuan-flow");
    const canonical = buildCanonicalReferenceFromPaperSession(report);

    expect(report.summary).toMatchObject({
      stepCount: 25,
      entryStepCount: 10,
      completionStepCount: 0,
      mergeStepCount: 2,
      totalBuyShares: 50,
      totalEntryBuyShares: 50,
      totalCompletionShares: 0,
      totalMergeShares: 25,
      totalRedeemShares: 0,
      finalUpShares: 0,
      finalDownShares: 0,
    });
    expect(report.summary.totalRawSpend).toBeCloseTo(22.65, 8);
    expect(report.summary.totalFeeUsd).toBeCloseTo(0.851652, 8);
    expect(report.summary.totalEffectiveSpend).toBeCloseTo(23.501652, 8);
    expect(report.summary.realizedMergeProfit).toBeCloseTo(1.498348, 8);
    expect(report.summary.roiPct).toBeCloseTo(6.3755, 4);
    expect(report.summary.footprint).toMatchObject({
      cycleCount: 2,
      cycleBucket: "2_3",
      alternatingTransitionCount: 7,
      partialRepairLatencyBucket: "none",
      dominantResidualSide: "FLAT",
      residualMagnitudeBucket: "flat",
      clipBucketCounts: {
        "1_5": 10,
        "6_10": 0,
      },
    });

    expect(canonical).toMatchObject({
      cycleCount: 5,
      mergeCount: 2,
      redeemCount: 0,
      completionCount: 5,
      overlapClipCount: 4,
      hasOverlap: true,
      repairLatencyBucket: "0_10",
      finalResidualSide: "FLAT",
      finalResidualBucket: "flat",
      normalizedClipTierCounts: {
        "0_5x": 0,
        "1x": 10,
      },
    });
    expect(canonical.orderedClipSequence.filter((event) => event.kind === "BUY")).toHaveLength(10);
    expect(canonical.orderedClipSequence.some((event) => event.phase === "HIGH_LOW_COMPLETION")).toBe(false);

    const openingSeed = report.steps.find((step) => step.name === "open-down-seed");
    expect(openingSeed?.execution.fills).toHaveLength(1);
    expect(openingSeed?.execution.fills[0]?.kind).toBe("entry");
    expect(openingSeed?.execution.fills[0]?.side).toBe("DOWN");
    expect(openingSeed?.execution.fills[0]?.size).toBe(5);
    expect(openingSeed?.execution.fills[0]?.price).toBeCloseTo(0.44, 8);
    expect(openingSeed?.execution.skippedEntrySides).toEqual(["UP"]);

    const highLowCompletion = report.steps.find((step) => step.name === "high-low-up-completion-3");
    expect(highLowCompletion?.execution.fills).toHaveLength(0);
    expect(highLowCompletion?.decision.entryTrace?.skipReason).toBe("late_fresh_seed_cutoff");
    expect(report.steps.some((step) => step.execution.redeemShares > 0)).toBe(false);
  });

  it("calibrates scripted completion opportunities while preserving the guarded cycle count", () => {
    const report = runPaperSession(env, "xuan-flow", {
      completionPatienceMultiplier: 0.45,
    });
    const completionStep = report.steps.find((step) => step.name === "patient-up-completion");

    expect(report.summary.stepCount).toBe(25);
    expect(buildCanonicalReferenceFromPaperSession(report).cycleCount).toBe(5);
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
    expect(canonical.orderedClipSequence.filter((event) => event.kind === "BUY")).toHaveLength(10);
    expect(canonical.redeemCount).toBe(0);
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

  it("replays the economically filtered strict xuan reference sequence in aggressive clone mode", () => {
    const aggressiveEnv = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
    });
    const report = runPaperSession(aggressiveEnv, "xuan-flow", {
      marketStartTs: exact1776253500Reference.startTs,
      referenceFlow: exact1776253500Reference,
    });
    const canonical = buildCanonicalReferenceFromPaperSession(report);
    const candidateBuys = canonical.orderedClipSequence.filter((event) => event.kind === "BUY");

    expect(candidateBuys.map((event) => event.outcome)).toEqual([
      "DOWN",
      "UP",
      "UP",
      "DOWN",
      "UP",
      "DOWN",
      "DOWN",
      "UP",
    ]);
    expect(candidateBuys.map((event) => event.phase)).toEqual([
      "ENTRY",
      "COMPLETION",
      "OVERLAP",
      "OVERLAP",
      "COMPLETION",
      "OVERLAP",
      "OVERLAP",
      "COMPLETION",
    ]);
    expect(candidateBuys.map((event) => event.tOffsetSec)).toEqual([4, 6, 10, 20, 42, 60, 86, 88]);
    expect(candidateBuys[2]?.qty).toBe(20);
  });

  it("runs the blocked-completion session and finishes with residual inventory", () => {
    const report = runPaperSession(env, "blocked-completion");
    const canonical = buildCanonicalReferenceFromPaperSession(report);

    expect(report.summary).toMatchObject({
      stepCount: 5,
      entryStepCount: 1,
      completionStepCount: 0,
      mergeStepCount: 1,
      totalEntryBuyShares: 10,
      totalCompletionShares: 0,
      totalMergeShares: 5,
      finalUpShares: 0,
      finalDownShares: 0,
    });
    expect(report.summary.totalRawSpend).toBeCloseTo(4.8, 8);
    expect(report.summary.totalFeeUsd).toBeCloseTo(0.179712, 8);
    expect(report.summary.totalEffectiveSpend).toBeCloseTo(4.979712, 8);
    expect(report.summary.realizedMergeProfit).toBeCloseTo(0.020288, 8);
    expect(report.summary.footprint).toMatchObject({
      cycleCount: 1,
      cycleBucket: "1",
      dominantResidualSide: "FLAT",
      residualMagnitudeBucket: "flat",
      partialRepairLatencyBucket: "none",
    });
    expect(canonical).toMatchObject({
      cycleCount: 1,
      mergeCount: 1,
      completionCount: 1,
      overlapClipCount: 0,
      hasOverlap: false,
      repairLatencyBucket: "0_10",
      finalResidualSide: "FLAT",
      finalResidualBucket: "flat",
      normalizedClipTierCounts: {
        "1x": 2,
      },
    });

    const blockedStep = report.steps.find((step) => step.name === "expensive-completion-blocked");
    expect(blockedStep?.decision.hasCompletion).toBe(false);
    expect(blockedStep?.execution.mergeShares).toBe(0);
    expect(blockedStep?.decision.entryTrace?.skipReason).toBe("late_fresh_seed_cutoff");
    expect(blockedStep?.stateAfter.upShares).toBe(0);
    expect(blockedStep?.stateAfter.downShares).toBe(0);
  });
});
