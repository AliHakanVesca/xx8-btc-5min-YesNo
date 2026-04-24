import type {
  CanonicalPhase,
  CanonicalReferenceBundle,
  CanonicalSequenceEvent,
  CanonicalReferenceExtract,
  NormalizedClipTier,
  QtyBucket,
  ResidualBucket,
  TimingBucket,
} from "./xuanCanonicalReference.js";
import type { OutcomeSide } from "../infra/clob/types.js";

export type ComparatorVerdict = "PASS" | "WARN" | "FAIL";

export const XUAN_FLOW_CALIBRATION_VERSION = "flow-calib-v4-side-role-opening-guard";

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
  flowPairSideSetScore: number;
  semanticRoleSequenceScore: number;
  completionReleaseRoleScore: number;
  flowPairRoleSetScore: number;
  overlapFamilyScore: number;
  phaseFamilyScore: number;
  eventQtyScore: number;
  mergeClusterQtyScore: number;
  redeemClusterQtyScore: number;
  flowLineageScore: number;
  activeFlowPeakScore: number;
  cycleCompletionLatencyScore: number;
  openingEntryTimingScore: number;
  childOrderMicroTimingScore: number;
}

export interface SideSequenceMismatchDetail {
  index: number;
  referenceSide: OutcomeSide | null;
  candidateSide: OutcomeSide | null;
  referencePhase: CanonicalPhase | null;
  candidatePhase: CanonicalPhase | null;
  referenceInternalLabel: string | null;
  candidateInternalLabel: string | null;
  referenceCycleId: number | null;
  candidateCycleId: number | null;
  referenceOffsetSec: number | null;
  candidateOffsetSec: number | null;
  offsetDeltaSec: number | null;
  mismatchSource: string;
}

export interface SemanticRoleSequenceMismatchDetail {
  index: number;
  referenceRole: SemanticRoleToken | null;
  candidateRole: SemanticRoleToken | null;
  referenceSide: OutcomeSide | null;
  candidateSide: OutcomeSide | null;
  referencePhase: CanonicalPhase | null;
  candidatePhase: CanonicalPhase | null;
  referenceInternalLabel: string | null;
  candidateInternalLabel: string | null;
  referenceCycleId: number | null;
  candidateCycleId: number | null;
  referenceOffsetSec: number | null;
  candidateOffsetSec: number | null;
  referencePrice: number | null;
  candidatePrice: number | null;
  offsetDeltaSec: number | null;
  priceDelta: number | null;
  mismatchSource: string;
}

export interface ChildOrderMicroTimingDetail {
  index: number;
  referenceSide: OutcomeSide | null;
  candidateSide: OutcomeSide | null;
  referencePhase: CanonicalPhase | null;
  candidatePhase: CanonicalPhase | null;
  referenceOffsetSec: number | null;
  candidateOffsetSec: number | null;
  offsetDeltaSec: number | null;
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
    sideSequenceMismatchDetails: SideSequenceMismatchDetail[];
    flowPairSideSetSimilarity: number;
    semanticRoleSequenceSimilarity: number;
    semanticRoleSequenceMismatchCount: number;
    semanticRoleSequenceMismatchDetails: SemanticRoleSequenceMismatchDetail[];
    completionReleaseRoleSimilarity: number;
    completionReleaseRoleMismatchCount: number;
    completionReleaseRoleMismatchDetails: SemanticRoleSequenceMismatchDetail[];
    flowPairRoleSetSimilarity: number;
    overlapFamilySimilarity: number;
    phaseFamilySimilarity: number;
    eventQtySimilarity: number;
    mergeClusterQtySimilarity: number;
    redeemClusterQtySimilarity: number;
    flowLineageSimilarity: number;
    activeFlowPeakSimilarity: number;
    cycleCompletionLatencySimilarity: number;
    openingEntryTimingSimilarity: number;
    childOrderMicroTimingSimilarity: number;
    childOrderMicroTimingMismatchCount: number;
    childOrderMicroTimingDetails: ChildOrderMicroTimingDetail[];
    childOrderSideInversionCount: number;
    childOrderGlobalDelayP50Sec: number;
    childOrderGlobalDelayP75Sec: number;
    childOrderGlobalAbsDelayP75Sec: number;
    childOrderMicroTimingDeltaP50Sec: number;
    childOrderMicroTimingDeltaP75Sec: number;
    childOrderMicroTimingMaxAbsDeltaSec: number;
    referenceActiveFlowPeak: number;
    candidateActiveFlowPeak: number;
    referenceFirstEntryOffsetSec: number | null;
    candidateFirstEntryOffsetSec: number | null;
    firstEntryOffsetDeltaSec: number | null;
    referenceAverageCycleCompletionLatencySec: number;
    candidateAverageCycleCompletionLatencySec: number;
    averageCycleCompletionLatencyDeltaSec: number;
    cycleCompletionLatencyDeltasSec: number[];
    cycleCompletionLatencyDeltaP50Sec: number;
    cycleCompletionLatencyDeltaP75Sec: number;
    cycleCompletionLatencyMaxAbsDeltaSec: number;
    exactLifecycleParityRequired: boolean;
    exactLifecycleParityBroken: boolean;
  };
}

