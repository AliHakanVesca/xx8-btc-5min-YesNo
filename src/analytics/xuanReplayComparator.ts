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
  sideSequenceScore: number;
  overlapFamilyScore: number;
  phaseFamilyScore: number;
  eventQtyScore: number;
  mergeClusterQtyScore: number;
  redeemClusterQtyScore: number;
  flowLineageScore: number;
  activeFlowPeakScore: number;
  cycleCompletionLatencyScore: number;
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
    sideSequenceSimilarity: number;
    sideSequenceMismatchCount: number;
    overlapFamilySimilarity: number;
    phaseFamilySimilarity: number;
    eventQtySimilarity: number;
    mergeClusterQtySimilarity: number;
    redeemClusterQtySimilarity: number;
    flowLineageSimilarity: number;
    activeFlowPeakSimilarity: number;
    cycleCompletionLatencySimilarity: number;
    referenceActiveFlowPeak: number;
    candidateActiveFlowPeak: number;
    referenceAverageCycleCompletionLatencySec: number;
    candidateAverageCycleCompletionLatencySec: number;
    averageCycleCompletionLatencyDeltaSec: number;
  };
}

export interface ComparisonFlowSummary {
  flowLineageSimilarity: number;
  activeFlowPeakSimilarity: number;
  cycleCompletionLatencySimilarity: number;
  referenceActiveFlowPeak: number;
  candidateActiveFlowPeak: number;
  referenceAverageCycleCompletionLatencySec: number;
  candidateAverageCycleCompletionLatencySec: number;
  averageCycleCompletionLatencyDeltaSec: number;
  flowLineageScore: number;
  activeFlowPeakScore: number;
  cycleCompletionLatencyScore: number;
}

export interface ComparisonFlowStatus {
  status: ComparatorVerdict;
  reasons: string[];
}

export interface FlowCalibrationSummary {
  sampleCount: number;
  averageFlowLineageSimilarity: number;
  averageActiveFlowPeakSimilarity: number;
  averageCycleCompletionLatencySimilarity: number;
  averageCycleCompletionLatencyDeltaSec: number;
  completionLatencyDirection: "candidate_early" | "candidate_late" | "aligned";
  status: ComparatorVerdict;
  recommendedFocus: string[];
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

function sideSequenceComparison(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): {
  similarity: number;
  mismatchCount: number;
} {
  const maxLength = Math.max(reference.buySequence.length, candidate.buySequence.length);
  if (maxLength === 0) {
    return {
      similarity: 1,
      mismatchCount: 0,
    };
  }
  let samePositionMatches = 0;
  const minLength = Math.min(reference.buySequence.length, candidate.buySequence.length);
  for (let index = 0; index < minLength; index += 1) {
    if (reference.buySequence[index] === candidate.buySequence[index]) {
      samePositionMatches += 1;
    }
  }
  return {
    similarity: samePositionMatches / maxLength,
    mismatchCount: maxLength - samePositionMatches,
  };
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

function flowLineageToken(event: { cycleId: number; phase: CanonicalPhase }): string {
  return `${event.cycleId}:${phaseToken(event.phase)}`;
}

function flowLineageSimilarity(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): number {
  const left = reference.orderedClipSequence
    .filter((event) => event.kind === "BUY")
    .map((event) => flowLineageToken(event));
  const right = candidate.orderedClipSequence
    .filter((event) => event.kind === "BUY")
    .map((event) => flowLineageToken(event));
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  return longestCommonSubsequenceLength(left, right) / Math.max(left.length, right.length);
}

function activeFlowPeak(extract: CanonicalReferenceExtract): number {
  const activeCycles = new Set<number>();
  let peak = 0;
  for (const event of extract.orderedClipSequence) {
    if (event.kind === "BUY") {
      if (event.phase === "ENTRY" || event.phase === "OVERLAP") {
        activeCycles.add(event.cycleId);
      }
      peak = Math.max(peak, activeCycles.size);
      if (event.phase === "COMPLETION" || event.phase === "HIGH_LOW_COMPLETION") {
        activeCycles.delete(event.cycleId);
      }
    } else if (event.kind === "MERGE" || event.kind === "REDEEM") {
      activeCycles.clear();
    }
    peak = Math.max(peak, activeCycles.size);
  }
  return peak;
}

function cycleCompletionLatencies(extract: CanonicalReferenceExtract): number[] {
  const openedAtByCycle = new Map<number, number>();
  const latencies: number[] = [];
  for (const event of extract.orderedClipSequence) {
    if (event.kind !== "BUY") {
      continue;
    }
    if ((event.phase === "ENTRY" || event.phase === "OVERLAP") && !openedAtByCycle.has(event.cycleId)) {
      openedAtByCycle.set(event.cycleId, event.tOffsetSec);
    }
    if (event.phase === "COMPLETION" || event.phase === "HIGH_LOW_COMPLETION") {
      const openedAt = openedAtByCycle.get(event.cycleId);
      if (openedAt !== undefined) {
        latencies.push(Math.max(0, event.tOffsetSec - openedAt));
        openedAtByCycle.delete(event.cycleId);
      }
    }
  }
  return latencies;
}

function sequenceQtySimilarity(
  left: number[],
  right: number[],
): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  let score = 0;
  for (let index = 0; index < maxLength; index += 1) {
    score += boundedRatioSimilarity(left[index] ?? 0, right[index] ?? 0);
  }
  return score / maxLength;
}

function averageNumber(values: number[]): number {
  return values.length > 0
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6))
    : 0;
}

