import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { ExecutionQuote } from "./orderBookState.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { pairCostWithBothTaker, completionCost, takerFeePerShare } from "./sumAvgEngine.js";
import {
  absoluteShareGap,
  averageCost,
  averageEffectiveCost,
  matchedEffectivePairCost,
  mergeableShares,
  oldestResidualLotTimestamp,
  projectedShareGapAfterBuy,
} from "./inventoryState.js";
import { plannedOppositeCompletionState, type FillRecord, type XuanMarketState } from "./marketState.js";
import {
  classifyResidualSeverity,
  completionAllowance,
  completionQualitySkipReason,
  classifyCompletionReleaseRole,
  type CompletionReleaseRole,
  type CampaignCompletionSizing,
  deriveFlowPressureBudgetState,
  highSideCompletionQualitySkipReason,
  residualSeverityPressure,
  resolveResidualBehaviorState,
  type FlowPressureBudgetState,
  type MarketBasketContinuationClass,
  type MarketBasketClipType,
  type OverlapRepairArbitration,
  marketBasketBootstrapAllowed,
  marketBasketContinuationProjection as projectMarketBasketContinuation,
  pairEntryCap,
  pairSweepAllowance,
  resolvePartialCompletionPhase,
  resolveCampaignCompletionSizing,
  resolveResidualCompletionDelayProfile,
} from "./modePolicy.js";
import { OrderBookState } from "./orderBookState.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import { buildTakerBuyOrder } from "./marketOrderBuilder.js";
import {
  resolveBundledExactReference,
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
  marketBasketProjectedEffectivePair?: number | undefined;
  marketBasketProjectedMatchedQty?: number | undefined;
  marketBasketImprovement?: number | undefined;
  marketBasketDebtBeforeUSDC?: number | undefined;
  marketBasketDebtAfterUSDC?: number | undefined;
  marketBasketDebtDeltaUSDC?: number | undefined;
  marketBasketBootstrap?: boolean | undefined;
  marketBasketContinuation?: boolean | undefined;
  xuanMicroPairContinuation?: boolean | undefined;
  balancedButDebted?: boolean | undefined;
  campaignMode?:
    | "PROBE_OPENED"
    | "BASKET_CAMPAIGN_ACTIVE"
    | "ACCUMULATING_CONTINUATION"
    | "UNBALANCED_CAMPAIGN_RESIDUAL"
    | "RESIDUAL_COMPLETION_ACTIVE"
    | "WATCH_FOR_DEBT_REDUCER"
    | undefined;
  campaignBaseLot?: number | undefined;
  executedProbeQty?: number | undefined;
  plannedContinuationQty?: number | undefined;
  currentBasketEffectiveAvg?: number | undefined;
  deltaAverageCost?: number | undefined;
  deltaAbsoluteDebt?: number | undefined;
  deltaTerminalEV?: number | undefined;
  residualCompletionFairValueFallback?: boolean | undefined;
  residualCompletionFallbackReason?: string | undefined;
  candidateEffectivePair?: number | undefined;
  edgePerPair?: number | undefined;
  qtyNeededToRepayDebt?: number | undefined;
  deltaBasketDebt?: number | undefined;
  continuationRejectedReason?: string | undefined;
  terminalCarryMode?: boolean | undefined;
  deltaTerminalMinPnl?: number | undefined;
  deltaTerminalExpectedPnl?: number | undefined;
  fairValueEVBefore?: number | undefined;
  fairValueEVAfter?: number | undefined;
  addedDebtUSDC?: number | undefined;
  continuationClass?: MarketBasketContinuationClass | undefined;
  campaignClipType?: MarketBasketClipType | undefined;
  avgImprovingBudgetRemainingUSDC?: number | undefined;
  avgImprovingClipBudgetRemaining?: number | undefined;
  flowShapingBudgetRemainingUSDC?: number | undefined;
  flowShapingClipBudgetRemaining?: number | undefined;
  campaignFlowCount?: number | undefined;
  campaignFlowTarget?: number | undefined;
  postCompletionDebtRepairActive?: boolean | undefined;
  postCompletionRepairAttemptCount?: number | undefined;
  postCompletionRepairOpenedCount?: number | undefined;
  pairCapBlockedRepairCount?: number | undefined;
  avgImprovingActionCount?: number | undefined;
  debtReducingActionCount?: number | undefined;
  mergeQtyOverBaseLot?: number | undefined;
  xuanFlowCount?: number | undefined;
  cycleSkippedReason?: string | undefined;
  xuanSeedRhythmWaitSec?: number | undefined;
  xuanSeedDelayedCount?: number | undefined;
  xuanBorderlinePhase?: XuanBorderlineEntryPhase | undefined;
  fairValueFallbackReason?: string | undefined;
  postProfitLowSideSetup?: boolean | undefined;
  stagedEntry?: boolean | undefined;
  plannedOppositeSide?: OutcomeSide | undefined;
  plannedOppositeQty?: number | undefined;
  plannedOppositeFilledQty?: number | undefined;
  plannedOppositeMissingQty?: number | undefined;
  plannedOppositeAgeSec?: number | undefined;
  plannedPairGroupOpenedAt?: number | undefined;
  plannedLowSideAvg?: number | undefined;
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
  existingResidualPairCost?: number | undefined;
  feeUSDC?: number | undefined;
  expectedNetIfMerged?: number | undefined;
  cycleQualityLabel?: CycleQualityLabel | undefined;
  marketBasketProjectedEffectivePair?: number | undefined;
  marketBasketProjectedMatchedQty?: number | undefined;
  marketBasketImprovement?: number | undefined;
  marketBasketDebtBeforeUSDC?: number | undefined;
  marketBasketDebtAfterUSDC?: number | undefined;
  marketBasketDebtDeltaUSDC?: number | undefined;
  continuationClass?: MarketBasketContinuationClass | undefined;
  campaignClipType?: MarketBasketClipType | undefined;
  avgImprovingBudgetRemainingUSDC?: number | undefined;
  avgImprovingClipBudgetRemaining?: number | undefined;
  flowShapingBudgetRemainingUSDC?: number | undefined;
  flowShapingClipBudgetRemaining?: number | undefined;
  campaignFlowCount?: number | undefined;
  campaignFlowTarget?: number | undefined;
  addedDebtUSDC?: number | undefined;
  cycleSkippedReason?: string | undefined;
  xuanSeedRhythmWaitSec?: number | undefined;
  xuanSeedDelayedCount?: number | undefined;
  xuanBorderlinePhase?: XuanBorderlineEntryPhase | undefined;
  fairValueFallbackReason?: string | undefined;
  postProfitLowSideSetup?: boolean | undefined;
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
  marketBasketProjectedEffectivePair?: number;
  marketBasketProjectedMatchedQty?: number;
  marketBasketImprovement?: number;
  marketBasketDebtBeforeUSDC?: number;
  marketBasketDebtAfterUSDC?: number;
  marketBasketDebtDeltaUSDC?: number;
  marketBasketBootstrap?: boolean;
  marketBasketContinuation?: boolean;
  xuanMicroPairContinuation?: boolean;
  marketBasketTotalUp?: number;
  marketBasketTotalDown?: number;
  marketBasketMergeableQty?: number;
  marketBasketResidualSide?: OutcomeSide | "BALANCED";
  marketBasketResidualQty?: number;
  marketBasketEffectiveAvg?: number;
  marketBasketDebtUSDC?: number;
  marketBasketNeedsContinuation?: boolean;
  balancedButDebted?: boolean;
  campaignMode?:
    | "PROBE_OPENED"
    | "BASKET_CAMPAIGN_ACTIVE"
    | "ACCUMULATING_CONTINUATION"
    | "UNBALANCED_CAMPAIGN_RESIDUAL"
    | "RESIDUAL_COMPLETION_ACTIVE"
    | "WATCH_FOR_DEBT_REDUCER";
  campaignState?:
    | "OPENING_SEED"
    | "ORPHAN_COMPLETION_DUTY"
    | "BALANCED_DEBT_CAMPAIGN"
    | "POST_PROFIT_CAMPAIGN"
    | "ACCUMULATING_CONTINUATION"
    | "MERGE_READY";
  campaignBaseLot?: number;
  executedProbeQty?: number;
  plannedContinuationQty?: number;
  currentBasketEffectiveAvg?: number;
  deltaAverageCost?: number;
  deltaAbsoluteDebt?: number;
  deltaTerminalEV?: number;
  residualCompletionFairValueFallback?: boolean;
  residualCompletionFallbackReason?: string;
  candidateEffectivePair?: number;
  edgePerPair?: number;
  qtyNeededToRepayDebt?: number;
  deltaBasketDebt?: number;
  continuationRejectedReason?: string;
  terminalCarryMode?: boolean;
  deltaTerminalMinPnl?: number;
  deltaTerminalExpectedPnl?: number;
  fairValueEVBefore?: number;
  fairValueEVAfter?: number;
  addedDebtUSDC?: number;
  xuanTemporalCompletionMinAgeSec?: number;
  xuanTemporalCompletionEarlyMaxEffectivePair?: number;
  xuanRhythmWaitSec?: number;
  xuanCompletionDelayedCount?: number;
  xuanEarlyCompletionReason?: string;
  continuationClass?: MarketBasketContinuationClass;
  avgImprovingBudgetRemainingUSDC?: number;
  avgImprovingClipBudgetRemaining?: number;
  flowShapingBudgetRemainingUSDC?: number;
  flowShapingClipBudgetRemaining?: number;
  campaignFlowCount?: number;
  campaignFlowTarget?: number;
  postCompletionDebtRepairActive?: boolean;
  balancedDebtCampaignTicks?: number;
  postCompletionRepairAttemptCount?: number;
  postCompletionRepairOpenedCount?: number;
  pairCapBlockedRepairCount?: number;
  avgImprovingActionCount?: number;
  debtReducingActionCount?: number;
  mergeQtyOverBaseLot?: number;
  xuanFlowCount?: number;
  stagedDebtReducingFlow?: boolean;
  initialBasketRecoveryPlan?: "none" | "weak" | "medium" | "strong";
  initialBasketRecoveryScore?: number;
  initialBasketEffectivePair?: number;
  initialBasketDebtUSDC?: number;
  initialBasketQtyCap?: number;
  initialBasketRecoveryReason?: string;
  campaignLaunchMode?: "STRONG_LAUNCH" | "RECOVERABLE_LAUNCH" | "XUAN_PROBE_LAUNCH" | "HARD_SKIP" | "NO_RECOVERY_LAUNCH";
  visibleRecoveryPath?: boolean;
  minEffectivePairAcrossTiers?: number;
  bestDebtReducingQty?: number;
  bestDebtReducingEffectivePair?: number;
  recoveryPathReason?: string;
  orphanCompletionDutyActive?: boolean;
  aggressiveResidualDutyReleaseActive?: boolean;
  oneSidedSeedUnrepairedTicks?: number;
  stagedLowSideOpenedButOppositeMissing?: boolean;
  terminalPnlIfUp?: number;
  terminalPnlIfDown?: number;
  stateBefore?: InventoryTraceState;
  stateAfter?: InventoryTraceState;
  cycleQualityLabel?: CycleQualityLabel;
  cycleOpenedReason?: EntryBuyReason | "controlled_overlap_pair" | "protected_residual_overlap_seed";
  cycleSkippedReason?: string;
  fairValueFallbackReason?: string;
  stagedEntry?: boolean;
  plannedOppositeSide?: OutcomeSide;
  plannedOppositeQty?: number;
  plannedOppositeFilledQty?: number;
  plannedOppositeMissingQty?: number;
  plannedOppositeAgeSec?: number;
  plannedPairGroupOpenedAt?: number;
  plannedLowSideAvg?: number;
  plannedOppositeMaxPrice?: number;
  plannedOppositeDeadlineSec?: number;
  plannedOppositeMinWaitSec?: number;
  plannedOppositeCompletionAttemptCount?: number;
  plannedOppositeCompletionOpenedCount?: number;
  plannedOppositeBlockedReason?: string;
  xuanGoldenPatternMatched?: boolean;
  mergeHeldForPlannedOpposite?: boolean;
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
  campaignClipType?: MarketBasketClipType | undefined;
  campaignMinClipQty?: number | undefined;
  campaignDefaultClipQty?: number | undefined;
  microRepairMaxQty?: number | undefined;
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
  xuanSeedRhythmWaitSec?: number | undefined;
  xuanSeedDelayedCount?: number | undefined;
  childOrderIntendedSide?: OutcomeSide | undefined;
  childOrderSelectedSide?: OutcomeSide | undefined;
  childOrderReason?:
    | "default"
    | "flow_intent"
    | "high_low_price"
    | "recent_completion"
    | "temporal_priority"
    | "covered_seed_priority"
    | "staged_debt_reducing_flow"
    | undefined;
  semanticRoleTarget?: "neutral" | "mid_pair" | "high_low_setup" | "raw_side_preserve" | undefined;
  completionRoleReleaseOrderBias?: "neutral" | "role_order" | undefined;
  residualJanitorUnlockNetUsdc?: number | undefined;
  residualJanitorProjectedMergeable?: number | undefined;
  residualJanitorProjectedMergeReturn?: number | undefined;
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
  marketBasketProjectedEffectivePair?: number | undefined;
  marketBasketProjectedMatchedQty?: number | undefined;
  marketBasketImprovement?: number | undefined;
  marketBasketDebtBeforeUSDC?: number | undefined;
  marketBasketDebtAfterUSDC?: number | undefined;
  marketBasketDebtDeltaUSDC?: number | undefined;
  marketBasketBootstrap?: boolean | undefined;
  marketBasketContinuation?: boolean | undefined;
  xuanMicroPairContinuation?: boolean | undefined;
  fairValueFallbackReason?: string | undefined;
  balancedButDebted?: boolean | undefined;
  campaignMode?:
    | "PROBE_OPENED"
    | "BASKET_CAMPAIGN_ACTIVE"
    | "ACCUMULATING_CONTINUATION"
    | "UNBALANCED_CAMPAIGN_RESIDUAL"
    | "RESIDUAL_COMPLETION_ACTIVE"
    | "WATCH_FOR_DEBT_REDUCER"
    | undefined;
  campaignBaseLot?: number | undefined;
  executedProbeQty?: number | undefined;
  plannedContinuationQty?: number | undefined;
  currentBasketEffectiveAvg?: number | undefined;
  deltaAverageCost?: number | undefined;
  deltaAbsoluteDebt?: number | undefined;
  deltaTerminalEV?: number | undefined;
  candidateEffectivePair?: number | undefined;
  edgePerPair?: number | undefined;
  qtyNeededToRepayDebt?: number | undefined;
  deltaBasketDebt?: number | undefined;
  continuationRejectedReason?: string | undefined;
  terminalCarryMode?: boolean | undefined;
  deltaTerminalMinPnl?: number | undefined;
  deltaTerminalExpectedPnl?: number | undefined;
  fairValueEVBefore?: number | undefined;
  fairValueEVAfter?: number | undefined;
  addedDebtUSDC?: number | undefined;
  continuationClass?: MarketBasketContinuationClass | undefined;
  campaignClipType?: MarketBasketClipType | undefined;
  avgImprovingBudgetRemainingUSDC?: number | undefined;
  avgImprovingClipBudgetRemaining?: number | undefined;
  flowShapingBudgetRemainingUSDC?: number | undefined;
  flowShapingClipBudgetRemaining?: number | undefined;
  campaignFlowCount?: number | undefined;
  campaignFlowTarget?: number | undefined;
  postCompletionDebtRepairActive?: boolean | undefined;
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
  existingResidualPairCost?: number | undefined;
  negativeEdgeUsdc: number;
  rawPairCost: number;
  feeUSDC: number;
  expectedNetIfMerged: number;
  cycleQualityLabel: CycleQualityLabel;
  orphanRisk: OrphanRiskTrace;
  fairValueDecision: { allowed: boolean; reason?: string | undefined };
  classifierScore: number;
  skipReason?: string | undefined;
  xuanSeedRhythmWaitSec?: number | undefined;
  xuanSeedDelayedCount?: number | undefined;
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
  ctx: EntryLadderContext;
}

type FreshCycleEntryRoute = "balanced_pair" | "temporal_seed" | "covered_seed";

interface FreshCycleCandidateContext {
  route: FreshCycleEntryRoute;
  ctx: EntryLadderContext;
  requestedSize: number;
  rawPair?: number | undefined;
  effectivePair?: number | undefined;
  highSidePrice?: number | undefined;
  lowSidePrice?: number | undefined;
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

function xuanRhythmCompletionGate(args: {
  config: XuanStrategyConfig;
  partialAgeSec: number;
  secsToClose: number;
  repairCost: number;
  currentMatchedEffectivePair: number;
  unbalancedCampaignResidual: boolean;
  plannedOppositeCompletionAllowed: boolean;
  campaignResidualFallbackAllowed: boolean;
}): { shouldWait: boolean; waitSec: number; earlyReason?: string | undefined } {
  if (args.config.botMode !== "XUAN" || args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return { shouldWait: false, waitSec: 0 };
  }
  if (
    args.secsToClose <= args.config.finalWindowCompletionOnlySec ||
    args.plannedOppositeCompletionAllowed ||
    args.repairCost <= args.config.xuanCompletionEarlyReleaseMaxEffectivePair + 1e-9
  ) {
    return {
      shouldWait: false,
      waitSec: 0,
      earlyReason:
        args.repairCost <= args.config.xuanCompletionEarlyReleaseMaxEffectivePair + 1e-9
          ? "profitable_completion"
          : "forced_or_debt_reducing",
    };
  }
  if (args.campaignResidualFallbackAllowed && args.repairCost <= 1 + 1e-9) {
    return { shouldWait: false, waitSec: 0, earlyReason: "forced_or_debt_reducing" };
  }

  const debtPositiveBasket = Number.isFinite(args.currentMatchedEffectivePair) && args.currentMatchedEffectivePair > 1 + 1e-9;
  const waitSec = xuanRhythmWaitForCost(
    args.config,
    args.repairCost,
    debtPositiveBasket || args.unbalancedCampaignResidual,
  );

  return {
    shouldWait: args.partialAgeSec < waitSec,
    waitSec,
  };
}

function aggressiveOppositeReleaseHold(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  sideToBuy: OutcomeSide;
  nowTs: number;
  secsToClose: number;
  effectiveCost: number;
  exactPriorActive: boolean;
}): { holdSec: number; ageSec: number } | undefined {
  if (!isAggressivePublicFootprint(args.config) || args.exactPriorActive) {
    return undefined;
  }
  if (args.secsToClose <= args.config.finalWindowCompletionOnlySec) {
    return undefined;
  }
  const lastBuy = [...args.state.fillHistory].reverse().find((fill) => fill.side === "BUY");
  if (!lastBuy || lastBuy.outcome === args.sideToBuy) {
    return undefined;
  }
  const ageSec = Math.max(0, args.nowTs - lastBuy.timestamp);
  const waitSec = plannedOppositeMinWaitSec(args.config);
  if (ageSec >= waitSec - 1e-9) {
    return undefined;
  }
  return {
    holdSec: normalizeTraceNumber(waitSec - ageSec),
    ageSec: normalizeTraceNumber(ageSec),
  };
}

function xuanRhythmWaitForCost(config: XuanStrategyConfig, effectiveCost: number, debtPositive = false): number {
  if (effectiveCost <= 1 + 1e-9) {
    return config.xuanRhythmMinWaitSec;
  }
  if (effectiveCost <= config.xuanTemporalCompletionEarlyMaxEffectivePair + 1e-9) {
    return Math.max(config.xuanRhythmMinWaitSec, Math.min(config.xuanRhythmBaseWaitSec, 12));
  }
  if (effectiveCost <= 1.025 + 1e-9) {
    return config.xuanRhythmBaseWaitSec;
  }
  return debtPositive
    ? config.xuanRhythmMaxWaitSec
    : Math.max(config.xuanRhythmBaseWaitSec, Math.min(config.xuanRhythmMaxWaitSec, 20));
}

