import { describe, expect, it } from "vitest";
import {
  buildComparisonFlowSummary,
  buildFlowCalibrationSummary,
  classifyComparisonFlowSummary,
  compareCanonicalReference,
} from "../../src/analytics/xuanReplayComparator.js";
import type {
  CanonicalReferenceExtract,
  CanonicalSequenceEvent,
  NormalizedClipTier,
} from "../../src/analytics/xuanCanonicalReference.js";
import {
  exact1776248100Reference,
  exact1776253500Reference,
  exact1776928800Reference,
} from "../../src/analytics/xuanExactReference.js";
import publicSequenceFixture from "../fixtures/xuan_public_sequence_bundle.json" with { type: "json" };
import runtimeIncidentFixture from "../fixtures/runtime_extract_btc-updown-5m-1776928800.json" with { type: "json" };

function buildEvent(overrides: Partial<CanonicalSequenceEvent>): CanonicalSequenceEvent {
  return {
    sequenceIndex: 0,
    clipIndex: null,
    cycleId: 1,
    phase: "ENTRY",
    kind: "BUY",
    tOffsetSec: 0,
    tOffsetMs: 0,
    outcome: "DOWN",
    price: 0.5,
    qty: 5,
    qtyBucket: "1_5",
    baseLot: 5,
    normalizedClipTier: "1x",
    familyLabel: "ENTRY",
    internalLabel: "ENTRY",
    ...overrides,
  };
}

function normalizedCounts(
  overrides?: Partial<Record<NormalizedClipTier, number>>,
): Record<NormalizedClipTier, number> {
  return {
    "0_5x": 0,
    "1x": 0,
    "2x": 0,
    "3x": 0,
    "4x_plus": 0,
    ...overrides,
  };
}

function buildReference(overrides?: Partial<CanonicalReferenceExtract>): CanonicalReferenceExtract {
  return {
    slug: "btc-updown-5m-1776253500",
    startTs: 1776253500,
    endTs: 1776253800,
    orderedClipSequence: [
      buildEvent({
        sequenceIndex: 0,
        clipIndex: 1,
        cycleId: 1,
        phase: "ENTRY",
        kind: "BUY",
        tOffsetSec: 4,
        tOffsetMs: 4000,
        outcome: "DOWN",
        price: 0.53,
        qty: 5,
        qtyBucket: "1_5",
        familyLabel: "ENTRY",
        internalLabel: "ENTRY",
      }),
      buildEvent({
        sequenceIndex: 1,
        clipIndex: 2,
        cycleId: 1,
        phase: "COMPLETION",
        kind: "BUY",
        tOffsetSec: 6,
        tOffsetMs: 6000,
        outcome: "UP",
        price: 0.48,
        qty: 5,
        qtyBucket: "1_5",
        familyLabel: "COMPLETION",
        internalLabel: "COMPLETION",
      }),
      buildEvent({
        sequenceIndex: 2,
        clipIndex: null,
        cycleId: 1,
        phase: "MERGE",
        kind: "MERGE",
        tOffsetSec: 10,
        tOffsetMs: 10000,
        outcome: null,
        price: null,
        qty: 5,
        qtyBucket: "1_5",
        baseLot: 5,
        normalizedClipTier: "1x",
        familyLabel: "MERGE",
        internalLabel: "MERGE",
      }),
    ],
    cycleCount: 1,
    mergeCount: 1,
    redeemCount: 0,
    completionCount: 1,
    overlapClipCount: 0,
    hasOverlap: false,
    repairLatencyBucket: "0_10",
    mergeTimingBucket: "0_10",
    finalResidualSide: "FLAT",
    finalResidualBucket: "flat",
    clipBucketCounts: {
      "1_5": 2,
      "6_10": 0,
      "11_15": 0,
      "16_30": 0,
      "31_plus": 0,
    },
    normalizedClipTierCounts: normalizedCounts({
      "1x": 2,
    }),
    buySequence: ["DOWN", "UP"],
    alternatingTransitionCount: 1,
    authority: {
      tradeTape: "json_verified_by_activity",
      lifecycle: "sqlite_activity",
      wallet: "0xcfb",
      verifiedBuyCount: 2,
      totalBuyCount: 2,
      mergeEventCount: 1,
      redeemEventCount: 0,
    },
    ...overrides,
  };
}

