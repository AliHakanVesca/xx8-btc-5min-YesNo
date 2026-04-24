import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { ExecutionQuote } from "./orderBookState.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { pairCostWithBothTaker, completionCost, takerFeePerShare } from "./sumAvgEngine.js";
import {
  absoluteShareGap,
  averageCost,
  averageEffectiveCost,
  mergeableShares,
  oldestResidualLotTimestamp,
  projectedShareGapAfterBuy,
} from "./inventoryState.js";
import type { FillRecord, XuanMarketState } from "./marketState.js";
import {
  classifyResidualSeverity,
  completionAllowance,
  completionQualitySkipReason,
  classifyCompletionReleaseRole,
  type CompletionReleaseRole,
  deriveFlowPressureBudgetState,
  highSideCompletionQualitySkipReason,
  residualSeverityPressure,
  resolveResidualBehaviorState,
  type FlowPressureBudgetState,
  type OverlapRepairArbitration,
  pairEntryCap,
  pairSweepAllowance,
  resolvePartialCompletionPhase,
  resolveResidualCompletionDelayProfile,
} from "./modePolicy.js";
import { OrderBookState } from "./orderBookState.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import { buildTakerBuyOrder } from "./marketOrderBuilder.js";
import {
  resolveBundledCompletionSequencePrior,
  resolveBundledLateCheapGuardSec,
  resolveBundledOpenSequencePrior,
  resolveBundledSeedSequencePrior,
} from "../../analytics/xuanExactReference.js";
import {
  fairValueGate,
  isCloneRepairFairValueFallbackSnapshot,
  type FairValueSnapshot,
} from "./fairValueEngine.js";

export type EntryBuyReason =
  | "balanced_pair_seed"
  | "balanced_pair_reentry"
  | "lagging_rebalance"
  | "temporal_single_leg_seed";

export type CycleQualityLabel = "STRONG_PAIR" | "ACCEPTABLE_PAIR" | "BORDERLINE_PAIR" | "BAD_PAIR";
type XuanBorderlineEntryPhase = "aggressive" | "mid" | "late";

export interface InventoryTraceState {
  upShares: number;
  downShares: number;
  mergeableShares: number;
  shareGap: number;
  upAveragePrice: number;
  downAveragePrice: number;
}

export interface EntryBuyDecision {
  side: OutcomeSide;
  size: number;
  reason: EntryBuyReason;
  mode: StrategyExecutionMode;
  expectedAveragePrice: number;
  effectivePricePerShare: number;
  negativeEdgeUsdc?: number | undefined;
  pairCostWithFees?: number | undefined;
  rawPairCost?: number | undefined;
  order: MarketOrderArgs;
}

export interface BalancedPairCandidateTrace {
  requestedSize: number;
  upFilledSize: number;
  downFilledSize: number;
  upAveragePrice: number;
  downAveragePrice: number;
  upLimitPrice: number;
  downLimitPrice: number;
  rawPairCost: number;
  rawPair?: number | undefined;
  pairCost: number;
  effectivePair?: number | undefined;
  pairEdge: number;
  feeUSDC?: number | undefined;
  expectedNetIfMerged?: number | undefined;
  cycleQualityLabel?: CycleQualityLabel | undefined;
  cycleSkippedReason?: string | undefined;
  xuanBorderlinePhase?: XuanBorderlineEntryPhase | undefined;
  fairValueFallbackReason?: string | undefined;
  stagedEntry?: boolean | undefined;
  plannedOppositeSide?: OutcomeSide | undefined;
  plannedOppositeQty?: number | undefined;
  negativeEdgeUsdc: number;
  verdict: "ok" | "up_depth" | "down_depth" | "pair_cap" | "orphan_risk";
  selectedMode?: StrategyExecutionMode | undefined;
  gateReason?: string | undefined;
  upOrphanRisk?: OrphanRiskTrace | undefined;
  downOrphanRisk?: OrphanRiskTrace | undefined;
}

export interface OrphanRiskTrace {
  allowed: boolean;
  effectivePrice: number;
  notionalUsdc: number;
  marketOrphanNotionalUsdc: number;
  fairValue?: number | undefined;
  fairPremium?: number | undefined;
  reason?: string | undefined;
}

export interface SingleLegSeedCandidateTrace {
  side: OutcomeSide;
  requestedSize: number;
  filledSize: number;
  sizingMode?: "standard" | "rhythm_micro" | undefined;
  semanticRoleTarget?: "neutral" | "mid_pair" | "high_low_setup" | "raw_side_preserve" | undefined;
  oppositeFilledSize?: number | undefined;
  oppositeCoverageRatio?: number | undefined;
  classifierScore?: number | undefined;
  priorityScore?: number | undefined;
  priorityScoreDelta?: number | undefined;
  completionRoleOrderScore?: number | undefined;
  averagePrice: number;
  limitPrice: number;
  effectivePricePerShare: number;
  referencePairCost: number;
  rawPair?: number | undefined;
  effectivePair?: number | undefined;
  feeUSDC?: number | undefined;
  expectedNetIfMerged?: number | undefined;
  cycleQualityLabel?: CycleQualityLabel | undefined;
  cycleSkippedReason?: string | undefined;
  xuanBorderlinePhase?: XuanBorderlineEntryPhase | undefined;
  fairValueFallbackReason?: string | undefined;
  stagedEntry?: boolean | undefined;
  plannedOppositeSide?: OutcomeSide | undefined;
  plannedOppositeQty?: number | undefined;
  negativeEdgeUsdc: number;
  orphanRisk?: OrphanRiskTrace | undefined;
  allowed: boolean;
  selectedMode?: StrategyExecutionMode | undefined;
  skipReason?: string | undefined;
}

export interface EntryDecisionTrace {
  mode: "disabled" | "balanced_pair" | "lagging_rebalance" | "temporal_pair_cycle";
  requestedLot: number;
  totalShares: number;
  shareGap: number;
  pairCap: number;
  selectedMode?: StrategyExecutionMode;
  skipReason?: string;
  gatedByRisk?: boolean;
  bestRawPair?: number;
  bestEffectivePair?: number;
  rawPair?: number;
  effectivePair?: number;
  feeUSDC?: number;
  expectedNetIfMerged?: number;
  stateBefore?: InventoryTraceState;
  stateAfter?: InventoryTraceState;
  cycleQualityLabel?: CycleQualityLabel;
  cycleOpenedReason?: EntryBuyReason | "controlled_overlap_pair" | "protected_residual_overlap_seed";
  cycleSkippedReason?: string;
  stagedEntry?: boolean;
  plannedOppositeSide?: OutcomeSide;
  plannedOppositeQty?: number;
  completionHoldSec?: number;
  recentBadCycleCount?: number;
  lastCycleNet?: number;
  lastCycleClosedAt?: number;
  freshCycleRequestedLotCap?: number;
  candidates: BalancedPairCandidateTrace[];
  seedCandidates?: SingleLegSeedCandidateTrace[] | undefined;
  laggingSide?: OutcomeSide;
  repairSize?: number;
  repairFilledSize?: number;
  repairCost?: number;
  repairAllowed?: boolean;
  repairCapMode?: "strict" | "soft" | "hard" | "emergency";
  repairRequestedQty?: number;
  repairFinalQty?: number;
  repairOldGap?: number;
  repairNewGap?: number;
  repairWouldIncreaseImbalance?: boolean;
  repairMissingQty?: number;
  repairOppositeAveragePrice?: number;
  repairHighLowMismatch?: boolean;
  repairSizingMode?: "standard" | "micro_fallback" | undefined;
  completionReleaseRole?: CompletionReleaseRole | undefined;
  completionCalibrationPatienceMultiplier?: number | undefined;
  completionRolePatienceMultiplier?: number | undefined;
  completionEffectivePatienceMultiplier?: number | undefined;
  completionWaitUntilSec?: number | undefined;
  repairCandidateCount?: number | undefined;
  residualSeverityLevel?: "flat" | "micro" | "small" | "medium" | "aggressive";
  overlapRepairArbitration?: OverlapRepairArbitration;
  overlapRepairReason?: string;
  overlapRepairOutcome?: "overlap_seed" | "pair_reentry" | "repair" | "wait" | "blocked";
  sideRhythmIntendedSide?: OutcomeSide | undefined;
  sideRhythmSelectedSide?: OutcomeSide | undefined;
  sideRhythmRejectedSide?: OutcomeSide | undefined;
  sideRhythmScoreDelta?: number | undefined;
  sideRhythmDecision?: "kept_priority" | "rhythm_override" | "rhythm_micro_fallback" | "no_viable_rhythm_side" | undefined;
  childOrderIntendedSide?: OutcomeSide | undefined;
  childOrderSelectedSide?: OutcomeSide | undefined;
  childOrderReason?:
    | "default"
    | "flow_intent"
    | "high_low_price"
    | "recent_completion"
    | "temporal_priority"
    | "covered_seed_priority"
    | undefined;
  semanticRoleTarget?: "neutral" | "mid_pair" | "high_low_setup" | "raw_side_preserve" | undefined;
  completionRoleReleaseOrderBias?: "neutral" | "role_order" | undefined;
}

export interface EntryEvaluation {
  decisions: EntryBuyDecision[];
  trace: EntryDecisionTrace;
}

export interface EntryLadderContext {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
  dailyNegativeEdgeSpentUsdc?: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  allowControlledOverlap?: boolean | undefined;
  protectedResidualShares?: number | undefined;
  protectedResidualSide?: OutcomeSide | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  pairGatePressure?: number | undefined;
  forcedOverlapRepairArbitration?: OverlapRepairArbitration | undefined;
  preferredOverlapSeedSide?: OutcomeSide | undefined;
  carryFlowConfidence?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  flowPressureState?: FlowPressureBudgetState | undefined;
  openingSeedReleaseBias?: "neutral" | "earlier" | "later" | undefined;
  semanticRoleAlignmentBias?:
    | "neutral"
    | "align_high_low_role"
    | "preserve_raw_side"
    | "cycle_role_arbitration"
    | undefined;
  completionPatienceMultiplier?: number | undefined;
  childOrderMicroTimingBias?: "neutral" | "flow_intent" | undefined;
  completionRoleReleaseOrderBias?: "neutral" | "role_order" | undefined;
}

interface BalancedPairCandidate {
  requestedSize: number;
  rawPairCost: number;
  pairCost: number;
  feeUSDC: number;
  expectedNetIfMerged: number;
  cycleQualityLabel: CycleQualityLabel;
  mode: Extract<
    StrategyExecutionMode,
    "STRICT_PAIR_SWEEP" | "XUAN_SOFT_PAIR_SWEEP" | "XUAN_HARD_PAIR_SWEEP"
  >;
  negativeEdgeUsdc: number;
  upExecution: ExecutionQuote;
  downExecution: ExecutionQuote;
}

interface TemporalSeedCandidate {
  side: OutcomeSide;
  requestedSize: number;
  sizingMode: "standard" | "rhythm_micro";
  seedQuote: ExecutionQuote;
  oppositeQuote: ExecutionQuote;
  executableSize: number;
  oppositeFilledSize: number;
  oppositeCoverageRatio: number;
  effectivePricePerShare: number;
  referencePairCost: number;
  negativeEdgeUsdc: number;
  rawPairCost: number;
  feeUSDC: number;
  expectedNetIfMerged: number;
  cycleQualityLabel: CycleQualityLabel;
  orphanRisk: OrphanRiskTrace;
  fairValueDecision: { allowed: boolean; reason?: string | undefined };
  classifierScore: number;
  skipReason?: string | undefined;
}

export function chooseEntryBuys(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
): EntryBuyDecision[] {
  return evaluateEntryBuys(config, state, books, ctx).decisions;
}

interface ClosedCycleQuality {
  openedAt: number;
  closedAt: number;
  shares: number;
  rawPair: number;
  effectivePair: number;
  feeUSDC: number;
  expectedNetIfMerged: number;
  cycleQualityLabel: CycleQualityLabel;
}

interface FreshCycleStats {
  closedCycles: ClosedCycleQuality[];
  recentBadCycleCount: number;
  lastCycle?: ClosedCycleQuality | undefined;
  lastBadCycle?: ClosedCycleQuality | undefined;
}

interface FreshCycleGateContext {
  stats: FreshCycleStats;
  referencePriorActive: boolean;
}

type FreshCycleEntryRoute = "balanced_pair" | "temporal_seed" | "covered_seed";

interface FreshCycleCandidateContext {
  route: FreshCycleEntryRoute;
  ctx: EntryLadderContext;
  requestedSize: number;
  rawPair?: number | undefined;
  effectivePair?: number | undefined;
}

interface XuanBorderlineEntryPolicy {
  phase: XuanBorderlineEntryPhase;
  maxQty: number;
  rawPairCap: number;
  effectivePairCap: number;
}

function normalizeTraceNumber(value: number): number {
  return Number(value.toFixed(6));
}

function inventoryTraceState(state: XuanMarketState): InventoryTraceState {
  return {
    upShares: normalizeTraceNumber(state.upShares),
    downShares: normalizeTraceNumber(state.downShares),
    mergeableShares: normalizeTraceNumber(mergeableShares(state)),
    shareGap: normalizeTraceNumber(Math.abs(state.upShares - state.downShares)),
    upAveragePrice: normalizeTraceNumber(averageCost(state, "UP")),
    downAveragePrice: normalizeTraceNumber(averageCost(state, "DOWN")),
  };
}

function projectedStateAfterCycleBuys(
  state: XuanMarketState,
  upSize: number,
  downSize: number,
  upAveragePrice: number,
  downAveragePrice: number,
): InventoryTraceState {
  const upShares = state.upShares + upSize;
  const downShares = state.downShares + downSize;
  const upCost = state.upCost + upSize * upAveragePrice;
  const downCost = state.downCost + downSize * downAveragePrice;
  return {
    upShares: normalizeTraceNumber(upShares),
    downShares: normalizeTraceNumber(downShares),
    mergeableShares: normalizeTraceNumber(Math.min(upShares, downShares)),
    shareGap: normalizeTraceNumber(Math.abs(upShares - downShares)),
    upAveragePrice: normalizeTraceNumber(upCost / Math.max(upShares, 1e-9)),
    downAveragePrice: normalizeTraceNumber(downCost / Math.max(downShares, 1e-9)),
  };
}

function classifyCycleQuality(
  config: XuanStrategyConfig,
  effectivePair: number,
  rawPair?: number | undefined,
): CycleQualityLabel {
  if (effectivePair <= config.strictNewCycleCap + 1e-9) {
    return "STRONG_PAIR";
  }
  if (effectivePair <= config.softNewCycleCap + 1e-9) {
    return "ACCEPTABLE_PAIR";
  }
  if (effectivePair <= config.hardNewCycleCap + 1e-9) {
    return "BORDERLINE_PAIR";
  }
  if (
    config.botMode === "XUAN" &&
    config.xuanBorderlineEntryEnabled &&
    rawPair !== undefined &&
    rawPair <= config.xuanBorderlineRawPairCap + 1e-9 &&
    effectivePair <= config.xuanBorderlineEffectivePairCap + 1e-9
  ) {
    return "BORDERLINE_PAIR";
  }
  return "BAD_PAIR";
}

function cycleQualityAllowedForFresh(
  config: XuanStrategyConfig,
  quality: CycleQualityLabel,
  stats: FreshCycleStats,
): boolean {
  if (quality === "STRONG_PAIR" || quality === "ACCEPTABLE_PAIR") {
    return true;
  }
  return (
    quality === "BORDERLINE_PAIR" &&
    config.allowHardNewCycleOnlyIfPreviousCyclePositive &&
    (stats.lastCycle?.expectedNetIfMerged ?? 0) > 0
  );
}

function xuanBorderlineEntryPolicy(
  config: XuanStrategyConfig,
  ctx: EntryLadderContext,
): XuanBorderlineEntryPolicy | undefined {
  if (config.botMode !== "XUAN" || !config.xuanBorderlineEntryEnabled) {
    return undefined;
  }
  if (ctx.secsFromOpen < Math.max(0, config.enterFromOpenSecMin)) {
    return undefined;
  }
  if (ctx.secsToClose <= Math.max(config.finalWindowCompletionOnlySec, config.finalWindowNoChaseSec)) {
    return undefined;
  }
  if (ctx.secsFromOpen <= config.xuanBorderlineEntryMaxAgeSec + 1e-9) {
    return {
      phase: "aggressive",
      maxQty: config.xuanBorderlineEntryMaxQty,
      rawPairCap: config.xuanBorderlineRawPairCap,
      effectivePairCap: config.xuanBorderlineEffectivePairCap,
    };
  }
  if (ctx.secsFromOpen <= config.xuanBorderlineEntryMidMaxAgeSec + 1e-9) {
    return {
      phase: "mid",
      maxQty: config.xuanBorderlineEntryMidMaxQty,
      rawPairCap: config.xuanBorderlineMidRawPairCap,
      effectivePairCap: config.xuanBorderlineMidEffectivePairCap,
    };
  }
  if (ctx.secsFromOpen <= Math.min(config.enterFromOpenSecMax, config.xuanBorderlineEntryLateMaxAgeSec) + 1e-9) {
    return {
      phase: "late",
      maxQty: config.xuanBorderlineEntryLateMaxQty,
      rawPairCap: config.xuanBorderlineLateRawPairCap,
      effectivePairCap: config.xuanBorderlineLateEffectivePairCap,
    };
  }
  return undefined;
}

function borderlineEntryMaxQtyForAge(config: XuanStrategyConfig, ctx: EntryLadderContext): number {
  return xuanBorderlineEntryPolicy(config, ctx)?.maxQty ?? 0;
}

function borderlineFreshEntryAllowed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  stats: FreshCycleStats,
  candidateContext: FreshCycleCandidateContext | undefined,
): boolean {
  if (!candidateContext || config.botMode !== "XUAN" || !config.xuanBorderlineEntryEnabled) {
    return false;
  }
  if (config.xuanBorderlineEntryRequiresCoveredSeed && candidateContext.route !== "covered_seed") {
    return false;
  }
  if (candidateContext.route === "temporal_seed" && !config.allowTemporalSingleLegSeed) {
    return false;
  }
  if (candidateContext.route === "covered_seed" && !config.allowXuanCoveredSeed) {
    return false;
  }
  if (stats.recentBadCycleCount >= config.maxConsecutiveBadCycles) {
    return false;
  }
  const shareGap = Math.abs(state.upShares - state.downShares);
  if (shareGap > Math.max(config.postMergeFlatDustShares, 1e-6)) {
    return false;
  }
  const policy = xuanBorderlineEntryPolicy(config, candidateContext.ctx);
  if (!policy) {
    return false;
  }
  if (candidateContext.requestedSize > policy.maxQty + 1e-6) {
    return false;
  }
  if (
    candidateContext.rawPair !== undefined &&
    candidateContext.rawPair > policy.rawPairCap + 1e-9
  ) {
    return false;
  }
  if (
    candidateContext.effectivePair !== undefined &&
    candidateContext.effectivePair > policy.effectivePairCap + 1e-9
  ) {
    return false;
  }
  return true;
}

function borderlineSamePatternSkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  stats: FreshCycleStats,
  candidateContext: FreshCycleCandidateContext | undefined,
  quality: CycleQualityLabel,
): string | undefined {
  if (
    config.botMode !== "XUAN" ||
    quality !== "BORDERLINE_PAIR" ||
    !stats.lastCycle ||
    stats.lastCycle.expectedNetIfMerged >= -1e-9 ||
    !candidateContext?.effectivePair ||
    config.borderlinePairRepeatCooldownSec <= 0
  ) {
    return undefined;
  }

  const nowTs = state.market.startTs + candidateContext.ctx.secsFromOpen;
  if (nowTs - stats.lastCycle.closedAt > config.borderlinePairRepeatCooldownSec) {
    return undefined;
  }

  const requiredImprovement = Math.max(0, config.borderlinePairRepeatMinEffectiveImprovement);
  if (candidateContext.effectivePair <= stats.lastCycle.effectivePair - requiredImprovement + 1e-9) {
    return undefined;
  }

  return "borderline_same_pattern_repeat";
}

function borderlineStagedResidualAgeSec(
  state: XuanMarketState,
  leadingSide: OutcomeSide,
  nowTs: number,
): number | undefined {
  const lots = leadingSide === "UP" ? state.upLots : state.downLots;
  const stagedLots = lots.filter((lot) => lot.executionMode === "PAIRGROUP_COVERED_SEED");
  if (stagedLots.length === 0) {
    return undefined;
  }
  return Math.max(0, nowTs - Math.min(...stagedLots.map((lot) => lot.timestamp)));
}

function cycleFeeUSDC(rawPair: number, effectivePair: number, shares: number): number {
  return normalizeTraceNumber(Math.max(0, effectivePair - rawPair) * shares);
}

function expectedNetIfMerged(effectivePair: number, shares: number): number {
  return normalizeTraceNumber((1 - effectivePair) * shares);
}

function cycleTraceFromPair(config: XuanStrategyConfig, rawPair: number, effectivePair: number, shares: number): {
  rawPair: number;
  effectivePair: number;
  feeUSDC: number;
  expectedNetIfMerged: number;
  cycleQualityLabel: CycleQualityLabel;
} {
  return {
    rawPair: normalizeTraceNumber(rawPair),
    effectivePair: normalizeTraceNumber(effectivePair),
    feeUSDC: cycleFeeUSDC(rawPair, effectivePair, shares),
    expectedNetIfMerged: expectedNetIfMerged(effectivePair, shares),
    cycleQualityLabel: classifyCycleQuality(config, effectivePair, rawPair),
  };
}