function buyEventQtySimilarity(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): number {
  const left = reference.orderedClipSequence.filter((event) => event.kind === "BUY").map((event) => event.qty);
  const right = candidate.orderedClipSequence.filter((event) => event.kind === "BUY").map((event) => event.qty);
  return sequenceQtySimilarity(left, right);
}

function clusterQtySimilarity(
  reference: CanonicalReferenceExtract,
  candidate: CanonicalReferenceExtract,
  kind: "MERGE" | "REDEEM",
): number {
  const group = (extract: CanonicalReferenceExtract) => {
    const grouped = new Map<number, number>();
    for (const event of extract.orderedClipSequence) {
      if (event.kind !== kind) {
        continue;
      }
      grouped.set(event.tOffsetSec, (grouped.get(event.tOffsetSec) ?? 0) + event.qty);
    }
    return [...grouped.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, qty]) => Number(qty.toFixed(6)));
  };
  return sequenceQtySimilarity(group(reference), group(candidate));
}

function numericDeltaScore(reference: number, candidate: number, exactWeight = 1, offByOneWeight = 0.75): number {
  const delta = Math.abs(reference - candidate);
  if (delta === 0) return exactWeight;
  if (delta === 1) return offByOneWeight;
  if (delta === 2) return 0.4;
  return 0;
}

export function buildComparisonFlowSummary(comparison: CanonicalComparisonResult): ComparisonFlowSummary {
  return {
    flowLineageSimilarity: comparison.details.flowLineageSimilarity,
    activeFlowPeakSimilarity: comparison.details.activeFlowPeakSimilarity,
    cycleCompletionLatencySimilarity: comparison.details.cycleCompletionLatencySimilarity,
    referenceActiveFlowPeak: comparison.details.referenceActiveFlowPeak,
    candidateActiveFlowPeak: comparison.details.candidateActiveFlowPeak,
    referenceAverageCycleCompletionLatencySec: comparison.details.referenceAverageCycleCompletionLatencySec,
    candidateAverageCycleCompletionLatencySec: comparison.details.candidateAverageCycleCompletionLatencySec,
    averageCycleCompletionLatencyDeltaSec: comparison.details.averageCycleCompletionLatencyDeltaSec,
    flowLineageScore: comparison.breakdown.flowLineageScore,
    activeFlowPeakScore: comparison.breakdown.activeFlowPeakScore,
    cycleCompletionLatencyScore: comparison.breakdown.cycleCompletionLatencyScore,
  };
}

