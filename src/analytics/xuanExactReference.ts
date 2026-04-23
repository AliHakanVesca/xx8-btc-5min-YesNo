import type { CanonicalReferenceBundle, CanonicalReferenceExtract } from "./xuanCanonicalReference.js";

const exact1776928800Reference: CanonicalReferenceExtract = {
  slug: "btc-updown-5m-1776928800",
  startTs: 1776928800,
  endTs: 1776929100,
  orderedClipSequence: [
    {
      sequenceIndex: 0,
      clipIndex: 1,
      cycleId: 1,
      phase: "ENTRY",
      kind: "BUY",
      tOffsetSec: 4,
      tOffsetMs: 4000,
      outcome: "DOWN",
      price: 0.49,
      qty: 5,
      qtyBucket: "1_5",
      baseLot: 5,
      normalizedClipTier: "1x",
      familyLabel: "ENTRY",
      internalLabel: "TEMPORAL_SINGLE_LEG_SEED",
    },
    {
      sequenceIndex: 1,
      clipIndex: 2,
      cycleId: 1,
      phase: "COMPLETION",
      kind: "BUY",
      tOffsetSec: 6,
      tOffsetMs: 6000,
      outcome: "UP",
      price: 0.5,
      qty: 5,
      qtyBucket: "1_5",
      baseLot: 5,
      normalizedClipTier: "1x",
      familyLabel: "COMPLETION",
      internalLabel: "HIGH_LOW_COMPLETION",
    },
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

const exactReferenceBundles: CanonicalReferenceBundle[] = [
  {
    generatedAt: "2026-04-23T00:00:00.000Z",
    slugs: [exact1776928800Reference.slug],
    sources: {
      tradeTapeFile: "bundled-exact-runtime-reference:btc-updown-5m-1776928800",
    },
    references: [exact1776928800Reference],
  },
];

export function resolveBundledExactReferenceBundle(referenceSlug: string): CanonicalReferenceBundle | undefined {
  return exactReferenceBundles.find((bundle) => bundle.references.some((reference) => reference.slug === referenceSlug));
}

export { exact1776928800Reference };
