import type {
  CanonicalPhase,
  CanonicalReferenceBundle,
  CanonicalReferenceExtract,
  NormalizedClipTier,
  QtyBucket,
  ResidualBucket,
  TimingBucket,
} from "./xuanCanonicalReference.js";

export type ComparatorVerdict = "PASS" | "WARN" | "FAIL";

export interface HardFailCounts {
  overshoot: number;
  sameSideAmplification: number;
  completionQtyExceedsMissing: number;
  grouplessBotFill: number;
  repairSizeZeroWithGap: number;
  mergeMissWithValidQty: number;
}

export interface ComparatorBreakdown {
  correctnessScore: number;
  familyScore: number;
  cycleCountScore: number;
  mergeCountScore: number;
  completionCountScore: number;
  repairLatencyScore: number;
  residualSideScore: number;
  residualBucketScore: number;
  clipBucketScore: number;
  alternationScore: number;
  overlapFamilyScore: number;
  phaseFamilyScore: number;
}

export interface CanonicalComparisonResult {
  verdict: ComparatorVerdict;
  score: number;
  hardFailTotal: number;
  hardFails: HardFailCounts;
  breakdown: ComparatorBreakdown;
  details: {
    referenceSlug: string;
    candidateSlug: string;
    cycleCountDelta: number;
    mergeCountDelta: number;
    completionCountDelta: number;
    repairLatencyBucketMatch: boolean;
    residualSideMatch: boolean;
    residualBucketMatch: boolean;
    clipBucketSimilarity: number;
    alternationSimilarity: number;
    overlapFamilySimilarity: number;
    phaseFamilySimilarity: number;
  };
}

export interface CanonicalBundleComparison {
  verdict: ComparatorVerdict;
  score: number;
  hardFailTotal: number;
  perSlug: CanonicalComparisonResult[];
  comparedSlugs: string[];
}

const qtyBuckets: QtyBucket[] = ["1_5", "6_10", "11_15", "16_30", "31_plus"];
const normalizedClipTiers: NormalizedClipTier[] = ["0_5x", "1x", "2x", "3x", "4x_plus"];
const residualOrder: ResidualBucket[] = ["flat", "dust", "small", "medium", "large"];
const timingOrder: TimingBucket[] = ["none", "0_10", "10_30", "30_90", "90_plus"];

function sumHardFails(fails: HardFailCounts): number {
  return Object.values(fails).reduce((acc, value) => acc + value, 0);
}

function defaultHardFails(overrides?: Partial<HardFailCounts> | undefined): HardFailCounts {
  return {
    overshoot: overrides?.overshoot ?? 0,
    sameSideAmplification: overrides?.sameSideAmplification ?? 0,
    completionQtyExceedsMissing: overrides?.completionQtyExceedsMissing ?? 0,
    grouplessBotFill: overrides?.grouplessBotFill ?? 0,
    repairSizeZeroWithGap: overrides?.repairSizeZeroWithGap ?? 0,
    mergeMissWithValidQty: overrides?.mergeMissWithValidQty ?? 0,
  };
}

function boundedRatioSimilarity(left: number, right: number): number {
  if (left <= 0 && right <= 0) return 1;
  const denominator = Math.max(left, right, 1);
  return Math.max(0, 1 - Math.abs(left - right) / denominator);
}

function bucketDistance<T extends string>(order: T[], left: T, right: T): number {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex === -1 || rightIndex === -1) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(leftIndex - rightIndex);
}

function bucketMatchScore<T extends string>(order: T[], left: T, right: T): number {
  const distance = bucketDistance(order, left, right);
  if (!Number.isFinite(distance)) return 0;
  if (distance === 0) return 1;
  if (distance === 1) return 0.5;
  return 0;
}

function histogramSimilarity(
  reference: Record<string, number>,
  candidate: Record<string, number>,
  orderedKeys: readonly string[],
): number {
  const referenceTotal = orderedKeys.reduce((acc, bucket) => acc + (reference[bucket] ?? 0), 0);
  if (referenceTotal <= 0) return 1;
  const overlap = orderedKeys.reduce(
    (acc, bucket) => acc + Math.min(reference[bucket] ?? 0, candidate[bucket] ?? 0),
    0,
  );
  return overlap / referenceTotal;
}

function alternationRatio(reference: CanonicalReferenceExtract): number {
  const denominator = Math.max(reference.buySequence.length - 1, 1);
  return reference.alternatingTransitionCount / denominator;
}

function overlapSimilarity(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): number {
  if (reference.hasOverlap === candidate.hasOverlap && reference.overlapClipCount === candidate.overlapClipCount) {
    return 1;
  }
  if (reference.hasOverlap === candidate.hasOverlap && Math.abs(reference.overlapClipCount - candidate.overlapClipCount) <= 1) {
    return 0.8;
  }
  if (reference.hasOverlap === candidate.hasOverlap) {
    return 0.5;
  }
  return 0;
}