function estimateClosedCycleQualities(config: XuanStrategyConfig, fills: FillRecord[]): ClosedCycleQuality[] {
  type PendingLot = { remaining: number; price: number; timestamp: number };
  const upLots: PendingLot[] = [];
  const downLots: PendingLot[] = [];
  const cycles: ClosedCycleQuality[] = [];
  const sortedBuys = fills
    .filter((fill) => fill.side === "BUY")
    .sort((left, right) => left.timestamp - right.timestamp);

  for (const fill of sortedBuys) {
    const sameLots = fill.outcome === "UP" ? upLots : downLots;
    const oppositeLots = fill.outcome === "UP" ? downLots : upLots;
    let remaining = fill.size;

    while (remaining > 1e-6 && oppositeLots.length > 0) {
      const opposite = oppositeLots[0]!;
      const used = Math.min(remaining, opposite.remaining);
      const upPrice = fill.outcome === "UP" ? fill.price : opposite.price;
      const downPrice = fill.outcome === "DOWN" ? fill.price : opposite.price;
      const rawPair = upPrice + downPrice;
      const effectivePair = pairCostWithBothTaker(upPrice, downPrice, config.cryptoTakerFeeRate);
      const trace = cycleTraceFromPair(config, rawPair, effectivePair, used);
      cycles.push({
        openedAt: Math.min(fill.timestamp, opposite.timestamp),
        closedAt: Math.max(fill.timestamp, opposite.timestamp),
        shares: normalizeTraceNumber(used),
        ...trace,
      });

      remaining = normalizeTraceNumber(remaining - used);
      opposite.remaining = normalizeTraceNumber(opposite.remaining - used);
      if (opposite.remaining <= 1e-6) {
        oppositeLots.shift();
      }
    }

    if (remaining > 1e-6) {
      sameLots.push({
        remaining: normalizeTraceNumber(remaining),
        price: fill.price,
        timestamp: fill.timestamp,
      });
    }
  }

  return cycles;
}

function buildFreshCycleStats(config: XuanStrategyConfig, state: XuanMarketState): FreshCycleStats {
  const closedCycles = estimateClosedCycleQualities(config, state.fillHistory);
  const lastCycle = closedCycles[closedCycles.length - 1];
  let recentBadCycleCount = 0;
  for (let index = closedCycles.length - 1; index >= 0; index -= 1) {
    const cycle = closedCycles[index]!;
    if (cycle.expectedNetIfMerged >= -1e-9) {
      break;
    }
    recentBadCycleCount += 1;
  }
  const lastBadCycle = [...closedCycles].reverse().find((cycle) => cycle.expectedNetIfMerged < -1e-9);
  return {
    closedCycles,
    recentBadCycleCount,
    ...(lastCycle ? { lastCycle } : {}),
    ...(lastBadCycle ? { lastBadCycle } : {}),
  };
}

function referenceFreshCyclePriorActive(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  ctx: EntryLadderContext,
): boolean {
  if (config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return false;
  }
  const openPrior = resolveBundledOpenSequencePrior(state.market.slug);
  if (
    openPrior !== undefined &&
    state.fillHistory.every((fill) => fill.side !== "BUY") &&
    ctx.secsFromOpen <= openPrior.activeUntilSec + 1e-9
  ) {
    return true;
  }
  const seedPrior = resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen);
  return seedPrior?.scope === "exact";
}

function freshCycleRequestedLotCap(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  requestedLot: number,
  referencePriorActive: boolean,
): number {
  if (referencePriorActive) {
    return requestedLot;
  }
  const shareGap = Math.abs(state.upShares - state.downShares);
  if (!config.allowNewCycleWhenFlatOnly || shareGap > Math.max(config.postMergeFlatDustShares, 1e-6)) {
    return requestedLot;
  }
  const cap = Math.max(config.flatStateSoftPairMaxQty, config.flatStateHardPairMaxQty);
  return Math.max(0, Math.min(requestedLot, cap));
}

function newCyclePacingSkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  ctx: EntryLadderContext,
  stats: FreshCycleStats,
  referencePriorActive: boolean,
): string | undefined {
  if (config.botMode !== "XUAN") {
    return undefined;
  }
  const protectedResidualShares = Math.max(0, ctx.protectedResidualShares ?? 0);
  if (protectedResidualShares > Math.max(config.repairMinQty, config.completionMinQty)) {
    return undefined;
  }
  if (
    !referencePriorActive &&
    config.freshSeedHardCutoffSec > 0 &&
    ctx.secsFromOpen > config.freshSeedHardCutoffSec + 1e-9
  ) {
    return "late_fresh_seed_cutoff";
  }
  const nowTs = state.market.startTs + ctx.secsFromOpen;
  if (
    config.requireReevaluationAfterEachCycle &&
    stats.lastCycle &&
    nowTs - stats.lastCycle.closedAt < config.minSecondsBetweenNewCycles
  ) {
    return "new_cycle_reevaluation_cooldown";
  }
  if (
    config.maxNewCyclesPer30Sec > 0 &&
    stats.closedCycles.filter((cycle) => nowTs - cycle.closedAt <= 30).length >= config.maxNewCyclesPer30Sec
  ) {
    return "new_cycle_30s_cap";
  }
  if (
    config.forbidFlatBadCycleSpam &&
    config.badCycleMode === "COMPLETION_ONLY" &&
    stats.recentBadCycleCount >= config.maxConsecutiveBadCycles &&
    stats.lastBadCycle &&
    nowTs - stats.lastBadCycle.closedAt <= config.badCycleCooldownSec
  ) {
    return "bad_cycle_completion_only";
  }
  return shouldThrottleNewCycleDensity(config, state, ctx);
}

function freshCycleCandidateSkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  stats: FreshCycleStats,
  quality: CycleQualityLabel,
  referencePriorActive: boolean,
  candidateContext?: FreshCycleCandidateContext,
): string | undefined {
  if (referencePriorActive) {
    return undefined;
  }
  const shareGap = Math.abs(state.upShares - state.downShares);
  if (!config.allowNewCycleWhenFlatOnly || shareGap > Math.max(config.postMergeFlatDustShares, 1e-6)) {
    return undefined;
  }
  if (cycleQualityAllowedForFresh(config, quality, stats)) {
    return undefined;
  }
  const samePatternSkipReason = borderlineSamePatternSkipReason(config, state, stats, candidateContext, quality);
  if (samePatternSkipReason) {
    return samePatternSkipReason;
  }
  if (
    quality === "BORDERLINE_PAIR" &&
    borderlineFreshEntryAllowed(config, state, stats, candidateContext)
  ) {
    return undefined;
  }
  return quality === "BORDERLINE_PAIR" ? "fresh_cycle_borderline_pair" : "fresh_cycle_bad_pair";
}