function lastTemporalSeedFill(state: XuanMarketState): FillRecord | undefined {
  return [...state.fillHistory]
    .reverse()
    .find(
      (fill) =>
        fill.side === "BUY" &&
        (fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" || fill.executionMode === "PAIRGROUP_COVERED_SEED"),
    );
}

function lastBuyFill(state: XuanMarketState): FillRecord | undefined {
  return [...state.fillHistory].reverse().find((fill) => fill.side === "BUY");
}

function xuanTemporalSeedRhythmSkipReason(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  ctx: EntryLadderContext;
  referencePairCost: number;
  completingExistingResidual: boolean;
  completingExistingResidualDebtReducing: boolean;
  candidateSide: OutcomeSide;
  exactPriorActive?: boolean | undefined;
}): { skipReason?: string; waitSec?: number; ageSec?: number } {
  if (args.config.botMode !== "XUAN" || args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return {};
  }
  if (args.exactPriorActive) {
    return {};
  }
  if (args.ctx.secsToClose <= args.config.finalWindowCompletionOnlySec) {
    return {};
  }
  const lastSeed = lastTemporalSeedFill(args.state);
  const lastBuy = lastBuyFill(args.state);
  const rhythmReferenceFill =
    isAggressivePublicFootprint(args.config) &&
    lastBuy !== undefined &&
    lastBuy.outcome !== args.candidateSide
      ? lastBuy
      : lastSeed;
  if (!rhythmReferenceFill) {
    return {};
  }
  const nowTs = args.state.market.startTs + args.ctx.secsFromOpen;
  const ageSec = Math.max(0, nowTs - rhythmReferenceFill.timestamp);
  const debtPositive = Number.isFinite(args.referencePairCost) && args.referencePairCost > 1 + 1e-9;
  const sameSideSpam = rhythmReferenceFill.outcome === args.candidateSide;
  const strictOppositeStaging = isAggressivePublicFootprint(args.config) && !sameSideSpam;
  const waitSec = strictOppositeStaging
    ? plannedOppositeMinWaitSec(args.config)
    : xuanRhythmWaitForCost(args.config, args.referencePairCost, debtPositive);
  const earlyRelease =
    !strictOppositeStaging &&
    (args.referencePairCost <= 1 + 1e-9 ||
      (args.completingExistingResidual && args.completingExistingResidualDebtReducing));
  if (!earlyRelease && ageSec < waitSec) {
    return {
      skipReason: sameSideSpam ? "xuan_seed_rhythm_same_side_wait" : "xuan_seed_rhythm_wait",
      waitSec,
      ageSec,
    };
  }
  return { waitSec, ageSec };
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

function xuanFreshCycleFlatDustThreshold(config: XuanStrategyConfig, state: XuanMarketState): number {
  const baseThreshold = Math.max(config.postMergeFlatDustShares, 1e-6);
  if (
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE"
  ) {
    return Math.max(baseThreshold, state.market.minOrderSize);
  }
  return baseThreshold;
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
  if (shareGap > xuanFreshCycleFlatDustThreshold(config, state)) {
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

function openingWeakPairSkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  candidateContext: FreshCycleCandidateContext | undefined,
  quality: CycleQualityLabel,
): string | undefined {
  if (
    config.botMode !== "XUAN" ||
    quality !== "BORDERLINE_PAIR" ||
    !candidateContext ||
    candidateContext.rawPair === undefined ||
    candidateContext.effectivePair === undefined ||
    !Number.isFinite(candidateContext.rawPair) ||
    !Number.isFinite(candidateContext.effectivePair) ||
    state.fillHistory.some((fill) => fill.side === "BUY")
  ) {
    return undefined;
  }

  const ctx = candidateContext.ctx;
  const shareGap = Math.abs(state.upShares - state.downShares);
  if (
    shareGap > xuanFreshCycleFlatDustThreshold(config, state) ||
    ctx.secsToClose <= Math.max(config.finalWindowCompletionOnlySec, config.finalWindowNoChaseSec)
  ) {
    return undefined;
  }

  const rawPair = candidateContext.rawPair;
  const effectivePair = candidateContext.effectivePair;
  const weakOpeningPair =
    rawPair >= config.openingWeakPairRawThreshold - 1e-9 ||
    effectivePair > config.hardNewCycleCap + 1e-9;
  if (!weakOpeningPair) {
    return undefined;
  }

  const highSidePrice =
    candidateContext.highSidePrice ??
    (rawPair < Number.POSITIVE_INFINITY ? Math.max(rawPair / 2, rawPair / 2) : undefined);
  const lowSidePrice =
    candidateContext.lowSidePrice ??
    (rawPair < Number.POSITIVE_INFINITY ? Math.min(rawPair / 2, rawPair / 2) : undefined);
  const spread =
    highSidePrice !== undefined && lowSidePrice !== undefined
      ? highSidePrice - lowSidePrice
      : 0;
  const hasFollowupPlan =
    config.allowControlledOverlap &&
    config.maxOpenGroupsPerMarket >= 2 &&
    config.controlledOverlapSeedMaxQty > 0 &&
    ctx.secsFromOpen <= config.openingFollowupPlanMaxAgeSec + 1e-9 &&
    candidateContext.requestedSize <= Math.max(config.xuanBorderlineEntryMaxQty, config.controlledOverlapSeedMaxQty) + 1e-9 &&
    spread >= config.openingFollowupMinSpread - 1e-9 &&
    (highSidePrice ?? 0) >= config.openingFollowupHighSideMinPrice - 1e-9 &&
    effectivePair <= config.openingFollowupMaxEffectivePair + 1e-9;

  return hasFollowupPlan ? undefined : "opening_weak_pair_no_followup_plan";
}

function earlyMidPairRepeatFeeGuardSkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  stats: FreshCycleStats,
  candidateContext: FreshCycleCandidateContext | undefined,
  quality: CycleQualityLabel,
): string | undefined {
  if (
    config.botMode !== "XUAN" ||
    quality !== "BORDERLINE_PAIR" ||
    !candidateContext ||
    (candidateContext.route !== "covered_seed" && candidateContext.route !== "balanced_pair") ||
    candidateContext.rawPair === undefined ||
    candidateContext.effectivePair === undefined ||
    !Number.isFinite(candidateContext.rawPair) ||
    !Number.isFinite(candidateContext.effectivePair)
  ) {
    return undefined;
  }

  const ctx = candidateContext.ctx;
  if (ctx.secsFromOpen > 90 || ctx.secsToClose <= Math.max(config.finalWindowCompletionOnlySec, config.finalWindowNoChaseSec)) {
    return undefined;
  }

  const protectedResidualShares = Math.max(0, ctx.protectedResidualShares ?? 0);
  if (protectedResidualShares > Math.max(config.repairMinQty, config.completionMinQty)) {
    return undefined;
  }

  const rawPair = candidateContext.rawPair;
  const isNeutralMidPair = rawPair >= 1.005 - 1e-9 && rawPair <= Math.min(1.03, config.xuanBorderlineRawPairCap) + 1e-9;
  if (!isNeutralMidPair) {
    return undefined;
  }

  const nowTs = state.market.startTs + ctx.secsFromOpen;
  const requiredImprovement = Math.max(0, config.borderlinePairRepeatMinEffectiveImprovement);
  const recentNegativeMidCycle =
    stats.lastCycle !== undefined &&
    stats.lastCycle.expectedNetIfMerged < -1e-9 &&
    nowTs - stats.lastCycle.closedAt <= 90 &&
    candidateContext.effectivePair > stats.lastCycle.effectivePair - requiredImprovement + 1e-9;
  const recentFreshSeed = state.fillHistory.some(
    (fill) =>
      fill.side === "BUY" &&
      nowTs - fill.timestamp <= 45 &&
      (
        fill.executionMode === "STRICT_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_SOFT_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_HARD_PAIR_SWEEP" ||
        fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" ||
        fill.executionMode === "PAIRGROUP_COVERED_SEED"
      ),
  );
  const matchedInventoryReady = mergeableShares(state) >= Math.max(config.mergeMinShares, 1e-6);
  const flatEnough = Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6);

  if (!flatEnough || (!recentFreshSeed && !matchedInventoryReady && !recentNegativeMidCycle)) {
    return undefined;
  }

  return "early_mid_pair_repeat_fee_guard";
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

interface MarketBasketStateTrace {
  totalUp: number;
  totalDown: number;
  mergeableQty: number;
  residualSide: OutcomeSide | "BALANCED";
  residualQty: number;
  basketEffectiveAvg: number;
  basketDebtUSDC: number;
  terminalPnlIfUp: number;
  terminalPnlIfDown: number;
  needsContinuation: boolean;
  balancedButDebted: boolean;
  campaignActive: boolean;
  campaignMode?: "BASKET_CAMPAIGN_ACTIVE" | "UNBALANCED_CAMPAIGN_RESIDUAL";
  campaignState?:
    | "ORPHAN_COMPLETION_DUTY"
    | "BALANCED_DEBT_CAMPAIGN"
    | "POST_PROFIT_CAMPAIGN"
    | "MERGE_READY";
  orphanCompletionDutyActive?: boolean;
  stagedLowSideOpenedButOppositeMissing?: boolean;
  plannedOppositeSide?: OutcomeSide;
  plannedOppositeQty?: number;
  plannedOppositeFilledQty?: number;
  plannedOppositeMissingQty?: number;
  plannedOppositeAgeSec?: number;
  plannedPairGroupOpenedAt?: number;
  plannedLowSideAvg?: number;
}

function estimateTraceCampaignFlowCount(state: XuanMarketState): number {
  const buys = state.fillHistory
    .filter(
      (fill) =>
        fill.side === "BUY" &&
        (
          fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" ||
          fill.executionMode === "PAIRGROUP_COVERED_SEED" ||
          fill.executionMode === "XUAN_HARD_PAIR_SWEEP" ||
          fill.executionMode === "XUAN_SOFT_PAIR_SWEEP" ||
          fill.executionMode === "STRICT_PAIR_SWEEP"
        ),
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  let flowCount = 0;
  let lastTimestamp: number | undefined;

  for (const fill of buys) {
    if (lastTimestamp === undefined || fill.timestamp - lastTimestamp > 4) {
      flowCount += 1;
    }
    lastTimestamp = fill.timestamp;
  }

  return flowCount;
}

function publicFootprintBasketMergeTargetQty(config: XuanStrategyConfig): number {
  const baseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
  return normalizeTraceNumber(
    Math.max(
      config.marketBasketMinMergeShares,
      Math.min(
        config.marketBasketMergeTargetMaxShares,
        baseLot * Math.max(1, config.marketBasketMergeTargetMultiplier),
      ),
    ),
  );
}

function effectiveInventoryCost(state: XuanMarketState, side: OutcomeSide, feeRate: number): number {
  const lots = side === "UP" ? state.upLots : state.downLots;
  if (lots.length === 0) {
    const shares = side === "UP" ? state.upShares : state.downShares;
    return shares * averageEffectiveCost(state, side, feeRate);
  }
  return lots.reduce((sum, lot) => sum + lot.size * (lot.price + takerFeePerShare(lot.price, feeRate)), 0);
}

function isCampaignSeedMode(mode: StrategyExecutionMode | undefined): boolean {
  return (
    mode === "TEMPORAL_SINGLE_LEG_SEED" ||
    mode === "PAIRGROUP_COVERED_SEED" ||
    mode === "XUAN_HARD_PAIR_SWEEP" ||
    mode === "XUAN_SOFT_PAIR_SWEEP" ||
    mode === "STRICT_PAIR_SWEEP" ||
    mode === "PARTIAL_FAST_COMPLETION" ||
    mode === "PARTIAL_SOFT_COMPLETION" ||
    mode === "HIGH_LOW_COMPLETION_CHASE"
  );
}

function hasCampaignSeedFill(state: XuanMarketState): boolean {
  return state.fillHistory.some((fill) => fill.side === "BUY" && isCampaignSeedMode(fill.executionMode));
}

function oneSidedCampaignSeedAgeSec(state: XuanMarketState, residualSide: OutcomeSide, nowTs: number): number | undefined {
  const campaignSeedTimestamps = state.fillHistory
    .filter((fill) => fill.side === "BUY" && fill.outcome === residualSide && isCampaignSeedMode(fill.executionMode))
    .map((fill) => fill.timestamp);
  if (campaignSeedTimestamps.length === 0) {
    return undefined;
  }
  return Math.max(0, nowTs - Math.min(...campaignSeedTimestamps));
}

function hasStagedLowSideOpenedButOppositeMissing(
  state: XuanMarketState,
  residualSide: OutcomeSide | "BALANCED",
  residualQty: number,
): boolean {
  if (residualSide === "BALANCED" || residualQty <= 1e-6) {
    return false;
  }
  return state.fillHistory.some(
    (fill) =>
      fill.side === "BUY" &&
      fill.outcome === residualSide &&
      fill.executionMode === "PAIRGROUP_COVERED_SEED",
  );
}

function marketBasketStateTrace(config: XuanStrategyConfig, state: XuanMarketState): MarketBasketStateTrace {
  const nowTs = Math.max(
    state.market.startTs,
    ...state.fillHistory.map((fill) => fill.timestamp),
  );
  const mergeableQty = mergeableShares(state);
  const residualQty = Math.abs(state.upShares - state.downShares);
  const residualSide: OutcomeSide | "BALANCED" =
    residualQty <= 1e-6 ? "BALANCED" : state.upShares > state.downShares ? "UP" : "DOWN";
  const basketEffectiveAvg = mergeableQty > 1e-6
    ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate)
    : 0;
  const upEffectiveCost = effectiveInventoryCost(state, "UP", config.cryptoTakerFeeRate);
  const downEffectiveCost = effectiveInventoryCost(state, "DOWN", config.cryptoTakerFeeRate);
  const totalEffectiveCost = upEffectiveCost + downEffectiveCost;
  const basketDebtUSDC = Math.max(0, basketEffectiveAvg - 1) * mergeableQty;
  const balancedButDebted =
    config.balancedDebtContinuationEnabled &&
    config.marketBasketContinuationEnabled &&
    mergeableQty >= config.marketBasketContinuationMinMatchedShares - 1e-9 &&
    residualQty <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
    basketDebtUSDC > config.marketBasketMinDebtUsdc + 1e-9;
  const campaignSeedActive = hasCampaignSeedFill(state);
  const campaignFlowCount = estimateTraceCampaignFlowCount(state);
  const campaignFlowTarget = Math.max(1, config.xuanBasketCampaignMinFlows);
  const campaignMergeTargetQty = publicFootprintBasketMergeTargetQty(config);
  const orphanCampaignSeedActive =
    config.xuanBasketCampaignEnabled &&
    config.marketBasketContinuationEnabled &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    campaignSeedActive &&
    residualSide !== "BALANCED" &&
    residualQty >= Math.max(config.repairMinQty, config.completionMinQty) - 1e-9 &&
    mergeableQty < campaignMergeTargetQty - 1e-9;
  const debtPositiveCampaignActive =
    config.xuanBasketCampaignEnabled &&
    config.marketBasketContinuationEnabled &&
    mergeableQty >= config.xuanBasketCampaignMinMatchedShares - 1e-9 &&
    basketDebtUSDC > config.marketBasketMinDebtUsdc + 1e-9 &&
    basketEffectiveAvg > config.marketBasketGoodAvgCap + 1e-9 &&
    (
      residualQty <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 ||
      campaignSeedActive
    );
  const postProfitCampaignActive =
    config.xuanBasketCampaignEnabled &&
    config.marketBasketContinuationEnabled &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    campaignSeedActive &&
    mergeableQty >= config.xuanBasketCampaignMinMatchedShares - 1e-9 &&
    residualQty <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
    basketEffectiveAvg <= config.marketBasketMergeEffectivePairCap + 1e-9 &&
    mergeableQty < campaignMergeTargetQty - 1e-9 &&
    campaignFlowCount < campaignFlowTarget;
  const campaignActive = debtPositiveCampaignActive || postProfitCampaignActive || orphanCampaignSeedActive;
  const campaignState =
    orphanCampaignSeedActive
      ? "ORPHAN_COMPLETION_DUTY"
      : debtPositiveCampaignActive
        ? "BALANCED_DEBT_CAMPAIGN"
        : postProfitCampaignActive
          ? "POST_PROFIT_CAMPAIGN"
          : mergeableQty >= campaignMergeTargetQty - 1e-9 &&
              basketEffectiveAvg <= config.marketBasketMergeEffectivePairCap + 1e-9
            ? "MERGE_READY"
            : undefined;
  const plannedOpposite = plannedOppositeCompletionState(state, nowTs, Math.max(config.postMergeFlatDustShares, 1e-6));
  const stagedLowSideOpenedButOppositeMissing =
    plannedOpposite !== undefined ||
    hasStagedLowSideOpenedButOppositeMissing(
      state,
      residualSide,
      residualQty,
    );
  return {
    totalUp: normalizeTraceNumber(state.upShares),
    totalDown: normalizeTraceNumber(state.downShares),
    mergeableQty: normalizeTraceNumber(mergeableQty),
    residualSide,
    residualQty: normalizeTraceNumber(residualQty),
    basketEffectiveAvg: normalizeTraceNumber(basketEffectiveAvg),
    basketDebtUSDC: normalizeTraceNumber(basketDebtUSDC),
    terminalPnlIfUp: normalizeTraceNumber(state.upShares - totalEffectiveCost),
    terminalPnlIfDown: normalizeTraceNumber(state.downShares - totalEffectiveCost),
    needsContinuation:
      balancedButDebted ||
      orphanCampaignSeedActive ||
      campaignActive ||
      (mergeableQty > 1e-6 && basketEffectiveAvg > config.marketBasketGoodAvgCap + 1e-9),
    balancedButDebted,
    campaignActive,
    ...(campaignActive ? { campaignMode: orphanCampaignSeedActive ? "UNBALANCED_CAMPAIGN_RESIDUAL" : "BASKET_CAMPAIGN_ACTIVE" } : {}),
    ...(campaignState ? { campaignState } : {}),
    ...(orphanCampaignSeedActive ? { orphanCompletionDutyActive: true } : {}),
    ...(stagedLowSideOpenedButOppositeMissing ? { stagedLowSideOpenedButOppositeMissing: true } : {}),
    ...(plannedOpposite
      ? {
          plannedOppositeSide: plannedOpposite.plannedOppositeSide,
          plannedOppositeQty: plannedOpposite.plannedOppositeQty,
          plannedOppositeFilledQty: plannedOpposite.plannedOppositeFilledQty,
          plannedOppositeMissingQty: plannedOpposite.plannedOppositeMissingQty,
          plannedOppositeAgeSec: plannedOpposite.plannedOppositeAgeSec,
          plannedPairGroupOpenedAt: plannedOpposite.plannedPairGroupOpenedAt,
          plannedLowSideAvg: plannedOpposite.plannedLowSideAvg,
        }
      : {}),
  };
}

function basketTraceFields(config: XuanStrategyConfig, state: XuanMarketState): Partial<EntryDecisionTrace> {
  if (!config.marketBasketScoringEnabled) {
    return {};
  }
  const basket = marketBasketStateTrace(config, state);
  return {
    marketBasketTotalUp: basket.totalUp,
    marketBasketTotalDown: basket.totalDown,
    marketBasketMergeableQty: basket.mergeableQty,
    marketBasketResidualSide: basket.residualSide,
    marketBasketResidualQty: basket.residualQty,
    marketBasketEffectiveAvg: basket.basketEffectiveAvg,
    marketBasketDebtUSDC: basket.basketDebtUSDC,
    marketBasketNeedsContinuation: basket.needsContinuation,
    balancedButDebted: basket.balancedButDebted,
    ...(basket.campaignState ? { campaignState: basket.campaignState } : {}),
    ...(basket.orphanCompletionDutyActive ? { orphanCompletionDutyActive: true } : {}),
    ...(basket.stagedLowSideOpenedButOppositeMissing ? { stagedLowSideOpenedButOppositeMissing: true } : {}),
    ...(basket.plannedOppositeSide ? { plannedOppositeSide: basket.plannedOppositeSide } : {}),
    ...(basket.plannedOppositeQty !== undefined ? { plannedOppositeQty: basket.plannedOppositeQty } : {}),
    ...(basket.plannedOppositeFilledQty !== undefined ? { plannedOppositeFilledQty: basket.plannedOppositeFilledQty } : {}),
    ...(basket.plannedOppositeMissingQty !== undefined ? { plannedOppositeMissingQty: basket.plannedOppositeMissingQty } : {}),
    ...(basket.plannedOppositeAgeSec !== undefined ? { plannedOppositeAgeSec: basket.plannedOppositeAgeSec } : {}),
    ...(basket.plannedPairGroupOpenedAt !== undefined ? { plannedPairGroupOpenedAt: basket.plannedPairGroupOpenedAt } : {}),
    ...(basket.plannedLowSideAvg !== undefined ? { plannedLowSideAvg: basket.plannedLowSideAvg } : {}),
    ...(basket.mergeableQty >= config.marketBasketMinMergeShares - 1e-9 &&
    xuanFlowCount(state) >= 2 &&
    !basket.stagedLowSideOpenedButOppositeMissing
      ? { xuanGoldenPatternMatched: true }
      : {}),
    ...(basket.campaignMode
      ? {
          campaignMode: basket.campaignMode,
          campaignBaseLot: config.liveSmallLotLadder[0] ?? config.defaultLot,
        }
      : {}),
    terminalPnlIfUp: basket.terminalPnlIfUp,
    terminalPnlIfDown: basket.terminalPnlIfDown,
  };
}

function isUnbalancedCampaignResidual(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  shareGap: number,
): boolean {
  if (
    !config.xuanBasketCampaignEnabled ||
    !config.marketBasketContinuationEnabled ||
    config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    shareGap <= Math.max(config.controlledOverlapMinResidualShares, config.microRepairMaxQty) + 1e-9
  ) {
    return false;
  }
  const matchedQty = mergeableShares(state);
  const hasSeedDuty = hasCampaignSeedFill(state);
  if (matchedQty < config.xuanBasketCampaignMinMatchedShares - 1e-9 && !hasSeedDuty) {
    return false;
  }
  return hasSeedDuty;
}

function residualCompletionFairValueFallback(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  unbalancedCampaignResidual: boolean;
  repairCost: number;
  currentMatchedEffectivePair: number;
  executableSize: number;
  oldGap: number;
  newGap: number;
  orphanCompletionDutyActive?: boolean | undefined;
  phaseCap?: number | undefined;
}): { allowed: boolean; reason?: string | undefined } {
  if (
    !args.config.allowResidualCompletionWithoutFairValue ||
    !args.unbalancedCampaignResidual ||
    args.executableSize <= 0 ||
    args.executableSize > args.oldGap + 1e-9 ||
    args.newGap >= args.oldGap - 1e-9
  ) {
    return { allowed: false };
  }
  if (args.repairCost <= args.config.residualCompletionCostBasisCap + 1e-9) {
    return { allowed: true, reason: "residual_cost_basis_cap" };
  }
  const hasTemporalSingleLegSeed = args.state.fillHistory.some(
    (fill) => fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" || fill.executionMode === "PAIRGROUP_COVERED_SEED",
  );
  if (
    args.config.botMode === "XUAN" &&
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    hasTemporalSingleLegSeed &&
    args.orphanCompletionDutyActive &&
    args.repairCost <= Math.max(args.config.softResidualCompletionCap, args.config.temporalRepairPatientCap) + 1e-9
  ) {
    return { allowed: true, reason: "xuan_orphan_seed_completion_priority" };
  }
  if (
    args.orphanCompletionDutyActive &&
    args.phaseCap !== undefined &&
    args.repairCost <= Math.max(args.phaseCap, args.config.softResidualCompletionCap) + 1e-9
  ) {
    return { allowed: true, reason: "orphan_seed_completion_duty" };
  }
  if (
    Number.isFinite(args.currentMatchedEffectivePair) &&
    args.repairCost <= args.config.softResidualCompletionCap + 1e-9 &&
    args.repairCost < args.currentMatchedEffectivePair - args.config.residualCompletionImprovementThreshold + 1e-9
  ) {
    return { allowed: true, reason: "residual_average_improvement" };
  }
  return { allowed: false };
}

function marketBasketProjection(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  candidateEffectivePair: number,
  candidateQty: number,
): {
  projectedEffectivePair: number;
  projectedMatchedQty: number;
  improvement: number;
  debtBeforeUSDC: number;
  debtAfterUSDC: number;
  debtDeltaUSDC: number;
} | undefined {
  if (
    !config.marketBasketScoringEnabled ||
    candidateQty <= 0 ||
    !Number.isFinite(candidateEffectivePair)
  ) {
    return undefined;
  }
  const currentMatchedQty = mergeableShares(state);
  const currentEffectivePair =
    currentMatchedQty > 1e-9 ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate) : candidateEffectivePair;
  const projectedMatchedQty = currentMatchedQty + candidateQty;
  const projectedEffectivePair =
    projectedMatchedQty > 1e-9
      ? (currentMatchedQty * currentEffectivePair + candidateQty * candidateEffectivePair) / projectedMatchedQty
      : candidateEffectivePair;
  const debtBeforeUSDC = Math.max(0, currentEffectivePair - 1) * currentMatchedQty;
  const debtAfterUSDC = Math.max(0, projectedEffectivePair - 1) * projectedMatchedQty;
  return {
    projectedEffectivePair: normalizeTraceNumber(projectedEffectivePair),
    projectedMatchedQty: normalizeTraceNumber(projectedMatchedQty),
    improvement: normalizeTraceNumber(currentMatchedQty > 1e-9 ? currentEffectivePair - projectedEffectivePair : 0),
    debtBeforeUSDC: normalizeTraceNumber(debtBeforeUSDC),
    debtAfterUSDC: normalizeTraceNumber(debtAfterUSDC),
    debtDeltaUSDC: normalizeTraceNumber(debtBeforeUSDC - debtAfterUSDC),
  };
}

interface TerminalCarryProjection {
  terminalMinPnlBefore: number;
  terminalMinPnlAfter: number;
  deltaTerminalMinPnl: number;
  fairValueEVBefore?: number | undefined;
  fairValueEVAfter?: number | undefined;
  deltaTerminalExpectedPnl?: number | undefined;
  addedDebtUSDC: number;
  allowed: boolean;
}