export interface ComparisonFlowSummary {
  flowLineageSimilarity: number;
  activeFlowPeakSimilarity: number;
  cycleCompletionLatencySimilarity: number;
  openingEntryTimingSimilarity: number;
  childOrderMicroTimingSimilarity: number;
  childOrderMicroTimingMismatchCount: number;
  childOrderMicroTimingDetails: ChildOrderMicroTimingDetail[];
  childOrderSideInversionCount: number;
  childOrderGlobalDelayP50Sec: number;
  childOrderGlobalDelayP75Sec: number;
  childOrderGlobalAbsDelayP75Sec: number;
  childOrderMicroTimingDeltaP50Sec: number;
  childOrderMicroTimingDeltaP75Sec: number;
  childOrderMicroTimingMaxAbsDeltaSec: number;
  sideSequenceSimilarity: number;
  sideSequenceMismatchCount: number;
  sideSequenceMismatchDetails: SideSequenceMismatchDetail[];
  flowPairSideSetSimilarity: number;
  semanticRoleSequenceSimilarity: number;
  semanticRoleSequenceMismatchCount: number;
  semanticRoleSequenceMismatchDetails: SemanticRoleSequenceMismatchDetail[];
  completionReleaseRoleSimilarity: number;
  completionReleaseRoleMismatchCount: number;
  completionReleaseRoleMismatchDetails: SemanticRoleSequenceMismatchDetail[];
  flowPairRoleSetSimilarity: number;
  referenceActiveFlowPeak: number;
  candidateActiveFlowPeak: number;
  referenceFirstEntryOffsetSec: number | null;
  candidateFirstEntryOffsetSec: number | null;
  firstEntryOffsetDeltaSec: number | null;
  referenceAverageCycleCompletionLatencySec: number;
  candidateAverageCycleCompletionLatencySec: number;
  averageCycleCompletionLatencyDeltaSec: number;
  cycleCompletionLatencyDeltaP50Sec: number;
  cycleCompletionLatencyDeltaP75Sec: number;
  cycleCompletionLatencyMaxAbsDeltaSec: number;
  flowLineageScore: number;
  activeFlowPeakScore: number;
  cycleCompletionLatencyScore: number;
  openingEntryTimingScore: number;
  childOrderMicroTimingScore: number;
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
  averageOpeningEntryTimingSimilarity: number;
  averageChildOrderMicroTimingSimilarity: number;
  averageChildOrderMicroTimingMismatchCount: number;
  averageChildOrderSideInversionCount: number;
  averageChildOrderGlobalDelayP50Sec: number;
  averageChildOrderGlobalDelayP75Sec: number;
  averageChildOrderGlobalAbsDelayP75Sec: number;
  averageChildOrderMicroTimingDeltaP50Sec: number;
  averageChildOrderMicroTimingDeltaP75Sec: number;
  averageChildOrderMicroTimingMaxAbsDeltaSec: number;
  childOrderTimingDirection: "candidate_early" | "candidate_late" | "mixed" | "aligned";
  averageFirstEntryOffsetDeltaSec: number;
  openingEntryTimingDirection: "candidate_early" | "candidate_late" | "aligned";
  averageSideSequenceSimilarity: number;
  averageSideSequenceMismatchCount: number;
  averageSideSequenceMismatchOffsetDeltaSec: number;
  averageFlowPairSideSetSimilarity: number;
  averageSemanticRoleSequenceSimilarity: number;
  averageSemanticRoleSequenceMismatchCount: number;
  averageSemanticRoleMismatchOffsetDeltaSec: number;
  averageCompletionReleaseRoleSimilarity: number;
  averageCompletionReleaseRoleMismatchCount: number;
  averageCompletionReleaseRoleMismatchOffsetDeltaSec: number;
  averageFlowPairRoleSetSimilarity: number;
  roleSideTradeoffRisk: "none" | "side_preservation_blocks_role_alignment" | "role_alignment_may_break_side_sequence";
  averageCycleCompletionLatencyDeltaSec: number;
  averageCycleCompletionLatencyDeltaP50Sec: number;
  averageCycleCompletionLatencyDeltaP75Sec: number;
  averageCycleCompletionLatencyMaxAbsDeltaSec: number;
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
  mismatchDetails: SideSequenceMismatchDetail[];
} {
  const maxLength = Math.max(reference.buySequence.length, candidate.buySequence.length);
  if (maxLength === 0) {
    return {
      similarity: 1,
      mismatchCount: 0,
      mismatchDetails: [],
    };
  }
  const referenceBuys = reference.orderedClipSequence.filter((event) => event.kind === "BUY");
  const candidateBuys = candidate.orderedClipSequence.filter((event) => event.kind === "BUY");
  let samePositionMatches = 0;
  const mismatchDetails: SideSequenceMismatchDetail[] = [];
  for (let index = 0; index < maxLength; index += 1) {
    const referenceEvent = referenceBuys[index];
    const candidateEvent = candidateBuys[index];
    const referenceSide = reference.buySequence[index] ?? null;
    const candidateSide = candidate.buySequence[index] ?? null;
    if (referenceSide !== null && referenceSide === candidateSide) {
      samePositionMatches += 1;
      continue;
    }
    mismatchDetails.push(buildSideSequenceMismatchDetail(index, referenceEvent, candidateEvent));
  }
  return {
    similarity: samePositionMatches / maxLength,
    mismatchCount: mismatchDetails.length,
    mismatchDetails,
  };
}

function childOrderMicroTimingComparison(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): {
  similarity: number;
  mismatchCount: number;
  details: ChildOrderMicroTimingDetail[];
  deltasSec: number[];
  sideInversionCount: number;
  deltaP50Sec: number;
  deltaP75Sec: number;
  absDeltaP75Sec: number;
  maxAbsDeltaSec: number;
} {
  const referenceBuys = reference.orderedClipSequence.filter((event) => event.kind === "BUY");
  const candidateBuys = candidate.orderedClipSequence.filter((event) => event.kind === "BUY");
  const maxLength = Math.max(referenceBuys.length, candidateBuys.length);
  if (maxLength === 0) {
    return {
      similarity: 1,
      mismatchCount: 0,
      details: [],
      deltasSec: [],
      sideInversionCount: 0,
      deltaP50Sec: 0,
      deltaP75Sec: 0,
      absDeltaP75Sec: 0,
      maxAbsDeltaSec: 0,
    };
  }
  let score = 0;
  const details: ChildOrderMicroTimingDetail[] = [];
  const deltasSec: number[] = [];
  let sideInversionCount = 0;
  for (let index = 0; index < maxLength; index += 1) {
    const referenceEvent = referenceBuys[index];
    const candidateEvent = candidateBuys[index];
    const referenceOffset = referenceEvent?.tOffsetSec ?? null;
    const candidateOffset = candidateEvent?.tOffsetSec ?? null;
    const offsetDelta =
      referenceOffset === null || candidateOffset === null
        ? null
        : Number((candidateOffset - referenceOffset).toFixed(6));
    if (offsetDelta !== null) {
      deltasSec.push(offsetDelta);
    }
    if (
      referenceEvent?.outcome !== undefined &&
      referenceEvent.outcome !== null &&
      candidateEvent?.outcome !== undefined &&
      candidateEvent.outcome !== null &&
      referenceEvent.outcome !== candidateEvent.outcome
    ) {
      sideInversionCount += 1;
    }
    const timingScore = timingOffsetSimilarity(referenceOffset, candidateOffset, 2, 30);
    score += timingScore;
    if (timingScore < 0.999) {
      details.push({
        index,
        referenceSide: referenceEvent?.outcome ?? null,
        candidateSide: candidateEvent?.outcome ?? null,
        referencePhase: referenceEvent?.phase ?? null,
        candidatePhase: candidateEvent?.phase ?? null,
        referenceOffsetSec: referenceOffset,
        candidateOffsetSec: candidateOffset,
        offsetDeltaSec: offsetDelta,
      });
    }
  }
  const absoluteDeltas = deltasSec.map((delta) => Math.abs(delta));
  return {
    similarity: score / maxLength,
    mismatchCount: details.length,
    details,
    deltasSec,
    sideInversionCount,
    deltaP50Sec: percentileNumber(deltasSec, 0.5),
    deltaP75Sec: percentileNumber(deltasSec, 0.75),
    absDeltaP75Sec: percentileNumber(absoluteDeltas, 0.75),
    maxAbsDeltaSec: absoluteDeltas.length > 0 ? Number(Math.max(...absoluteDeltas).toFixed(6)) : 0,
  };
}