function phaseToken(phase: CanonicalPhase): string {
  switch (phase) {
    case "ENTRY":
      return "E";
    case "OVERLAP":
      return "O";
    case "COMPLETION":
      return "C";
    case "HIGH_LOW_COMPLETION":
      return "H";
    case "MERGE":
      return "M";
    case "REDEEM":
      return "R";
  }
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let row = 1; row < rows; row += 1) {
    const current = dp[row]!;
    const previous = dp[row - 1]!;
    for (let col = 1; col < cols; col += 1) {
      if (left[row - 1] === right[col - 1]) {
        current[col] = previous[col - 1]! + 1;
      } else {
        current[col] = Math.max(previous[col]!, current[col - 1]!);
      }
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

function phaseFamilySimilarity(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): number {
  const left = reference.orderedClipSequence.filter((event) => event.kind === "BUY").map((event) => phaseToken(event.phase));
  const right = candidate.orderedClipSequence.filter((event) => event.kind === "BUY").map((event) => phaseToken(event.phase));
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  return longestCommonSubsequenceLength(left, right) / Math.max(left.length, right.length);
}

function numericDeltaScore(reference: number, candidate: number, exactWeight = 1, offByOneWeight = 0.75): number {
  const delta = Math.abs(reference - candidate);
  if (delta === 0) return exactWeight;
  if (delta === 1) return offByOneWeight;
  if (delta === 2) return 0.4;
  return 0;
}

export function compareCanonicalReference(
  reference: CanonicalReferenceExtract,
  candidate: CanonicalReferenceExtract,
  options?: {
    hardFails?: Partial<HardFailCounts> | undefined;
  },
): CanonicalComparisonResult {
  const hardFails = defaultHardFails(options?.hardFails);
  const hardFailTotal = sumHardFails(hardFails);

  const cycleCountScore = numericDeltaScore(reference.cycleCount, candidate.cycleCount);
  const mergeCountScore = numericDeltaScore(reference.mergeCount, candidate.mergeCount, 1, 0.7);
  const completionCountScore = numericDeltaScore(reference.completionCount, candidate.completionCount, 1, 0.7);
  const repairLatencyScore = bucketMatchScore(timingOrder, reference.repairLatencyBucket, candidate.repairLatencyBucket);
  const residualSideScore = reference.finalResidualSide === candidate.finalResidualSide ? 1 : 0;
  const residualBucketScore = bucketMatchScore(residualOrder, reference.finalResidualBucket, candidate.finalResidualBucket);

  const clipBucketSimilarity = histogramSimilarity(
    reference.normalizedClipTierCounts,
    candidate.normalizedClipTierCounts,
    normalizedClipTiers,
  );
  const alternationSimilarity = boundedRatioSimilarity(alternationRatio(reference), alternationRatio(candidate));
  const overlapFamily = overlapSimilarity(reference, candidate);
  const phaseFamily = phaseFamilySimilarity(reference, candidate);

  const correctnessScore =
    cycleCountScore * 15 +
    mergeCountScore * 10 +
    completionCountScore * 5 +
    repairLatencyScore * 10 +
    residualSideScore * 10 +
    residualBucketScore * 10;

  const familyScore =
    clipBucketSimilarity * 20 +
    alternationSimilarity * 10 +
    overlapFamily * 5 +
    phaseFamily * 5;

  const score = Math.round((correctnessScore + familyScore) * 100) / 100;

  let verdict: ComparatorVerdict;
  if (hardFailTotal > 0) {
    verdict = "FAIL";
  } else if (score >= 80) {
    verdict = "PASS";
  } else if (score >= 65) {
    verdict = "WARN";
  } else {
    verdict = "FAIL";
  }

  return {
    verdict,
    score,
    hardFailTotal,
    hardFails,
    breakdown: {
      correctnessScore,
      familyScore,
      cycleCountScore,
      mergeCountScore,
      completionCountScore,
      repairLatencyScore,
      residualSideScore,
      residualBucketScore,
      clipBucketScore: clipBucketSimilarity,
      alternationScore: alternationSimilarity,
      overlapFamilyScore: overlapFamily,
      phaseFamilyScore: phaseFamily,
    },
    details: {
      referenceSlug: reference.slug,
      candidateSlug: candidate.slug,
      cycleCountDelta: Math.abs(reference.cycleCount - candidate.cycleCount),
      mergeCountDelta: Math.abs(reference.mergeCount - candidate.mergeCount),
      completionCountDelta: Math.abs(reference.completionCount - candidate.completionCount),
      repairLatencyBucketMatch: reference.repairLatencyBucket === candidate.repairLatencyBucket,
      residualSideMatch: reference.finalResidualSide === candidate.finalResidualSide,
      residualBucketMatch: reference.finalResidualBucket === candidate.finalResidualBucket,
      clipBucketSimilarity,
      alternationSimilarity,
      overlapFamilySimilarity: overlapFamily,
      phaseFamilySimilarity: phaseFamily,
    },
  };
}

export function compareCanonicalBundles(
  referenceBundle: CanonicalReferenceBundle,
  candidateBundle: CanonicalReferenceBundle,
  options?: {
    hardFailsBySlug?: Record<string, Partial<HardFailCounts>> | undefined;
  },
): CanonicalBundleComparison {
  const referenceBySlug = new Map(referenceBundle.references.map((reference) => [reference.slug, reference]));
  const candidateBySlug = new Map(candidateBundle.references.map((candidate) => [candidate.slug, candidate]));
  const comparedSlugs = referenceBundle.slugs.filter((slug) => referenceBySlug.has(slug) && candidateBySlug.has(slug));
  const perSlug = comparedSlugs.map((slug) =>
    compareCanonicalReference(referenceBySlug.get(slug)!, candidateBySlug.get(slug)!, {
      hardFails: options?.hardFailsBySlug?.[slug],
    }),
  );

  const hardFailTotal = perSlug.reduce((acc, result) => acc + result.hardFailTotal, 0);
  const score =
    perSlug.length > 0 ? Math.round((perSlug.reduce((acc, result) => acc + result.score, 0) / perSlug.length) * 100) / 100 : 0;
  const verdict: ComparatorVerdict =
    hardFailTotal > 0 ? "FAIL" : perSlug.every((result) => result.verdict === "PASS") ? "PASS" : perSlug.some((result) => result.verdict === "FAIL") ? "FAIL" : "WARN";

  return {
    verdict,
    score,
    hardFailTotal,
    perSlug,
    comparedSlugs,
  };
}