function terminalCarryProjectionForPair(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  upQty: number;
  downQty: number;
  upPrice: number;
  downPrice: number;
  effectivePair: number;
}): TerminalCarryProjection {
  const beforeUpCost = effectiveInventoryCost(args.state, "UP", args.config.cryptoTakerFeeRate);
  const beforeDownCost = effectiveInventoryCost(args.state, "DOWN", args.config.cryptoTakerFeeRate);
  const beforeTotalCost = beforeUpCost + beforeDownCost;
  const beforeUpShares = args.state.upShares;
  const beforeDownShares = args.state.downShares;
  const afterUpShares = beforeUpShares + args.upQty;
  const afterDownShares = beforeDownShares + args.downQty;
  const addedUpCost = args.upQty * (args.upPrice + takerFeePerShare(args.upPrice, args.config.cryptoTakerFeeRate));
  const addedDownCost = args.downQty * (args.downPrice + takerFeePerShare(args.downPrice, args.config.cryptoTakerFeeRate));
  const afterTotalCost = beforeTotalCost + addedUpCost + addedDownCost;
  const terminalMinPnlBefore = Math.min(beforeUpShares - beforeTotalCost, beforeDownShares - beforeTotalCost);
  const terminalMinPnlAfter = Math.min(afterUpShares - afterTotalCost, afterDownShares - afterTotalCost);
  const fairUp = fairValueForOrphanSide(args.fairValueSnapshot, "UP");
  const fairDown = fairValueForOrphanSide(args.fairValueSnapshot, "DOWN");
  const fairValueEVBefore =
    fairUp !== undefined && fairDown !== undefined
      ? beforeUpShares * fairUp + beforeDownShares * fairDown - beforeTotalCost
      : undefined;
  const fairValueEVAfter =
    fairUp !== undefined && fairDown !== undefined
      ? afterUpShares * fairUp + afterDownShares * fairDown - afterTotalCost
      : undefined;
  const deltaTerminalExpectedPnl =
    fairValueEVBefore !== undefined && fairValueEVAfter !== undefined
      ? fairValueEVAfter - fairValueEVBefore
      : undefined;
  const addedDebtUSDC = Math.max(0, args.effectivePair - 1) * Math.max(Math.min(args.upQty, args.downQty), 0);
  const deltaTerminalMinPnl = terminalMinPnlAfter - terminalMinPnlBefore;
  const evBeatsAddedDebt =
    deltaTerminalExpectedPnl !== undefined &&
    deltaTerminalExpectedPnl >= args.config.terminalCarryMinEvGainUsdc - 1e-9 &&
    deltaTerminalExpectedPnl > addedDebtUSDC + 1e-9;
  const minPnlImproves =
    deltaTerminalMinPnl >= args.config.terminalCarryMinMinPnlImprovementUsdc - 1e-9;

  return {
    terminalMinPnlBefore: normalizeTraceNumber(terminalMinPnlBefore),
    terminalMinPnlAfter: normalizeTraceNumber(terminalMinPnlAfter),
    deltaTerminalMinPnl: normalizeTraceNumber(deltaTerminalMinPnl),
    ...(fairValueEVBefore !== undefined ? { fairValueEVBefore: normalizeTraceNumber(fairValueEVBefore) } : {}),
    ...(fairValueEVAfter !== undefined ? { fairValueEVAfter: normalizeTraceNumber(fairValueEVAfter) } : {}),
    ...(deltaTerminalExpectedPnl !== undefined
      ? { deltaTerminalExpectedPnl: normalizeTraceNumber(deltaTerminalExpectedPnl) }
      : {}),
    addedDebtUSDC: normalizeTraceNumber(addedDebtUSDC),
    allowed:
      args.config.terminalCarryImprovementEnabled &&
      addedDebtUSDC <= args.config.terminalCarryMaxAddedDebtUsdc + 1e-9 &&
      (evBeatsAddedDebt || minPnlImproves),
  };
}

function isHighLowVisualPair(config: XuanStrategyConfig, upPrice: number, downPrice: number): boolean {
  const high = Math.max(upPrice, downPrice);
  const low = Math.min(upPrice, downPrice);
  const spread = high - low;
  return (
    spread + 1e-9 >= config.highLowContinuationMinSpread &&
    low <= config.lowSideMaxForHighCompletion + 0.06 + 1e-9 &&
    high >= config.highSidePriceThreshold - 0.12 - 1e-9
  );
}

function shouldAllowPostCompletionDebtCampaignPairOverride(args: {
  config: XuanStrategyConfig;
  basketState: MarketBasketStateTrace;
  allowance: ReturnType<typeof pairSweepAllowance> | undefined;
  basketProjection: ReturnType<typeof marketBasketProjection> | undefined;
  terminalCarryProjection: TerminalCarryProjection;
  pairCost: number;
  requestedSize: number;
}): boolean {
  if (
    args.config.botMode !== "XUAN" ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.basketState.campaignActive ||
    !args.basketState.balancedButDebted ||
    !args.allowance?.marketBasketContinuation ||
    args.allowance.continuationClass !== "AVG_IMPROVING" ||
    !args.basketProjection
  ) {
    return false;
  }
  if (
    args.pairCost > args.config.xuanBasketCampaignFlowShapingEffectiveCap + 1e-9 ||
    args.pairCost > args.basketState.basketEffectiveAvg - args.config.marketBasketMinAvgImprovement + 1e-9
  ) {
    return false;
  }
  if (args.basketProjection.improvement < args.config.marketBasketMinAvgImprovement - 1e-9) {
    return false;
  }
  if (
    args.allowance.avgImprovingClipBudgetRemaining !== undefined &&
    args.allowance.avgImprovingClipBudgetRemaining <= 0
  ) {
    return false;
  }
  const addedDebtUSDC = Math.max(0, args.pairCost - 1) * args.requestedSize;
  const maxAddedDebt = Math.max(
    args.config.maxAvgImprovingAddedDebtUsdc,
    args.config.xuanBasketCampaignAvgImprovementMaxAddedDebtUsdc,
    Math.min(Math.max(args.basketState.basketDebtUSDC * 0.35, 0.75), 2.5),
  );
  if (
    args.allowance.avgImprovingBudgetRemainingUSDC !== undefined &&
    addedDebtUSDC > args.allowance.avgImprovingBudgetRemainingUSDC + 1e-9
  ) {
    return false;
  }
  if (addedDebtUSDC > maxAddedDebt + 1e-9) {
    return false;
  }
  const terminalAllowedDrag = Math.min(maxAddedDebt, Math.max(0.25, args.basketState.basketDebtUSDC * 0.2));
  if (args.terminalCarryProjection.deltaTerminalMinPnl < -terminalAllowedDrag - 1e-9) {
    return false;
  }
  return true;
}

function xuanFlowCount(state: XuanMarketState): number {
  return estimateTraceCampaignFlowCount(state);
}

function traceRepairCounters(traces: BalancedPairCandidateTrace[]): Partial<EntryDecisionTrace> {
  const postCompletionRepairAttemptCount = traces.filter((trace) => trace.postCompletionDebtRepairActive).length;
  const postCompletionRepairOpenedCount = traces.filter(
    (trace) => trace.postCompletionDebtRepairActive && trace.verdict === "ok",
  ).length;
  const pairCapBlockedRepairCount = traces.filter(
    (trace) => trace.postCompletionDebtRepairActive && trace.verdict === "pair_cap",
  ).length;
  const avgImprovingActionCount = traces.filter(
    (trace) => trace.verdict === "ok" && trace.continuationClass === "AVG_IMPROVING",
  ).length;
  const debtReducingActionCount = traces.filter(
    (trace) => trace.verdict === "ok" && trace.continuationClass === "DEBT_REDUCING",
  ).length;

  return {
    ...(postCompletionRepairAttemptCount > 0 ? { postCompletionRepairAttemptCount } : {}),
    ...(postCompletionRepairOpenedCount > 0 ? { postCompletionRepairOpenedCount } : {}),
    ...(pairCapBlockedRepairCount > 0 ? { pairCapBlockedRepairCount } : {}),
    ...(avgImprovingActionCount > 0 ? { avgImprovingActionCount } : {}),
    ...(debtReducingActionCount > 0 ? { debtReducingActionCount } : {}),
  };
}

function balancedDebtContinuationQtyCap(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  basketState: MarketBasketStateTrace,
  maxCandidateSize: number,
): number | undefined {
  if (
    !basketState.balancedButDebted ||
    maxCandidateSize <= 0 ||
    basketState.basketDebtUSDC <= config.marketBasketMinDebtUsdc + 1e-9
  ) {
    return undefined;
  }

  const probeSize = normalizeOrderSize(state.market.minOrderSize, state.market.minOrderSize);
  if (probeSize <= 0) {
    return undefined;
  }
  const upProbe = books.quoteForSize("UP", "ask", probeSize);
  const downProbe = books.quoteForSize("DOWN", "ask", probeSize);
  if (!upProbe.fullyFilled || !downProbe.fullyFilled) {
    return undefined;
  }

  const probeEffectivePair = pairCostWithBothTaker(
    upProbe.averagePrice,
    downProbe.averagePrice,
    config.cryptoTakerFeeRate,
  );
  const edgePerPair = 1 - probeEffectivePair;
  if (edgePerPair <= 1e-9) {
    return undefined;
  }

  const qtyNeeded = basketState.basketDebtUSDC / edgePerPair;
  return normalizeOrderSize(
    Math.min(maxCandidateSize, config.marketBasketContinuationMaxQty, qtyNeeded),
    state.market.minOrderSize,
  );
}

function shouldBlockLowSideUnpairedBasketDebtSeed(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  basketState: MarketBasketStateTrace;
  side: OutcomeSide;
  seedPrice: number;
  oldGap: number;
  canUseInventoryCover: boolean;
  useStagedBorderlineEntry: boolean;
  basketProjection?: ReturnType<typeof marketBasketProjection>;
}): boolean {
  if (
    !args.config.marketBasketScoringEnabled ||
    !args.basketState.needsContinuation ||
    !args.useStagedBorderlineEntry ||
    args.canUseInventoryCover
  ) {
    return false;
  }

  const lowSideSeed = args.seedPrice <= args.config.lowSideMaxForHighCompletion + 0.04;
  if (!lowSideSeed) {
    return false;
  }

  const buysIntoExistingOppositeResidual =
    args.oldGap > Math.max(args.config.postMergeFlatDustShares, 1e-6) &&
    ((args.side === "UP" && args.state.downShares > args.state.upShares) ||
      (args.side === "DOWN" && args.state.upShares > args.state.downShares));
  if (buysIntoExistingOppositeResidual) {
    return false;
  }

  const pairedPlanImprovesBasket =
    args.basketProjection !== undefined &&
    (args.basketProjection.debtDeltaUSDC > 1e-9 ||
      args.basketProjection.projectedEffectivePair <=
        args.config.marketBasketContinuationProjectedEffectivePairCap + 1e-9 ||
      args.basketProjection.projectedEffectivePair <= args.config.marketBasketGoodAvgCap + 1e-9);

  return !pairedPlanImprovesBasket;
}

function isStrongMarketBasketPair(config: XuanStrategyConfig, rawPair: number, effectivePair: number): boolean {
  return (
    config.marketBasketScoringEnabled &&
    Number.isFinite(rawPair) &&
    Number.isFinite(effectivePair) &&
    rawPair <= config.marketBasketStrongRawPairCap + 1e-9 &&
    effectivePair <= config.marketBasketStrongEffectivePairCap + 1e-9
  );
}

function marketBasketContinuationAllowed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  candidateContext: FreshCycleCandidateContext | undefined,
): boolean {
  const effectivePair = candidateContext?.effectivePair;
  if (!candidateContext || effectivePair === undefined || !Number.isFinite(effectivePair)) {
    return false;
  }
  return Boolean(
    projectMarketBasketContinuation({
      config,
      state,
      costWithFees: effectivePair,
      candidateSize: candidateContext.requestedSize,
      secsToClose: candidateContext.ctx.secsToClose,
      ...(candidateContext.highSidePrice !== undefined && candidateContext.lowSidePrice !== undefined
        ? { priceSpread: Math.abs(candidateContext.highSidePrice - candidateContext.lowSidePrice) }
        : {}),
    })?.allowed,
  );
}

function marketBasketBootstrapCandidateAllowed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  candidateContext: FreshCycleCandidateContext | undefined,
): boolean {
  const effectivePair = candidateContext?.effectivePair;
  if (!candidateContext || effectivePair === undefined || !Number.isFinite(effectivePair)) {
    return false;
  }
  return marketBasketBootstrapAllowed({
    config,
    state,
    costWithFees: effectivePair,
    candidateSize: candidateContext.requestedSize,
    secsToClose: candidateContext.ctx.secsToClose,
  });
}

function basketTraceFromCandidate(candidate: BalancedPairCandidate): Partial<EntryDecisionTrace> {
  return {
    ...(candidate.marketBasketProjectedEffectivePair !== undefined
      ? { marketBasketProjectedEffectivePair: candidate.marketBasketProjectedEffectivePair }
      : {}),
    ...(candidate.marketBasketProjectedMatchedQty !== undefined
      ? { marketBasketProjectedMatchedQty: candidate.marketBasketProjectedMatchedQty }
      : {}),
    ...(candidate.marketBasketImprovement !== undefined
      ? { marketBasketImprovement: candidate.marketBasketImprovement }
      : {}),
    ...(candidate.marketBasketDebtBeforeUSDC !== undefined
      ? { marketBasketDebtBeforeUSDC: candidate.marketBasketDebtBeforeUSDC }
      : {}),
    ...(candidate.marketBasketDebtAfterUSDC !== undefined
      ? { marketBasketDebtAfterUSDC: candidate.marketBasketDebtAfterUSDC }
      : {}),
    ...(candidate.marketBasketDebtDeltaUSDC !== undefined
      ? { marketBasketDebtDeltaUSDC: candidate.marketBasketDebtDeltaUSDC }
      : {}),
    ...(candidate.marketBasketBootstrap ? { marketBasketBootstrap: true } : {}),
    ...(candidate.marketBasketContinuation ? { marketBasketContinuation: true } : {}),
    ...(candidate.xuanMicroPairContinuation ? { xuanMicroPairContinuation: true } : {}),
    ...(candidate.fairValueFallbackReason ? { fairValueFallbackReason: candidate.fairValueFallbackReason } : {}),
    ...(candidate.balancedButDebted ? { balancedButDebted: true } : {}),
    ...(candidate.campaignMode ? { campaignMode: candidate.campaignMode } : {}),
    ...(candidate.campaignBaseLot !== undefined ? { campaignBaseLot: candidate.campaignBaseLot } : {}),
    ...(candidate.executedProbeQty !== undefined ? { executedProbeQty: candidate.executedProbeQty } : {}),
    ...(candidate.plannedContinuationQty !== undefined
      ? { plannedContinuationQty: candidate.plannedContinuationQty }
      : {}),
    ...(candidate.currentBasketEffectiveAvg !== undefined
      ? { currentBasketEffectiveAvg: candidate.currentBasketEffectiveAvg }
      : {}),
    ...(candidate.deltaAverageCost !== undefined ? { deltaAverageCost: candidate.deltaAverageCost } : {}),
    ...(candidate.deltaAbsoluteDebt !== undefined ? { deltaAbsoluteDebt: candidate.deltaAbsoluteDebt } : {}),
    ...(candidate.deltaTerminalEV !== undefined ? { deltaTerminalEV: candidate.deltaTerminalEV } : {}),
    ...(candidate.candidateEffectivePair !== undefined ? { candidateEffectivePair: candidate.candidateEffectivePair } : {}),
    ...(candidate.edgePerPair !== undefined ? { edgePerPair: candidate.edgePerPair } : {}),
    ...(candidate.qtyNeededToRepayDebt !== undefined
      ? { qtyNeededToRepayDebt: candidate.qtyNeededToRepayDebt }
      : {}),
    ...(candidate.deltaBasketDebt !== undefined ? { deltaBasketDebt: candidate.deltaBasketDebt } : {}),
    ...(candidate.continuationRejectedReason
      ? { continuationRejectedReason: candidate.continuationRejectedReason }
      : {}),
    ...(candidate.terminalCarryMode ? { terminalCarryMode: true } : {}),
    ...(candidate.deltaTerminalMinPnl !== undefined ? { deltaTerminalMinPnl: candidate.deltaTerminalMinPnl } : {}),
    ...(candidate.deltaTerminalExpectedPnl !== undefined
      ? { deltaTerminalExpectedPnl: candidate.deltaTerminalExpectedPnl }
      : {}),
    ...(candidate.fairValueEVBefore !== undefined ? { fairValueEVBefore: candidate.fairValueEVBefore } : {}),
    ...(candidate.fairValueEVAfter !== undefined ? { fairValueEVAfter: candidate.fairValueEVAfter } : {}),
    ...(candidate.addedDebtUSDC !== undefined ? { addedDebtUSDC: candidate.addedDebtUSDC } : {}),
    ...(candidate.continuationClass !== undefined ? { continuationClass: candidate.continuationClass } : {}),
    ...(candidate.campaignClipType !== undefined ? { campaignClipType: candidate.campaignClipType } : {}),
    ...(candidate.avgImprovingBudgetRemainingUSDC !== undefined
      ? { avgImprovingBudgetRemainingUSDC: candidate.avgImprovingBudgetRemainingUSDC }
      : {}),
    ...(candidate.avgImprovingClipBudgetRemaining !== undefined
      ? { avgImprovingClipBudgetRemaining: candidate.avgImprovingClipBudgetRemaining }
      : {}),
    ...(candidate.flowShapingBudgetRemainingUSDC !== undefined
      ? { flowShapingBudgetRemainingUSDC: candidate.flowShapingBudgetRemainingUSDC }
      : {}),
    ...(candidate.flowShapingClipBudgetRemaining !== undefined
      ? { flowShapingClipBudgetRemaining: candidate.flowShapingClipBudgetRemaining }
      : {}),
    ...(candidate.campaignFlowCount !== undefined ? { campaignFlowCount: candidate.campaignFlowCount } : {}),
    ...(candidate.campaignFlowTarget !== undefined ? { campaignFlowTarget: candidate.campaignFlowTarget } : {}),
    ...(candidate.postCompletionDebtRepairActive ? { postCompletionDebtRepairActive: true } : {}),
    ...(candidate.addedDebtUSDC !== undefined ? { addedDebtUSDC: candidate.addedDebtUSDC } : {}),
  };
}

function basketTraceFromSeedCandidate(candidate: SingleLegSeedCandidateTrace | undefined): Partial<EntryDecisionTrace> {
  if (!candidate) {
    return {};
  }
  return {
    ...(candidate.marketBasketProjectedEffectivePair !== undefined
      ? { marketBasketProjectedEffectivePair: candidate.marketBasketProjectedEffectivePair }
      : {}),
    ...(candidate.marketBasketProjectedMatchedQty !== undefined
      ? { marketBasketProjectedMatchedQty: candidate.marketBasketProjectedMatchedQty }
      : {}),
    ...(candidate.marketBasketImprovement !== undefined
      ? { marketBasketImprovement: candidate.marketBasketImprovement }
      : {}),
    ...(candidate.marketBasketDebtBeforeUSDC !== undefined
      ? { marketBasketDebtBeforeUSDC: candidate.marketBasketDebtBeforeUSDC }
      : {}),
    ...(candidate.marketBasketDebtAfterUSDC !== undefined
      ? { marketBasketDebtAfterUSDC: candidate.marketBasketDebtAfterUSDC }
      : {}),
    ...(candidate.marketBasketDebtDeltaUSDC !== undefined
      ? { marketBasketDebtDeltaUSDC: candidate.marketBasketDebtDeltaUSDC }
      : {}),
    ...(candidate.continuationClass !== undefined ? { continuationClass: candidate.continuationClass } : {}),
    ...(candidate.campaignClipType !== undefined ? { campaignClipType: candidate.campaignClipType } : {}),
    ...(candidate.avgImprovingBudgetRemainingUSDC !== undefined
      ? { avgImprovingBudgetRemainingUSDC: candidate.avgImprovingBudgetRemainingUSDC }
      : {}),
    ...(candidate.avgImprovingClipBudgetRemaining !== undefined
      ? { avgImprovingClipBudgetRemaining: candidate.avgImprovingClipBudgetRemaining }
      : {}),
    ...(candidate.flowShapingBudgetRemainingUSDC !== undefined
      ? { flowShapingBudgetRemainingUSDC: candidate.flowShapingBudgetRemainingUSDC }
      : {}),
    ...(candidate.flowShapingClipBudgetRemaining !== undefined
      ? { flowShapingClipBudgetRemaining: candidate.flowShapingClipBudgetRemaining }
      : {}),
    ...(candidate.campaignFlowCount !== undefined ? { campaignFlowCount: candidate.campaignFlowCount } : {}),
    ...(candidate.campaignFlowTarget !== undefined ? { campaignFlowTarget: candidate.campaignFlowTarget } : {}),
  };
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
  if (seedPrior?.scope === "exact") {
    return true;
  }
  return false;
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
  if (!config.allowNewCycleWhenFlatOnly || shareGap > xuanFreshCycleFlatDustThreshold(config, state)) {
    return requestedLot;
  }
  const cap = Math.max(config.flatStateSoftPairMaxQty, config.flatStateHardPairMaxQty);
  return Math.max(0, Math.min(requestedLot, cap));
}

interface InitialBasketRecoveryPlan {
  strength: "none" | "weak" | "medium" | "strong";
  score: number;
  initialEffectivePair: number;
  initialDebtUSDC: number;
  qtyCap: number;
  reason: string;
  launchMode: "STRONG_LAUNCH" | "RECOVERABLE_LAUNCH" | "XUAN_PROBE_LAUNCH" | "HARD_SKIP" | "NO_RECOVERY_LAUNCH";
  visibleRecoveryPath: boolean;
  minEffectivePairAcrossTiers?: number | undefined;
  bestDebtReducingQty?: number | undefined;
  bestDebtReducingEffectivePair?: number | undefined;
  recoveryPathReason?: string | undefined;
}

interface LaunchRecoveryScan {
  visibleRecoveryPath: boolean;
  minEffectivePairAcrossTiers?: number | undefined;
  bestDebtReducingQty?: number | undefined;
  bestDebtReducingEffectivePair?: number | undefined;
  reason?: string | undefined;
}

function scanLaunchRecoveryPath(args: {
  config: XuanStrategyConfig;
  books: OrderBookState;
}): LaunchRecoveryScan {
  let minEffectivePairAcrossTiers = Number.POSITIVE_INFINITY;
  let bestDebtReducingQty: number | undefined;
  let bestDebtReducingEffectivePair: number | undefined;

  for (const rawTier of args.config.campaignLaunchVwapTiers) {
    const tier = normalizeOrderSize(rawTier, 1);
    if (tier <= 0) {
      continue;
    }
    const up = args.books.quoteForSize("UP", "ask", tier);
    const down = args.books.quoteForSize("DOWN", "ask", tier);
    if (!up.fullyFilled || !down.fullyFilled) {
      continue;
    }
    const effectivePair = pairCostWithBothTaker(up.averagePrice, down.averagePrice, args.config.cryptoTakerFeeRate);
    if (effectivePair < minEffectivePairAcrossTiers) {
      minEffectivePairAcrossTiers = effectivePair;
    }
    if (
      effectivePair < args.config.highLowDebtReducingEffectiveCap - 1e-9 &&
      (bestDebtReducingEffectivePair === undefined || effectivePair < bestDebtReducingEffectivePair)
    ) {
      bestDebtReducingQty = tier;
      bestDebtReducingEffectivePair = effectivePair;
    }
  }

  if (bestDebtReducingQty !== undefined && bestDebtReducingEffectivePair !== undefined) {
    return {
      visibleRecoveryPath: true,
      minEffectivePairAcrossTiers: normalizeTraceNumber(minEffectivePairAcrossTiers),
      bestDebtReducingQty,
      bestDebtReducingEffectivePair: normalizeTraceNumber(bestDebtReducingEffectivePair),
      reason: "visible_debt_reducing_vwap_tier",
    };
  }

  if (minEffectivePairAcrossTiers <= args.config.campaignLaunchApproachingEffectiveCap + 1e-9) {
    return {
      visibleRecoveryPath: false,
      minEffectivePairAcrossTiers: normalizeTraceNumber(minEffectivePairAcrossTiers),
      reason: "vwap_tier_near_but_not_debt_reducing",
    };
  }

  return {
    visibleRecoveryPath: false,
    ...(Number.isFinite(minEffectivePairAcrossTiers)
      ? { minEffectivePairAcrossTiers: normalizeTraceNumber(minEffectivePairAcrossTiers) }
      : {}),
    reason: "no_visible_recovery_path",
  };
}