export function evaluateEntryBuys(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
): EntryEvaluation {
  const pairCap = pairEntryCap(config);
  const totalShares = state.upShares + state.downShares;
  const shareGap = Math.abs(state.upShares - state.downShares);
  const dailyNegativeEdgeSpentUsdc = ctx.dailyNegativeEdgeSpentUsdc ?? 0;
  const overlapBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
  const matchedInventoryQuality = Math.max(
    0,
    ctx.matchedInventoryQuality ??
      Number(Math.min(1.25, Math.min(state.upShares, state.downShares) / Math.max(overlapBaseLot, 1e-6)).toFixed(6)),
  );
  const flowPressureState =
    ctx.flowPressureState ??
    deriveFlowPressureBudgetState({
      carryFlowConfidence: ctx.carryFlowConfidence,
      matchedInventoryQuality,
      recentSeedFlowCount: ctx.recentSeedFlowCount,
      activeIndependentFlowCount: ctx.activeIndependentFlowCount,
      residualSeverityPressure:
        (ctx.protectedResidualShares ?? 0) > 0
          ? residualSeverityPressure(config, ctx.protectedResidualShares ?? 0)
        : residualSeverityPressure(config, shareGap),
    });
  const freshCycleStats = buildFreshCycleStats(config, state);
  const referencePriorActive = referenceFreshCyclePriorActive(config, state, ctx);

  if (!config.entryTakerBuyEnabled) {
    return {
      decisions: [],
      trace: {
        mode: "disabled",
        requestedLot: ctx.lot,
        totalShares,
        shareGap,
        pairCap,
        skipReason: "entry_taker_disabled",
        recentBadCycleCount: freshCycleStats.recentBadCycleCount,
        ...(freshCycleStats.lastCycle ? { lastCycleNet: freshCycleStats.lastCycle.expectedNetIfMerged } : {}),
        ...(freshCycleStats.lastCycle ? { lastCycleClosedAt: freshCycleStats.lastCycle.closedAt } : {}),
        candidates: [],
      },
    };
  }

  if (shareGap === 0) {
    const cycleDensitySkipReason = newCyclePacingSkipReason(
      config,
      state,
      ctx,
      freshCycleStats,
      referencePriorActive,
    );
    if (cycleDensitySkipReason) {
      return {
        decisions: [],
        trace: {
          mode: "balanced_pair",
          requestedLot: ctx.lot,
          totalShares,
          shareGap,
          pairCap,
          skipReason: cycleDensitySkipReason,
          cycleSkippedReason: cycleDensitySkipReason,
          stateBefore: inventoryTraceState(state),
          recentBadCycleCount: freshCycleStats.recentBadCycleCount,
          ...(freshCycleStats.lastCycle ? { lastCycleNet: freshCycleStats.lastCycle.expectedNetIfMerged } : {}),
          ...(freshCycleStats.lastCycle ? { lastCycleClosedAt: freshCycleStats.lastCycle.closedAt } : {}),
          candidates: [],
        },
      };
    }
    const freshRequestedLot = freshCycleRequestedLotCap(config, state, ctx.lot, referencePriorActive);
    const freshCtx: EntryLadderContext = { ...ctx, lot: freshRequestedLot };
    const inspected = inspectBalancedPairCandidates(
      config,
      state,
      books,
      freshRequestedLot,
      ctx.secsFromOpen,
      pairCap,
      ctx.secsToClose,
      dailyNegativeEdgeSpentUsdc,
      ctx.fairValueSnapshot,
      ctx.carryFlowConfidence,
      matchedInventoryQuality,
      ctx.activeIndependentFlowCount,
      flowPressureState,
      { stats: freshCycleStats, referencePriorActive },
    );
    const trace: EntryDecisionTrace = {
      mode: "balanced_pair",
      requestedLot: ctx.lot,
      totalShares,
      shareGap,
      pairCap,
      freshCycleRequestedLotCap: freshRequestedLot,
      stateBefore: inventoryTraceState(state),
      recentBadCycleCount: freshCycleStats.recentBadCycleCount,
      ...(freshCycleStats.lastCycle ? { lastCycleNet: freshCycleStats.lastCycle.expectedNetIfMerged } : {}),
      ...(freshCycleStats.lastCycle ? { lastCycleClosedAt: freshCycleStats.lastCycle.closedAt } : {}),
      ...(inspected.bestRawPair !== undefined ? { bestRawPair: inspected.bestRawPair } : {}),
      ...(inspected.bestEffectivePair !== undefined ? { bestEffectivePair: inspected.bestEffectivePair } : {}),
      candidates: inspected.traces,
    };

    const temporalSeedEvaluation = evaluateTemporalSingleLegSeed(
      config,
      state,
      books,
      freshCtx,
      dailyNegativeEdgeSpentUsdc,
    );
    const preferTemporalCloneCycle =
      inspected.bestCandidate !== undefined &&
      shouldPreferTemporalCloneCycleOverBalancedPair({
        config,
        state,
        ctx,
        bestCandidate: inspected.bestCandidate,
        flowPressureState,
      });

    if (inspected.bestCandidate && !preferTemporalCloneCycle) {
      return {
        decisions: buildBalancedPairEntryBuys(
          config,
          state,
          ctx.secsFromOpen,
          ctx.childOrderMicroTimingBias,
          inspected.bestCandidate,
          config.cryptoTakerFeeRate,
          totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
        ),
        trace: {
          ...trace,
          selectedMode: inspected.bestCandidate.mode,
          rawPair: inspected.bestCandidate.rawPairCost,
          effectivePair: inspected.bestCandidate.pairCost,
          feeUSDC: inspected.bestCandidate.feeUSDC,
          expectedNetIfMerged: inspected.bestCandidate.expectedNetIfMerged,
          cycleQualityLabel: inspected.bestCandidate.cycleQualityLabel,
          cycleOpenedReason: totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
          stateAfter: projectedStateAfterCycleBuys(
            state,
            inspected.bestCandidate.requestedSize,
            inspected.bestCandidate.requestedSize,
            inspected.bestCandidate.upExecution.averagePrice,
            inspected.bestCandidate.downExecution.averagePrice,
          ),
          ...balancedPairChildOrderTrace(config, state, ctx.secsFromOpen, ctx.childOrderMicroTimingBias, inspected.bestCandidate),
          semanticRoleTarget: semanticRoleTargetForPair(inspected.bestCandidate.upExecution.averagePrice, inspected.bestCandidate.downExecution.averagePrice, ctx.semanticRoleAlignmentBias),
        },
      };
    }

    if (temporalSeedEvaluation.decision) {
      const selectedSeedTrace = temporalSeedEvaluation.trace.find(
        (seedTrace) => seedTrace.allowed && seedTrace.side === temporalSeedEvaluation.decision?.side,
      );
      return {
        decisions: [temporalSeedEvaluation.decision],
        trace: {
          ...trace,
          mode: "temporal_pair_cycle",
          selectedMode: temporalSeedEvaluation.decision.mode,
          ...(selectedSeedTrace?.rawPair !== undefined ? { rawPair: selectedSeedTrace.rawPair } : {}),
          ...(selectedSeedTrace?.effectivePair !== undefined ? { effectivePair: selectedSeedTrace.effectivePair } : {}),
          ...(selectedSeedTrace?.feeUSDC !== undefined ? { feeUSDC: selectedSeedTrace.feeUSDC } : {}),
          ...(selectedSeedTrace?.expectedNetIfMerged !== undefined
            ? { expectedNetIfMerged: selectedSeedTrace.expectedNetIfMerged }
            : {}),
          ...(selectedSeedTrace?.cycleQualityLabel ? { cycleQualityLabel: selectedSeedTrace.cycleQualityLabel } : {}),
          cycleOpenedReason: "temporal_single_leg_seed",
          stateAfter: projectedStateAfterCycleBuys(
            state,
            temporalSeedEvaluation.decision.side === "UP" ? temporalSeedEvaluation.decision.size : 0,
            temporalSeedEvaluation.decision.side === "DOWN" ? temporalSeedEvaluation.decision.size : 0,
            temporalSeedEvaluation.decision.side === "UP" ? temporalSeedEvaluation.decision.expectedAveragePrice : 0,
            temporalSeedEvaluation.decision.side === "DOWN" ? temporalSeedEvaluation.decision.expectedAveragePrice : 0,
          ),
          seedCandidates: temporalSeedEvaluation.trace,
          sideRhythmIntendedSide: temporalSeedEvaluation.rhythmArbitration?.intendedSide,
          sideRhythmSelectedSide: temporalSeedEvaluation.rhythmArbitration?.selectedSide,
          sideRhythmRejectedSide: temporalSeedEvaluation.rhythmArbitration?.rejectedSide,
          sideRhythmScoreDelta: temporalSeedEvaluation.rhythmArbitration?.scoreDelta,
          sideRhythmDecision: temporalSeedEvaluation.rhythmArbitration?.decision,
          childOrderIntendedSide: temporalSeedEvaluation.childOrder?.intendedSide,
          childOrderSelectedSide: temporalSeedEvaluation.childOrder?.selectedSide,
          childOrderReason: temporalSeedEvaluation.childOrder?.reason,
          semanticRoleTarget: temporalSeedEvaluation.semanticRoleTarget,
          skipReason:
            preferTemporalCloneCycle
              ? "clone_temporal_priority_over_pair_reentry"
              : determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
        },
      };
    }

    if (inspected.bestCandidate) {
      return {
        decisions: buildBalancedPairEntryBuys(
          config,
          state,
          ctx.secsFromOpen,
          ctx.childOrderMicroTimingBias,
          inspected.bestCandidate,
          config.cryptoTakerFeeRate,
          totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
        ),
        trace: {
          ...trace,
          selectedMode: inspected.bestCandidate.mode,
          rawPair: inspected.bestCandidate.rawPairCost,
          effectivePair: inspected.bestCandidate.pairCost,
          feeUSDC: inspected.bestCandidate.feeUSDC,
          expectedNetIfMerged: inspected.bestCandidate.expectedNetIfMerged,
          cycleQualityLabel: inspected.bestCandidate.cycleQualityLabel,
          cycleOpenedReason: totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
          stateAfter: projectedStateAfterCycleBuys(
            state,
            inspected.bestCandidate.requestedSize,
            inspected.bestCandidate.requestedSize,
            inspected.bestCandidate.upExecution.averagePrice,
            inspected.bestCandidate.downExecution.averagePrice,
          ),
          ...balancedPairChildOrderTrace(config, state, ctx.secsFromOpen, ctx.childOrderMicroTimingBias, inspected.bestCandidate),
          semanticRoleTarget: semanticRoleTargetForPair(inspected.bestCandidate.upExecution.averagePrice, inspected.bestCandidate.downExecution.averagePrice, ctx.semanticRoleAlignmentBias),
        },
      };
    }

    const seedEvaluation = evaluateSingleLegSeed(
      config,
      state,
      books,
      freshCtx,
      dailyNegativeEdgeSpentUsdc,
    );

    if (seedEvaluation.decisions && seedEvaluation.decisions.length > 0) {
      const selectedSeedTrace = seedEvaluation.trace.find(
        (seedTrace) => seedTrace.allowed && seedTrace.side === seedEvaluation.decisions?.[0]?.side,
      );
      const upDecision = seedEvaluation.decisions.find((decision) => decision.side === "UP");
      const downDecision = seedEvaluation.decisions.find((decision) => decision.side === "DOWN");
      return {
        decisions: seedEvaluation.decisions,
        trace: {
          ...trace,
          selectedMode: seedEvaluation.decisions[0]!.mode,
          ...(selectedSeedTrace?.rawPair !== undefined ? { rawPair: selectedSeedTrace.rawPair } : {}),
          ...(selectedSeedTrace?.effectivePair !== undefined ? { effectivePair: selectedSeedTrace.effectivePair } : {}),
          ...(selectedSeedTrace?.feeUSDC !== undefined ? { feeUSDC: selectedSeedTrace.feeUSDC } : {}),
          ...(selectedSeedTrace?.expectedNetIfMerged !== undefined
            ? { expectedNetIfMerged: selectedSeedTrace.expectedNetIfMerged }
            : {}),
          ...(selectedSeedTrace?.cycleQualityLabel ? { cycleQualityLabel: selectedSeedTrace.cycleQualityLabel } : {}),
          ...(selectedSeedTrace?.stagedEntry ? { stagedEntry: true } : {}),
          ...(selectedSeedTrace?.plannedOppositeSide
            ? { plannedOppositeSide: selectedSeedTrace.plannedOppositeSide }
            : {}),
          ...(selectedSeedTrace?.plannedOppositeQty !== undefined
            ? { plannedOppositeQty: selectedSeedTrace.plannedOppositeQty }
            : {}),
          cycleOpenedReason: "balanced_pair_seed",
          stateAfter: projectedStateAfterCycleBuys(
            state,
            upDecision?.size ?? 0,
            downDecision?.size ?? 0,
            upDecision?.expectedAveragePrice ?? 0,
            downDecision?.expectedAveragePrice ?? 0,
          ),
          seedCandidates: [...temporalSeedEvaluation.trace, ...seedEvaluation.trace],
          childOrderIntendedSide: seedEvaluation.childOrder?.intendedSide,
          childOrderSelectedSide: seedEvaluation.childOrder?.selectedSide,
          childOrderReason: seedEvaluation.childOrder?.reason,
          semanticRoleTarget: seedEvaluation.semanticRoleTarget,
          skipReason: determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
        },
      };
    }

    const cycleSkippedReason =
      temporalSeedEvaluation.trace.find((seedTrace) => seedTrace.cycleSkippedReason)?.cycleSkippedReason ??
      seedEvaluation.trace.find((seedTrace) => seedTrace.cycleSkippedReason)?.cycleSkippedReason ??
      inspected.traces.find((candidateTrace) => candidateTrace.cycleSkippedReason)?.cycleSkippedReason;

    return {
      decisions: [],
      trace: {
        ...trace,
        seedCandidates: [...temporalSeedEvaluation.trace, ...seedEvaluation.trace],
        skipReason:
          temporalSeedEvaluation.trace.length > 0 || seedEvaluation.trace.length > 0
            ? `${determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces)}+single_leg_seed`
            : determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
        ...(cycleSkippedReason ? { cycleSkippedReason } : {}),
      },
    };
  }

  const laggingSide: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
  const leadingSide: OutcomeSide = laggingSide === "UP" ? "DOWN" : "UP";
  const residualBehaviorState = resolveResidualBehaviorState({
    config,
    residualShares: ctx.protectedResidualShares ?? 0,
    shareGap,
    ...(ctx.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: ctx.recentSeedFlowCount } : {}),
    ...(ctx.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: ctx.activeIndependentFlowCount } : {}),
  });
  const residualSeverity = residualBehaviorState.severity;
  const overlapRepairArbitration =
    ctx.forcedOverlapRepairArbitration ??
    residualBehaviorState.overlapRepairArbitration;
  const favorIndependentOverlapFlow = overlapRepairArbitration === "favor_independent_overlap";
  const preferCloneResidualRepair = overlapRepairArbitration === "favor_residual_repair";
  const carryPreservedOverlapPath =
    ctx.forcedOverlapRepairArbitration === "favor_independent_overlap" &&
    (ctx.protectedResidualShares ?? 0) > 0;
  const allowOverlapPath = Boolean(ctx.allowControlledOverlap || carryPreservedOverlapPath);
  const overlapRepairReason =
    ctx.forcedOverlapRepairArbitration !== undefined
      ? "sticky_arbitration_carry"
      : overlapRepairArbitration === "favor_independent_overlap"
      ? "micro_or_small_residual_overlap_bias"
      : overlapRepairArbitration === "favor_residual_repair"
        ? "protected_residual_repair_bias"
        : overlapRepairArbitration === "standard_pair_reentry"
          ? "standard_pair_reentry"
          : "no_overlap_lock";
  const overlapInspection = allowOverlapPath
      ? inspectBalancedPairCandidates(
          config,
          state,
          books,
          ctx.lot,
          ctx.secsFromOpen,
          pairCap,
          ctx.secsToClose,
          dailyNegativeEdgeSpentUsdc,
          ctx.fairValueSnapshot,
          ctx.carryFlowConfidence,
          matchedInventoryQuality,
          ctx.activeIndependentFlowCount,
          flowPressureState,
      )
    : undefined;
  const overlapTemporalSeed =
    allowOverlapPath && (ctx.protectedResidualShares ?? 0) > 0
      ? evaluateTemporalSingleLegSeed(
          config,
          state,
          books,
          ctx,
          dailyNegativeEdgeSpentUsdc,
        )
      : undefined;
  const buildOverlapPairReentry = (): EntryEvaluation | undefined =>
    overlapInspection?.bestCandidate
      ? {
          decisions: buildBalancedPairEntryBuys(
            config,
            state,
            ctx.secsFromOpen,
            ctx.childOrderMicroTimingBias,
            overlapInspection.bestCandidate,
            config.cryptoTakerFeeRate,
            "balanced_pair_reentry",
          ),
          trace: {
            mode: "balanced_pair",
            requestedLot: ctx.lot,
            totalShares,
            shareGap,
            pairCap,
            selectedMode: overlapInspection.bestCandidate.mode,
            ...balancedPairChildOrderTrace(config, state, ctx.secsFromOpen, ctx.childOrderMicroTimingBias, overlapInspection.bestCandidate),
            semanticRoleTarget: semanticRoleTargetForPair(
              overlapInspection.bestCandidate.upExecution.averagePrice,
              overlapInspection.bestCandidate.downExecution.averagePrice,
              ctx.semanticRoleAlignmentBias,
            ),
            laggingSide,
            residualSeverityLevel: residualSeverity.level,
            overlapRepairArbitration,
            overlapRepairReason,
            overlapRepairOutcome: "pair_reentry",
            ...(overlapInspection.bestRawPair !== undefined ? { bestRawPair: overlapInspection.bestRawPair } : {}),
            ...(overlapInspection.bestEffectivePair !== undefined
              ? { bestEffectivePair: overlapInspection.bestEffectivePair }
              : {}),
            candidates: overlapInspection.traces,
            skipReason: "controlled_overlap_pair",
          },
        }
      : undefined;
  const buildOverlapTemporalSeedEvaluation = (): EntryEvaluation | undefined =>
    overlapTemporalSeed?.decision
      ? {
          decisions: [overlapTemporalSeed.decision],
          trace: {
            mode: "temporal_pair_cycle",
            requestedLot: ctx.lot,
            totalShares,
            shareGap,
            pairCap,
            selectedMode: overlapTemporalSeed.decision.mode,
            laggingSide,
            residualSeverityLevel: residualSeverity.level,
            overlapRepairArbitration,
            overlapRepairReason,
            overlapRepairOutcome: "overlap_seed",
            sideRhythmIntendedSide: overlapTemporalSeed.rhythmArbitration?.intendedSide,
            sideRhythmSelectedSide: overlapTemporalSeed.rhythmArbitration?.selectedSide,
            sideRhythmRejectedSide: overlapTemporalSeed.rhythmArbitration?.rejectedSide,
            sideRhythmScoreDelta: overlapTemporalSeed.rhythmArbitration?.scoreDelta,
            sideRhythmDecision: overlapTemporalSeed.rhythmArbitration?.decision,
            childOrderIntendedSide: overlapTemporalSeed.childOrder?.intendedSide,
            childOrderSelectedSide: overlapTemporalSeed.childOrder?.selectedSide,
            childOrderReason: overlapTemporalSeed.childOrder?.reason,
            semanticRoleTarget: overlapTemporalSeed.semanticRoleTarget,
            candidates: overlapInspection?.traces ?? [],
            seedCandidates: overlapTemporalSeed.trace,
            skipReason: "protected_residual_overlap_seed",
          },
        }
      : undefined;
  const withCloneOverlapFallback = (fallback: EntryEvaluation): EntryEvaluation =>
    preferCloneResidualRepair || favorIndependentOverlapFlow
      ? buildOverlapTemporalSeedEvaluation() ?? buildOverlapPairReentry() ?? fallback
      : fallback;

  if (favorIndependentOverlapFlow) {
    const overlapSeedEvaluation = buildOverlapTemporalSeedEvaluation();
    if (overlapSeedEvaluation) {
      return overlapSeedEvaluation;
    }

    const pairReentry = buildOverlapPairReentry();
    if (pairReentry) {
      return pairReentry;
    }
  }

  if (allowOverlapPath && !preferCloneResidualRepair && !favorIndependentOverlapFlow) {
    const pairReentry = buildOverlapPairReentry();
    if (pairReentry) {
      return pairReentry;
    }

    const overlapSeedEvaluation = buildOverlapTemporalSeedEvaluation();
    if (overlapSeedEvaluation) {
      return overlapSeedEvaluation;
    }
  }
  const completionQtyPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledCompletionSequencePrior(state.market.slug, ctx.secsFromOpen, laggingSide)
      : undefined;
  const exactCompletionQtyPrior = completionQtyPrior?.scope === "exact" ? completionQtyPrior : undefined;
  const highLowRepairOvershootQty = buildHighLowRepairOvershootQty({
    config,
    sideToBuy: laggingSide,
    books,
    existingAverage: averageCost(state, leadingSide),
    shareGap,
    exactPriorActive: Boolean(exactCompletionQtyPrior),
  });
  const repairLotCap =
    highLowRepairOvershootQty !== undefined
      ? Math.max(ctx.lot * config.rebalanceMaxLaggingMultiplier, highLowRepairOvershootQty)
      : ctx.lot * config.rebalanceMaxLaggingMultiplier;
  const repairRequestedQty = Math.min(
    Math.max(exactCompletionQtyPrior?.qty ?? Math.max(ctx.lot, shareGap), highLowRepairOvershootQty ?? 0),
    repairLotCap,
    Math.max(0, config.maxMarketSharesPerSide - (laggingSide === "UP" ? state.upShares : state.downShares)),
    Math.max(0, config.maxOneSidedExposureShares),
  );
  const repairQtyCap =
    config.completionQtyMode === "ALLOW_OVERSHOOT"
      ? shareGap + config.maxCompletionOvershootShares
      : shareGap;
  const repairEffectiveQtyCap = exactCompletionQtyPrior
    ? Math.max(repairQtyCap, exactCompletionQtyPrior.qty)
    : highLowRepairOvershootQty !== undefined
      ? Math.max(repairQtyCap, highLowRepairOvershootQty)
      : repairQtyCap;
  const repairSize = normalizeOrderSize(
    Math.min(repairRequestedQty, repairEffectiveQtyCap),
    config.repairMinQty,
  );
  const trace: EntryDecisionTrace = {
    mode: "lagging_rebalance",
    requestedLot: ctx.lot,
    totalShares,
    shareGap,
    pairCap,
    candidates: [],
    laggingSide,
    residualSeverityLevel: residualSeverity.level,
    overlapRepairArbitration,
    overlapRepairReason,
    overlapRepairOutcome: "repair",
    repairSize,
    repairRequestedQty,
    repairMissingQty: shareGap,
  };

  const residualJanitorPair = buildResidualJanitorPairEvaluation({
    config,
    state,
    books,
    ctx,
    trace,
    dailyNegativeEdgeSpentUsdc,
    carryFlowConfidence: ctx.carryFlowConfidence,
    matchedInventoryQuality,
    activeIndependentFlowCount: ctx.activeIndependentFlowCount,
    flowPressureState,
  });
  if (residualJanitorPair) {
    return residualJanitorPair;
  }

  if (
    shouldHoldHighLowOvershootResidual({
      config,
      state,
      leadingSide,
      shareGap,
      secsFromOpen: ctx.secsFromOpen,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
    })
  ) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        overlapRepairOutcome: "wait",
        skipReason: "high_low_residual_redeem_hold",
      },
    });
  }

  if (
    shouldHoldLateSmallResidual({
      config,
      shareGap,
      secsFromOpen: ctx.secsFromOpen,
      secsToClose: ctx.secsToClose,
      residualSeverityLevel: residualSeverity.level,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
    })
  ) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        overlapRepairOutcome: "wait",
        skipReason: "late_small_residual_hold",
      },
    });
  }

  if (repairSize <= 0) {
    return {
      decisions: [],
      trace: {
        ...trace,
        skipReason: shareGap < config.repairMinQty ? "repair_size_zero" : "repair_qty_cap",
      },
    };
  }

  const nowTs = state.market.endTs - ctx.secsToClose;
  const residualTimestamp = oldestResidualLotTimestamp(state, leadingSide);
  const partialAgeSec =
    residualTimestamp !== undefined ? Math.max(0, nowTs - residualTimestamp) : config.partialSoftWindowSec;
  const stagedResidualAgeSec = borderlineStagedResidualAgeSec(state, leadingSide, nowTs);
  if (
    config.borderlinePairStagedEntryEnabled &&
    stagedResidualAgeSec !== undefined &&
    stagedResidualAgeSec < config.borderlinePairReevaluateAfterSec &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec
  ) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        overlapRepairOutcome: "wait",
        completionHoldSec: normalizeTraceNumber(config.borderlinePairReevaluateAfterSec - stagedResidualAgeSec),
        skipReason: "borderline_staged_completion_wait",
      },
    });
  }
  const phase = resolvePartialCompletionPhase({
    config,
    partialAgeSec,
    secsToClose: ctx.secsToClose,
    capFamily: "temporal_repair",
    postMergeCompletionOnly:
      config.postMergeOnlyCompletion &&
      (state.reentryDisabled ||
        (state.postMergeCompletionOnlyUntil !== undefined && nowTs < state.postMergeCompletionOnlyUntil)),
  });
  const phaseCap =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    partialAgeSec <= config.temporalRepairUltraFastWindowSec
      ? Math.max(phase.cap, config.temporalRepairUltraFastCap)
      : phase.cap;
  const phaseMaxQty =
    exactCompletionQtyPrior && Number.isFinite(phase.maxQty)
      ? Math.max(phase.maxQty, exactCompletionQtyPrior.qty)
      : highLowRepairOvershootQty !== undefined && Number.isFinite(phase.maxQty)
        ? Math.max(phase.maxQty, highLowRepairOvershootQty)
      : phase.maxQty;
  const phasedRepairSize = normalizeOrderSize(
    Math.min(repairSize, Number.isFinite(phaseMaxQty) ? phaseMaxQty : repairSize),
    config.repairMinQty,
  );
  if (phasedRepairSize <= 0) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        skipReason: "repair_phase_qty_cap",
      },
    });
  }
  const residualCarryQty = completionResidualCarryQty({
    config,
    shareGap,
    repairSize: phasedRepairSize,
    secsFromOpen: ctx.secsFromOpen,
    secsToClose: ctx.secsToClose,
    residualSeverityLevel: residualSeverity.level,
    exactPriorActive: Boolean(exactCompletionQtyPrior),
    overlapRepairArbitration,
  });
  const residualAwareRepairSize = normalizeOrderSize(
    Math.max(config.repairMinQty, phasedRepairSize - residualCarryQty),
    config.repairMinQty,
  );
  const effectiveRepairSize =
    residualCarryQty > 0 && residualAwareRepairSize > 0 ? Math.min(phasedRepairSize, residualAwareRepairSize) : phasedRepairSize;
  const repairCandidateSizes = buildResidualRepairCandidateSizes({
    config,
    standardSize: effectiveRepairSize,
    shareGap,
    exactPriorActive: Boolean(exactCompletionQtyPrior),
  });
  let lastBlockedRepairEvaluation: EntryEvaluation | undefined;
  let bestRepairEvaluation: EntryEvaluation | undefined;
  let bestRepairScore = Number.POSITIVE_INFINITY;

  for (const repairCandidateSize of repairCandidateSizes) {
    const repairSizingMode = Math.abs(repairCandidateSize - effectiveRepairSize) <= 1e-6
      ? "standard"
      : "micro_fallback";
    const execution = books.quoteForSize(laggingSide, "ask", repairCandidateSize);
    const executableSize = normalizeOrderSize(execution.filledSize, config.repairMinQty);
    if (executableSize <= 0) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...trace,
          repairSizingMode,
          repairCandidateCount: repairCandidateSizes.length,
        repairFilledSize: executableSize,
        skipReason: "lagging_depth",
      },
      };
      continue;
    }

    const oldGap = absoluteShareGap(state);
    const newGap = projectedShareGapAfterBuy(state, laggingSide, executableSize);
    const wouldIncreaseImbalance = newGap > oldGap + config.maxCompletionOvershootShares;
    if ((config.forbidBuyThatIncreasesImbalance || config.partialCompletionRequiresImbalanceReduction) && wouldIncreaseImbalance) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...trace,
          repairSizingMode,
          repairCandidateCount: repairCandidateSizes.length,
        repairFilledSize: executableSize,
        repairFinalQty: executableSize,
        repairOldGap: oldGap,
        repairNewGap: newGap,
        repairWouldIncreaseImbalance: wouldIncreaseImbalance,
        skipReason: "repair_increases_imbalance",
      },
      };
      continue;
    }

    const oppositeAveragePrice = averageEffectiveCost(state, leadingSide, config.cryptoTakerFeeRate);
    const repairCost = completionCost(
      oppositeAveragePrice,
      execution.averagePrice,
      config.cryptoTakerFeeRate,
    );
    const allowance = completionAllowance(config, state, {
      costWithFees: repairCost,
      candidateSize: executableSize,
      oppositeAveragePrice,
      missingSidePrice: execution.averagePrice,
      partialAgeSec,
    });
    const blockedCompletionReleaseRole = classifyCompletionReleaseRole({
      config,
      oppositeAveragePrice,
      missingSidePrice: execution.averagePrice,
    });
    const highLowPhaseCapOverride = Boolean(allowance.highLowMismatch && allowance.allowed);
    if ((repairCost > phaseCap && !highLowPhaseCapOverride) || executableSize > phaseMaxQty) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...trace,
          repairSizingMode,
          repairCandidateCount: repairCandidateSizes.length,
        repairFilledSize: executableSize,
        repairFinalQty: executableSize,
        repairCost,
        repairAllowed: false,
        repairCapMode: allowance.capMode,
        repairOldGap: oldGap,
        repairNewGap: newGap,
        repairWouldIncreaseImbalance: wouldIncreaseImbalance,
        repairOppositeAveragePrice: oppositeAveragePrice,
        repairHighLowMismatch: allowance.highLowMismatch ?? false,
        completionReleaseRole: blockedCompletionReleaseRole,
        skipReason: executableSize > phaseMaxQty ? "repair_phase_qty_cap" : "repair_phase_cap",
      },
      };
      continue;
    }
    const ultraFastCloneFairValueFallback =
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      partialAgeSec <= config.temporalRepairUltraFastWindowSec &&
      isCloneRepairFairValueFallbackSnapshot(ctx.fairValueSnapshot) &&
      repairCost <= config.temporalRepairUltraFastMissingFairValueCap &&
      allowance.allowed;
    const fairValueRequired =
      ultraFastCloneFairValueFallback
        ? false
        : allowance.highLowMismatch && allowance.allowed && !allowance.requiresFairValue
          ? false
          : !(
              config.allowStrictResidualCompletionWithoutFairValue &&
              repairCost <= config.strictResidualCompletionCap
            ) || Boolean(allowance.requiresFairValue);
    const fairValueDecision = ultraFastCloneFairValueFallback
      ? { allowed: true as const }
      : fairValueGate({
          config,
          snapshot: ctx.fairValueSnapshot,
          side: laggingSide,
          sidePrice: execution.averagePrice,
          mode: phase.mode === "PARTIAL_EMERGENCY_COMPLETION" ? "emergency" : "completion",
          secsToClose: ctx.secsToClose,
          effectiveCost: repairCost,
          required: fairValueRequired,
        });
    const strictHighSideFairValueDecision =
      execution.averagePrice >= config.highSidePriceThreshold
        ? fairValueGate({
            config,
            snapshot: ctx.fairValueSnapshot,
            side: laggingSide,
            sidePrice: execution.averagePrice,
            mode: phase.mode === "PARTIAL_EMERGENCY_COMPLETION" ? "emergency" : "completion",
            secsToClose: ctx.secsToClose,
            effectiveCost: repairCost,
            required: true,
          })
        : { allowed: true as const };
    const highSideQualitySkipReason = highSideCompletionQualitySkipReason(config, state, {
      costWithFees: repairCost,
      candidateSize: executableSize,
      missingSidePrice: execution.averagePrice,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
      fairValueAllowed: strictHighSideFairValueDecision.allowed,
    });
    const qualitySkipReason = completionQualitySkipReason(config, state, {
      costWithFees: repairCost,
      candidateSize: executableSize,
      partialAgeSec,
      capMode: allowance.capMode,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
      secsToClose: ctx.secsToClose,
    });
    const cheapLateCompletionChase =
      allowance.allowed &&
      shouldUseCheapLateCompletionChase({
        config,
        completionQtyPrior,
        oppositeAveragePrice,
        missingSidePrice: execution.averagePrice,
        partialAgeSec,
      });
    const repairMode: StrategyExecutionMode =
      allowance.highLowMismatch && allowance.allowed
        ? "HIGH_LOW_COMPLETION_CHASE"
        : cheapLateCompletionChase
          ? "CHEAP_LATE_COMPLETION_CHASE"
          : phase.mode;
    const completionReleaseRole = blockedCompletionReleaseRole;
    const completionDelayProfile = resolveResidualCompletionDelayProfile({
      config,
      residualShares: shareGap,
      partialAgeSec,
      secsToClose: ctx.secsToClose,
      oppositeAveragePrice,
      missingSidePrice: execution.averagePrice,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
      exceptionalMode: Boolean(allowance.highLowMismatch) || cheapLateCompletionChase,
      ...(ctx.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: ctx.recentSeedFlowCount } : {}),
      ...(ctx.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: ctx.activeIndependentFlowCount } : {}),
      ...(ctx.completionPatienceMultiplier !== undefined
        ? { completionPatienceMultiplier: ctx.completionPatienceMultiplier }
        : {}),
    });
    const detailedTrace: EntryDecisionTrace = {
      ...trace,
      selectedMode: repairMode,
      repairSizingMode,
      repairCandidateCount: repairCandidateSizes.length,
      repairFilledSize: executableSize,
      repairFinalQty: executableSize,
      repairCost,
      repairAllowed: allowance.allowed,
      repairCapMode: allowance.capMode,
      repairOldGap: oldGap,
      repairNewGap: newGap,
      repairWouldIncreaseImbalance: wouldIncreaseImbalance,
      repairOppositeAveragePrice: oppositeAveragePrice,
      repairHighLowMismatch: allowance.highLowMismatch ?? false,
      completionReleaseRole,
      completionCalibrationPatienceMultiplier: completionDelayProfile.calibrationPatienceMultiplier,
      completionRolePatienceMultiplier: completionDelayProfile.rolePatienceMultiplier,
      completionEffectivePatienceMultiplier: completionDelayProfile.effectivePatienceMultiplier,
      completionWaitUntilSec: completionDelayProfile.waitUntilSec,
    };
    if (
      ctx.secsToClose <= config.partialNoChaseLastSec &&
      !config.allowAnyNewBuyInLast10S &&
      allowance.capMode !== "strict"
    ) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        overlapRepairOutcome: "blocked",
        skipReason: "repair_last10_strict_only",
      },
      };
      continue;
    }
    if (!allowance.allowed || !fairValueDecision.allowed) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        overlapRepairOutcome: "blocked",
        skipReason: !allowance.allowed ? "repair_cap" : fairValueDecision.reason ?? "repair_fair_value",
      },
      };
      continue;
    }
    if (highSideQualitySkipReason) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        overlapRepairOutcome: "blocked",
        skipReason: highSideQualitySkipReason,
      },
      };
      continue;
    }
    if (qualitySkipReason) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        overlapRepairOutcome: "blocked",
        skipReason: qualitySkipReason,
      },
      };
      continue;
    }
    if (completionDelayProfile.shouldDelay) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        overlapRepairOutcome: "wait",
        skipReason: "repair_patience_wait",
      },
      };
      continue;
    }

    const repairEvaluation: EntryEvaluation = {
      decisions: [
        buildEntryBuy(
          state,
          laggingSide,
          {
            ...execution,
            requestedSize: executableSize,
            filledSize: executableSize,
            fullyFilled: execution.filledSize + 1e-9 >= executableSize,
          },
          "lagging_rebalance",
          repairMode,
          config.cryptoTakerFeeRate,
          repairCost,
          allowance.negativeEdgeUsdc,
        ),
      ],
      trace: detailedTrace,
    };
    const repairScore = completionCandidateRankScore(config, {
      costWithFees: repairCost,
      missingSidePrice: execution.averagePrice,
      candidateSize: executableSize,
      missingShares: shareGap,
      partialAgeSec,
      fairValuePremium:
        fairValueForOrphanSide(ctx.fairValueSnapshot, laggingSide) !== undefined
          ? execution.averagePrice - (fairValueForOrphanSide(ctx.fairValueSnapshot, laggingSide) ?? execution.averagePrice)
          : undefined,
      depthCoverageRatio: books.depthAtOrBetter(laggingSide, execution.limitPrice, "ask") / Math.max(executableSize, 1e-6),
      gapImprovement: Math.max(0, oldGap - newGap),
      oldGap,
      residualAfter: newGap,
      exactQtyMatch:
        exactCompletionQtyPrior !== undefined &&
        Math.abs(executableSize - exactCompletionQtyPrior.qty) <= 1e-6,
    });
    if (repairScore < bestRepairScore) {
      bestRepairEvaluation = repairEvaluation;
      bestRepairScore = repairScore;
    }
  }

  if (bestRepairEvaluation) {
    return bestRepairEvaluation;
  }

  return withCloneOverlapFallback(lastBlockedRepairEvaluation ?? {
    decisions: [],
    trace: {
      ...trace,
      repairCandidateCount: repairCandidateSizes.length,
      skipReason: "repair_no_viable_candidate",
    },
  });
}