function cycleSideSetToken(events: CanonicalSequenceEvent[]): string {
  return events
    .filter((event) => event.kind === "BUY" && event.outcome !== null)
    .map((event) => event.outcome)
    .sort()
    .join("+");
}

function flowPairSideSetSimilarity(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): number {
  const group = (extract: CanonicalReferenceExtract): Map<number, string> => {
    const byCycle = new Map<number, CanonicalSequenceEvent[]>();
    for (const event of extract.orderedClipSequence) {
      if (event.kind !== "BUY") {
        continue;
      }
      const events = byCycle.get(event.cycleId) ?? [];
      events.push(event);
      byCycle.set(event.cycleId, events);
    }
    return new Map(
      [...byCycle.entries()]
        .map(([cycleId, events]) => [cycleId, cycleSideSetToken(events)] as const)
        .filter(([, token]) => token.length > 0),
    );
  };
  const left = group(reference);
  const right = group(candidate);
  const cycleIds = new Set([...left.keys(), ...right.keys()]);
  if (cycleIds.size === 0) {
    return 1;
  }
  let matches = 0;
  for (const cycleId of cycleIds) {
    if (left.get(cycleId) === right.get(cycleId)) {
      matches += 1;
    }
  }
  return matches / cycleIds.size;
}

type SemanticRoleToken =
  | "ENTRY_HIGH"
  | "ENTRY_MID"
  | "ENTRY_LOW"
  | "OVERLAP_HIGH"
  | "OVERLAP_MID"
  | "OVERLAP_LOW"
  | "COMPLETION_EXPENSIVE"
  | "COMPLETION_MID"
  | "COMPLETION_CHEAP"
  | "HIGH_LOW_COMPLETION_EXPENSIVE"
  | "HIGH_LOW_COMPLETION_MID"
  | "HIGH_LOW_COMPLETION_CHEAP";

function semanticRoleSequenceComparison(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): {
  similarity: number;
  mismatchCount: number;
  mismatchDetails: SemanticRoleSequenceMismatchDetail[];
} {
  const left = semanticRoleSequence(reference);
  const right = semanticRoleSequence(candidate);
  return compareSemanticRoleTokens(left, right);
}

function completionReleaseRoleSequenceComparison(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): {
  similarity: number;
  mismatchCount: number;
  mismatchDetails: SemanticRoleSequenceMismatchDetail[];
} {
  const completionTokens = (extract: CanonicalReferenceExtract): SemanticRoleEventToken[] =>
    semanticRoleSequence(extract).filter(
      (token) => token.event.phase === "COMPLETION" || token.event.phase === "HIGH_LOW_COMPLETION",
    );
  return compareSemanticRoleTokens(completionTokens(reference), completionTokens(candidate));
}

function compareSemanticRoleTokens(left: SemanticRoleEventToken[], right: SemanticRoleEventToken[]): {
  similarity: number;
  mismatchCount: number;
  mismatchDetails: SemanticRoleSequenceMismatchDetail[];
} {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return { similarity: 1, mismatchCount: 0, mismatchDetails: [] };
  }
  let matches = 0;
  const mismatchDetails: SemanticRoleSequenceMismatchDetail[] = [];
  for (let index = 0; index < maxLength; index += 1) {
    const referenceToken = left[index];
    const candidateToken = right[index];
    if (referenceToken !== undefined && candidateToken !== undefined && referenceToken.role === candidateToken.role) {
      matches += 1;
      continue;
    }
    mismatchDetails.push(buildSemanticRoleSequenceMismatchDetail(index, referenceToken, candidateToken));
  }
  return {
    similarity: matches / maxLength,
    mismatchCount: mismatchDetails.length,
    mismatchDetails,
  };
}

function flowPairRoleSetSimilarity(reference: CanonicalReferenceExtract, candidate: CanonicalReferenceExtract): number {
  const group = (extract: CanonicalReferenceExtract): Map<number, string> => {
    const byCycle = new Map<number, string[]>();
    for (const token of semanticRoleSequence(extract)) {
      const roles = byCycle.get(token.event.cycleId) ?? [];
      roles.push(token.role);
      byCycle.set(token.event.cycleId, roles);
    }
    return new Map(
      [...byCycle.entries()]
        .map(([cycleId, roles]) => [cycleId, roles.sort().join("+")] as const)
        .filter(([, token]) => token.length > 0),
    );
  };
  const left = group(reference);
  const right = group(candidate);
  const cycleIds = new Set([...left.keys(), ...right.keys()]);
  if (cycleIds.size === 0) {
    return 1;
  }
  let matches = 0;
  for (const cycleId of cycleIds) {
    if (left.get(cycleId) === right.get(cycleId)) {
      matches += 1;
    }
  }
  return matches / cycleIds.size;
}

interface SemanticRoleEventToken {
  role: SemanticRoleToken;
  event: CanonicalSequenceEvent;
}

function semanticRoleSequence(extract: CanonicalReferenceExtract): SemanticRoleEventToken[] {
  const buys = extract.orderedClipSequence.filter((event) => event.kind === "BUY");
  const byCycle = new Map<number, CanonicalSequenceEvent[]>();
  for (const event of buys) {
    const cycleEvents = byCycle.get(event.cycleId) ?? [];
    cycleEvents.push(event);
    byCycle.set(event.cycleId, cycleEvents);
  }
  return buys.map((event) => ({
    event,
    role: semanticRoleToken(event, byCycle.get(event.cycleId) ?? [event]),
  }));
}

function semanticRoleToken(
  event: CanonicalSequenceEvent,
  cycleEvents: CanonicalSequenceEvent[],
): SemanticRoleToken {
  const opener =
    cycleEvents.find((cycleEvent) => cycleEvent.phase === "ENTRY" || cycleEvent.phase === "OVERLAP") ??
    cycleEvents[0] ??
    event;
  const completion =
    cycleEvents.find(
      (cycleEvent) => cycleEvent.phase === "COMPLETION" || cycleEvent.phase === "HIGH_LOW_COMPLETION",
    ) ?? cycleEvents.find((cycleEvent) => cycleEvent !== opener);
  const counterpart = event === opener ? completion : opener;
  const priceDelta = event.price !== null && counterpart?.price !== null && counterpart?.price !== undefined
    ? Number((event.price - counterpart.price).toFixed(6))
    : 0;
  const role = priceDelta >= 0.08 ? "HIGH" : priceDelta <= -0.08 ? "LOW" : "MID";
  if (event.phase === "COMPLETION" || event.phase === "HIGH_LOW_COMPLETION") {
    const completionRole =
      role === "HIGH" ? "EXPENSIVE" : role === "LOW" ? "CHEAP" : "MID";
    return `COMPLETION_${completionRole}` as SemanticRoleToken;
  }
  return `${event.phase}_${role}` as SemanticRoleToken;
}