function initialBasketRecoveryPlanForBooks(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  books: OrderBookState;
  ctx: EntryLadderContext;
  requestedLot: number;
  rawPair: number;
  effectivePair: number;
  upPrice: number;
  downPrice: number;
}): InitialBasketRecoveryPlan {
  const noCap = normalizeOrderSize(args.requestedLot, args.state.market.minOrderSize);
  const initialDebtUSDC = Math.max(0, args.effectivePair - 1) * Math.max(args.requestedLot, 0);
  if (
    !args.config.initialBasketRecoveryPlanEnabled ||
    args.state.upShares + args.state.downShares > Math.max(args.config.postMergeFlatDustShares, 1e-6)
  ) {
    return {
      strength: "strong",
      score: normalizeTraceNumber(Math.max(0, 1 - args.effectivePair)),
      initialEffectivePair: normalizeTraceNumber(args.effectivePair),
      initialDebtUSDC: normalizeTraceNumber(initialDebtUSDC),
      qtyCap: noCap,
      reason: "initial_basket_soft_or_disabled",
      launchMode: "STRONG_LAUNCH",
      visibleRecoveryPath: true,
    };
  }

  const recoveryScan = scanLaunchRecoveryPath({
    config: args.config,
    books: args.books,
  });
  const highSidePrice = Math.max(args.upPrice, args.downPrice);
  const lowSidePrice = Math.min(args.upPrice, args.downPrice);
  const spread = highSidePrice - lowSidePrice;
  const visibleDebtReducer =
    args.effectivePair <= args.config.highLowDebtReducingEffectiveCap + 1e-9 ||
    recoveryScan.bestDebtReducingQty !== undefined ||
    (spread >= args.config.openingFollowupMinSpread - 1e-9 &&
      highSidePrice >= args.config.openingFollowupHighSideMinPrice - 1e-9 &&
      args.effectivePair <= Math.min(args.config.openingFollowupMaxEffectivePair, args.config.campaignLaunchApproachingEffectiveCap) + 1e-9);
  const upFair = fairValueForOrphanSide(args.ctx.fairValueSnapshot, "UP");
  const downFair = fairValueForOrphanSide(args.ctx.fairValueSnapshot, "DOWN");
  const upEffective = args.upPrice + takerFeePerShare(args.upPrice, args.config.cryptoTakerFeeRate);
  const downEffective = args.downPrice + takerFeePerShare(args.downPrice, args.config.cryptoTakerFeeRate);
  const bestTerminalFairEdge = Math.max(
    upFair !== undefined ? upFair - upEffective : Number.NEGATIVE_INFINITY,
    downFair !== undefined ? downFair - downEffective : Number.NEGATIVE_INFINITY,
  );
  const terminalPairProjection = terminalCarryProjectionForPair({
    config: args.config,
    state: args.state,
    fairValueSnapshot: args.ctx.fairValueSnapshot,
    upQty: args.requestedLot,
    downQty: args.requestedLot,
    upPrice: args.upPrice,
    downPrice: args.downPrice,
    effectivePair: args.effectivePair,
  });
  const strongTerminalEdge =
    bestTerminalFairEdge >= args.config.initialBasketStrongTerminalFairValueEdge - 1e-9 ||
    terminalPairProjection.allowed;
  const mediumTerminalEdge =
    bestTerminalFairEdge >= args.config.initialBasketMediumTerminalFairValueEdge - 1e-9 ||
    (terminalPairProjection.deltaTerminalExpectedPnl ?? 0) >= args.config.terminalCarryMinEvGainUsdc - 1e-9;
  const visibleRecoveryPath = visibleDebtReducer || recoveryScan.visibleRecoveryPath || strongTerminalEdge || mediumTerminalEdge;
  const fairValueStronglyAgainst =
    Number.isFinite(bestTerminalFairEdge) &&
    bestTerminalFairEdge < -args.config.campaignLaunchXuanProbeMaxFairValueDrag + 1e-9;
  const debtPerPair = Math.max(0, args.effectivePair - 1);
  const minProbeDebtUSDC = debtPerPair * args.state.market.minOrderSize;
  const xuanProbeAllowed =
    args.config.xuanBasketCampaignEnabled &&
    args.ctx.secsFromOpen <= args.config.campaignLaunchXuanProbeMaxAgeSec + 1e-9 &&
    args.effectivePair <= args.config.campaignLaunchXuanProbeEffectiveCap + 1e-9 &&
    minProbeDebtUSDC <= args.config.campaignLaunchXuanProbeMaxDebtUsdc + 1e-9 &&
    !fairValueStronglyAgainst;
  const launchMode: InitialBasketRecoveryPlan["launchMode"] =
    args.effectivePair <= args.config.campaignLaunchStrongEffectiveCap + 1e-9
      ? "STRONG_LAUNCH"
      : visibleRecoveryPath && args.effectivePair <= args.config.campaignLaunchRecoverableEffectiveCap + 1e-9
        ? "RECOVERABLE_LAUNCH"
        : strongTerminalEdge
          ? "RECOVERABLE_LAUNCH"
          : xuanProbeAllowed
            ? "XUAN_PROBE_LAUNCH"
            : "HARD_SKIP";

  let strength: InitialBasketRecoveryPlan["strength"] = "none";
  let reason = "no_visible_recovery_plan";
  if (args.effectivePair <= args.config.campaignLaunchStrongEffectiveCap + 1e-9 || visibleDebtReducer || strongTerminalEdge) {
    strength = "strong";
    reason =
      args.effectivePair <= args.config.campaignLaunchStrongEffectiveCap + 1e-9
        ? "strong_initial_basket"
        : visibleDebtReducer
          ? recoveryScan.reason ?? "visible_debt_reducer"
          : "strong_terminal_fair_value_edge";
  } else if (visibleRecoveryPath && mediumTerminalEdge) {
    strength = "medium";
    reason = "medium_terminal_fair_value_edge";
  } else if (
    visibleRecoveryPath &&
    args.effectivePair <= args.config.campaignLaunchRecoverableEffectiveCap + 1e-9
  ) {
    strength = "weak";
    reason = recoveryScan.reason ?? "recoverable_launch_recovery_path";
  } else if (xuanProbeAllowed) {
    reason = "xuan_probe_launch_no_visible_recovery_path";
  }

  const score = normalizeTraceNumber(
    (visibleDebtReducer ? 1 : 0) +
      (recoveryScan.visibleRecoveryPath ? 0.5 : 0) +
      Math.max(0, Number.isFinite(bestTerminalFairEdge) ? bestTerminalFairEdge : 0) * 10 +
      Math.max(0, terminalPairProjection.deltaTerminalExpectedPnl ?? 0) / Math.max(args.requestedLot, 1),
  );
  const diagnosticQty = normalizeOrderSize(
    Math.min(args.requestedLot, args.config.initialBasketHardDebtNoPlanMaxQty, args.config.campaignLaunchDiagnosticQty),
    args.state.market.minOrderSize,
  );
  const xuanProbeDebtQty =
    debtPerPair > 0 ? args.config.campaignLaunchXuanProbeMaxDebtUsdc / debtPerPair : args.requestedLot;
  const xuanProbeQty = normalizeOrderSize(
    Math.max(
      args.state.market.minOrderSize,
      Math.min(args.requestedLot, args.requestedLot * args.config.campaignLaunchXuanProbePct, xuanProbeDebtQty),
    ),
    args.state.market.minOrderSize,
  );
  const qtyCap =
    strength === "strong"
      ? noCap
      : strength === "medium"
        ? normalizeOrderSize(args.requestedLot * args.config.initialBasketMediumRecoveryQtyMultiplier, args.state.market.minOrderSize)
        : strength === "weak"
          ? normalizeOrderSize(args.requestedLot * args.config.initialBasketWeakRecoveryQtyMultiplier, args.state.market.minOrderSize)
          : launchMode === "XUAN_PROBE_LAUNCH"
            ? xuanProbeQty
            : Math.max(args.state.market.minOrderSize, diagnosticQty);

  return {
    strength,
    score,
    initialEffectivePair: normalizeTraceNumber(args.effectivePair),
    initialDebtUSDC: normalizeTraceNumber(initialDebtUSDC),
    qtyCap,
    reason,
    launchMode,
    visibleRecoveryPath,
    ...(recoveryScan.minEffectivePairAcrossTiers !== undefined
      ? { minEffectivePairAcrossTiers: recoveryScan.minEffectivePairAcrossTiers }
      : {}),
    ...(recoveryScan.bestDebtReducingQty !== undefined ? { bestDebtReducingQty: recoveryScan.bestDebtReducingQty } : {}),
    ...(recoveryScan.bestDebtReducingEffectivePair !== undefined
      ? { bestDebtReducingEffectivePair: recoveryScan.bestDebtReducingEffectivePair }
      : {}),
    ...(recoveryScan.reason ? { recoveryPathReason: recoveryScan.reason } : {}),
  };
}