function buildResidualJanitorPairEvaluation(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  books: OrderBookState;
  ctx: EntryLadderContext;
  trace: EntryDecisionTrace;
  dailyNegativeEdgeSpentUsdc: number;
  carryFlowConfidence?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  flowPressureState?: FlowPressureBudgetState | undefined;
}): EntryEvaluation | undefined {
  if (!args.config.residualJanitorEnabled || args.config.botMode !== "XUAN") {
    return undefined;
  }
  if (args.ctx.secsToClose <= args.config.finalWindowNoChaseSec) {
    return undefined;
  }

  const currentMergeable = mergeableShares(args.state);
  const shareGap = Math.abs(args.state.upShares - args.state.downShares);
  const maxInventory = Math.max(args.state.upShares, args.state.downShares);
  if (
    currentMergeable <= 1e-6 ||
    currentMergeable >= args.config.mergeMinShares - 1e-6 ||
    shareGap > args.config.residualJanitorMaxShareGap + 1e-6 ||
    maxInventory > args.config.residualJanitorMaxInventoryShares + 1e-6
  ) {
    return undefined;
  }

  const targetPairQty = normalizeOrderSize(
    Math.min(
      args.config.residualJanitorMaxQty,
      Math.max(
        args.config.completionMinQty,
        args.config.mergeMinShares - currentMergeable + args.config.mergeDustLeaveShares,
      ),
    ),
    args.config.completionMinQty,
  );
  if (targetPairQty <= 0) {
    return undefined;
  }

  const upExecution = args.books.quoteForSize("UP", "ask", targetPairQty);
  const downExecution = args.books.quoteForSize("DOWN", "ask", targetPairQty);
  if (!upExecution.fullyFilled || !downExecution.fullyFilled) {
    return undefined;
  }

  const rawPairCost = upExecution.averagePrice + downExecution.averagePrice;
  const pairCost = pairCostWithBothTaker(
    upExecution.averagePrice,
    downExecution.averagePrice,
    args.config.cryptoTakerFeeRate,
  );
  if (pairCost > args.config.residualJanitorMaxEffectivePair + 1e-9) {
    return undefined;
  }

  const allowance = pairSweepAllowance({
    config: args.config,
    state: args.state,
    costWithFees: pairCost,
    candidateSize: targetPairQty,
    secsToClose: args.ctx.secsToClose,
    dailyNegativeEdgeSpentUsdc: args.dailyNegativeEdgeSpentUsdc,
    carryFlowConfidence: args.carryFlowConfidence,
    matchedInventoryQuality: args.matchedInventoryQuality,
    activeIndependentFlowCount: args.activeIndependentFlowCount,
    flowPressureState: args.flowPressureState,
  });
  if (!allowance.allowed && pairCost > args.config.pairSweepStrictCap + 1e-9) {
    return undefined;
  }

  const mode = allowance.mode ?? "STRICT_PAIR_SWEEP";
  const traceFromPair = cycleTraceFromPair(args.config, rawPairCost, pairCost, targetPairQty);
  const candidate: BalancedPairCandidate = {
    requestedSize: targetPairQty,
    rawPairCost: traceFromPair.rawPair,
    pairCost: traceFromPair.effectivePair,
    feeUSDC: traceFromPair.feeUSDC,
    expectedNetIfMerged: traceFromPair.expectedNetIfMerged,
    cycleQualityLabel: traceFromPair.cycleQualityLabel,
    mode,
    negativeEdgeUsdc: allowance.negativeEdgeUsdc,
    upExecution: {
      ...upExecution,
      requestedSize: targetPairQty,
      filledSize: targetPairQty,
      fullyFilled: true,
    },
    downExecution: {
      ...downExecution,
      requestedSize: targetPairQty,
      filledSize: targetPairQty,
      fullyFilled: true,
    },
  };

  return {
    decisions: buildBalancedPairEntryBuys(
      args.config,
      args.state,
      args.ctx.secsFromOpen,
      args.ctx.childOrderMicroTimingBias,
      candidate,
      args.config.cryptoTakerFeeRate,
      "balanced_pair_reentry",
    ),
    trace: {
      ...args.trace,
      selectedMode: mode,
      rawPair: candidate.rawPairCost,
      effectivePair: candidate.pairCost,
      feeUSDC: candidate.feeUSDC,
      expectedNetIfMerged: candidate.expectedNetIfMerged,
      cycleQualityLabel: candidate.cycleQualityLabel,
      cycleOpenedReason: "controlled_overlap_pair",
      overlapRepairOutcome: "pair_reentry",
      skipReason: "micro_residual_janitor_pair",
      stateAfter: projectedStateAfterCycleBuys(
        args.state,
        targetPairQty,
        targetPairQty,
        upExecution.averagePrice,
        downExecution.averagePrice,
      ),
      candidates: [
        {
          requestedSize: targetPairQty,
          upFilledSize: targetPairQty,
          downFilledSize: targetPairQty,
          upAveragePrice: upExecution.averagePrice,
          downAveragePrice: downExecution.averagePrice,
          upLimitPrice: upExecution.limitPrice,
          downLimitPrice: downExecution.limitPrice,
          rawPairCost: candidate.rawPairCost,
          rawPair: candidate.rawPairCost,
          pairCost: candidate.pairCost,
          effectivePair: candidate.pairCost,
          pairEdge: Number((1 - candidate.pairCost).toFixed(6)),
          feeUSDC: candidate.feeUSDC,
          expectedNetIfMerged: candidate.expectedNetIfMerged,
          cycleQualityLabel: candidate.cycleQualityLabel,
          negativeEdgeUsdc: candidate.negativeEdgeUsdc,
          verdict: "ok",
          selectedMode: mode,
          gateReason: "micro_residual_janitor_pair",
        },
      ],
    },
  };
}

function fairValueForOrphanSide(snapshot: FairValueSnapshot | undefined, side: OutcomeSide): number | undefined {
  if (!snapshot || snapshot.status !== "valid") {
    return undefined;
  }
  return side === "UP" ? snapshot.fairUp : snapshot.fairDown;
}

function shouldBlockCloneStaleCheapOppositeQuote(args: {
  config: XuanStrategyConfig;
  marketSlug: string;
  snapshot: FairValueSnapshot | undefined;
  secsFromOpen: number;
  upPrice: number;
  downPrice: number;
  pairCost: number;
}): boolean {
  if (args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return false;
  }
  if (!args.snapshot || args.snapshot.status === "valid" || args.snapshot.status === "disabled") {
    return false;
  }
  const requiredAgeSec =
    resolveBundledLateCheapGuardSec(args.marketSlug) ?? args.config.cloneStaleCheapOppositeQuoteMinAgeSec;
  if (args.secsFromOpen < requiredAgeSec) {
    return false;
  }

  const lowSidePrice = Math.min(args.upPrice, args.downPrice);
  const highSidePrice = Math.max(args.upPrice, args.downPrice);
  return (
    args.pairCost > args.config.pairSweepStrictCap + 1e-9 &&
    lowSidePrice <= args.config.lowSideMaxForHighCompletion + 1e-9 &&
    highSidePrice >= args.config.highSidePriceThreshold - 0.02
  );
}

function currentOrphanNotionalUsdc(state: XuanMarketState): number {
  const gap = absoluteShareGap(state);
  if (gap <= 1e-6) {
    return 0;
  }
  const orphanSide: OutcomeSide = state.upShares > state.downShares ? "UP" : "DOWN";
  return Number((gap * averageCost(state, orphanSide)).toFixed(6));
}

function evaluateOrphanRisk(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  side: OutcomeSide;
  execution: ExecutionQuote;
  candidateSize: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
}): OrphanRiskTrace {
  const effectivePrice = args.execution.averagePrice + takerFeePerShare(
    args.execution.averagePrice,
    args.config.cryptoTakerFeeRate,
  );
  const notionalUsdc = Number((effectivePrice * args.candidateSize).toFixed(6));
  const marketOrphanNotionalUsdc = Number((currentOrphanNotionalUsdc(args.state) + notionalUsdc).toFixed(6));
  const fairValue = fairValueForOrphanSide(args.fairValueSnapshot, args.side);
  const fairPremium = fairValue !== undefined ? Number((effectivePrice - fairValue).toFixed(6)) : undefined;
  let reason: string | undefined;

  if (args.candidateSize > args.config.maxSingleOrphanQty + 1e-6) {
    reason = "orphan_qty";
  } else if (notionalUsdc > args.config.orphanLegMaxNotionalUsdc + 1e-6) {
    reason = "orphan_notional";
  } else if (marketOrphanNotionalUsdc > args.config.maxMarketOrphanUsdc + 1e-6) {
    reason = "market_orphan_budget";
  } else if (effectivePrice > args.config.singleLegOrphanCap + 1e-9) {
    reason = "single_leg_orphan_cap";
  } else if (
    args.config.singleLegFairValueVeto &&
    fairPremium !== undefined &&
    fairPremium > args.config.singleLegOrphanMaxFairPremium + 1e-9
  ) {
    reason = "orphan_fair_value";
  }

  return {
    allowed: reason === undefined,
    effectivePrice: Number(effectivePrice.toFixed(6)),
    notionalUsdc,
    marketOrphanNotionalUsdc,
    ...(fairValue !== undefined ? { fairValue } : {}),
    ...(fairPremium !== undefined ? { fairPremium } : {}),
    ...(reason ? { reason } : {}),
  };
}

function orphanGateReason(side: OutcomeSide, risk: OrphanRiskTrace): string | undefined {
  return risk.reason ? `${side.toLowerCase()}_${risk.reason}` : undefined;
}

function orphanRiskSortValue(risk: OrphanRiskTrace): number {
  const premiumPenalty = Math.max(0, risk.fairPremium ?? 0) * 10;
  const disallowedPenalty = risk.allowed ? 0 : 1_000;
  return disallowedPenalty + premiumPenalty + risk.effectivePrice + risk.notionalUsdc / 100;
}

function protectedResidualAllowance(
  config: XuanStrategyConfig,
  ctx: Pick<EntryLadderContext, "protectedResidualShares" | "protectedResidualSide">,
  side: OutcomeSide,
): number {
  const protectedShares = Number(Math.max(0, ctx.protectedResidualShares ?? 0).toFixed(6));
  if (protectedShares <= 1e-6) {
    return 0;
  }
  if (ctx.protectedResidualSide === side) {
    return protectedShares;
  }
  const severity = classifyResidualSeverity(config, protectedShares);
  if (severity.level === "micro") {
    return Number((protectedShares * 0.85).toFixed(6));
  }
  if (severity.level === "small") {
    return Number((protectedShares * 0.45).toFixed(6));
  }
  if (severity.level === "medium") {
    return Number((protectedShares * 0.2).toFixed(6));
  }
  return 0;
}

function recentTemporalSequenceBias(state: XuanMarketState, side: OutcomeSide): number {
  const recentBuys = state.fillHistory.filter((fill) => fill.side === "BUY").slice(-4);
  if (recentBuys.length === 0) {
    return 0;
  }

  const lastBuy = recentBuys[recentBuys.length - 1]!;
  const sameCount = recentBuys.filter((fill) => fill.outcome === side).length;
  const oppositeCount = recentBuys.length - sameCount;
  let score = lastBuy.outcome !== side ? 1 : -0.4;
  score += (oppositeCount - sameCount) / Math.max(1, recentBuys.length);

  if (
    state.lastFilledSide === side &&
    state.lastExecutionMode !== undefined &&
    [
      "PARTIAL_FAST_COMPLETION",
      "PARTIAL_SOFT_COMPLETION",
      "PARTIAL_EMERGENCY_COMPLETION",
      "POST_MERGE_RESIDUAL_COMPLETION",
      "HIGH_LOW_COMPLETION_CHASE",
      "CHEAP_LATE_COMPLETION_CHASE",
    ].includes(state.lastExecutionMode)
  ) {
    score += 0.75;
  }

  if (
    state.lastFilledSide === side &&
    (state.lastExecutionMode === "TEMPORAL_SINGLE_LEG_SEED" || state.lastExecutionMode === "PAIRGROUP_COVERED_SEED")
  ) {
    score -= 0.5;
  }

  return Number(score.toFixed(6));
}

function bundledOpenSequencePriorBias(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  marketSlug: string;
  side: OutcomeSide;
  secsFromOpen: number;
}): number {
  if (args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return 0;
  }
  if (args.state.upShares + args.state.downShares > 1e-6) {
    return 0;
  }
  if (args.state.fillHistory.some((fill) => fill.side === "BUY")) {
    return 0;
  }

  const prior = resolveBundledOpenSequencePrior(args.marketSlug);
  if (!prior || args.secsFromOpen > prior.activeUntilSec + 1e-9) {
    return 0;
  }

  return args.side === prior.side ? 1.25 : -0.95;
}

function bundledSeedSequencePriorBias(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  marketSlug: string;
  side: OutcomeSide;
  secsFromOpen: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
}): { bias: number; fairValueScale: number } {
  if (args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return { bias: 0, fairValueScale: 1 };
  }
  if (Math.abs(args.state.upShares - args.state.downShares) > 1e-6) {
    return { bias: 0, fairValueScale: 1 };
  }

  const prior = resolveBundledSeedSequencePrior(args.marketSlug, args.secsFromOpen);
  if (!prior) {
    return { bias: 0, fairValueScale: 1 };
  }
  if (prior.scope === "family" && args.fairValueSnapshot?.status === "valid") {
    return { bias: 0, fairValueScale: 1 };
  }

  const sameSide = args.side === prior.side;
  const phaseWeight = prior.phase === "ENTRY" ? 1 : 0.9;
  return {
    bias: sameSide ? 1.35 * phaseWeight : -1.05 * phaseWeight,
    fairValueScale: prior.scope === "exact" ? 0.55 : 0.75,
  };
}

function shouldPreferTemporalCloneCycleOverBalancedPair(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  ctx: EntryLadderContext;
  bestCandidate: BalancedPairCandidate;
  flowPressureState: FlowPressureBudgetState;
}): boolean {
  if (args.config.botMode !== "XUAN") {
    return false;
  }
  const openPrior = resolveBundledOpenSequencePrior(args.state.market.slug);
  const openPriorActive =
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    args.state.fillHistory.every((fill) => fill.side !== "BUY") &&
    openPrior !== undefined &&
    args.ctx.secsFromOpen <= openPrior.activeUntilSec + 1e-9;
  const prior = resolveBundledSeedSequencePrior(args.state.market.slug, args.ctx.secsFromOpen);
  const referencePriorActive =
    prior !== undefined &&
    !(prior.scope === "family" && args.ctx.fairValueSnapshot?.status === "valid") &&
    args.ctx.secsFromOpen >= prior.activeFromSec - 1e-9 &&
    args.ctx.secsFromOpen <= prior.activeUntilSec + 1e-9;
  if (args.bestCandidate.mode === "STRICT_PAIR_SWEEP" && !openPriorActive && !referencePriorActive) {
    return false;
  }
  const recentFlowDensity = args.ctx.recentSeedFlowCount ?? 0;
  const pairGatePressure = Math.max(0, args.ctx.pairGatePressure ?? 0);
  const flowBudgetAssertive =
    args.flowPressureState.assertive && args.flowPressureState.remainingBudget >= 0.4;
  const ongoingFlow =
    recentFlowDensity >= 1 ||
    args.state.fillHistory.some((fill) => fill.side === "BUY");
  if (!ongoingFlow) {
    return false;
  }
  const residualOverlapBias =
    (args.ctx.protectedResidualShares ?? 0) > Math.max(args.config.repairMinQty, args.config.completionMinQty);
  if (openPriorActive) {
    return true;
  }
  if (args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" && referencePriorActive) {
    return true;
  }
  if (
    args.ctx.childOrderMicroTimingBias === "flow_intent" &&
    args.ctx.semanticRoleAlignmentBias === "cycle_role_arbitration" &&
    shouldPreferFlowIntentTemporalSeedChildOrder(args.ctx) &&
    recentFlowDensity >= 1
  ) {
    const pairFirstSide = preferredBalancedPairFirstSide(
      args.config,
      args.state,
      args.ctx.secsFromOpen,
      args.ctx.childOrderMicroTimingBias,
      args.bestCandidate,
    );
    const temporalRhythmSide = preferredTemporalSeedRhythmSide(args.state);
    const spread = Math.abs(args.bestCandidate.upExecution.averagePrice - args.bestCandidate.downExecution.averagePrice);
    if (pairFirstSide !== temporalRhythmSide && spread < 0.55) {
      return true;
    }
  }
  return (
    recentFlowDensity >= 2 ||
    flowBudgetAssertive ||
    (pairGatePressure >= 0.03 && (recentFlowDensity >= 1 || residualOverlapBias))
  );
}

function shouldUseCheapLateCompletionChase(args: {
  config: XuanStrategyConfig;
  completionQtyPrior:
    | {
        internalLabel: string;
        scope: "exact" | "family";
      }
    | undefined;
  oppositeAveragePrice: number;
  missingSidePrice: number;
  partialAgeSec: number;
}): boolean {
  if (args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return false;
  }
  if (args.completionQtyPrior?.internalLabel === "CHEAP_LATE_COMPLETION") {
    return true;
  }
  return (
    args.completionQtyPrior?.scope === "exact" &&
    args.partialAgeSec >= Math.max(10, args.config.partialFastWindowSec) &&
    args.missingSidePrice <= args.config.lowSideMaxForHighCompletion + 0.02 &&
    args.oppositeAveragePrice >= args.config.highSidePriceThreshold - 0.02
  );
}

