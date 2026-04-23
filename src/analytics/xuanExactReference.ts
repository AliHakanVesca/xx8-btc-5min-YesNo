import type { OutcomeSide } from "../infra/clob/types.js";
import type {
  CanonicalPhase,
  CanonicalReferenceBundle,
  CanonicalReferenceExtract,
  CanonicalSequenceEvent,
  NormalizedClipTier,
  QtyBucket,
} from "./xuanCanonicalReference.js";

function exactEvent(args: {
  sequenceIndex: number;
  clipIndex?: number | null;
  cycleId: number;
  phase: CanonicalPhase;
  kind?: CanonicalSequenceEvent["kind"];
  tOffsetSec: number;
  outcome?: OutcomeSide | null;
  price?: number | null;
  qty: number;
  qtyBucket: QtyBucket;
  baseLot: number;
  normalizedClipTier?: NormalizedClipTier;
  familyLabel?: CanonicalPhase;
  internalLabel?: string;
}): CanonicalSequenceEvent {
  return {
    sequenceIndex: args.sequenceIndex,
    clipIndex: args.clipIndex ?? null,
    cycleId: args.cycleId,
    phase: args.phase,
    kind: args.kind ?? "BUY",
    tOffsetSec: args.tOffsetSec,
    tOffsetMs: args.tOffsetSec * 1000,
    outcome: args.outcome ?? null,
    price: args.price ?? null,
    qty: args.qty,
    qtyBucket: args.qtyBucket,
    baseLot: args.baseLot,
    normalizedClipTier: args.normalizedClipTier ?? "1x",
    familyLabel: args.familyLabel ?? args.phase,
    internalLabel: args.internalLabel ?? args.phase,
  };
}

const exact1776928800Reference: CanonicalReferenceExtract = {
  slug: "btc-updown-5m-1776928800",
  startTs: 1776928800,
  endTs: 1776929100,
  orderedClipSequence: [
    exactEvent({
      sequenceIndex: 0,
      clipIndex: 1,
      cycleId: 1,
      phase: "ENTRY",
      tOffsetSec: 4,
      outcome: "DOWN",
      price: 0.49,
      qty: 5,
      qtyBucket: "1_5",
      baseLot: 5,
      internalLabel: "TEMPORAL_SINGLE_LEG_SEED",
    }),
    exactEvent({
      sequenceIndex: 1,
      clipIndex: 2,
      cycleId: 1,
      phase: "COMPLETION",
      tOffsetSec: 6,
      outcome: "UP",
      price: 0.5,
      qty: 5,
      qtyBucket: "1_5",
      baseLot: 5,
      internalLabel: "HIGH_LOW_COMPLETION",
    }),
  ],
  cycleCount: 1,
  mergeCount: 0,
  redeemCount: 0,
  completionCount: 1,
  overlapClipCount: 0,
  hasOverlap: false,
  repairLatencyBucket: "0_10",
  mergeTimingBucket: "none",
  finalResidualSide: "FLAT",
  finalResidualBucket: "flat",
  clipBucketCounts: {
    "1_5": 2,
    "6_10": 0,
    "11_15": 0,
    "16_30": 0,
    "31_plus": 0,
  },
  normalizedClipTierCounts: {
    "0_5x": 0,
    "1x": 2,
    "2x": 0,
    "3x": 0,
    "4x_plus": 0,
  },
  buySequence: ["DOWN", "UP"],
  alternatingTransitionCount: 1,
  authority: {
    tradeTape: "paper",
    lifecycle: "paper",
    verifiedBuyCount: 2,
    totalBuyCount: 2,
    mergeEventCount: 0,
    redeemEventCount: 0,
  },
};