export function classifyComparisonFlowSummary(summary: ComparisonFlowSummary): ComparisonFlowStatus {
  const failReasons: string[] = [];
  const warnReasons: string[] = [];
  if (summary.flowLineageSimilarity < 0.55) {
    failReasons.push("flow_lineage_similarity_low");
  } else if (summary.flowLineageSimilarity < 0.75) {
    warnReasons.push("flow_lineage_similarity_warn");
  }
  if (summary.activeFlowPeakSimilarity < 0.5) {
    failReasons.push("active_flow_peak_similarity_low");
  } else if (summary.activeFlowPeakSimilarity < 0.75) {
    warnReasons.push("active_flow_peak_similarity_warn");
  }
  if (summary.cycleCompletionLatencySimilarity < 0.45) {
    failReasons.push("cycle_completion_latency_similarity_low");
  } else if (summary.cycleCompletionLatencySimilarity < 0.65) {
    warnReasons.push("cycle_completion_latency_similarity_warn");
  }

  if (failReasons.length > 0) {
    return { status: "FAIL", reasons: failReasons };
  }
  if (warnReasons.length > 0) {
    return { status: "WARN", reasons: warnReasons };
  }
  return { status: "PASS", reasons: [] };
}

export function buildFlowCalibrationSummary(summaries: ComparisonFlowSummary[]): FlowCalibrationSummary {
  const sampleCount = summaries.length;
  const average = (selector: (summary: ComparisonFlowSummary) => number): number =>
    sampleCount > 0
      ? Number((summaries.reduce((sum, summary) => sum + selector(summary), 0) / sampleCount).toFixed(6))
      : 0;
  const aggregate: ComparisonFlowSummary = {
    flowLineageSimilarity: average((summary) => summary.flowLineageSimilarity),
    activeFlowPeakSimilarity: average((summary) => summary.activeFlowPeakSimilarity),
    cycleCompletionLatencySimilarity: average((summary) => summary.cycleCompletionLatencySimilarity),
    referenceActiveFlowPeak: average((summary) => summary.referenceActiveFlowPeak),
    candidateActiveFlowPeak: average((summary) => summary.candidateActiveFlowPeak),
    referenceAverageCycleCompletionLatencySec: average((summary) => summary.referenceAverageCycleCompletionLatencySec ?? 0),
    candidateAverageCycleCompletionLatencySec: average((summary) => summary.candidateAverageCycleCompletionLatencySec ?? 0),
    averageCycleCompletionLatencyDeltaSec: average((summary) => summary.averageCycleCompletionLatencyDeltaSec ?? 0),
    flowLineageScore: average((summary) => summary.flowLineageScore),
    activeFlowPeakScore: average((summary) => summary.activeFlowPeakScore),
    cycleCompletionLatencyScore: average((summary) => summary.cycleCompletionLatencyScore),
  };
  const status = classifyComparisonFlowSummary(aggregate);
  const completionLatencyDirection =
    aggregate.averageCycleCompletionLatencyDeltaSec > 1
      ? "candidate_late"
      : aggregate.averageCycleCompletionLatencyDeltaSec < -1
        ? "candidate_early"
        : "aligned";
  const recommendedFocus = status.reasons.map((reason) => {
    if (reason.includes("flow_lineage")) return "increase_lineage_preservation";
    if (reason.includes("active_flow_peak")) return "allow_more_parallel_flow_when_budget_supports";
    if (reason.includes("completion_latency")) {
      if (completionLatencyDirection === "candidate_late") return "release_completion_earlier";
      if (completionLatencyDirection === "candidate_early") return "increase_completion_patience";
      return "tune_completion_patience_and_release";
    }
    return "inspect_flow_similarity";
  });
  return {
    sampleCount,
    averageFlowLineageSimilarity: aggregate.flowLineageSimilarity,
    averageActiveFlowPeakSimilarity: aggregate.activeFlowPeakSimilarity,
    averageCycleCompletionLatencySimilarity: aggregate.cycleCompletionLatencySimilarity,
    averageCycleCompletionLatencyDeltaSec: aggregate.averageCycleCompletionLatencyDeltaSec,
    completionLatencyDirection,
    status: sampleCount === 0 ? "WARN" : status.status,
    recommendedFocus: [...new Set(sampleCount === 0 ? ["collect_replay_flow_samples"] : recommendedFocus)],
  };
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
  const sideSequence = sideSequenceComparison(reference, candidate);
  const overlapFamily = overlapSimilarity(reference, candidate);
  const phaseFamily = phaseFamilySimilarity(reference, candidate);
  const eventQty = buyEventQtySimilarity(reference, candidate);
  const mergeClusterQty = clusterQtySimilarity(reference, candidate, "MERGE");
  const redeemClusterQty = clusterQtySimilarity(reference, candidate, "REDEEM");
  const lineageFlow = flowLineageSimilarity(reference, candidate);
  const referenceActiveFlowPeak = activeFlowPeak(reference);
  const candidateActiveFlowPeak = activeFlowPeak(candidate);
  const referenceCompletionLatencies = cycleCompletionLatencies(reference);
  const candidateCompletionLatencies = cycleCompletionLatencies(candidate);
  const referenceAverageCycleCompletionLatencySec = averageNumber(referenceCompletionLatencies);
  const candidateAverageCycleCompletionLatencySec = averageNumber(candidateCompletionLatencies);
  const averageCycleCompletionLatencyDeltaSec = Number(
    (candidateAverageCycleCompletionLatencySec - referenceAverageCycleCompletionLatencySec).toFixed(6),
  );
  const activeFlowPeakSimilarity = boundedRatioSimilarity(referenceActiveFlowPeak, candidateActiveFlowPeak);
  const cycleCompletionLatencySimilarity = sequenceQtySimilarity(
    referenceCompletionLatencies,
    candidateCompletionLatencies,
  );

  const correctnessScore =
    cycleCountScore * 15 +
    mergeCountScore * 10 +
    completionCountScore * 5 +
    repairLatencyScore * 10 +
    residualSideScore * 10 +
    residualBucketScore * 10;

  const familyScore =
    clipBucketSimilarity * 7 +
    alternationSimilarity * 4 +
    sideSequence.similarity * 4 +
    overlapFamily * 4 +
    phaseFamily * 4 +
    eventQty * 6 +
    mergeClusterQty * 3 +
    redeemClusterQty * 3 +
    lineageFlow * 3 +
    activeFlowPeakSimilarity * 1 +
    cycleCompletionLatencySimilarity * 1;

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
      sideSequenceScore: sideSequence.similarity,
      overlapFamilyScore: overlapFamily,
      phaseFamilyScore: phaseFamily,
      eventQtyScore: eventQty,
      mergeClusterQtyScore: mergeClusterQty,
      redeemClusterQtyScore: redeemClusterQty,
      flowLineageScore: lineageFlow,
      activeFlowPeakScore: activeFlowPeakSimilarity,
      cycleCompletionLatencyScore: cycleCompletionLatencySimilarity,
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
      sideSequenceSimilarity: sideSequence.similarity,
      sideSequenceMismatchCount: sideSequence.mismatchCount,
      overlapFamilySimilarity: overlapFamily,
      phaseFamilySimilarity: phaseFamily,
      eventQtySimilarity: eventQty,
      mergeClusterQtySimilarity: mergeClusterQty,
      redeemClusterQtySimilarity: redeemClusterQty,
      flowLineageSimilarity: lineageFlow,
      activeFlowPeakSimilarity,
      cycleCompletionLatencySimilarity,
      referenceActiveFlowPeak,
      candidateActiveFlowPeak,
      referenceAverageCycleCompletionLatencySec,
      candidateAverageCycleCompletionLatencySec,
      averageCycleCompletionLatencyDeltaSec,
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