function buildSideSequenceMismatchDetail(
  index: number,
  referenceEvent: CanonicalSequenceEvent | undefined,
  candidateEvent: CanonicalSequenceEvent | undefined,
): SideSequenceMismatchDetail {
  const candidateSource =
    candidateEvent !== undefined
      ? `${phaseToken(candidateEvent.phase)}:${candidateEvent.internalLabel}`
      : "missing_candidate_buy";
  const offsetDeltaSec =
    referenceEvent === undefined || candidateEvent === undefined
      ? null
      : Number((candidateEvent.tOffsetSec - referenceEvent.tOffsetSec).toFixed(6));
  return {
    index,
    referenceSide: referenceEvent?.outcome ?? null,
    candidateSide: candidateEvent?.outcome ?? null,
    referencePhase: referenceEvent?.phase ?? null,
    candidatePhase: candidateEvent?.phase ?? null,
    referenceInternalLabel: referenceEvent?.internalLabel ?? null,
    candidateInternalLabel: candidateEvent?.internalLabel ?? null,
    referenceCycleId: referenceEvent?.cycleId ?? null,
    candidateCycleId: candidateEvent?.cycleId ?? null,
    referenceOffsetSec: referenceEvent?.tOffsetSec ?? null,
    candidateOffsetSec: candidateEvent?.tOffsetSec ?? null,
    offsetDeltaSec,
    mismatchSource: candidateSource,
  };
}