const exact1776253500Reference: CanonicalReferenceExtract = {
  slug: "btc-updown-5m-1776253500",
  startTs: 1776253500,
  endTs: 1776253800,
  orderedClipSequence: [
    exactEvent({
      sequenceIndex: 0,
      clipIndex: 1,
      cycleId: 1,
      phase: "ENTRY",
      tOffsetSec: 4,
      outcome: "DOWN",
      price: 0.53,
      qty: 127.53312,
      qtyBucket: "31_plus",
      baseLot: 127.53312,
    }),
    exactEvent({
      sequenceIndex: 1,
      clipIndex: 2,
      cycleId: 1,
      phase: "COMPLETION",
      tOffsetSec: 6,
      outcome: "UP",
      price: 0.48,
      qty: 127.05792,
      qtyBucket: "31_plus",
      baseLot: 127.53312,
    }),
    exactEvent({
      sequenceIndex: 2,
      clipIndex: 3,
      cycleId: 2,
      phase: "OVERLAP",
      tOffsetSec: 10,
      outcome: "UP",
      price: 0.5,
      qty: 87.4348,
      qtyBucket: "31_plus",
      baseLot: 87.4348,
    }),
    exactEvent({
      sequenceIndex: 3,
      clipIndex: 4,
      cycleId: 2,
      phase: "COMPLETION",
      tOffsetSec: 20,
      outcome: "DOWN",
      price: 0.46,
      qty: 87.17359,
      qtyBucket: "31_plus",
      baseLot: 87.4348,
    }),
    exactEvent({
      sequenceIndex: 4,
      clipIndex: 5,
      cycleId: 3,
      phase: "OVERLAP",
      tOffsetSec: 26,
      outcome: "DOWN",
      price: 0.57,
      qty: 127.91328,
      qtyBucket: "31_plus",
      baseLot: 127.91328,
    }),
    exactEvent({
      sequenceIndex: 5,
      clipIndex: 6,
      cycleId: 3,
      phase: "COMPLETION",
      tOffsetSec: 42,
      outcome: "UP",
      price: 0.48284242424242424,
      qty: 127.08494,
      qtyBucket: "31_plus",
      baseLot: 127.91328,
    }),
    exactEvent({
      sequenceIndex: 6,
      clipIndex: 7,
      cycleId: 4,
      phase: "OVERLAP",
      tOffsetSec: 44,
      outcome: "UP",
      price: 0.57,
      qty: 87.89193,
      qtyBucket: "31_plus",
      baseLot: 87.89193,
    }),
    exactEvent({
      sequenceIndex: 7,
      clipIndex: 8,
      cycleId: 4,
      phase: "COMPLETION",
      tOffsetSec: 60,
      outcome: "DOWN",
      price: 0.37,
      qty: 86.58585,
      qtyBucket: "31_plus",
      baseLot: 87.89193,
    }),
    exactEvent({
      sequenceIndex: 8,
      clipIndex: 9,
      cycleId: 5,
      phase: "OVERLAP",
      tOffsetSec: 64,
      outcome: "UP",
      price: 0.6722271223814774,
      qty: 88.55952,
      qtyBucket: "31_plus",
      baseLot: 88.55952,
    }),
    exactEvent({
      sequenceIndex: 9,
      clipIndex: 10,
      cycleId: 5,
      phase: "COMPLETION",
      tOffsetSec: 70,
      outcome: "DOWN",
      price: 0.27,
      qty: 85.93281,
      qtyBucket: "31_plus",
      baseLot: 88.55952,
    }),
    exactEvent({
      sequenceIndex: 10,
      cycleId: 1,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: 76,
      qty: 127.05792,
      qtyBucket: "31_plus",
      baseLot: 127.53312,
    }),
    exactEvent({
      sequenceIndex: 11,
      cycleId: 2,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: 76,
      qty: 87.17359,
      qtyBucket: "31_plus",
      baseLot: 87.4348,
    }),
    exactEvent({
      sequenceIndex: 12,
      cycleId: 3,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: 76,
      qty: 127.08494,
      qtyBucket: "31_plus",
      baseLot: 127.91328,
    }),
    exactEvent({
      sequenceIndex: 13,
      cycleId: 4,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: 76,
      qty: 86.58585,
      qtyBucket: "31_plus",
      baseLot: 87.89193,
    }),
    exactEvent({
      sequenceIndex: 14,
      cycleId: 5,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: 76,
      qty: 85.93281,
      qtyBucket: "31_plus",
      baseLot: 88.55952,
    }),
    exactEvent({
      sequenceIndex: 15,
      clipIndex: 11,
      cycleId: 6,
      phase: "OVERLAP",
      tOffsetSec: 86,
      outcome: "DOWN",
      price: 0.17,
      qty: 85.27977,
      qtyBucket: "31_plus",
      baseLot: 85.27977,
    }),
    exactEvent({
      sequenceIndex: 16,
      clipIndex: 12,
      cycleId: 6,
      phase: "HIGH_LOW_COMPLETION",
      tOffsetSec: 88,
      outcome: "UP",
      price: 0.9,
      qty: 90.04696,
      qtyBucket: "31_plus",
      baseLot: 85.27977,
    }),
    exactEvent({
      sequenceIndex: 17,
      cycleId: 6,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: 276,
      qty: 85.27977,
      qtyBucket: "31_plus",
      baseLot: 85.27977,
    }),
    exactEvent({
      sequenceIndex: 18,
      cycleId: 2,
      phase: "REDEEM",
      kind: "REDEEM",
      tOffsetSec: 556,
      outcome: "UP",
      qty: 0.26121,
      qtyBucket: "1_5",
      baseLot: 87.4348,
      normalizedClipTier: "0_5x",
    }),
    exactEvent({
      sequenceIndex: 19,
      cycleId: 4,
      phase: "REDEEM",
      kind: "REDEEM",
      tOffsetSec: 556,
      outcome: "UP",
      qty: 1.30608,
      qtyBucket: "1_5",
      baseLot: 87.89193,
      normalizedClipTier: "0_5x",
    }),
    exactEvent({
      sequenceIndex: 20,
      cycleId: 5,
      phase: "REDEEM",
      kind: "REDEEM",
      tOffsetSec: 556,
      outcome: "UP",
      qty: 2.62671,
      qtyBucket: "1_5",
      baseLot: 88.55952,
      normalizedClipTier: "0_5x",
    }),
    exactEvent({
      sequenceIndex: 21,
      cycleId: 6,
      phase: "REDEEM",
      kind: "REDEEM",
      tOffsetSec: 556,
      outcome: "UP",
      qty: 3.46365,
      qtyBucket: "1_5",
      baseLot: 85.27977,
      normalizedClipTier: "0_5x",
    }),
  ],
  cycleCount: 6,
  mergeCount: 2,
  redeemCount: 1,
  completionCount: 6,
  overlapClipCount: 5,
  hasOverlap: true,
  repairLatencyBucket: "0_10",
  mergeTimingBucket: "30_90",
  finalResidualSide: "FLAT",
  finalResidualBucket: "flat",
  clipBucketCounts: {
    "1_5": 0,
    "6_10": 0,
    "11_15": 0,
    "16_30": 0,
    "31_plus": 12,
  },
  normalizedClipTierCounts: {
    "0_5x": 0,
    "1x": 12,
    "2x": 0,
    "3x": 0,
    "4x_plus": 0,
  },
  buySequence: ["DOWN", "UP", "UP", "DOWN", "DOWN", "UP", "UP", "DOWN", "UP", "DOWN", "DOWN", "UP"],
  alternatingTransitionCount: 7,
  authority: {
    tradeTape: "json_verified_by_activity",
    lifecycle: "sqlite_activity",
    wallet: "0xcfb103c37c0234f524c632d964ed31f117b5f694",
    verifiedBuyCount: 12,
    totalBuyCount: 12,
    mergeEventCount: 2,
    redeemEventCount: 1,
  },
};