describe("xuan replay comparator", () => {
  it("returns PASS for a near-identical canonical footprint", () => {
    const reference = buildReference();
    const candidate = buildReference({
      slug: "candidate-market",
    });

    const result = compareCanonicalReference(reference, candidate);

    expect(result.verdict).toBe("PASS");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.hardFailTotal).toBe(0);
  });

  it("returns WARN for medium similarity without hard fails", () => {
    const reference = buildReference();
    const candidate = buildReference({
      slug: "candidate-market",
      cycleCount: 2,
      mergeCount: 1,
      completionCount: 1,
      repairLatencyBucket: "10_30",
      finalResidualSide: "FLAT",
      finalResidualBucket: "dust",
      clipBucketCounts: {
        "1_5": 1,
        "6_10": 1,
        "11_15": 0,
        "16_30": 0,
        "31_plus": 0,
      },
      normalizedClipTierCounts: normalizedCounts({
        "1x": 1,
        "2x": 1,
      }),
      buySequence: ["DOWN", "DOWN", "UP"],
      alternatingTransitionCount: 1,
      overlapClipCount: 0,
      hasOverlap: false,
      orderedClipSequence: [
        buildEvent({
          sequenceIndex: 0,
          clipIndex: 1,
          cycleId: 1,
          phase: "ENTRY",
          kind: "BUY",
          tOffsetSec: 4,
          tOffsetMs: 4000,
          outcome: "DOWN",
          price: 0.53,
          qty: 5,
          qtyBucket: "1_5",
          normalizedClipTier: "1x",
          familyLabel: "ENTRY",
          internalLabel: "ENTRY",
        }),
        buildEvent({
          sequenceIndex: 1,
          clipIndex: 2,
          cycleId: 1,
          phase: "ENTRY",
          kind: "BUY",
          tOffsetSec: 8,
          tOffsetMs: 8000,
          outcome: "DOWN",
          price: 0.52,
          qty: 6,
          qtyBucket: "6_10",
          normalizedClipTier: "2x",
          familyLabel: "ENTRY",
          internalLabel: "ENTRY",
        }),
        buildEvent({
          sequenceIndex: 2,
          clipIndex: 3,
          cycleId: 1,
          phase: "COMPLETION",
          kind: "BUY",
          tOffsetSec: 20,
          tOffsetMs: 20000,
          outcome: "UP",
          price: 0.48,
          qty: 5,
          qtyBucket: "1_5",
          normalizedClipTier: "1x",
          familyLabel: "COMPLETION",
          internalLabel: "COMPLETION",
        }),
        buildEvent({
          sequenceIndex: 3,
          clipIndex: null,
          cycleId: 1,
          phase: "MERGE",
          kind: "MERGE",
          tOffsetSec: 28,
          tOffsetMs: 28000,
          outcome: null,
          price: null,
          qty: 5,
          qtyBucket: "1_5",
          baseLot: 5,
          normalizedClipTier: "1x",
          familyLabel: "MERGE",
          internalLabel: "MERGE",
        }),
      ],
    });

    const result = compareCanonicalReference(reference, candidate);

    expect(result.verdict).toBe("WARN");
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(result.score).toBeLessThan(80);
    expect(result.hardFailTotal).toBe(0);
  });

  it("returns FAIL when any hard fail is present", () => {
    const reference = buildReference();
    const candidate = buildReference({
      slug: "candidate-market",
    });

    const result = compareCanonicalReference(reference, candidate, {
      hardFails: {
        overshoot: 1,
      },
    });

    expect(result.verdict).toBe("FAIL");
    expect(result.hardFailTotal).toBe(1);
    expect(result.hardFails.overshoot).toBe(1);
  });

  it("scores flow lineage shape, active-flow peak, and completion latency", () => {
    const reference = buildReference({
      orderedClipSequence: [
        buildEvent({ sequenceIndex: 0, clipIndex: 1, cycleId: 1, phase: "ENTRY", tOffsetSec: 4, tOffsetMs: 4000 }),
        buildEvent({
          sequenceIndex: 1,
          clipIndex: 2,
          cycleId: 2,
          phase: "OVERLAP",
          tOffsetSec: 8,
          tOffsetMs: 8000,
          outcome: "UP",
        }),
        buildEvent({
          sequenceIndex: 2,
          clipIndex: 3,
          cycleId: 1,
          phase: "COMPLETION",
          tOffsetSec: 14,
          tOffsetMs: 14000,
          outcome: "UP",
        }),
        buildEvent({
          sequenceIndex: 3,
          clipIndex: 4,
          cycleId: 2,
          phase: "COMPLETION",
          tOffsetSec: 18,
          tOffsetMs: 18000,
          outcome: "DOWN",
        }),
      ],
      cycleCount: 2,
      completionCount: 2,
      overlapClipCount: 1,
      hasOverlap: true,
      buySequence: ["DOWN", "UP", "UP", "DOWN"],
      alternatingTransitionCount: 2,
    });
    const collapsedCandidate = buildReference({
      slug: "candidate-market",
      orderedClipSequence: [
        buildEvent({ sequenceIndex: 0, clipIndex: 1, cycleId: 1, phase: "ENTRY", tOffsetSec: 4, tOffsetMs: 4000 }),
        buildEvent({
          sequenceIndex: 1,
          clipIndex: 2,
          cycleId: 1,
          phase: "COMPLETION",
          tOffsetSec: 18,
          tOffsetMs: 18000,
          outcome: "UP",
        }),
      ],
      cycleCount: 1,
      completionCount: 1,
      overlapClipCount: 0,
      hasOverlap: false,
      buySequence: ["DOWN", "UP"],
      alternatingTransitionCount: 1,
    });

    const identical = compareCanonicalReference(reference, { ...reference, slug: "identical-candidate" });
    const collapsed = compareCanonicalReference(reference, collapsedCandidate);

    expect(identical.details.referenceActiveFlowPeak).toBe(2);
    expect(identical.details.activeFlowPeakSimilarity).toBe(1);
    expect(collapsed.details.candidateActiveFlowPeak).toBe(1);
    expect(collapsed.details.flowLineageSimilarity).toBeLessThan(identical.details.flowLineageSimilarity);
    expect(collapsed.breakdown.cycleCompletionLatencyScore).toBeLessThan(1);
    expect(collapsed.details.averageCycleCompletionLatencyDeltaSec).toBeGreaterThan(0);
    expect(collapsed.details.cycleCompletionLatencyDeltasSec.length).toBeGreaterThan(0);
    expect(collapsed.details.cycleCompletionLatencyMaxAbsDeltaSec).toBeGreaterThan(0);
    expect(collapsed.score).toBeLessThan(identical.score);
  });

  it("tracks opening entry timing separately from flow correctness", () => {
    const reference = buildReference();
    const delayedCandidate = buildReference({
      slug: "candidate-market",
      orderedClipSequence: reference.orderedClipSequence.map((event) => {
        if (event.kind !== "BUY") {
          return event;
        }
        return {
          ...event,
          tOffsetSec: event.tOffsetSec + 6,
          tOffsetMs: event.tOffsetMs + 6000,
        };
      }),
    });

    const baseline = compareCanonicalReference(reference, { ...reference, slug: "baseline-candidate" });
    const delayed = compareCanonicalReference(reference, delayedCandidate);
    const summary = buildComparisonFlowSummary(delayed);
    const calibration = buildFlowCalibrationSummary([summary]);

    expect(baseline.details.openingEntryTimingSimilarity).toBe(1);
    expect(delayed.details.referenceFirstEntryOffsetSec).toBe(4);
    expect(delayed.details.candidateFirstEntryOffsetSec).toBe(10);
    expect(delayed.details.firstEntryOffsetDeltaSec).toBe(6);
    expect(delayed.details.openingEntryTimingSimilarity).toBeLessThan(1);
    expect(delayed.details.childOrderMicroTimingSimilarity).toBeLessThan(1);
    expect(delayed.details.childOrderMicroTimingMismatchCount).toBeGreaterThan(0);
    expect(summary.openingEntryTimingSimilarity).toBe(delayed.details.openingEntryTimingSimilarity);
    expect(summary.childOrderMicroTimingSimilarity).toBe(delayed.details.childOrderMicroTimingSimilarity);
    expect(calibration.openingEntryTimingDirection).toBe("candidate_late");
    expect(calibration.averageChildOrderMicroTimingSimilarity).toBeLessThan(1);
    expect(calibration.recommendedFocus).toContain("release_opening_seed_earlier");
    expect(calibration.recommendedFocus).toContain("improve_child_order_micro_timing");
    expect(delayed.score).toBeLessThan(baseline.score);
  });

  it("classifies flow summary status and builds calibration focus from recent summaries", () => {
    const reference = buildReference();
    const passSummary = buildComparisonFlowSummary(
      compareCanonicalReference(reference, { ...reference, slug: "candidate-pass" }),
    );
    const weakSummary = {
      ...passSummary,
      flowLineageSimilarity: 0.5,
      activeFlowPeakSimilarity: 0.45,
      cycleCompletionLatencySimilarity: 0.4,
    };
    const status = classifyComparisonFlowSummary(weakSummary);
    const calibration = buildFlowCalibrationSummary([passSummary, weakSummary]);

    expect(classifyComparisonFlowSummary(passSummary).status).toBe("PASS");
    expect(status.status).toBe("FAIL");
    expect(status.reasons).toContain("flow_lineage_similarity_low");
    expect(calibration.sampleCount).toBe(2);
    expect(calibration.status).toBe("WARN");
    expect(calibration.averageCycleCompletionLatencyDeltaP75Sec).toBeTypeOf("number");
    expect(calibration.recommendedFocus.length).toBeGreaterThan(0);
  });

  it("penalizes side-first sequence mismatches against the bundled public-sequence fixture", () => {
    const reference = publicSequenceFixture.references[0] as CanonicalReferenceExtract;
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      buySequence: ["DOWN", "UP", "DOWN", "UP"],
      orderedClipSequence: reference.orderedClipSequence.map((event, index) =>
        event.kind !== "BUY"
          ? event
          : {
              ...event,
              outcome: index % 2 === 0 ? "DOWN" : "UP",
            },
      ),
    };

    const baseline = compareCanonicalReference(reference, {
      ...reference,
      slug: "baseline-candidate",
    });
    const shifted = compareCanonicalReference(reference, candidate);

    expect(shifted.details.sideSequenceMismatchCount).toBeGreaterThan(0);
    expect(shifted.details.sideSequenceMismatchDetails[0]).toMatchObject({
      index: 0,
      referenceSide: "UP",
      candidateSide: "DOWN",
      referencePhase: "ENTRY",
      candidatePhase: "ENTRY",
      offsetDeltaSec: 0,
      mismatchSource: expect.stringContaining("E:"),
    });
    expect(shifted.details.sideSequenceSimilarity).toBeLessThan(1);
    expect(shifted.score).toBeLessThan(baseline.score);
  });

  it("separates child-order side mismatches from paired flow-intent preservation", () => {
    const reference = exact1776253500Reference;
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      buySequence: reference.buySequence.map((side, index) =>
        index === 4 ? "UP" : index === 5 ? "DOWN" : side,
      ),
      orderedClipSequence: reference.orderedClipSequence.map((event) => {
        if (event.sequenceIndex === 4) {
          return { ...event, outcome: "UP" };
        }
        if (event.sequenceIndex === 5) {
          return { ...event, outcome: "DOWN" };
        }
        return event;
      }),
    };

    const comparison = compareCanonicalReference(reference, candidate);
    const calibration = buildFlowCalibrationSummary([buildComparisonFlowSummary(comparison)]);

    expect(comparison.details.sideSequenceSimilarity).toBeLessThan(1);
    expect(comparison.details.flowPairSideSetSimilarity).toBe(1);
    expect(calibration.averageFlowPairSideSetSimilarity).toBe(1);
    expect(calibration.recommendedFocus).toContain("improve_child_order_micro_timing");
  });

  it("penalizes deviations from the exact 1776253500 late cheap-seed to high-low chase path", () => {
    const reference = exact1776253500Reference;
    const baseline = compareCanonicalReference(reference, {
      ...reference,
      slug: "baseline-candidate",
    });
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      buySequence: reference.buySequence.map((side, index) =>
        index === reference.buySequence.length - 2 ? "UP" : index === reference.buySequence.length - 1 ? "DOWN" : side,
      ),
      orderedClipSequence: reference.orderedClipSequence.map((event) => {
        if (event.sequenceIndex === 15) {
          return {
            ...event,
            outcome: "UP",
            price: 0.84,
          };
        }
        if (event.sequenceIndex === 16) {
          return {
            ...event,
            phase: "COMPLETION",
            familyLabel: "COMPLETION",
            internalLabel: "COMPLETION",
            outcome: "DOWN",
            price: 0.18,
          };
        }
        return event;
      }),
    };

    const shifted = compareCanonicalReference(reference, candidate);

    expect(shifted.details.sideSequenceMismatchCount).toBeGreaterThan(0);
    expect(shifted.details.phaseFamilySimilarity).toBeLessThan(baseline.details.phaseFamilySimilarity);
    expect(shifted.score).toBeLessThan(baseline.score);
  });

  it("penalizes exact 1776253500 completion qty parity drift even when side/mode path stays intact", () => {
    const reference = exact1776253500Reference;
    const baseline = compareCanonicalReference(reference, {
      ...reference,
      slug: "baseline-candidate",
    });
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      orderedClipSequence: reference.orderedClipSequence.map((event) =>
        event.sequenceIndex === 16
          ? {
              ...event,
              qty: 85.27977,
            }
          : event,
      ),
    };

    const shifted = compareCanonicalReference(reference, candidate);

    expect(shifted.details.eventQtySimilarity).toBeLessThan(baseline.details.eventQtySimilarity);
    expect(shifted.score).toBeLessThan(baseline.score);
  });

  it("penalizes exact 1776253500 merge-cluster qty drift", () => {
    const reference = exact1776253500Reference;
    const baseline = compareCanonicalReference(reference, {
      ...reference,
      slug: "baseline-candidate",
    });
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      orderedClipSequence: reference.orderedClipSequence.map((event) =>
        event.kind === "MERGE" && event.tOffsetSec === 76
          ? {
              ...event,
              qty: Number((event.qty * 0.8).toFixed(6)),
            }
          : event,
      ),
    };

    const shifted = compareCanonicalReference(reference, candidate);

    expect(shifted.details.mergeClusterQtySimilarity).toBeLessThan(baseline.details.mergeClusterQtySimilarity);
    expect(shifted.score).toBeLessThan(baseline.score);
  });

  it("fails the exact 1776253500 lifecycle parity gate when BUY, merge, or redeem path drifts", () => {
    const reference = exact1776253500Reference;
    const baseline = compareCanonicalReference(reference, { ...reference, slug: "baseline-candidate" }, {
      requireExactLifecycleParity: true,
    });
    const missingBuy: CanonicalReferenceExtract = {
      ...reference,
      slug: "missing-buy-candidate",
      buySequence: reference.buySequence.slice(0, -1),
      orderedClipSequence: reference.orderedClipSequence.filter((event) => event.sequenceIndex !== 16),
    };
    const missingMerge: CanonicalReferenceExtract = {
      ...reference,
      slug: "missing-merge-candidate",
      mergeCount: reference.mergeCount - 1,
      orderedClipSequence: reference.orderedClipSequence.filter((event) => event.sequenceIndex !== 17),
    };
    const missingRedeem: CanonicalReferenceExtract = {
      ...reference,
      slug: "missing-redeem-candidate",
      redeemCount: reference.redeemCount - 1,
      orderedClipSequence: reference.orderedClipSequence.filter((event) => event.kind !== "REDEEM"),
    };

    expect(baseline.verdict).toBe("PASS");
    expect(compareCanonicalReference(reference, missingBuy, { requireExactLifecycleParity: true }).verdict).toBe("FAIL");
    expect(compareCanonicalReference(reference, missingMerge, { requireExactLifecycleParity: true }).verdict).toBe("FAIL");
    expect(compareCanonicalReference(reference, missingRedeem, { requireExactLifecycleParity: true }).verdict).toBe("FAIL");
    expect(compareCanonicalReference(reference, missingRedeem, { requireExactLifecycleParity: true }).details).toMatchObject({
      exactLifecycleParityRequired: true,
      exactLifecycleParityBroken: true,
    });
  });

  it("penalizes deviations from the exact 1776248100 expensive-first to cheap-late completion path", () => {
    const reference = exact1776248100Reference;
    const baseline = compareCanonicalReference(reference, {
      ...reference,
      slug: "baseline-candidate",
    });
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      orderedClipSequence: reference.orderedClipSequence.map((event) => {
        if (event.sequenceIndex === 10) {
          return {
            ...event,
            outcome: "UP",
            price: 0.41,
            internalLabel: "OVERLAP",
          };
        }
        if (event.sequenceIndex === 11) {
          return {
            ...event,
            phase: "HIGH_LOW_COMPLETION",
            familyLabel: "HIGH_LOW_COMPLETION",
            internalLabel: "HIGH_LOW_COMPLETION",
            qty: 61.37359,
            price: 0.9,
          };
        }
        return event;
      }),
      buySequence: reference.buySequence.map((side, index) =>
        index === 10 ? "UP" : index === 11 ? "UP" : side,
      ),
    };

    const shifted = compareCanonicalReference(reference, candidate);

    expect(shifted.details.sideSequenceMismatchCount).toBeGreaterThan(0);
    expect(shifted.details.semanticRoleSequenceMismatchCount).toBeGreaterThan(0);
    expect(shifted.details.semanticRoleSequenceMismatchDetails[0]).toMatchObject({
      index: 10,
      referenceRole: "OVERLAP_HIGH",
      candidateRole: "OVERLAP_LOW",
      referenceSide: "DOWN",
      candidateSide: "UP",
    });
    expect(shifted.details.semanticRoleSequenceSimilarity).toBeLessThan(
      baseline.details.semanticRoleSequenceSimilarity,
    );
    expect(shifted.details.eventQtySimilarity).toBeLessThan(baseline.details.eventQtySimilarity);
    expect(shifted.score).toBeLessThan(baseline.score);
  });

  it("flags semantic role repair when side preservation is already strong", () => {
    const reference = exact1776248100Reference;
    const candidate: CanonicalReferenceExtract = {
      ...reference,
      slug: "candidate-market",
      orderedClipSequence: reference.orderedClipSequence.map((event) => {
        if (event.sequenceIndex === 10) {
          return {
            ...event,
            price: 0.14,
            internalLabel: "OVERLAP",
          };
        }
        if (event.sequenceIndex === 11) {
          return {
            ...event,
            price: 0.67,
            internalLabel: "COMPLETION",
          };
        }
        return event;
      }),
    };

    const comparison = compareCanonicalReference(reference, candidate);
    const calibration = buildFlowCalibrationSummary([buildComparisonFlowSummary(comparison)]);

    expect(comparison.details.sideSequenceSimilarity).toBe(1);
    expect(comparison.details.semanticRoleSequenceSimilarity).toBeLessThan(1);
    expect(comparison.details.completionReleaseRoleSimilarity).toBeLessThan(1);
    expect(calibration.roleSideTradeoffRisk).toBe("side_preservation_blocks_role_alignment");
    expect(calibration.averageCompletionReleaseRoleSimilarity).toBeLessThan(1);
    expect(calibration.recommendedFocus).toContain("guard_role_alignment_against_side_regression");
    expect(calibration.recommendedFocus).toContain("preserve_raw_side_before_role_override");
    expect(calibration.recommendedFocus).toContain("tune_completion_role_release_order");
  });

  it("fails the exact 1776928800 runtime incident against a healthier target footprint", () => {
    const candidate = runtimeIncidentFixture.references[0] as CanonicalReferenceExtract;
    const reference = exact1776928800Reference;

    const result = compareCanonicalReference(reference, candidate, {
      hardFails: (runtimeIncidentFixture as { hardFailsBySlug: Record<string, Record<string, number>> }).hardFailsBySlug[
        "btc-updown-5m-1776928800"
      ],
    });

    expect(result.verdict).toBe("FAIL");
    expect(result.hardFails.sameSideAmplification).toBe(1);
    expect(result.details.sideSequenceMismatchCount).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(66);
  });
});