function scoreTemporalSeedCycle(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  marketSlug: string;
  side: OutcomeSide;
  secsFromOpen: number;
  seedQuote: ExecutionQuote;
  oppositeQuote: ExecutionQuote;
  candidateSize: number;
  executableSize: number;
  oppositeCoverageRatio: number;
  referencePairCost: number;
  orphanRisk: OrphanRiskTrace;
  protectedResidualShares?: number | undefined;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  openingSeedReleaseBias?: "neutral" | "earlier" | "later" | undefined;
  semanticRoleAlignmentBias?: EntryLadderContext["semanticRoleAlignmentBias"];
  completionRoleReleaseOrderBias?: EntryLadderContext["completionRoleReleaseOrderBias"];
}): number {
  const oppositeSide: OutcomeSide = args.side === "UP" ? "DOWN" : "UP";
  const timedSequencePrior = bundledSeedSequencePriorBias({
    config: args.config,
    state: args.state,
    marketSlug: args.marketSlug,
    side: args.side,
    secsFromOpen: args.secsFromOpen,
    fairValueSnapshot: args.fairValueSnapshot,
  });
  const ownFairValue = fairValueForOrphanSide(args.fairValueSnapshot, args.side);
  const oppositeFairValue = fairValueForOrphanSide(args.fairValueSnapshot, oppositeSide);
  const protectedResidualShares = Math.max(0, args.protectedResidualShares ?? 0);
  const residualSeverity = classifyResidualSeverity(args.config, protectedResidualShares);
  const residualPressure =
    protectedResidualShares > 0 ? residualSeverityPressure(args.config, protectedResidualShares) : 1;
  const residualFairValueScale =
    protectedResidualShares > 0 ? Number(Math.max(0.35, 1 - residualPressure * 0.55).toFixed(6)) : 1;
  const ownDiscount =
    ownFairValue !== undefined
      ? (ownFairValue - args.seedQuote.averagePrice) * timedSequencePrior.fairValueScale * residualFairValueScale
      : 0;
  const repairDiscount =
    oppositeFairValue !== undefined
      ? (oppositeFairValue - args.oppositeQuote.averagePrice) * timedSequencePrior.fairValueScale * residualFairValueScale
      : 0;
  const behaviorRoom =
    Number.isFinite(args.referencePairCost) ? args.config.xuanBehaviorCap - args.referencePairCost : -1;
  const depthRatio = args.candidateSize > 0 ? args.executableSize / args.candidateSize : 0;
  const orphanPenalty = orphanRiskSortValue(args.orphanRisk);
  const sequenceBias = recentTemporalSequenceBias(args.state, args.side);
  const seedRhythmSide = preferredTemporalSeedRhythmSide(args.state);
  const seedRhythmBias = seedRhythmSide === args.side ? 1 : -0.65;
  const sequenceBiasBoost =
    (args.state.upShares + args.state.downShares <= 1e-6 ? 1.25 : 1) *
    (args.fairValueSnapshot?.status === "valid" || args.fairValueSnapshot?.status === "disabled" ? 1 : 1.15);
  const timedPriorBoost =
    protectedResidualShares > 0 ? Number((1 + Math.max(0, 1 - residualPressure) * 0.6).toFixed(6)) : 1;
  const recentSequenceScale =
    protectedResidualShares > 0 ? Number((0.45 + Math.min(1, residualPressure) * 0.55).toFixed(6)) : 1;
  const openSequencePriorBias = bundledOpenSequencePriorBias({
    config: args.config,
    state: args.state,
    marketSlug: args.marketSlug,
    side: args.side,
    secsFromOpen: args.secsFromOpen,
  });
  const lateAsymmetricSetupBias = lateAsymmetricCompletionSetupBias({
    config: args.config,
    state: args.state,
    side: args.side,
    secsFromOpen: args.secsFromOpen,
    seedPrice: args.seedQuote.averagePrice,
    oppositePrice: args.oppositeQuote.averagePrice,
    referencePairCost: args.referencePairCost,
    oppositeCoverageRatio: args.oppositeCoverageRatio,
    protectedResidualShares,
    semanticRoleAlignmentBias: args.semanticRoleAlignmentBias,
  });
  const completionRoleOrderScore = completionReleaseRoleOrderScore({
    config: args.config,
    side: args.side,
    secsFromOpen: args.secsFromOpen,
    seedPrice: args.seedQuote.averagePrice,
    oppositePrice: args.oppositeQuote.averagePrice,
    oppositeCoverageRatio: args.oppositeCoverageRatio,
    referencePairCost: args.referencePairCost,
    completionRoleReleaseOrderBias: args.completionRoleReleaseOrderBias,
  });
  const openingReleaseBias =
    args.state.upShares + args.state.downShares <= 1e-6 &&
    !args.state.fillHistory.some((fill) => fill.side === "BUY") &&
    args.secsFromOpen <= 20
      ? args.openingSeedReleaseBias === "earlier"
        ? 0.45
        : args.openingSeedReleaseBias === "later"
          ? -0.45
          : 0
      : 0;

  return Number(
    (
      ownDiscount * args.config.temporalSeedOwnDiscountWeight +
      repairDiscount * args.config.temporalSeedRepairDiscountWeight +
      behaviorRoom * args.config.temporalSeedBehaviorRoomWeight +
      args.oppositeCoverageRatio * args.config.temporalSeedOppositeCoverageWeight +
      depthRatio * args.config.temporalSeedDepthWeight +
      sequenceBias * args.config.temporalSeedSequenceBiasWeight * sequenceBiasBoost * recentSequenceScale -
      orphanPenalty * args.config.temporalSeedOrphanPenaltyWeight +
      seedRhythmBias * args.config.temporalSeedSequenceBiasWeight * 0.85 +
      (openSequencePriorBias + timedSequencePrior.bias) *
        args.config.temporalSeedSequenceBiasWeight *
        sequenceBiasBoost *
        timedPriorBoost +
      lateAsymmetricSetupBias * args.config.temporalSeedSequenceBiasWeight +
      completionRoleOrderScore * args.config.temporalSeedSequenceBiasWeight +
      openingReleaseBias * args.config.temporalSeedSequenceBiasWeight
    ).toFixed(6),
  );
}

function completionReleaseRoleOrderScore(args: {
  config: XuanStrategyConfig;
  side: OutcomeSide;
  secsFromOpen: number;
  seedPrice: number;
  oppositePrice: number;
  oppositeCoverageRatio: number;
  referencePairCost: number;
  completionRoleReleaseOrderBias?: EntryLadderContext["completionRoleReleaseOrderBias"];
}): number {
  if (args.config.botMode !== "XUAN" || args.completionRoleReleaseOrderBias !== "role_order") {
    return 0;
  }
  if (args.oppositeCoverageRatio < args.config.temporalSingleLegMinOppositeDepthRatio) {
    return 0;
  }
  if (!Number.isFinite(args.referencePairCost) || args.referencePairCost > args.config.xuanBehaviorCap + 1e-9) {
    return 0;
  }
  const spread = Math.abs(args.seedPrice - args.oppositePrice);
  const projectedCompletionRole =
    args.oppositePrice - args.seedPrice >= 0.08
      ? "expensive"
      : args.oppositePrice - args.seedPrice <= -0.08
        ? "cheap"
        : "mid";
  if (spread >= 0.3 && args.secsFromOpen >= 50) {
    return projectedCompletionRole === "cheap" ? 0.75 : projectedCompletionRole === "expensive" ? -0.45 : -0.2;
  }
  if (spread <= 0.12) {
    return projectedCompletionRole === "mid" ? 0.45 : -0.35;
  }
  if (spread < 0.25) {
    return projectedCompletionRole === "mid" ? 0.25 : projectedCompletionRole === "cheap" ? -0.12 : -0.2;
  }
  return projectedCompletionRole === "cheap" ? 0.25 : 0;
}

function lateAsymmetricCompletionSetupBias(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  side: OutcomeSide;
  secsFromOpen: number;
  seedPrice: number;
  oppositePrice: number;
  referencePairCost: number;
  oppositeCoverageRatio: number;
  protectedResidualShares: number;
  semanticRoleAlignmentBias?: EntryLadderContext["semanticRoleAlignmentBias"];
}): number {
  if (args.config.botMode !== "XUAN") {
    return 0;
  }
  if (args.secsFromOpen < 50 || args.oppositeCoverageRatio < args.config.temporalSingleLegMinOppositeDepthRatio) {
    return 0;
  }
  if (!Number.isFinite(args.referencePairCost) || args.referencePairCost > args.config.xuanBehaviorCap + 1e-9) {
    return 0;
  }
  const exactSeedPrior = args.config.xuanCloneMode === "PUBLIC_FOOTPRINT"
    ? resolveBundledSeedSequencePrior(args.state.market.slug, args.secsFromOpen)?.scope === "exact"
    : false;
  if (exactSeedPrior) {
    return 0;
  }

  const lowPrice = Math.min(args.seedPrice, args.oppositePrice);
  const highPrice = Math.max(args.seedPrice, args.oppositePrice);
  const spread = highPrice - lowPrice;
  const cheapLegVisible = lowPrice <= args.config.lowSideMaxForHighCompletion + 0.04;
  const expensiveButBoundedLeg =
    highPrice >= Math.max(0.58, args.config.highSidePriceThreshold - 0.18) &&
    highPrice <= args.config.singleLegOrphanCap + 0.04;
  if (!cheapLegVisible || !expensiveButBoundedLeg || spread < 0.3) {
    return 0;
  }

  const seedIsHighSide = args.seedPrice >= args.oppositePrice;
  const matchedInventory = Math.min(args.state.upShares, args.state.downShares);
  const matchedInventoryQuality = matchedInventory / Math.max(args.config.liveSmallLotLadder[0] ?? args.config.defaultLot, 1e-6);
  const residualPressure = args.protectedResidualShares > 0 ? residualSeverityPressure(args.config, args.protectedResidualShares) : 0;
  const alignmentMultiplier =
    args.semanticRoleAlignmentBias === "align_high_low_role"
      ? 1.28
      : args.semanticRoleAlignmentBias === "cycle_role_arbitration"
        ? 1.05
      : 1;
  const setupStrength = Math.min(
    1.65,
    (spread * 2 + Math.min(0.5, matchedInventoryQuality * 0.25) + residualPressure * 0.25) *
      alignmentMultiplier,
  );

  return Number((seedIsHighSide ? setupStrength : -setupStrength * 0.85).toFixed(6));
}

function shouldBlockCheapSeedExpensiveCompletionSetup(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  side: OutcomeSide;
  secsFromOpen: number;
  seedPrice: number;
  oppositePrice: number;
  referencePairCost: number;
  oppositeCoverageRatio: number;
  semanticRoleAlignmentBias?: EntryLadderContext["semanticRoleAlignmentBias"];
}): boolean {
  if (args.config.botMode !== "XUAN") {
    return false;
  }
  if (args.secsFromOpen < 50 || args.oppositeCoverageRatio < args.config.temporalSingleLegMinOppositeDepthRatio) {
    return false;
  }
  if (!Number.isFinite(args.referencePairCost) || args.referencePairCost > args.config.xuanBehaviorCap + 1e-9) {
    return false;
  }
  if (args.semanticRoleAlignmentBias !== "align_high_low_role") {
    return false;
  }
  const exactSeedPrior = args.config.xuanCloneMode === "PUBLIC_FOOTPRINT"
    ? resolveBundledSeedSequencePrior(args.state.market.slug, args.secsFromOpen)?.scope === "exact"
    : false;
  if (exactSeedPrior) {
    return false;
  }

  const seedIsCheap = args.seedPrice <= args.config.lowSideMaxForHighCompletion + 0.04;
  const oppositeIsExpensive =
    args.oppositePrice >= Math.max(0.58, args.config.highSidePriceThreshold - 0.18);
  const spread = args.oppositePrice - args.seedPrice;
  return seedIsCheap && oppositeIsExpensive && spread >= 0.3;
}

function preferredTemporalSeedRhythmSide(state: XuanMarketState): OutcomeSide {
  const seedLikeBuys = state.fillHistory.filter(
    (fill) =>
      fill.side === "BUY" &&
      (
        fill.executionMode === "STRICT_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_SOFT_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_HARD_PAIR_SWEEP" ||
        fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" ||
        fill.executionMode === "PAIRGROUP_COVERED_SEED"
      ),
  );
  const lastSeed = seedLikeBuys.at(-1);
  if (!lastSeed) {
    return "UP";
  }
  return lastSeed.outcome === "UP" ? "DOWN" : "UP";
}

function completionCarrySideRhythmBoost(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  side: OutcomeSide;
  activeIndependentFlowCount?: number | undefined;
  recentSeedFlowCount?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  protectedResidualShares?: number | undefined;
}): number {
  if (args.config.botMode !== "XUAN") {
    return 0;
  }
  const completionModes: StrategyExecutionMode[] = [
    "PARTIAL_FAST_COMPLETION",
    "PARTIAL_SOFT_COMPLETION",
    "PARTIAL_EMERGENCY_COMPLETION",
    "POST_MERGE_RESIDUAL_COMPLETION",
    "HIGH_LOW_COMPLETION_CHASE",
    "CHEAP_LATE_COMPLETION_CHASE",
  ];
  if (
    args.state.lastFilledSide === undefined ||
    args.state.lastExecutionMode === undefined ||
    !completionModes.includes(args.state.lastExecutionMode)
  ) {
    return 0;
  }
  const overlapContextActive =
    (args.activeIndependentFlowCount ?? 0) >= 1 ||
    (args.recentSeedFlowCount ?? 0) >= 1 ||
    (args.matchedInventoryQuality ?? 0) >= 0.75 ||
    (args.protectedResidualShares ?? 0) > Math.max(args.config.repairMinQty, args.config.completionMinQty);
  if (!overlapContextActive) {
    return 0;
  }
  const denseFlow =
    (args.activeIndependentFlowCount ?? 0) >= 2 ||
    (args.recentSeedFlowCount ?? 0) >= 2 ||
    (args.matchedInventoryQuality ?? 0) >= 1;
  return args.state.lastFilledSide === args.side
    ? denseFlow
      ? 2.15
      : 1.15
    : denseFlow
      ? -0.95
      : -0.45;
}

function completionResidualCarryQty(args: {
  config: XuanStrategyConfig;
  shareGap: number;
  repairSize: number;
  secsFromOpen: number;
  secsToClose: number;
  residualSeverityLevel: "flat" | "micro" | "small" | "medium" | "aggressive";
  exactPriorActive: boolean;
  overlapRepairArbitration: OverlapRepairArbitration;
}): number {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive) {
    return 0;
  }
  if (args.residualSeverityLevel === "aggressive" || args.shareGap <= args.config.repairMinQty * 2) {
    return 0;
  }
  if (args.secsFromOpen < 150 || args.secsToClose <= args.config.finalWindowCompletionOnlySec) {
    return 0;
  }
  if (args.overlapRepairArbitration === "favor_residual_repair" && args.secsFromOpen < 220) {
    return 0;
  }

  const carryQty = Math.min(5, Math.max(0.75, args.shareGap * 0.08));
  const maxCarryWithoutBlockingOrder = Math.max(0, args.repairSize - args.config.repairMinQty);
  return Number(Math.min(carryQty, maxCarryWithoutBlockingOrder).toFixed(6));
}

function buildResidualRepairCandidateSizes(args: {
  config: XuanStrategyConfig;
  standardSize: number;
  shareGap: number;
  exactPriorActive: boolean;
}): number[] {
  if (args.standardSize <= 0) {
    return [];
  }
  if (args.config.botMode !== "XUAN" || args.exactPriorActive) {
    return [args.standardSize];
  }
  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const microFloor = args.config.repairMinQty;
  const sizes = [
    args.standardSize,
    args.standardSize * 0.7,
    args.standardSize * 0.5,
    Math.min(args.standardSize, args.shareGap * 0.5),
    Math.min(args.standardSize, baseLot * 0.5),
  ]
    .map((size) => normalizeOrderSize(size, microFloor))
    .filter((size) => size > 0);
  return [...new Set(sizes)].sort((left, right) => right - left);
}

function completionCandidateRankScore(
  config: XuanStrategyConfig,
  args: {
    costWithFees: number;
    missingSidePrice: number;
    candidateSize: number;
    missingShares: number;
    partialAgeSec: number;
    fairValuePremium?: number | undefined;
    depthCoverageRatio?: number | undefined;
    gapImprovement?: number | undefined;
    oldGap?: number | undefined;
    residualAfter?: number | undefined;
    exactQtyMatch?: boolean | undefined;
  },
): number {
  if (config.botMode !== "XUAN") {
    return -args.candidateSize;
  }
  const sizeRatio = args.candidateSize / Math.max(args.missingShares, 1e-6);
  const forceSec = Math.max(config.completionUrgencyStrictSec, config.completionUrgencyForceSec);
  const agePressure = Math.max(0, Math.min(1, args.partialAgeSec / Math.max(forceSec, 1e-6)));
  const negativeEdgePenalty = Math.max(0, args.costWithFees - 1) * 35;
  const fairValuePenalty = Math.max(0, args.fairValuePremium ?? 0) * 14;
  const costPenalty = args.costWithFees * 4 + args.missingSidePrice * 1.25 + negativeEdgePenalty + fairValuePenalty;
  const resolutionBonus = (0.02 + agePressure * 0.06) * sizeRatio;
  const depthBonus = Math.min(0.08, Math.max(0, args.depthCoverageRatio ?? 0) * 0.012);
  const gapImprovementRatio = (args.gapImprovement ?? 0) / Math.max(args.oldGap ?? args.missingShares, 1e-6);
  const inventoryShapeBonus = Math.min(0.18, Math.max(0, gapImprovementRatio) * 0.18);
  const cleanupBonus =
    (args.residualAfter ?? Number.POSITIVE_INFINITY) <= config.residualJanitorMaxShareGap + 1e-9 ? 0.06 : 0;
  const exactQtyBonus = args.exactQtyMatch ? 0.5 : 0;
  return Number((costPenalty - resolutionBonus - depthBonus - inventoryShapeBonus - cleanupBonus - exactQtyBonus).toFixed(9));
}

function buildHighLowRepairOvershootQty(args: {
  config: XuanStrategyConfig;
  sideToBuy: OutcomeSide;
  books: OrderBookState;
  existingAverage: number;
  shareGap: number;
  exactPriorActive: boolean;
}): number | undefined {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive || args.shareGap <= 0) {
    return undefined;
  }
  const missingSidePrice = args.books.bestAsk(args.sideToBuy);
  const priceSpikeDelta = missingSidePrice - args.existingAverage;
  const priceSpikeRatio = missingSidePrice / Math.max(args.existingAverage, 0.01);
  const strongHighLowSpike =
    missingSidePrice >= args.config.highSidePriceThreshold - 0.02 &&
    priceSpikeDelta >= 0.45 &&
    priceSpikeRatio >= 2.25;
  const classicHighLow =
    missingSidePrice >= Math.max(0.58, args.config.highSidePriceThreshold - 0.18) &&
    args.existingAverage <= args.config.lowSideMaxForHighCompletion + 0.08;
  if (!classicHighLow && !strongHighLowSpike) {
    return undefined;
  }
  const overshootRatio = missingSidePrice >= args.config.highSidePriceThreshold ? 0.055 : 0.035;
  const overshootQty = normalizeOrderSize(args.shareGap * (1 + overshootRatio), args.config.repairMinQty);
  if (overshootQty <= args.shareGap + 1e-6) {
    return undefined;
  }
  return overshootQty;
}

function shouldHoldLateSmallResidual(args: {
  config: XuanStrategyConfig;
  shareGap: number;
  secsFromOpen: number;
  secsToClose: number;
  residualSeverityLevel: "flat" | "micro" | "small" | "medium" | "aggressive";
  exactPriorActive: boolean;
}): boolean {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive) {
    return false;
  }
  const holdableSeverity =
    args.residualSeverityLevel === "micro" ||
    args.residualSeverityLevel === "small" ||
    (args.residualSeverityLevel === "flat" && args.shareGap > 0.5);
  if (!holdableSeverity) {
    return false;
  }
  if (args.shareGap > 5 + 1e-6) {
    return false;
  }
  return args.secsFromOpen >= 240 || args.secsToClose <= args.config.finalWindowSoftStartSec;
}

function shouldHoldHighLowOvershootResidual(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  leadingSide: OutcomeSide;
  shareGap: number;
  secsFromOpen: number;
  exactPriorActive: boolean;
}): boolean {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive || args.secsFromOpen < 150) {
    return false;
  }
  if (args.shareGap <= 0 || args.shareGap > Math.max(5, args.config.maxCompletionOvershootShares)) {
    return false;
  }
  const residualLots = args.leadingSide === "UP" ? args.state.upLots : args.state.downLots;
  return residualLots.some((lot) => lot.executionMode === "HIGH_LOW_COMPLETION_CHASE");
}