const exactReferences = [exact1776928800Reference, exact1776253500Reference];

const exactReferenceBundles: CanonicalReferenceBundle[] = exactReferences.map((reference) => ({
  generatedAt: "2026-04-23T00:00:00.000Z",
  slugs: [reference.slug],
  sources: {
    tradeTapeFile: `bundled-exact-public-reference:${reference.slug}`,
  },
  references: [reference],
}));

export function resolveBundledExactReference(referenceSlug: string): CanonicalReferenceExtract | undefined {
  return exactReferences.find((reference) => reference.slug === referenceSlug);
}

export function resolveBundledOpenSequencePrior(
  referenceSlug: string,
): { side: OutcomeSide; activeUntilSec: number } | undefined {
  const reference = resolveBundledExactReference(referenceSlug);
  if (!reference) {
    return undefined;
  }

  const buys = reference.orderedClipSequence.filter(
    (event): event is CanonicalSequenceEvent & { outcome: OutcomeSide } =>
      event.kind === "BUY" && event.outcome !== null,
  );
  const firstBuy = buys[0];
  if (!firstBuy) {
    return undefined;
  }

  const sameCycleRepair = buys.find((event) => event.cycleId === firstBuy.cycleId && event.sequenceIndex > firstBuy.sequenceIndex);
  return {
    side: firstBuy.outcome,
    activeUntilSec: Math.max(12, sameCycleRepair?.tOffsetSec ?? firstBuy.tOffsetSec),
  };
}

export function resolveBundledLateCheapGuardSec(referenceSlug: string): number | undefined {
  const reference = resolveBundledExactReference(referenceSlug);
  if (!reference) {
    return undefined;
  }

  const highLowCompletion = reference.orderedClipSequence.find(
    (event) => event.kind === "BUY" && event.phase === "HIGH_LOW_COMPLETION",
  );
  if (!highLowCompletion) {
    return undefined;
  }

  const precedingBuy = [...reference.orderedClipSequence]
    .reverse()
    .find(
      (event) =>
        event.kind === "BUY" &&
        event.outcome !== null &&
        event.sequenceIndex < highLowCompletion.sequenceIndex,
    );

  return precedingBuy?.tOffsetSec ?? highLowCompletion.tOffsetSec;
}

export function resolveBundledExactReferenceBundle(referenceSlug: string): CanonicalReferenceBundle | undefined {
  return exactReferenceBundles.find((bundle) => bundle.references.some((reference) => reference.slug === referenceSlug));
}

export { exact1776928800Reference, exact1776253500Reference };