function freshCycleRequestedLotCapForBooks(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
  referencePriorActive: boolean,
): { lot: number; recoveryPlan?: InitialBasketRecoveryPlan | undefined } {
  const requestedLot = ctx.lot;
  const baseCap = freshCycleRequestedLotCap(config, state, requestedLot, referencePriorActive);
  if (!config.marketBasketScoringEnabled || referencePriorActive || baseCap >= requestedLot - 1e-9) {
    return { lot: baseCap };
  }
  const basketState = marketBasketStateTrace(config, state);
  if (basketState.campaignActive) {
    return { lot: requestedLot };
  }
  if (
    config.marketBasketContinuationEnabled &&
    mergeableShares(state) >= config.marketBasketContinuationMinMatchedShares - 1e-9
  ) {
    return { lot: requestedLot };
  }
  const probeSize = normalizeOrderSize(state.market.minOrderSize, state.market.minOrderSize);
  const upProbe = books.quoteForSize("UP", "ask", probeSize);
  const downProbe = books.quoteForSize("DOWN", "ask", probeSize);
  if (!upProbe.fullyFilled || !downProbe.fullyFilled) {
    return { lot: baseCap };
  }
  const rawPair = upProbe.averagePrice + downProbe.averagePrice;
  const effectivePair = pairCostWithBothTaker(upProbe.averagePrice, downProbe.averagePrice, config.cryptoTakerFeeRate);
  if (
    config.marketBasketBootstrapEnabled &&
    state.upShares + state.downShares <= Math.max(config.postMergeFlatDustShares, 1e-6) &&
    effectivePair <= config.marketBasketBootstrapMaxEffectivePair + 1e-9
  ) {
    const recoveryPlan = initialBasketRecoveryPlanForBooks({
      config,
      state,
      books,
      ctx,
      requestedLot,
      rawPair,
      effectivePair,
      upPrice: upProbe.averagePrice,
      downPrice: downProbe.averagePrice,
    });
    return { lot: Math.min(requestedLot, recoveryPlan.qtyCap), recoveryPlan };
  }
  const lot = isStrongMarketBasketPair(config, rawPair, effectivePair) ? requestedLot : baseCap;
  return { lot };
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
  const nowTs = state.market.startTs + ctx.secsFromOpen;
  const matchedQty = mergeableShares(state);
  const currentBasketEffectivePair = matchedEffectivePairCost(state, config.cryptoTakerFeeRate);
  const basketState = marketBasketStateTrace(config, state);
  const basketContinuationReady =
    config.marketBasketContinuationEnabled &&
    basketState.needsContinuation &&
    (matchedQty >= config.marketBasketContinuationMinMatchedShares - 1e-9 || basketState.campaignActive) &&
    Number.isFinite(currentBasketEffectivePair) &&
    (basketState.balancedButDebted
      ? ctx.secsToClose > config.finalWindowCompletionOnlySec
      : basketState.campaignActive
        ? ctx.secsToClose > config.finalWindowCompletionOnlySec
      : ctx.secsToClose > config.xuanMinTimeLeftForHardSweep);
  const aggressivePublicFootprint =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE";
  const aggressiveSeedPrior =
    aggressivePublicFootprint ? resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen) : undefined;
  const aggressiveSequencePriorActive = aggressiveSeedPrior !== undefined;
  const dustFlatAfterRecycle =
    state.upShares + state.downShares <=
    Math.max(config.postMergeFlatDustShares * 2, state.market.minOrderSize * 0.01, 0.05);
  const aggressiveFamilyCycleReleaseActive =
    aggressivePublicFootprint &&
    ctx.secsToClose > config.finalWindowNoChaseSec &&
    (
      aggressiveSeedPrior?.scope === "family" ||
      dustFlatAfterRecycle ||
      (ctx.secsFromOpen >= 150 && matchedQty >= Math.max(state.market.minOrderSize, config.completionMinQty) - 1e-9)
    );
  if (
    !aggressiveSequencePriorActive &&
    !aggressiveFamilyCycleReleaseActive &&
    config.forbidFlatBadCycleSpam &&
    config.badCycleMode === "COMPLETION_ONLY" &&
    stats.recentBadCycleCount >= config.maxConsecutiveBadCycles &&
    stats.lastBadCycle &&
    nowTs - stats.lastBadCycle.closedAt <= config.badCycleCooldownSec
  ) {
    return "bad_cycle_completion_only";
  }
  if (basketContinuationReady) {
    return undefined;
  }
  const aggressiveLateFreshSeedAllowed =
    aggressivePublicFootprint &&
    (dustFlatAfterRecycle || aggressiveFamilyCycleReleaseActive) &&
    ctx.secsFromOpen <= Math.max(config.freshSeedHardCutoffSec, 285) + 1e-9 &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec;
  if (
    !referencePriorActive &&
    config.freshSeedHardCutoffSec > 0 &&
    ctx.secsFromOpen > config.freshSeedHardCutoffSec + 1e-9 &&
    !aggressiveLateFreshSeedAllowed &&
    !aggressiveSequencePriorActive
  ) {
    return "late_fresh_seed_cutoff";
  }
  if (
    !aggressiveSequencePriorActive &&
    !aggressiveFamilyCycleReleaseActive &&
    config.requireReevaluationAfterEachCycle &&
    stats.lastCycle &&
    nowTs - stats.lastCycle.closedAt < config.minSecondsBetweenNewCycles
  ) {
    return "new_cycle_reevaluation_cooldown";
  }
  if (
    !aggressiveSequencePriorActive &&
    !aggressiveFamilyCycleReleaseActive &&
    config.maxNewCyclesPer30Sec > 0 &&
    stats.closedCycles.filter((cycle) => nowTs - cycle.closedAt <= 30).length >= config.maxNewCyclesPer30Sec
  ) {
    return "new_cycle_30s_cap";
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
  const aggressiveFamilyPriorActive =
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE" &&
    state.fillHistory.some((fill) => fill.side === "BUY") &&
    candidateContext !== undefined &&
    resolveBundledSeedSequencePrior(state.market.slug, candidateContext.ctx.secsFromOpen)?.scope === "family";
  if (aggressiveFamilyPriorActive) {
    return undefined;
  }
  const shareGap = Math.abs(state.upShares - state.downShares);
  if (!config.allowNewCycleWhenFlatOnly || shareGap > xuanFreshCycleFlatDustThreshold(config, state)) {
    return undefined;
  }
  if (marketBasketBootstrapCandidateAllowed(config, state, candidateContext)) {
    return undefined;
  }
  if (marketBasketContinuationAllowed(config, state, candidateContext)) {
    return undefined;
  }
  const samePatternSkipReason = borderlineSamePatternSkipReason(config, state, stats, candidateContext, quality);
  if (samePatternSkipReason) {
    return samePatternSkipReason;
  }
  const openingWeakPairSkip = openingWeakPairSkipReason(config, state, candidateContext, quality);
  if (openingWeakPairSkip) {
    return openingWeakPairSkip;
  }
  const earlyMidPairRepeatFeeGuard = earlyMidPairRepeatFeeGuardSkipReason(config, state, stats, candidateContext, quality);
  if (earlyMidPairRepeatFeeGuard) {
    return earlyMidPairRepeatFeeGuard;
  }
  if (cycleQualityAllowedForFresh(config, quality, stats)) {
    return undefined;
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
  const currentBasketState = marketBasketStateTrace(config, state);
  const sequencePriorDustRecycleActive =
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE" &&
    state.fillHistory.some((fill) => fill.side === "BUY") &&
    resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen) !== undefined;
  const useBalancedPairPath =
    shareGap === 0 ||
    currentBasketState.balancedButDebted ||
    (sequencePriorDustRecycleActive && shareGap <= xuanFreshCycleFlatDustThreshold(config, state));

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

  if (
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE" &&
    totalShares <= Math.max(config.postMergeFlatDustShares, 1e-6) &&
    ctx.secsFromOpen < Math.max(4, config.enterFromOpenSecMin) - 1e-9
  ) {
    return {
      decisions: [],
      trace: {
        mode: "balanced_pair",
        requestedLot: ctx.lot,
        totalShares,
        shareGap,
        pairCap,
        skipReason: "xuan_open_wait",
        recentBadCycleCount: freshCycleStats.recentBadCycleCount,
        candidates: [],
      },
    };
  }

  if (useBalancedPairPath) {
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
          ...basketTraceFields(config, state),
          recentBadCycleCount: freshCycleStats.recentBadCycleCount,
          ...(freshCycleStats.lastCycle ? { lastCycleNet: freshCycleStats.lastCycle.expectedNetIfMerged } : {}),
          ...(freshCycleStats.lastCycle ? { lastCycleClosedAt: freshCycleStats.lastCycle.closedAt } : {}),
          candidates: [],
        },
      };
    }
    const freshLotResolution = freshCycleRequestedLotCapForBooks(config, state, books, ctx, referencePriorActive);
    const freshRequestedLot = freshLotResolution.lot;
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
      { stats: freshCycleStats, referencePriorActive, ctx: freshCtx },
    );
    const trace: EntryDecisionTrace = {
      mode: "balanced_pair",
      requestedLot: ctx.lot,
      totalShares,
      shareGap,
      pairCap,
      freshCycleRequestedLotCap: freshRequestedLot,
      ...(freshLotResolution.recoveryPlan
        ? {
            initialBasketRecoveryPlan: freshLotResolution.recoveryPlan.strength,
            initialBasketRecoveryScore: freshLotResolution.recoveryPlan.score,
            initialBasketEffectivePair: freshLotResolution.recoveryPlan.initialEffectivePair,
            initialBasketDebtUSDC: freshLotResolution.recoveryPlan.initialDebtUSDC,
            initialBasketQtyCap: freshLotResolution.recoveryPlan.qtyCap,
            initialBasketRecoveryReason: freshLotResolution.recoveryPlan.reason,
            campaignLaunchMode: freshLotResolution.recoveryPlan.launchMode,
            visibleRecoveryPath: freshLotResolution.recoveryPlan.visibleRecoveryPath,
            ...(freshLotResolution.recoveryPlan.minEffectivePairAcrossTiers !== undefined
              ? { minEffectivePairAcrossTiers: freshLotResolution.recoveryPlan.minEffectivePairAcrossTiers }
              : {}),
            ...(freshLotResolution.recoveryPlan.bestDebtReducingQty !== undefined
              ? { bestDebtReducingQty: freshLotResolution.recoveryPlan.bestDebtReducingQty }
              : {}),
            ...(freshLotResolution.recoveryPlan.bestDebtReducingEffectivePair !== undefined
              ? { bestDebtReducingEffectivePair: freshLotResolution.recoveryPlan.bestDebtReducingEffectivePair }
              : {}),
            ...(freshLotResolution.recoveryPlan.recoveryPathReason
              ? { recoveryPathReason: freshLotResolution.recoveryPlan.recoveryPathReason }
              : {}),
            ...(freshLotResolution.recoveryPlan.launchMode === "HARD_SKIP" ||
            freshLotResolution.recoveryPlan.launchMode === "NO_RECOVERY_LAUNCH"
              ? {
                  campaignMode: "WATCH_FOR_DEBT_REDUCER" as const,
                  campaignBaseLot: ctx.lot,
                }
              : freshLotResolution.recoveryPlan.launchMode === "XUAN_PROBE_LAUNCH"
                ? {
                    campaignMode: "BASKET_CAMPAIGN_ACTIVE" as const,
                    campaignBaseLot: ctx.lot,
                    executedProbeQty: freshRequestedLot,
                  }
              : freshRequestedLot < ctx.lot - 1e-9
              ? {
                  campaignMode: "PROBE_OPENED" as const,
                  campaignBaseLot: ctx.lot,
                  executedProbeQty: freshRequestedLot,
                }
              : {}),
          }
        : {}),
      stateBefore: inventoryTraceState(state),
      ...basketTraceFields(config, state),
      recentBadCycleCount: freshCycleStats.recentBadCycleCount,
      ...(freshCycleStats.lastCycle ? { lastCycleNet: freshCycleStats.lastCycle.expectedNetIfMerged } : {}),
      ...(freshCycleStats.lastCycle ? { lastCycleClosedAt: freshCycleStats.lastCycle.closedAt } : {}),
      ...(inspected.bestRawPair !== undefined ? { bestRawPair: inspected.bestRawPair } : {}),
      ...(inspected.bestEffectivePair !== undefined ? { bestEffectivePair: inspected.bestEffectivePair } : {}),
      ...(currentBasketState.campaignState === "BALANCED_DEBT_CAMPAIGN" ? { balancedDebtCampaignTicks: 1 } : {}),
      xuanFlowCount: xuanFlowCount(state),
      mergeQtyOverBaseLot: normalizeTraceNumber(mergeableShares(state) / Math.max(ctx.lot, 1e-9)),
      ...traceRepairCounters(inspected.traces),
      candidates: inspected.traces,
    };

    if (
      (freshLotResolution.recoveryPlan?.launchMode === "HARD_SKIP" ||
        freshLotResolution.recoveryPlan?.launchMode === "NO_RECOVERY_LAUNCH") &&
      !freshLotResolution.recoveryPlan.visibleRecoveryPath
    ) {
      return {
        decisions: [],
        trace: {
          ...trace,
          skipReason: "watch_for_debt_reducer",
          cycleSkippedReason: freshLotResolution.recoveryPlan.recoveryPathReason ?? "no_visible_recovery_path",
        },
      };
    }

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
    const stagedDebtReducingFlow =
      inspected.bestCandidate !== undefined
        ? buildStagedDebtReducingFlowSeed({
            config,
            state,
            ctx,
            basketState: currentBasketState,
            candidate: inspected.bestCandidate,
          })
        : undefined;

    const stagedDebtReducingCandidate = inspected.bestCandidate;
    if (stagedDebtReducingFlow && stagedDebtReducingCandidate) {
      return {
        decisions: [stagedDebtReducingFlow.decision],
        trace: {
          ...trace,
          mode: "temporal_pair_cycle",
          selectedMode: stagedDebtReducingFlow.decision.mode,
          rawPair: stagedDebtReducingCandidate.rawPairCost,
          effectivePair: stagedDebtReducingCandidate.pairCost,
          feeUSDC: stagedDebtReducingCandidate.feeUSDC,
          expectedNetIfMerged: stagedDebtReducingCandidate.expectedNetIfMerged,
          ...basketTraceFromCandidate(stagedDebtReducingCandidate),
          stagedEntry: true,
          stagedDebtReducingFlow: true,
          plannedOppositeSide: stagedDebtReducingFlow.plannedOppositeSide,
          plannedOppositeQty: stagedDebtReducingFlow.plannedOppositeQty,
          cycleQualityLabel: stagedDebtReducingCandidate.cycleQualityLabel,
          cycleOpenedReason: "temporal_single_leg_seed",
          stateAfter: projectedStateAfterCycleBuys(
            state,
            stagedDebtReducingFlow.decision.side === "UP" ? stagedDebtReducingFlow.decision.size : 0,
            stagedDebtReducingFlow.decision.side === "DOWN" ? stagedDebtReducingFlow.decision.size : 0,
            stagedDebtReducingFlow.decision.side === "UP" ? stagedDebtReducingFlow.decision.expectedAveragePrice : 0,
            stagedDebtReducingFlow.decision.side === "DOWN" ? stagedDebtReducingFlow.decision.expectedAveragePrice : 0,
          ),
          candidates: inspected.traces,
          childOrderIntendedSide: stagedDebtReducingFlow.decision.side,
          childOrderSelectedSide: stagedDebtReducingFlow.decision.side,
          childOrderReason: "staged_debt_reducing_flow",
          semanticRoleTarget: "high_low_setup",
          skipReason: "staged_debt_reducing_flow",
        },
      };
    }

    if (inspected.bestCandidate && !preferTemporalCloneCycle) {
      const pairPlan = buildBalancedPairEntryPlan(
        config,
        state,
        ctx.secsFromOpen,
        ctx.childOrderMicroTimingBias,
        ctx.semanticRoleAlignmentBias,
        inspected.bestCandidate,
        config.cryptoTakerFeeRate,
        totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
      );
      return {
        decisions: pairPlan.decisions,
        trace: {
          ...trace,
          selectedMode: inspected.bestCandidate.mode,
          rawPair: inspected.bestCandidate.rawPairCost,
          effectivePair: inspected.bestCandidate.pairCost,
          feeUSDC: inspected.bestCandidate.feeUSDC,
          expectedNetIfMerged: inspected.bestCandidate.expectedNetIfMerged,
          ...basketTraceFromCandidate(inspected.bestCandidate),
          cycleQualityLabel: inspected.bestCandidate.cycleQualityLabel,
          cycleOpenedReason: totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
          stateAfter: pairPlan.stateAfter,
          ...pairPlan.tracePatch,
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
          ...basketTraceFromSeedCandidate(selectedSeedTrace),
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
      const pairPlan = buildBalancedPairEntryPlan(
        config,
        state,
        ctx.secsFromOpen,
        ctx.childOrderMicroTimingBias,
        ctx.semanticRoleAlignmentBias,
        inspected.bestCandidate,
        config.cryptoTakerFeeRate,
        totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
      );
      return {
        decisions: pairPlan.decisions,
        trace: {
          ...trace,
          selectedMode: inspected.bestCandidate.mode,
          rawPair: inspected.bestCandidate.rawPairCost,
          effectivePair: inspected.bestCandidate.pairCost,
          feeUSDC: inspected.bestCandidate.feeUSDC,
          expectedNetIfMerged: inspected.bestCandidate.expectedNetIfMerged,
          ...basketTraceFromCandidate(inspected.bestCandidate),
          cycleQualityLabel: inspected.bestCandidate.cycleQualityLabel,
          cycleOpenedReason: totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
          stateAfter: pairPlan.stateAfter,
          ...pairPlan.tracePatch,
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
          ...basketTraceFromSeedCandidate(selectedSeedTrace),
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

    const marketBasketContinuationCycleSkippedReason =
      [...seedEvaluation.trace, ...temporalSeedEvaluation.trace, ...inspected.traces].find((trace) => {
        const reason = trace.cycleSkippedReason;
        return (
          reason === "avg_improving_pair_too_expensive" ||
          reason === "avg_improving_spread_too_small" ||
          reason === "avg_improving_clip_budget_exhausted" ||
          reason === "avg_improving_budget_exhausted" ||
          reason === "avg_improving_qty_cap" ||
          reason === "debt_reducing_qty_cap" ||
          reason === "high_low_effective_not_debt_reducing" ||
          reason === "projected_basket_too_expensive" ||
          reason === "continuation_not_debt_reducing_or_avg_improving" ||
          reason === "market_basket_continuation_rejected"
        );
      })?.cycleSkippedReason;
    const cycleSkippedReason =
      marketBasketContinuationCycleSkippedReason ??
      seedEvaluation.trace.find((seedTrace) => seedTrace.cycleSkippedReason === "low_side_unpaired_basket_debt")
        ?.cycleSkippedReason ??
      seedEvaluation.trace.find((seedTrace) => seedTrace.cycleSkippedReason === "xuan_micro_covered_seed_fallback")
        ?.cycleSkippedReason ??
      temporalSeedEvaluation.trace.find((seedTrace) => seedTrace.cycleSkippedReason)?.cycleSkippedReason ??
      seedEvaluation.trace.find((seedTrace) => seedTrace.cycleSkippedReason)?.cycleSkippedReason ??
      inspected.traces.find((candidateTrace) => candidateTrace.cycleSkippedReason)?.cycleSkippedReason;
    const pairSkipReason = determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces);

    return {
      decisions: [],
      trace: {
        ...trace,
        seedCandidates: [...temporalSeedEvaluation.trace, ...seedEvaluation.trace],
        skipReason:
          temporalSeedEvaluation.trace.length > 0 || seedEvaluation.trace.length > 0
            ? pairSkipReason === "high_low_effective_not_debt_reducing"
              ? pairSkipReason
              : `${pairSkipReason}+single_leg_seed`
            : pairSkipReason,
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
  const campaignResidualFlowActive =
    currentBasketState.campaignActive &&
    isUnbalancedCampaignResidual(config, state, shareGap) &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec;
  const allowCampaignPairContinuation =
    campaignResidualFlowActive &&
    config.marketBasketContinuationEnabled &&
    config.xuanBasketCampaignEnabled;
  const completionQtyPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledCompletionSequencePrior(state.market.slug, ctx.secsFromOpen, laggingSide)
      : undefined;
  const exactCompletionQtyPrior = completionQtyPrior?.scope === "exact" ? completionQtyPrior : undefined;
  const aggressivePublicFootprint =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE";
  const activeCompletionQtyPrior = aggressivePublicFootprint
    ? completionQtyPrior
    : exactCompletionQtyPrior;
  const completionPriorForcesRepair =
    activeCompletionQtyPrior !== undefined &&
    activeCompletionQtyPrior.phase === "HIGH_LOW_COMPLETION" &&
    ctx.secsToClose > config.finalWindowNoChaseSec;
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
  const overlapInspection = allowOverlapPath || allowCampaignPairContinuation
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
  const buildOverlapPairReentry = (): EntryEvaluation | undefined => {
    if (!overlapInspection?.bestCandidate) {
      return undefined;
    }
    const pairPlan = buildBalancedPairEntryPlan(
      config,
      state,
      ctx.secsFromOpen,
      ctx.childOrderMicroTimingBias,
      ctx.semanticRoleAlignmentBias,
      overlapInspection.bestCandidate,
      config.cryptoTakerFeeRate,
      "balanced_pair_reentry",
    );
    return {
      decisions: pairPlan.decisions,
      trace: {
        mode: "balanced_pair",
        requestedLot: ctx.lot,
        totalShares,
        shareGap,
        pairCap,
        selectedMode: overlapInspection.bestCandidate.mode,
        ...pairPlan.tracePatch,
        laggingSide,
        residualSeverityLevel: residualSeverity.level,
        overlapRepairArbitration,
        overlapRepairReason,
        overlapRepairOutcome: "pair_reentry",
        ...(overlapInspection.bestRawPair !== undefined ? { bestRawPair: overlapInspection.bestRawPair } : {}),
        ...(overlapInspection.bestEffectivePair !== undefined
          ? { bestEffectivePair: overlapInspection.bestEffectivePair }
          : {}),
        ...basketTraceFromCandidate(overlapInspection.bestCandidate),
        candidates: overlapInspection.traces,
        skipReason: "controlled_overlap_pair",
      },
    };
  };
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

  if (favorIndependentOverlapFlow && !completionPriorForcesRepair) {
    const overlapSeedEvaluation = buildOverlapTemporalSeedEvaluation();
    if (overlapSeedEvaluation) {
      return overlapSeedEvaluation;
    }

    const pairReentry = buildOverlapPairReentry();
    if (pairReentry) {
      return pairReentry;
    }
  }

  if (allowOverlapPath && !preferCloneResidualRepair && !favorIndependentOverlapFlow && !completionPriorForcesRepair) {
    const pairReentry = buildOverlapPairReentry();
    if (pairReentry) {
      return pairReentry;
    }

    const overlapSeedEvaluation = buildOverlapTemporalSeedEvaluation();
    if (overlapSeedEvaluation) {
      return overlapSeedEvaluation;
    }
  }

  if (allowCampaignPairContinuation && !completionPriorForcesRepair) {
    const pairReentry = buildOverlapPairReentry();
    if (pairReentry) {
      return {
        decisions: pairReentry.decisions,
        trace: {
          ...pairReentry.trace,
          campaignMode: "ACCUMULATING_CONTINUATION",
          overlapRepairReason: "campaign_residual_pair_continuation",
          overlapRepairOutcome: "pair_reentry",
          skipReason: "campaign_residual_pair_continuation",
        },
      };
    }
  }
  const highLowRepairOvershootQty = buildHighLowRepairOvershootQty({
    config,
    sideToBuy: laggingSide,
    books,
    existingAverage: averageCost(state, leadingSide),
    shareGap,
    exactPriorActive: Boolean(activeCompletionQtyPrior),
  });
  const repairLotCap =
    highLowRepairOvershootQty !== undefined
      ? Math.max(ctx.lot * config.rebalanceMaxLaggingMultiplier, highLowRepairOvershootQty)
      : ctx.lot * config.rebalanceMaxLaggingMultiplier;
  const repairRequestedQty = Math.min(
    Math.max(activeCompletionQtyPrior?.qty ?? Math.max(ctx.lot, shareGap), highLowRepairOvershootQty ?? 0),
    repairLotCap,
    Math.max(0, config.maxMarketSharesPerSide - (laggingSide === "UP" ? state.upShares : state.downShares)),
    Math.max(0, config.maxOneSidedExposureShares),
  );
  const repairQtyCap =
    config.completionQtyMode === "ALLOW_OVERSHOOT"
      ? shareGap + config.maxCompletionOvershootShares
      : shareGap;
  const nowTs = state.market.endTs - ctx.secsToClose;
  const unbalancedCampaignResidual = isUnbalancedCampaignResidual(config, state, shareGap);
  const orphanCompletionDutyActive = unbalancedCampaignResidual && mergeableShares(state) < config.xuanBasketCampaignMinMatchedShares - 1e-9;
  const currentMatchedEffectiveForHedge =
    mergeableShares(state) > 1e-6 ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate) : Number.POSITIVE_INFINITY;
  const aggressiveResidualDutyReleaseActive =
    aggressivePublicFootprint &&
    ctx.secsToClose > config.finalWindowNoChaseSec &&
    (
      activeCompletionQtyPrior?.phase === "HIGH_LOW_COMPLETION" ||
      unbalancedCampaignResidual ||
      (ctx.secsFromOpen >= 250 && shareGap >= config.completionMinQty - 1e-9)
    );
  const debtPositiveCampaignHedgeQtyCap =
    unbalancedCampaignResidual &&
    !activeCompletionQtyPrior &&
    !aggressiveResidualDutyReleaseActive &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec &&
    currentMatchedEffectiveForHedge > config.fullRebalanceOnlyIfEffectivePairBelow + 1e-9
      ? Math.max(
          0,
          (leadingSide === "UP" ? state.upShares : state.downShares) * config.initialDebtyCampaignMaxHedgeRatio -
            (laggingSide === "UP" ? state.upShares : state.downShares),
        )
      : Number.POSITIVE_INFINITY;
  const repairEffectiveQtyCap = activeCompletionQtyPrior
    ? Math.max(repairQtyCap, activeCompletionQtyPrior.qty)
    : highLowRepairOvershootQty !== undefined
      ? Math.max(repairQtyCap, highLowRepairOvershootQty)
      : aggressiveResidualDutyReleaseActive
        ? repairQtyCap
      : Math.min(repairQtyCap, debtPositiveCampaignHedgeQtyCap);
  const repairSize = normalizeOrderSize(
    Math.min(repairRequestedQty, repairEffectiveQtyCap),
    config.repairMinQty,
  );
  const campaignCompletionSizing =
    unbalancedCampaignResidual && !activeCompletionQtyPrior
      ? resolveCampaignCompletionSizing(config, shareGap)
      : undefined;
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
    ...(campaignCompletionSizing
      ? {
          campaignClipType: campaignCompletionSizing.clipType,
          campaignMinClipQty: campaignCompletionSizing.minCampaignClipQty,
          campaignDefaultClipQty: campaignCompletionSizing.defaultCampaignClipQty,
          microRepairMaxQty: config.microRepairMaxQty,
        }
      : {}),
        ...(unbalancedCampaignResidual
          ? {
              campaignMode: "UNBALANCED_CAMPAIGN_RESIDUAL",
              campaignBaseLot: config.liveSmallLotLadder[0] ?? config.defaultLot,
              marketBasketMergeableQty: normalizeTraceNumber(mergeableShares(state)),
              ...(aggressiveResidualDutyReleaseActive ? { aggressiveResidualDutyReleaseActive: true } : {}),
              ...(orphanCompletionDutyActive ? { orphanCompletionDutyActive: true } : {}),
          ...(oneSidedCampaignSeedAgeSec(state, leadingSide, nowTs) !== undefined
            ? { oneSidedSeedUnrepairedTicks: normalizeTraceNumber(oneSidedCampaignSeedAgeSec(state, leadingSide, nowTs) ?? 0) }
            : {}),
          ...(hasStagedLowSideOpenedButOppositeMissing(state, leadingSide, shareGap)
            ? { stagedLowSideOpenedButOppositeMissing: true }
            : {}),
        }
      : {}),
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

  if (repairSize <= 0) {
    return {
      decisions: [],
      trace: {
        ...trace,
        skipReason: shareGap < config.repairMinQty ? "repair_size_zero" : "repair_qty_cap",
      },
    };
  }

  const residualTimestamp = oldestResidualLotTimestamp(state, leadingSide);
  const partialAgeSec =
    residualTimestamp !== undefined ? Math.max(0, nowTs - residualTimestamp) : config.partialSoftWindowSec;
  const plannedOpposite = plannedOppositeCompletionState(state, nowTs, Math.max(config.postMergeFlatDustShares, 1e-6));
  const plannedOppositeMaterialQty = Math.max(
    config.controlledOverlapMinResidualShares,
    config.microRepairMaxQty + state.market.minOrderSize,
  );
  const plannedOppositeTimingReady =
    plannedOpposite === undefined ||
    !isAggressivePublicFootprint(config) ||
    exactCompletionQtyPrior !== undefined ||
    plannedOpposite.plannedOppositeAgeSec >= plannedOppositeMinWaitSec(config) - 1e-9 ||
    ctx.secsToClose <= config.finalWindowCompletionOnlySec;
  const plannedOppositeDutyActive =
    plannedOpposite !== undefined &&
    plannedOpposite.plannedOppositeSide === laggingSide &&
    plannedOpposite.plannedOppositeMissingQty >= plannedOppositeMaterialQty - 1e-9 &&
    (plannedOpposite.plannedLowSideAvg <= config.lowSideMaxForHighCompletion + 1e-9 ||
      exactCompletionQtyPrior !== undefined) &&
    plannedOppositeTimingReady;
  const stagedResidualAgeSec = borderlineStagedResidualAgeSec(state, leadingSide, nowTs);
  if (
    config.borderlinePairStagedEntryEnabled &&
    stagedResidualAgeSec !== undefined &&
    stagedResidualAgeSec < config.borderlinePairReevaluateAfterSec &&
    !plannedOppositeDutyActive &&
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
    activeCompletionQtyPrior && Number.isFinite(phase.maxQty)
      ? Math.max(phase.maxQty, activeCompletionQtyPrior.qty)
      : highLowRepairOvershootQty !== undefined && Number.isFinite(phase.maxQty)
        ? Math.max(phase.maxQty, highLowRepairOvershootQty)
      : phase.maxQty;
  const campaignPhaseMaxQty =
    unbalancedCampaignResidual &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec &&
    !activeCompletionQtyPrior
      ? Math.max(
          Number.isFinite(phaseMaxQty) ? phaseMaxQty : repairSize,
          campaignCompletionSizing?.targetQty ?? repairSize,
        )
      : phaseMaxQty;
  const phasedRepairSize = normalizeOrderSize(
    Math.min(repairSize, Number.isFinite(campaignPhaseMaxQty) ? campaignPhaseMaxQty : repairSize),
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
    exactPriorActive: Boolean(activeCompletionQtyPrior),
    overlapRepairArbitration,
  });
  const residualAwareRepairSize = normalizeOrderSize(
    Math.max(config.repairMinQty, phasedRepairSize - residualCarryQty),
    config.repairMinQty,
  );
  const effectiveRepairSize =
    residualCarryQty > 0 && residualAwareRepairSize > 0 ? Math.min(phasedRepairSize, residualAwareRepairSize) : phasedRepairSize;
  const baseRepairCandidateSizes = buildResidualRepairCandidateSizes({
    config,
    standardSize: effectiveRepairSize,
    shareGap,
    exactPriorActive: Boolean(activeCompletionQtyPrior),
    campaignCompletionSizing,
  });
  const plannedOppositeQty =
    plannedOppositeDutyActive && plannedOpposite
      ? normalizeOrderSize(
          Math.min(plannedOpposite.plannedOppositeMissingQty, shareGap, config.marketBasketContinuationMaxQty),
          config.repairMinQty,
        )
      : 0;
  const repairCandidateSizes =
    plannedOppositeQty > 0 && !baseRepairCandidateSizes.some((size) => Math.abs(size - plannedOppositeQty) <= 1e-6)
      ? [plannedOppositeQty, ...baseRepairCandidateSizes]
      : baseRepairCandidateSizes;
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
    const finalResidualDutyActive =
      ctx.secsFromOpen >= 250 &&
      oldGap >= Math.max(state.market.minOrderSize, config.repairMinQty) - 1e-9;
    const xuanFamilyResidualDutyActive =
      aggressivePublicFootprint &&
      ctx.secsToClose > config.finalWindowNoChaseSec &&
      (
        activeCompletionQtyPrior?.phase === "HIGH_LOW_COMPLETION" ||
        plannedOppositeDutyActive ||
        unbalancedCampaignResidual ||
        finalResidualDutyActive
      );
    const xuanResidualDutyMaxQty = Math.max(
      oldGap + config.maxCompletionOvershootShares,
      activeCompletionQtyPrior?.qty ?? 0,
      plannedOppositeDutyActive && plannedOpposite ? plannedOpposite.plannedOppositeMissingQty : 0,
      xuanFamilyResidualDutyActive ? Math.min(config.xuanBasketCampaignCompletionClipMaxQty, oldGap * 1.15) : 0,
    );
    const xuanRoleSequenceOvershootAllowed =
      xuanFamilyResidualDutyActive &&
      executableSize <= xuanResidualDutyMaxQty + 1e-9 &&
      newGap <= config.maxOneSidedExposureShares + 1e-9;
    if (
      (config.forbidBuyThatIncreasesImbalance || config.partialCompletionRequiresImbalanceReduction) &&
      wouldIncreaseImbalance &&
      !xuanRoleSequenceOvershootAllowed
    ) {
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
    const plannedOppositeCandidate =
      plannedOppositeDutyActive &&
      plannedOpposite !== undefined &&
      executableSize <= plannedOpposite.plannedOppositeMissingQty + config.maxCompletionOvershootShares + 1e-9;
    const plannedOppositeCompletionCap =
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE"
        ? Math.max(
            1.025,
            Math.min(
              config.xuanBehaviorCap,
              Math.max(config.marketBasketGoodAvgCap, config.temporalRepairPatientCap, config.highSideEmergencyCap),
            ),
          )
        : 1.025;
    const plannedOppositeCompletionAllowed =
      plannedOppositeCandidate &&
      ctx.secsToClose > config.finalWindowNoChaseSec &&
      repairCost <= plannedOppositeCompletionCap + 1e-9;
    const plannedOppositeDebtReducing =
      plannedOppositeCandidate &&
      repairCost <= config.marketBasketGoodAvgCap + 1e-9;
    const aggressiveOppositeHold = aggressiveOppositeReleaseHold({
      config,
      state,
      sideToBuy: laggingSide,
      nowTs,
      secsToClose: ctx.secsToClose,
      effectiveCost: repairCost,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
    });
    if (aggressiveOppositeHold) {
      lastBlockedRepairEvaluation = {
        decisions: [],
        trace: {
          ...trace,
          repairSizingMode,
          repairCandidateCount: repairCandidateSizes.length,
          repairFilledSize: executableSize,
          repairFinalQty: executableSize,
          repairCost,
          repairOldGap: oldGap,
          repairNewGap: newGap,
          repairOppositeAveragePrice: oppositeAveragePrice,
          plannedOppositeAgeSec: aggressiveOppositeHold.ageSec,
          completionHoldSec: aggressiveOppositeHold.holdSec,
          xuanCompletionDelayedCount: 1,
          continuationRejectedReason: "xuan_planned_opposite_wait",
          overlapRepairOutcome: "wait",
          skipReason: "xuan_planned_opposite_wait",
        },
      };
      continue;
    }
    const expensiveCampaignCompletionThreshold = Math.max(1.045, config.fullRebalanceOnlyIfEffectivePairBelow);
    const expensiveCampaignPartialHedgeMaxQty =
      !xuanFamilyResidualDutyActive &&
      unbalancedCampaignResidual &&
      !plannedOppositeCompletionAllowed &&
      !activeCompletionQtyPrior &&
      repairCost > expensiveCampaignCompletionThreshold + 1e-9 &&
      oldGap > config.completionMinQty + 1e-9
        ? Math.max(
            config.completionMinQty,
            Math.min(
              oldGap,
              oldGap * Math.max(0.1, Math.min(config.initialDebtyCampaignMaxHedgeRatio, 0.65)),
            ),
          )
        : undefined;
    if (
      expensiveCampaignPartialHedgeMaxQty !== undefined &&
      executableSize > expensiveCampaignPartialHedgeMaxQty + config.maxCompletionOvershootShares + 1e-9
    ) {
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
          skipReason: "expensive_completion_partial_hedge_cap",
        },
      };
      continue;
    }
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
    const currentMatchedEffectivePair =
      mergeableShares(state) > 1e-6
        ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate)
        : Number.POSITIVE_INFINITY;
    const campaignResidualFallback = residualCompletionFairValueFallback({
      config,
      state,
      unbalancedCampaignResidual,
      repairCost,
      currentMatchedEffectivePair,
      executableSize,
      oldGap,
      newGap,
      orphanCompletionDutyActive,
      phaseCap,
    });
    const strictXuanCompletionReleaseAllowed =
      aggressivePublicFootprint &&
      xuanFamilyResidualDutyActive &&
      ctx.secsToClose > config.finalWindowNoChaseSec &&
      (executableSize <= oldGap + config.maxCompletionOvershootShares + 1e-9 ||
        xuanRoleSequenceOvershootAllowed) &&
      repairCost <= config.xuanBehaviorCap + 1e-9;
    const campaignPhaseCapOverride =
      campaignResidualFallback.allowed ||
      plannedOppositeCompletionAllowed ||
      strictXuanCompletionReleaseAllowed;
    const earlyTemporalLaggingRebalanceWait =
      config.botMode === "XUAN" &&
      config.xuanCloneMode !== "PUBLIC_FOOTPRINT" &&
      !exactCompletionQtyPrior &&
      !plannedOppositeCompletionAllowed &&
      partialAgeSec < config.xuanTemporalCompletionMinAgeSec &&
      ctx.secsToClose > config.finalWindowCompletionOnlySec &&
      repairCost > config.xuanTemporalCompletionEarlyMaxEffectivePair + 1e-9;
    if (earlyTemporalLaggingRebalanceWait) {
      lastBlockedRepairEvaluation = {
        decisions: [],
        trace: {
          ...trace,
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
          completionReleaseRole: blockedCompletionReleaseRole,
          completionHoldSec: normalizeTraceNumber(config.xuanTemporalCompletionMinAgeSec - partialAgeSec),
          xuanTemporalCompletionMinAgeSec: config.xuanTemporalCompletionMinAgeSec,
          xuanTemporalCompletionEarlyMaxEffectivePair: config.xuanTemporalCompletionEarlyMaxEffectivePair,
          currentBasketEffectiveAvg: normalizeTraceNumber(currentMatchedEffectivePair),
          continuationRejectedReason: "temporal_lagging_rebalance_wait",
          overlapRepairOutcome: "wait",
          skipReason: "temporal_lagging_rebalance_wait",
        },
      };
      continue;
    }
    const campaignResidualCostBasisBlocked =
      unbalancedCampaignResidual &&
      oldGap >= Math.max(config.controlledOverlapMinResidualShares, config.microRepairMaxQty) - 1e-9 &&
      !campaignResidualFallback.allowed &&
      !plannedOppositeCompletionAllowed &&
      !strictXuanCompletionReleaseAllowed &&
      ctx.secsToClose > config.finalWindowCompletionOnlySec;
    if (campaignResidualCostBasisBlocked) {
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
          currentBasketEffectiveAvg: normalizeTraceNumber(currentMatchedEffectivePair),
          skipReason: "residual_completion_cost_basis_cap",
        },
      };
      continue;
    }
    if (
      (repairCost > phaseCap && !highLowPhaseCapOverride && !campaignPhaseCapOverride) ||
      (executableSize > campaignPhaseMaxQty && !plannedOppositeCompletionAllowed)
    ) {
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
        skipReason: executableSize > campaignPhaseMaxQty ? "repair_phase_qty_cap" : "repair_phase_cap",
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
      ultraFastCloneFairValueFallback ||
      campaignResidualFallback.allowed ||
      plannedOppositeCompletionAllowed ||
      strictXuanCompletionReleaseAllowed
        ? false
        : allowance.highLowMismatch && allowance.allowed && !allowance.requiresFairValue
          ? false
          : !(
              config.allowStrictResidualCompletionWithoutFairValue &&
              repairCost <= config.strictResidualCompletionCap
            ) || Boolean(allowance.requiresFairValue);
    const fairValueDecision =
      ultraFastCloneFairValueFallback ||
      campaignResidualFallback.allowed ||
      plannedOppositeCompletionAllowed ||
      strictXuanCompletionReleaseAllowed
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
      exactPriorActive: Boolean(activeCompletionQtyPrior),
      fairValueAllowed: strictHighSideFairValueDecision.allowed,
    });
    const campaignHighSideCompletionOverride =
      (campaignResidualFallback.allowed || plannedOppositeCompletionAllowed) &&
      unbalancedCampaignResidual &&
      executableSize <= oldGap + config.maxCompletionOvershootShares + 1e-9 &&
      repairCost <= Math.max(config.temporalRepairPatientCap, config.highSideCompletionMaxCost) + 1e-9;
    const qualitySkipReason = completionQualitySkipReason(config, state, {
      costWithFees: repairCost,
      candidateSize: executableSize,
      partialAgeSec,
      capMode: allowance.capMode,
      exactPriorActive: Boolean(activeCompletionQtyPrior),
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
      plannedOppositeCompletionAllowed && (allowance.highLowMismatch || plannedOppositeDebtReducing)
        ? "HIGH_LOW_COMPLETION_CHASE"
        : allowance.highLowMismatch && allowance.allowed
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
      exactPriorActive: Boolean(activeCompletionQtyPrior),
      exceptionalMode:
        Boolean(allowance.highLowMismatch) ||
        cheapLateCompletionChase ||
        campaignResidualFallback.allowed ||
        plannedOppositeCompletionAllowed ||
        strictXuanCompletionReleaseAllowed,
      ...(ctx.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: ctx.recentSeedFlowCount } : {}),
      ...(ctx.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: ctx.activeIndependentFlowCount } : {}),
      ...(ctx.completionPatienceMultiplier !== undefined
        ? { completionPatienceMultiplier: ctx.completionPatienceMultiplier }
        : {}),
    });
    const xuanRhythmGate = xuanRhythmCompletionGate({
      config,
      partialAgeSec,
      secsToClose: ctx.secsToClose,
      repairCost,
      currentMatchedEffectivePair,
      unbalancedCampaignResidual,
      plannedOppositeCompletionAllowed,
      campaignResidualFallbackAllowed: campaignResidualFallback.allowed,
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
      ...(campaignResidualFallback.allowed
        ? {
            campaignMode: "RESIDUAL_COMPLETION_ACTIVE",
            residualCompletionFairValueFallback: true,
            ...(campaignResidualFallback.reason
              ? { residualCompletionFallbackReason: campaignResidualFallback.reason }
              : {}),
            currentBasketEffectiveAvg: normalizeTraceNumber(currentMatchedEffectivePair),
          }
        : strictXuanCompletionReleaseAllowed
        ? {
            campaignMode: "RESIDUAL_COMPLETION_ACTIVE",
            residualCompletionFairValueFallback: true,
            residualCompletionFallbackReason: "xuan_family_residual_duty",
            currentBasketEffectiveAvg: normalizeTraceNumber(currentMatchedEffectivePair),
          }
        : {}),
      ...(plannedOppositeCompletionAllowed && plannedOpposite
        ? {
            campaignMode: "RESIDUAL_COMPLETION_ACTIVE",
            residualCompletionFairValueFallback: true,
            residualCompletionFallbackReason: plannedOppositeDebtReducing
              ? "planned_opposite_debt_reducing"
              : "planned_opposite_completion",
            plannedOppositeSide: plannedOpposite.plannedOppositeSide,
            plannedOppositeQty: plannedOpposite.plannedOppositeQty,
            plannedOppositeFilledQty: plannedOpposite.plannedOppositeFilledQty,
            plannedOppositeMissingQty: plannedOpposite.plannedOppositeMissingQty,
            plannedOppositeAgeSec: plannedOpposite.plannedOppositeAgeSec,
            plannedOppositeCompletionAttemptCount: 1,
            plannedOppositeCompletionOpenedCount: 1,
          }
        : {}),
      completionCalibrationPatienceMultiplier: completionDelayProfile.calibrationPatienceMultiplier,
      completionRolePatienceMultiplier: completionDelayProfile.rolePatienceMultiplier,
      completionEffectivePatienceMultiplier: completionDelayProfile.effectivePatienceMultiplier,
      completionWaitUntilSec: completionDelayProfile.waitUntilSec,
      xuanRhythmWaitSec: normalizeTraceNumber(xuanRhythmGate.waitSec),
      ...(xuanRhythmGate.earlyReason ? { xuanEarlyCompletionReason: xuanRhythmGate.earlyReason } : {}),
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
    if (
      !allowance.allowed &&
      !plannedOppositeCompletionAllowed &&
      !strictXuanCompletionReleaseAllowed ||
      (
        !fairValueDecision.allowed &&
        !campaignResidualFallback.allowed &&
        !plannedOppositeCompletionAllowed &&
        !strictXuanCompletionReleaseAllowed
      )
    ) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        overlapRepairOutcome: "blocked",
        skipReason:
          !allowance.allowed && !plannedOppositeCompletionAllowed && !strictXuanCompletionReleaseAllowed
            ? "repair_cap"
            : fairValueDecision.reason ?? "repair_fair_value",
      },
      };
      continue;
    }
    if (
      highSideQualitySkipReason &&
      !campaignHighSideCompletionOverride &&
      !plannedOppositeCompletionAllowed &&
      !strictXuanCompletionReleaseAllowed
    ) {
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
    if (
      qualitySkipReason &&
      !campaignResidualFallback.allowed &&
      !plannedOppositeCompletionAllowed &&
      !strictXuanCompletionReleaseAllowed
    ) {
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
    if (xuanRhythmGate.shouldWait && !strictXuanCompletionReleaseAllowed) {
      lastBlockedRepairEvaluation = {
      decisions: [],
      trace: {
        ...detailedTrace,
        completionHoldSec: normalizeTraceNumber(xuanRhythmGate.waitSec - partialAgeSec),
        xuanCompletionDelayedCount: 1,
        continuationRejectedReason: "xuan_rhythm_wait",
        overlapRepairOutcome: "wait",
        skipReason: "xuan_rhythm_wait",
      },
      };
      continue;
    }
    if (
      completionDelayProfile.shouldDelay &&
      !campaignResidualFallback.allowed &&
      !plannedOppositeCompletionAllowed &&
      !strictXuanCompletionReleaseAllowed
    ) {
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
        activeCompletionQtyPrior !== undefined &&
        Math.abs(executableSize - activeCompletionQtyPrior.qty) <= 1e-6,
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
  const projectedMergeableAfterJanitor = currentMergeable + targetPairQty;
  const projectedMergeReturn = Math.max(0, projectedMergeableAfterJanitor - args.config.mergeDustLeaveShares);
  const effectiveJanitorCost = targetPairQty * pairCost;
  const unlockNetUsdc = Number((projectedMergeReturn - effectiveJanitorCost).toFixed(6));
  const unlocksSubMinMerge =
    currentMergeable < args.config.mergeMinShares - 1e-9 &&
    projectedMergeReturn >= args.config.mergeMinShares - 1e-9;
  const unlockPairCostAllowed =
    unlocksSubMinMerge &&
    pairCost <= args.config.residualJanitorUnlockMaxEffectivePair + 1e-9 &&
    unlockNetUsdc >= args.config.residualJanitorMinUnlockNetUsdc - 1e-9;
  if (pairCost > args.config.residualJanitorMaxEffectivePair + 1e-9 && !unlockPairCostAllowed) {
    return undefined;
  }

  const allowance = pairSweepAllowance({
    config: args.config,
    state: args.state,
    costWithFees: pairCost,
    candidateSize: targetPairQty,
    secsToClose: args.ctx.secsToClose,
    priceSpread: Math.abs(upExecution.averagePrice - downExecution.averagePrice),
    dailyNegativeEdgeSpentUsdc: args.dailyNegativeEdgeSpentUsdc,
    carryFlowConfidence: args.carryFlowConfidence,
    matchedInventoryQuality: args.matchedInventoryQuality,
    activeIndependentFlowCount: args.activeIndependentFlowCount,
    flowPressureState: args.flowPressureState,
  });
  if (!allowance.allowed && pairCost > args.config.pairSweepStrictCap + 1e-9 && !unlockPairCostAllowed) {
    return undefined;
  }

  const mode = allowance.mode ?? (unlockPairCostAllowed ? "XUAN_HARD_PAIR_SWEEP" : "STRICT_PAIR_SWEEP");
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
      residualJanitorUnlockNetUsdc: unlockNetUsdc,
      residualJanitorProjectedMergeable: Number(projectedMergeableAfterJanitor.toFixed(6)),
      residualJanitorProjectedMergeReturn: Number(projectedMergeReturn.toFixed(6)),
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
          fairValueFallbackReason: unlockPairCostAllowed ? "sub_min_merge_unlock" : undefined,
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
  const aggressivePublicFootprint =
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" && args.config.xuanCloneIntensity === "AGGRESSIVE";
  if (
    Math.abs(args.state.upShares - args.state.downShares) > 1e-6 &&
    !(aggressivePublicFootprint && Math.abs(args.state.upShares - args.state.downShares) <= xuanFreshCycleFlatDustThreshold(args.config, args.state))
  ) {
    return { bias: 0, fairValueScale: 1 };
  }

  const prior = resolveBundledSeedSequencePrior(args.marketSlug, args.secsFromOpen);
  if (!prior) {
    return { bias: 0, fairValueScale: 1 };
  }
  if (prior.scope === "family" && args.fairValueSnapshot?.status === "valid" && !aggressivePublicFootprint) {
    return { bias: 0, fairValueScale: 1 };
  }

  const sameSide = args.side === prior.side;
  const phaseWeight = prior.phase === "ENTRY" ? 1 : 0.9;
  const strictScale = aggressivePublicFootprint ? (prior.scope === "exact" ? 5 : 2.25) : 1;
  return {
    bias: sameSide ? 1.35 * phaseWeight * strictScale : -1.05 * phaseWeight * strictScale,
    fairValueScale: prior.scope === "exact" ? (aggressivePublicFootprint ? 0.35 : 0.55) : aggressivePublicFootprint ? 0.55 : 0.75,
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
  if (
    args.bestCandidate.marketBasketContinuation &&
    (args.bestCandidate.continuationClass === "AVG_IMPROVING" ||
      args.bestCandidate.continuationClass === "DEBT_REDUCING")
  ) {
    return false;
  }
  const openPrior = resolveBundledOpenSequencePrior(args.state.market.slug);
  const openPriorActive =
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    args.state.fillHistory.every((fill) => fill.side !== "BUY") &&
    openPrior !== undefined &&
    args.ctx.secsFromOpen <= openPrior.activeUntilSec + 1e-9;
  const prior = resolveBundledSeedSequencePrior(args.state.market.slug, args.ctx.secsFromOpen);
  const aggressivePublicFootprint =
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" && args.config.xuanCloneIntensity === "AGGRESSIVE";
  const referencePriorActive =
    prior !== undefined &&
    !(prior.scope === "family" && args.ctx.fairValueSnapshot?.status === "valid" && !aggressivePublicFootprint) &&
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
    marketSlug: args.marketSlug,
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
  marketSlug: string;
  side: OutcomeSide;
  secsFromOpen: number;
  seedPrice: number;
  oppositePrice: number;
  oppositeCoverageRatio: number;
  referencePairCost: number;
  completionRoleReleaseOrderBias?: EntryLadderContext["completionRoleReleaseOrderBias"];
}): number {
  const aggressivePublicFootprint =
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" && args.config.xuanCloneIntensity === "AGGRESSIVE";
  if (
    args.config.botMode !== "XUAN" ||
    (!aggressivePublicFootprint && args.completionRoleReleaseOrderBias !== "role_order")
  ) {
    return 0;
  }
  if (args.oppositeCoverageRatio < args.config.temporalSingleLegMinOppositeDepthRatio) {
    return 0;
  }
  if (!Number.isFinite(args.referencePairCost) || args.referencePairCost > args.config.xuanBehaviorCap + 1e-9) {
    return 0;
  }
  if (aggressivePublicFootprint) {
    const oppositeSide: OutcomeSide = args.side === "UP" ? "DOWN" : "UP";
    const sameSidePrior = resolveBundledCompletionSequencePrior(args.marketSlug, args.secsFromOpen, args.side);
    const oppositeSidePrior = resolveBundledCompletionSequencePrior(args.marketSlug, args.secsFromOpen, oppositeSide);
    if (sameSidePrior) {
      return sameSidePrior.scope === "exact" ? 1.65 : 1.05;
    }
    if (oppositeSidePrior) {
      return oppositeSidePrior.scope === "exact" ? -1.25 : -0.85;
    }
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
  campaignCompletionSizing?: CampaignCompletionSizing | undefined;
}): number[] {
  if (args.standardSize <= 0) {
    return [];
  }
  if (args.config.botMode !== "XUAN" || args.exactPriorActive) {
    return [args.standardSize];
  }
  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const microFloor = args.config.repairMinQty;
  const campaignMinAllowed =
    args.campaignCompletionSizing?.clipType === "CAMPAIGN_COMPLETION"
      ? Math.min(args.shareGap, Math.max(args.config.microRepairMaxQty, args.campaignCompletionSizing.minCampaignClipQty))
      : 0;
  const sizes = [
    ...(args.campaignCompletionSizing ? [args.campaignCompletionSizing.targetQty] : []),
    args.standardSize,
    args.standardSize * 0.7,
    args.standardSize * 0.5,
    Math.min(args.standardSize, args.shareGap * 0.5),
    Math.min(args.standardSize, baseLot * 0.5),
  ]
    .map((size) => normalizeOrderSize(size, microFloor))
    .filter((size) => size > 0)
    .filter((size) => campaignMinAllowed <= 0 || size + 1e-9 >= campaignMinAllowed);
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
  const campaignBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
  const debtReducingOverlapSeedCap = Math.max(
    config.controlledOverlapSeedMaxQty,
    Math.min(
      config.xuanBasketCampaignCompletionClipMaxQty,
      campaignBaseLot * config.xuanBasketCampaignDebtReducingQtyMultiplier,
    ),
  );
  const aggressivePublicFootprint =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE";
  const seedSequencePrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen)
      : undefined;
  const exactSeedPriorQty =
    aggressivePublicFootprint && seedSequencePrior?.scope === "exact"
      ? seedSequencePrior.qty
      : undefined;
  const overlapSeedCap = protectedOverlapActive
    ? Math.max(0, debtReducingOverlapSeedCap, exactSeedPriorQty ?? 0)
    : Number.POSITIVE_INFINITY;
  const requestedSeedLot =
    exactSeedPriorQty !== undefined
      ? Math.max(ctx.lot, exactSeedPriorQty)
      : ctx.lot;
  const singleLegSeedCap =
    exactSeedPriorQty !== undefined
      ? Math.max(config.singleLegSeedMaxQty, exactSeedPriorQty)
      : config.singleLegSeedMaxQty;
  const candidateSize = normalizeOrderSize(
    Math.min(
      requestedSeedLot,
      singleLegSeedCap,
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
      ? seedSequencePrior
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
    const completingExistingResidual =
      protectedOverlapActive &&
      oppositeShares > currentSideShares + Math.max(config.postMergeFlatDustShares, 1e-6);
    const existingOppositeAveragePrice =
      completingExistingResidual ? averageCost(state, oppositeSide) : undefined;
    const referenceOppositePrice =
      existingOppositeAveragePrice !== undefined && existingOppositeAveragePrice > 0
        ? existingOppositeAveragePrice
        : oppositeQuote.averagePrice;
    const referencePairCost =
      executableSize > 0
        ? pairCostWithBothTaker(
            side === "UP" ? seedQuote.averagePrice : referenceOppositePrice,
            side === "DOWN" ? seedQuote.averagePrice : referenceOppositePrice,
            config.cryptoTakerFeeRate,
          )
        : Number.POSITIVE_INFINITY;
    const rawPairCost =
      executableSize > 0 ? seedQuote.averagePrice + referenceOppositePrice : Number.POSITIVE_INFINITY;
    const existingResidualPairCost = completingExistingResidual ? referencePairCost : undefined;
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
    const oldGap = absoluteShareGap(state);
    const projectedGap = Math.abs(currentSideShares + executableSize - oppositeShares);
    const effectiveProjectedGap = Math.max(0, projectedGap - protectedResidualAllowance(config, ctx, side));
    const matchedEffectivePair =
      mergeableShares(state) > 1e-6
        ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate)
        : Number.POSITIVE_INFINITY;
    const dustOnlyResidual =
      oldGap <=
      Math.max(config.postMergeFlatDustShares, config.repairMinQty, config.completionMinQty) + 1e-9;
    const microOverlapResidual =
      oldGap < Math.max(config.controlledOverlapMinResidualShares, config.microRepairMaxQty) - 1e-9;
    const protectedResidualDebtReducing =
      completingExistingResidual && referencePairCost <= config.residualCompletionCostBasisCap + 1e-9;
    const protectedResidualAverageImproving =
      completingExistingResidual &&
      Number.isFinite(matchedEffectivePair) &&
      referencePairCost <= config.softResidualCompletionCap + 1e-9 &&
      referencePairCost < matchedEffectivePair - config.residualCompletionImprovementThreshold + 1e-9;
    const protectedCampaignResidualCompletion =
      completingExistingResidual &&
      isUnbalancedCampaignResidual(config, state, oldGap) &&
      referencePairCost <= Math.max(config.temporalRepairPatientCap, config.highSideCompletionMaxCost) + 1e-9 &&
      executableSize <= oldGap + config.maxCompletionOvershootShares + 1e-9;
    const protectedResidualCostBasisAllowed =
      !completingExistingResidual ||
      dustOnlyResidual ||
      microOverlapResidual ||
      protectedResidualDebtReducing ||
      protectedResidualAverageImproving ||
      protectedCampaignResidualCompletion;
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
    const seedRhythm = xuanTemporalSeedRhythmSkipReason({
      config,
      state,
      ctx,
      referencePairCost,
      completingExistingResidual,
      completingExistingResidualDebtReducing: protectedResidualDebtReducing || protectedResidualAverageImproving,
      candidateSide: side,
      exactPriorActive: exactSeedPriorQty !== undefined,
    });
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
            highSidePrice: Math.max(seedQuote.averagePrice, referenceOppositePrice),
            lowSidePrice: Math.min(seedQuote.averagePrice, referenceOppositePrice),
          },
        );
      }

    if (skipReason === undefined) {
      if (cheapSeedExpensiveCompletionBlocked) {
        skipReason = "cheap_seed_expensive_completion_guard";
      } else if (!protectedResidualCostBasisAllowed) {
        skipReason = "protected_residual_overlap_seed_cost_basis_cap";
      } else if (sameSideOverlapAmplificationBlocked) {
        skipReason = "overlap_same_side_amplification";
      } else if (seedRhythm.skipReason !== undefined) {
        skipReason = seedRhythm.skipReason;
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
    const protectedResidualHighSideCompletion =
      completingExistingResidual &&
      seedQuote.averagePrice >= config.highSideCompletionSoftPriceThreshold - 1e-9;
    const highSideCompletionFairValueDecision = protectedResidualHighSideCompletion
      ? fairValueGate({
          config,
          snapshot: ctx.fairValueSnapshot,
          side,
          sidePrice: seedQuote.averagePrice,
          mode: "completion",
          secsToClose: ctx.secsToClose,
          effectiveCost: referencePairCost,
          required: config.highSideCompletionRequiresFairValue,
        })
      : undefined;
    if (skipReason === undefined && protectedResidualHighSideCompletion) {
      const imbalanceRatio = Math.abs(state.upShares - state.downShares) / Math.max(state.upShares + state.downShares, 1e-9);
      if (!protectedCampaignResidualCompletion && executableSize > config.highSideCompletionMaxQty + 1e-9) {
        skipReason = "high_side_completion_qty_cap";
      } else if (!protectedCampaignResidualCompletion && referencePairCost > config.highSideCompletionMaxCost + 1e-9) {
        skipReason = "high_side_completion_cost_cap";
      } else if (!protectedCampaignResidualCompletion && config.highSideCompletionRequiresHardImbalance && imbalanceRatio < config.hardImbalanceRatio) {
        skipReason = "high_side_completion_imbalance";
      } else if (!protectedCampaignResidualCompletion && config.highSideCompletionRequiresFairValue && !highSideCompletionFairValueDecision?.allowed) {
        skipReason = "high_side_completion_fair_value";
      }
    }
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
      existingResidualPairCost,
      negativeEdgeUsdc,
      rawPairCost,
      feeUSDC: cycleTrace.feeUSDC,
      expectedNetIfMerged: cycleTrace.expectedNetIfMerged,
      cycleQualityLabel: cycleTrace.cycleQualityLabel,
      orphanRisk,
      fairValueDecision,
      classifierScore,
      skipReason,
      ...(seedRhythm.waitSec !== undefined ? { xuanSeedRhythmWaitSec: seedRhythm.waitSec } : {}),
      ...(seedRhythm.skipReason !== undefined ? { xuanSeedDelayedCount: 1 } : {}),
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
        marketSlug: state.market.slug,
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
      ...(candidate.existingResidualPairCost !== undefined
        ? { existingResidualPairCost: candidate.existingResidualPairCost }
        : {}),
      feeUSDC: candidate.feeUSDC,
      expectedNetIfMerged: candidate.expectedNetIfMerged,
      cycleQualityLabel: candidate.cycleQualityLabel,
      ...(candidate.skipReason === "fresh_cycle_borderline_pair" ||
      candidate.skipReason === "fresh_cycle_bad_pair" ||
      candidate.skipReason === "opening_weak_pair_no_followup_plan" ||
      candidate.skipReason === "early_mid_pair_repeat_fee_guard" ||
      candidate.skipReason === "xuan_seed_rhythm_wait" ||
      candidate.skipReason === "xuan_seed_rhythm_same_side_wait"
        ? { cycleSkippedReason: candidate.skipReason }
        : {}),
      ...(candidate.xuanSeedRhythmWaitSec !== undefined
        ? { xuanSeedRhythmWaitSec: normalizeTraceNumber(candidate.xuanSeedRhythmWaitSec) }
        : {}),
      ...(candidate.xuanSeedDelayedCount !== undefined
        ? { xuanSeedDelayedCount: candidate.xuanSeedDelayedCount }
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
  const seedPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledSeedSequencePrior(state.market.slug, ctx.secsFromOpen)
      : undefined;
  const xuanSequencePriorActive =
    seedPrior?.scope === "exact" ||
    (
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      config.xuanCloneIntensity === "AGGRESSIVE" &&
      seedPrior?.scope === "family"
    );
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

  if (protectedResidualActive || xuanSequencePriorActive) {
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
  const basketState = marketBasketStateTrace(config, state);
  const baseMaxCandidateSize = normalizeOrderSize(
    Math.min(
      requestedMaxLot,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
      Math.max(0, config.maxMarketExposureShares - Math.max(state.upShares, state.downShares)),
    ),
    state.market.minOrderSize,
  );
  const balancedDebtQtyCap = balancedDebtContinuationQtyCap(
    config,
    state,
    books,
    basketState,
    baseMaxCandidateSize,
  );
  const maxCandidateSize = normalizeOrderSize(
    Math.min(baseMaxCandidateSize, balancedDebtQtyCap ?? baseMaxCandidateSize),
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
    const basketProjection = marketBasketProjection(config, state, pairCost, requestedSize);
    const edgePerPair = 1 - pairCost;
    const terminalCarryProjection = terminalCarryProjectionForPair({
      config,
      state,
      fairValueSnapshot,
      upQty: requestedSize,
      downQty: requestedSize,
      upPrice: upExecution.averagePrice,
      downPrice: downExecution.averagePrice,
      effectivePair: pairCost,
    });
    const qtyNeededToRepayDebt =
      basketState.balancedButDebted && edgePerPair > 1e-9
        ? normalizeTraceNumber(basketState.basketDebtUSDC / edgePerPair)
        : undefined;
    const freshCycleSkipReason = freshCycleGate
      ? freshCycleCandidateSkipReason(
          config,
          state,
          freshCycleGate.stats,
          cycleTrace.cycleQualityLabel,
          freshCycleGate.referencePriorActive,
          {
            route: "balanced_pair",
            ctx: freshCycleGate.ctx,
            requestedSize,
            rawPair: rawPairCost,
            effectivePair: pairCost,
            highSidePrice: Math.max(upExecution.averagePrice, downExecution.averagePrice),
            lowSidePrice: Math.min(upExecution.averagePrice, downExecution.averagePrice),
          },
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
            priceSpread: Math.abs(upExecution.averagePrice - downExecution.averagePrice),
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
    const marketBasketFairValueFallbackEligible =
      allowance?.marketBasketContinuation === true &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled &&
      basketProjection !== undefined &&
      basketProjection.improvement >= config.marketBasketMinAvgImprovement - 1e-9;
    const basketContinuationPairOverride =
      allowance?.allowed === true &&
      allowance.marketBasketContinuation === true &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled;
    const fairValueReasons = [upFairValue.reason, downFairValue.reason].filter((reason): reason is string =>
      Boolean(reason),
    );
    const marketBasketContinuationFairValueFallback = shouldAllowMarketBasketContinuationFairValueFallback({
      config,
      allowance,
      marketBasketFairValueFallbackEligible,
      secsToClose,
      reasons: fairValueReasons,
    });
    const fairValueAllowed =
      (upFairValue.allowed && downFairValue.allowed) ||
      shouldAllowPairedHighLowFairValueOverride(
        config,
        allowance,
        upExecution.averagePrice,
        downExecution.averagePrice,
        pairCost,
        fairValueReasons,
      ) ||
      marketBasketContinuationFairValueFallback;
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
    const terminalCarryPairOverride =
      (basketState.balancedButDebted || basketState.campaignActive) &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled &&
      terminalCarryProjection.allowed;
    const postCompletionDebtCampaignOverride = shouldAllowPostCompletionDebtCampaignPairOverride({
      config,
      basketState,
      allowance,
      basketProjection,
      terminalCarryProjection,
      pairCost,
      requestedSize,
    });
    const postCompletionDebtCampaignFairValueFallback =
      postCompletionDebtCampaignOverride &&
      fairValueReasons.length > 0 &&
      fairValueReasons.every((reason) => reason === "fair_value_missing" || reason === "fair_value_missing_side");
    const buyFillCount = state.fillHistory.filter((fill) => fill.side === "BUY").length;
    const aggressivePublicFootprint =
      config.botMode === "XUAN" &&
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      config.xuanCloneIntensity === "AGGRESSIVE";
    const familySeedPrior = aggressivePublicFootprint
      ? resolveBundledSeedSequencePrior(state.market.slug, secsFromOpen)
      : undefined;
    const postMergeRecycleSlot =
      aggressivePublicFootprint &&
      state.mergeHistory.length > 0 &&
      state.upShares + state.downShares <=
        Math.max(config.postMergeFlatDustShares * 2, state.market.minOrderSize * 0.01, 0.05) + 1e-9 &&
      secsToClose > config.finalWindowCompletionOnlySec;
    const xuanStrictSequenceClipMax = Math.max(
      state.market.minOrderSize,
      config.xuanMicroPairMaxQty,
      Math.min(config.liveSmallLotLadder[0] ?? config.defaultLot, 30),
    );
    const balancedMicroPairReady =
      config.xuanMicroPairContinuationEnabled &&
      config.botMode === "XUAN" &&
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      buyFillCount < config.xuanMinFillCountForPass &&
      secsToClose > config.finalWindowCompletionOnlySec &&
      Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
      mergeableShares(state) >= config.xuanBasketCampaignMinMatchedShares - 1e-9 &&
      requestedSize <= Math.max(state.market.minOrderSize, config.xuanMicroPairMaxQty) + 1e-9 &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled &&
      basketProjection !== undefined &&
      pairCost <= config.marketBasketContinuationMaxEffectivePair + 1e-9 &&
      !allowance?.continuationRejectedReason?.startsWith("flow_shaping_") &&
      !allowance?.continuationRejectedReason?.startsWith("avg_improving_") &&
      !staleCheapOppositeQuote;
    const xuanMicroPairContinuation =
      balancedMicroPairReady &&
      basketProjection.projectedEffectivePair <= config.xuanMicroPairProjectedEffectiveCap + 1e-9;
    const xuanMicroPairProjectedTooExpensive =
      balancedMicroPairReady &&
      basketProjection.projectedEffectivePair > config.xuanMicroPairProjectedEffectiveCap + 1e-9;
    const xuanStrictSequenceContinuation =
      aggressivePublicFootprint &&
      (familySeedPrior !== undefined || postMergeRecycleSlot) &&
      secsToClose > config.finalWindowCompletionOnlySec &&
      Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled &&
      requestedSize <= xuanStrictSequenceClipMax + 1e-9 &&
      pairCost <= config.xuanBehaviorCap + 1e-9 &&
      !staleCheapOppositeQuote;
    const xuanBalancedPairContinuationOverride =
      config.botMode === "XUAN" &&
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      secsToClose > config.finalWindowCompletionOnlySec &&
      Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
      (mergeableShares(state) >= config.xuanBasketCampaignMinMatchedShares - 1e-9 || xuanStrictSequenceContinuation) &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled &&
      !staleCheapOppositeQuote &&
      (
        xuanStrictSequenceContinuation ||
        xuanMicroPairContinuation ||
        pairCost <= 1.01 + 1e-9 ||
        (
          basketProjection !== undefined &&
          basketProjection.improvement >= config.marketBasketMinAvgImprovement - 1e-9 &&
          basketProjection.projectedEffectivePair < basketState.basketEffectiveAvg - 1e-9
        )
      );
    const aggressiveMarketBasketFairValueFallback =
      aggressivePublicFootprint &&
      allowance?.marketBasketContinuation === true &&
      upExecution.fullyFilled &&
      downExecution.fullyFilled &&
      secsToClose > config.finalWindowNoChaseSec &&
      pairCost <= config.xuanBehaviorCap + 1e-9 &&
      fairValueReasons.length > 0 &&
      fairValueReasons.every((reason) => reason === "fair_value_missing" || reason === "fair_value_missing_side");
    const effectiveFairValueAllowed =
      fairValueAllowed ||
      postCompletionDebtCampaignFairValueFallback ||
      xuanBalancedPairContinuationOverride ||
      aggressiveMarketBasketFairValueFallback;
    const selectedMode =
      allowance?.mode ??
      (terminalCarryPairOverride || postCompletionDebtCampaignOverride || xuanBalancedPairContinuationOverride
        ? "XUAN_HARD_PAIR_SWEEP"
        : undefined);
    const highLowVisualPair = isHighLowVisualPair(config, upExecution.averagePrice, downExecution.averagePrice);
    const avgImprovingHighLowContinuationAllowed =
      allowance?.marketBasketContinuation === true &&
      allowance.continuationClass === "AVG_IMPROVING" &&
      (basketState.campaignActive || basketState.balancedButDebted);
    const aggressiveHighLowRecycleOverride =
      aggressivePublicFootprint &&
      highLowVisualPair &&
      allowance?.marketBasketContinuation === true &&
      secsToClose > config.finalWindowNoChaseSec &&
      pairCost <= config.xuanBehaviorCap + 1e-9 &&
      (
        familySeedPrior !== undefined ||
        postMergeRecycleSlot ||
        basketState.campaignActive ||
        basketState.balancedButDebted
      );
    const strictHighLowHardSweepBlocked =
      highLowVisualPair &&
      config.botMode === "XUAN" &&
      (basketState.campaignActive || basketState.balancedButDebted) &&
      pairCost > config.highLowDebtReducingEffectiveCap + 1e-9 &&
      !terminalCarryPairOverride &&
      !postCompletionDebtCampaignOverride &&
      !xuanStrictSequenceContinuation &&
      !xuanBalancedPairContinuationOverride &&
      !aggressiveHighLowRecycleOverride &&
      !avgImprovingHighLowContinuationAllowed;
    const xuanBalancedPairFreshCycleBypass =
      xuanBalancedPairContinuationOverride &&
      (freshCycleSkipReason === "late_fresh_seed_cutoff" ||
        (xuanMicroPairContinuation && freshCycleSkipReason === "fresh_cycle_bad_pair") ||
        (
          xuanStrictSequenceContinuation &&
          (
            freshCycleSkipReason === "fresh_cycle_bad_pair" ||
            freshCycleSkipReason === "fresh_cycle_borderline_pair" ||
            freshCycleSkipReason === "bad_cycle_completion_only" ||
            freshCycleSkipReason === "temporal_cycle_density"
          )
        ));
    const effectiveFreshCycleSkipReason =
      terminalCarryPairOverride ||
      postCompletionDebtCampaignOverride ||
      xuanBalancedPairFreshCycleBypass ||
      (allowance?.allowed === true && allowance.marketBasketContinuation === true)
        ? undefined
        : freshCycleSkipReason;
    const orphanRiskAllowed =
      (upOrphanRisk.allowed && downOrphanRisk.allowed) ||
      basketContinuationPairOverride ||
      postCompletionDebtCampaignOverride ||
      xuanBalancedPairContinuationOverride;
    const allowanceAllowed = Boolean(
      allowance?.allowed ||
      terminalCarryPairOverride ||
      postCompletionDebtCampaignOverride ||
      xuanBalancedPairContinuationOverride,
    );
    const verdict =
      !upExecution.fullyFilled
        ? "up_depth"
        : !downExecution.fullyFilled
          ? "down_depth"
          : allowanceAllowed &&
              effectiveFairValueAllowed &&
              !staleCheapOppositeQuote &&
              !strictHighLowHardSweepBlocked &&
              orphanRiskAllowed &&
              !effectiveFreshCycleSkipReason
            ? "ok"
            : allowanceAllowed &&
                effectiveFairValueAllowed &&
                !staleCheapOppositeQuote &&
                !strictHighLowHardSweepBlocked &&
                !effectiveFreshCycleSkipReason &&
                !orphanRiskAllowed
              ? "orphan_risk"
              : "pair_cap";
    const gateReason =
      verdict === "pair_cap"
        ? strictHighLowHardSweepBlocked
          ? "high_low_effective_not_debt_reducing"
          : effectiveFreshCycleSkipReason
            ? effectiveFreshCycleSkipReason
          : staleCheapOppositeQuote
          ? "pair_stale_cheap_quote"
          : effectiveFairValueAllowed
          ? describePairGate(config, pairCost, requestedSize, allowance, secsToClose, cap)
          : upFairValue.reason ?? downFairValue.reason ?? "pair_fair_value"
        : verdict === "orphan_risk"
          ? orphanGateReason("UP", upOrphanRisk) ?? orphanGateReason("DOWN", downOrphanRisk)
        : undefined;
    const continuationDutyActive = basketState.balancedButDebted || basketState.campaignActive;
    const continuationRejectedReason =
      continuationDutyActive && verdict !== "ok"
        ? allowance?.continuationRejectedReason ??
          effectiveFreshCycleSkipReason ??
          (gateReason === "fair_value_missing" || gateReason === "fair_value_missing_side" || gateReason === "pair_fair_value"
            ? gateReason
            : edgePerPair <= 0
            ? basketState.campaignActive
              ? "average_improvement_not_allowed"
              : "non_positive_edge"
            : basketProjection === undefined
              ? "no_basket_projection"
              : basketProjection.debtDeltaUSDC <= 0
                ? "debt_not_reduced"
                : gateReason)
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
      ...(basketProjection
        ? {
            marketBasketProjectedEffectivePair: basketProjection.projectedEffectivePair,
            marketBasketProjectedMatchedQty: basketProjection.projectedMatchedQty,
            marketBasketImprovement: basketProjection.improvement,
            marketBasketDebtBeforeUSDC: basketProjection.debtBeforeUSDC,
            marketBasketDebtAfterUSDC: basketProjection.debtAfterUSDC,
            marketBasketDebtDeltaUSDC: basketProjection.debtDeltaUSDC,
          }
        : {}),
      ...(allowance?.marketBasketBootstrap ? { marketBasketBootstrap: true } : {}),
      ...(allowance?.marketBasketContinuation ||
      terminalCarryPairOverride ||
      postCompletionDebtCampaignOverride ||
      xuanBalancedPairContinuationOverride
        ? { marketBasketContinuation: true }
        : {}),
      ...(xuanMicroPairContinuation ? { xuanMicroPairContinuation: true } : {}),
      ...(marketBasketContinuationFairValueFallback
        ? { fairValueFallbackReason: "market_basket_continuation" }
        : {}),
      ...(postCompletionDebtCampaignFairValueFallback
        ? { fairValueFallbackReason: "post_completion_debt_campaign" }
        : {}),
      ...(basketState.balancedButDebted ? { balancedButDebted: true } : {}),
      ...(basketState.campaignActive
        ? {
            campaignMode: verdict === "ok" ? "ACCUMULATING_CONTINUATION" : "BASKET_CAMPAIGN_ACTIVE",
            campaignBaseLot: normalizeTraceNumber(requestedMaxLot),
            plannedContinuationQty: normalizeTraceNumber(requestedSize),
          }
        : {}),
      ...(basketProjection
        ? {
            currentBasketEffectiveAvg: basketState.basketEffectiveAvg,
            deltaAverageCost: basketProjection.improvement,
            deltaAbsoluteDebt: basketProjection.debtDeltaUSDC,
          }
        : {}),
      candidateEffectivePair: cycleTrace.effectivePair,
      edgePerPair: normalizeTraceNumber(edgePerPair),
      ...(qtyNeededToRepayDebt !== undefined ? { qtyNeededToRepayDebt } : {}),
      ...(basketProjection ? { deltaBasketDebt: basketProjection.debtDeltaUSDC } : {}),
      ...(continuationRejectedReason ? { continuationRejectedReason } : {}),
      ...(continuationRejectedReason ? { cycleSkippedReason: continuationRejectedReason } : {}),
      ...(terminalCarryPairOverride ? { terminalCarryMode: true } : {}),
      ...(xuanBalancedPairContinuationOverride
        ? { fairValueFallbackReason: xuanMicroPairContinuation ? "xuan_micro_pair_continuation" : "xuan_balanced_pair_continuation" }
        : {}),
      deltaTerminalMinPnl: terminalCarryProjection.deltaTerminalMinPnl,
      ...(terminalCarryProjection.deltaTerminalExpectedPnl !== undefined
        ? {
            deltaTerminalExpectedPnl: terminalCarryProjection.deltaTerminalExpectedPnl,
            deltaTerminalEV: terminalCarryProjection.deltaTerminalExpectedPnl,
          }
        : {}),
      ...(terminalCarryProjection.fairValueEVBefore !== undefined
        ? { fairValueEVBefore: terminalCarryProjection.fairValueEVBefore }
        : {}),
      ...(terminalCarryProjection.fairValueEVAfter !== undefined
        ? { fairValueEVAfter: terminalCarryProjection.fairValueEVAfter }
        : {}),
      addedDebtUSDC: terminalCarryProjection.addedDebtUSDC,
      ...(allowance?.continuationClass ? { continuationClass: allowance.continuationClass } : {}),
      ...(allowance?.campaignClipType ? { campaignClipType: allowance.campaignClipType } : {}),
      ...(allowance?.avgImprovingBudgetRemainingUSDC !== undefined
        ? { avgImprovingBudgetRemainingUSDC: allowance.avgImprovingBudgetRemainingUSDC }
        : {}),
      ...(allowance?.avgImprovingClipBudgetRemaining !== undefined
        ? { avgImprovingClipBudgetRemaining: allowance.avgImprovingClipBudgetRemaining }
        : {}),
      ...(allowance?.flowShapingBudgetRemainingUSDC !== undefined
        ? { flowShapingBudgetRemainingUSDC: allowance.flowShapingBudgetRemainingUSDC }
        : {}),
      ...(allowance?.flowShapingClipBudgetRemaining !== undefined
        ? { flowShapingClipBudgetRemaining: allowance.flowShapingClipBudgetRemaining }
        : {}),
      ...(allowance?.campaignFlowCount !== undefined ? { campaignFlowCount: allowance.campaignFlowCount } : {}),
      ...(allowance?.campaignFlowTarget !== undefined ? { campaignFlowTarget: allowance.campaignFlowTarget } : {}),
      ...(allowance?.postCompletionDebtRepairActive ? { postCompletionDebtRepairActive: true } : {}),
      ...(xuanMicroPairProjectedTooExpensive
          ? { cycleSkippedReason: "projected_basket_too_expensive" }
        : effectiveFreshCycleSkipReason && !continuationRejectedReason
          ? { cycleSkippedReason: effectiveFreshCycleSkipReason }
          : {}),
      negativeEdgeUsdc: terminalCarryPairOverride || xuanBalancedPairContinuationOverride ? 0 : allowance?.negativeEdgeUsdc ?? 0,
      verdict,
      ...(selectedMode ? { selectedMode } : {}),
      ...(gateReason ? { gateReason } : {}),
      upOrphanRisk,
      downOrphanRisk,
    });

    if (
      verdict === "ok" &&
      shouldUseBalancedPairCandidate(
        config,
        bestCandidate,
        requestedSize,
        rawPairCost,
        pairCost,
        Boolean(allowance?.marketBasketBootstrap || allowance?.marketBasketContinuation),
      )
    ) {
      bestCandidate = {
        requestedSize,
        rawPairCost,
        pairCost,
        ...(basketProjection
          ? {
              marketBasketProjectedEffectivePair: basketProjection.projectedEffectivePair,
              marketBasketProjectedMatchedQty: basketProjection.projectedMatchedQty,
              marketBasketImprovement: basketProjection.improvement,
              marketBasketDebtBeforeUSDC: basketProjection.debtBeforeUSDC,
              marketBasketDebtAfterUSDC: basketProjection.debtAfterUSDC,
              marketBasketDebtDeltaUSDC: basketProjection.debtDeltaUSDC,
            }
          : {}),
        ...(allowance?.marketBasketBootstrap ? { marketBasketBootstrap: true } : {}),
      ...(allowance?.marketBasketContinuation ||
        terminalCarryPairOverride ||
        postCompletionDebtCampaignOverride ||
        xuanBalancedPairContinuationOverride
          ? { marketBasketContinuation: true }
          : {}),
        ...(xuanMicroPairContinuation ? { xuanMicroPairContinuation: true } : {}),
        ...(marketBasketContinuationFairValueFallback
          ? { fairValueFallbackReason: "market_basket_continuation" }
          : {}),
        ...(postCompletionDebtCampaignFairValueFallback
          ? { fairValueFallbackReason: "post_completion_debt_campaign" }
          : {}),
        ...(xuanBalancedPairContinuationOverride
          ? { fairValueFallbackReason: xuanMicroPairContinuation ? "xuan_micro_pair_continuation" : "xuan_balanced_pair_continuation" }
          : {}),
        ...(basketState.balancedButDebted ? { balancedButDebted: true } : {}),
        ...(basketState.campaignActive
          ? {
              campaignMode: "ACCUMULATING_CONTINUATION",
              campaignBaseLot: normalizeTraceNumber(requestedMaxLot),
              plannedContinuationQty: normalizeTraceNumber(requestedSize),
            }
          : {}),
        ...(basketProjection
          ? {
              currentBasketEffectiveAvg: basketState.basketEffectiveAvg,
              deltaAverageCost: basketProjection.improvement,
              deltaAbsoluteDebt: basketProjection.debtDeltaUSDC,
            }
          : {}),
        candidateEffectivePair: cycleTrace.effectivePair,
        edgePerPair: normalizeTraceNumber(edgePerPair),
        ...(qtyNeededToRepayDebt !== undefined ? { qtyNeededToRepayDebt } : {}),
        ...(basketProjection ? { deltaBasketDebt: basketProjection.debtDeltaUSDC } : {}),
        ...(continuationRejectedReason ? { continuationRejectedReason } : {}),
        ...(terminalCarryPairOverride ? { terminalCarryMode: true } : {}),
        deltaTerminalMinPnl: terminalCarryProjection.deltaTerminalMinPnl,
        ...(terminalCarryProjection.deltaTerminalExpectedPnl !== undefined
          ? {
              deltaTerminalExpectedPnl: terminalCarryProjection.deltaTerminalExpectedPnl,
              deltaTerminalEV: terminalCarryProjection.deltaTerminalExpectedPnl,
            }
          : {}),
        ...(terminalCarryProjection.fairValueEVBefore !== undefined
          ? { fairValueEVBefore: terminalCarryProjection.fairValueEVBefore }
          : {}),
        ...(terminalCarryProjection.fairValueEVAfter !== undefined
          ? { fairValueEVAfter: terminalCarryProjection.fairValueEVAfter }
          : {}),
        addedDebtUSDC: terminalCarryProjection.addedDebtUSDC,
        ...(allowance?.continuationClass ? { continuationClass: allowance.continuationClass } : {}),
        ...(allowance?.campaignClipType ? { campaignClipType: allowance.campaignClipType } : {}),
        ...(allowance?.avgImprovingBudgetRemainingUSDC !== undefined
          ? { avgImprovingBudgetRemainingUSDC: allowance.avgImprovingBudgetRemainingUSDC }
          : {}),
        ...(allowance?.avgImprovingClipBudgetRemaining !== undefined
          ? { avgImprovingClipBudgetRemaining: allowance.avgImprovingClipBudgetRemaining }
          : {}),
        ...(allowance?.flowShapingBudgetRemainingUSDC !== undefined
          ? { flowShapingBudgetRemainingUSDC: allowance.flowShapingBudgetRemainingUSDC }
          : {}),
        ...(allowance?.flowShapingClipBudgetRemaining !== undefined
          ? { flowShapingClipBudgetRemaining: allowance.flowShapingClipBudgetRemaining }
          : {}),
        ...(allowance?.campaignFlowCount !== undefined ? { campaignFlowCount: allowance.campaignFlowCount } : {}),
        ...(allowance?.campaignFlowTarget !== undefined ? { campaignFlowTarget: allowance.campaignFlowTarget } : {}),
        ...(allowance?.postCompletionDebtRepairActive ? { postCompletionDebtRepairActive: true } : {}),
        feeUSDC: cycleTrace.feeUSDC,
        expectedNetIfMerged: cycleTrace.expectedNetIfMerged,
        cycleQualityLabel: cycleTrace.cycleQualityLabel,
        mode: selectedMode!,
        negativeEdgeUsdc:
          terminalCarryPairOverride || xuanBalancedPairContinuationOverride
            ? 0
            : allowance?.negativeEdgeUsdc ?? 0,
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

function shouldBlockPublicFootprintMicroCoveredSeedFallback(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  basketState: MarketBasketStateTrace;
  candidateSize: number;
}): boolean {
  if (
    args.config.botMode !== "XUAN" ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.config.xuanBasketCampaignEnabled ||
    !args.config.marketBasketBootstrapEnabled
  ) {
    return false;
  }
  if (args.state.fillHistory.some((fill) => fill.side === "BUY")) {
    return false;
  }
  if (
    args.basketState.mergeableQty > 1e-6 ||
    args.basketState.residualQty > Math.max(args.config.postMergeFlatDustShares, 1e-6)
  ) {
    return false;
  }

  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const minCampaignClipQty = Math.max(
    args.config.microRepairMaxQty + args.state.market.minOrderSize,
    baseLot * Math.max(args.config.campaignMinClipPct, args.config.campaignLaunchXuanProbePct * 0.5),
  );
  return args.candidateSize + 1e-6 < minCampaignClipQty;
}

function shouldAllowPostProfitLowSideCampaignSeed(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  basketState: MarketBasketStateTrace;
  side: OutcomeSide;
  seedPrice: number;
  oppositePrice: number;
  rawPairCost: number;
  referencePairCost: number;
  pairExecutableSize: number;
  oldGap: number;
}): boolean {
  if (
    args.config.botMode !== "XUAN" ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.config.xuanBasketCampaignEnabled ||
    !args.config.marketBasketContinuationEnabled ||
    args.basketState.basketDebtUSDC > args.config.marketBasketMinDebtUsdc + 1e-9 ||
    args.basketState.basketEffectiveAvg > args.config.marketBasketMergeEffectivePairCap + 1e-9 ||
    args.basketState.mergeableQty <= 1e-6 ||
    args.basketState.mergeableQty >= publicFootprintBasketMergeTargetQty(args.config) - 1e-9 ||
    args.basketState.residualQty > Math.max(args.config.postMergeFlatDustShares, 1e-6) + 1e-9 ||
    args.oldGap > Math.max(args.config.postMergeFlatDustShares, 1e-6) + 1e-9 ||
    args.pairExecutableSize <= 0 ||
    !Number.isFinite(args.rawPairCost) ||
    !Number.isFinite(args.referencePairCost)
  ) {
    return false;
  }

  const lowSide = args.seedPrice <= args.oppositePrice;
  const spread = Math.abs(args.seedPrice - args.oppositePrice);
  if (!lowSide || args.seedPrice > args.config.lowSideMaxForHighCompletion + 1e-9) {
    return false;
  }
  if (spread + 1e-9 < args.config.highLowContinuationMinSpread) {
    return false;
  }
  if (args.rawPairCost > args.config.xuanBorderlineRawPairCap + 1e-9) {
    return false;
  }
  return args.referencePairCost <= args.config.xuanBasketCampaignFlowShapingEffectiveCap + 1e-9;
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
  const basketState = marketBasketStateTrace(config, state);
  const basketContinuationDuty =
    config.marketBasketScoringEnabled &&
    config.marketBasketContinuationEnabled &&
    basketState.needsContinuation &&
    (basketState.mergeableQty >= config.marketBasketContinuationMinMatchedShares - 1e-9 || basketState.campaignActive) &&
    ctx.secsToClose > config.xuanMinTimeLeftForHardSweep;
  const ageAwareBorderlineCoveredSeedCap =
    !referencePriorActive &&
    !basketContinuationDuty &&
    config.xuanBorderlineEntryEnabled &&
    Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6)
      ? borderlineEntryMaxQtyForAge(config, ctx)
      : Number.POSITIVE_INFINITY;
  const stagedBorderlineInitialCap =
    !referencePriorActive &&
    !basketContinuationDuty &&
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
    const basketProjection =
      pairExecutableSize > 0
        ? marketBasketProjection(config, state, referencePairCost, pairExecutableSize)
        : undefined;
    const continuationProjection =
      pairExecutableSize > 0
        ? projectMarketBasketContinuation({
            config,
            state,
            costWithFees: referencePairCost,
            candidateSize: pairExecutableSize,
            secsToClose: ctx.secsToClose,
            priceSpread: Math.abs(seedQuote.averagePrice - oppositeQuote.averagePrice),
          })
        : undefined;
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
      highSidePrice: Math.max(seedQuote.averagePrice, oppositeQuote.averagePrice),
      lowSidePrice: Math.min(seedQuote.averagePrice, oppositeQuote.averagePrice),
    };
    skipReason = freshCycleCandidateSkipReason(
      config,
      state,
      freshCycleStats,
      cycleTrace.cycleQualityLabel,
      referencePriorActive,
      freshCycleCandidateContext,
    );
    const postProfitLowSideSetup = shouldAllowPostProfitLowSideCampaignSeed({
      config,
      state,
      basketState,
      side,
      seedPrice: seedQuote.averagePrice,
      oppositePrice: oppositeQuote.averagePrice,
      rawPairCost,
      referencePairCost,
      pairExecutableSize,
      oldGap,
    });
    if (
      postProfitLowSideSetup &&
      (
        skipReason === undefined ||
        skipReason === "fresh_cycle_borderline_pair" ||
        skipReason === "early_mid_pair_repeat_fee_guard" ||
        skipReason === "borderline_same_pattern_repeat"
      )
    ) {
      skipReason = undefined;
    }
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

    const continuationDutyActive = basketState.campaignActive || basketState.balancedButDebted;
    if (
      continuationDutyActive &&
      continuationProjection !== undefined &&
      !continuationProjection.allowed &&
      !postProfitLowSideSetup &&
      (skipReason === undefined ||
        skipReason === "fresh_cycle_borderline_pair" ||
        skipReason === "fresh_cycle_bad_pair")
    ) {
      skipReason = continuationProjection.rejectedReason ?? "market_basket_continuation_rejected";
    }

    const selectedMode: StrategyExecutionMode = "PAIRGROUP_COVERED_SEED";
    const useStagedBorderlineEntry =
      borderlineCoveredSeedAllowed &&
      config.borderlinePairStagedEntryEnabled &&
      requiresSamePairgroupOppositeOrder &&
      !canUseInventoryCover;
    const useStagedPostProfitLowSideEntry =
      postProfitLowSideSetup &&
      requiresSamePairgroupOppositeOrder &&
      !canUseInventoryCover;

    if (
      skipReason === undefined &&
      !postProfitLowSideSetup &&
      shouldBlockLowSideUnpairedBasketDebtSeed({
        config,
        state,
        basketState,
        side,
        seedPrice: seedQuote.averagePrice,
        oldGap,
        canUseInventoryCover,
        useStagedBorderlineEntry,
        basketProjection,
      })
    ) {
      skipReason = "low_side_unpaired_basket_debt";
    }

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
      : postProfitLowSideSetup && baseFairValueDecision.reason === "fair_value_missing"
        ? "post_profit_low_side_setup"
      : undefined;
    if (
      skipReason === undefined &&
      fairValueFallbackReason &&
      shouldBlockPublicFootprintMicroCoveredSeedFallback({
        config,
        state,
        basketState,
        candidateSize: pairExecutableSize > 0 ? pairExecutableSize : candidateSize,
      })
    ) {
      skipReason = "xuan_micro_covered_seed_fallback";
    }
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
      ...(basketProjection
        ? {
            marketBasketProjectedEffectivePair: basketProjection.projectedEffectivePair,
            marketBasketProjectedMatchedQty: basketProjection.projectedMatchedQty,
            marketBasketImprovement: basketProjection.improvement,
            marketBasketDebtBeforeUSDC: basketProjection.debtBeforeUSDC,
            marketBasketDebtAfterUSDC: basketProjection.debtAfterUSDC,
            marketBasketDebtDeltaUSDC: basketProjection.debtDeltaUSDC,
          }
        : {}),
      ...(continuationProjection
        ? {
            continuationClass: continuationProjection.continuationClass,
            campaignClipType: continuationProjection.campaignClipType,
            avgImprovingBudgetRemainingUSDC: continuationProjection.avgImprovingBudgetRemainingUSDC,
            avgImprovingClipBudgetRemaining: continuationProjection.avgImprovingClipBudgetRemaining,
            flowShapingBudgetRemainingUSDC: continuationProjection.flowShapingBudgetRemainingUSDC,
            flowShapingClipBudgetRemaining: continuationProjection.flowShapingClipBudgetRemaining,
            campaignFlowCount: continuationProjection.campaignFlowCount,
            campaignFlowTarget: continuationProjection.campaignFlowTarget,
            addedDebtUSDC: continuationProjection.addedDebtUSDC,
          }
        : {}),
      ...(borderlinePolicy ? { xuanBorderlinePhase: borderlinePolicy.phase } : {}),
      ...(fairValueFallbackReason ? { fairValueFallbackReason } : {}),
      ...(postProfitLowSideSetup ? { postProfitLowSideSetup: true } : {}),
      ...(useStagedBorderlineEntry
        ? {
            stagedEntry: true,
            plannedOppositeSide: oppositeSide,
            plannedOppositeQty: pairExecutableSize,
          }
        : {}),
      ...(useStagedPostProfitLowSideEntry
        ? {
            stagedEntry: true,
            plannedOppositeSide: oppositeSide,
            plannedOppositeQty: pairExecutableSize,
          }
        : {}),
      ...(skipReason === "fresh_cycle_borderline_pair" ||
      skipReason === "fresh_cycle_bad_pair" ||
      skipReason === "borderline_same_pattern_repeat" ||
      skipReason === "opening_weak_pair_no_followup_plan" ||
      skipReason === "early_mid_pair_repeat_fee_guard" ||
      skipReason === "low_side_unpaired_basket_debt" ||
      skipReason === "xuan_micro_covered_seed_fallback" ||
      skipReason === "avg_improving_pair_too_expensive" ||
      skipReason === "avg_improving_spread_too_small" ||
      skipReason === "avg_improving_clip_budget_exhausted" ||
      skipReason === "avg_improving_budget_exhausted" ||
      skipReason === "avg_improving_qty_cap" ||
      skipReason === "flow_shaping_flow_target_met" ||
      skipReason === "flow_shaping_clip_budget_exhausted" ||
      skipReason === "flow_shaping_budget_exhausted" ||
      skipReason === "flow_shaping_qty_cap" ||
      skipReason === "debt_reducing_qty_cap" ||
      skipReason === "high_low_effective_not_debt_reducing" ||
      skipReason === "continuation_not_debt_reducing_or_avg_improving" ||
      skipReason === "market_basket_continuation_rejected"
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
      decisions = useStagedBorderlineEntry || useStagedPostProfitLowSideEntry
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
    config.botMode === "XUAN" &&
    (
      config.clipSplitMode === "DEPTH_ADAPTIVE_XUAN_BIAS" ||
      (config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE")
    )
      ? buildXuanClipSizeCandidates(maxCandidateSize, minOrderSize)
      : [];
  const debtReducingVwapTiers =
    config.botMode === "XUAN"
      ? config.campaignLaunchVwapTiers
      : [];
  const normalized = Array.from(
    new Set(
      [...xuanClipSizes, ...debtReducingVwapTiers, ...ladder, maxCandidateSize]
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
  for (const tier of [5, 10, 20, 40, 80, 160, 300]) {
    if (maxCandidateSize >= tier) {
      candidates.push(tier);
    }
  }
  if (maxCandidateSize >= 30) {
    candidates.push(10, 15);
    candidates.push(maxCandidateSize * 0.25, maxCandidateSize * 0.5);
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
  rawPairCost: number,
  pairCost: number,
  preferLargeBasketClip: boolean,
): boolean {
  if (!current) {
    return true;
  }
  if (preferLargeBasketClip && requestedSize > current.requestedSize) {
    return true;
  }
  if (
    isStrongMarketBasketPair(config, current.rawPairCost, current.pairCost) &&
    isStrongMarketBasketPair(config, rawPairCost, pairCost) &&
    requestedSize > current.requestedSize &&
    pairCost <= current.pairCost + config.marketBasketStrongMaxDegradation + 1e-9
  ) {
    return true;
  }
  if (
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE" &&
    requestedSize > current.requestedSize &&
    pairCost <= config.campaignLaunchXuanProbeEffectiveCap + 1e-9 &&
    pairCost <= current.pairCost + config.marketBasketStrongMaxDegradation + 1e-9
  ) {
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
  if (gateReasons.has("high_low_effective_not_debt_reducing")) return "high_low_effective_not_debt_reducing";
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

interface BalancedPairEntryPlan {
  decisions: EntryBuyDecision[];
  stateAfter: InventoryTraceState;
  tracePatch: Partial<EntryDecisionTrace>;
}

function isAggressivePublicFootprint(config: Pick<XuanStrategyConfig, "botMode" | "xuanCloneMode" | "xuanCloneIntensity">): boolean {
  return config.botMode === "XUAN" && config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE";
}

function hasExactSameSecondDualSeedPrior(marketSlug: string, secsFromOpen: number): boolean {
  const exact = resolveBundledExactReference(marketSlug);
  if (!exact) {
    return false;
  }
  const sides = new Set(
    exact.orderedClipSequence
      .filter(
        (event) =>
          event.kind === "BUY" &&
          event.outcome !== null &&
          (event.phase === "ENTRY" || event.phase === "OVERLAP") &&
          Math.abs(event.tOffsetSec - secsFromOpen) <= 0.5,
      )
      .map((event) => event.outcome),
  );
  return sides.has("UP") && sides.has("DOWN");
}

function preferredStagedPairSeedSide(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  secsFromOpen: number,
  candidate: BalancedPairCandidate,
): OutcomeSide {
  const sequencePrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledSeedSequencePrior(state.market.slug, secsFromOpen)
      : undefined;
  if (
    sequencePrior &&
    secsFromOpen >= sequencePrior.activeFromSec - 1e-9 &&
    secsFromOpen <= sequencePrior.activeUntilSec + 1e-9
  ) {
    return sequencePrior.side;
  }

  const shareGap = state.upShares - state.downShares;
  if (Math.abs(shareGap) >= Math.max(state.market.minOrderSize, config.completionMinQty) - 1e-9) {
    return shareGap > 0 ? "DOWN" : "UP";
  }

  return candidate.upExecution.averagePrice <= candidate.downExecution.averagePrice ? "UP" : "DOWN";
}

function plannedOppositeMinWaitSec(config: XuanStrategyConfig): number {
  if (!isAggressivePublicFootprint(config)) {
    return 0;
  }
  return Math.min(
    25,
    Math.max(config.xuanTemporalCompletionMinAgeSec, config.xuanRhythmMaxWaitSec * 2),
  );
}

function plannedOppositeTargetPrice(config: XuanStrategyConfig, seedPrice: number, currentOppositePrice: number): number {
  const targetPairCap = Math.min(
    config.xuanBehaviorCap,
    Math.max(1.01, Math.min(config.marketBasketGoodAvgCap, config.xuanTemporalCompletionEarlyMaxEffectivePair)),
  );
  const target = Math.max(0.01, targetPairCap - seedPrice);
  return normalizeTraceNumber(Math.min(currentOppositePrice, target));
}

function buildAggressiveStagedPairSeed(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  secsFromOpen: number;
  candidate: BalancedPairCandidate;
  feeRate: number;
  reason: EntryBuyReason;
}): BalancedPairEntryPlan | undefined {
  if (
    !isAggressivePublicFootprint(args.config) ||
    args.candidate.mode === "STRICT_PAIR_SWEEP" ||
    hasExactSameSecondDualSeedPrior(args.state.market.slug, args.secsFromOpen)
  ) {
    return undefined;
  }
  const sequencePrior = resolveBundledSeedSequencePrior(args.state.market.slug, args.secsFromOpen);
  if (sequencePrior?.scope === "exact") {
    return undefined;
  }

  const seedSide = preferredStagedPairSeedSide(args.config, args.state, args.secsFromOpen, args.candidate);
  const oppositeSide: OutcomeSide = seedSide === "UP" ? "DOWN" : "UP";
  const seedExecution = seedSide === "UP" ? args.candidate.upExecution : args.candidate.downExecution;
  const oppositeExecution = oppositeSide === "UP" ? args.candidate.upExecution : args.candidate.downExecution;
  const decision = buildEntryBuy(
    args.state,
    seedSide,
    seedExecution,
    args.reason,
    "PAIRGROUP_COVERED_SEED",
    args.feeRate,
    args.candidate.pairCost,
    0,
    args.candidate.rawPairCost,
  );
  const minWaitSec = plannedOppositeMinWaitSec(args.config);
  const deadlineSec = Math.min(
    Math.max(args.secsFromOpen + minWaitSec, args.secsFromOpen + args.config.completionTargetMaxDelaySec),
    282,
  );

  return {
    decisions: [decision],
    stateAfter: projectedStateAfterCycleBuys(
      args.state,
      seedSide === "UP" ? decision.size : 0,
      seedSide === "DOWN" ? decision.size : 0,
      seedSide === "UP" ? decision.expectedAveragePrice : 0,
      seedSide === "DOWN" ? decision.expectedAveragePrice : 0,
    ),
    tracePatch: {
      selectedMode: "PAIRGROUP_COVERED_SEED",
      stagedEntry: true,
      plannedOppositeSide: oppositeSide,
      plannedOppositeQty: args.candidate.requestedSize,
      plannedOppositeMissingQty: args.candidate.requestedSize,
      plannedPairGroupOpenedAt: args.state.market.startTs + args.secsFromOpen,
      plannedLowSideAvg: seedExecution.averagePrice,
      plannedOppositeMinWaitSec: minWaitSec,
      plannedOppositeDeadlineSec: deadlineSec,
      plannedOppositeMaxPrice: plannedOppositeTargetPrice(args.config, seedExecution.averagePrice, oppositeExecution.averagePrice),
      childOrderIntendedSide: seedSide,
      childOrderSelectedSide: seedSide,
      childOrderReason: "covered_seed_priority",
      semanticRoleTarget: "high_low_setup",
    },
  };
}

function buildBalancedPairEntryPlan(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  secsFromOpen: number,
  childOrderMicroTimingBias: EntryLadderContext["childOrderMicroTimingBias"],
  semanticRoleAlignmentBias: EntryLadderContext["semanticRoleAlignmentBias"],
  candidate: BalancedPairCandidate,
  feeRate: number,
  reason: EntryBuyReason,
  options: { allowAggressiveStagedPair?: boolean } = {},
): BalancedPairEntryPlan {
  const staged =
    options.allowAggressiveStagedPair !== false
      ? buildAggressiveStagedPairSeed({ config, state, secsFromOpen, candidate, feeRate, reason })
      : undefined;
  if (staged) {
    return staged;
  }

  return {
    decisions: buildBalancedPairEntryBuys(
      config,
      state,
      secsFromOpen,
      childOrderMicroTimingBias,
      candidate,
      feeRate,
      reason,
    ),
    stateAfter: projectedStateAfterCycleBuys(
      state,
      candidate.requestedSize,
      candidate.requestedSize,
      candidate.upExecution.averagePrice,
      candidate.downExecution.averagePrice,
    ),
    tracePatch: {
      ...balancedPairChildOrderTrace(config, state, secsFromOpen, childOrderMicroTimingBias, candidate),
      semanticRoleTarget: semanticRoleTargetForPair(
        candidate.upExecution.averagePrice,
        candidate.downExecution.averagePrice,
        semanticRoleAlignmentBias,
      ),
    },
  };
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

function buildStagedDebtReducingFlowSeed(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  ctx: EntryLadderContext;
  basketState: MarketBasketStateTrace;
  candidate: BalancedPairCandidate;
}): { decision: EntryBuyDecision; plannedOppositeSide: OutcomeSide; plannedOppositeQty: number } | undefined {
  if (
    args.config.botMode !== "XUAN" ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.config.xuanBasketCampaignEnabled ||
    !args.config.marketBasketContinuationEnabled ||
    args.ctx.secsToClose <= args.config.finalWindowCompletionOnlySec ||
    !(args.basketState.balancedButDebted || args.basketState.campaignActive) ||
    Math.abs(args.state.upShares - args.state.downShares) > Math.max(args.config.postMergeFlatDustShares, 1e-6)
  ) {
    return undefined;
  }
  if (
    !args.candidate.marketBasketContinuation ||
    args.candidate.continuationClass !== "DEBT_REDUCING" ||
    args.candidate.campaignClipType !== "STRONG_HIGH_LOW_CONTINUATION" ||
    args.candidate.pairCost >= args.config.highLowDebtReducingEffectiveCap - 1e-9
  ) {
    return undefined;
  }
  const flowCount = args.candidate.campaignFlowCount ?? 0;
  const flowTarget = args.candidate.campaignFlowTarget ?? args.config.xuanBasketCampaignMinFlows;
  if (flowCount >= flowTarget) {
    return undefined;
  }
  const upPrice = args.candidate.upExecution.averagePrice;
  const downPrice = args.candidate.downExecution.averagePrice;
  const spread = Math.abs(upPrice - downPrice);
  const lowSide: OutcomeSide = upPrice <= downPrice ? "UP" : "DOWN";
  const highSide: OutcomeSide = lowSide === "UP" ? "DOWN" : "UP";
  const lowExecution = lowSide === "UP" ? args.candidate.upExecution : args.candidate.downExecution;
  const lowPrice = lowSide === "UP" ? upPrice : downPrice;
  if (
    spread + 1e-9 < args.config.highLowContinuationMinSpread ||
    lowPrice > args.config.lowSideMaxForHighCompletion + 0.06 + 1e-9
  ) {
    return undefined;
  }
  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  if (args.candidate.requestedSize < baseLot * args.config.xuanBasketCampaignAvgImprovementQtyMultiplier - 1e-9) {
    return undefined;
  }
  return {
    decision: buildEntryBuy(
      args.state,
      lowSide,
      lowExecution,
      "temporal_single_leg_seed",
      "TEMPORAL_SINGLE_LEG_SEED",
      args.config.cryptoTakerFeeRate,
      args.candidate.pairCost,
      args.candidate.negativeEdgeUsdc,
      args.candidate.rawPairCost,
    ),
    plannedOppositeSide: highSide,
    plannedOppositeQty: args.candidate.requestedSize,
  };
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

function shouldAllowMarketBasketContinuationFairValueFallback(args: {
  config: XuanStrategyConfig;
  allowance: ReturnType<typeof pairSweepAllowance> | undefined;
  marketBasketFairValueFallbackEligible: boolean;
  secsToClose: number;
  reasons: string[];
}): boolean {
  if (
    !args.config.allowMarketBasketContinuationWithoutFairValue ||
    !args.allowance?.allowed ||
    !args.allowance.marketBasketContinuation ||
    !args.marketBasketFairValueFallbackEligible ||
    args.secsToClose <= args.config.finalWindowCompletionOnlySec ||
    args.reasons.length === 0
  ) {
    return false;
  }

  return args.reasons.every((reason) => reason === "fair_value_missing" || reason === "fair_value_missing_side");
}

function normalizeOrderSize(size: number, minOrderSize: number): number {
  const normalized = Number(size.toFixed(6));
  if (normalized < minOrderSize) {
    return 0;
  }
  return normalized;
}