function buildSemanticRoleSequenceMismatchDetail(
  index: number,
  referenceToken: SemanticRoleEventToken | undefined,
  candidateToken: SemanticRoleEventToken | undefined,
): SemanticRoleSequenceMismatchDetail {
  const referenceEvent = referenceToken?.event;
  const candidateEvent = candidateToken?.event;
  const candidateSource =
    candidateToken !== undefined && candidateEvent !== undefined
      ? `${candidateToken.role}:${phaseToken(candidateEvent.phase)}:${candidateEvent.internalLabel}`
      : "missing_candidate_role";
  const offsetDeltaSec =
    referenceEvent === undefined || candidateEvent === undefined
      ? null
      : Number((candidateEvent.tOffsetSec - referenceEvent.tOffsetSec).toFixed(6));
  const priceDelta =
    referenceEvent?.price === null ||
    referenceEvent?.price === undefined ||
    candidateEvent?.price === null ||
    candidateEvent?.price === undefined
      ? null
      : Number((candidateEvent.price - referenceEvent.price).toFixed(6));

  return {
    index,
    referenceRole: referenceToken?.role ?? null,
    candidateRole: candidateToken?.role ?? null,
    referenceSide: referenceEvent?.outcome ?? null,
    candidateSide: candidateEvent?.outcome ?? null,
    referencePhase: referenceEvent?.phase ?? null,
    candidatePhase: candidateEvent?.phase ?? null,
    referenceInternalLabel: referenceEvent?.internalLabel ?? null,
    candidateInternalLabel: candidateEvent?.internalLabel ?? null,
    referenceCycleId: referenceEvent?.cycleId ?? null,
    candidateCycleId: candidateEvent?.cycleId ?? null,
    referenceOffsetSec: referenceEvent?.tOffsetSec ?? null,
    candidateOffsetSec: candidateEvent?.tOffsetSec ?? null,
    referencePrice: referenceEvent?.price ?? null,
    candidatePrice: candidateEvent?.price ?? null,
    offsetDeltaSec,
    priceDelta,
    mismatchSource: candidateSource,
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

function firstEntryOffsetSec(extract: CanonicalReferenceExtract): number | null {
  const firstEntry = extract.orderedClipSequence.find(
    (event) => event.kind === "BUY" && event.phase === "ENTRY",
  );
  return firstEntry?.tOffsetSec ?? null;
}

function timingOffsetSimilarity(
  referenceOffsetSec: number | null,
  candidateOffsetSec: number | null,
  toleranceSec = 2,
  fullPenaltyAfterSec = 20,
): number {
  if (referenceOffsetSec === null && candidateOffsetSec === null) return 1;
  if (referenceOffsetSec === null || candidateOffsetSec === null) return 0;
  const absoluteDelta = Math.abs(candidateOffsetSec - referenceOffsetSec);
  if (absoluteDelta <= toleranceSec) return 1;
  return Math.max(0, 1 - (absoluteDelta - toleranceSec) / fullPenaltyAfterSec);
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

function percentileNumber(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return Number((sorted[index] ?? 0).toFixed(6));
}

function cycleCompletionLatencyDeltas(reference: number[], candidate: number[]): number[] {
  const maxLength = Math.max(reference.length, candidate.length);
  const deltas: number[] = [];
  for (let index = 0; index < maxLength; index += 1) {
    deltas.push(Number(((candidate[index] ?? 0) - (reference[index] ?? 0)).toFixed(6)));
  }
  return deltas;
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
    openingEntryTimingSimilarity: comparison.details.openingEntryTimingSimilarity,
    childOrderMicroTimingSimilarity: comparison.details.childOrderMicroTimingSimilarity,
    childOrderMicroTimingMismatchCount: comparison.details.childOrderMicroTimingMismatchCount,
    childOrderMicroTimingDetails: comparison.details.childOrderMicroTimingDetails,
    childOrderSideInversionCount: comparison.details.childOrderSideInversionCount,
    childOrderGlobalDelayP50Sec: comparison.details.childOrderGlobalDelayP50Sec,
    childOrderGlobalDelayP75Sec: comparison.details.childOrderGlobalDelayP75Sec,
    childOrderGlobalAbsDelayP75Sec: comparison.details.childOrderGlobalAbsDelayP75Sec,
    childOrderMicroTimingDeltaP50Sec: comparison.details.childOrderMicroTimingDeltaP50Sec,
    childOrderMicroTimingDeltaP75Sec: comparison.details.childOrderMicroTimingDeltaP75Sec,
    childOrderMicroTimingMaxAbsDeltaSec: comparison.details.childOrderMicroTimingMaxAbsDeltaSec,
    sideSequenceSimilarity: comparison.details.sideSequenceSimilarity,
    sideSequenceMismatchCount: comparison.details.sideSequenceMismatchCount,
    sideSequenceMismatchDetails: comparison.details.sideSequenceMismatchDetails,
    flowPairSideSetSimilarity: comparison.details.flowPairSideSetSimilarity,
    semanticRoleSequenceSimilarity: comparison.details.semanticRoleSequenceSimilarity,
    semanticRoleSequenceMismatchCount: comparison.details.semanticRoleSequenceMismatchCount,
    semanticRoleSequenceMismatchDetails: comparison.details.semanticRoleSequenceMismatchDetails,
    completionReleaseRoleSimilarity: comparison.details.completionReleaseRoleSimilarity,
    completionReleaseRoleMismatchCount: comparison.details.completionReleaseRoleMismatchCount,
    completionReleaseRoleMismatchDetails: comparison.details.completionReleaseRoleMismatchDetails,
    flowPairRoleSetSimilarity: comparison.details.flowPairRoleSetSimilarity,
    referenceActiveFlowPeak: comparison.details.referenceActiveFlowPeak,
    candidateActiveFlowPeak: comparison.details.candidateActiveFlowPeak,
    referenceFirstEntryOffsetSec: comparison.details.referenceFirstEntryOffsetSec,
    candidateFirstEntryOffsetSec: comparison.details.candidateFirstEntryOffsetSec,
    firstEntryOffsetDeltaSec: comparison.details.firstEntryOffsetDeltaSec,
    referenceAverageCycleCompletionLatencySec: comparison.details.referenceAverageCycleCompletionLatencySec,
    candidateAverageCycleCompletionLatencySec: comparison.details.candidateAverageCycleCompletionLatencySec,
    averageCycleCompletionLatencyDeltaSec: comparison.details.averageCycleCompletionLatencyDeltaSec,
    cycleCompletionLatencyDeltaP50Sec: comparison.details.cycleCompletionLatencyDeltaP50Sec,
    cycleCompletionLatencyDeltaP75Sec: comparison.details.cycleCompletionLatencyDeltaP75Sec,
    cycleCompletionLatencyMaxAbsDeltaSec: comparison.details.cycleCompletionLatencyMaxAbsDeltaSec,
    flowLineageScore: comparison.breakdown.flowLineageScore,
    activeFlowPeakScore: comparison.breakdown.activeFlowPeakScore,
    cycleCompletionLatencyScore: comparison.breakdown.cycleCompletionLatencyScore,
    openingEntryTimingScore: comparison.breakdown.openingEntryTimingScore,
    childOrderMicroTimingScore: comparison.breakdown.childOrderMicroTimingScore,
  };
}

export function classifyComparisonFlowSummary(summary: ComparisonFlowSummary): ComparisonFlowStatus {
  const failReasons: string[] = [];
  const warnReasons: string[] = [];
  const openingEntryTimingSimilarity = summary.openingEntryTimingSimilarity ?? 1;
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
  if (openingEntryTimingSimilarity < 0.55) {
    failReasons.push("opening_entry_timing_similarity_low");
  } else if (openingEntryTimingSimilarity < 0.75) {
    warnReasons.push("opening_entry_timing_similarity_warn");
  }
  if ((summary.childOrderMicroTimingSimilarity ?? 1) < 0.75 || (summary.childOrderMicroTimingMismatchCount ?? 0) > 0) {
    warnReasons.push("child_order_micro_timing_similarity_warn");
  }
  if ((summary.childOrderGlobalAbsDelayP75Sec ?? 0) >= 4) {
    warnReasons.push("child_order_global_delay_warn");
  }
  if ((summary.childOrderSideInversionCount ?? 0) > 0) {
    warnReasons.push("child_order_side_inversion_warn");
  }
  if ((summary.sideSequenceSimilarity ?? 1) < 0.65) {
    failReasons.push("side_sequence_similarity_low");
  } else if ((summary.sideSequenceSimilarity ?? 1) < 0.9 || (summary.sideSequenceMismatchCount ?? 0) > 0) {
    warnReasons.push("side_sequence_similarity_warn");
  }
  if ((summary.semanticRoleSequenceSimilarity ?? 1) < 0.35) {
    failReasons.push("semantic_role_sequence_similarity_low");
  } else if ((summary.semanticRoleSequenceSimilarity ?? 1) < 0.7) {
    warnReasons.push("semantic_role_sequence_similarity_warn");
  }
  if ((summary.completionReleaseRoleSimilarity ?? 1) < 0.35) {
    failReasons.push("completion_release_role_similarity_low");
  } else if ((summary.completionReleaseRoleSimilarity ?? 1) < 0.7) {
    warnReasons.push("completion_release_role_similarity_warn");
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
  const averageMismatchOffsetDeltaSec = (): number => {
    const deltas = summaries.flatMap((summary) =>
      (summary.sideSequenceMismatchDetails ?? [])
        .map((detail) => detail.offsetDeltaSec)
        .filter((delta): delta is number => typeof delta === "number" && Number.isFinite(delta)),
    );
    return deltas.length > 0
      ? Number((deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length).toFixed(6))
      : 0;
  };
  const aggregate: ComparisonFlowSummary = {
    flowLineageSimilarity: average((summary) => summary.flowLineageSimilarity),
    activeFlowPeakSimilarity: average((summary) => summary.activeFlowPeakSimilarity),
    cycleCompletionLatencySimilarity: average((summary) => summary.cycleCompletionLatencySimilarity),
    openingEntryTimingSimilarity: average((summary) => summary.openingEntryTimingSimilarity ?? 1),
    childOrderMicroTimingSimilarity: average((summary) => summary.childOrderMicroTimingSimilarity ?? 1),
    childOrderMicroTimingMismatchCount: average((summary) => summary.childOrderMicroTimingMismatchCount ?? 0),
    childOrderMicroTimingDetails: summaries.flatMap((summary) => summary.childOrderMicroTimingDetails ?? []),
    childOrderSideInversionCount: average((summary) => summary.childOrderSideInversionCount ?? 0),
    childOrderGlobalDelayP50Sec: average((summary) => summary.childOrderGlobalDelayP50Sec ?? 0),
    childOrderGlobalDelayP75Sec: average((summary) => summary.childOrderGlobalDelayP75Sec ?? 0),
    childOrderGlobalAbsDelayP75Sec: average((summary) => summary.childOrderGlobalAbsDelayP75Sec ?? 0),
    childOrderMicroTimingDeltaP50Sec: average((summary) => summary.childOrderMicroTimingDeltaP50Sec ?? 0),
    childOrderMicroTimingDeltaP75Sec: average((summary) => summary.childOrderMicroTimingDeltaP75Sec ?? 0),
    childOrderMicroTimingMaxAbsDeltaSec: average((summary) => summary.childOrderMicroTimingMaxAbsDeltaSec ?? 0),
    sideSequenceSimilarity: average((summary) => summary.sideSequenceSimilarity ?? 1),
    sideSequenceMismatchCount: average((summary) => summary.sideSequenceMismatchCount ?? 0),
    sideSequenceMismatchDetails: summaries.flatMap((summary) => summary.sideSequenceMismatchDetails ?? []),
    flowPairSideSetSimilarity: average((summary) => summary.flowPairSideSetSimilarity ?? 1),
    semanticRoleSequenceSimilarity: average((summary) => summary.semanticRoleSequenceSimilarity ?? 1),
    semanticRoleSequenceMismatchCount: average((summary) => summary.semanticRoleSequenceMismatchCount ?? 0),
    semanticRoleSequenceMismatchDetails: summaries.flatMap(
      (summary) => summary.semanticRoleSequenceMismatchDetails ?? [],
    ),
    completionReleaseRoleSimilarity: average((summary) => summary.completionReleaseRoleSimilarity ?? 1),
    completionReleaseRoleMismatchCount: average((summary) => summary.completionReleaseRoleMismatchCount ?? 0),
    completionReleaseRoleMismatchDetails: summaries.flatMap(
      (summary) => summary.completionReleaseRoleMismatchDetails ?? [],
    ),
    flowPairRoleSetSimilarity: average((summary) => summary.flowPairRoleSetSimilarity ?? 1),
    referenceActiveFlowPeak: average((summary) => summary.referenceActiveFlowPeak),
    candidateActiveFlowPeak: average((summary) => summary.candidateActiveFlowPeak),
    referenceFirstEntryOffsetSec: average((summary) => summary.referenceFirstEntryOffsetSec ?? 0),
    candidateFirstEntryOffsetSec: average((summary) => summary.candidateFirstEntryOffsetSec ?? 0),
    firstEntryOffsetDeltaSec: average((summary) => summary.firstEntryOffsetDeltaSec ?? 0),
    referenceAverageCycleCompletionLatencySec: average((summary) => summary.referenceAverageCycleCompletionLatencySec ?? 0),
    candidateAverageCycleCompletionLatencySec: average((summary) => summary.candidateAverageCycleCompletionLatencySec ?? 0),
    averageCycleCompletionLatencyDeltaSec: average((summary) => summary.averageCycleCompletionLatencyDeltaSec ?? 0),
    cycleCompletionLatencyDeltaP50Sec: average(
      (summary) => summary.cycleCompletionLatencyDeltaP50Sec ?? summary.averageCycleCompletionLatencyDeltaSec ?? 0,
    ),
    cycleCompletionLatencyDeltaP75Sec: average(
      (summary) => summary.cycleCompletionLatencyDeltaP75Sec ?? summary.averageCycleCompletionLatencyDeltaSec ?? 0,
    ),
    cycleCompletionLatencyMaxAbsDeltaSec: average(
      (summary) =>
        summary.cycleCompletionLatencyMaxAbsDeltaSec ?? Math.abs(summary.averageCycleCompletionLatencyDeltaSec ?? 0),
    ),
    flowLineageScore: average((summary) => summary.flowLineageScore),
    activeFlowPeakScore: average((summary) => summary.activeFlowPeakScore),
    cycleCompletionLatencyScore: average((summary) => summary.cycleCompletionLatencyScore),
    openingEntryTimingScore: average((summary) => summary.openingEntryTimingScore ?? summary.openingEntryTimingSimilarity ?? 1),
    childOrderMicroTimingScore: average(
      (summary) => summary.childOrderMicroTimingScore ?? summary.childOrderMicroTimingSimilarity ?? 1,
    ),
  };
  const status = classifyComparisonFlowSummary(aggregate);
  const completionLatencyDirection =
    aggregate.averageCycleCompletionLatencyDeltaSec > 1
      ? "candidate_late"
      : aggregate.averageCycleCompletionLatencyDeltaSec < -1
        ? "candidate_early"
        : "aligned";
  const openingEntryTimingDirection =
    (aggregate.firstEntryOffsetDeltaSec ?? 0) > 2
      ? "candidate_late"
      : (aggregate.firstEntryOffsetDeltaSec ?? 0) < -2
        ? "candidate_early"
        : "aligned";
  const childOrderTimingDirection =
    Math.abs(aggregate.childOrderGlobalDelayP75Sec) <= 2 && aggregate.childOrderGlobalAbsDelayP75Sec <= 3
      ? "aligned"
      : aggregate.childOrderGlobalDelayP75Sec > 2
        ? "candidate_late"
        : aggregate.childOrderGlobalDelayP75Sec < -2
          ? "candidate_early"
          : "mixed";
  const recommendedFocus: string[] = status.reasons.map((reason) => {
    if (reason.includes("flow_lineage")) return "increase_lineage_preservation";
    if (reason.includes("active_flow_peak")) return "allow_more_parallel_flow_when_budget_supports";
    if (reason.includes("completion_latency")) {
      if (completionLatencyDirection === "candidate_late") return "release_completion_earlier";
      if (completionLatencyDirection === "candidate_early") return "increase_completion_patience";
      return "tune_completion_patience_and_release";
    }
    if (reason.includes("opening_entry_timing")) return "align_opening_seed_release";
    if (reason.includes("child_order_global_delay")) return "compress_child_order_timing";
    if (reason.includes("child_order_side_inversion")) return "stabilize_child_order_side_rhythm";
    if (reason.includes("child_order_micro_timing")) return "improve_child_order_micro_timing";
    if (reason.includes("side_sequence")) return "improve_seed_side_rhythm";
    if (reason.includes("semantic_role_sequence")) return "align_high_low_role_sequence";
    if (reason.includes("completion_release_role")) return "align_completion_release_role_sequence";
    return "inspect_flow_similarity";
  });
  const sideSequenceMismatchOffsetDeltaSec = averageMismatchOffsetDeltaSec();
  const semanticRoleMismatchOffsetDeltaSec = averageNumber(
    aggregate.semanticRoleSequenceMismatchDetails
      .map((detail) => detail.offsetDeltaSec)
      .filter((value): value is number => value !== null),
  );
  const completionReleaseRoleMismatchOffsetDeltaSec = averageNumber(
    aggregate.completionReleaseRoleMismatchDetails
      .map((detail) => detail.offsetDeltaSec)
      .filter((value): value is number => value !== null),
  );
  if (
    aggregate.sideSequenceMismatchCount > 0 &&
    sideSequenceMismatchOffsetDeltaSec >= 20
  ) {
    recommendedFocus.push("compress_overlap_seed_rhythm");
  }
  if (
    aggregate.sideSequenceMismatchCount > 0 &&
    aggregate.flowPairSideSetSimilarity >= 0.95 &&
    aggregate.sideSequenceSimilarity < 0.9
  ) {
    recommendedFocus.push("improve_child_order_micro_timing");
  }
  if (
    aggregate.semanticRoleSequenceMismatchCount > 0 &&
    aggregate.sideSequenceSimilarity >= 0.8 &&
    (aggregate.semanticRoleSequenceSimilarity < 0.7 || aggregate.semanticRoleSequenceMismatchCount >= 2)
  ) {
    recommendedFocus.push("preserve_raw_side_before_role_override");
  }
  const roleSideTradeoffRisk =
    aggregate.semanticRoleSequenceMismatchCount > 0 &&
    aggregate.sideSequenceSimilarity >= 0.8 &&
    (aggregate.semanticRoleSequenceSimilarity < 0.7 || aggregate.semanticRoleSequenceMismatchCount >= 2)
      ? "side_preservation_blocks_role_alignment"
      : aggregate.sideSequenceSimilarity < 0.8 &&
          aggregate.semanticRoleSequenceSimilarity >= 0.7
        ? "role_alignment_may_break_side_sequence"
        : "none";
  if (roleSideTradeoffRisk !== "none") {
    recommendedFocus.push("guard_role_alignment_against_side_regression");
  }
  if (
    aggregate.semanticRoleSequenceMismatchCount > 0 &&
    semanticRoleMismatchOffsetDeltaSec >= 20
  ) {
    recommendedFocus.push("compress_high_low_role_rhythm");
  }
  if (
    aggregate.completionReleaseRoleMismatchCount > 0 &&
    aggregate.completionReleaseRoleSimilarity < 0.98
  ) {
    recommendedFocus.push("tune_completion_role_release_order");
  }
  if ((aggregate.firstEntryOffsetDeltaSec ?? 0) >= 4) {
    recommendedFocus.push("release_opening_seed_earlier");
  } else if ((aggregate.firstEntryOffsetDeltaSec ?? 0) <= -4) {
    recommendedFocus.push("delay_opening_seed_release");
  } else if (sampleCount > 0 && aggregate.openingEntryTimingSimilarity >= 0.98 && status.status !== "PASS") {
    recommendedFocus.push("maintain_opening_seed_early");
  }
  return {
    sampleCount,
    averageFlowLineageSimilarity: aggregate.flowLineageSimilarity,
    averageActiveFlowPeakSimilarity: aggregate.activeFlowPeakSimilarity,
    averageCycleCompletionLatencySimilarity: aggregate.cycleCompletionLatencySimilarity,
    averageOpeningEntryTimingSimilarity: aggregate.openingEntryTimingSimilarity,
    averageChildOrderMicroTimingSimilarity: aggregate.childOrderMicroTimingSimilarity,
    averageChildOrderMicroTimingMismatchCount: aggregate.childOrderMicroTimingMismatchCount,
    averageChildOrderSideInversionCount: aggregate.childOrderSideInversionCount,
    averageChildOrderGlobalDelayP50Sec: aggregate.childOrderGlobalDelayP50Sec,
    averageChildOrderGlobalDelayP75Sec: aggregate.childOrderGlobalDelayP75Sec,
    averageChildOrderGlobalAbsDelayP75Sec: aggregate.childOrderGlobalAbsDelayP75Sec,
    averageChildOrderMicroTimingDeltaP50Sec: aggregate.childOrderMicroTimingDeltaP50Sec,
    averageChildOrderMicroTimingDeltaP75Sec: aggregate.childOrderMicroTimingDeltaP75Sec,
    averageChildOrderMicroTimingMaxAbsDeltaSec: aggregate.childOrderMicroTimingMaxAbsDeltaSec,
    childOrderTimingDirection,
    averageFirstEntryOffsetDeltaSec: aggregate.firstEntryOffsetDeltaSec ?? 0,
    openingEntryTimingDirection,
    averageSideSequenceSimilarity: aggregate.sideSequenceSimilarity,
    averageSideSequenceMismatchCount: aggregate.sideSequenceMismatchCount,
    averageSideSequenceMismatchOffsetDeltaSec: sideSequenceMismatchOffsetDeltaSec,
    averageFlowPairSideSetSimilarity: aggregate.flowPairSideSetSimilarity,
    averageSemanticRoleSequenceSimilarity: aggregate.semanticRoleSequenceSimilarity,
    averageSemanticRoleSequenceMismatchCount: aggregate.semanticRoleSequenceMismatchCount,
    averageSemanticRoleMismatchOffsetDeltaSec: semanticRoleMismatchOffsetDeltaSec,
    averageCompletionReleaseRoleSimilarity: aggregate.completionReleaseRoleSimilarity,
    averageCompletionReleaseRoleMismatchCount: aggregate.completionReleaseRoleMismatchCount,
    averageCompletionReleaseRoleMismatchOffsetDeltaSec: completionReleaseRoleMismatchOffsetDeltaSec,
    averageFlowPairRoleSetSimilarity: aggregate.flowPairRoleSetSimilarity,
    roleSideTradeoffRisk,
    averageCycleCompletionLatencyDeltaSec: aggregate.averageCycleCompletionLatencyDeltaSec,
    averageCycleCompletionLatencyDeltaP50Sec: aggregate.cycleCompletionLatencyDeltaP50Sec,
    averageCycleCompletionLatencyDeltaP75Sec: aggregate.cycleCompletionLatencyDeltaP75Sec,
    averageCycleCompletionLatencyMaxAbsDeltaSec: aggregate.cycleCompletionLatencyMaxAbsDeltaSec,
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
    requireExactLifecycleParity?: boolean | undefined;
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
  const childOrderMicroTiming = childOrderMicroTimingComparison(reference, candidate);
  const pairSideSetSimilarity = flowPairSideSetSimilarity(reference, candidate);
  const semanticRoleSequence = semanticRoleSequenceComparison(reference, candidate);
  const completionReleaseRoleSequence = completionReleaseRoleSequenceComparison(reference, candidate);
  const pairRoleSetSimilarity = flowPairRoleSetSimilarity(reference, candidate);
  const overlapFamily = overlapSimilarity(reference, candidate);
  const phaseFamily = phaseFamilySimilarity(reference, candidate);
  const eventQty = buyEventQtySimilarity(reference, candidate);
  const mergeClusterQty = clusterQtySimilarity(reference, candidate, "MERGE");
  const redeemClusterQty = clusterQtySimilarity(reference, candidate, "REDEEM");
  const exactLifecycleParityRequired = Boolean(options?.requireExactLifecycleParity);
  const exactLifecycleParityBroken =
    exactLifecycleParityRequired &&
    (reference.buySequence.length !== candidate.buySequence.length ||
      reference.mergeCount !== candidate.mergeCount ||
      reference.redeemCount !== candidate.redeemCount ||
      mergeClusterQty < 0.999 ||
      redeemClusterQty < 0.999);
  const lineageFlow = flowLineageSimilarity(reference, candidate);
  const referenceActiveFlowPeak = activeFlowPeak(reference);
  const candidateActiveFlowPeak = activeFlowPeak(candidate);
  const referenceCompletionLatencies = cycleCompletionLatencies(reference);
  const candidateCompletionLatencies = cycleCompletionLatencies(candidate);
  const referenceFirstEntryOffsetSec = firstEntryOffsetSec(reference);
  const candidateFirstEntryOffsetSec = firstEntryOffsetSec(candidate);
  const firstEntryOffsetDeltaSec =
    referenceFirstEntryOffsetSec === null || candidateFirstEntryOffsetSec === null
      ? null
      : Number((candidateFirstEntryOffsetSec - referenceFirstEntryOffsetSec).toFixed(6));
  const referenceAverageCycleCompletionLatencySec = averageNumber(referenceCompletionLatencies);
  const candidateAverageCycleCompletionLatencySec = averageNumber(candidateCompletionLatencies);
  const averageCycleCompletionLatencyDeltaSec = Number(
    (candidateAverageCycleCompletionLatencySec - referenceAverageCycleCompletionLatencySec).toFixed(6),
  );
  const completionLatencyDeltas = cycleCompletionLatencyDeltas(referenceCompletionLatencies, candidateCompletionLatencies);
  const absoluteCompletionLatencyDeltas = completionLatencyDeltas.map((delta) => Math.abs(delta));
  const cycleCompletionLatencyDeltaP50Sec = percentileNumber(completionLatencyDeltas, 0.5);
  const cycleCompletionLatencyDeltaP75Sec = percentileNumber(completionLatencyDeltas, 0.75);
  const cycleCompletionLatencyMaxAbsDeltaSec =
    absoluteCompletionLatencyDeltas.length > 0 ? Math.max(...absoluteCompletionLatencyDeltas) : 0;
  const activeFlowPeakSimilarity = boundedRatioSimilarity(referenceActiveFlowPeak, candidateActiveFlowPeak);
  const cycleCompletionLatencySimilarity = sequenceQtySimilarity(
    referenceCompletionLatencies,
    candidateCompletionLatencies,
  );
  const openingEntryTimingSimilarity = timingOffsetSimilarity(
    referenceFirstEntryOffsetSec,
    candidateFirstEntryOffsetSec,
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
    sideSequence.similarity * 2.4 +
    pairSideSetSimilarity * 0.6 +
    semanticRoleSequence.similarity * 1.7 +
    completionReleaseRoleSequence.similarity * 0.8 +
    pairRoleSetSimilarity * 0.3 +
    overlapFamily * 4 +
    phaseFamily * 4 +
    eventQty * 5 +
    mergeClusterQty * 3 +
    redeemClusterQty * 3 +
    lineageFlow * 3 +
    activeFlowPeakSimilarity * 1 +
    cycleCompletionLatencySimilarity * 1 +
    childOrderMicroTiming.similarity * 0.6;

  const score = Math.round((correctnessScore + familyScore) * 100) / 100;

  let verdict: ComparatorVerdict;
  if (hardFailTotal > 0 || exactLifecycleParityBroken) {
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
      flowPairSideSetScore: pairSideSetSimilarity,
      semanticRoleSequenceScore: semanticRoleSequence.similarity,
      completionReleaseRoleScore: completionReleaseRoleSequence.similarity,
      flowPairRoleSetScore: pairRoleSetSimilarity,
      overlapFamilyScore: overlapFamily,
      phaseFamilyScore: phaseFamily,
      eventQtyScore: eventQty,
      mergeClusterQtyScore: mergeClusterQty,
      redeemClusterQtyScore: redeemClusterQty,
      flowLineageScore: lineageFlow,
      activeFlowPeakScore: activeFlowPeakSimilarity,
      cycleCompletionLatencyScore: cycleCompletionLatencySimilarity,
      openingEntryTimingScore: openingEntryTimingSimilarity,
      childOrderMicroTimingScore: childOrderMicroTiming.similarity,
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
      sideSequenceMismatchDetails: sideSequence.mismatchDetails,
      flowPairSideSetSimilarity: pairSideSetSimilarity,
      semanticRoleSequenceSimilarity: semanticRoleSequence.similarity,
      semanticRoleSequenceMismatchCount: semanticRoleSequence.mismatchCount,
      semanticRoleSequenceMismatchDetails: semanticRoleSequence.mismatchDetails,
      completionReleaseRoleSimilarity: completionReleaseRoleSequence.similarity,
      completionReleaseRoleMismatchCount: completionReleaseRoleSequence.mismatchCount,
      completionReleaseRoleMismatchDetails: completionReleaseRoleSequence.mismatchDetails,
      flowPairRoleSetSimilarity: pairRoleSetSimilarity,
      overlapFamilySimilarity: overlapFamily,
      phaseFamilySimilarity: phaseFamily,
      eventQtySimilarity: eventQty,
      mergeClusterQtySimilarity: mergeClusterQty,
      redeemClusterQtySimilarity: redeemClusterQty,
      flowLineageSimilarity: lineageFlow,
      activeFlowPeakSimilarity,
      cycleCompletionLatencySimilarity,
      openingEntryTimingSimilarity,
      childOrderMicroTimingSimilarity: childOrderMicroTiming.similarity,
      childOrderMicroTimingMismatchCount: childOrderMicroTiming.mismatchCount,
      childOrderMicroTimingDetails: childOrderMicroTiming.details,
      childOrderSideInversionCount: childOrderMicroTiming.sideInversionCount,
      childOrderGlobalDelayP50Sec: childOrderMicroTiming.deltaP50Sec,
      childOrderGlobalDelayP75Sec: childOrderMicroTiming.deltaP75Sec,
      childOrderGlobalAbsDelayP75Sec: childOrderMicroTiming.absDeltaP75Sec,
      childOrderMicroTimingDeltaP50Sec: childOrderMicroTiming.deltaP50Sec,
      childOrderMicroTimingDeltaP75Sec: childOrderMicroTiming.deltaP75Sec,
      childOrderMicroTimingMaxAbsDeltaSec: childOrderMicroTiming.maxAbsDeltaSec,
      referenceActiveFlowPeak,
      candidateActiveFlowPeak,
      referenceFirstEntryOffsetSec,
      candidateFirstEntryOffsetSec,
      firstEntryOffsetDeltaSec,
      referenceAverageCycleCompletionLatencySec,
      candidateAverageCycleCompletionLatencySec,
      averageCycleCompletionLatencyDeltaSec,
      cycleCompletionLatencyDeltasSec: completionLatencyDeltas,
      cycleCompletionLatencyDeltaP50Sec,
      cycleCompletionLatencyDeltaP75Sec,
      cycleCompletionLatencyMaxAbsDeltaSec: Number(cycleCompletionLatencyMaxAbsDeltaSec.toFixed(6)),
      exactLifecycleParityRequired,
      exactLifecycleParityBroken,
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
