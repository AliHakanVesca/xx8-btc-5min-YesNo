import { describe, expect, it } from "vitest";
import { compareCanonicalReference } from "../../src/analytics/xuanReplayComparator.js";
import type {
  CanonicalReferenceExtract,
  CanonicalSequenceEvent,
  NormalizedClipTier,
} from "../../src/analytics/xuanCanonicalReference.js";
import { exact1776253500Reference, exact1776928800Reference } from "../../src/analytics/xuanExactReference.js";
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
    expect(shifted.details.sideSequenceSimilarity).toBeLessThan(1);
    expect(shifted.score).toBeLessThan(baseline.score);
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