function evaluateTemporalSingleLegSeed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
  dailyNegativeEdgeSpentUsdc: number,
): {
  decision?: EntryBuyDecision;
  trace: SingleLegSeedCandidateTrace[];
  rhythmArbitration?: {
    intendedSide?: OutcomeSide | undefined;
    selectedSide?: OutcomeSide | undefined;
    rejectedSide?: OutcomeSide | undefined;
    scoreDelta?: number | undefined;
    decision: "kept_priority" | "rhythm_override" | "rhythm_micro_fallback" | "no_viable_rhythm_side";
  } | undefined;
  childOrder?: {
    intendedSide?: OutcomeSide | undefined;
    selectedSide?: OutcomeSide | undefined;
    reason: "flow_intent" | "temporal_priority";
  } | undefined;
  semanticRoleTarget?: EntryDecisionTrace["semanticRoleTarget"] | undefined;
} {
  if (
    config.botMode !== "XUAN" ||
    !config.allowTemporalSingleLegSeed ||
    ctx.secsToClose <= Math.max(config.finalWindowNoChaseSec, config.temporalSingleLegTtlSec) ||
    (ctx.secsToClose <= config.finalWindowSoftStartSec && !config.allowSingleLegSeedInLast60S)
  ) {
    return { trace: [] };
  }

  const stickyOverlapCarryActive =
    ctx.forcedOverlapRepairArbitration === "favor_independent_overlap" &&
    (ctx.protectedResidualShares ?? 0) > 0;
  const protectedOverlapActive = Boolean(
    (ctx.allowControlledOverlap || stickyOverlapCarryActive) && (ctx.protectedResidualShares ?? 0) > 0,
  );
  const overlapSeedCap = protectedOverlapActive
    ? Math.max(0, config.controlledOverlapSeedMaxQty)
    : Number.POSITIVE_INFINITY;
  const candidateSize = normalizeOrderSize(
    Math.min(
      ctx.lot,
      config.singleLegSeedMaxQty,
      overlapSeedCap,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
      Math.max(0, config.maxOneSidedExposureShares),
    ),
    state.market.minOrderSize,
  );
  if (candidateSize <= 0) {
    return { trace: [] };
  }

  const selectedMode: StrategyExecutionMode = "TEMPORAL_SINGLE_LEG_SEED";
  const freshCycleStats = buildFreshCycleStats(config, state);
  const referencePriorActive = referenceFreshCyclePriorActive(config, state, ctx);
  const denseCycleThrottle = shouldThrottleNewCycleDensity(config, state, ctx);
  const overlapSequencePrior =
    (ctx.allowControlledOverlap || stickyOverlapCarryActive) && (ctx.protectedResidualShares ?? 0) > 0
      ? resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen)
      : undefined;
  const overlapPriorBoost =
    overlapSequencePrior?.scope === "exact" ? 2.75 : overlapSequencePrior ? 1.35 : 0;
  const preferredOverlapSeedSide =
    ctx.allowControlledOverlap || stickyOverlapCarryActive ? ctx.preferredOverlapSeedSide : undefined;
  const preferredOverlapSeedBoost = preferredOverlapSeedSide ? 1.4 : 0;
  const overlapMatchedInventoryQuality =
    ctx.matchedInventoryQuality ??
    Number(
      Math.min(
        1.25,
        Math.min(state.upShares, state.downShares) /
          Math.max(config.liveSmallLotLadder[0] ?? config.defaultLot, 1e-6),
      ).toFixed(6),
    );
  const completionCarrySideBoost = (side: OutcomeSide): number =>
    completionCarrySideRhythmBoost({
      config,
      state,
      side,
      activeIndependentFlowCount: ctx.activeIndependentFlowCount,
      recentSeedFlowCount: ctx.recentSeedFlowCount,
      matchedInventoryQuality: overlapMatchedInventoryQuality,
      protectedResidualShares: ctx.protectedResidualShares,
    });
  const flowIntentSeedSide =
    ctx.childOrderMicroTimingBias === "flow_intent" && shouldPreferFlowIntentTemporalSeedChildOrder(ctx)
      ? preferredFlowIntentChildOrderSide(state)
      : undefined;
  const flowIntentSeedBoost = flowIntentSeedSide ? 0.55 : 0;
  const rawSideRhythmSide = preferredTemporalSeedRhythmSide(state);
  const rawSideRhythmBoost =
    ctx.childOrderMicroTimingBias === "flow_intent"
      ? ctx.semanticRoleAlignmentBias === "cycle_role_arbitration"
        ? 0.9
        : 0.65
      : 0;
  const priorityScore = (candidate: {
    side: OutcomeSide;
    classifierScore: number;
  }): number =>
    Number(
      (
        candidate.classifierScore +
        (overlapSequencePrior?.side === candidate.side ? overlapPriorBoost : 0) +
        (preferredOverlapSeedSide === candidate.side ? preferredOverlapSeedBoost : 0) +
        (flowIntentSeedSide === candidate.side ? flowIntentSeedBoost : 0) +
        (rawSideRhythmBoost > 0
          ? candidate.side === rawSideRhythmSide
            ? rawSideRhythmBoost
            : -rawSideRhythmBoost * 0.35
          : 0) +
        completionCarrySideBoost(candidate.side)
      ).toFixed(6),
    );
  const buildTemporalSeedCandidate = (
    side: OutcomeSide,
    requestedSize: number,
    sizingMode: TemporalSeedCandidate["sizingMode"],
  ): TemporalSeedCandidate => {
    const oppositeSide: OutcomeSide = side === "UP" ? "DOWN" : "UP";
    const currentSideShares = side === "UP" ? state.upShares : state.downShares;
    const oppositeShares = oppositeSide === "UP" ? state.upShares : state.downShares;
    const initialSeedQuote = books.quoteForSize(side, "ask", requestedSize);
    const initialSeedFilledSize = normalizeOrderSize(initialSeedQuote.filledSize, state.market.minOrderSize);
    const initialOppositeQuote = books.quoteForSize(oppositeSide, "ask", requestedSize);
    const initialOppositeFilledSize = normalizeOrderSize(initialOppositeQuote.filledSize, state.market.minOrderSize);
    const maxSeedByOppositeDepth = initialOppositeFilledSize / Math.max(config.temporalSingleLegMinOppositeDepthRatio, 1e-6);
    const executableSize = normalizeOrderSize(
      Math.min(requestedSize, initialSeedFilledSize, maxSeedByOppositeDepth),
      state.market.minOrderSize,
    );
    const seedQuote =
      executableSize > 0 ? books.quoteForSize(side, "ask", executableSize) : initialSeedQuote;
    const oppositeQuote =
      executableSize > 0 ? books.quoteForSize(oppositeSide, "ask", executableSize) : initialOppositeQuote;
    const oppositeFilledSize = normalizeOrderSize(oppositeQuote.filledSize, state.market.minOrderSize);
    const oppositeCoverageRatio =
      executableSize > 0 ? Number((oppositeFilledSize / executableSize).toFixed(6)) : 0;
    const effectivePricePerShare =
      seedQuote.averagePrice + takerFeePerShare(seedQuote.averagePrice, config.cryptoTakerFeeRate);
    const referencePairCost =
      executableSize > 0
        ? pairCostWithBothTaker(
            side === "UP" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
            side === "DOWN" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
            config.cryptoTakerFeeRate,
          )
        : Number.POSITIVE_INFINITY;
    const rawPairCost =
      executableSize > 0 ? seedQuote.averagePrice + oppositeQuote.averagePrice : Number.POSITIVE_INFINITY;
    const cycleTrace =
      executableSize > 0
        ? cycleTraceFromPair(config, rawPairCost, referencePairCost, executableSize)
        : {
            rawPair: Number.POSITIVE_INFINITY,
            effectivePair: Number.POSITIVE_INFINITY,
            feeUSDC: 0,
            expectedNetIfMerged: 0,
            cycleQualityLabel: "BAD_PAIR" as const,
          };
    const negativeEdgeUsdc = executableSize > 0 ? Math.max(0, referencePairCost - 1) * executableSize : 0;
    const projectedGap = Math.abs(currentSideShares + executableSize - oppositeShares);
    const effectiveProjectedGap = Math.max(0, projectedGap - protectedResidualAllowance(config, ctx, side));
    const cheapSeedExpensiveCompletionBlocked = shouldBlockCheapSeedExpensiveCompletionSetup({
      config,
      state,
      side,
      secsFromOpen: ctx.secsFromOpen,
      seedPrice: seedQuote.averagePrice,
      oppositePrice: oppositeQuote.averagePrice,
      referencePairCost,
      oppositeCoverageRatio,
      semanticRoleAlignmentBias: ctx.semanticRoleAlignmentBias,
    });
    const sameSideOverlapAmplificationBlocked =
      (ctx.protectedResidualShares ?? 0) > Math.max(config.repairMinQty, config.completionMinQty) &&
      ctx.protectedResidualSide === side &&
      overlapSequencePrior?.scope !== "exact";
    let skipReason: string | undefined;

    if (denseCycleThrottle) {
      skipReason = denseCycleThrottle;
      } else {
        skipReason = freshCycleCandidateSkipReason(
          config,
          state,
          freshCycleStats,
          cycleTrace.cycleQualityLabel,
          referencePriorActive,
          {
            route: "temporal_seed",
            ctx,
            requestedSize: executableSize > 0 ? executableSize : requestedSize,
            rawPair: rawPairCost,
            effectivePair: referencePairCost,
          },
        );
      }

    if (skipReason === undefined) {
      if (cheapSeedExpensiveCompletionBlocked) {
        skipReason = "cheap_seed_expensive_completion_guard";
      } else if (sameSideOverlapAmplificationBlocked) {
        skipReason = "overlap_same_side_amplification";
      } else if (state.consecutiveSeedSide === side && state.consecutiveSeedCount >= config.maxConsecutiveSingleLegSeedsPerSide) {
        skipReason = "temporal_seed_side_limit";
      } else if (initialSeedFilledSize <= 0 || executableSize <= 0) {
        skipReason = "temporal_seed_depth";
      } else if (oppositeCoverageRatio + 1e-6 < config.temporalSingleLegMinOppositeDepthRatio) {
        skipReason = "temporal_seed_opposite_depth";
      } else if (effectiveProjectedGap > config.maxOneSidedExposureShares + 1e-6) {
        skipReason = "temporal_seed_one_sided_exposure";
      } else if (referencePairCost > config.xuanBehaviorCap + 1e-9) {
        skipReason = "temporal_behavior_cap";
      } else if (negativeEdgeUsdc > config.maxNegativePairEdgePerCycleUsdc + 1e-9) {
        skipReason = "temporal_cycle_budget";
      } else if (state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc > config.maxNegativePairEdgePerMarketUsdc + 1e-9) {
        skipReason = "temporal_market_budget";
      } else if (dailyNegativeEdgeSpentUsdc + negativeEdgeUsdc > config.maxNegativeDailyBudgetUsdc + 1e-9) {
        skipReason = "temporal_daily_budget";
      }
    }

    const fairValueDecision = fairValueGate({
      config,
      snapshot: ctx.fairValueSnapshot,
      side,
      sidePrice: seedQuote.averagePrice,
      mode: "seed",
      secsToClose: ctx.secsToClose,
      effectiveCost: referencePairCost,
      required: config.fairValueFailClosedForSeed,
    });
    const orphanRisk = evaluateOrphanRisk({
      config,
      state,
      side,
      execution: seedQuote,
      candidateSize: executableSize > 0 ? executableSize : requestedSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const classifierScore = scoreTemporalSeedCycle({
      config,
      state,
      marketSlug: state.market.slug,
      side,
      secsFromOpen: ctx.secsFromOpen,
      seedQuote,
      oppositeQuote,
      candidateSize: requestedSize,
      executableSize,
      oppositeCoverageRatio,
      referencePairCost,
      orphanRisk,
      protectedResidualShares: ctx.protectedResidualShares,
      fairValueSnapshot: ctx.fairValueSnapshot,
      openingSeedReleaseBias: ctx.openingSeedReleaseBias,
      semanticRoleAlignmentBias: ctx.semanticRoleAlignmentBias,
      completionRoleReleaseOrderBias: ctx.completionRoleReleaseOrderBias,
    });

    return {
      side,
      requestedSize,
      sizingMode,
      seedQuote,
      oppositeQuote,
      executableSize,
      oppositeFilledSize,
      oppositeCoverageRatio,
      effectivePricePerShare,
      referencePairCost,
      negativeEdgeUsdc,
      rawPairCost,
      feeUSDC: cycleTrace.feeUSDC,
      expectedNetIfMerged: cycleTrace.expectedNetIfMerged,
      cycleQualityLabel: cycleTrace.cycleQualityLabel,
      orphanRisk,
      fairValueDecision,
      classifierScore,
      skipReason,
    };
  };
  const standardCandidates = (["UP", "DOWN"] as OutcomeSide[]).map((side) =>
    buildTemporalSeedCandidate(side, candidateSize, "standard"),
  );
  const candidates = [
    ...standardCandidates,
    ...standardCandidates.flatMap((candidate) =>
      buildTemporalSeedMicroFallbackCandidates({
        config,
        state,
        candidateSize,
        side: candidate.side,
        standardCandidate: candidate,
        buildTemporalSeedCandidate,
      }),
    ),
  ].sort((left, right) => {
    const rightPriorityScore = priorityScore(right);
    const leftPriorityScore = priorityScore(left);
    if (rightPriorityScore !== leftPriorityScore) {
      return rightPriorityScore - leftPriorityScore;
    }
    return orphanRiskSortValue(left.orphanRisk) - orphanRiskSortValue(right.orphanRisk);
  });
  const rhythmArbitration = resolveTemporalSeedSideRhythmArbitration({
    config,
    state,
    ctx,
    candidates,
    priorityScore,
    overlapSequencePriorScope: overlapSequencePrior?.scope,
    overlapSequencePriorSide: overlapSequencePrior?.side,
  });
  if (rhythmArbitration.overrideIndex > 0) {
    const [rhythmCandidate] = candidates.splice(rhythmArbitration.overrideIndex, 1);
    if (rhythmCandidate) {
      candidates.unshift(rhythmCandidate);
    }
  }
  if (preferredOverlapSeedSide) {
    const preferredIndex = candidates.findIndex(
      (candidate) =>
        candidate.side === preferredOverlapSeedSide &&
        candidate.skipReason === undefined &&
        candidate.fairValueDecision.allowed &&
        candidate.orphanRisk.allowed,
    );
    if (preferredIndex > 0) {
      const [preferredCandidate] = candidates.splice(preferredIndex, 1);
      if (preferredCandidate) {
        candidates.unshift(preferredCandidate);
      }
    }
  }
  if (
    candidates[0]?.sizingMode === "rhythm_micro" &&
    rhythmArbitration.intendedSide === candidates[0].side
  ) {
    rhythmArbitration.selectedSide = candidates[0].side;
    rhythmArbitration.rejectedSide = candidates.find((candidate) => candidate.sizingMode === "standard")?.side;
    rhythmArbitration.scoreDelta = Number(
      (
        (candidates.find((candidate) => candidate.sizingMode === "standard")
          ? priorityScore(candidates.find((candidate) => candidate.sizingMode === "standard")!)
          : priorityScore(candidates[0])) - priorityScore(candidates[0])
      ).toFixed(6),
    );
    rhythmArbitration.decision = "rhythm_micro_fallback";
  }

  const traces: SingleLegSeedCandidateTrace[] = [];
  let decision: EntryBuyDecision | undefined;
  const selectedPriorityScore = candidates[0] ? priorityScore(candidates[0]) : undefined;

  for (const candidate of candidates) {
    const traceSkipReason = candidate.skipReason ?? candidate.fairValueDecision.reason ?? candidate.orphanRisk.reason;
    const candidatePriorityScore = priorityScore(candidate);
    traces.push({
      side: candidate.side,
      requestedSize: candidate.requestedSize,
      filledSize: candidate.executableSize,
      sizingMode: candidate.sizingMode,
      semanticRoleTarget: semanticRoleTargetForPair(
        candidate.side === "UP" ? candidate.seedQuote.averagePrice : candidate.oppositeQuote.averagePrice,
        candidate.side === "DOWN" ? candidate.seedQuote.averagePrice : candidate.oppositeQuote.averagePrice,
        ctx.semanticRoleAlignmentBias,
      ),
      oppositeFilledSize: candidate.oppositeFilledSize,
      oppositeCoverageRatio: candidate.oppositeCoverageRatio,
      classifierScore: candidate.classifierScore,
      priorityScore: candidatePriorityScore,
      ...(selectedPriorityScore !== undefined
        ? { priorityScoreDelta: Number((selectedPriorityScore - candidatePriorityScore).toFixed(6)) }
        : {}),
      completionRoleOrderScore: completionReleaseRoleOrderScore({
        config,
        side: candidate.side,
        secsFromOpen: ctx.secsFromOpen,
        seedPrice: candidate.seedQuote.averagePrice,
        oppositePrice: candidate.oppositeQuote.averagePrice,
        oppositeCoverageRatio: candidate.oppositeCoverageRatio,
        referencePairCost: candidate.referencePairCost,
        completionRoleReleaseOrderBias: ctx.completionRoleReleaseOrderBias,
      }),
      averagePrice: candidate.seedQuote.averagePrice,
      limitPrice: candidate.seedQuote.limitPrice,
      effectivePricePerShare: candidate.effectivePricePerShare,
      referencePairCost: candidate.referencePairCost,
      rawPair: candidate.rawPairCost,
      effectivePair: candidate.referencePairCost,
      feeUSDC: candidate.feeUSDC,
      expectedNetIfMerged: candidate.expectedNetIfMerged,
      cycleQualityLabel: candidate.cycleQualityLabel,
      ...(candidate.skipReason === "fresh_cycle_borderline_pair" || candidate.skipReason === "fresh_cycle_bad_pair"
        ? { cycleSkippedReason: candidate.skipReason }
        : {}),
      negativeEdgeUsdc: candidate.negativeEdgeUsdc,
      orphanRisk: candidate.orphanRisk,
      allowed: candidate.skipReason === undefined && candidate.fairValueDecision.allowed && candidate.orphanRisk.allowed,
      ...(candidate.skipReason === undefined && candidate.fairValueDecision.allowed && candidate.orphanRisk.allowed
        ? { selectedMode }
        : {}),
      ...(traceSkipReason ? { skipReason: traceSkipReason } : {}),
    });

    if (!decision && candidate.skipReason === undefined && candidate.fairValueDecision.allowed && candidate.orphanRisk.allowed) {
      decision = buildEntryBuy(
        state,
        candidate.side,
        {
          ...candidate.seedQuote,
          requestedSize: candidate.executableSize,
          filledSize: candidate.executableSize,
          fullyFilled: candidate.seedQuote.filledSize + 1e-9 >= candidate.executableSize,
        },
        "temporal_single_leg_seed",
        selectedMode,
        config.cryptoTakerFeeRate,
        candidate.referencePairCost,
        candidate.negativeEdgeUsdc,
        candidate.seedQuote.averagePrice + candidate.oppositeQuote.averagePrice,
      );
    }
  }

  return {
    ...(decision ? { decision } : {}),
    trace: traces,
    rhythmArbitration,
    childOrder: {
      ...(flowIntentSeedSide ? { intendedSide: flowIntentSeedSide } : {}),
      ...(decision ? { selectedSide: decision.side } : {}),
      reason: flowIntentSeedSide ? "flow_intent" : "temporal_priority",
    },
    semanticRoleTarget: decision
      ? traces.find((trace) => trace.allowed && trace.side === decision.side)?.semanticRoleTarget
      : undefined,
  };
}

function buildTemporalSeedMicroFallbackCandidates(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  candidateSize: number;
  side: OutcomeSide;
  standardCandidate: TemporalSeedCandidate;
  buildTemporalSeedCandidate: (
    side: OutcomeSide,
    requestedSize: number,
    sizingMode: TemporalSeedCandidate["sizingMode"],
  ) => TemporalSeedCandidate;
}): TemporalSeedCandidate[] {
  if (!shouldTryTemporalSeedMicroFallback(args.standardCandidate)) {
    return [];
  }
  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const sizes = Array.from(
    new Set(
      [
        args.candidateSize * 0.7,
        args.candidateSize * 0.5,
        Math.min(args.candidateSize, baseLot * 0.5),
      ]
        .map((size) => normalizeOrderSize(size, args.state.market.minOrderSize))
        .filter((size) => size > 0 && size < args.candidateSize),
    ),
  ).sort((left, right) => right - left);

  const candidates: TemporalSeedCandidate[] = [];
  for (const size of sizes) {
    const candidate = args.buildTemporalSeedCandidate(args.side, size, "rhythm_micro");
    if (
      candidate.skipReason === undefined &&
      candidate.fairValueDecision.allowed &&
      candidate.orphanRisk.allowed
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function shouldTryTemporalSeedMicroFallback(candidate: TemporalSeedCandidate): boolean {
  if (
    candidate.skipReason === undefined &&
    candidate.fairValueDecision.allowed &&
    candidate.orphanRisk.allowed
  ) {
    return false;
  }
  const sizeSensitiveSkipReasons = new Set<string>([
    "temporal_seed_depth",
    "temporal_seed_opposite_depth",
    "temporal_seed_one_sided_exposure",
    "temporal_cycle_budget",
    "temporal_market_budget",
    "temporal_daily_budget",
  ]);
  const sizeSensitiveOrphanReasons = new Set<string>([
    "orphan_qty",
    "orphan_notional",
    "market_orphan_budget",
  ]);
  return (
    (candidate.skipReason !== undefined && sizeSensitiveSkipReasons.has(candidate.skipReason)) ||
    (candidate.orphanRisk.reason !== undefined && sizeSensitiveOrphanReasons.has(candidate.orphanRisk.reason))
  );
}

function resolveTemporalSeedSideRhythmArbitration(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  ctx: EntryLadderContext;
  candidates: TemporalSeedCandidate[];
  priorityScore: (candidate: { side: OutcomeSide; classifierScore: number }) => number;
  overlapSequencePriorScope?: "exact" | "family" | undefined;
  overlapSequencePriorSide?: OutcomeSide | undefined;
}): {
  intendedSide?: OutcomeSide | undefined;
  selectedSide?: OutcomeSide | undefined;
  rejectedSide?: OutcomeSide | undefined;
  scoreDelta?: number | undefined;
  decision: "kept_priority" | "rhythm_override" | "rhythm_micro_fallback" | "no_viable_rhythm_side";
  overrideIndex: number;
} {
  const selected = args.candidates[0];
  if (args.config.botMode !== "XUAN" || !selected) {
    return { decision: "kept_priority", overrideIndex: -1 };
  }

  const intendedSide = preferredTemporalSeedRhythmSide(args.state);
  const rhythmIndex = args.candidates.findIndex(
    (candidate) =>
      candidate.side === intendedSide &&
      candidate.skipReason === undefined &&
      candidate.fairValueDecision.allowed &&
      candidate.orphanRisk.allowed,
  );
  if (rhythmIndex < 0) {
    return {
      intendedSide,
      selectedSide: selected.side,
      decision: "no_viable_rhythm_side",
      overrideIndex: -1,
    };
  }

  const rhythmCandidate = args.candidates[rhythmIndex]!;
  const selectedPriorityScore = args.priorityScore(selected);
  const rhythmPriorityScore = args.priorityScore(rhythmCandidate);
  const scoreDelta = Number((selectedPriorityScore - rhythmPriorityScore).toFixed(6));
  const protectedResidualShares = Math.max(0, args.ctx.protectedResidualShares ?? 0);
  const residualPressure =
    protectedResidualShares > 0 ? residualSeverityPressure(args.config, protectedResidualShares) : 0;
  const denseFlow =
    (args.ctx.activeIndependentFlowCount ?? 0) >= 1 ||
    (args.ctx.recentSeedFlowCount ?? 0) >= 2 ||
    (args.ctx.matchedInventoryQuality ?? 0) >= 0.75;
  const priorConflictPenalty =
    args.overlapSequencePriorScope === "exact" && args.overlapSequencePriorSide !== intendedSide ? 0.45 : 0;
  const preserveRawSideBoost =
    args.ctx.semanticRoleAlignmentBias === "preserve_raw_side"
      ? 0.35
      : args.ctx.semanticRoleAlignmentBias === "cycle_role_arbitration"
        ? args.ctx.childOrderMicroTimingBias === "flow_intent"
          ? 0.42
          : 0.16
        : 0;
  const tolerance = Number(
    Math.max(
      0.35,
      0.65 +
        (denseFlow ? 0.4 : 0) +
        Math.min(0.35, residualPressure * 0.35) +
        preserveRawSideBoost -
        priorConflictPenalty,
    ).toFixed(6),
  );
  const shouldOverride = rhythmIndex > 0 && scoreDelta <= tolerance + 1e-9;

  return {
    intendedSide,
    selectedSide: shouldOverride ? rhythmCandidate.side : selected.side,
    rejectedSide: shouldOverride ? selected.side : rhythmCandidate.side,
    scoreDelta,
    decision: shouldOverride ? "rhythm_override" : "kept_priority",
    overrideIndex: shouldOverride ? rhythmIndex : -1,
  };
}

function shouldThrottleNewCycleDensity(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  ctx: EntryLadderContext,
): string | undefined {
  if (config.botMode !== "XUAN") {
    return undefined;
  }
  const protectedResidualShares = Math.max(0, ctx.protectedResidualShares ?? 0);
  const protectedResidualActive = protectedResidualShares > Math.max(config.repairMinQty, config.completionMinQty);
  const exactSeedPrior = config.xuanCloneMode === "PUBLIC_FOOTPRINT"
    ? resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen)?.scope === "exact"
    : false;
  const recentCycleOpeners = state.fillHistory.filter(
    (fill) =>
      fill.side === "BUY" &&
      ctx.secsFromOpen - Math.max(0, fill.timestamp - state.market.startTs) <= 120 &&
      (
        fill.executionMode === "STRICT_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_SOFT_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_HARD_PAIR_SWEEP" ||
        fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" ||
        fill.executionMode === "PAIRGROUP_COVERED_SEED"
      ),
  ).length;

  if (protectedResidualActive || exactSeedPrior) {
    return undefined;
  }
  if (ctx.secsFromOpen < 120) {
    return undefined;
  }
  if (ctx.secsToClose <= Math.max(config.finalWindowCompletionOnlySec, config.temporalSingleLegTtlSec)) {
    return undefined;
  }
  if (
    ctx.secsFromOpen >= 150 &&
    ctx.flowPressureState?.confirmed &&
    ctx.flowPressureState.remainingBudget >= 0.55
  ) {
    return undefined;
  }
  if (recentCycleOpeners >= 3) {
    return "temporal_cycle_density";
  }
  return undefined;
}

function inspectBalancedPairCandidates(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  requestedMaxLot: number,
  secsFromOpen: number,
  cap: number,
  secsToClose: number,
  dailyNegativeEdgeSpentUsdc: number,
  fairValueSnapshot: FairValueSnapshot | undefined,
  carryFlowConfidence?: number,
  matchedInventoryQuality?: number,
  activeIndependentFlowCount?: number,
  flowPressureState?: FlowPressureBudgetState,
  freshCycleGate?: FreshCycleGateContext,
): {
  bestCandidate?: BalancedPairCandidate;
  traces: BalancedPairCandidateTrace[];
  maxCandidateSize: number;
  bestRawPair?: number;
  bestEffectivePair?: number;
} {
  const maxCandidateSize = normalizeOrderSize(
    Math.min(
      requestedMaxLot,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
      Math.max(0, config.maxMarketExposureShares - Math.max(state.upShares, state.downShares)),
    ),
    state.market.minOrderSize,
  );

  if (maxCandidateSize <= 0) {
    return {
      traces: [],
      maxCandidateSize,
    };
  }

  const requestedSizes = buildCandidateSizes(config, config.lotLadder, maxCandidateSize, state.market.minOrderSize);
  let bestCandidate: BalancedPairCandidate | undefined;
  const traces: BalancedPairCandidateTrace[] = [];
  let bestRawPair: number | undefined;
  let bestEffectivePair: number | undefined;

  for (const requestedSize of requestedSizes) {
    const upExecution = books.quoteForSize("UP", "ask", requestedSize);
    const downExecution = books.quoteForSize("DOWN", "ask", requestedSize);
    const rawPairCost = upExecution.averagePrice + downExecution.averagePrice;
    const pairCost = pairCostWithBothTaker(
      upExecution.averagePrice,
      downExecution.averagePrice,
      config.cryptoTakerFeeRate,
    );
    const cycleTrace = cycleTraceFromPair(config, rawPairCost, pairCost, requestedSize);
    const freshCycleSkipReason = freshCycleGate
      ? freshCycleCandidateSkipReason(
          config,
          state,
          freshCycleGate.stats,
          cycleTrace.cycleQualityLabel,
          freshCycleGate.referencePriorActive,
        )
      : undefined;
    bestRawPair = bestRawPair === undefined ? rawPairCost : Math.min(bestRawPair, rawPairCost);
    bestEffectivePair = bestEffectivePair === undefined ? pairCost : Math.min(bestEffectivePair, pairCost);

    const allowance =
      upExecution.fullyFilled && downExecution.fullyFilled
        ? pairSweepAllowance({
            config,
            state,
            costWithFees: pairCost,
            candidateSize: requestedSize,
            secsToClose,
            dailyNegativeEdgeSpentUsdc,
            carryFlowConfidence,
            matchedInventoryQuality,
            activeIndependentFlowCount,
            flowPressureState,
          })
        : undefined;
    const upFairValue = fairValueGate({
      config,
      snapshot: fairValueSnapshot,
      side: "UP",
      sidePrice: upExecution.averagePrice,
      mode: allowance?.mode === "STRICT_PAIR_SWEEP" ? "pair" : "completion",
      secsToClose,
      effectiveCost: pairCost,
      required:
        allowance !== undefined &&
        allowance.mode !== "STRICT_PAIR_SWEEP" &&
        config.fairValueFailClosedForNegativePair,
    });
    const downFairValue = fairValueGate({
      config,
      snapshot: fairValueSnapshot,
      side: "DOWN",
      sidePrice: downExecution.averagePrice,
      mode: allowance?.mode === "STRICT_PAIR_SWEEP" ? "pair" : "completion",
      secsToClose,
      effectiveCost: pairCost,
      required:
        allowance !== undefined &&
        allowance.mode !== "STRICT_PAIR_SWEEP" &&
        config.fairValueFailClosedForNegativePair,
    });
    const fairValueAllowed =
      (upFairValue.allowed && downFairValue.allowed) ||
      shouldAllowPairedHighLowFairValueOverride(
        config,
        allowance,
        upExecution.averagePrice,
        downExecution.averagePrice,
        pairCost,
        [upFairValue.reason, downFairValue.reason].filter((reason): reason is string => Boolean(reason)),
      );
    const staleCheapOppositeQuote =
      allowance !== undefined &&
      allowance.allowed &&
      allowance.mode !== "STRICT_PAIR_SWEEP" &&
      shouldBlockCloneStaleCheapOppositeQuote({
        config,
        marketSlug: state.market.slug,
        snapshot: fairValueSnapshot,
        secsFromOpen,
        upPrice: upExecution.averagePrice,
        downPrice: downExecution.averagePrice,
        pairCost,
      });
    const upOrphanRisk = evaluateOrphanRisk({
      config,
      state,
      side: "UP",
      execution: upExecution,
      candidateSize: requestedSize,
      fairValueSnapshot,
    });
    const downOrphanRisk = evaluateOrphanRisk({
      config,
      state,
      side: "DOWN",
      execution: downExecution,
      candidateSize: requestedSize,
      fairValueSnapshot,
    });
    const orphanRiskAllowed = upOrphanRisk.allowed && downOrphanRisk.allowed;
    const verdict =
      !upExecution.fullyFilled
        ? "up_depth"
        : !downExecution.fullyFilled
          ? "down_depth"
          : allowance?.allowed && fairValueAllowed && !staleCheapOppositeQuote && orphanRiskAllowed && !freshCycleSkipReason
            ? "ok"
            : allowance?.allowed && fairValueAllowed && !staleCheapOppositeQuote && !freshCycleSkipReason && !orphanRiskAllowed
              ? "orphan_risk"
              : "pair_cap";
    const gateReason =
      verdict === "pair_cap"
        ? freshCycleSkipReason
          ? freshCycleSkipReason
          : staleCheapOppositeQuote
          ? "pair_stale_cheap_quote"
          : fairValueAllowed
          ? describePairGate(config, pairCost, requestedSize, allowance, secsToClose, cap)
          : upFairValue.reason ?? downFairValue.reason ?? "pair_fair_value"
        : verdict === "orphan_risk"
          ? orphanGateReason("UP", upOrphanRisk) ?? orphanGateReason("DOWN", downOrphanRisk)
        : undefined;

    traces.push({
      requestedSize,
      upFilledSize: upExecution.filledSize,
      downFilledSize: downExecution.filledSize,
      upAveragePrice: upExecution.averagePrice,
      downAveragePrice: downExecution.averagePrice,
      upLimitPrice: upExecution.limitPrice,
      downLimitPrice: downExecution.limitPrice,
      rawPairCost,
      rawPair: cycleTrace.rawPair,
      pairCost,
      effectivePair: cycleTrace.effectivePair,
      pairEdge: 1 - pairCost,
      feeUSDC: cycleTrace.feeUSDC,
      expectedNetIfMerged: cycleTrace.expectedNetIfMerged,
      cycleQualityLabel: cycleTrace.cycleQualityLabel,
      ...(freshCycleSkipReason ? { cycleSkippedReason: freshCycleSkipReason } : {}),
      negativeEdgeUsdc: allowance?.negativeEdgeUsdc ?? 0,
      verdict,
      ...(allowance?.mode ? { selectedMode: allowance.mode } : {}),
      ...(gateReason ? { gateReason } : {}),
      upOrphanRisk,
      downOrphanRisk,
    });

    if (verdict === "ok" && shouldUseBalancedPairCandidate(config, bestCandidate, requestedSize, pairCost)) {
      bestCandidate = {
        requestedSize,
        rawPairCost,
        pairCost,
        feeUSDC: cycleTrace.feeUSDC,
        expectedNetIfMerged: cycleTrace.expectedNetIfMerged,
        cycleQualityLabel: cycleTrace.cycleQualityLabel,
        mode: allowance!.mode!,
        negativeEdgeUsdc: allowance!.negativeEdgeUsdc,
        upExecution,
        downExecution,
      };
    }
  }

  return {
    ...(bestCandidate ? { bestCandidate } : {}),
    traces,
    maxCandidateSize,
    ...(bestRawPair !== undefined ? { bestRawPair } : {}),
    ...(bestEffectivePair !== undefined ? { bestEffectivePair } : {}),
  };
}

function shouldAllowCoveredSeedMissingFairValue(args: {
  config: XuanStrategyConfig;
  fairValueDecision: { allowed: boolean; reason?: string | undefined };
  requiresSamePairgroupOppositeOrder: boolean;
  canUseInventoryCover: boolean;
  pairExecutableSize: number;
  requestedSize: number;
  rawPairCost: number;
  referencePairCost: number;
  seedReferencePairCap: number;
  borderlinePolicy?: XuanBorderlineEntryPolicy | undefined;
}): boolean {
  if (
    args.fairValueDecision.allowed ||
    args.config.coveredSeedMissingFairValueMode !== "ALLOW_PAIR_REFERENCE_CAP" ||
    args.fairValueDecision.reason !== "fair_value_missing"
  ) {
    return false;
  }
  if (!args.requiresSamePairgroupOppositeOrder || args.canUseInventoryCover) {
    return false;
  }
  if (args.pairExecutableSize <= 0 || !Number.isFinite(args.rawPairCost) || !Number.isFinite(args.referencePairCost)) {
    return false;
  }
  const maxQty = args.borderlinePolicy?.maxQty ?? args.config.coveredSeedMaxQty;
  if (args.requestedSize > maxQty + 1e-6) {
    return false;
  }
  const rawCap = args.borderlinePolicy?.rawPairCap ?? args.config.xuanBorderlineRawPairCap;
  const effectiveCap = Math.min(
    args.seedReferencePairCap,
    args.borderlinePolicy?.effectivePairCap ?? args.config.xuanPairSweepHardCap,
  );
  return args.rawPairCost <= rawCap + 1e-9 && args.referencePairCost <= effectiveCap + 1e-9;
}

function evaluateSingleLegSeed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
  dailyNegativeEdgeSpentUsdc: number,
): {
  decisions?: EntryBuyDecision[];
  trace: SingleLegSeedCandidateTrace[];
  childOrder?: {
    intendedSide?: OutcomeSide | undefined;
    selectedSide?: OutcomeSide | undefined;
    reason: "flow_intent" | "covered_seed_priority";
  } | undefined;
  semanticRoleTarget?: EntryDecisionTrace["semanticRoleTarget"] | undefined;
} {
  if (
    config.botMode !== "XUAN" ||
    !config.allowXuanCoveredSeed ||
    ctx.secsToClose <= config.finalWindowNoChaseSec ||
    (ctx.secsToClose <= config.finalWindowSoftStartSec && !config.allowSingleLegSeedInLast60S)
  ) {
    return { trace: [] };
  }

  const freshCycleStats = buildFreshCycleStats(config, state);
  const referencePriorActive = referenceFreshCyclePriorActive(config, state, ctx);
  const ageAwareBorderlineCoveredSeedCap =
    !referencePriorActive &&
    config.xuanBorderlineEntryEnabled &&
    Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6)
      ? borderlineEntryMaxQtyForAge(config, ctx)
      : Number.POSITIVE_INFINITY;
  const stagedBorderlineInitialCap =
    !referencePriorActive &&
    config.borderlinePairStagedEntryEnabled &&
    Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6)
      ? Math.max(state.market.minOrderSize, config.borderlinePairInitialQty)
      : Number.POSITIVE_INFINITY;
  const candidateSize = normalizeOrderSize(
    Math.min(
      ctx.lot,
      config.coveredSeedMaxQty,
      config.singleLegSeedMaxQty,
      ageAwareBorderlineCoveredSeedCap > 0 ? ageAwareBorderlineCoveredSeedCap : Number.POSITIVE_INFINITY,
      stagedBorderlineInitialCap,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
    ),
    state.market.minOrderSize,
  );
  if (candidateSize <= 0) {
    return { trace: [] };
  }

  const flowIntentCoveredSeedSide =
    ctx.childOrderMicroTimingBias === "flow_intent" && shouldPreferFlowIntentTemporalSeedChildOrder(ctx)
      ? preferredFlowIntentChildOrderSide(state)
      : undefined;
  const sideOrder = (["UP", "DOWN"] as OutcomeSide[]).sort((left, right) => {
    const leftQuote = books.quoteForSize(left, "ask", candidateSize);
    const rightQuote = books.quoteForSize(right, "ask", candidateSize);
    const leftSize = normalizeOrderSize(leftQuote.filledSize || candidateSize, state.market.minOrderSize);
    const rightSize = normalizeOrderSize(rightQuote.filledSize || candidateSize, state.market.minOrderSize);
    const leftRisk = evaluateOrphanRisk({
      config,
      state,
      side: left,
      execution: leftQuote,
      candidateSize: leftSize > 0 ? leftSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const rightRisk = evaluateOrphanRisk({
      config,
      state,
      side: right,
      execution: rightQuote,
      candidateSize: rightSize > 0 ? rightSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const riskDelta = orphanRiskSortValue(leftRisk) - orphanRiskSortValue(rightRisk);
    if (riskDelta !== 0) {
      return riskDelta;
    }
    if (flowIntentCoveredSeedSide === left && flowIntentCoveredSeedSide !== right) {
      return -1;
    }
    if (flowIntentCoveredSeedSide === right && flowIntentCoveredSeedSide !== left) {
      return 1;
    }
    return 0;
  });
  const traces: SingleLegSeedCandidateTrace[] = [];
  let decisions: EntryBuyDecision[] | undefined;

  for (const side of sideOrder) {
    const oppositeSide: OutcomeSide = side === "UP" ? "DOWN" : "UP";
    const currentSideShares = side === "UP" ? state.upShares : state.downShares;
    const oppositeShares = oppositeSide === "UP" ? state.upShares : state.downShares;
    const oldGap = absoluteShareGap(state);
    const seedQuote = books.quoteForSize(side, "ask", candidateSize);
    const seedExecutableSize = normalizeOrderSize(seedQuote.filledSize, state.market.minOrderSize);
    const oppositeQuote = books.quoteForSize(oppositeSide, "ask", seedExecutableSize > 0 ? seedExecutableSize : candidateSize);
    const oppositeExecutableSize = normalizeOrderSize(oppositeQuote.filledSize, state.market.minOrderSize);
    const pairExecutableSize = normalizeOrderSize(
      Math.min(seedExecutableSize, oppositeExecutableSize),
      state.market.minOrderSize,
    );
    const projectedGap = Math.abs(currentSideShares + (pairExecutableSize > 0 ? pairExecutableSize : candidateSize) - oppositeShares);
    const effectivePricePerShare =
      seedQuote.averagePrice + takerFeePerShare(seedQuote.averagePrice, config.cryptoTakerFeeRate);
    const referencePairCost = pairExecutableSize > 0
      ? pairCostWithBothTaker(
          side === "UP" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
          side === "DOWN" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
          config.cryptoTakerFeeRate,
        )
      : Number.POSITIVE_INFINITY;
    const rawPairCost =
      pairExecutableSize > 0 ? seedQuote.averagePrice + oppositeQuote.averagePrice : Number.POSITIVE_INFINITY;
    const cycleTrace =
      pairExecutableSize > 0
        ? cycleTraceFromPair(config, rawPairCost, referencePairCost, pairExecutableSize)
        : {
            rawPair: Number.POSITIVE_INFINITY,
            effectivePair: Number.POSITIVE_INFINITY,
            feeUSDC: 0,
            expectedNetIfMerged: 0,
            cycleQualityLabel: "BAD_PAIR" as const,
          };
    const negativeEdgeUsdc =
      pairExecutableSize > 0
        ? Math.max(0, referencePairCost - 1) * Math.max(pairExecutableSize, candidateSize)
        : 0;
    const cheapSeedExpensiveCompletionBlocked = shouldBlockCheapSeedExpensiveCompletionSetup({
      config,
      state,
      side,
      secsFromOpen: ctx.secsFromOpen,
      seedPrice: seedQuote.averagePrice,
      oppositePrice: oppositeQuote.averagePrice,
      referencePairCost,
      oppositeCoverageRatio: pairExecutableSize > 0
        ? Number((oppositeExecutableSize / pairExecutableSize).toFixed(6))
        : 0,
      semanticRoleAlignmentBias: ctx.semanticRoleAlignmentBias,
    });
    let skipReason: string | undefined;

    const hasOppositeInventoryCover =
      pairExecutableSize > 0 &&
      oppositeShares + 1e-6 >= pairExecutableSize * config.coveredSeedMinOppositeCoverageRatio;
    const canUseInventoryCover =
      config.coveredSeedAllowOppositeInventoryCover && hasOppositeInventoryCover;
    const requiresSamePairgroupOppositeOrder =
      config.coveredSeedRequireSamePairgroupOppositeOrder &&
      !canUseInventoryCover &&
      config.coveredSeedAllowSamePairgroupOppositeOrder;
    const effectiveProjectedGap = requiresSamePairgroupOppositeOrder ? oldGap : projectedGap;
    const protectedProjectedGap = Math.max(
      0,
      effectiveProjectedGap - protectedResidualAllowance(config, ctx, side),
    );
    const freshCycleCandidateContext = {
      route: "covered_seed" as const,
      ctx,
      requestedSize: pairExecutableSize > 0 ? pairExecutableSize : candidateSize,
      rawPair: rawPairCost,
      effectivePair: referencePairCost,
    };
    skipReason = freshCycleCandidateSkipReason(
      config,
      state,
      freshCycleStats,
      cycleTrace.cycleQualityLabel,
      referencePriorActive,
      freshCycleCandidateContext,
    );
    const borderlineCoveredSeedAllowed =
      cycleTrace.cycleQualityLabel === "BORDERLINE_PAIR" &&
      skipReason === undefined &&
      borderlineFreshEntryAllowed(config, state, freshCycleStats, freshCycleCandidateContext);
    const borderlinePolicy =
      cycleTrace.cycleQualityLabel === "BORDERLINE_PAIR" ? xuanBorderlineEntryPolicy(config, ctx) : undefined;
    const seedReferencePairCap = borderlineCoveredSeedAllowed
      ? Math.max(config.xuanPairSweepHardCap, config.xuanBorderlineEffectivePairCap)
      : config.xuanPairSweepHardCap;

    if (skipReason === undefined) {
      if (!config.coveredSeedAllowSamePairgroupOppositeOrder && !canUseInventoryCover && !config.allowNakedSingleLegSeed) {
        skipReason = "seed_requires_same_pairgroup_opposite_order";
      } else if (cheapSeedExpensiveCompletionBlocked) {
        skipReason = "cheap_seed_expensive_completion_guard";
      } else if (!config.allowNakedSingleLegSeed && !canUseInventoryCover && !requiresSamePairgroupOppositeOrder) {
        skipReason = "seed_missing_opposite_inventory";
      } else if (state.consecutiveSeedSide === side && state.consecutiveSeedCount >= config.maxConsecutiveSingleLegSeedsPerSide) {
        skipReason = "seed_side_limit";
      } else if (
        config.forbidBuyThatIncreasesImbalance &&
        effectiveProjectedGap > oldGap + config.maxCompletionOvershootShares
      ) {
        skipReason = "seed_increases_imbalance";
      } else if (protectedProjectedGap > config.maxOneSidedExposureShares) {
        skipReason = "seed_one_sided_exposure";
      } else if (pairExecutableSize <= 0) {
        skipReason = "seed_depth";
      } else if (referencePairCost > seedReferencePairCap) {
        skipReason = "seed_reference_pair_cap";
      } else if (negativeEdgeUsdc > config.maxNegativePairEdgePerCycleUsdc) {
        skipReason = "seed_cycle_budget";
      } else if (state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc > config.maxNegativePairEdgePerMarketUsdc) {
        skipReason = "seed_market_budget";
      } else if (dailyNegativeEdgeSpentUsdc + negativeEdgeUsdc > config.maxNegativeDailyBudgetUsdc) {
        skipReason = "seed_daily_budget";
      }
    }

    const selectedMode: StrategyExecutionMode = "PAIRGROUP_COVERED_SEED";
    const useStagedBorderlineEntry =
      borderlineCoveredSeedAllowed &&
      config.borderlinePairStagedEntryEnabled &&
      requiresSamePairgroupOppositeOrder &&
      !canUseInventoryCover;
    const baseFairValueDecision = fairValueGate({
      config,
      snapshot: ctx.fairValueSnapshot,
      side,
      sidePrice: seedQuote.averagePrice,
      mode: "seed",
      secsToClose: ctx.secsToClose,
      effectiveCost: referencePairCost,
      required: config.coveredSeedRequiresFairValue || config.fairValueFailClosedForSeed,
    });
    const fairValueFallbackReason = shouldAllowCoveredSeedMissingFairValue({
      config,
      fairValueDecision: baseFairValueDecision,
      requiresSamePairgroupOppositeOrder,
      canUseInventoryCover,
      pairExecutableSize,
      requestedSize: candidateSize,
      rawPairCost,
      referencePairCost,
      seedReferencePairCap,
      borderlinePolicy,
    })
      ? "missing_fair_value_allowed_by_pair_reference_cap"
      : undefined;
    const fairValueDecision = fairValueFallbackReason
      ? { allowed: true }
      : baseFairValueDecision;
    const orphanRisk = evaluateOrphanRisk({
      config,
      state,
      side,
      execution: seedQuote,
      candidateSize: pairExecutableSize > 0 ? pairExecutableSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const traceSkipReason = skipReason ?? fairValueDecision.reason ?? orphanRisk.reason;
    traces.push({
      side,
      requestedSize: candidateSize,
      filledSize: pairExecutableSize,
      semanticRoleTarget: semanticRoleTargetForPair(
        side === "UP" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
        side === "DOWN" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
        ctx.semanticRoleAlignmentBias,
      ),
      averagePrice: seedQuote.averagePrice,
      limitPrice: seedQuote.limitPrice,
      effectivePricePerShare,
      referencePairCost,
      rawPair: rawPairCost,
      effectivePair: referencePairCost,
      feeUSDC: cycleTrace.feeUSDC,
      expectedNetIfMerged: cycleTrace.expectedNetIfMerged,
      cycleQualityLabel: cycleTrace.cycleQualityLabel,
      ...(borderlinePolicy ? { xuanBorderlinePhase: borderlinePolicy.phase } : {}),
      ...(fairValueFallbackReason ? { fairValueFallbackReason } : {}),
      ...(useStagedBorderlineEntry
        ? {
            stagedEntry: true,
            plannedOppositeSide: oppositeSide,
            plannedOppositeQty: pairExecutableSize,
          }
        : {}),
      ...(skipReason === "fresh_cycle_borderline_pair" ||
      skipReason === "fresh_cycle_bad_pair" ||
      skipReason === "borderline_same_pattern_repeat"
        ? { cycleSkippedReason: skipReason }
        : {}),
      negativeEdgeUsdc,
      orphanRisk,
      allowed: skipReason === undefined && fairValueDecision.allowed && orphanRisk.allowed,
      ...(skipReason === undefined && fairValueDecision.allowed && orphanRisk.allowed ? { selectedMode } : {}),
      ...(traceSkipReason ? { skipReason: traceSkipReason } : {}),
    });

    if (!decisions && skipReason === undefined && fairValueDecision.allowed && orphanRisk.allowed) {
      const seedExecution: ExecutionQuote = {
        ...seedQuote,
        requestedSize: pairExecutableSize,
        filledSize: pairExecutableSize,
        fullyFilled: seedQuote.filledSize + 1e-9 >= pairExecutableSize,
      };
      const coveredExecution: ExecutionQuote = {
        ...oppositeQuote,
        requestedSize: pairExecutableSize,
        filledSize: pairExecutableSize,
        fullyFilled: oppositeQuote.filledSize + 1e-9 >= pairExecutableSize,
      };
      const seedDecision = buildEntryBuy(
          state,
          side,
          seedExecution,
          "balanced_pair_seed",
          selectedMode,
          config.cryptoTakerFeeRate,
          referencePairCost,
          negativeEdgeUsdc,
          seedQuote.averagePrice + oppositeQuote.averagePrice,
        );
      const coveredDecision = buildEntryBuy(
          state,
          oppositeSide,
          coveredExecution,
          "balanced_pair_seed",
          selectedMode,
          config.cryptoTakerFeeRate,
          referencePairCost,
          negativeEdgeUsdc,
          seedQuote.averagePrice + oppositeQuote.averagePrice,
        );
      decisions = useStagedBorderlineEntry
        ? [seedDecision]
        : [seedDecision, coveredDecision];
    }
  }

  return {
    ...(decisions ? { decisions } : {}),
    trace: traces,
    childOrder: {
      ...(flowIntentCoveredSeedSide ? { intendedSide: flowIntentCoveredSeedSide } : {}),
      ...(decisions?.[0] ? { selectedSide: decisions[0].side } : {}),
      reason: flowIntentCoveredSeedSide ? "flow_intent" : "covered_seed_priority",
    },
    semanticRoleTarget: decisions?.[0]
      ? traces.find((trace) => trace.allowed && trace.side === decisions?.[0]?.side)?.semanticRoleTarget
      : undefined,
  };
}

function buildCandidateSizes(
  config: XuanStrategyConfig,
  ladder: number[],
  maxCandidateSize: number,
  minOrderSize: number,
): number[] {
  const xuanClipSizes =
    config.botMode === "XUAN" && config.clipSplitMode === "DEPTH_ADAPTIVE_XUAN_BIAS"
      ? buildXuanClipSizeCandidates(maxCandidateSize, minOrderSize)
      : [];
  const normalized = Array.from(
    new Set(
      [...xuanClipSizes, ...ladder, maxCandidateSize]
        .map((size) => normalizeOrderSize(size, minOrderSize))
        .filter((size) => size > 0 && size <= maxCandidateSize),
    ),
  ).sort((left, right) => left - right);

  if (normalized.length > 0) {
    return normalized;
  }

  return [maxCandidateSize];
}

function buildXuanClipSizeCandidates(maxCandidateSize: number, minOrderSize: number): number[] {
  const candidates: number[] = [];
  if (maxCandidateSize >= 30) {
    candidates.push(10, 15);
  } else if (maxCandidateSize >= 15) {
    candidates.push(5);
  } else if (maxCandidateSize >= 12) {
    candidates.push(4);
  } else if (maxCandidateSize >= 10) {
    candidates.push(5);
  }
  return candidates
    .map((size) => normalizeOrderSize(Math.min(size, maxCandidateSize), minOrderSize))
    .filter((size) => size > 0);
}

function shouldUseBalancedPairCandidate(
  config: XuanStrategyConfig,
  current: BalancedPairCandidate | undefined,
  requestedSize: number,
  pairCost: number,
): boolean {
  if (!current) {
    return true;
  }
  if (
    config.botMode === "XUAN" &&
    config.clipSplitMode === "DEPTH_ADAPTIVE_XUAN_BIAS" &&
    config.preferMulticlipWhenCostNeutral &&
    requestedSize > current.requestedSize &&
    pairCost >= current.pairCost - 0.001
  ) {
    return false;
  }
  return true;
}

function determineBalancedPairSkipReason(
  maxCandidateSize: number,
  traces: BalancedPairCandidateTrace[],
): string {
  if (maxCandidateSize <= 0) {
    return "max_market_exposure";
  }

  if (traces.length === 0) {
    return "no_candidate_sizes";
  }

  const gateReasons = new Set(
    traces
      .map((trace) => trace.gateReason)
      .filter((reason): reason is string => Boolean(reason)),
  );
  if (gateReasons.has("pair_market_budget")) return "pair_market_budget";
  if (gateReasons.has("pair_cycle_budget")) return "pair_cycle_budget";
  if (gateReasons.has("pair_daily_budget")) return "pair_daily_budget";
  if (gateReasons.has("pair_qty_limit")) return "pair_qty_limit";
  if (gateReasons.has("pair_time_gate")) return "pair_time_gate";
  if ([...gateReasons].some((reason) => reason.includes("orphan"))) return "orphan_risk";

  const hasPairCap = traces.some((trace) => trace.verdict === "pair_cap");
  const hasOrphanRisk = traces.some((trace) => trace.verdict === "orphan_risk");
  const hasDepthIssue = traces.some((trace) => trace.verdict === "up_depth" || trace.verdict === "down_depth");

  if (hasPairCap && hasDepthIssue) {
    return "pair_cap_and_depth";
  }
  if (hasOrphanRisk) {
    return "orphan_risk";
  }
  if (hasPairCap) {
    return "pair_cap";
  }
  if (hasDepthIssue) {
    return "insufficient_depth";
  }

  return "no_viable_pair";
}

function buildBalancedPairEntryBuys(
  config: Pick<XuanStrategyConfig, "botMode">,
  state: XuanMarketState,
  secsFromOpen: number,
  childOrderMicroTimingBias: EntryLadderContext["childOrderMicroTimingBias"],
  candidate: BalancedPairCandidate,
  feeRate: number,
  reason: EntryBuyReason,
): EntryBuyDecision[] {
  const firstSide = preferredBalancedPairFirstSide(config, state, secsFromOpen, childOrderMicroTimingBias, candidate);
  const sideOrder: OutcomeSide[] = [firstSide, firstSide === "UP" ? "DOWN" : "UP"];
  return sideOrder.map((side) =>
    buildEntryBuy(
      state,
      side,
      side === "UP" ? candidate.upExecution : candidate.downExecution,
      reason,
      candidate.mode,
      feeRate,
      candidate.pairCost,
      candidate.negativeEdgeUsdc,
      candidate.rawPairCost,
    ),
  );
}

function preferredBalancedPairFirstSide(
  config: Pick<XuanStrategyConfig, "botMode">,
  state: XuanMarketState,
  secsFromOpen: number,
  childOrderMicroTimingBias: EntryLadderContext["childOrderMicroTimingBias"],
  candidate: BalancedPairCandidate,
): OutcomeSide {
  if (config.botMode !== "XUAN") {
    return "UP";
  }
  const highLowFirstSide = preferredHighLowBalancedPairFirstSide(candidate);
  const flowIntentFirstSide =
    childOrderMicroTimingBias === "flow_intent" ? preferredFlowIntentChildOrderSide(state) : undefined;
  if (
    flowIntentFirstSide &&
    shouldPreferFlowIntentBalancedPairChildOrder({
      secsFromOpen,
      candidate,
    })
  ) {
    return flowIntentFirstSide;
  }
  if (secsFromOpen >= 70) {
    return highLowFirstSide ?? "UP";
  }
  const lastBuy = [...state.fillHistory].reverse().find((fill) => fill.side === "BUY");
  if (!lastBuy?.executionMode) {
    return highLowFirstSide ?? "UP";
  }
  if (
    [
      "PARTIAL_FAST_COMPLETION",
      "PARTIAL_SOFT_COMPLETION",
      "PARTIAL_EMERGENCY_COMPLETION",
      "POST_MERGE_RESIDUAL_COMPLETION",
      "HIGH_LOW_COMPLETION_CHASE",
      "CHEAP_LATE_COMPLETION_CHASE",
    ].includes(lastBuy.executionMode)
  ) {
    return lastBuy.outcome;
  }
  return highLowFirstSide ?? "UP";
}

function balancedPairChildOrderTrace(
  config: Pick<XuanStrategyConfig, "botMode">,
  state: XuanMarketState,
  secsFromOpen: number,
  childOrderMicroTimingBias: EntryLadderContext["childOrderMicroTimingBias"],
  candidate: BalancedPairCandidate,
): Pick<EntryDecisionTrace, "childOrderIntendedSide" | "childOrderSelectedSide" | "childOrderReason"> {
  const selectedSide = preferredBalancedPairFirstSide(config, state, secsFromOpen, childOrderMicroTimingBias, candidate);
  if (config.botMode !== "XUAN") {
    return {
      childOrderSelectedSide: selectedSide,
      childOrderReason: "default",
    };
  }
  const flowIntentSide =
    childOrderMicroTimingBias === "flow_intent" ? preferredFlowIntentChildOrderSide(state) : undefined;
  if (
    flowIntentSide &&
    selectedSide === flowIntentSide &&
    shouldPreferFlowIntentBalancedPairChildOrder({ secsFromOpen, candidate })
  ) {
    return {
      childOrderIntendedSide: flowIntentSide,
      childOrderSelectedSide: selectedSide,
      childOrderReason: "flow_intent",
    };
  }
  if (preferredHighLowBalancedPairFirstSide(candidate) === selectedSide) {
    return {
      ...(flowIntentSide ? { childOrderIntendedSide: flowIntentSide } : {}),
      childOrderSelectedSide: selectedSide,
      childOrderReason: "high_low_price",
    };
  }
  return {
    ...(flowIntentSide ? { childOrderIntendedSide: flowIntentSide } : {}),
    childOrderSelectedSide: selectedSide,
    childOrderReason: selectedSide === preferredRecentCompletionSide(state) ? "recent_completion" : "default",
  };
}

function preferredFlowIntentChildOrderSide(state: XuanMarketState): OutcomeSide | undefined {
  const completionModes: StrategyExecutionMode[] = [
    "PARTIAL_FAST_COMPLETION",
    "PARTIAL_SOFT_COMPLETION",
    "PARTIAL_EMERGENCY_COMPLETION",
    "POST_MERGE_RESIDUAL_COMPLETION",
    "HIGH_LOW_COMPLETION_CHASE",
    "CHEAP_LATE_COMPLETION_CHASE",
  ];
  const recentCompletion = [...state.fillHistory]
    .reverse()
    .find((fill) => fill.side === "BUY" && fill.executionMode !== undefined && completionModes.includes(fill.executionMode));
  return recentCompletion?.outcome;
}

function preferredRecentCompletionSide(state: XuanMarketState): OutcomeSide | undefined {
  const lastBuy = [...state.fillHistory].reverse().find((fill) => fill.side === "BUY");
  if (!lastBuy?.executionMode) {
    return undefined;
  }
  return [
    "PARTIAL_FAST_COMPLETION",
    "PARTIAL_SOFT_COMPLETION",
    "PARTIAL_EMERGENCY_COMPLETION",
    "POST_MERGE_RESIDUAL_COMPLETION",
    "HIGH_LOW_COMPLETION_CHASE",
    "CHEAP_LATE_COMPLETION_CHASE",
  ].includes(lastBuy.executionMode)
    ? lastBuy.outcome
    : undefined;
}

function shouldPreferFlowIntentBalancedPairChildOrder(args: {
  secsFromOpen: number;
  candidate: BalancedPairCandidate;
}): boolean {
  const spread = Math.abs(args.candidate.upExecution.averagePrice - args.candidate.downExecution.averagePrice);
  if (spread >= 0.55) {
    return false;
  }
  return args.secsFromOpen >= 24 && args.secsFromOpen <= 210;
}

function preferredHighLowBalancedPairFirstSide(candidate: BalancedPairCandidate): OutcomeSide | undefined {
  const spread = Math.abs(candidate.upExecution.averagePrice - candidate.downExecution.averagePrice);
  if (spread < 0.25) {
    return undefined;
  }
  return candidate.upExecution.averagePrice >= candidate.downExecution.averagePrice ? "UP" : "DOWN";
}

function shouldPreferFlowIntentTemporalSeedChildOrder(ctx: EntryLadderContext): boolean {
  return ctx.secsFromOpen >= 24 && ctx.secsFromOpen <= 210;
}

function semanticRoleTargetForPair(
  upPrice: number,
  downPrice: number,
  semanticRoleAlignmentBias: EntryLadderContext["semanticRoleAlignmentBias"],
): EntryDecisionTrace["semanticRoleTarget"] {
  if (semanticRoleAlignmentBias === "preserve_raw_side") {
    return "raw_side_preserve";
  }
  const spread = Math.abs(upPrice - downPrice);
  if (spread >= 0.25) {
    return "high_low_setup";
  }
  if (upPrice >= 0.42 && upPrice <= 0.58 && downPrice >= 0.42 && downPrice <= 0.58) {
    return "mid_pair";
  }
  return "neutral";
}

function buildEntryBuy(
  state: XuanMarketState,
  side: OutcomeSide,
  execution: ExecutionQuote,
  reason: EntryBuyReason,
  mode: StrategyExecutionMode,
  feeRate: number,
  pairCost?: number,
  negativeEdgeUsdc?: number,
  rawPairCost?: number,
): EntryBuyDecision {
  return {
    side,
    size: execution.filledSize,
    reason,
    mode,
    expectedAveragePrice: execution.averagePrice,
    effectivePricePerShare: execution.averagePrice + takerFeePerShare(execution.averagePrice, feeRate),
    ...(negativeEdgeUsdc !== undefined ? { negativeEdgeUsdc } : {}),
    ...(pairCost !== undefined ? { pairCostWithFees: pairCost } : {}),
    ...(rawPairCost !== undefined ? { rawPairCost } : {}),
    order: buildTakerBuyOrder({
      state,
      side,
      shareTarget: execution.filledSize,
      limitPrice: execution.limitPrice,
      orderType: "FAK",
    }),
  };
}

function describePairGate(
  config: XuanStrategyConfig,
  pairCost: number,
  requestedSize: number,
  allowance: ReturnType<typeof pairSweepAllowance> | undefined,
  secsToClose: number,
  cap: number,
): string {
  if (!allowance) {
    return "pair_cap";
  }
  if (pairCost <= cap) {
    return "pair_cap";
  }
  if (!config.allowInitialNegativePairSweep || config.botMode !== "XUAN") {
    return "pair_cap";
  }
  if (pairCost > config.xuanPairSweepHardCap) {
    return "pair_cap";
  }
  if (allowance.projectedDailyBudget > config.maxNegativeDailyBudgetUsdc) {
    return "pair_daily_budget";
  }
  if (allowance.projectedMarketBudget > config.maxNegativePairEdgePerMarketUsdc) {
    return "pair_market_budget";
  }
  if (allowance.negativeEdgeUsdc > config.maxNegativePairEdgePerCycleUsdc) {
    return "pair_cycle_budget";
  }
  if (requestedSize > config.xuanSoftSweepMaxQty && requestedSize > config.xuanHardSweepMaxQty) {
    return "pair_qty_limit";
  }
  if (secsToClose <= config.xuanMinTimeLeftForHardSweep) {
    return "pair_time_gate";
  }
  if (secsToClose <= config.finalWindowNoChaseSec && !config.allowAnyNewBuyInLast10S) {
    return "pair_time_gate";
  }
  if (secsToClose <= config.finalWindowCompletionOnlySec && !config.allowNewPairInLast30S) {
    return "pair_time_gate";
  }
  if (secsToClose <= config.finalWindowSoftStartSec && !config.allowNewPairInLast60S) {
    return "pair_time_gate";
  }
  return "pair_cap";
}

function shouldAllowPairedHighLowFairValueOverride(
  config: XuanStrategyConfig,
  allowance: ReturnType<typeof pairSweepAllowance> | undefined,
  upPrice: number,
  downPrice: number,
  pairCost: number,
  reasons: string[],
): boolean {
  if (!allowance?.allowed || allowance.mode === "STRICT_PAIR_SWEEP" || reasons.length === 0) {
    return false;
  }
  if (reasons.some((reason) => reason !== "fair_value_high_side_price")) {
    return false;
  }

  const highSide = Math.max(upPrice, downPrice);
  const lowSide = Math.min(upPrice, downPrice);
  if (highSide < config.highSidePriceThreshold || lowSide > config.lowSideMaxForHighCompletion) {
    return false;
  }

  const cap = allowance.mode === "XUAN_HARD_PAIR_SWEEP" ? config.xuanPairSweepHardCap : config.xuanPairSweepSoftCap;
  return pairCost <= cap;
}

function normalizeOrderSize(size: number, minOrderSize: number): number {
  const normalized = Number(size.toFixed(6));
  if (normalized < minOrderSize) {
    return 0;
  }
  return normalized;
}
