import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig, type XuanStrategyConfig } from "../config/strategyPresets.js";
import { createClobAdapter } from "../infra/clob/index.js";
import type { MarketInfo, OrderBook, OutcomeSide, TradeSide } from "../infra/clob/types.js";
import type { MarketOrderArgs, OrderResult } from "../infra/clob/types.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { Erc1155BalanceReader } from "../infra/polygon/erc1155Balances.js";
import { Erc20BalanceReader } from "../infra/polygon/erc20Balances.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { UserWsClient, type UserOrderEvent, type UserTradeEvent } from "../infra/ws/userWsClient.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { BtcPriceFeed } from "../infra/ws/btcPriceFeed.js";
import { SystemClock } from "../infra/time/clock.js";
import { CtfClient } from "../infra/ctf/ctfClient.js";
import { createLogger, writeStructuredLog } from "../observability/logger.js";
import { JsonlTraceLogger } from "../observability/jsonlTrace.js";
import { renderDashboard } from "../observability/dashboard.js";
import { OrderManager } from "../execution/orderManager.js";
import {
  applyPairOrderType,
  createPairOrderGroup,
  extractMatchedShares,
  finalizePairExecutionResult,
  resolvePairOrderGroupStatus,
  type PairExecutionResult,
  type PairOrderGroup,
  type PairOrderGroupStatus,
} from "../execution/pairOrderGroup.js";
import { TakerCompletionManager } from "../execution/takerCompletionManager.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import {
  countActiveIndependentFlowCount as countActiveIndependentFlowCountFromHistory,
  countRecentSeedFlowCount as countRecentSeedFlowCountFromHistory,
  createMarketState,
  type FillRecord,
  type XuanMarketState,
} from "../strategy/xuan5m/marketState.js";
import { applyFill, applyMerge, averageCost, shrinkOutcomeToObservedShares } from "../strategy/xuan5m/inventoryState.js";
import { chooseInventoryAdjustment } from "../strategy/xuan5m/completionEngine.js";
import {
  createMergeBatchTracker,
  evaluateDelayedMergeGate,
  planMerge,
  syncMergeBatchTracker,
} from "../strategy/xuan5m/mergeCoordinator.js";
import {
  classifyFlowPressureBudget,
  classifyResidualSeverity,
  deriveFlowPressureBudget,
  deriveFlowPressureBudgetState,
  estimateNegativeEdgeUsdc,
  resolveResidualBehaviorState,
  type OverlapRepairArbitration,
} from "../strategy/xuan5m/modePolicy.js";
import type { FlowPressureBudgetState } from "../strategy/xuan5m/modePolicy.js";
import { resolveBundledMergeClusterPrior } from "../analytics/xuanExactReference.js";
import {
  buildFlowCalibrationSummary,
  XUAN_FLOW_CALIBRATION_VERSION,
  type ComparisonFlowSummary,
  type FlowCalibrationSummary,
} from "../analytics/xuanReplayComparator.js";
import { resolveConfiguredFunderAddress } from "./topology.js";
import { isClassifiedBuyMode, type StrategyExecutionMode } from "../strategy/xuan5m/executionModes.js";
import type { EntryBuyDecision } from "../strategy/xuan5m/entryLadderEngine.js";
import {
  buildInventoryActionPlan,
  executeInventoryActionPlan,
  fetchInventorySnapshot,
  type InventoryMarketView,
} from "./inventoryManager.js";
import { isOrderResultAccepted, summarizeOrderResult } from "../infra/clob/orderResult.js";
import {
  PersistentStateStore,
  type PersistedArbitrationCarrySnapshot,
  type PersistedFlowBudgetSnapshot,
  type ValidationRunRecord,
} from "./persistentStateStore.js";
import { MarketFairValueRuntime } from "./fairValueRuntime.js";
import type { FairValueSnapshot } from "../strategy/xuan5m/fairValueEngine.js";
import { planCloneChildBuyOrders } from "./childOrderPlanner.js";

export interface BotSessionOptions {
  durationSec?: number;
  postCloseReconcileSec?: number;
  tickMs?: number;
  initialBookWaitMs?: number;
  balanceSyncMs?: number;
  marketSelection?: "auto" | "current" | "next";
  initialDailyNegativeEdgeSpentUsdc?: number;
  dailyBudgetStorePath?: string;
}

export interface ObservedTokenBalances {
  up: number;
  down: number;
}

export interface BalanceCorrection {
  outcome: OutcomeSide;
  fromShares: number;
  toShares: number;
}

export interface BalanceShortfallCandidate extends BalanceCorrection {
  nowTs: number;
}

export interface StateReconcileResult {
  state: XuanMarketState;
  inferredFills: FillRecord[];
  corrections: BalanceCorrection[];
}

export interface SubmittedIntent {
  side: TradeSide;
  price?: number | undefined;
  submittedAt: number;
  mode?: StrategyExecutionMode | undefined;
  groupId?: string | undefined;
  orderId?: string | undefined;
  expectedShares?: number | undefined;
  attributedShares: number;
  active: boolean;
}

type SubmittedIntentBook = Partial<Record<OutcomeSide, SubmittedIntent[]>>;

interface ExecutedMarketOrder {
  order: MarketOrderArgs;
  result: OrderResult;
}

type PairOrderPlan = Record<OutcomeSide, MarketOrderArgs[]>;

export interface BotSessionReport {
  runtime: {
    mode: "live";
    stackMode: AppEnv["POLY_STACK_MODE"];
    useClobV2: boolean;
    clobBaseUrl: string;
    signatureType: number;
    funder: string;
    activeCollateralToken: string;
    activeCollateralSymbol: AppEnv["ACTIVE_COLLATERAL_SYMBOL"];
    ctfMergeEnabled: boolean;
  };
  market: {
    selection: "current" | "next";
    slug: string;
    conditionId: string;
    startTs: number;
    endTs: number;
    upTokenId: string;
    downTokenId: string;
  };
  options: Required<BotSessionOptions>;
  summary: {
    startedAt: number;
    endedAt: number;
    ticks: number;
    userTradeCount: number;
    balanceSyncCount: number;
    balanceCorrectionCount: number;
    entrySubmitCount: number;
    pairGroupCount: number;
    partialLegCount: number;
    completionSubmitCount: number;
    unwindSubmitCount: number;
    mergeCount: number;
    adoptedInventory: boolean;
    arbitrationCarryCreatedCount: number;
    arbitrationCarryExtendedCount: number;
    arbitrationCarryExpiredCount: number;
    entryArbitrationActionDeltaCount: number;
    arbitrationCarryExtensionRate: number;
    entryArbitrationActionDeltaRate: number;
  };
  finalState: {
    upShares: number;
    downShares: number;
    upAverage: number;
    downAverage: number;
    fillCount: number;
    mergeCount: number;
    negativeEdgeConsumedUsdc: number;
    negativePairEdgeConsumedUsdc: number;
    negativeCompletionEdgeConsumedUsdc: number;
    initialDailyNegativeEdgeSpentUsdc: number;
    finalDailyNegativeEdgeSpentUsdc: number;
  };
  finalDecision: ReturnType<Xuan5mBot["evaluateTick"]>;
  dashboard: string;
  events: Array<Record<string, unknown>>;
}

interface PendingPairExecution {
  group: PairOrderGroup;
  upResult: PairExecutionResult["upResult"];
  downResult: PairExecutionResult["downResult"];
  negativeEdgeUsdc: number;
  deadlineAt: number;
  status: PairOrderGroupStatus;
  submittedAt: number;
  reconciledAfterSubmit: boolean;
}

interface PartialOpenGroupLock {
  groupId: string;
  status: Extract<PairOrderGroupStatus, "UP_ONLY" | "DOWN_ONLY">;
  openedAt: number;
  protectedSide: OutcomeSide;
  protectedShares: number;
}

export interface RuntimeProtectedResidualLock {
  openedAt: number;
  protectedSide: OutcomeSide;
  protectedShares: number;
  sourceMode: Extract<StrategyExecutionMode, "TEMPORAL_SINGLE_LEG_SEED" | "PAIRGROUP_COVERED_SEED">;
}

interface ArbitrationCarry {
  createdAt: number;
  recommendation: Extract<OverlapRepairArbitration, "favor_independent_overlap" | "favor_residual_repair">;
  preferredSeedSide?: OutcomeSide | undefined;
  protectedResidualSide: OutcomeSide;
  referenceShareGap: number;
  alignmentStreak: number;
  lastObservedAt: number;
  lastProtectedShares: number;
  expiresAt: number;
  residualSeverityLevel?: "flat" | "micro" | "small" | "medium" | "aggressive" | undefined;
}

interface ActivePairSubmission {
  groupId: string;
  expiresAt: number;
  entries: Array<{
    outcome: OutcomeSide;
    price?: number | undefined;
    expectedShares?: number | undefined;
    mode?: StrategyExecutionMode | undefined;
  }>;
}

interface RecentBotOwnedBuyFill {
  outcome: OutcomeSide;
  size: number;
  price: number;
  timestamp: number;
  expiresAt: number;
  groupId?: string | undefined;
  orderId?: string | undefined;
}

const DECISION_TRACE_INTERVAL_SEC = 20;
const BOT_OWNED_ZERO_BALANCE_GRACE_SEC = 3;

interface DecisionTraceContext {
  eventSeq: number;
  decisionLatencyMs: number;
  bookAgeMsUp: number;
  bookAgeMsDown: number;
  arbitrationCarryRecommendation?: OverlapRepairArbitration | undefined;
  arbitrationCarryPreferredSeedSide?: OutcomeSide | undefined;
  runtimeFlowBudgetState?: RuntimeFlowBudgetState | undefined;
  runtimeFlowBudgetLastLineage?: string | undefined;
  runtimeFlowBudgetDominantLineageLoad?: number | undefined;
  runtimeFlowCalibrationBias?: RuntimeFlowCalibrationBias | undefined;
}

export interface RuntimeFlowBudgetState extends FlowPressureBudgetState {
  matchedInventoryQuality: number;
  unlockedMatchedInventoryQuality: number;
  carryFlowConfidence: number;
  recentSeedFlowCount: number;
  activeIndependentFlowCount: number;
  residualSeverityPressure: number;
  reservedBudget: number;
  flowLoadReserve: number;
  mergeReserve: number;
  residualReserve: number;
  pendingExecutionReserve: number;
  realizedActionReserve: number;
  lineageActionReserve: number;
}

export interface RuntimeFlowCalibrationBias {
  lineageFlowCountBonus: number;
  activeFlowCountBonus: number;
  semanticRoleFlowCountBonus: number;
  completionPatienceFlowCountBonus: number;
  completionPatienceMultiplier: number;
  completionReleaseBias: "neutral" | "earlier" | "later";
  semanticRoleAlignmentBias: "neutral" | "align_high_low_role" | "preserve_raw_side" | "cycle_role_arbitration";
  childOrderMicroTimingBias: "neutral" | "flow_intent";
  completionRoleReleaseOrderBias: "neutral" | "role_order";
  openingSeedReleaseBias: "neutral" | "earlier" | "later";
  openingSeedOffsetShiftSec: number;
  overlapCadenceCompressionBonus: number;
  childOrderDispatchDelayCapMs?: number | undefined;
  recommendedFocus: string[];
}

interface RuntimeChildOrderDispatchSummary {
  pairSubmitCount: number;
  sequentialPairSubmitCount: number;
  flowIntentPairSubmitCount: number;
  compressedPairSubmitCount: number;
  averageInterChildDelayMs: number | null;
  maxInterChildDelayMs: number | null;
}

const MIN_RUNTIME_CHILD_ORDER_FLOW_INTENT_SAMPLES = 2;

function extractFlowSummariesFromValidationRuns(runs: ValidationRunRecord[]): ComparisonFlowSummary[] {
  const acceptedByFootprint = new Map<string, number>();
  return runs
    .filter(
      (run) => {
        if (
          run.payload?.flowCalibrationVersion !== XUAN_FLOW_CALIBRATION_VERSION ||
          run.payload?.flowCalibrationAccepted === false ||
          (run.payload?.flowStatus as { status?: unknown } | undefined)?.status === "FAIL"
        ) {
          return false;
        }
        const footprintKey = [
          String(run.payload?.command ?? "unknown"),
          String(run.payload?.variant ?? "runtime"),
          String(run.payload?.referenceSlug ?? run.payload?.marketSlug ?? "unknown"),
        ].join(":");
        const acceptedCount = acceptedByFootprint.get(footprintKey) ?? 0;
        if (acceptedCount >= 3) {
          return false;
        }
        acceptedByFootprint.set(footprintKey, acceptedCount + 1);
        return true;
      },
    )
    .map((run) => run.payload?.flowSummary)
    .filter((summary): summary is ComparisonFlowSummary => {
      if (!summary || typeof summary !== "object") {
        return false;
      }
      const candidate = summary as Partial<Record<keyof ComparisonFlowSummary, unknown>>;
      return (
        typeof candidate.flowLineageSimilarity === "number" &&
        typeof candidate.activeFlowPeakSimilarity === "number" &&
        typeof candidate.cycleCompletionLatencySimilarity === "number"
      );
    });
}

function extractRuntimeChildOrderDispatchSummaries(runs: ValidationRunRecord[]): RuntimeChildOrderDispatchSummary[] {
  const acceptedByFootprint = new Map<string, number>();
  return runs
    .filter((run) => run.payload?.flowCalibrationVersion === XUAN_FLOW_CALIBRATION_VERSION)
    .flatMap((run) => {
      const payload = run.payload ?? {};
      const footprintKey = [
        String(payload.command ?? "unknown"),
        String(payload.referenceSlug ?? payload.marketSlug ?? "unknown"),
      ].join(":");
      const acceptedCount = acceptedByFootprint.get(footprintKey) ?? 0;
      if (acceptedCount >= 3) {
        return [];
      }
      const candidate =
        payload.runtimeChildOrderDispatch ??
        (payload.runtimeDataStatus as { diagnostics?: { childOrderDispatch?: unknown } } | undefined)?.diagnostics
          ?.childOrderDispatch;
      if (!candidate || typeof candidate !== "object") {
        return [];
      }
      const summary = candidate as Partial<RuntimeChildOrderDispatchSummary>;
      if (
        typeof summary.pairSubmitCount !== "number" ||
        typeof summary.sequentialPairSubmitCount !== "number" ||
        typeof summary.flowIntentPairSubmitCount !== "number" ||
        typeof summary.compressedPairSubmitCount !== "number"
      ) {
        return [];
      }
      acceptedByFootprint.set(footprintKey, acceptedCount + 1);
      return [
        {
          pairSubmitCount: summary.pairSubmitCount,
          sequentialPairSubmitCount: summary.sequentialPairSubmitCount,
          flowIntentPairSubmitCount: summary.flowIntentPairSubmitCount,
          compressedPairSubmitCount: summary.compressedPairSubmitCount,
          averageInterChildDelayMs:
            typeof summary.averageInterChildDelayMs === "number" ? summary.averageInterChildDelayMs : null,
          maxInterChildDelayMs: typeof summary.maxInterChildDelayMs === "number" ? summary.maxInterChildDelayMs : null,
        },
      ];
    });
}

function deriveRuntimeChildOrderDispatchDelayCapMs(summaries: RuntimeChildOrderDispatchSummary[]): number | undefined {
  const flowIntentSummaries = summaries.filter((summary) => summary.flowIntentPairSubmitCount > 0);
  const flowIntentPairSubmitCount = flowIntentSummaries.reduce(
    (total, summary) => total + summary.flowIntentPairSubmitCount,
    0,
  );
  if (flowIntentPairSubmitCount < MIN_RUNTIME_CHILD_ORDER_FLOW_INTENT_SAMPLES) {
    return undefined;
  }
  const hasUncompressedFlowIntent = flowIntentSummaries.some(
    (summary) => summary.compressedPairSubmitCount < summary.flowIntentPairSubmitCount,
  );
  const maxObservedDelayMs = Math.max(
    ...flowIntentSummaries.map((summary) => summary.maxInterChildDelayMs ?? 0),
  );
  if (hasUncompressedFlowIntent || maxObservedDelayMs > 40) {
    return 40;
  }
  return undefined;
}

export function deriveRuntimeFlowCalibrationBias(
  calibration: Pick<FlowCalibrationSummary, "recommendedFocus" | "status"> &
    Partial<
      Pick<
        FlowCalibrationSummary,
        | "completionLatencyDirection"
        | "openingEntryTimingDirection"
        | "averageFirstEntryOffsetDeltaSec"
        | "averageSideSequenceMismatchOffsetDeltaSec"
        | "averageChildOrderGlobalAbsDelayP75Sec"
        | "averageChildOrderMicroTimingMaxAbsDeltaSec"
        | "averageChildOrderSideInversionCount"
        | "averageCycleCompletionLatencyDeltaSec"
        | "averageCycleCompletionLatencyDeltaP50Sec"
        | "averageCycleCompletionLatencyDeltaP75Sec"
      >
    >,
): RuntimeFlowCalibrationBias {
  const focus = new Set(calibration.recommendedFocus);
  const enabled = calibration.status === "WARN" || calibration.status === "FAIL";
  const coldStartCalibration = enabled && focus.has("collect_replay_flow_samples");
  const maintainEarlyOpening = enabled && focus.has("maintain_opening_seed_early");
  const releaseEarlier = enabled && (focus.has("release_completion_earlier") || calibration.completionLatencyDirection === "candidate_late");
  const waitLonger = enabled && (focus.has("increase_completion_patience") || calibration.completionLatencyDirection === "candidate_early");
  const tuneCompletionTail =
    enabled &&
    focus.has("tune_completion_patience_and_release") &&
    calibration.averageCycleCompletionLatencyDeltaP50Sec !== undefined &&
    Math.abs(calibration.averageCycleCompletionLatencyDeltaP50Sec) <= 2;
  const alignHighLowRole = enabled && focus.has("align_high_low_role_sequence");
  const tuneCompletionRoleReleaseOrder = enabled && focus.has("tune_completion_role_release_order");
  const improveChildOrderMicroTiming =
    enabled &&
    (focus.has("improve_child_order_micro_timing") ||
      focus.has("compress_child_order_timing") ||
      focus.has("stabilize_child_order_side_rhythm") ||
      tuneCompletionRoleReleaseOrder);
  const preserveRawSide =
    enabled &&
    (focus.has("preserve_raw_side_before_role_override") ||
      focus.has("guard_role_alignment_against_side_regression") ||
      focus.has("improve_seed_side_rhythm"));
  const cycleRoleArbitration =
    (alignHighLowRole || tuneCompletionRoleReleaseOrder) && preserveRawSide && improveChildOrderMicroTiming;
  const releaseOpeningEarlier =
    enabled &&
    (focus.has("release_opening_seed_earlier") ||
      (calibration.openingEntryTimingDirection === "candidate_late" &&
        Math.abs(calibration.averageFirstEntryOffsetDeltaSec ?? 0) >= 4));
  const delayOpeningRelease =
    enabled &&
    (focus.has("delay_opening_seed_release") ||
      (calibration.openingEntryTimingDirection === "candidate_early" &&
        Math.abs(calibration.averageFirstEntryOffsetDeltaSec ?? 0) >= 4));
  const latencyDeltaSec = Math.abs(
    calibration.averageCycleCompletionLatencyDeltaP75Sec ?? calibration.averageCycleCompletionLatencyDeltaSec ?? 0,
  );
  const openingOffsetDeltaSec = Math.abs(calibration.averageFirstEntryOffsetDeltaSec ?? 0);
  const sideMismatchOffsetDeltaSec = Math.abs(calibration.averageSideSequenceMismatchOffsetDeltaSec ?? 0);
  const childOrderCadenceDeltaSec = Math.max(
    calibration.averageChildOrderGlobalAbsDelayP75Sec ?? 0,
    (calibration.averageChildOrderMicroTimingMaxAbsDeltaSec ?? 0) * 0.55,
  );
  const childOrderSideInversionPressure = (calibration.averageChildOrderSideInversionCount ?? 0) > 0 ? 1 : 0;
  const openingSeedOffsetShiftSec = coldStartCalibration || maintainEarlyOpening
    ? 6
    : releaseOpeningEarlier
      ? Math.min(8, Math.max(6, Math.round(openingOffsetDeltaSec)))
      : delayOpeningRelease
        ? -Math.min(8, Math.max(2, Math.round(openingOffsetDeltaSec)))
        : 0;
  let completionPatienceMultiplier = 1;
  if (coldStartCalibration || (tuneCompletionTail && latencyDeltaSec >= 4)) {
    completionPatienceMultiplier = 0.63;
  } else if (releaseEarlier) {
    const tailDampedRelease =
      calibration.averageCycleCompletionLatencyDeltaP50Sec !== undefined &&
      Math.abs(calibration.averageCycleCompletionLatencyDeltaP50Sec) <= 2 &&
      latencyDeltaSec >= 4;
    completionPatienceMultiplier = tailDampedRelease
      ? 0.63
      : latencyDeltaSec >= 6
        ? 0.25
        : latencyDeltaSec >= 2
          ? 0.55
          : 0.75;
  } else if (waitLonger) {
    completionPatienceMultiplier = latencyDeltaSec >= 6 ? 1.28 : latencyDeltaSec >= 3 ? 1.2 : 1.12;
  }
  return {
    lineageFlowCountBonus:
      enabled && focus.has("increase_lineage_preservation") ? 1 + childOrderSideInversionPressure : childOrderSideInversionPressure,
    activeFlowCountBonus: enabled && focus.has("allow_more_parallel_flow_when_budget_supports") ? 1 : 0,
    semanticRoleFlowCountBonus: alignHighLowRole && !cycleRoleArbitration ? 1 : 0,
    overlapCadenceCompressionBonus:
      enabled && (focus.has("compress_overlap_seed_rhythm") || improveChildOrderMicroTiming)
        ? Math.max(sideMismatchOffsetDeltaSec, childOrderCadenceDeltaSec) >= 20
          ? 2
          : 1
        : 0,
    completionPatienceFlowCountBonus:
      enabled &&
      (focus.has("tune_completion_patience_and_release") ||
        focus.has("release_completion_earlier") ||
        focus.has("increase_completion_patience") ||
        coldStartCalibration)
        ? 1
        : 0,
    completionPatienceMultiplier,
    completionReleaseBias: coldStartCalibration || releaseEarlier ? "earlier" : waitLonger ? "later" : "neutral",
    semanticRoleAlignmentBias: cycleRoleArbitration
      ? "cycle_role_arbitration"
      : preserveRawSide
      ? "preserve_raw_side"
      : alignHighLowRole
        ? "align_high_low_role"
        : "neutral",
    childOrderMicroTimingBias: improveChildOrderMicroTiming ? "flow_intent" : "neutral",
    completionRoleReleaseOrderBias: tuneCompletionRoleReleaseOrder ? "role_order" : "neutral",
    openingSeedReleaseBias:
      coldStartCalibration || maintainEarlyOpening || releaseOpeningEarlier
        ? "earlier"
        : delayOpeningRelease
          ? "later"
          : "neutral",
    openingSeedOffsetShiftSec,
    recommendedFocus: calibration.recommendedFocus,
  };
}

export function deriveRuntimeFlowBudgetState(args: {
  matchedInventoryQuality: number;
  unlockedMatchedInventoryQuality?: number;
  carryFlowConfidence?: number;
  recentSeedFlowCount?: number;
  activeIndependentFlowCount?: number;
  residualSeverityPressure?: number;
}): RuntimeFlowBudgetState {
  const matchedInventoryQuality = Math.max(0, args.matchedInventoryQuality);
  const unlockedMatchedInventoryQuality = Math.max(
    0,
    args.unlockedMatchedInventoryQuality ?? matchedInventoryQuality,
  );
  const effectiveMatchedInventoryQuality = Math.max(
    matchedInventoryQuality,
    unlockedMatchedInventoryQuality,
  );
  const carryFlowConfidence = Math.max(0, args.carryFlowConfidence ?? 0);
  const recentSeedFlowCount = Math.max(0, args.recentSeedFlowCount ?? 0);
  const activeIndependentFlowCount = Math.max(0, args.activeIndependentFlowCount ?? 0);
  const residualSeverityPressure = Math.max(0, args.residualSeverityPressure ?? 0);
  const state = deriveFlowPressureBudgetState({
    carryFlowConfidence,
    matchedInventoryQuality: effectiveMatchedInventoryQuality,
    recentSeedFlowCount,
    activeIndependentFlowCount,
    residualSeverityPressure,
  });
  return {
    ...state,
    matchedInventoryQuality,
    unlockedMatchedInventoryQuality,
    carryFlowConfidence,
    recentSeedFlowCount,
    activeIndependentFlowCount,
    residualSeverityPressure,
    reservedBudget: 0,
    flowLoadReserve: 0,
    mergeReserve: 0,
    residualReserve: 0,
    pendingExecutionReserve: 0,
    realizedActionReserve: 0,
    lineageActionReserve: 0,
  };
}

function runtimeFlowBudgetActionWeight(args: {
  quantityShares?: number | undefined;
  baseLot?: number | undefined;
}): number {
  const quantityShares = Math.max(0, args.quantityShares ?? 0);
  const baseLot = Math.max(1e-6, args.baseLot ?? 0);
  if (quantityShares <= 0 || baseLot <= 1e-6) {
    return 1;
  }
  const lotRatio = quantityShares / baseLot;
  return Number(Math.min(1.8, Math.max(0.45, Math.sqrt(lotRatio))).toFixed(6));
}

export function runtimeFlowBudgetReleaseQuantityForResidualChange(args: {
  requestedShares: number;
  oldGap?: number | undefined;
  newGap?: number | undefined;
}): number {
  const requestedShares = Math.max(0, args.requestedShares);
  if (args.oldGap === undefined || args.newGap === undefined) {
    return requestedShares;
  }
  const residualShrink = Math.max(0, args.oldGap - args.newGap);
  if (residualShrink <= 1e-6) {
    return requestedShares * 0.45;
  }
  return Number(Math.min(requestedShares, residualShrink).toFixed(6));
}

function runtimeFlowBudgetReleaseActionForFillMode(
  mode: StrategyExecutionMode | undefined,
): RuntimeFlowBudgetLedgerAction | undefined {
  if (mode === "UNWIND") {
    return "unwind_submit";
  }
  if (
    mode === "HIGH_LOW_COMPLETION_CHASE" ||
    mode === "CHEAP_LATE_COMPLETION_CHASE" ||
    mode === "PARTIAL_FAST_COMPLETION" ||
    mode === "PARTIAL_SOFT_COMPLETION" ||
    mode === "PARTIAL_EMERGENCY_COMPLETION" ||
    mode === "POST_MERGE_RESIDUAL_COMPLETION"
  ) {
    return "completion_submit";
  }
  return undefined;
}

export function applyRuntimeFlowBudgetConsumption(
  state: RuntimeFlowBudgetState,
  args: {
    activeIndependentFlowCount?: number;
    pendingMergeWindowCount?: number;
    protectedResidualShares?: number;
    residualSeverityPressure?: number;
    pendingPairExecutionActive?: boolean;
    realizedActionBudgetLoad?: number;
    lineageActionBudgetLoad?: number;
  },
): RuntimeFlowBudgetState {
  const activeIndependentFlowCount = Math.max(
    0,
    args.activeIndependentFlowCount ?? state.activeIndependentFlowCount,
  );
  const pendingMergeWindowCount = Math.max(0, args.pendingMergeWindowCount ?? 0);
  const protectedResidualShares = Math.max(0, args.protectedResidualShares ?? 0);
  const residualSeverityPressure = Math.max(
    0,
    args.residualSeverityPressure ?? state.residualSeverityPressure,
  );
  const flowLoadReserve = Math.min(0.18, Math.max(0, activeIndependentFlowCount - 1) * 0.06);
  const mergeReserve = Math.min(0.14, pendingMergeWindowCount * 0.035);
  const residualReserve =
    protectedResidualShares > 0 ? Math.min(0.16, residualSeverityPressure * 0.08 + 0.035) : 0;
  const pendingExecutionReserve = args.pendingPairExecutionActive ? 0.04 : 0;
  const realizedActionReserve = Math.min(0.18, Math.max(0, args.realizedActionBudgetLoad ?? 0));
  const lineageActionReserve = Math.min(0.12, Math.max(0, args.lineageActionBudgetLoad ?? 0));
  const reservedBudget = Number(
    Math.min(
      0.58,
      flowLoadReserve +
        mergeReserve +
        residualReserve +
        pendingExecutionReserve +
        realizedActionReserve +
        lineageActionReserve,
    ).toFixed(6),
  );
  const remainingBudget = Number(Math.max(0, state.remainingBudget - reservedBudget).toFixed(6));
  const consumedBudget = Number(Math.min(1, state.consumedBudget + reservedBudget).toFixed(6));

  return {
    ...state,
    remainingBudget,
    consumedBudget,
    reservedBudget,
    flowLoadReserve,
    mergeReserve,
    residualReserve,
    pendingExecutionReserve,
    realizedActionReserve,
    lineageActionReserve,
  };
}

export type RuntimeFlowBudgetLedgerAction =
  | "pair_submit"
  | "seed_submit"
  | "completion_submit"
  | "unwind_submit"
  | "merge"
  | "residual_flat"
  | "balance_adopted";

export function applyRuntimeFlowBudgetLedgerAction(
  currentLoad: number,
  action: RuntimeFlowBudgetLedgerAction,
  args: {
    quantityShares?: number | undefined;
    baseLot?: number | undefined;
  } = {},
): number {
  const deltaByAction: Record<RuntimeFlowBudgetLedgerAction, number> = {
    pair_submit: 0.08,
    seed_submit: 0.05,
    completion_submit: -0.05,
    unwind_submit: -0.07,
    merge: -0.14,
    residual_flat: -0.18,
    balance_adopted: 0.1,
  };
  const weightedDelta = deltaByAction[action] * runtimeFlowBudgetActionWeight(args);
  return Number(Math.max(0, Math.min(0.32, currentLoad + weightedDelta)).toFixed(6));
}

export function applyRuntimeFlowBudgetLineageLedgerAction(
  currentLoads: Record<string, number>,
  action: RuntimeFlowBudgetLedgerAction,
  args: {
    lineage?: string | undefined;
    quantityShares?: number | undefined;
    baseLot?: number | undefined;
  } = {},
): Record<string, number> {
  const lineage = args.lineage ?? "UNCLASSIFIED";
  const nextLoad = applyRuntimeFlowBudgetLedgerAction(currentLoads[lineage] ?? 0, action, args);
  const nextLoads = { ...currentLoads };
  if (nextLoad <= 1e-6) {
    delete nextLoads[lineage];
  } else {
    nextLoads[lineage] = nextLoad;
  }
  return nextLoads;
}

function dominantRuntimeFlowBudgetLineageLoad(loads: Record<string, number>): number {
  return Number(Math.max(0, ...Object.values(loads)).toFixed(6));
}

function deriveCarryFlowLineageKey(args: {
  recommendation?: Extract<OverlapRepairArbitration, "favor_independent_overlap" | "favor_residual_repair"> | undefined;
  preferredSeedSide?: OutcomeSide | undefined;
  protectedResidualSide?: OutcomeSide | undefined;
}): string | undefined {
  if (!args.recommendation) {
    return undefined;
  }
  return [
    args.recommendation,
    args.preferredSeedSide ?? "NA",
    args.protectedResidualSide ?? "NA",
  ].join("|");
}

function arbitrationCarryPersistenceKey(
  carry:
    | Pick<
        ArbitrationCarry,
        | "recommendation"
        | "preferredSeedSide"
        | "protectedResidualSide"
        | "alignmentStreak"
        | "lastObservedAt"
        | "lastProtectedShares"
        | "expiresAt"
        | "residualSeverityLevel"
      >
    | undefined,
): string {
  if (!carry) {
    return "none";
  }
  return [
    carry.recommendation,
    carry.preferredSeedSide ?? "NA",
    carry.protectedResidualSide,
    carry.alignmentStreak,
    carry.lastObservedAt,
    carry.lastProtectedShares.toFixed(6),
    carry.expiresAt,
    carry.residualSeverityLevel ?? "NA",
  ].join("|");
}

function arbitrationCarryAlignmentBonus(alignmentStreak: number): number {
  return Number(Math.min(0.36, Math.max(0, alignmentStreak - 1) * 0.08).toFixed(6));
}

export function deriveArbitrationCarryExpiry(args: {
  config: Pick<XuanStrategyConfig, "partialFastWindowSec" | "partialSoftWindowSec" | "partialPatientWindowSec">;
  carry: ArbitrationCarry;
  protectedResidualShares: number;
  nowTs: number;
  recentSeedFlowCount: number;
  residualBehaviorState: Pick<
    ReturnType<typeof resolveResidualBehaviorState>,
    "carryPersistenceBias" | "riskToleranceBias" | "severityPressure"
  >;
}): number {
  const elapsedSinceObservation = Math.max(1, args.nowTs - args.carry.lastObservedAt);
  const shrinkShares = Math.max(0, args.carry.lastProtectedShares - args.protectedResidualShares);
  const shrinkRatio = shrinkShares / Math.max(args.carry.lastProtectedShares, 1e-6);
  const shrinkRatePerSec = shrinkShares / elapsedSinceObservation;
  const denseFlow = args.recentSeedFlowCount >= 2;
  const streakBonus = arbitrationCarryAlignmentBonus(args.carry.alignmentStreak);
  const stalledResolution = shrinkRatio < 0.08 && shrinkRatePerSec < 0.02;
  const slowResolution = shrinkRatio < 0.18;
  const shrinkRegimeMultiplier =
    stalledResolution
      ? 1.35
      : slowResolution
        ? 1.15
        : shrinkRatio > 0.45
          ? 0.85
          : 1;
  const baseExtensionSec =
    args.carry.recommendation === "favor_independent_overlap"
      ? args.config.partialFastWindowSec * args.residualBehaviorState.carryPersistenceBias * (1 + streakBonus) +
        args.config.partialSoftWindowSec * (denseFlow ? 0.25 : 0.1) * (1 + args.residualBehaviorState.riskToleranceBias)
      : args.config.partialFastWindowSec * Math.max(1, args.residualBehaviorState.carryPersistenceBias * (0.85 + streakBonus * 0.45));
  const maxCarryAgeSec =
    args.config.partialPatientWindowSec * Math.min(1.65, args.residualBehaviorState.carryPersistenceBias + streakBonus * 0.8);
  const nextExpiry =
    args.nowTs +
    Math.ceil(
      baseExtensionSec * shrinkRegimeMultiplier +
        elapsedSinceObservation * (stalledResolution ? 0.12 : 0.08) +
        args.config.partialFastWindowSec * streakBonus * 0.35,
    );
  return Math.min(args.carry.createdAt + maxCarryAgeSec, nextExpiry);
}

export function shouldPreserveCarryDrivenOverlap(args: {
  config: Pick<
    XuanStrategyConfig,
    | "allowControlledOverlap"
    | "allowOverlapOnlyAfterPartialClassified"
    | "allowOverlapOnlyWhenCompletionEngineActive"
    | "allowOverlapInLast30S"
    | "finalWindowCompletionOnlySec"
    | "maxOpenGroupsPerMarket"
    | "maxOpenPartialGroups"
    | "requireMatchedInventoryBeforeSecondGroup"
    | "completionMinQty"
    | "repairMinQty"
    | "defaultLot"
    | "liveSmallLotLadder"
    | "xuanCloneMode"
  >;
  carry:
    | Pick<ArbitrationCarry, "recommendation" | "expiresAt" | "alignmentStreak">
    | undefined;
  nowTs: number;
  secsToClose: number;
  protectedResidualShares: number;
  completionActive: boolean;
  linkageHealthy: boolean;
  matchedInventoryTargetMet: boolean;
  matchedInventoryQuality?: number;
  unlockedMatchedInventoryQuality?: number;
  carryFlowConfidence?: number;
  recentSeedFlowCount?: number;
  activeIndependentFlowCount?: number;
}): boolean {
  if (!args.config.allowControlledOverlap || !args.carry) {
    return false;
  }
  if (args.carry.recommendation !== "favor_independent_overlap" || args.nowTs >= args.carry.expiresAt) {
    return false;
  }
  if (args.config.maxOpenGroupsPerMarket < 2 || args.config.maxOpenPartialGroups < 1) {
    return false;
  }
  if (!args.config.allowOverlapInLast30S && args.secsToClose <= args.config.finalWindowCompletionOnlySec) {
    return false;
  }
  if (args.protectedResidualShares <= Math.max(args.config.repairMinQty, args.config.completionMinQty)) {
    return false;
  }
  if (args.config.allowOverlapOnlyAfterPartialClassified && !args.linkageHealthy) {
    return false;
  }
  if (args.config.allowOverlapOnlyWhenCompletionEngineActive && !args.completionActive) {
    return false;
  }

  const residualBehaviorState = resolveResidualBehaviorState({
    config: args.config,
    residualShares: args.protectedResidualShares,
    shareGap: args.protectedResidualShares,
    ...(args.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: args.recentSeedFlowCount } : {}),
    ...(args.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: args.activeIndependentFlowCount } : {}),
  });
  const residualSeverity = residualBehaviorState.severity;
  if (residualSeverity.level === "flat" || residualSeverity.level === "aggressive") {
    return false;
  }
  if (!args.config.requireMatchedInventoryBeforeSecondGroup || args.matchedInventoryTargetMet) {
    return true;
  }

  const carryFlowConfidence = Math.max(0, args.carryFlowConfidence ?? 0);
  const flowPressureBudget = deriveFlowPressureBudget({
    carryFlowConfidence,
    matchedInventoryQuality: Math.max(args.matchedInventoryQuality ?? 0, args.unlockedMatchedInventoryQuality ?? 0),
    recentSeedFlowCount: args.recentSeedFlowCount,
    activeIndependentFlowCount: args.activeIndependentFlowCount,
    residualSeverityPressure: residualBehaviorState.severityPressure,
  });
  const flowPressureState = classifyFlowPressureBudget({
    budget: flowPressureBudget,
    matchedInventoryQuality: Math.max(args.matchedInventoryQuality ?? 0, args.unlockedMatchedInventoryQuality ?? 0),
  });
  return (
    Math.max(args.matchedInventoryQuality ?? 0, args.unlockedMatchedInventoryQuality ?? 0) >=
      flowPressureState.requiredMatchedInventoryQuality &&
    (residualBehaviorState.riskToleranceBias >= 0.48 || args.carry.alignmentStreak >= 2 || flowPressureState.confirmed) &&
    (residualSeverity.level === "micro" || residualSeverity.level === "small" || residualSeverity.level === "medium")
  );
}

export function deriveCarryFlowConfidence(args: {
  carry:
    | (Pick<ArbitrationCarry, "alignmentStreak"> &
        Partial<Pick<ArbitrationCarry, "recommendation" | "preferredSeedSide" | "protectedResidualSide">>)
    | undefined;
  state: Pick<XuanMarketState, "fillHistory" | "mergeHistory">;
  nowTs: number;
  matchedInventoryQuality: number;
  unlockedMatchedInventoryQuality?: number | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
}): number {
  if (!args.carry) {
    return 0;
  }

  const targetLineage = deriveCarryFlowLineageKey({
    recommendation: args.carry.recommendation,
    preferredSeedSide: args.carry.preferredSeedSide,
    protectedResidualSide: args.carry.protectedResidualSide,
  });
  const recentBuyFills = args.state.fillHistory.filter(
    (fill) => fill.side === "BUY" && isClassifiedBuyMode(fill.executionMode) && args.nowTs - fill.timestamp <= 120,
  );
  const lineageBuyFills =
    targetLineage !== undefined
      ? recentBuyFills.filter((fill) => fill.flowLineage === targetLineage)
      : [];
  const consideredBuyFills = lineageBuyFills.length > 0 ? lineageBuyFills : recentBuyFills;
  const seedLikeFills = consideredBuyFills.filter(
    (fill) => fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" || fill.executionMode === "PAIRGROUP_COVERED_SEED",
  );
  const completionLikeFills = consideredBuyFills.filter(
    (fill) =>
      fill.executionMode === "PARTIAL_FAST_COMPLETION" ||
      fill.executionMode === "PARTIAL_SOFT_COMPLETION" ||
      fill.executionMode === "PARTIAL_EMERGENCY_COMPLETION" ||
      fill.executionMode === "POST_MERGE_RESIDUAL_COMPLETION" ||
      fill.executionMode === "CHEAP_LATE_COMPLETION_CHASE" ||
      fill.executionMode === "HIGH_LOW_COMPLETION_CHASE",
  );
  const recentMerges = args.state.mergeHistory.filter((merge) => args.nowTs - merge.timestamp <= 180);
  const lineageMerges =
    targetLineage !== undefined
      ? recentMerges.filter((merge) => merge.flowLineage === targetLineage)
      : [];
  const consideredMerges = lineageMerges.length > 0 ? lineageMerges : recentMerges;
  const fillOutcomes = new Set(consideredBuyFills.map((fill) => fill.outcome));
  const pairedFillConfirmed = fillOutcomes.size >= 2;
  const recentMergeConfirmed = consideredMerges.length > 0;
  const quality = Math.max(0, args.matchedInventoryQuality, args.unlockedMatchedInventoryQuality ?? 0);
  const lineageBonus = targetLineage !== undefined && lineageBuyFills.length > 0 ? 0.08 : 0;
  const flowDensityBonus =
    (args.recentSeedFlowCount ?? 0) >= 2 ? 0.12 : (args.recentSeedFlowCount ?? 0) >= 1 ? 0.06 : 0;
  const alignmentBonus = Math.min(0.18, Math.max(0, args.carry.alignmentStreak - 1) * 0.06);
  let confirmationScore =
    Math.min(0.45, quality * 0.4) + flowDensityBonus + alignmentBonus + lineageBonus + (recentMergeConfirmed ? 0.25 : 0);

  if (args.carry.recommendation === "favor_independent_overlap") {
    const preferredSeedSide = args.carry.preferredSeedSide;
    const alignedSeedCount = preferredSeedSide
      ? seedLikeFills.filter((fill) => fill.outcome === preferredSeedSide).length
      : 0;
    confirmationScore += alignedSeedCount >= 2 ? 0.34 : alignedSeedCount >= 1 ? 0.22 : 0;
    confirmationScore += pairedFillConfirmed ? 0.16 : consideredBuyFills.length >= 2 ? 0.08 : 0;
  } else if (args.carry.recommendation === "favor_residual_repair") {
    const repairSide =
      args.carry.protectedResidualSide === "UP"
        ? "DOWN"
        : args.carry.protectedResidualSide === "DOWN"
          ? "UP"
          : undefined;
    const repairCompletionCount = repairSide
      ? completionLikeFills.filter((fill) => fill.outcome === repairSide).length
      : 0;
    const repairBuyCount = repairSide ? recentBuyFills.filter((fill) => fill.outcome === repairSide).length : 0;
    confirmationScore += repairCompletionCount >= 2 ? 0.38 : repairCompletionCount >= 1 ? 0.26 : 0;
    confirmationScore += repairBuyCount >= 1 ? 0.08 : 0;
  } else {
    confirmationScore += pairedFillConfirmed ? 0.28 : consideredBuyFills.length >= 2 ? 0.12 : 0;
  }

  return Number(Math.min(1.4, confirmationScore).toFixed(6));
}

export function deriveConfirmedCarryAlignmentStreak(args: {
  carry:
    | (Pick<ArbitrationCarry, "alignmentStreak"> &
        Partial<Pick<ArbitrationCarry, "recommendation" | "preferredSeedSide" | "protectedResidualSide">>)
    | undefined;
  state: Pick<XuanMarketState, "fillHistory" | "mergeHistory">;
  nowTs: number;
  matchedInventoryQuality: number;
  unlockedMatchedInventoryQuality?: number | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  flowConfidence?: number | undefined;
}): number {
  if (!args.carry) {
    return 0;
  }
  const flowConfidence =
    args.flowConfidence ??
    deriveCarryFlowConfidence({
      carry: args.carry,
      state: args.state,
      nowTs: args.nowTs,
      matchedInventoryQuality: args.matchedInventoryQuality,
      unlockedMatchedInventoryQuality: args.unlockedMatchedInventoryQuality,
      recentSeedFlowCount: args.recentSeedFlowCount,
    });

  if (flowConfidence >= 1.05) {
    return args.carry.alignmentStreak;
  }
  if (flowConfidence >= 0.82) {
    return Math.max(1, Math.min(args.carry.alignmentStreak, 3));
  }
  if (flowConfidence >= 0.62) {
    return Math.max(1, Math.min(args.carry.alignmentStreak, 2));
  }
  return 1;
}

function normalizeMergeAmount(mergeable: number, dustLeaveShares: number): number {
  return Number(Math.max(0, mergeable - Math.max(0, dustLeaveShares)).toFixed(6));
}

function computePendingLockedShares(
  pending: PendingPairExecution | undefined,
  fillSnapshot: { upBoughtQty: number; downBoughtQty: number } | undefined,
  config: Pick<XuanStrategyConfig, "lockReservedQtyForPendingOrders">,
): { up: number; down: number } {
  if (!pending || !config.lockReservedQtyForPendingOrders) {
    return { up: 0, down: 0 };
  }
  return {
    up: Number((fillSnapshot?.upBoughtQty ?? 0).toFixed(6)),
    down: Number((fillSnapshot?.downBoughtQty ?? 0).toFixed(6)),
  };
}

function unlockedMergeableShares(
  state: XuanMarketState,
  locked: { up: number; down: number },
): number {
  return Number(
    Math.min(
      Math.max(0, state.upShares - locked.up),
      Math.max(0, state.downShares - locked.down),
    ).toFixed(6),
  );
}

function shouldAllowControlledOverlap(args: {
  config: Pick<
    XuanStrategyConfig,
    | "allowControlledOverlap"
    | "allowOverlapOnlyAfterPartialClassified"
    | "allowOverlapOnlyWhenCompletionEngineActive"
    | "allowOverlapInLast30S"
    | "finalWindowCompletionOnlySec"
    | "partialFastWindowSec"
    | "partialSoftWindowSec"
    | "partialPatientWindowSec"
    | "maxOpenGroupsPerMarket"
    | "maxOpenPartialGroups"
    | "requireMatchedInventoryBeforeSecondGroup"
    | "worstCaseAmplificationToleranceShares"
    | "completionMinQty"
    | "repairMinQty"
    | "defaultLot"
    | "liveSmallLotLadder"
    | "xuanCloneMode"
  >;
  nowTs: number;
  secsToClose: number;
  protectedResidualLock:
    | Pick<PartialOpenGroupLock, "openedAt">
    | Pick<RuntimeProtectedResidualLock, "openedAt">
    | undefined;
  protectedResidualShares: number;
  completionActive: boolean;
  linkageHealthy: boolean;
  entryBuys: EntryBuyDecision[];
  matchedInventoryTargetMet: boolean;
  worstCaseAmplificationShares: number;
  recentSeedFlowCount?: number;
  activeIndependentFlowCount?: number;
}): boolean {
  if (!args.config.allowControlledOverlap) {
    return false;
  }
  if (!args.protectedResidualLock || args.entryBuys.length !== 2) {
    return false;
  }
  if (args.config.maxOpenGroupsPerMarket < 2 || args.config.maxOpenPartialGroups < 1) {
    return false;
  }
  if (!args.config.allowOverlapInLast30S && args.secsToClose <= args.config.finalWindowCompletionOnlySec) {
    return false;
  }
  const partialAgeSec = Math.max(0, args.nowTs - args.protectedResidualLock.openedAt);
  const residualBehaviorState = resolveResidualBehaviorState({
    config: args.config,
    residualShares: args.protectedResidualShares,
    shareGap: args.protectedResidualShares,
    ...(args.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: args.recentSeedFlowCount } : {}),
    ...(args.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: args.activeIndependentFlowCount } : {}),
  });
  const residualSeverity = residualBehaviorState.severity;
  const flowDensity = residualBehaviorState.flowDensity;
  const riskToleranceBias = residualBehaviorState.riskToleranceBias;
  const overlapAgeEligible =
    residualSeverity.level === "micro" && args.protectedResidualShares > 0
      ? true
      : partialAgeSec >= args.config.partialFastWindowSec * Math.max(0.2, 1 - riskToleranceBias * 0.75);
  if (!overlapAgeEligible) {
    return false;
  }
  const carryWindowExtensionSec =
    args.config.partialSoftWindowSec *
    Math.max(0, residualBehaviorState.carryPersistenceBias - 1) *
    0.7;
  if (partialAgeSec >= args.config.partialPatientWindowSec + carryWindowExtensionSec) {
    return false;
  }
  if (args.config.allowOverlapOnlyAfterPartialClassified && !args.linkageHealthy) {
    return false;
  }
  if (args.config.allowOverlapOnlyWhenCompletionEngineActive && !args.completionActive) {
    return false;
  }
  const relaxedMatchedInventoryRequirement =
    riskToleranceBias >= 0.55 &&
    (residualSeverity.level === "micro" || residualSeverity.level === "small" || residualSeverity.level === "medium");
  if (args.config.requireMatchedInventoryBeforeSecondGroup && !args.matchedInventoryTargetMet && !relaxedMatchedInventoryRequirement) {
    return false;
  }
  const densityAmplificationAllowance =
    (0.2 + riskToleranceBias * 0.55 + (flowDensity >= 2 ? 0.15 : 0)) *
    (args.config.liveSmallLotLadder[0] ?? args.config.defaultLot);
  if (
    args.worstCaseAmplificationShares >
    args.config.worstCaseAmplificationToleranceShares + densityAmplificationAllowance + 1e-6
  ) {
    return false;
  }
  return true;
}

function isReplayComparatorStatus(status: string | undefined): status is "pass" | "warn" | "fail" {
  return status === "pass" || status === "warn" || status === "fail";
}

function computeWorstCaseAmplificationShares(
  state: Pick<XuanMarketState, "upShares" | "downShares">,
  entryBuys: EntryBuyDecision[],
): number {
  const baseGap = Math.abs(state.upShares - state.downShares);
  return Number(
    entryBuys
      .map((entryBuy) => {
        const nextUp = state.upShares + (entryBuy.side === "UP" ? entryBuy.size : 0);
        const nextDown = state.downShares + (entryBuy.side === "DOWN" ? entryBuy.size : 0);
        const nextGap = Math.abs(nextUp - nextDown);
        return Math.max(0, nextGap - baseGap);
      })
      .reduce((worst, value) => Math.max(worst, value), 0)
      .toFixed(6),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childOrderDelayMs(baseDelayMs: number, salt: string): number {
  if (baseDelayMs <= 0) {
    return 0;
  }

  let hash = 0;
  for (let index = 0; index < salt.length; index += 1) {
    hash = (hash * 31 + salt.charCodeAt(index)) % 10_000;
  }
  const jitter = (hash % 41) - 20;
  return Math.max(0, baseDelayMs + jitter);
}

function normalizeBookTimestampSec(book: OrderBook): number {
  return book.timestamp > 10_000_000_000 ? Math.floor(book.timestamp / 1000) : book.timestamp;
}

function computeBookStaleMs(book: OrderBook | undefined, nowTs: number): number {
  if (!book) {
    return 60_000;
  }
  return Math.max(0, (nowTs - normalizeBookTimestampSec(book)) * 1000);
}

function parseNumeric(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOutcome(value: string | undefined): OutcomeSide | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "UP" || normalized === "YES") {
    return "UP";
  }
  if (normalized === "DOWN" || normalized === "NO") {
    return "DOWN";
  }
  return undefined;
}

function outcomeForAssetId(market: MarketInfo, assetId: string): OutcomeSide | undefined {
  if (assetId === market.tokens.UP.tokenId) {
    return "UP";
  }
  if (assetId === market.tokens.DOWN.tokenId) {
    return "DOWN";
  }
  return undefined;
}

function clampFallbackPrice(price: number | undefined): number {
  if (price !== undefined && Number.isFinite(price) && price > 0) {
    return price;
  }
  return 0.5;
}

function normalizeShares(value: number): number {
  return Number(value.toFixed(6));
}

function isProtectedResidualSeedMode(
  mode: StrategyExecutionMode | undefined,
): mode is Extract<StrategyExecutionMode, "TEMPORAL_SINGLE_LEG_SEED" | "PAIRGROUP_COVERED_SEED"> {
  return mode === "TEMPORAL_SINGLE_LEG_SEED" || mode === "PAIRGROUP_COVERED_SEED";
}

function dominantResidualSide(state: Pick<XuanMarketState, "upShares" | "downShares">): OutcomeSide | undefined {
  if (Math.abs(state.upShares - state.downShares) <= 1e-6) {
    return undefined;
  }
  return state.upShares > state.downShares ? "UP" : "DOWN";
}

export function restorePersistedArbitrationCarry(args: {
  snapshot: PersistedArbitrationCarrySnapshot | undefined;
  state: Pick<XuanMarketState, "upShares" | "downShares">;
  nowTs: number;
  minResidualShares: number;
}): ArbitrationCarry | undefined {
  const snapshot = args.snapshot;
  if (!snapshot || snapshot.residualSeverityLevel === "flat") {
    return undefined;
  }
  if (args.nowTs >= snapshot.expiresAt) {
    return undefined;
  }

  const currentProtectedSide = dominantResidualSide(args.state);
  const currentProtectedShares = normalizeShares(Math.abs(args.state.upShares - args.state.downShares));
  if (!currentProtectedSide || currentProtectedShares <= Math.max(1e-6, args.minResidualShares)) {
    return undefined;
  }
  if (currentProtectedSide !== snapshot.protectedResidualSide) {
    return undefined;
  }

  const minimumExpectedShares = Math.max(args.minResidualShares, snapshot.referenceShareGap * 0.14);
  const maximumExpectedShares = Math.max(snapshot.lastProtectedShares, snapshot.referenceShareGap, args.minResidualShares) * 1.9;
  if (currentProtectedShares + 1e-6 < minimumExpectedShares || currentProtectedShares - 1e-6 > maximumExpectedShares) {
    return undefined;
  }

  return {
    createdAt: Math.min(snapshot.createdAt, snapshot.lastObservedAt),
    recommendation: snapshot.recommendation,
    preferredSeedSide: snapshot.preferredSeedSide,
    protectedResidualSide: snapshot.protectedResidualSide,
    referenceShareGap: Math.max(snapshot.referenceShareGap, currentProtectedShares),
    alignmentStreak: Math.max(1, snapshot.alignmentStreak),
    lastObservedAt: Math.min(snapshot.lastObservedAt, args.nowTs),
    lastProtectedShares: currentProtectedShares,
    expiresAt: snapshot.expiresAt,
    residualSeverityLevel: snapshot.residualSeverityLevel,
  };
}

export function refreshRuntimeProtectedResidualLock(args: {
  lock: RuntimeProtectedResidualLock | undefined;
  state: Pick<XuanMarketState, "upShares" | "downShares">;
  nowTs: number;
  mode?: StrategyExecutionMode | undefined;
}): RuntimeProtectedResidualLock | undefined {
  const protectedSide = dominantResidualSide(args.state);
  const protectedShares = normalizeShares(Math.abs(args.state.upShares - args.state.downShares));
  if (!protectedSide || protectedShares <= 1e-6) {
    return undefined;
  }

  if (isProtectedResidualSeedMode(args.mode)) {
    return {
      openedAt: args.nowTs,
      protectedSide,
      protectedShares,
      sourceMode: args.mode,
    };
  }

  if (!args.lock) {
    return undefined;
  }

  return {
    ...args.lock,
    openedAt: args.lock.protectedSide === protectedSide ? args.lock.openedAt : args.nowTs,
    protectedSide,
    protectedShares,
  };
}

function pushEvent(events: Array<Record<string, unknown>>, event: Record<string, unknown>, limit = 200): void {
  events.push(event);
  if (events.length > limit) {
    events.shift();
  }
}

function emitLiveMirror(eventType: string, payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      tsIso: new Date().toISOString(),
      eventType,
      ...payload,
    }),
  );
}

function buildDecisionTraceEvent(
  decision: ReturnType<Xuan5mBot["evaluateTick"]>,
  context: DecisionTraceContext,
): Record<string, unknown> {
  const candidateCaps = decision.trace.entry.candidates.map((candidate) => ({
    qty: candidate.requestedSize,
    rawPair: candidate.rawPairCost,
    effectivePair: candidate.pairCost,
    negativeEdgeUsdc: candidate.negativeEdgeUsdc,
    selectedMode: candidate.selectedMode ?? null,
    gateReason: candidate.gateReason ?? null,
    upOrphanReason: candidate.upOrphanRisk?.reason ?? null,
    downOrphanReason: candidate.downOrphanRisk?.reason ?? null,
    upOrphanFairPremium: candidate.upOrphanRisk?.fairPremium ?? null,
    downOrphanFairPremium: candidate.downOrphanRisk?.fairPremium ?? null,
  }));
  const bestEffectivePair =
    decision.trace.entry.candidates.length > 0
      ? Math.min(...decision.trace.entry.candidates.map((candidate) => candidate.pairCost))
      : null;
  const bestRawPair =
    decision.trace.entry.candidates.length > 0
      ? Math.min(...decision.trace.entry.candidates.map((candidate) => candidate.rawPairCost))
      : null;
  const entryArbitrationActionDelta =
    decision.trace.entry.overlapRepairArbitration === "favor_independent_overlap" &&
    !["overlap_seed", "pair_reentry", "wait"].includes(decision.trace.entry.overlapRepairOutcome ?? "")
      ? `favor_independent_overlap_but_${decision.trace.entry.overlapRepairOutcome ?? decision.completion?.arbitrationOutcome ?? decision.unwind?.arbitrationOutcome ?? "idle"}`
      : decision.trace.entry.overlapRepairArbitration === "favor_residual_repair" &&
          !["repair", "blocked"].includes(decision.trace.entry.overlapRepairOutcome ?? "")
        ? `favor_residual_repair_but_${decision.trace.entry.overlapRepairOutcome ?? decision.completion?.arbitrationOutcome ?? decision.unwind?.arbitrationOutcome ?? "idle"}`
        : null;
  const flowBudgetSummary = context.runtimeFlowBudgetState
    ? `${context.runtimeFlowBudgetState.remainingBudget.toFixed(3)}/${context.runtimeFlowBudgetState.budget.toFixed(3)}`
    : "none";
  const stickyCarryActive = Boolean(
    context.arbitrationCarryRecommendation ?? context.arbitrationCarryPreferredSeedSide,
  );
  const stickyCarrySummary = stickyCarryActive
    ? [
        context.arbitrationCarryRecommendation ?? "carry",
        context.arbitrationCarryPreferredSeedSide ?? "any_side",
      ].join(":")
    : "off";
  const flowBehaviorSummary = [
    `flowBudget=${flowBudgetSummary}`,
    `overlapRepairArbitration=${decision.trace.entry.overlapRepairArbitration ?? "none"}`,
    `stickyCarry=${stickyCarrySummary}`,
  ].join(" ");
  return {
    eventSeq: context.eventSeq,
    decisionLatencyMs: context.decisionLatencyMs,
    bookAgeMsUp: context.bookAgeMsUp,
    bookAgeMsDown: context.bookAgeMsDown,
    phase: decision.phase,
    allowNewEntries: decision.risk.allowNewEntries,
    completionOnly: decision.risk.completionOnly,
    hardCancel: decision.risk.hardCancel,
    riskReasons: decision.risk.reasons,
    secsFromOpen: decision.trace.secsFromOpen,
    secsToClose: decision.trace.secsToClose,
    lot: decision.trace.lot,
    totalShares: decision.trace.totalShares,
    shareGap: decision.trace.shareGap,
    inventoryBalanced: decision.trace.inventoryBalanced,
    bestAskUp: decision.trace.bestAskUp,
    bestAskDown: decision.trace.bestAskDown,
    pairCap: decision.trace.pairCap,
    pairTakerCost: decision.trace.pairTakerCost,
    selectedMode: decision.trace.selectedMode ?? null,
    protectedResidualContext: decision.trace.protectedResidualContext,
    flowRotationRetryAttempted: decision.trace.flowRotationRetryAttempted,
    flowRotationRetrySelected: decision.trace.flowRotationRetrySelected,
    sameWindowCompletionAndOverlap: decision.trace.sameWindowCompletionAndOverlap,
    fairValueStatus: decision.trace.fairValue?.status ?? null,
    fairValuePriceToBeat: decision.trace.fairValue?.priceToBeat ?? null,
    fairValueLivePrice: decision.trace.fairValue?.livePrice ?? null,
    fairValueUp: decision.trace.fairValue?.fairUp ?? null,
    fairValueDown: decision.trace.fairValue?.fairDown ?? null,
    fairValueEstimatedThreshold: decision.trace.fairValue?.estimatedThreshold ?? null,
    bestEffectivePair,
    bestRawPair,
    wouldTradeAtCap_1_005: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.005),
    wouldTradeAtCap_1_025: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.025),
    wouldTradeAtCap_1_035: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.035),
    wouldTradeAtCap_1_055: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.055),
    qtyCaps: candidateCaps,
    entryMode: decision.trace.entry.mode,
    entrySkipReason: decision.trace.entry.skipReason ?? null,
    residualSeverityLevel: decision.trace.entry.residualSeverityLevel ?? null,
    flowBehaviorSummary,
    overlapRepairArbitration: decision.trace.entry.overlapRepairArbitration ?? null,
    overlapRepairReason: decision.trace.entry.overlapRepairReason ?? null,
    overlapRepairOutcome: decision.trace.entry.overlapRepairOutcome ?? null,
    arbitrationCarryRecommendation: context.arbitrationCarryRecommendation ?? null,
    arbitrationCarryPreferredSeedSide: context.arbitrationCarryPreferredSeedSide ?? null,
    flowBudget: context.runtimeFlowBudgetState?.budget ?? null,
    flowBudgetRemaining: context.runtimeFlowBudgetState?.remainingBudget ?? null,
    flowBudgetConsumed: context.runtimeFlowBudgetState?.consumedBudget ?? null,
    flowBudgetReserved: context.runtimeFlowBudgetState?.reservedBudget ?? null,
    flowBudgetFlowLoadReserve: context.runtimeFlowBudgetState?.flowLoadReserve ?? null,
    flowBudgetMergeReserve: context.runtimeFlowBudgetState?.mergeReserve ?? null,
    flowBudgetResidualReserve: context.runtimeFlowBudgetState?.residualReserve ?? null,
    flowBudgetPendingExecutionReserve: context.runtimeFlowBudgetState?.pendingExecutionReserve ?? null,
    flowBudgetRealizedActionReserve: context.runtimeFlowBudgetState?.realizedActionReserve ?? null,
    flowBudgetLineageActionReserve: context.runtimeFlowBudgetState?.lineageActionReserve ?? null,
    flowBudgetLastLineage: context.runtimeFlowBudgetLastLineage ?? null,
    flowBudgetDominantLineageLoad: context.runtimeFlowBudgetDominantLineageLoad ?? null,
    flowBudgetMatchedInventoryQuality: context.runtimeFlowBudgetState?.matchedInventoryQuality ?? null,
    flowBudgetUnlockedMatchedInventoryQuality:
      context.runtimeFlowBudgetState?.unlockedMatchedInventoryQuality ?? null,
    flowBudgetCarryConfidence: context.runtimeFlowBudgetState?.carryFlowConfidence ?? null,
    flowCalibrationReleaseBias: context.runtimeFlowCalibrationBias?.completionReleaseBias ?? null,
    flowCalibrationPatienceMultiplier: context.runtimeFlowCalibrationBias?.completionPatienceMultiplier ?? null,
    flowCalibrationSemanticRoleAlignmentBias:
      context.runtimeFlowCalibrationBias?.semanticRoleAlignmentBias ?? null,
    flowCalibrationChildOrderMicroTimingBias:
      context.runtimeFlowCalibrationBias?.childOrderMicroTimingBias ?? null,
    flowCalibrationCompletionRoleReleaseOrderBias:
      context.runtimeFlowCalibrationBias?.completionRoleReleaseOrderBias ?? null,
    flowCalibrationSemanticRoleFlowCountBonus:
      context.runtimeFlowCalibrationBias?.semanticRoleFlowCountBonus ?? null,
    flowCalibrationOverlapCadenceCompressionBonus:
      context.runtimeFlowCalibrationBias?.overlapCadenceCompressionBonus ?? null,
    flowCalibrationRecommendedFocus: context.runtimeFlowCalibrationBias?.recommendedFocus ?? [],
    entryArbitrationActionDelta,
    gatedByRisk: decision.trace.entry.gatedByRisk ?? false,
    laggingSide: decision.trace.entry.laggingSide ?? null,
    repairSize: decision.trace.entry.repairSize ?? null,
    repairFilledSize: decision.trace.entry.repairFilledSize ?? null,
    repairCost: decision.trace.entry.repairCost ?? null,
    repairAllowed: decision.trace.entry.repairAllowed ?? null,
    repairCapMode: decision.trace.entry.repairCapMode ?? null,
    completionMode: decision.completion?.mode ?? null,
    completionResidualSeverityLevel: decision.completion?.residualSeverityLevel ?? null,
    completionOverlapRepairArbitration: decision.completion?.overlapRepairArbitration ?? null,
    completionArbitrationOutcome: decision.completion?.arbitrationOutcome ?? null,
    unwindMode: decision.unwind?.mode ?? null,
    unwindResidualSeverityLevel: decision.unwind?.residualSeverityLevel ?? null,
    unwindOverlapRepairArbitration: decision.unwind?.overlapRepairArbitration ?? null,
    unwindArbitrationOutcome: decision.unwind?.arbitrationOutcome ?? null,
    candidates: decision.trace.entry.candidates,
    seedCandidates: decision.trace.entry.seedCandidates ?? [],
  };
}

function computeRecentSeedFlowCount(state: Pick<XuanMarketState, "fillHistory">, nowTs: number): number {
  return countRecentSeedFlowCountFromHistory(state.fillHistory, nowTs);
}

function computeActiveIndependentFlowCount(
  state: Pick<XuanMarketState, "fillHistory">,
  nowTs: number,
): number {
  return countActiveIndependentFlowCountFromHistory(state.fillHistory, nowTs);
}

function selectPreferredSeedSide(decision: ReturnType<Xuan5mBot["evaluateTick"]>): OutcomeSide | undefined {
  const overlapSeed = decision.entryBuys.find((entryBuy) => entryBuy.reason === "temporal_single_leg_seed");
  if (overlapSeed) {
    return overlapSeed.side;
  }
  return decision.trace.entry.seedCandidates?.find((candidate) => candidate.allowed)?.side;
}

function decisionTraceSignature(decision: ReturnType<Xuan5mBot["evaluateTick"]>): string {
  const entry = decision.trace.entry;
  const candidateSignature = entry.candidates
    .map((candidate) => `${candidate.requestedSize}:${candidate.verdict}:${candidate.pairCost.toFixed(6)}`)
    .join("|");
  const seedSignature = (entry.seedCandidates ?? [])
    .map(
      (candidate) =>
        `${candidate.side}:${candidate.allowed ? "ok" : candidate.skipReason ?? "skip"}:${candidate.referencePairCost.toFixed(6)}`,
    )
    .join("|");

  return [
    decision.phase,
    decision.risk.allowNewEntries ? "entry_on" : "entry_off",
    decision.risk.completionOnly ? "completion_only" : "normal",
    decision.risk.hardCancel ? "hard_cancel" : "soft",
    decision.risk.reasons.join(","),
    decision.trace.fairValue?.status ?? "",
    decision.trace.fairValue?.fairUp?.toFixed(4) ?? "",
    decision.trace.fairValue?.fairDown?.toFixed(4) ?? "",
    decision.trace.protectedResidualContext ? "protected_residual" : "no_protected_residual",
    decision.trace.flowRotationRetryAttempted ? "flow_retry_attempted" : "flow_retry_not_attempted",
    decision.trace.flowRotationRetrySelected ? "flow_retry_selected" : "flow_retry_not_selected",
    decision.trace.sameWindowCompletionAndOverlap ? "same_window_completion_overlap" : "single_action_window",
    entry.mode,
    entry.skipReason ?? "",
    entry.residualSeverityLevel ?? "",
    entry.overlapRepairArbitration ?? "",
    entry.overlapRepairReason ?? "",
    entry.overlapRepairOutcome ?? "",
    entry.gatedByRisk ? "gated" : "open",
    candidateSignature,
    seedSignature,
    entry.repairAllowed === undefined ? "" : entry.repairAllowed ? "repair_ok" : "repair_blocked",
    entry.repairCost?.toFixed(6) ?? "",
    decision.completion?.mode ?? "",
    decision.completion?.overlapRepairArbitration ?? "",
    decision.unwind?.mode ?? "",
    decision.unwind?.overlapRepairArbitration ?? "",
  ].join("::");
}

function pickSessionMarket(
  market: { current: MarketInfo; next: MarketInfo },
  nowTs: number,
  normalEntryCutoffSecToClose: number,
): { selection: "current" | "next"; market: MarketInfo } {
  const secsToCurrentClose = market.current.endTs - nowTs;
  if (secsToCurrentClose <= normalEntryCutoffSecToClose) {
    return { selection: "next", market: market.next };
  }
  return { selection: "current", market: market.current };
}

async function waitForInitialBooks(
  client: MarketWsClient,
  market: MarketInfo,
  initialBookWaitMs: number,
): Promise<{ upBook: OrderBook; downBook: OrderBook }> {
  const waitDeadline = Date.now() + initialBookWaitMs;

  while (Date.now() < waitDeadline) {
    const upBook = client.getBook(market.tokens.UP.tokenId);
    const downBook = client.getBook(market.tokens.DOWN.tokenId);
    if (upBook && downBook) {
      return { upBook, downBook };
    }
    await sleep(250);
  }

  throw new Error("Initial orderbooks were not received before timeout.");
}

async function readObservedBalances(
  reader: Erc1155BalanceReader,
  market: MarketInfo,
  ownerAddress: string,
): Promise<ObservedTokenBalances> {
  const balances = await reader.getBalances([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId], ownerAddress);
  return {
    up: balances.get(String(market.tokens.UP.tokenId)) ?? 0,
    down: balances.get(String(market.tokens.DOWN.tokenId)) ?? 0,
  };
}

async function readCollateralBalanceUsdc(env: AppEnv): Promise<number | undefined> {
  if (!env.ACTIVE_COLLATERAL_TOKEN || env.ACTIVE_COLLATERAL_TOKEN === "0x0000000000000000000000000000000000000000") {
    return undefined;
  }
  const reader = new Erc20BalanceReader(env);
  const raw = await reader.getBalance(env.ACTIVE_COLLATERAL_TOKEN, resolveConfiguredFunderAddress(env));
  return raw / 1_000_000;
}

export function inferUserTradeFill(args: {
  event: UserTradeEvent;
  market: MarketInfo;
  nowTs: number;
  submittedPrices: SubmittedIntentBook;
}): FillRecord | undefined {
  const outcome = normalizeOutcome(args.event.outcome) ?? outcomeForAssetId(args.market, args.event.asset_id);
  if (!outcome) {
    return undefined;
  }

  const makerOrders = args.event.maker_orders ?? [];
  const matchedSize = makerOrders.reduce((acc, order) => acc + (parseNumeric(order.matched_amount) ?? 0), 0);
  if (matchedSize <= 0) {
    return undefined;
  }

  const weightedNotional = makerOrders.reduce(
    (acc, order) => acc + (parseNumeric(order.matched_amount) ?? 0) * (parseNumeric(order.price) ?? 0),
    0,
  );
  const weightedPrice = matchedSize > 0 ? weightedNotional / matchedSize : undefined;
  const fallbackIntent = latestSubmittedIntent(args.submittedPrices, outcome);
  const price = parseNumeric(args.event.price) ?? weightedPrice ?? fallbackIntent?.price;
  const makerSide = makerOrders[0]?.side?.toUpperCase();
  const side: TradeSide =
    fallbackIntent?.side ??
    (makerSide === "BUY" ? "SELL" : "BUY");

  return {
    outcome,
    side,
    price: clampFallbackPrice(price),
    size: Number(matchedSize.toFixed(6)),
    timestamp: args.nowTs,
    makerTaker: "taker",
    executionMode: fallbackIntent?.mode,
  };
}

export function reconcileStateWithBalances(args: {
  state: XuanMarketState;
  observed: ObservedTokenBalances;
  nowTs: number;
  fallbackPrices: Record<OutcomeSide, number | undefined>;
  shouldIgnoreShortfall?: ((candidate: BalanceShortfallCandidate) => boolean) | undefined;
}): StateReconcileResult {
  let state = { ...args.state };
  const inferredFills: FillRecord[] = [];
  const corrections: BalanceCorrection[] = [];

  const reconcileOutcome = (outcome: OutcomeSide, observedShares: number): void => {
    const sharesKey = outcome === "UP" ? "upShares" : "downShares";
    const currentShares = state[sharesKey];
    const normalizedObserved = Number(observedShares.toFixed(6));

    if (normalizedObserved > currentShares + 1e-6) {
      const fill: FillRecord = {
        outcome,
        side: "BUY",
        price: clampFallbackPrice(args.fallbackPrices[outcome]),
        size: Number((normalizedObserved - currentShares).toFixed(6)),
        timestamp: args.nowTs,
        makerTaker: "unknown",
      };
      state = applyFill(state, fill);
      inferredFills.push(fill);
      return;
    }

    if (normalizedObserved < currentShares - 1e-6) {
      const candidate: BalanceShortfallCandidate = {
        outcome,
        fromShares: currentShares,
        toShares: normalizedObserved,
        nowTs: args.nowTs,
      };
      if (args.shouldIgnoreShortfall?.(candidate)) {
        return;
      }
      state = shrinkOutcomeToObservedShares(state, outcome, normalizedObserved);
      corrections.push({
        outcome: candidate.outcome,
        fromShares: candidate.fromShares,
        toShares: candidate.toShares,
      });
    }
  };

  reconcileOutcome("UP", args.observed.up);
  reconcileOutcome("DOWN", args.observed.down);

  return { state, inferredFills, corrections };
}

function buildFallbackPrices(
  books: OrderBookState,
  submittedPrices: SubmittedIntentBook,
): Record<OutcomeSide, number | undefined> {
  return {
    UP: latestSubmittedIntent(submittedPrices, "UP")?.price ?? books.bestAsk("UP"),
    DOWN: latestSubmittedIntent(submittedPrices, "DOWN")?.price ?? books.bestAsk("DOWN"),
  };
}

function latestSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
): SubmittedIntent | undefined {
  const intents = submittedPrices[outcome] ?? [];
  return [...intents].reverse().find((intent) => intent.active) ?? intents.at(-1);
}

function recentSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
  nowTs: number,
  maxAgeSec: number,
): SubmittedIntent | undefined {
  const intents = submittedPrices[outcome] ?? [];
  return [...intents]
    .reverse()
    .find((intent) => nowTs - intent.submittedAt <= maxAgeSec);
}

function findActiveSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
): SubmittedIntent | undefined {
  const intents = submittedPrices[outcome] ?? [];
  return intents.find((intent) => intent.active);
}

function consumeSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
  filledShares: number,
): SubmittedIntent | undefined {
  const intent = findActiveSubmittedIntent(submittedPrices, outcome);
  if (!intent) {
    return undefined;
  }
  intent.attributedShares = normalizeShares(intent.attributedShares + filledShares);
  if (
    intent.expectedShares === undefined ||
    intent.attributedShares >= normalizeShares(Math.max(0, intent.expectedShares - 1e-6))
  ) {
    intent.active = false;
  }
  return intent;
}

function resolveFillIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
  filledShares: number,
  nowTs: number,
  maxAgeSec: number,
): SubmittedIntent | undefined {
  return (
    consumeSubmittedIntent(submittedPrices, outcome, filledShares) ??
    recentSubmittedIntent(submittedPrices, outcome, nowTs, maxAgeSec)
  );
}

function inferPendingPairExecutionIntent(args: {
  pending: PendingPairExecution | undefined;
  outcome: OutcomeSide;
  filledShares: number;
  fillSnapshot?: { upBoughtQty: number; downBoughtQty: number } | undefined;
}): SubmittedIntent | undefined {
  if (!args.pending) {
    return undefined;
  }

  const alreadyAttributed =
    args.outcome === "UP" ? args.fillSnapshot?.upBoughtQty ?? 0 : args.fillSnapshot?.downBoughtQty ?? 0;
  const remainingQty = normalizeShares(Math.max(0, args.pending.group.intendedQty - alreadyAttributed));
  if (remainingQty <= 1e-6) {
    return undefined;
  }

  const toleranceShares = 0.5;
  if (args.filledShares > remainingQty + toleranceShares) {
    return undefined;
  }

  return {
    side: "BUY",
    price: args.outcome === "UP" ? args.pending.group.maxUpPrice : args.pending.group.maxDownPrice,
    submittedAt: args.pending.submittedAt,
    mode: args.pending.group.selectedMode,
    groupId: args.pending.group.groupId,
    expectedShares: remainingQty,
    attributedShares: normalizeShares(args.filledShares),
    active: false,
  };
}

function extractExpectedSharesFromOrderResult(result: OrderResult | undefined): number | undefined {
  const raw = result?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = Number((raw as { takingAmount?: unknown }).takingAmount);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return normalizeShares(value);
}

function expectedSharesForSubmission(
  shareTarget: number | undefined,
  result: OrderResult | undefined,
): number | undefined {
  return extractExpectedSharesFromOrderResult(result) ?? (shareTarget !== undefined ? normalizeShares(shareTarget) : undefined);
}

function asOrderRawObject(result: OrderResult | undefined): Record<string, unknown> | undefined {
  if (!result?.raw || typeof result.raw !== "object" || Array.isArray(result.raw)) {
    return undefined;
  }
  return result.raw as Record<string, unknown>;
}

function extractOrderResultExecutionPrice(
  result: OrderResult | undefined,
  fallbackPrice: number | undefined,
): number {
  const raw = asOrderRawObject(result);
  const takingAmount = Number(raw?.takingAmount);
  const makingAmount = Number(raw?.makingAmount);
  if (Number.isFinite(takingAmount) && takingAmount > 0 && Number.isFinite(makingAmount) && makingAmount > 0) {
    return Number(clampFallbackPrice(makingAmount / takingAmount).toFixed(6));
  }
  return Number(clampFallbackPrice(fallbackPrice).toFixed(6));
}

export function inferImmediateOrderResultFill(args: {
  result: OrderResult | undefined;
  order: MarketOrderArgs;
  outcome: OutcomeSide;
  nowTs: number;
  mode?: StrategyExecutionMode | undefined;
}): FillRecord | undefined {
  if (!args.result || !isOrderResultAccepted(args.result)) {
    return undefined;
  }
  const size = extractMatchedShares(args.result);
  if (size <= 1e-6) {
    return undefined;
  }
  return {
    outcome: args.outcome,
    side: args.order.side,
    price: extractOrderResultExecutionPrice(args.result, args.order.price),
    size,
    timestamp: args.nowTs,
    makerTaker: "taker",
    executionMode: args.mode,
  };
}

function rememberSubmittedPrices(
  submittedPrices: SubmittedIntentBook,
  market: MarketInfo,
  orders: Array<{
    tokenId: string;
    side: TradeSide;
    price?: number | undefined;
    mode?: StrategyExecutionMode | undefined;
    groupId?: string | undefined;
    orderId?: string | undefined;
    expectedShares?: number | undefined;
  }>,
  submittedAt: number,
): void {
  for (const order of orders) {
    const outcome = outcomeForAssetId(market, order.tokenId);
    if (!outcome) {
      continue;
    }
    const nextIntent: SubmittedIntent = {
      side: order.side,
      price: order.price,
      submittedAt,
      mode: order.mode,
      groupId: order.groupId,
      orderId: order.orderId,
      expectedShares: order.expectedShares,
      attributedShares: 0,
      active: true,
    };
    const bucket = submittedPrices[outcome] ?? [];
    bucket.push(nextIntent);
    submittedPrices[outcome] = bucket;
  }
}

function buildBooks(client: MarketWsClient, market: MarketInfo): OrderBookState {
  return new OrderBookState(client.getBook(market.tokens.UP.tokenId), client.getBook(market.tokens.DOWN.tokenId));
}

function reserveNegativeEdgeBudget(
  state: XuanMarketState,
  negativeEdgeUsdc: number,
  bucket: "pair" | "completion",
): XuanMarketState {
  if (negativeEdgeUsdc <= 0) {
    return state;
  }
  return {
    ...state,
    negativeEdgeConsumedUsdc: Number((state.negativeEdgeConsumedUsdc + negativeEdgeUsdc).toFixed(6)),
    negativePairEdgeConsumedUsdc:
      bucket === "pair"
        ? Number((state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc).toFixed(6))
        : state.negativePairEdgeConsumedUsdc,
    negativeCompletionEdgeConsumedUsdc:
      bucket === "completion"
        ? Number((state.negativeCompletionEdgeConsumedUsdc + negativeEdgeUsdc).toFixed(6))
        : state.negativeCompletionEdgeConsumedUsdc,
  };
}

function consumedPairNegativeEdgeUsdc(args: {
  estimatedNegativeEdgeUsdc: number;
  intendedQty: number;
  filledUpQty: number;
  filledDownQty: number;
}): number {
  if (args.estimatedNegativeEdgeUsdc <= 0 || args.intendedQty <= 0) {
    return 0;
  }
  const fillRatio = Math.min(
    1,
    (Math.max(0, args.filledUpQty) + Math.max(0, args.filledDownQty)) / (args.intendedQty * 2),
  );
  return normalizeShares(args.estimatedNegativeEdgeUsdc * fillRatio);
}

function withAvailableUsdcBalance(order: MarketOrderArgs, usdcBalance: number | undefined): MarketOrderArgs {
  if (order.side !== "BUY" || usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0) {
    return order;
  }

  return {
    ...order,
    userUsdcBalance: Number(usdcBalance.toFixed(6)),
  };
}

function assignSequentialUsdcBalances(
  orders: MarketOrderArgs[],
  usdcBalance: number | undefined,
): MarketOrderArgs[] {
  if (usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0) {
    return orders;
  }

  let remainingBalance = usdcBalance;
  return orders.map((order) => {
    const balancedOrder = withAvailableUsdcBalance(order, remainingBalance);
    if (order.side === "BUY") {
      remainingBalance = normalizeShares(Math.max(0, remainingBalance - order.amount));
    }
    return balancedOrder;
  });
}

async function executeMarketOrdersInSequence(
  completionManager: TakerCompletionManager,
  orders: MarketOrderArgs[],
  interOrderDelayMs = 0,
): Promise<ExecutedMarketOrder[]> {
  const executed: ExecutedMarketOrder[] = [];
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index]!;
    executed.push({
      order,
      result: await completionManager.execute(order),
    });
    if (
      interOrderDelayMs > 0 &&
      index < orders.length - 1 &&
      isOrderResultAccepted(executed[executed.length - 1]!.result)
    ) {
      await sleep(childOrderDelayMs(interOrderDelayMs, `${order.tokenId}:${index}`));
    }
  }
  return executed;
}

function selectRepresentativeExecution(executions: ExecutedMarketOrder[]): ExecutedMarketOrder {
  return executions.find((execution) => isOrderResultAccepted(execution.result)) ?? executions[executions.length - 1]!;
}

function selectRepresentativeResult(executions: ExecutedMarketOrder[]): OrderResult | undefined {
  return executions.length > 0 ? selectRepresentativeExecution(executions).result : undefined;
}

function sumOrderShareTargets(orders: MarketOrderArgs[]): number | undefined {
  const total = orders.reduce((acc, order) => acc + (order.shareTarget ?? 0), 0);
  return total > 0 ? normalizeShares(total) : undefined;
}

function sumOrderAmounts(orders: MarketOrderArgs[]): number {
  return normalizeShares(orders.reduce((acc, order) => acc + order.amount, 0));
}

function buildPairOrderPlan(args: {
  config: XuanStrategyConfig;
  entriesBySide: Record<OutcomeSide, EntryBuyDecision>;
  books: OrderBookState;
  minOrderSize: number;
  cachedUsdcBalance: number | undefined;
}): PairOrderPlan {
  const buildSideOrders = (side: OutcomeSide): MarketOrderArgs[] => {
    const baseOrder = args.entriesBySide[side].order;
    const plannedOrders =
      args.config.xuanCloneMode === "PUBLIC_FOOTPRINT"
        ? planCloneChildBuyOrders({
            order: baseOrder,
            outcome: side,
            books: args.books,
            minOrderSize: args.minOrderSize,
            preferredChildShares: args.config.cloneChildPreferredShares,
          })
        : [baseOrder];
    return assignSequentialUsdcBalances(plannedOrders, args.cachedUsdcBalance);
  };

  return {
    UP: buildSideOrders("UP"),
    DOWN: buildSideOrders("DOWN"),
  };
}

async function executePairOrderPlan(args: {
  completionManager: TakerCompletionManager;
  orderPlanBySide: PairOrderPlan;
  orderedEntries: EntryBuyDecision[];
  sequentialPairExecutionActive: boolean;
  interChildDelayMs: number;
}): Promise<Record<OutcomeSide, ExecutedMarketOrder[]>> {
  const executedBySide: Record<OutcomeSide, ExecutedMarketOrder[]> = {
    UP: [],
    DOWN: [],
  };

  if (args.sequentialPairExecutionActive) {
    let abortRemainingSides = false;
    for (const entryBuy of args.orderedEntries) {
      if (abortRemainingSides) {
        break;
      }
      const sideOrders = args.orderPlanBySide[entryBuy.side];
      for (let index = 0; index < sideOrders.length; index += 1) {
        const order = sideOrders[index]!;
        const execution = {
          order,
          result: await args.completionManager.execute(order),
        };
        executedBySide[entryBuy.side].push(execution);
        if (!isOrderResultAccepted(execution.result)) {
          if (index === 0) {
            abortRemainingSides = true;
          }
          break;
        }
        if (args.interChildDelayMs > 0 && index < sideOrders.length - 1) {
          await sleep(childOrderDelayMs(args.interChildDelayMs, `${entryBuy.side}:${index}`));
        }
      }
    }
    return executedBySide;
  }

  const maxBatchCount = Math.max(args.orderPlanBySide.UP.length, args.orderPlanBySide.DOWN.length);
  const sideOrder = pairExecutionSideOrder(args.orderedEntries);
  for (let batchIndex = 0; batchIndex < maxBatchCount; batchIndex += 1) {
    const batch = sideOrder
      .map((side) => {
        const order = args.orderPlanBySide[side][batchIndex];
        return order ? { side, order } : undefined;
      })
      .filter((item): item is { side: OutcomeSide; order: MarketOrderArgs } => item !== undefined);
    if (batch.length === 0) {
      continue;
    }
    const results = await Promise.all(batch.map((item) => args.completionManager.execute(item.order)));
    let batchAccepted = true;
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]!;
      const result = results[index]!;
      executedBySide[item.side].push({
        order: item.order,
        result,
      });
      if (!isOrderResultAccepted(result)) {
        batchAccepted = false;
      }
    }
    if (!batchAccepted) {
      break;
    }
    if (args.interChildDelayMs > 0 && batchIndex < maxBatchCount - 1) {
      await sleep(childOrderDelayMs(args.interChildDelayMs, `pair-batch:${batchIndex}`));
    }
  }

  return executedBySide;
}

function pairExecutionSideOrder(orderedEntries: EntryBuyDecision[]): OutcomeSide[] {
  const sides = orderedEntries
    .map((entry) => entry.side)
    .filter((side, index, all): side is OutcomeSide => all.indexOf(side) === index);
  return sides.length > 0 ? sides : ["UP", "DOWN"];
}

function orderPairEntriesForPublicFootprint(args: {
  config: Pick<XuanStrategyConfig, "botMode" | "xuanCloneMode">;
  state: Pick<XuanMarketState, "upShares" | "downShares">;
  group: Pick<PairOrderGroup, "selectedMode">;
  groupedEntries: EntryBuyDecision[];
  controlledOverlapActive: boolean;
  missingSide: OutcomeSide;
}): EntryBuyDecision[] {
  if (args.group.selectedMode === "PAIRGROUP_COVERED_SEED") {
    return args.groupedEntries;
  }
  const shouldPrioritizeSide =
    args.controlledOverlapActive ||
    (args.config.botMode === "XUAN" &&
      args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      Math.abs(args.state.upShares - args.state.downShares) > 1e-6);
  if (!shouldPrioritizeSide) {
    return args.groupedEntries;
  }
  return [...args.groupedEntries].sort((left, right) => {
    if (left.side === right.side) return 0;
    return left.side === args.missingSide ? -1 : 1;
  });
}

async function logRejectedOrder(args: {
  traceLogger: JsonlTraceLogger;
  phase: "entry" | "completion" | "unwind";
  mode: string;
  side?: OutcomeSide | undefined;
  size: number;
  result: OrderResult;
  order: MarketOrderArgs;
  negativeEdgeUsdc?: number | undefined;
}): Promise<void> {
  await args.traceLogger.write("errors", {
    channel: "order_submit",
    severity: "warn",
    phase: args.phase,
    mode: args.mode,
    outcome: args.side ?? null,
    size: args.size,
    price: args.order.price ?? null,
    shareTarget: args.order.shareTarget ?? null,
    spendAmount: args.order.amount,
    negativeEdgeUsdc: args.negativeEdgeUsdc ?? 0,
    ...summarizeOrderResult(args.result),
  });
}

function updateSeedSubmissionState(
  state: XuanMarketState,
  mode: StrategyExecutionMode,
  side: OutcomeSide,
): XuanMarketState {
  if (mode === "PAIRGROUP_COVERED_SEED" || mode === "TEMPORAL_SINGLE_LEG_SEED") {
    const nextCount = state.consecutiveSeedSide === side ? state.consecutiveSeedCount + 1 : 1;
    return {
      ...state,
      consecutiveSeedSide: side,
      consecutiveSeedCount: nextCount,
      lastExecutionMode: mode,
    };
  }

  return {
    ...state,
    consecutiveSeedSide: undefined,
    consecutiveSeedCount: 0,
    lastExecutionMode: mode,
  };
}

function assertClassifiedBuyMode(mode: StrategyExecutionMode, config: Pick<XuanStrategyConfig, "rejectUnclassifiedBuy">): void {
  if (!config.rejectUnclassifiedBuy) {
    return;
  }
  if (!isClassifiedBuyMode(mode)) {
    throw new Error(`Unclassified BUY mode rejected: ${mode}`);
  }
}

function resolveActivePairExecution(
  pending: PendingPairExecution | undefined,
  state: XuanMarketState,
  fillSnapshot?: { upBoughtQty: number; downBoughtQty: number },
): PendingPairExecution | undefined {
  if (!pending) {
    return undefined;
  }
  const status = resolvePairOrderGroupStatus(pending.group, state, fillSnapshot);
  return {
    ...pending,
    status,
  };
}

export async function runStatefulBotSession(
  env: AppEnv,
  options: BotSessionOptions = {},
): Promise<BotSessionReport> {
  if (!env.BOT_PRIVATE_KEY || !env.POLY_API_KEY || !env.POLY_API_SECRET || !env.POLY_API_PASSPHRASE) {
    throw new Error("Stateful bot:live icin BOT_PRIVATE_KEY ve POLY_API_* credential seti gerekli.");
  }

  const resolvedOptions: Required<BotSessionOptions> = {
    durationSec: Math.max(10, Math.floor(options.durationSec ?? 240)),
    postCloseReconcileSec: Math.max(0, Math.floor(options.postCloseReconcileSec ?? 0)),
    tickMs: Math.max(250, Math.floor(options.tickMs ?? 1000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
    balanceSyncMs: Math.max(1000, Math.floor(options.balanceSyncMs ?? 5000)),
    marketSelection: options.marketSelection ?? "auto",
    initialDailyNegativeEdgeSpentUsdc: Math.max(0, Number(options.initialDailyNegativeEdgeSpentUsdc ?? 0)),
    dailyBudgetStorePath: options.dailyBudgetStorePath ?? "",
  };

  const logger = createLogger(env);
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  if (!env.DRY_RUN && config.validationSequence === "REPLAY_THEN_LIVE" && config.replayRequiredBeforeLive) {
    const latestReplayValidation = stateStore.latestValidationRun("replay");
    if (!latestReplayValidation || !isReplayComparatorStatus(latestReplayValidation.status) || latestReplayValidation.status === "fail") {
      stateStore.close();
      throw new Error(
        "Live once comparator replay validation gerekli. Once npm run xuan:compare-paper veya npm run xuan:compare-runtime calistir.",
      );
    }
  }
  const clob = createClobAdapter(env);
  const gamma = new GammaClient(env);
  const clock = new SystemClock();
  const bot = new Xuan5mBot();
  const orderManager = new OrderManager(clob);
  const completionManager = new TakerCompletionManager(orderManager);
  const ctf = new CtfClient(env);
  const marketWs = new MarketWsClient(env);
  const userWs = new UserWsClient(env);
  const balanceReader = new Erc1155BalanceReader(env);
  const startedAt = clock.now();

  const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
  let selected =
    resolvedOptions.marketSelection === "current"
      ? { selection: "current" as const, market: discovery.current }
      : resolvedOptions.marketSelection === "next"
        ? { selection: "next" as const, market: discovery.next }
        : pickSessionMarket(discovery, startedAt, config.normalEntryCutoffSecToClose);
  let startupInventorySnapshot =
    config.startupInventoryPolicy === "ADOPT_AND_RECONCILE"
      ? await fetchInventorySnapshot(env, config)
      : undefined;
  if (
    resolvedOptions.marketSelection === "auto" &&
    startupInventorySnapshot?.currentMarket &&
    startupInventorySnapshot.currentMarket.totalShares >= config.dustSharesThreshold
  ) {
    selected = {
      selection: "current",
      market: discovery.current,
    };
  }
  const market = selected.market;
  const balanceOwnerAddress = resolveConfiguredFunderAddress(env);
  const persistedBudget = stateStore.loadRiskBudget({
    wallet: balanceOwnerAddress,
    now: new Date(startedAt * 1000),
  });
  const initialDailyNegativeEdgeSpentUsdc = Math.max(
    0,
    Number(
      options.initialDailyNegativeEdgeSpentUsdc ?? persistedBudget.dailyNegativeSpentUsdc,
    ),
  );
  resolvedOptions.initialDailyNegativeEdgeSpentUsdc = initialDailyNegativeEdgeSpentUsdc;
  const runId = `live-${market.slug}-${startedAt}`;
  const traceLogger = new JsonlTraceLogger(env, {
    runId,
    source: "stateful_session",
    botMode: config.botMode,
    dryRun: env.DRY_RUN,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    upTokenId: market.tokens.UP.tokenId,
    downTokenId: market.tokens.DOWN.tokenId,
  });
  let state = createMarketState(market);
  let cachedUsdcBalance = (await readCollateralBalanceUsdc(env)) ?? Math.max(config.minUsdcBalance, 100);
  let startupBlockNewEntries = false;
  let startupCompletionOnly = false;
  let startupSafeHalt = false;
  let startupExternalReasons: string[] = [];
  let externalActivityDetected = false;
  let pairgroupLinkageHealthy = true;
  let grouplessFillEvents = 0;
  let lastBalanceSyncAt = 0;
  let actionCooldownUntil = 0;
  let lastMergeAtMs = 0;
  let mergeTxCount = 0;
  let adoptedInventory = false;
  let userTradeCount = 0;
  let balanceSyncCount = 0;
  let balanceCorrectionCount = 0;
  let entrySubmitCount = 0;
  let pairGroupCount = 0;
  let partialLegCount = 0;
  let completionSubmitCount = 0;
  let unwindSubmitCount = 0;
  let mergeCount = 0;
  let arbitrationCarryCreatedCount = 0;
  let arbitrationCarryExtendedCount = 0;
  let arbitrationCarryExpiredCount = 0;
  let entryArbitrationActionDeltaCount = 0;
  let runtimeFlowBudgetLedgerLoad = 0;
  let runtimeFlowBudgetLastAction: RuntimeFlowBudgetLedgerAction | undefined;
  let runtimeFlowBudgetLastLineage: string | undefined;
  let runtimeFlowBudgetLineageLoads: Record<string, number> = {};
  let ticks = 0;
  const submittedPrices: SubmittedIntentBook = {};
  const seenTradeIds = new Set<string>();
  const orderResultFillSuppressions: Array<{
    outcome: OutcomeSide;
    size: number;
    price: number;
    expiresAt: number;
  }> = [];
  const recentBotOwnedBuyFills: RecentBotOwnedBuyFill[] = [];
  const events: Array<Record<string, unknown>> = [];
  let pendingPairExecution: PendingPairExecution | undefined;
  let partialOpenGroupLock: PartialOpenGroupLock | undefined;
  let runtimeProtectedResidualLock: RuntimeProtectedResidualLock | undefined;
  let arbitrationCarry: ArbitrationCarry | undefined;
  let activePairSubmission: ActivePairSubmission | undefined;
  let lastDecisionTraceAt = 0;
  let lastDecisionTraceSignature = "";
  let marketEventSeq = 0;
  let mergeBatchTracker = createMergeBatchTracker();
  let latestBookEventAtMs = Date.now();
  let lastBookEventAtMs: Record<OutcomeSide, number> = {
    UP: Date.now(),
    DOWN: Date.now(),
  };
  let pendingDecisionPulseResolve: (() => void) | undefined;
  let latestFairValueSnapshot: FairValueSnapshot | undefined;
  const btcPriceFeed = new BtcPriceFeed();
  const fairValueRuntime = new MarketFairValueRuntime(config, market, stateStore, btcPriceFeed);
  const runtimeValidationRuns = stateStore.recentValidationRuns("replay", 12);
  const runtimeFlowCalibration = buildFlowCalibrationSummary(
    extractFlowSummariesFromValidationRuns(runtimeValidationRuns),
  );
  const runtimeFlowCalibrationBias = {
    ...deriveRuntimeFlowCalibrationBias(runtimeFlowCalibration),
    childOrderDispatchDelayCapMs: deriveRuntimeChildOrderDispatchDelayCapMs(
      extractRuntimeChildOrderDispatchSummaries(runtimeValidationRuns),
    ),
  };
  const persistedSafeHalt = stateStore.loadSafeHalt();
  if (persistedSafeHalt.active && config.requireManualResumeConfirm) {
    stateStore.close();
    throw new Error(
      `SAFE_HALT aktif (${persistedSafeHalt.reason ?? "external_activity"}). Once npm run inventory:reconcile, sonra npm run inventory:report, en son npm run bot:resume --confirm calistir.`,
    );
  }

  const persistDailyBudget = (nextState: XuanMarketState): void => {
    stateStore.upsertRiskBudget({
      wallet: balanceOwnerAddress,
      dailyNegativeSpentUsdc: initialDailyNegativeEdgeSpentUsdc + nextState.negativeEdgeConsumedUsdc,
      marketSlug: market.slug,
      marketNegativeSpentUsdc: nextState.negativePairEdgeConsumedUsdc,
      now: new Date(clock.now() * 1000),
    });
  };
  const persistMarketState = (noNewEntryReason?: string | undefined): void => {
    const flowBudgetSnapshot: PersistedFlowBudgetSnapshot = {
      load: runtimeFlowBudgetLedgerLoad,
      updatedAt: clock.now(),
      lastAction: runtimeFlowBudgetLastAction,
      lastLineage: runtimeFlowBudgetLastLineage,
      lineageLoads: runtimeFlowBudgetLineageLoads,
    };
    stateStore.upsertMarketState(state, noNewEntryReason, {
      arbitrationCarry:
        arbitrationCarry !== undefined
          ? {
              createdAt: arbitrationCarry.createdAt,
              recommendation: arbitrationCarry.recommendation,
              preferredSeedSide: arbitrationCarry.preferredSeedSide,
              protectedResidualSide: arbitrationCarry.protectedResidualSide,
              referenceShareGap: arbitrationCarry.referenceShareGap,
              alignmentStreak: arbitrationCarry.alignmentStreak,
              lastObservedAt: arbitrationCarry.lastObservedAt,
              lastProtectedShares: arbitrationCarry.lastProtectedShares,
              expiresAt: arbitrationCarry.expiresAt,
              residualSeverityLevel: arbitrationCarry.residualSeverityLevel,
            }
          : undefined,
      flowBudget: flowBudgetSnapshot,
    });
  };
  const applyRuntimeFlowBudgetAction = (
    action: RuntimeFlowBudgetLedgerAction,
    args: {
      quantityShares?: number | undefined;
      lineage?: string | undefined;
    } = {},
  ): void => {
    const baseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
    runtimeFlowBudgetLedgerLoad = applyRuntimeFlowBudgetLedgerAction(runtimeFlowBudgetLedgerLoad, action, {
      quantityShares: args.quantityShares,
      baseLot,
    });
    runtimeFlowBudgetLineageLoads = applyRuntimeFlowBudgetLineageLedgerAction(
      runtimeFlowBudgetLineageLoads,
      action,
      {
        lineage: args.lineage,
        quantityShares: args.quantityShares,
        baseLot,
      },
    );
    runtimeFlowBudgetLastAction = action;
    runtimeFlowBudgetLastLineage = args.lineage;
  };
  const currentRuntimeFlowLineage = (fallbackSide?: OutcomeSide | undefined): string | undefined =>
    deriveCarryFlowLineageKey({
      recommendation: arbitrationCarry?.recommendation,
      preferredSeedSide: arbitrationCarry?.preferredSeedSide ?? fallbackSide,
      protectedResidualSide:
        arbitrationCarry?.protectedResidualSide ?? (partialOpenGroupLock ?? runtimeProtectedResidualLock)?.protectedSide,
    });
  const submittedIntentMaxAgeSec = Math.max(15, Math.ceil(config.pairgroupFinalizeTimeoutMs / 1000) + 2);

  const rememberOrderResultFillSuppression = (fill: FillRecord): void => {
    orderResultFillSuppressions.push({
      outcome: fill.outcome,
      size: fill.size,
      price: fill.price,
      expiresAt: fill.timestamp + submittedIntentMaxAgeSec,
    });
  };

  const consumeOrderResultFillSuppression = (fill: FillRecord): boolean => {
    const nowTs = fill.timestamp;
    for (let index = orderResultFillSuppressions.length - 1; index >= 0; index -= 1) {
      if (orderResultFillSuppressions[index]!.expiresAt < nowTs) {
        orderResultFillSuppressions.splice(index, 1);
      }
    }
    const matchedIndex = orderResultFillSuppressions.findIndex(
      (candidate) =>
        candidate.outcome === fill.outcome &&
        Math.abs(candidate.size - fill.size) <= Math.max(1e-6, fill.size * 0.001) &&
        Math.abs(candidate.price - fill.price) <= 0.005,
    );
    if (matchedIndex < 0) {
      return false;
    }
    orderResultFillSuppressions.splice(matchedIndex, 1);
    return true;
  };

  const rememberBotOwnedBuyFill = (
    fill: FillRecord,
    context: { groupId?: string | undefined; orderId?: string | undefined } = {},
  ): void => {
    if (fill.side !== "BUY") {
      return;
    }
    recentBotOwnedBuyFills.push({
      outcome: fill.outcome,
      size: fill.size,
      price: fill.price,
      timestamp: fill.timestamp,
      expiresAt: fill.timestamp + submittedIntentMaxAgeSec,
      groupId: context.groupId,
      orderId: context.orderId,
    });
  };

  const pruneBotOwnedBuyFills = (nowTs: number): void => {
    for (let index = recentBotOwnedBuyFills.length - 1; index >= 0; index -= 1) {
      if (recentBotOwnedBuyFills[index]!.expiresAt < nowTs) {
        recentBotOwnedBuyFills.splice(index, 1);
      }
    }
  };

  const findBotOwnedFillForShortfall = (
    candidate: Pick<BalanceShortfallCandidate, "outcome" | "fromShares" | "toShares" | "nowTs">,
  ): RecentBotOwnedBuyFill | undefined => {
    pruneBotOwnedBuyFills(candidate.nowTs);
    return [...recentBotOwnedBuyFills].reverse().find((fill) => {
      if (fill.outcome !== candidate.outcome) {
        return false;
      }
      const fillTolerance = Math.max(0.5, fill.size * 0.08);
      if (candidate.toShares <= 1e-6) {
        return Math.abs(candidate.fromShares - fill.size) <= fillTolerance;
      }
      const shortfall = candidate.fromShares - candidate.toShares;
      return candidate.fromShares >= fill.size - fillTolerance && shortfall > 0 && shortfall <= fillTolerance;
    });
  };

  const shouldIgnoreTransientBotOwnedShortfall = (candidate: BalanceShortfallCandidate): boolean => {
    if (candidate.toShares > 1e-6) {
      return false;
    }
    const matchedFill = findBotOwnedFillForShortfall(candidate);
    if (!matchedFill) {
      return false;
    }
    return candidate.nowTs - matchedFill.timestamp <= BOT_OWNED_ZERO_BALANCE_GRACE_SEC;
  };

  const matchActivePairSubmission = (fill: FillRecord): ActivePairSubmission["entries"][number] | undefined => {
    const active = activePairSubmission;
    if (!active || fill.timestamp > active.expiresAt) {
      activePairSubmission = undefined;
      return undefined;
    }
    return active.entries.find((entry) => {
      if (entry.outcome !== fill.outcome) {
        return false;
      }
      if (entry.expectedShares !== undefined) {
        const shareTolerance = Math.max(0.5, entry.expectedShares * 0.1);
        if (fill.size > entry.expectedShares + shareTolerance) {
          return false;
        }
      }
      if (entry.price !== undefined && Math.abs(fill.price - entry.price) > 0.05) {
        return false;
      }
      return true;
    });
  };

  const signalDecisionPulse = (): void => {
    const resolve = pendingDecisionPulseResolve;
    pendingDecisionPulseResolve = undefined;
    resolve?.();
  };

  const waitForDecisionPulse = async (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingDecisionPulseResolve === onPulse) {
          pendingDecisionPulseResolve = undefined;
        }
        resolve();
      }, resolvedOptions.tickMs);

      const onPulse = () => {
        clearTimeout(timer);
        resolve();
      };

      pendingDecisionPulseResolve = onPulse;
    });

  const writeRiskEvent = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await traceLogger.write("risk_events", {
      reason,
      ...extra,
    });
  };

  const markExternalActivity = async (
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    if (externalActivityDetected) {
      return;
    }
    externalActivityDetected = true;
    startupBlockNewEntries = config.blockNewEntryOnExternalActivity;
    startupCompletionOnly =
      config.externalActivityMode === "SAFE_HALT" ? false : config.requireReconcileAfterManualTrade;
    startupSafeHalt = config.externalActivityMode === "SAFE_HALT";
    if (startupSafeHalt) {
      stateStore.setSafeHalt({
        active: true,
        reason,
        timestamp: clock.now(),
      });
      try {
        await clob.cancelAll();
      } catch (error) {
        logger.warn({ error }, "SAFE_HALT cancelAll failed.");
      }
    }
    startupExternalReasons = [...new Set([...startupExternalReasons, reason])];
    stateStore.recordExternalActivity({
      marketSlug: market.slug,
      conditionId: market.conditionId,
      timestamp: clock.now(),
      type: "runtime",
      action: reason,
      reason,
      botRecognized: false,
      responseMode: config.externalActivityMode,
    });
    await writeRiskEvent(reason, {
      stage: "runtime",
      blockNewEntries: startupBlockNewEntries,
      completionOnly: startupCompletionOnly,
      safeHalt: startupSafeHalt,
      ...extra,
    });
  };

  const markPairgroupRepairRequired = async (
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    pairgroupLinkageHealthy = false;
    grouplessFillEvents += 1;
    const escalateToGlobalSafeHalt =
      config.pairgroupRepairRequiredScope === "GLOBAL" ||
      config.pairgroupRepairRepeatEscalation === "GLOBAL_SAFE_HALT" &&
      grouplessFillEvents >= config.maxGrouplessFillEventsBeforeGlobalHalt;

    startupCompletionOnly = true;
    startupBlockNewEntries = true;
    startupExternalReasons = [...new Set([...startupExternalReasons, reason])];
    if (escalateToGlobalSafeHalt) {
      startupCompletionOnly = false;
      startupSafeHalt = true;
      stateStore.setSafeHalt({
        active: true,
        reason,
        timestamp: clock.now(),
      });
      try {
        await clob.cancelAll();
      } catch (error) {
        logger.warn({ error }, "pairgroup repair escalation cancelAll failed.");
      }
    }
    persistMarketState(reason);
    stateStore.recordReconcileRun({
      scope: "pairgroup_repair_required",
      marketSlug: market.slug,
      conditionId: market.conditionId,
      timestamp: clock.now(),
      status: escalateToGlobalSafeHalt ? "safe_halt" : "repair_required",
      requiresManualResume: true,
      payload: {
        scope: config.pairgroupRepairRequiredScope,
        grouplessFillEvents,
        escalated: escalateToGlobalSafeHalt,
        ...extra,
      },
    });
    await writeRiskEvent(reason, {
      stage: "pairgroup_repair",
      scope: config.pairgroupRepairRequiredScope,
      grouplessFillEvents,
      escalated: escalateToGlobalSafeHalt,
      ...extra,
    });
  };

  const persistFinalizedPairGroup = async (
    finalized: PairExecutionResult,
    pending: PendingPairExecution,
    finalizedAtTs: number,
  ): Promise<void> => {
    const actualNegativeEdgeUsdc = consumedPairNegativeEdgeUsdc({
      estimatedNegativeEdgeUsdc: pending.negativeEdgeUsdc,
      intendedQty: finalized.group.intendedQty,
      filledUpQty: finalized.filledUpQty,
      filledDownQty: finalized.filledDownQty,
    });
    const finalizedGroup = {
      ...finalized.group,
      negativeEdgeUsdc: actualNegativeEdgeUsdc,
      marketNegativeSpentAfter: normalizeShares(
        finalized.group.marketNegativeSpentBefore + actualNegativeEdgeUsdc,
      ),
    };

    if (actualNegativeEdgeUsdc > 0) {
      state = reserveNegativeEdgeBudget(state, actualNegativeEdgeUsdc, "pair");
      persistDailyBudget(state);
    }
    if (finalized.status === "UP_ONLY" || finalized.status === "DOWN_ONLY") {
      partialLegCount += 1;
      const protectedSide: OutcomeSide = finalized.status === "UP_ONLY" ? "UP" : "DOWN";
      partialOpenGroupLock = {
        groupId: finalized.group.groupId,
        status: finalized.status,
        openedAt: finalizedAtTs,
        protectedSide,
        protectedShares: normalizeShares(
          Math.max(
            Math.abs(finalized.filledUpQty - finalized.filledDownQty),
            Math.abs(state.upShares - state.downShares),
          ),
        ),
      };
      runtimeProtectedResidualLock = undefined;
      arbitrationCarry = undefined;
    } else if (partialOpenGroupLock?.groupId === finalized.group.groupId) {
      partialOpenGroupLock = undefined;
    }
    pushEvent(events, {
      timestamp: finalizedAtTs,
      type: "pair_group_finalized",
      groupId: finalized.group.groupId,
      status: finalized.status,
      intendedQty: finalized.group.intendedQty,
      negativeEdgeUsdc: actualNegativeEdgeUsdc,
      filledUpQty: finalized.filledUpQty,
      filledDownQty: finalized.filledDownQty,
      upResult: pending.upResult,
      downResult: pending.downResult,
    });
    await traceLogger.write("pair_groups", {
      eventType: "pair_group_finalized",
      pairGroupId: finalized.group.groupId,
      status: finalized.status,
      normalizedStatus:
        finalized.status === "UP_ONLY" || finalized.status === "DOWN_ONLY"
          ? "PARTIAL"
          : finalized.status,
      selectedMode: finalizedGroup.selectedMode,
      intendedQty: finalizedGroup.intendedQty,
      rawPair: finalizedGroup.rawPair,
      effectivePair: finalizedGroup.effectivePair,
      negativeEdgeUsdc: actualNegativeEdgeUsdc,
      marketNegativeSpentBefore: finalizedGroup.marketNegativeSpentBefore,
      marketNegativeSpentAfter: finalizedGroup.marketNegativeSpentAfter,
      filledUpQty: finalized.filledUpQty,
      filledDownQty: finalized.filledDownQty,
    });
    stateStore.upsertPairGroup(finalizedGroup);
    persistMarketState(partialOpenGroupLock?.groupId ? "partial_group_open" : undefined);
  };

  const writeInventorySnapshotTrace = async (
    label: string,
    snapshot: Awaited<ReturnType<typeof fetchInventorySnapshot>>,
  ): Promise<void> => {
    await traceLogger.write("inventory_snapshots", {
      label,
      walletAddress: snapshot.walletAddress,
      currentSlug: snapshot.currentSlug,
      previousSlug: snapshot.previousSlug,
      nextSlug: snapshot.nextSlug,
      markets: snapshot.markets.map((inventoryMarket) => ({
        slug: inventoryMarket.slug,
        relation: inventoryMarket.relation,
        knownBtc5m: inventoryMarket.knownBtc5m,
        resolved: inventoryMarket.resolved,
        redeemable: inventoryMarket.redeemable,
        upShares: inventoryMarket.upShares,
        downShares: inventoryMarket.downShares,
        mergeable: inventoryMarket.mergeable,
        residualUp: inventoryMarket.residualUp,
        residualDown: inventoryMarket.residualDown,
        imbalanceRatio: inventoryMarket.imbalanceRatio,
      })),
    });
  };

  await traceLogger.write("market_rollover", {
    status: "session_start",
    selection: selected.selection,
    startedAt,
  });
  stateStore.recordMarketRollover({
    status: "session_start",
    timestamp: startedAt,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    payload: {
      selection: selected.selection,
      initialDailyNegativeEdgeSpentUsdc,
    },
  });
  const persistedArbitrationCarry = stateStore.loadArbitrationCarrySnapshot(market.slug);
  const persistedFlowBudget = stateStore.loadFlowBudgetSnapshot(market.slug);
  state = stateStore.loadMarketState(state);
  if (persistedFlowBudget) {
    const snapshotAgeSec = Math.max(0, startedAt - persistedFlowBudget.updatedAt);
    const decay = Math.min(1, snapshotAgeSec / Math.max(30, config.partialPatientWindowSec));
    runtimeFlowBudgetLedgerLoad = Number(Math.max(0, persistedFlowBudget.load * (1 - decay)).toFixed(6));
    runtimeFlowBudgetLineageLoads = Object.fromEntries(
      Object.entries(persistedFlowBudget.lineageLoads ?? {})
        .map(([lineage, load]) => [lineage, Number(Math.max(0, load * (1 - decay)).toFixed(6))] as const)
        .filter(([, load]) => load > 1e-6),
    );
    runtimeFlowBudgetLastAction = persistedFlowBudget.lastAction as RuntimeFlowBudgetLedgerAction | undefined;
    runtimeFlowBudgetLastLineage = persistedFlowBudget.lastLineage;
  }
  runtimeProtectedResidualLock = refreshRuntimeProtectedResidualLock({
    lock: undefined,
    state,
    nowTs: startedAt,
    mode: state.lastExecutionMode,
  });
  arbitrationCarry = restorePersistedArbitrationCarry({
    snapshot: persistedArbitrationCarry,
    state,
    nowTs: startedAt,
    minResidualShares: Math.max(config.repairMinQty, config.completionMinQty),
  });
  persistMarketState();
  if (config.restartRestorePartialAsCompletionOnly) {
    const restoredPartialGroup = stateStore.loadLatestOpenPartialPairGroup(market.slug);
    const restoredGap = Math.abs(state.upShares - state.downShares);
    if (
      restoredPartialGroup &&
      restoredGap > Math.max(config.repairMinQty, config.completionMinQty)
    ) {
      partialOpenGroupLock = {
        groupId: restoredPartialGroup.groupId,
        status: restoredPartialGroup.status,
        openedAt: restoredPartialGroup.createdAt,
        protectedSide: restoredPartialGroup.status === "UP_ONLY" ? "UP" : "DOWN",
        protectedShares: normalizeShares(restoredGap),
      };
      runtimeProtectedResidualLock = undefined;
      arbitrationCarry = undefined;
      startupCompletionOnly = true;
      if (config.blockNewPairWhenRestoredPartialExists) {
        startupBlockNewEntries = true;
      }
      state = {
        ...state,
        reentryDisabled: true,
      };
      persistMarketState("restored_partial_group_open");
      await writeRiskEvent("restored_partial_group_open", {
        groupId: restoredPartialGroup.groupId,
        status: restoredPartialGroup.status,
        restoredGap,
      });
    }
  }

  if (startupInventorySnapshot) {
    await writeInventorySnapshotTrace("startup_before_manage", startupInventorySnapshot);
    const startupPlan = buildInventoryActionPlan(startupInventorySnapshot, config);
    startupBlockNewEntries = startupPlan.blockNewEntries;
    startupExternalReasons = [...startupPlan.blockReasons];

    if (startupPlan.redeem.length > 0 || startupPlan.merge.length > 0) {
      const startupActions = await executeInventoryActionPlan(env, startupPlan, config);
      for (const action of startupActions) {
        await traceLogger.write("merge_redeem", {
          action: action.type,
          slug: action.slug,
          relation: action.relation,
          amount: action.amount ?? null,
          reason: action.reason,
          txHash: action.result.txHash ?? null,
          simulated: action.result.simulated,
          skipped: action.result.skipped ?? false,
        });
      }
      startupInventorySnapshot = await fetchInventorySnapshot(env, config);
      await writeInventorySnapshotTrace("startup_after_manage", startupInventorySnapshot);
    }

    const startupGuardPlan = buildInventoryActionPlan(startupInventorySnapshot, config);
    startupBlockNewEntries = startupGuardPlan.blockNewEntries;
    startupExternalReasons = [...startupGuardPlan.blockReasons];
    const startupCurrentInventory =
      startupInventorySnapshot.markets.find(
        (inventoryMarket) => inventoryMarket.conditionId === market.conditionId || inventoryMarket.slug === market.slug,
      ) ?? startupInventorySnapshot.currentMarket;
    if (startupCurrentInventory && startupCurrentInventory.imbalanceRatio >= config.hardImbalanceRatio) {
      startupBlockNewEntries = true;
      startupCompletionOnly = true;
      startupExternalReasons.push("startup_current_inventory_hard_imbalance");
    }
    for (const reason of startupExternalReasons) {
      await writeRiskEvent(reason, {
        stage: "startup",
      });
    }
  }

  btcPriceFeed.connect();
  marketWs.connect([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);
  userWs.connect([market.conditionId]);

  marketWs.on("book", (book: OrderBook) => {
    marketEventSeq += 1;
    latestBookEventAtMs = Date.now();
    const outcome = outcomeForAssetId(market, book.assetId);
    if (outcome) {
      lastBookEventAtMs[outcome] = latestBookEventAtMs;
    }
    signalDecisionPulse();
  });
  btcPriceFeed.on("price", () => {
    signalDecisionPulse();
  });
  btcPriceFeed.on("warn", (error: Error) => {
    logger.warn({ error }, "BTC price feed warning.");
    pushEvent(events, { timestamp: clock.now(), type: "btc_price_warn", message: error.message });
    void traceLogger.write("errors", {
      channel: "btc_price_feed",
      severity: "warn",
      message: error.message,
    });
  });

  userWs.on("warn", (error: Error) => {
    logger.warn({ error }, "User websocket warning.");
    pushEvent(events, { timestamp: clock.now(), type: "user_ws_warn", message: error.message });
    void traceLogger.write("errors", {
      channel: "user_ws",
      severity: "warn",
      message: error.message,
    });
  });
  userWs.on("error", (error: Error) => {
    logger.error({ error }, "User websocket error.");
    pushEvent(events, { timestamp: clock.now(), type: "user_ws_error", message: error.message });
    void traceLogger.write("errors", {
      channel: "user_ws",
      severity: "error",
      message: error.message,
    });
  });
  userWs.on("order", (event: UserOrderEvent) => {
    pushEvent(events, {
      timestamp: clock.now(),
      type: "user_order",
      eventType: event.type,
      orderId: event.id,
      assetId: event.asset_id,
      price: event.price,
      matchedSize: event.size_matched,
    });
    void traceLogger.write("orders", {
      eventType: "user_order",
      orderId: event.id,
      assetId: event.asset_id,
      price: event.price,
      matchedSize: event.size_matched,
    });
  });
  userWs.on("trade", (event: UserTradeEvent) => {
    if (seenTradeIds.has(event.id)) {
      return;
    }
    seenTradeIds.add(event.id);
    const fill = inferUserTradeFill({
      event,
      market,
      nowTs: clock.now(),
      submittedPrices,
    });
    if (!fill) {
      pushEvent(events, {
        timestamp: clock.now(),
        type: "user_trade_unparsed",
        eventId: event.id,
        assetId: event.asset_id,
      });
      void traceLogger.write("errors", {
        channel: "user_trade",
        severity: "warn",
        message: "user_trade_unparsed",
        eventId: event.id,
        assetId: event.asset_id,
      });
      return;
    }

    const pendingFillSnapshot = pendingPairExecution
      ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
      : undefined;
    const submittedIntent =
      resolveFillIntent(
        submittedPrices,
        fill.outcome,
        fill.size,
        fill.timestamp,
        submittedIntentMaxAgeSec,
      ) ??
      inferPendingPairExecutionIntent({
        pending: pendingPairExecution,
        outcome: fill.outcome,
        filledShares: fill.size,
        fillSnapshot: pendingFillSnapshot,
      });
    const normalizedFill: FillRecord = {
      ...fill,
      executionMode: fill.executionMode ?? submittedIntent?.mode,
      flowLineage:
        fill.flowLineage ??
        deriveCarryFlowLineageKey({
          recommendation: arbitrationCarry?.recommendation,
          preferredSeedSide: arbitrationCarry?.preferredSeedSide,
          protectedResidualSide: arbitrationCarry?.protectedResidualSide ?? (partialOpenGroupLock ?? runtimeProtectedResidualLock)?.protectedSide,
        }),
    };
    const activePairMatch = !submittedIntent?.groupId ? matchActivePairSubmission(normalizedFill) : undefined;
    if (activePairMatch) {
      pushEvent(events, {
        timestamp: normalizedFill.timestamp,
        type: "user_fill_suppressed_pair_submit_window",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        side: normalizedFill.side,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: activePairSubmission?.groupId ?? null,
      });
      void traceLogger.write("user_fills", {
        eventType: "user_fill_suppressed_pair_submit_window",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        side: normalizedFill.side,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: activePairSubmission?.groupId ?? null,
        source: "PAIR_SUBMIT_WINDOW",
      });
      return;
    }
    if (normalizedFill.side === "BUY" && consumeOrderResultFillSuppression(normalizedFill)) {
      pushEvent(events, {
        timestamp: normalizedFill.timestamp,
        type: "user_fill_suppressed_order_result_duplicate",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
      });
      void traceLogger.write("user_fills", {
        eventType: "user_fill_suppressed_order_result_duplicate",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
        source: "ORDER_RESULT",
      });
      return;
    }
    if (pendingPairExecution && !submittedIntent?.groupId) {
      void markPairgroupRepairRequired("pairgroup_repair_required", {
        source: "user_ws",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        pendingPairGroupId: pendingPairExecution.group.groupId,
      });
    }
    const fillOldGap = Math.abs(state.upShares - state.downShares);
    state = applyFill(state, normalizedFill);
    const fillNewGap = Math.abs(state.upShares - state.downShares);
    const fillReleaseAction = runtimeFlowBudgetReleaseActionForFillMode(normalizedFill.executionMode);
    if (fillReleaseAction) {
      applyRuntimeFlowBudgetAction(fillReleaseAction, {
        quantityShares: runtimeFlowBudgetReleaseQuantityForResidualChange({
          requestedShares: normalizedFill.size,
          oldGap: fillOldGap,
          newGap: fillNewGap,
        }),
        lineage: normalizedFill.flowLineage ?? currentRuntimeFlowLineage(normalizedFill.outcome),
      });
    }
    stateStore.recordFill(state, normalizedFill, {
      orderId: submittedIntent?.orderId,
      groupId: submittedIntent?.groupId,
      executionMode: submittedIntent?.mode,
      source: "USER_WS",
    });
    if (submittedIntent?.groupId || submittedIntent?.orderId) {
      rememberBotOwnedBuyFill(normalizedFill, {
        groupId: submittedIntent.groupId,
        orderId: submittedIntent.orderId,
      });
    }
    runtimeProtectedResidualLock =
      partialOpenGroupLock !== undefined
        ? undefined
        : refreshRuntimeProtectedResidualLock({
            lock: runtimeProtectedResidualLock,
            state,
            nowTs: normalizedFill.timestamp,
            mode: submittedIntent?.mode ?? normalizedFill.executionMode,
          });
    persistMarketState();
    userTradeCount += 1;
    pushEvent(events, {
      timestamp: normalizedFill.timestamp,
      type: "user_fill",
      eventId: event.id,
      outcome: normalizedFill.outcome,
      side: normalizedFill.side,
      size: normalizedFill.size,
      price: normalizedFill.price,
      groupId: submittedIntent?.groupId ?? null,
      orderId: submittedIntent?.orderId ?? null,
    });
    void traceLogger.write("user_fills", {
      eventId: event.id,
      outcome: normalizedFill.outcome,
      side: normalizedFill.side,
      size: normalizedFill.size,
      price: normalizedFill.price,
      groupId: submittedIntent?.groupId ?? null,
      orderId: submittedIntent?.orderId ?? null,
      correlationId: submittedIntent?.groupId ?? event.id,
    });
    emitLiveMirror("user_fill", {
      marketSlug: market.slug,
      eventId: event.id,
      outcome: normalizedFill.outcome,
      side: normalizedFill.side,
      size: normalizedFill.size,
      price: normalizedFill.price,
      executionMode: normalizedFill.executionMode ?? null,
      groupId: submittedIntent?.groupId ?? null,
      orderId: submittedIntent?.orderId ?? null,
      upShares: state.upShares,
      downShares: state.downShares,
      upAverage: averageCost(state, "UP"),
      downAverage: averageCost(state, "DOWN"),
    });
  });

  const performBalanceSync = async (args: {
    nowTs: number;
    books: OrderBookState;
    scope: string;
    traceLabel: string;
  }): Promise<void> => {
    lastBalanceSyncAt = args.nowTs;
    balanceSyncCount += 1;
    cachedUsdcBalance = (await readCollateralBalanceUsdc(env)) ?? cachedUsdcBalance;

    const observedBalances = await readObservedBalances(balanceReader, market, balanceOwnerAddress);
    const balanceSyncOldGap = Math.abs(state.upShares - state.downShares);
    const reconciled = reconcileStateWithBalances({
      state,
      observed: observedBalances,
      nowTs: args.nowTs,
      fallbackPrices: buildFallbackPrices(args.books, submittedPrices),
      shouldIgnoreShortfall: shouldIgnoreTransientBotOwnedShortfall,
    });
    state = reconciled.state;
    const balanceSyncNewGap = Math.abs(state.upShares - state.downShares);
    balanceCorrectionCount += reconciled.corrections.length;

    for (const fill of reconciled.inferredFills) {
      const pendingFillSnapshot = pendingPairExecution
        ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
        : undefined;
      const submittedIntent =
        resolveFillIntent(
          submittedPrices,
          fill.outcome,
          fill.size,
          fill.timestamp,
          submittedIntentMaxAgeSec,
        ) ??
        inferPendingPairExecutionIntent({
          pending: pendingPairExecution,
          outcome: fill.outcome,
          filledShares: fill.size,
          fillSnapshot: pendingFillSnapshot,
        });
      const normalizedFill: FillRecord = {
        ...fill,
        executionMode: fill.executionMode ?? submittedIntent?.mode,
        flowLineage:
          fill.flowLineage ??
          deriveCarryFlowLineageKey({
            recommendation: arbitrationCarry?.recommendation,
            preferredSeedSide: arbitrationCarry?.preferredSeedSide,
            protectedResidualSide: arbitrationCarry?.protectedResidualSide ?? (partialOpenGroupLock ?? runtimeProtectedResidualLock)?.protectedSide,
          }),
      };
      if (pendingPairExecution && !submittedIntent?.groupId) {
        await markPairgroupRepairRequired("pairgroup_repair_required", {
          source: args.scope,
          outcome: normalizedFill.outcome,
          size: normalizedFill.size,
          pendingPairGroupId: pendingPairExecution.group.groupId,
        });
      }
      const fillReleaseAction = runtimeFlowBudgetReleaseActionForFillMode(normalizedFill.executionMode);
      if (fillReleaseAction) {
        applyRuntimeFlowBudgetAction(fillReleaseAction, {
          quantityShares: runtimeFlowBudgetReleaseQuantityForResidualChange({
            requestedShares: normalizedFill.size,
            oldGap: balanceSyncOldGap,
            newGap: balanceSyncNewGap,
          }),
          lineage: normalizedFill.flowLineage ?? currentRuntimeFlowLineage(normalizedFill.outcome),
        });
      }
      stateStore.recordFill(state, normalizedFill, {
        orderId: submittedIntent?.orderId,
        groupId: submittedIntent?.groupId,
        executionMode: submittedIntent?.mode,
        source: "BALANCE_RECONCILE",
      });
      if (submittedIntent?.groupId || submittedIntent?.orderId) {
        rememberBotOwnedBuyFill(normalizedFill, {
          groupId: submittedIntent.groupId,
          orderId: submittedIntent.orderId,
        });
      }
      pushEvent(events, {
        timestamp: args.nowTs,
        type: "balance_sync_fill",
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: submittedIntent?.groupId ?? null,
        orderId: submittedIntent?.orderId ?? null,
      });
      await traceLogger.write("balance_sync", {
        balanceEvent: "fill",
        scope: args.scope,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: submittedIntent?.groupId ?? null,
        orderId: submittedIntent?.orderId ?? null,
      });
    }
    for (const correction of reconciled.corrections) {
      const botOwnedCorrection = Boolean(
        findBotOwnedFillForShortfall({
          ...correction,
          nowTs: args.nowTs,
        }),
      );
      const persistedShrink = botOwnedCorrection
        ? stateStore.shrinkOpenLotsToObservedShares(
            market.slug,
            correction.outcome,
            correction.toShares,
            args.nowTs,
          )
        : undefined;
      pushEvent(events, {
        timestamp: args.nowTs,
        type: "balance_sync_correction",
        outcome: correction.outcome,
        fromShares: correction.fromShares,
        toShares: correction.toShares,
        botOwned: botOwnedCorrection,
      });
      await traceLogger.write("balance_sync", {
        balanceEvent: "correction",
        scope: args.scope,
        outcome: correction.outcome,
        fromShares: correction.fromShares,
        toShares: correction.toShares,
        botOwned: botOwnedCorrection,
        persistedFromShares: persistedShrink?.fromShares ?? null,
        persistedToShares: persistedShrink?.toShares ?? null,
        persistedConsumedQty: persistedShrink?.consumedQty ?? null,
      });
      if (
        !botOwnedCorrection &&
        config.blockNewEntryOnExternalActivity &&
        correction.toShares + 1e-6 < correction.fromShares
      ) {
        await markExternalActivity("external_inventory_delta", {
          outcome: correction.outcome,
          fromShares: correction.fromShares,
          toShares: correction.toShares,
        });
      }
    }
    runtimeProtectedResidualLock =
      partialOpenGroupLock !== undefined
        ? undefined
        : refreshRuntimeProtectedResidualLock({
            lock: runtimeProtectedResidualLock,
            state,
            nowTs: args.nowTs,
          });
    persistMarketState();
    stateStore.recordReconcileRun({
      scope: args.scope,
      marketSlug: market.slug,
      conditionId: market.conditionId,
      timestamp: args.nowTs,
      status: reconciled.corrections.length > 0 ? "corrected" : "ok",
      requiresManualResume: externalActivityDetected,
      mismatchShares: reconciled.corrections.reduce(
        (sum, correction) => sum + Math.abs(correction.fromShares - correction.toShares),
        0,
      ),
      payload: {
        inferredFills: reconciled.inferredFills.length,
        corrections: reconciled.corrections.length,
      },
    });

    if (config.mergeOnEachReconcile) {
      await traceLogger.write("inventory_snapshots", {
        label: args.traceLabel,
        upShares: state.upShares,
        downShares: state.downShares,
        mergeable: Math.min(state.upShares, state.downShares),
        negativeEdgeConsumedUsdc: state.negativeEdgeConsumedUsdc,
      });
    }

    if (pendingPairExecution && args.nowTs >= pendingPairExecution.submittedAt) {
      pendingPairExecution = {
        ...pendingPairExecution,
        reconciledAfterSubmit: true,
      };
    }
  };

  const finalizePendingPairExecutionIfReady = async (
    nowTs: number,
    options: { forceDeadline?: boolean } = {},
  ): Promise<void> => {
    const pendingFillSnapshot = pendingPairExecution
      ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
      : undefined;
    pendingPairExecution = resolveActivePairExecution(pendingPairExecution, state, pendingFillSnapshot);
    if (!pendingPairExecution) {
      return;
    }

    const deadlinePassed = options.forceDeadline || Date.now() >= pendingPairExecution.deadlineAt;
    const finalized =
      pendingPairExecution.status !== "PENDING" ||
      (deadlinePassed &&
        (!config.pairgroupFinalizeAfterBalanceSync || pendingPairExecution.reconciledAfterSubmit))
        ? finalizePairExecutionResult({
            group: pendingPairExecution.group,
            upResult: pendingPairExecution.upResult,
            downResult: pendingPairExecution.downResult,
            state,
            fillSnapshot: stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId),
            reconcileObservedAfterSubmit: pendingPairExecution.reconciledAfterSubmit,
            requireReconcileBeforeNoneFilled: config.pairgroupRequireReconcileBeforeNoneFilled,
          })
        : undefined;

    if (finalized) {
      await persistFinalizedPairGroup(finalized, pendingPairExecution, nowTs);
      pendingPairExecution = undefined;
    }
  };

  try {
    const initial = await waitForInitialBooks(marketWs, market, resolvedOptions.initialBookWaitMs);
    const initialBooks = new OrderBookState(initial.upBook, initial.downBook);
    const initialBalances = await readObservedBalances(balanceReader, market, balanceOwnerAddress);
    latestFairValueSnapshot = fairValueRuntime.evaluate(startedAt);
    if (initialBalances.up > 0 || initialBalances.down > 0) {
      const adopted = reconcileStateWithBalances({
        state,
        observed: initialBalances,
        nowTs: startedAt,
        fallbackPrices: {
          UP: initialBooks.bestAsk("UP"),
          DOWN: initialBooks.bestAsk("DOWN"),
        },
      });
      state = adopted.state;
      for (const fill of adopted.inferredFills) {
        stateStore.recordFill(state, fill, {
          source: "BALANCE_RECONCILE",
        });
      }
      persistMarketState();
      adoptedInventory = adopted.inferredFills.length > 0 || adopted.corrections.length > 0;
      if (adoptedInventory) {
        applyRuntimeFlowBudgetAction("balance_adopted", {
          quantityShares:
            adopted.inferredFills.reduce((sum, fill) => sum + fill.size, 0) +
            adopted.corrections.reduce((sum, correction) => sum + Math.abs(correction.fromShares - correction.toShares), 0),
          lineage: currentRuntimeFlowLineage(),
        });
        persistMarketState("startup_inventory_adopted");
        pushEvent(events, {
          timestamp: startedAt,
          type: "startup_inventory_adopted",
          upShares: state.upShares,
          downShares: state.downShares,
        });
        await traceLogger.write("inventory_snapshots", {
          label: "startup_adopted_market_state",
          upShares: state.upShares,
          downShares: state.downShares,
          fillCount: state.fillHistory.length,
          startupBlockNewEntries,
          startupCompletionOnly,
        });
      }
      const startupCorrectionMagnitude = adopted.corrections.reduce(
        (acc, correction) => acc + Math.abs(correction.fromShares - correction.toShares),
        0,
      );
      if (startupCorrectionMagnitude > config.stateReconcileToleranceShares) {
        startupSafeHalt = true;
        startupBlockNewEntries = true;
        startupCompletionOnly = false;
        startupExternalReasons.push("startup_reconcile_mismatch");
      }
    }

    const sessionDeadline = Math.min(startedAt + resolvedOptions.durationSec, market.endTs);
    while (clock.now() < sessionDeadline && clock.now() < market.endTs) {
      const nowTs = clock.now();
      ticks += 1;
      const books = buildBooks(marketWs, market);
      const upBook = marketWs.getBook(market.tokens.UP.tokenId);
      const downBook = marketWs.getBook(market.tokens.DOWN.tokenId);

      if (!upBook || !downBook) {
        await waitForDecisionPulse();
        continue;
      }

      latestFairValueSnapshot = fairValueRuntime.evaluate(nowTs);

      if (nowTs - lastBalanceSyncAt >= Math.floor(resolvedOptions.balanceSyncMs / 1000)) {
        await performBalanceSync({
          nowTs,
          books,
          scope: "session_balance_sync",
          traceLabel: "reconcile_state",
        });
      }

      await finalizePendingPairExecutionIfReady(nowTs);

      if (Date.now() >= actionCooldownUntil) {
        const mergePlan = planMerge(config, state);
        const pendingMergeFillSnapshot = pendingPairExecution
          ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
          : undefined;
        const lockedPendingShares = computePendingLockedShares(
          pendingPairExecution,
          pendingMergeFillSnapshot,
          config,
        );
        const mergeResidualLock = partialOpenGroupLock ?? runtimeProtectedResidualLock;
        const mergeProtectedResidualShares = mergeResidualLock
          ? Math.min(mergeResidualLock.protectedShares, Math.abs(state.upShares - state.downShares))
          : 0;
        const mergeRecentSeedFlowCount = computeRecentSeedFlowCount(state, nowTs);
        const mergeActiveIndependentFlowCount = computeActiveIndependentFlowCount(state, nowTs);
        const calibratedMergeRecentSeedFlowCount =
          mergeRecentSeedFlowCount +
          runtimeFlowCalibrationBias.lineageFlowCountBonus +
          runtimeFlowCalibrationBias.semanticRoleFlowCountBonus +
          runtimeFlowCalibrationBias.completionPatienceFlowCountBonus +
          runtimeFlowCalibrationBias.overlapCadenceCompressionBonus;
        const calibratedMergeActiveIndependentFlowCount =
          mergeActiveIndependentFlowCount + runtimeFlowCalibrationBias.activeFlowCountBonus;
        const mergeResidualBehaviorState = resolveResidualBehaviorState({
          config,
          residualShares: mergeProtectedResidualShares,
          shareGap: mergeProtectedResidualShares,
          recentSeedFlowCount: calibratedMergeRecentSeedFlowCount,
          activeIndependentFlowCount: calibratedMergeActiveIndependentFlowCount,
        });
        const mergeOverlapBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
        const mergeMatchedInventoryQuality = Number(
          Math.min(
            1.25,
            Math.min(state.upShares, state.downShares) / Math.max(mergeOverlapBaseLot, 1e-6),
          ).toFixed(6),
        );
        const mergeCarryFlowConfidence = arbitrationCarry
          ? deriveCarryFlowConfidence({
              carry: arbitrationCarry,
              state,
              nowTs,
              matchedInventoryQuality: mergeMatchedInventoryQuality,
              recentSeedFlowCount: calibratedMergeRecentSeedFlowCount,
              activeIndependentFlowCount: calibratedMergeActiveIndependentFlowCount,
            })
          : 0;
        const mergeRuntimeFlowBudgetState = applyRuntimeFlowBudgetConsumption(
          deriveRuntimeFlowBudgetState({
            matchedInventoryQuality: mergeMatchedInventoryQuality,
            carryFlowConfidence: mergeCarryFlowConfidence,
            recentSeedFlowCount: calibratedMergeRecentSeedFlowCount,
            activeIndependentFlowCount: calibratedMergeActiveIndependentFlowCount,
            residualSeverityPressure: mergeResidualBehaviorState.severityPressure,
          }),
          {
            activeIndependentFlowCount: calibratedMergeActiveIndependentFlowCount,
            pendingMergeWindowCount: mergeBatchTracker.windows.length,
            protectedResidualShares: mergeProtectedResidualShares,
            residualSeverityPressure: mergeResidualBehaviorState.severityPressure,
            pendingPairExecutionActive: pendingPairExecution !== undefined,
            realizedActionBudgetLoad: runtimeFlowBudgetLedgerLoad,
            lineageActionBudgetLoad: dominantRuntimeFlowBudgetLineageLoad(runtimeFlowBudgetLineageLoads),
          },
        );
        const mergeableUnlocked = config.mergeOnlyConfirmedMatchedUnlockedLots
          ? unlockedMergeableShares(state, lockedPendingShares)
          : mergePlan.mergeable;
        mergeBatchTracker = syncMergeBatchTracker(mergeBatchTracker, mergeableUnlocked, nowTs, {
          flowPressureBudget: mergeRuntimeFlowBudgetState.budget,
          activeIndependentFlowCount: calibratedMergeActiveIndependentFlowCount,
          flowPressureState: mergeRuntimeFlowBudgetState,
        });
        const mergeGate = evaluateDelayedMergeGate(config, state, {
          nowTs,
          secsFromOpen: nowTs - market.startTs,
          secsToClose: market.endTs - nowTs,
          usdcBalance: cachedUsdcBalance,
          tracker: mergeBatchTracker,
          flowPressureBudget: mergeRuntimeFlowBudgetState.budget,
          activeIndependentFlowCount: calibratedMergeActiveIndependentFlowCount,
          flowPressureState: mergeRuntimeFlowBudgetState,
        });
        const mergeClusterPrior =
          config.xuanCloneMode === "PUBLIC_FOOTPRINT"
            ? resolveBundledMergeClusterPrior(market.slug, nowTs - market.startTs)
            : undefined;
        const mergeTargetQty = mergeClusterPrior ? Math.min(mergeableUnlocked, mergeClusterPrior.totalQty) : mergeableUnlocked;
        const mergeAmount = normalizeMergeAmount(mergeTargetQty, config.mergeDustLeaveShares);
        const mergeAllowed =
          mergePlan.shouldMerge &&
          mergeGate.allow &&
          mergeAmount >= config.mergeMinShares &&
          Date.now() - lastMergeAtMs >= config.mergeDebounceMs &&
          (!pendingPairExecution || config.allowMergeWithPendingGroups) &&
          mergeTxCount < config.mergeMaxTxPerMarket;
        if (mergeAllowed) {
          const mergeResult = env.CTF_MERGE_ENABLED
            ? await ctf.mergePositions(market.conditionId, mergeAmount)
            : {
                simulated: true,
                skipped: true,
                action: "merge" as const,
                amount: mergeAmount,
                conditionId: market.conditionId,
                reason: "CTF_MERGE_ENABLED=false",
              };
          if (mergeResult.simulated || !mergeResult.skipped) {
            const preMergeState = state;
            state = applyMerge(state, {
              amount: mergeAmount,
              timestamp: nowTs,
              simulated: mergeResult.simulated,
              flowLineage: deriveCarryFlowLineageKey({
                recommendation: arbitrationCarry?.recommendation,
                preferredSeedSide: arbitrationCarry?.preferredSeedSide,
                protectedResidualSide:
                  arbitrationCarry?.protectedResidualSide ?? mergeResidualLock?.protectedSide,
              }),
            });
            stateStore.recordMerge(preMergeState, state.mergeHistory.at(-1) ?? {
              amount: mergeAmount,
              timestamp: nowTs,
              simulated: mergeResult.simulated,
            });
            const residualAfterMerge = Math.abs(state.upShares - state.downShares);
            if (config.postMergeOnlyCompletion) {
              if (config.postMergeOnlyCompletionWhileResidual && residualAfterMerge > config.postMergeFlatDustShares) {
                state = {
                  ...state,
                  reentryDisabled: true,
                  postMergeCompletionOnlyUntil: undefined,
                };
              } else if (config.postMergeAllowNewPairIfFlat) {
                state = {
                  ...state,
                  reentryDisabled: false,
                  postMergeCompletionOnlyUntil:
                    nowTs + Math.ceil(config.postMergePairReopenCooldownMs / 1000),
                };
              } else {
                state = {
                  ...state,
                  reentryDisabled: true,
                  postMergeCompletionOnlyUntil:
                    nowTs + Math.ceil(config.postMergeNewSeedCooldownMs / 1000),
                };
              }
            }
            mergeCount += 1;
            mergeTxCount += 1;
            lastMergeAtMs = Date.now();
            applyRuntimeFlowBudgetAction("merge", {
              quantityShares: mergeAmount,
              lineage: currentRuntimeFlowLineage(),
            });
            const pendingPostMergeFillSnapshot = pendingPairExecution
              ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
              : undefined;
            const postMergeLockedPendingShares = computePendingLockedShares(
              pendingPairExecution,
              pendingPostMergeFillSnapshot,
              config,
            );
            const postMergeObserved = config.mergeOnlyConfirmedMatchedUnlockedLots
              ? unlockedMergeableShares(state, postMergeLockedPendingShares)
              : Math.min(state.upShares, state.downShares);
            mergeBatchTracker = syncMergeBatchTracker(mergeBatchTracker, postMergeObserved, nowTs);
            persistMarketState(state.reentryDisabled ? "post_merge_completion_only" : undefined);
          }
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          pushEvent(events, {
            timestamp: nowTs,
            type: "merge",
            amount: mergeAmount,
            mergeGateReason: mergeGate.reason,
            mergeGateForced: mergeGate.forced,
            result: mergeResult,
          });
          await traceLogger.write("merge_redeem", {
            action: "merge",
            amount: mergeAmount,
            mergeGateReason: mergeGate.reason,
            mergeGateForced: mergeGate.forced,
            mergePendingMatchedQty: mergeGate.pendingMatchedQty,
            mergeCompletedCycles: mergeGate.completedCycles,
            mergeOldestMatchedAgeSec: mergeGate.oldestMatchedAgeSec ?? null,
            txHash: mergeResult.txHash ?? null,
            simulated: mergeResult.simulated,
            skipped: mergeResult.skipped ?? false,
            lockedPendingUpShares: lockedPendingShares.up,
            lockedPendingDownShares: lockedPendingShares.down,
            matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
            matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
            mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
            realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
            remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
            remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
            postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
          });
          emitLiveMirror("merge_submit", {
            marketSlug: market.slug,
            trigger: "runtime",
            amount: mergeAmount,
            mergeGateReason: mergeGate.reason,
            mergeGateForced: mergeGate.forced,
            mergePendingMatchedQty: mergeGate.pendingMatchedQty,
            mergeCompletedCycles: mergeGate.completedCycles,
            txHash: mergeResult.txHash ?? null,
            simulated: mergeResult.simulated,
            skipped: mergeResult.skipped ?? false,
            matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
            matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
            mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
            realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
            remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
            remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
            postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
          });
          await waitForDecisionPulse();
          continue;
        }
      }

      const decisionEvalStartedAtMs = Date.now();
      if (
        partialOpenGroupLock &&
        Math.abs(state.upShares - state.downShares) <= Math.max(config.repairMinQty, config.completionMinQty)
      ) {
        partialOpenGroupLock = undefined;
        if (arbitrationCarry) {
          arbitrationCarryExpiredCount += 1;
        }
        arbitrationCarry = undefined;
        applyRuntimeFlowBudgetAction("residual_flat", {
          quantityShares: Math.abs(state.upShares - state.downShares),
          lineage: currentRuntimeFlowLineage(),
        });
        persistMarketState();
      }
      if (
        runtimeProtectedResidualLock &&
        Math.abs(state.upShares - state.downShares) <= Math.max(config.repairMinQty, config.completionMinQty)
      ) {
        runtimeProtectedResidualLock = undefined;
        if (arbitrationCarry) {
          arbitrationCarryExpiredCount += 1;
        }
        arbitrationCarry = undefined;
        applyRuntimeFlowBudgetAction("residual_flat", {
          quantityShares: Math.abs(state.upShares - state.downShares),
          lineage: currentRuntimeFlowLineage(),
        });
        persistMarketState();
      }
      if (
        state.reentryDisabled &&
        Math.abs(state.upShares - state.downShares) <= config.postMergeFlatDustShares &&
        config.postMergeAllowNewPairIfFlat
      ) {
        state = {
          ...state,
          reentryDisabled: false,
          postMergeCompletionOnlyUntil:
            nowTs + Math.ceil(config.postMergePairReopenCooldownMs / 1000),
        };
        persistMarketState();
      }
      const activeProtectedResidualLock = partialOpenGroupLock ?? runtimeProtectedResidualLock;
      const overlapCompletionProbe =
        activeProtectedResidualLock !== undefined
          ? chooseInventoryAdjustment(config, state, books, {
              secsToClose: market.endTs - nowTs,
              usdcBalance: cachedUsdcBalance,
              nowTs,
              fairValueSnapshot: latestFairValueSnapshot,
              completionPatienceMultiplier: runtimeFlowCalibrationBias.completionPatienceMultiplier,
            })
          : undefined;
      const overlapCompletionActive = Boolean(overlapCompletionProbe?.completion);
      const partialAgeSec =
        activeProtectedResidualLock !== undefined ? Math.max(0, nowTs - activeProtectedResidualLock.openedAt) : undefined;
      const protectedResidualShares = activeProtectedResidualLock
        ? Math.min(activeProtectedResidualLock.protectedShares, Math.abs(state.upShares - state.downShares))
        : 0;
      const residualSeverity = classifyResidualSeverity(config, protectedResidualShares);
      const recentSeedFlowCount = computeRecentSeedFlowCount(state, nowTs);
      const activeIndependentFlowCount = computeActiveIndependentFlowCount(state, nowTs);
      const calibratedRecentSeedFlowCount =
        recentSeedFlowCount +
        runtimeFlowCalibrationBias.lineageFlowCountBonus +
        runtimeFlowCalibrationBias.semanticRoleFlowCountBonus +
        runtimeFlowCalibrationBias.completionPatienceFlowCountBonus +
        runtimeFlowCalibrationBias.overlapCadenceCompressionBonus;
      const calibratedActiveIndependentFlowCount =
        activeIndependentFlowCount + runtimeFlowCalibrationBias.activeFlowCountBonus;
      const carryPersistenceKeyBeforeTick = arbitrationCarryPersistenceKey(arbitrationCarry);
      const overlapBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
      const pendingDecisionFillSnapshot = pendingPairExecution
        ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
        : undefined;
      const decisionLockedPendingShares = computePendingLockedShares(
        pendingPairExecution,
        pendingDecisionFillSnapshot,
        config,
      );
      const openMatchedQty = Number(Math.min(state.upShares, state.downShares).toFixed(6));
      const unlockedMatchedQty = unlockedMergeableShares(state, decisionLockedPendingShares);
      const matchedInventoryTargetMet =
        mergeBatchTracker.windows.length >= 1 || openMatchedQty + 1e-6 >= overlapBaseLot;
      const matchedInventoryQuality = Number(
        Math.min(
          1.25,
          Math.max(
            mergeBatchTracker.windows.length >= 1 ? 1 : 0,
            openMatchedQty / Math.max(overlapBaseLot, 1e-6),
          ),
        ).toFixed(6),
      );
      const unlockedMatchedInventoryQuality = Number(
        Math.min(
          1.25,
          Math.max(
            mergeBatchTracker.windows.length >= 1 ? 1 : 0,
            unlockedMatchedQty / Math.max(overlapBaseLot, 1e-6),
          ),
        ).toFixed(6),
      );
      const carryFlowConfidence = arbitrationCarry
        ? deriveCarryFlowConfidence({
            carry: arbitrationCarry,
            state,
            nowTs,
            matchedInventoryQuality,
            unlockedMatchedInventoryQuality,
            recentSeedFlowCount: calibratedRecentSeedFlowCount,
            activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
          })
        : 0;
      const residualBehaviorState = resolveResidualBehaviorState({
        config,
        residualShares: protectedResidualShares,
        shareGap: protectedResidualShares,
        recentSeedFlowCount: calibratedRecentSeedFlowCount,
        activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
      });
      const baseRuntimeFlowBudgetState = deriveRuntimeFlowBudgetState({
        matchedInventoryQuality,
        unlockedMatchedInventoryQuality,
        carryFlowConfidence,
        recentSeedFlowCount: calibratedRecentSeedFlowCount,
        activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
        residualSeverityPressure: residualBehaviorState.severityPressure,
      });
      const runtimeFlowBudgetState = applyRuntimeFlowBudgetConsumption(baseRuntimeFlowBudgetState, {
        activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
        pendingMergeWindowCount: mergeBatchTracker.windows.length,
        protectedResidualShares,
        residualSeverityPressure: residualBehaviorState.severityPressure,
        pendingPairExecutionActive: pendingPairExecution !== undefined,
        realizedActionBudgetLoad: runtimeFlowBudgetLedgerLoad,
        lineageActionBudgetLoad: dominantRuntimeFlowBudgetLineageLoad(runtimeFlowBudgetLineageLoads),
      });
      if (arbitrationCarry) {
        arbitrationCarry = {
          ...arbitrationCarry,
          alignmentStreak: deriveConfirmedCarryAlignmentStreak({
            carry: arbitrationCarry,
            state,
            nowTs,
            matchedInventoryQuality,
            unlockedMatchedInventoryQuality,
            recentSeedFlowCount: calibratedRecentSeedFlowCount,
            flowConfidence: carryFlowConfidence,
          }),
        };
      }
      if (
        arbitrationCarry &&
        activeProtectedResidualLock &&
        activeProtectedResidualLock.protectedSide === arbitrationCarry.protectedResidualSide &&
        protectedResidualShares > Math.max(config.repairMinQty, config.completionMinQty)
      ) {
        const currentCarry: ArbitrationCarry = arbitrationCarry;
        const nextExpiry = deriveArbitrationCarryExpiry({
          config,
          carry: currentCarry,
          protectedResidualShares,
          nowTs,
          recentSeedFlowCount: calibratedRecentSeedFlowCount,
          residualBehaviorState: resolveResidualBehaviorState({
            config,
            residualShares: protectedResidualShares,
            shareGap: protectedResidualShares,
            recentSeedFlowCount: calibratedRecentSeedFlowCount,
            activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
          }),
        });
        if (nextExpiry > currentCarry.expiresAt + 1e-6) {
          arbitrationCarryExtendedCount += 1;
        }
        arbitrationCarry = {
          ...currentCarry,
          expiresAt: nextExpiry,
          lastObservedAt: nowTs,
          lastProtectedShares: protectedResidualShares,
          residualSeverityLevel: residualBehaviorState.severity.level,
        };
      }
      if (
        arbitrationCarry &&
        (
          nowTs >= arbitrationCarry.expiresAt ||
          !activeProtectedResidualLock ||
          activeProtectedResidualLock.protectedSide !== arbitrationCarry.protectedResidualSide ||
          protectedResidualShares <=
            Math.max(
              Math.max(config.repairMinQty, config.completionMinQty),
              arbitrationCarry.referenceShareGap *
                (resolveResidualBehaviorState({
                  config,
                  residualShares: protectedResidualShares,
                  shareGap: protectedResidualShares,
                  recentSeedFlowCount: calibratedRecentSeedFlowCount,
                  activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
                }).riskToleranceBias >= 0.55
                  ? arbitrationCarry.recommendation === "favor_independent_overlap"
                    ? 0.18
                    : 0.3
                  : arbitrationCarry.recommendation === "favor_independent_overlap"
                    ? 0.25
                    : 0.4),
            )
        )
      ) {
        arbitrationCarryExpiredCount += 1;
        arbitrationCarry = undefined;
      }
      const riskToleranceBias = residualBehaviorState.riskToleranceBias;
      const overlapAgeEligible =
        partialAgeSec !== undefined &&
        partialAgeSec <
          config.partialPatientWindowSec +
            config.partialSoftWindowSec *
              Math.max(0, residualBehaviorState.carryPersistenceBias - 1) *
              0.7 &&
        (residualSeverity.level === "micro" && protectedResidualShares > 0
          ? true
          : partialAgeSec >= config.partialFastWindowSec * Math.max(0.2, 1 - riskToleranceBias * 0.75));
      const relaxedMatchedInventoryRequirement =
        riskToleranceBias >= 0.55 &&
        (residualSeverity.level === "micro" || residualSeverity.level === "small" || residualSeverity.level === "medium");
      const carryPreservedOverlapAllowed =
        activeProtectedResidualLock !== undefined &&
        shouldPreserveCarryDrivenOverlap({
          config,
          carry: arbitrationCarry,
          nowTs,
          secsToClose: market.endTs - nowTs,
          protectedResidualShares,
          completionActive: overlapCompletionActive,
          linkageHealthy: pairgroupLinkageHealthy,
          matchedInventoryTargetMet,
          matchedInventoryQuality,
          unlockedMatchedInventoryQuality,
          carryFlowConfidence,
          recentSeedFlowCount: calibratedRecentSeedFlowCount,
          activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
        });
      const previewControlledOverlapAllowed =
        activeProtectedResidualLock !== undefined &&
        config.allowControlledOverlap &&
        config.maxOpenGroupsPerMarket >= 2 &&
        config.maxOpenPartialGroups >= 1 &&
        (!config.allowOverlapOnlyAfterPartialClassified || pairgroupLinkageHealthy) &&
        (!config.allowOverlapOnlyWhenCompletionEngineActive || overlapCompletionActive) &&
        (!config.requireMatchedInventoryBeforeSecondGroup || matchedInventoryTargetMet || relaxedMatchedInventoryRequirement) &&
        overlapAgeEligible &&
        (config.allowOverlapInLast30S || nowTs < market.endTs - config.finalWindowCompletionOnlySec) ||
        carryPreservedOverlapAllowed;
      const postMergeCompletionOnlyActive =
        config.postMergeOnlyCompletion &&
        (state.reentryDisabled ||
          (state.postMergeCompletionOnlyUntil !== undefined && nowTs < state.postMergeCompletionOnlyUntil));
      const partialOpenCompletionOnlyActive =
        config.blockNewPairWhilePartialOpen &&
        partialOpenGroupLock !== undefined &&
        config.maxOpenPartialGroups <= 1 &&
        !previewControlledOverlapAllowed &&
        !(
          riskToleranceBias >= 0.55 &&
          calibratedRecentSeedFlowCount >= 1 &&
          (residualSeverity.level === "micro" || residualSeverity.level === "small" || residualSeverity.level === "medium")
        );
      const decision = bot.evaluateTick({
        config,
        state,
        books,
        nowTs,
        riskContext: {
          secsToClose: market.endTs - nowTs,
          staleBookMs: Math.max(computeBookStaleMs(upBook, nowTs), computeBookStaleMs(downBook, nowTs)),
          balanceStaleMs: Math.max(0, (nowTs - lastBalanceSyncAt) * 1000),
          bookIsCrossed: books.bestBid("UP") > books.bestAsk("UP") || books.bestBid("DOWN") > books.bestAsk("DOWN"),
          dailyLossUsdc: 0,
          marketLossUsdc: 0,
          usdcBalance: cachedUsdcBalance,
          forceNoNewEntries:
            startupBlockNewEntries || postMergeCompletionOnlyActive || partialOpenCompletionOnlyActive,
          forceCompletionOnly:
            startupCompletionOnly || postMergeCompletionOnlyActive || partialOpenCompletionOnlyActive,
          forceSafeHalt: startupSafeHalt,
          externalReasons: [
            ...startupExternalReasons,
            ...(postMergeCompletionOnlyActive ? ["post_merge_completion_only"] : []),
            ...(partialOpenCompletionOnlyActive ? ["partial_group_open"] : []),
          ],
        },
        dryRunOrSmallLive: false,
        dailyNegativeEdgeSpentUsdc:
          resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc,
        fairValueSnapshot: latestFairValueSnapshot,
        allowControlledOverlap: previewControlledOverlapAllowed,
        protectedResidualShares,
        protectedResidualSide: activeProtectedResidualLock?.protectedSide,
        recentSeedFlowCount: calibratedRecentSeedFlowCount,
        activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
        completionPatienceMultiplier: runtimeFlowCalibrationBias.completionPatienceMultiplier,
        openingSeedReleaseBias: runtimeFlowCalibrationBias.openingSeedReleaseBias,
        semanticRoleAlignmentBias: runtimeFlowCalibrationBias.semanticRoleAlignmentBias,
        childOrderMicroTimingBias: runtimeFlowCalibrationBias.childOrderMicroTimingBias,
        completionRoleReleaseOrderBias: runtimeFlowCalibrationBias.completionRoleReleaseOrderBias,
        matchedInventoryQuality: unlockedMatchedInventoryQuality,
        flowPressureState: runtimeFlowBudgetState,
        arbitrationCarry:
          arbitrationCarry &&
          activeProtectedResidualLock &&
          arbitrationCarry.protectedResidualSide === activeProtectedResidualLock.protectedSide
            ? {
                recommendation: arbitrationCarry.recommendation,
                preferredSeedSide: arbitrationCarry.preferredSeedSide,
                alignmentStreak: arbitrationCarry.alignmentStreak,
                flowConfidence: carryFlowConfidence,
              }
            : undefined,
      });
      const decisionTraceContext: DecisionTraceContext = {
        eventSeq: marketEventSeq,
        decisionLatencyMs: Math.max(0, Date.now() - Math.max(latestBookEventAtMs, decisionEvalStartedAtMs)),
        bookAgeMsUp: Math.max(0, Date.now() - lastBookEventAtMs.UP),
        bookAgeMsDown: Math.max(0, Date.now() - lastBookEventAtMs.DOWN),
        arbitrationCarryRecommendation: arbitrationCarry?.recommendation,
        arbitrationCarryPreferredSeedSide: arbitrationCarry?.preferredSeedSide,
        runtimeFlowBudgetState,
        runtimeFlowBudgetLastLineage,
        runtimeFlowBudgetDominantLineageLoad: dominantRuntimeFlowBudgetLineageLoad(runtimeFlowBudgetLineageLoads),
        runtimeFlowCalibrationBias,
      };
      if (activeProtectedResidualLock && decision.trace.entry.overlapRepairArbitration === "favor_independent_overlap") {
        const preferredSeedSide = selectPreferredSeedSide(decision);
        const stickyOutcome = decision.trace.entry.overlapRepairOutcome;
        if (stickyOutcome === "overlap_seed" || stickyOutcome === "pair_reentry" || stickyOutcome === "wait") {
          const nextCarry: ArbitrationCarry = {
            createdAt: arbitrationCarry?.createdAt ?? nowTs,
            recommendation: "favor_independent_overlap",
            preferredSeedSide,
            protectedResidualSide: activeProtectedResidualLock.protectedSide,
            referenceShareGap: Math.max(protectedResidualShares, Math.abs(state.upShares - state.downShares)),
            alignmentStreak:
              arbitrationCarry?.recommendation === "favor_independent_overlap" &&
              (arbitrationCarry.preferredSeedSide === preferredSeedSide || preferredSeedSide === undefined)
                ? arbitrationCarry.alignmentStreak + 1
                : 1,
            lastObservedAt: nowTs,
            lastProtectedShares: protectedResidualShares,
            expiresAt: nowTs + Math.max(6, config.partialFastWindowSec),
            residualSeverityLevel: residualBehaviorState.severity.level,
          };
          if (!arbitrationCarry || arbitrationCarry.recommendation !== nextCarry.recommendation) {
            arbitrationCarryCreatedCount += 1;
          }
          arbitrationCarry = {
            ...nextCarry,
            expiresAt: deriveArbitrationCarryExpiry({
              config,
              carry: nextCarry,
              protectedResidualShares,
              nowTs,
              recentSeedFlowCount: calibratedRecentSeedFlowCount,
              residualBehaviorState,
            }),
          };
        }
      } else if (activeProtectedResidualLock && decision.trace.entry.overlapRepairArbitration === "favor_residual_repair") {
        if (decision.trace.entry.overlapRepairOutcome === "repair" || decision.trace.entry.overlapRepairOutcome === "blocked") {
          const nextCarry: ArbitrationCarry = {
            createdAt: arbitrationCarry?.createdAt ?? nowTs,
            recommendation: "favor_residual_repair",
            protectedResidualSide: activeProtectedResidualLock.protectedSide,
            referenceShareGap: Math.max(protectedResidualShares, Math.abs(state.upShares - state.downShares)),
            alignmentStreak:
              arbitrationCarry?.recommendation === "favor_residual_repair"
                ? arbitrationCarry.alignmentStreak + 1
                : 1,
            lastObservedAt: nowTs,
            lastProtectedShares: protectedResidualShares,
            expiresAt: nowTs + Math.max(4, Math.min(config.partialFastWindowSec, 12)),
            residualSeverityLevel: residualBehaviorState.severity.level,
          };
          if (!arbitrationCarry || arbitrationCarry.recommendation !== nextCarry.recommendation) {
            arbitrationCarryCreatedCount += 1;
          }
          arbitrationCarry = {
            ...nextCarry,
            expiresAt: deriveArbitrationCarryExpiry({
              config,
              carry: nextCarry,
              protectedResidualShares,
              nowTs,
              recentSeedFlowCount: calibratedRecentSeedFlowCount,
              residualBehaviorState,
            }),
          };
        }
      } else if (!activeProtectedResidualLock) {
        arbitrationCarry = undefined;
      }
      const carryPersistenceChanged = carryPersistenceKeyBeforeTick !== arbitrationCarryPersistenceKey(arbitrationCarry);
      if (carryPersistenceChanged) {
        persistMarketState(state.reentryDisabled ? "post_merge_completion_only" : undefined);
      }

      if (decision.entryBuys.length === 0 && !decision.completion && !decision.unwind) {
        const traceSignature = decisionTraceSignature(decision);
        if (
          traceSignature !== lastDecisionTraceSignature ||
          nowTs - lastDecisionTraceAt >= DECISION_TRACE_INTERVAL_SEC
        ) {
          pushEvent(events, {
            timestamp: nowTs,
            type: "decision_trace",
            ...buildDecisionTraceEvent(decision, decisionTraceContext),
          });
          const decisionTraceEvent = buildDecisionTraceEvent(decision, decisionTraceContext);
          if (decisionTraceEvent.entryArbitrationActionDelta) {
            entryArbitrationActionDeltaCount += 1;
          }
          await traceLogger.write("decision_trace", decisionTraceEvent);
          emitLiveMirror("decision_trace", {
            marketSlug: market.slug,
            phase: decision.phase,
            allowNewEntries: decision.risk.allowNewEntries,
            completionOnly: decision.risk.completionOnly,
            hardCancel: decision.risk.hardCancel,
            riskReasons: decision.risk.reasons,
            lot: decision.trace.lot,
            shareGap: decision.trace.shareGap,
            bestAskUp: decision.trace.bestAskUp,
            bestAskDown: decision.trace.bestAskDown,
            bestEffectivePair: decisionTraceEvent.bestEffectivePair,
            bestRawPair: decisionTraceEvent.bestRawPair,
            selectedMode: decision.trace.selectedMode ?? null,
            skipReason: decision.trace.entry.skipReason ?? null,
            residualSeverityLevel: decision.trace.entry.residualSeverityLevel ?? null,
            overlapRepairArbitration: decision.trace.entry.overlapRepairArbitration ?? null,
            overlapRepairReason: decision.trace.entry.overlapRepairReason ?? null,
            overlapRepairOutcome: decision.trace.entry.overlapRepairOutcome ?? null,
            arbitrationCarryRecommendation: decisionTraceEvent.arbitrationCarryRecommendation ?? null,
            arbitrationCarryPreferredSeedSide: decisionTraceEvent.arbitrationCarryPreferredSeedSide ?? null,
            flowBudget: decisionTraceEvent.flowBudget ?? null,
            flowBudgetRemaining: decisionTraceEvent.flowBudgetRemaining ?? null,
            flowBudgetReserved: decisionTraceEvent.flowBudgetReserved ?? null,
            flowBudgetRealizedActionReserve: decisionTraceEvent.flowBudgetRealizedActionReserve ?? null,
            flowBudgetLineageActionReserve: decisionTraceEvent.flowBudgetLineageActionReserve ?? null,
            flowBudgetLastLineage: decisionTraceEvent.flowBudgetLastLineage ?? null,
            flowBudgetDominantLineageLoad: decisionTraceEvent.flowBudgetDominantLineageLoad ?? null,
            flowBudgetFlowLoadReserve: decisionTraceEvent.flowBudgetFlowLoadReserve ?? null,
            flowBudgetMergeReserve: decisionTraceEvent.flowBudgetMergeReserve ?? null,
            flowBudgetResidualReserve: decisionTraceEvent.flowBudgetResidualReserve ?? null,
            flowBudgetPendingExecutionReserve: decisionTraceEvent.flowBudgetPendingExecutionReserve ?? null,
            entryArbitrationActionDelta: decisionTraceEvent.entryArbitrationActionDelta ?? null,
            completionMode: decisionTraceEvent.completionMode ?? null,
            completionOverlapRepairArbitration: decisionTraceEvent.completionOverlapRepairArbitration ?? null,
            unwindMode: decisionTraceEvent.unwindMode ?? null,
            unwindOverlapRepairArbitration: decisionTraceEvent.unwindOverlapRepairArbitration ?? null,
            gateReasons: decision.trace.entry.candidates
              .map((candidate) => candidate.gateReason)
              .filter((reason): reason is string => Boolean(reason)),
            allowControlledOverlap: previewControlledOverlapAllowed,
            partialOpenGroupId: partialOpenGroupLock?.groupId ?? null,
          });
          if (decision.risk.reasons.length > 0 || decision.trace.entry.gatedByRisk) {
            await traceLogger.write("risk_events", {
              reason: decision.trace.entry.skipReason ?? "risk_gate",
              riskReasons: decision.risk.reasons,
              phase: decision.phase,
              allowNewEntries: decision.risk.allowNewEntries,
              completionOnly: decision.risk.completionOnly,
              hardCancel: decision.risk.hardCancel,
            });
          }
          lastDecisionTraceSignature = traceSignature;
          lastDecisionTraceAt = nowTs;
        }
      }

      if (Date.now() < actionCooldownUntil) {
        await waitForDecisionPulse();
        continue;
      }

      if (pendingPairExecution && decision.entryBuys.length > 1) {
        await waitForDecisionPulse();
        continue;
      }

      const worstCaseAmplificationShares = computeWorstCaseAmplificationShares(state, decision.entryBuys);
      const controlledOverlapLock = partialOpenGroupLock ?? runtimeProtectedResidualLock;
      const controlledOverlapActive = shouldAllowControlledOverlap({
        config,
        nowTs,
        secsToClose: market.endTs - nowTs,
        protectedResidualLock: controlledOverlapLock,
        protectedResidualShares,
        completionActive: overlapCompletionActive,
        linkageHealthy: pairgroupLinkageHealthy,
        entryBuys: decision.entryBuys,
        matchedInventoryTargetMet,
        worstCaseAmplificationShares,
        recentSeedFlowCount: calibratedRecentSeedFlowCount,
        activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
      });

      if (controlledOverlapLock && decision.entryBuys.length > 1 && !controlledOverlapActive) {
        await traceLogger.write("risk_events", {
          reason: "controlled_overlap_blocked",
          partialGroupId: partialOpenGroupLock?.groupId ?? null,
          partialStatus: partialOpenGroupLock?.status ?? "SEED_ONLY",
          partialAgeSec,
          protectedResidualShares,
          residualSeverityLevel: residualSeverity.level,
          completionActive: overlapCompletionActive,
          linkageHealthy: pairgroupLinkageHealthy,
          matchedInventoryTargetMet,
          worstCaseAmplificationShares,
          secsToClose: market.endTs - nowTs,
          residualLockSource: partialOpenGroupLock ? "partial_group" : runtimeProtectedResidualLock?.sourceMode ?? null,
        });
        await waitForDecisionPulse();
        continue;
      }

      let completionSubmittedThisTick = false;
      const submitDecisionCompletion = async (submitContext: "completion_only" | "same_window_completion_first") => {
        if (!decision.completion || completionSubmittedThisTick) {
          return false;
        }
        completionSubmittedThisTick = true;
        assertClassifiedBuyMode(decision.completion.mode, config);
        const liveOrder = withAvailableUsdcBalance(decision.completion.order, cachedUsdcBalance);
        const result = await completionManager.complete(liveOrder);
        rememberSubmittedPrices(
          submittedPrices,
          market,
          [
            {
              ...decision.completion.order,
              side: decision.completion.order.side,
              mode: decision.completion.mode,
              orderId: result.orderId,
              expectedShares: expectedSharesForSubmission(liveOrder.shareTarget, result),
            },
          ],
          nowTs,
        );
        const accepted = isOrderResultAccepted(result);
        if (accepted) {
          applyRuntimeFlowBudgetAction("completion_submit", {
            quantityShares: runtimeFlowBudgetReleaseQuantityForResidualChange({
              requestedShares: decision.completion.missingShares,
              oldGap: decision.completion.oldGap,
              newGap: decision.completion.newGap,
            }),
            lineage: currentRuntimeFlowLineage(decision.completion.sideToBuy),
          });
          state = reserveNegativeEdgeBudget(state, decision.completion.negativeEdgeUsdc, "completion");
          persistDailyBudget(state);
          state = updateSeedSubmissionState(state, decision.completion.mode, decision.completion.sideToBuy);
          persistMarketState(submitContext === "same_window_completion_first" ? "same_window_completion_first" : undefined);
        } else {
          await logRejectedOrder({
            traceLogger,
            phase: "completion",
            mode: decision.completion.mode,
            side: decision.completion.sideToBuy,
            size: decision.completion.missingShares,
            result,
            order: liveOrder,
            negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          });
        }
        completionSubmitCount += 1;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "completion_submit",
          outcome: decision.completion.sideToBuy,
          mode: decision.completion.mode,
          size: decision.completion.missingShares,
          price: liveOrder.price,
          shareTarget: liveOrder.shareTarget ?? null,
          spendAmount: liveOrder.amount,
          costWithFees: decision.completion.costWithFees,
          capMode: decision.completion.capMode,
          negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          result: summarizeOrderResult(result),
          submitContext,
        });
        await traceLogger.write("orders", {
          eventType: "completion_submit",
          normalizedMode: `COMPLETION_${decision.completion.sideToBuy}`,
          outcome: decision.completion.sideToBuy,
          size: decision.completion.missingShares,
          price: liveOrder.price ?? null,
          shareTarget: liveOrder.shareTarget ?? null,
          spendAmount: liveOrder.amount,
          capMode: decision.completion.capMode,
          negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          orderId: result.orderId,
          orderStatus: result.status,
          orderAccepted: accepted,
          orderResult: summarizeOrderResult(result),
          oldGap: decision.completion.oldGap,
          newGapEstimate: decision.completion.newGap,
          wouldIncreaseImbalance:
            decision.completion.newGap > decision.completion.oldGap + config.maxCompletionOvershootShares,
          requestedQty: decision.completion.missingShares,
          finalQty: decision.completion.missingShares,
          missingQty: Math.abs(state.upShares - state.downShares),
          residualOppositeAveragePrice: decision.completion.oppositeAveragePrice,
          missingSideAveragePrice: decision.completion.missingSideAveragePrice,
          effectiveCompletionCost: decision.completion.costWithFees,
          highLowMismatch: decision.completion.highLowMismatch,
          capUsed: decision.completion.capMode,
          rejectReason: accepted ? null : "completion_rejected",
          sameWindowCompletionFirst: submitContext === "same_window_completion_first",
          correlationId: result.orderId,
        });
        emitLiveMirror("completion_submit", {
          marketSlug: market.slug,
          normalizedMode: `COMPLETION_${decision.completion.sideToBuy}`,
          outcome: decision.completion.sideToBuy,
          size: decision.completion.missingShares,
          price: liveOrder.price ?? null,
          shareTarget: liveOrder.shareTarget ?? null,
          spendAmount: liveOrder.amount,
          capMode: decision.completion.capMode,
          negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          orderId: result.orderId ?? null,
          orderStatus: result.status,
          orderAccepted: accepted,
          oldGap: decision.completion.oldGap,
          newGapEstimate: decision.completion.newGap,
          missingQty: Math.abs(state.upShares - state.downShares),
          residualOppositeAveragePrice: decision.completion.oppositeAveragePrice,
          missingSideAveragePrice: decision.completion.missingSideAveragePrice,
          effectiveCompletionCost: decision.completion.costWithFees,
          highLowMismatch: decision.completion.highLowMismatch,
          sameWindowCompletionFirst: submitContext === "same_window_completion_first",
          rejectReason: accepted ? null : "completion_rejected",
        });
        return accepted;
      };
      const sameWindowCompletionFirst =
        Boolean(decision.completion) &&
        decision.entryBuys.length > 0 &&
        decision.trace.entry.overlapRepairOutcome === "overlap_seed";
      if (sameWindowCompletionFirst) {
        await submitDecisionCompletion("same_window_completion_first");
      }

      if (decision.entryBuys.length > 0) {
        const submittedAtTs = nowTs;
        const submittedAtMs = Date.now();
        for (const entryBuy of decision.entryBuys) {
          assertClassifiedBuyMode(entryBuy.mode, config);
        }
        if (decision.entryBuys.length === 2) {
          const upEntry = decision.entryBuys.find((entryBuy) => entryBuy.side === "UP");
          const downEntry = decision.entryBuys.find((entryBuy) => entryBuy.side === "DOWN");
          if (!upEntry || !downEntry) {
            throw new Error("Balanced pair entry expected both UP and DOWN legs.");
          }

          const group = createPairOrderGroup({
            conditionId: market.conditionId,
            marketSlug: market.slug,
            upTokenId: market.tokens.UP.tokenId,
            downTokenId: market.tokens.DOWN.tokenId,
            intendedQty: Math.min(upEntry.size, downEntry.size),
            maxUpPrice: upEntry.order.price,
            maxDownPrice: downEntry.order.price,
            mode: config.botMode,
            selectedMode: upEntry.mode as
              | "STRICT_PAIR_SWEEP"
              | "XUAN_SOFT_PAIR_SWEEP"
              | "XUAN_HARD_PAIR_SWEEP"
              | "TEMPORAL_SINGLE_LEG_SEED"
              | "PAIRGROUP_COVERED_SEED",
            createdAt: submittedAtMs,
            state,
            rawPair: upEntry.rawPairCost ?? 0,
            effectivePair: upEntry.pairCostWithFees ?? 0,
            negativeEdgeUsdc: upEntry.negativeEdgeUsdc ?? 0,
          });
          const groupedEntries = applyPairOrderType(decision.entryBuys, group);
          const missingSide: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
          const sequentialPairExecutionActive =
            controlledOverlapActive || group.selectedMode === "PAIRGROUP_COVERED_SEED";
          const orderedEntries = orderPairEntriesForPublicFootprint({
            config,
            state,
            group,
            groupedEntries,
            controlledOverlapActive,
            missingSide,
          });
          const groupedEntryBySide = {
            UP: groupedEntries.find((entryBuy) => entryBuy.side === "UP")!,
            DOWN: groupedEntries.find((entryBuy) => entryBuy.side === "DOWN")!,
          } satisfies Record<OutcomeSide, EntryBuyDecision>;
          const orderPlanBySide = buildPairOrderPlan({
            config,
            entriesBySide: groupedEntryBySide,
            books,
            minOrderSize: state.market.minOrderSize,
            cachedUsdcBalance,
          });
          const pairChildOrderDelayMs =
            runtimeFlowCalibrationBias.childOrderMicroTimingBias === "flow_intent" ||
            decision.trace.entry.childOrderReason === "flow_intent"
              ? Math.min(config.cloneChildOrderDelayMs, runtimeFlowCalibrationBias.childOrderDispatchDelayCapMs ?? 40)
              : config.cloneChildOrderDelayMs;
          activePairSubmission = {
            groupId: group.groupId,
            expiresAt: submittedAtTs + submittedIntentMaxAgeSec,
            entries: groupedEntries.map((entryBuy) => ({
              outcome: entryBuy.side,
              price: orderPlanBySide[entryBuy.side][0]?.price,
              expectedShares: sumOrderShareTargets(orderPlanBySide[entryBuy.side]),
              mode: entryBuy.mode,
            })),
          };
          const executedBySide = await executePairOrderPlan({
            completionManager,
            orderPlanBySide,
            orderedEntries,
            sequentialPairExecutionActive,
            interChildDelayMs: pairChildOrderDelayMs,
          });
          const upResult = selectRepresentativeResult(executedBySide.UP);
          const downResult = selectRepresentativeResult(executedBySide.DOWN);
          const allExecutions = [...executedBySide.UP, ...executedBySide.DOWN];

          rememberSubmittedPrices(
            submittedPrices,
            market,
            allExecutions.map(({ order, result }) => ({
              ...order,
              side: order.side,
              mode:
                order.tokenId === market.tokens.UP.tokenId
                  ? groupedEntryBySide.UP.mode
                  : groupedEntryBySide.DOWN.mode,
              groupId: group.groupId,
              orderId: result.orderId,
              expectedShares: expectedSharesForSubmission(order.shareTarget, result),
            })),
            submittedAtTs,
          );
          const negativeEdgeUsdc = estimateNegativeEdgeUsdc(upEntry.pairCostWithFees ?? 1, group.intendedQty);
          pairGroupCount += 1;
          entrySubmitCount += allExecutions.length;
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          const anyAccepted = Boolean(
            (upResult && isOrderResultAccepted(upResult)) ||
              (downResult && isOrderResultAccepted(downResult)),
          );
          if (anyAccepted) {
            applyRuntimeFlowBudgetAction("pair_submit", {
              quantityShares: group.intendedQty,
              lineage: currentRuntimeFlowLineage(orderedEntries[0]?.side),
            });
            persistMarketState("pair_group_pending");
          }
          const pairFinalizeTimeoutMs = anyAccepted
            ? Math.max(config.pairgroupFinalizeTimeoutMs, submittedIntentMaxAgeSec * 1000)
            : config.pairgroupFinalizeTimeoutMs;
          pendingPairExecution = {
            group,
            upResult,
            downResult,
            negativeEdgeUsdc,
            deadlineAt: Date.now() + Math.max(config.reentryDelayMs * 3, pairFinalizeTimeoutMs),
            status: "PENDING",
            submittedAt: submittedAtTs,
            reconciledAfterSubmit: false,
          };
          stateStore.upsertPairGroup(group);
          let immediateFinalizedPairExecution: PairExecutionResult | undefined;
          const immediateOrderResultFills = allExecutions.flatMap(({ order, result }) => {
            const outcome: OutcomeSide = order.tokenId === market.tokens.UP.tokenId ? "UP" : "DOWN";
            const mode = outcome === "UP" ? upEntry.mode : downEntry.mode;
            const fill = inferImmediateOrderResultFill({
              result,
              order,
              outcome,
              nowTs,
              mode,
            });
            return fill ? [{ fill, result, mode }] : [];
          });
          for (const immediateFill of immediateOrderResultFills) {
            const normalizedImmediateFill: FillRecord = {
              ...immediateFill.fill,
              flowLineage:
                immediateFill.fill.flowLineage ??
                deriveCarryFlowLineageKey({
                  recommendation: arbitrationCarry?.recommendation,
                  preferredSeedSide: arbitrationCarry?.preferredSeedSide,
                  protectedResidualSide:
                    arbitrationCarry?.protectedResidualSide ?? (partialOpenGroupLock ?? runtimeProtectedResidualLock)?.protectedSide,
                }),
            };
            state = applyFill(state, normalizedImmediateFill);
            stateStore.recordFill(state, normalizedImmediateFill, {
              orderId: immediateFill.result?.orderId,
              groupId: group.groupId,
              executionMode: immediateFill.mode,
              source: "ORDER_RESULT",
            });
            rememberBotOwnedBuyFill(normalizedImmediateFill, {
              groupId: group.groupId,
              orderId: immediateFill.result?.orderId,
            });
            consumeSubmittedIntent(submittedPrices, normalizedImmediateFill.outcome, normalizedImmediateFill.size);
            rememberOrderResultFillSuppression(normalizedImmediateFill);
            pushEvent(events, {
              timestamp: nowTs,
              type: "order_result_fill",
              groupId: group.groupId,
              outcome: normalizedImmediateFill.outcome,
              size: immediateFill.fill.size,
              price: immediateFill.fill.price,
              orderId: immediateFill.result?.orderId ?? null,
            });
            await traceLogger.write("user_fills", {
              eventType: "order_result_fill",
              outcome: immediateFill.fill.outcome,
              side: immediateFill.fill.side,
              size: immediateFill.fill.size,
              price: immediateFill.fill.price,
              executionMode: immediateFill.mode,
              groupId: group.groupId,
              orderId: immediateFill.result?.orderId ?? null,
              source: "ORDER_RESULT",
              correlationId: group.groupId,
            });
          }
          if (immediateOrderResultFills.length > 0) {
            immediateFinalizedPairExecution = finalizePairExecutionResult({
              group,
              upResult,
              downResult,
              state,
              fillSnapshot: stateStore.loadPairGroupFillSnapshot(group.groupId),
              reconcileObservedAfterSubmit: false,
              requireReconcileBeforeNoneFilled: true,
            });
            pendingPairExecution = {
              ...pendingPairExecution,
              status: immediateFinalizedPairExecution.status,
            };
            persistMarketState("order_result_fill");
          }
          pushEvent(events, {
            timestamp: nowTs,
            type: "pair_group_submit",
            groupId: group.groupId,
            selectedMode: group.selectedMode,
            orderType: group.orderType,
            intendedQty: group.intendedQty,
            maxUpPrice: group.maxUpPrice,
            maxDownPrice: group.maxDownPrice,
            rawPair: group.rawPair,
            pairCostWithFees: upEntry.pairCostWithFees,
            negativeEdgeUsdc,
            marketNegativeSpentBefore: group.marketNegativeSpentBefore,
            marketNegativeSpentAfter: group.marketNegativeSpentAfter,
            controlledOverlap: controlledOverlapActive,
            upChildOrderCount: executedBySide.UP.length,
            downChildOrderCount: executedBySide.DOWN.length,
            upResult,
            downResult,
          });
          await traceLogger.write("pair_groups", {
            eventType: "pair_group_submit",
            pairGroupId: group.groupId,
            status: "SUBMITTED",
            selectedMode: group.selectedMode,
            intendedQty: group.intendedQty,
            rawPair: group.rawPair,
            effectivePair: group.effectivePair,
            negativeEdgeUsdc,
            maxUpPrice: group.maxUpPrice ?? null,
            maxDownPrice: group.maxDownPrice ?? null,
            orderType: group.orderType,
            marketNegativeSpentBefore: group.marketNegativeSpentBefore,
            marketNegativeSpentAfter: group.marketNegativeSpentAfter,
            filledUpQty: null,
            filledDownQty: null,
            correlationId: group.groupId,
          });
          await traceLogger.write("orders", {
            eventType: "pair_orders_submit",
            pairGroupId: group.groupId,
            orderType: group.orderType,
            controlledOverlap: controlledOverlapActive,
            sequentialPairExecution: sequentialPairExecutionActive,
            interChildDelayMs: pairChildOrderDelayMs,
            childOrderReason: decision.trace.entry.childOrderReason ?? null,
            childOrderMicroTimingBias: runtimeFlowCalibrationBias.childOrderMicroTimingBias,
            upChildOrderCount: executedBySide.UP.length,
            downChildOrderCount: executedBySide.DOWN.length,
            upOrderId: upResult?.orderId ?? null,
            downOrderId: downResult?.orderId ?? null,
            upStatus: upResult?.status ?? null,
            downStatus: downResult?.status ?? null,
            upAccepted: upResult ? isOrderResultAccepted(upResult) : false,
            downAccepted: downResult ? isOrderResultAccepted(downResult) : false,
            upChildResults: executedBySide.UP.map((execution) => summarizeOrderResult(execution.result)),
            downChildResults: executedBySide.DOWN.map((execution) => summarizeOrderResult(execution.result)),
            upResult: upResult ? summarizeOrderResult(upResult) : null,
            downResult: downResult ? summarizeOrderResult(downResult) : null,
          });
          emitLiveMirror("pair_group_submit", {
            marketSlug: market.slug,
            pairGroupId: group.groupId,
            selectedMode: group.selectedMode,
            orderType: group.orderType,
            intendedQty: group.intendedQty,
            rawPair: group.rawPair,
            effectivePair: group.effectivePair,
            negativeEdgeUsdc,
            controlledOverlap: controlledOverlapActive,
            sequentialPairExecution: sequentialPairExecutionActive,
            interChildDelayMs: pairChildOrderDelayMs,
            childOrderReason: decision.trace.entry.childOrderReason ?? null,
            childOrderMicroTimingBias: runtimeFlowCalibrationBias.childOrderMicroTimingBias,
            up: {
              price: group.maxUpPrice ?? null,
              shareTarget: sumOrderShareTargets(orderPlanBySide.UP) ?? null,
              spendAmount: sumOrderAmounts(orderPlanBySide.UP),
              childOrderCount: executedBySide.UP.length,
              orderId: upResult?.orderId ?? null,
              status: upResult?.status ?? null,
              accepted: upResult ? isOrderResultAccepted(upResult) : false,
            },
            down: {
              price: group.maxDownPrice ?? null,
              shareTarget: sumOrderShareTargets(orderPlanBySide.DOWN) ?? null,
              spendAmount: sumOrderAmounts(orderPlanBySide.DOWN),
              childOrderCount: executedBySide.DOWN.length,
              orderId: downResult?.orderId ?? null,
              status: downResult?.status ?? null,
              accepted: downResult ? isOrderResultAccepted(downResult) : false,
            },
          });
          if (immediateFinalizedPairExecution && pendingPairExecution) {
            await persistFinalizedPairGroup(immediateFinalizedPairExecution, pendingPairExecution, nowTs);
            pendingPairExecution = undefined;
            activePairSubmission = undefined;
          }
        } else {
          const entryBuy = decision.entryBuys[0];
          if (!entryBuy) {
            throw new Error("Expected a single entry buy decision.");
          }
          const temporalSeedGroup =
            entryBuy.mode === "TEMPORAL_SINGLE_LEG_SEED"
              ? createPairOrderGroup({
                  conditionId: market.conditionId,
                  marketSlug: market.slug,
                  upTokenId: market.tokens.UP.tokenId,
                  downTokenId: market.tokens.DOWN.tokenId,
                  intendedQty: entryBuy.size,
                  ...(entryBuy.side === "UP" ? { maxUpPrice: entryBuy.order.price } : {}),
                  ...(entryBuy.side === "DOWN" ? { maxDownPrice: entryBuy.order.price } : {}),
                  mode: config.botMode,
                  selectedMode: "TEMPORAL_SINGLE_LEG_SEED",
                  createdAt: submittedAtMs,
                  state,
                  rawPair: entryBuy.rawPairCost ?? 0,
                  effectivePair: entryBuy.pairCostWithFees ?? 0,
                  negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
                })
              : undefined;
          const groupedSingleOrder = temporalSeedGroup
            ? {
                ...entryBuy.order,
                metadata: `${temporalSeedGroup.groupId}:${entryBuy.side}`,
              }
            : entryBuy.order;
          const plannedOrders =
            config.xuanCloneMode === "PUBLIC_FOOTPRINT"
              ? planCloneChildBuyOrders({
                  order: groupedSingleOrder,
                  outcome: entryBuy.side,
                  books,
                  minOrderSize: state.market.minOrderSize,
                  preferredChildShares: config.cloneChildPreferredShares,
                })
              : [groupedSingleOrder];
          const liveOrders = assignSequentialUsdcBalances(plannedOrders, cachedUsdcBalance);
          if (temporalSeedGroup) {
            stateStore.upsertPairGroup(temporalSeedGroup);
            activePairSubmission = {
              groupId: temporalSeedGroup.groupId,
              expiresAt: submittedAtTs + submittedIntentMaxAgeSec,
              entries: [
                {
                  outcome: entryBuy.side,
                  price: liveOrders[0]?.price,
                  expectedShares: entryBuy.size,
                  mode: entryBuy.mode,
                },
              ],
            };
          }
          const executions = await executeMarketOrdersInSequence(
            completionManager,
            liveOrders,
            config.cloneChildOrderDelayMs,
          );
          const representativeExecution = selectRepresentativeExecution(executions);
          const result = representativeExecution.result;
          const accepted = executions.some((execution) => isOrderResultAccepted(execution.result));
          rememberSubmittedPrices(
            submittedPrices,
            market,
            executions.map(({ order, result: executionResult }) => ({
              ...order,
              side: order.side,
              mode: entryBuy.mode,
              groupId: temporalSeedGroup?.groupId,
              orderId: executionResult.orderId,
              expectedShares: expectedSharesForSubmission(order.shareTarget, executionResult),
            })),
            submittedAtTs,
          );
          if (temporalSeedGroup) {
            pendingPairExecution = {
              group: temporalSeedGroup,
              upResult: entryBuy.side === "UP" ? result : undefined,
              downResult: entryBuy.side === "DOWN" ? result : undefined,
              negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
              deadlineAt: Date.now() + Math.max(config.reentryDelayMs * 3, config.pairgroupFinalizeTimeoutMs),
              status: "PENDING",
              submittedAt: submittedAtTs,
              reconciledAfterSubmit: false,
            };
          }
          if (accepted && !temporalSeedGroup) {
            applyRuntimeFlowBudgetAction("seed_submit", {
              quantityShares: entryBuy.size,
              lineage: currentRuntimeFlowLineage(entryBuy.side),
            });
            state = reserveNegativeEdgeBudget(state, entryBuy.negativeEdgeUsdc ?? 0, "pair");
            persistDailyBudget(state);
            state = updateSeedSubmissionState(state, entryBuy.mode, entryBuy.side);
            persistMarketState();
          } else if (!accepted) {
            await logRejectedOrder({
              traceLogger,
              phase: "entry",
              mode: entryBuy.mode,
              side: entryBuy.side,
              size: entryBuy.size,
              result,
              order: representativeExecution.order,
              negativeEdgeUsdc: entryBuy.negativeEdgeUsdc,
            });
          }
          if (temporalSeedGroup && pendingPairExecution) {
            if (accepted) {
              applyRuntimeFlowBudgetAction("seed_submit", {
                quantityShares: entryBuy.size,
                lineage: currentRuntimeFlowLineage(entryBuy.side),
              });
              persistMarketState("pair_group_pending");
            }
            let sawImmediateFill = false;
            for (const execution of executions) {
              const immediateFill = inferImmediateOrderResultFill({
                result: execution.result,
                order: execution.order,
                outcome: entryBuy.side,
                nowTs,
                mode: entryBuy.mode,
              });
              if (!immediateFill) {
                continue;
              }
              sawImmediateFill = true;
              const normalizedImmediateFill: FillRecord = {
                ...immediateFill,
                flowLineage:
                  immediateFill.flowLineage ??
                  deriveCarryFlowLineageKey({
                    recommendation: arbitrationCarry?.recommendation,
                    preferredSeedSide: arbitrationCarry?.preferredSeedSide,
                    protectedResidualSide:
                      arbitrationCarry?.protectedResidualSide ?? (partialOpenGroupLock ?? runtimeProtectedResidualLock)?.protectedSide,
                  }),
              };
              state = applyFill(state, normalizedImmediateFill);
              stateStore.recordFill(state, normalizedImmediateFill, {
                orderId: execution.result.orderId,
                groupId: temporalSeedGroup.groupId,
                executionMode: entryBuy.mode,
                source: "ORDER_RESULT",
              });
              rememberBotOwnedBuyFill(normalizedImmediateFill, {
                groupId: temporalSeedGroup.groupId,
                orderId: execution.result.orderId,
              });
              runtimeProtectedResidualLock =
                partialOpenGroupLock !== undefined
                  ? undefined
                  : refreshRuntimeProtectedResidualLock({
                      lock: runtimeProtectedResidualLock,
                      state,
                      nowTs,
                      mode: entryBuy.mode,
                    });
              consumeSubmittedIntent(submittedPrices, immediateFill.outcome, immediateFill.size);
              rememberOrderResultFillSuppression(immediateFill);
              pushEvent(events, {
                timestamp: nowTs,
                type: "order_result_fill",
                groupId: temporalSeedGroup.groupId,
                outcome: immediateFill.outcome,
                size: immediateFill.size,
                price: immediateFill.price,
                orderId: execution.result.orderId ?? null,
              });
              await traceLogger.write("user_fills", {
                eventType: "order_result_fill",
                outcome: immediateFill.outcome,
                side: immediateFill.side,
                size: immediateFill.size,
                price: immediateFill.price,
                executionMode: entryBuy.mode,
                groupId: temporalSeedGroup.groupId,
                orderId: execution.result.orderId ?? null,
                source: "ORDER_RESULT",
                correlationId: temporalSeedGroup.groupId,
              });
            }
            if (sawImmediateFill || !accepted) {
              const finalized = finalizePairExecutionResult({
                group: temporalSeedGroup,
                upResult: entryBuy.side === "UP" ? result : undefined,
                downResult: entryBuy.side === "DOWN" ? result : undefined,
                state,
                fillSnapshot: stateStore.loadPairGroupFillSnapshot(temporalSeedGroup.groupId),
                reconcileObservedAfterSubmit: false,
                requireReconcileBeforeNoneFilled: true,
              });
              pendingPairExecution = {
                ...pendingPairExecution,
                status: finalized.status,
              };
              await persistFinalizedPairGroup(finalized, pendingPairExecution, nowTs);
              pendingPairExecution = undefined;
              activePairSubmission = undefined;
            }
          }
          entrySubmitCount += 1;
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          pushEvent(events, {
            timestamp: nowTs,
            type: "entry_submit",
            orders: executions.map(({ order, result: executionResult }) => ({
              side: entryBuy.side,
              size: order.shareTarget ?? entryBuy.size,
              price: order.price,
              reason: entryBuy.reason,
              mode: entryBuy.mode,
              rawPair: entryBuy.rawPairCost ?? null,
              effectivePair: entryBuy.pairCostWithFees ?? null,
              negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
              shareTarget: order.shareTarget ?? null,
              spendAmount: order.amount,
              result: summarizeOrderResult(executionResult),
            })),
          });
          await traceLogger.write("orders", {
            eventType: "entry_submit",
            selectedMode: entryBuy.mode,
            side: entryBuy.side,
            size: entryBuy.size,
            childOrderCount: executions.length,
            price: representativeExecution.order.price ?? null,
            shareTarget: entryBuy.size,
            spendAmount: Number(executions.reduce((total, execution) => total + execution.order.amount, 0).toFixed(6)),
            negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
            orderId: result.orderId,
            orderStatus: result.status,
            orderAccepted: accepted,
            orderResult: summarizeOrderResult(result),
            oldGap: decision.trace.entry.repairOldGap ?? decision.trace.shareGap,
            newGapEstimate: decision.trace.entry.repairNewGap ?? null,
            wouldIncreaseImbalance: decision.trace.entry.repairWouldIncreaseImbalance ?? null,
            requestedQty: decision.trace.entry.repairRequestedQty ?? entryBuy.size,
            finalQty: decision.trace.entry.repairFinalQty ?? entryBuy.size,
            missingQty: decision.trace.entry.repairMissingQty ?? null,
            residualOppositeAveragePrice: decision.trace.entry.repairOppositeAveragePrice ?? null,
            effectiveCompletionCost: decision.trace.entry.repairCost ?? entryBuy.pairCostWithFees ?? null,
            capUsed: decision.trace.entry.repairCapMode ?? null,
            rejectReason: accepted ? null : decision.trace.entry.skipReason ?? null,
            correlationId: result.orderId,
          });
          emitLiveMirror("entry_submit", {
            marketSlug: market.slug,
            selectedMode: entryBuy.mode,
            outcome: entryBuy.side,
            reason: entryBuy.reason,
            size: entryBuy.size,
            childOrderCount: executions.length,
            price: representativeExecution.order.price ?? null,
            shareTarget: entryBuy.size,
            spendAmount: Number(executions.reduce((total, execution) => total + execution.order.amount, 0).toFixed(6)),
            rawPair: entryBuy.rawPairCost ?? null,
            effectivePair: entryBuy.pairCostWithFees ?? null,
            negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
            orderId: result.orderId ?? null,
            orderStatus: result.status,
            orderAccepted: accepted,
            oldGap: decision.trace.entry.repairOldGap ?? decision.trace.shareGap,
            newGapEstimate: decision.trace.entry.repairNewGap ?? null,
            missingQty: decision.trace.entry.repairMissingQty ?? null,
            capUsed: decision.trace.entry.repairCapMode ?? null,
            rejectReason: accepted ? null : decision.trace.entry.skipReason ?? null,
          });
        }
        await waitForDecisionPulse();
        continue;
      }

      if (decision.completion) {
        await submitDecisionCompletion("completion_only");
        await waitForDecisionPulse();
        continue;
      }

      if (decision.unwind) {
        const liveOrder = withAvailableUsdcBalance(decision.unwind.order, cachedUsdcBalance);
        const result = await completionManager.complete(liveOrder);
        rememberSubmittedPrices(
          submittedPrices,
          market,
          [
            {
              ...decision.unwind.order,
              side: decision.unwind.order.side,
              mode: decision.unwind.mode,
              orderId: result.orderId,
              expectedShares: expectedSharesForSubmission(liveOrder.shareTarget, result),
            },
          ],
          nowTs,
        );
        const accepted = isOrderResultAccepted(result);
        if (accepted) {
          applyRuntimeFlowBudgetAction("unwind_submit", {
            quantityShares: runtimeFlowBudgetReleaseQuantityForResidualChange({
              requestedShares: decision.unwind.unwindShares,
              oldGap: Math.abs(state.upShares - state.downShares),
              newGap: decision.unwind.residualAfter,
            }),
            lineage: currentRuntimeFlowLineage(decision.unwind.sideToSell),
          });
          state = updateSeedSubmissionState(state, decision.unwind.mode, decision.unwind.sideToSell);
          persistMarketState();
        } else {
          await logRejectedOrder({
            traceLogger,
            phase: "unwind",
            mode: decision.unwind.mode,
            side: decision.unwind.sideToSell,
            size: decision.unwind.unwindShares,
            result,
            order: liveOrder,
          });
        }
        unwindSubmitCount += 1;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "unwind_submit",
          outcome: decision.unwind.sideToSell,
          mode: decision.unwind.mode,
          size: decision.unwind.unwindShares,
          price: liveOrder.price,
          shareTarget: liveOrder.shareTarget ?? null,
          amount: liveOrder.amount,
          result: summarizeOrderResult(result),
        });
        await traceLogger.write("orders", {
          eventType: "unwind_submit",
          outcome: decision.unwind.sideToSell,
          size: decision.unwind.unwindShares,
          price: liveOrder.price ?? null,
          shareTarget: liveOrder.shareTarget ?? null,
          amount: liveOrder.amount,
          orderId: result.orderId,
          orderStatus: result.status,
          orderAccepted: accepted,
          orderResult: summarizeOrderResult(result),
          correlationId: result.orderId,
        });
      }

      await waitForDecisionPulse();
    }

    if (resolvedOptions.postCloseReconcileSec > 0 && clock.now() >= market.endTs) {
      const postCloseStartedAt = clock.now();
      const postCloseDeadline = postCloseStartedAt + resolvedOptions.postCloseReconcileSec;
      let postCloseReconcileCount = 0;
      await traceLogger.write("market_rollover", {
        status: "post_close_reconcile_start",
        marketSlug: market.slug,
        startedAt: postCloseStartedAt,
        deadlineTs: postCloseDeadline,
        pendingPairGroupId: pendingPairExecution?.group.groupId ?? null,
      });
      while (clock.now() <= postCloseDeadline) {
        const nowTs = clock.now();
        const books = buildBooks(marketWs, market);
        if (
          postCloseReconcileCount === 0 ||
          nowTs - lastBalanceSyncAt >= Math.floor(resolvedOptions.balanceSyncMs / 1000)
        ) {
          await performBalanceSync({
            nowTs,
            books,
            scope: "post_close_reconcile",
            traceLabel: "post_close_reconcile_state",
          });
          postCloseReconcileCount += 1;
          await finalizePendingPairExecutionIfReady(nowTs, { forceDeadline: true });
        }

        if (postCloseReconcileCount >= 2 && !pendingPairExecution) {
          break;
        }

        const remainingMs = Math.max(0, (postCloseDeadline - clock.now()) * 1000);
        if (remainingMs <= 0) {
          break;
        }
        await sleep(Math.min(resolvedOptions.balanceSyncMs, remainingMs));
      }
      await traceLogger.write("market_rollover", {
        status: "post_close_reconcile_end",
        marketSlug: market.slug,
        endedAt: clock.now(),
        balanceSyncCount: postCloseReconcileCount,
        pendingPairGroupId: pendingPairExecution?.group.groupId ?? null,
      });
    }
  } finally {
    btcPriceFeed.disconnect();
    marketWs.disconnect();
    userWs.disconnect();
  }

  const endedAt = clock.now();
  const closingMergePlan = planMerge(config, state);
  const closingPendingFillSnapshot = pendingPairExecution
    ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
    : undefined;
  const closingLockedPendingShares = computePendingLockedShares(
    pendingPairExecution,
    closingPendingFillSnapshot,
    config,
  );
  const closingMergeableUnlocked = config.mergeOnlyConfirmedMatchedUnlockedLots
    ? unlockedMergeableShares(state, closingLockedPendingShares)
    : closingMergePlan.mergeable;
  const closingMergeClusterPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledMergeClusterPrior(market.slug, endedAt - market.startTs)
      : undefined;
  const closingMergeTargetQty = closingMergeClusterPrior
    ? Math.min(closingMergeableUnlocked, closingMergeClusterPrior.totalQty)
    : closingMergeableUnlocked;
  const closingMergeAmount = normalizeMergeAmount(closingMergeTargetQty, config.mergeDustLeaveShares);
  if (
    config.mergeMode === "AUTO" &&
    config.mergeOnMarketClose &&
    endedAt >= market.endTs &&
    closingMergeAmount >= config.mergeMinShares &&
    (!pendingPairExecution || config.allowMergeWithPendingGroups) &&
    mergeTxCount < config.mergeMaxTxPerMarket
  ) {
    const closingMergeResult = env.CTF_MERGE_ENABLED
      ? await ctf.mergePositions(market.conditionId, closingMergeAmount)
      : {
          simulated: true,
          skipped: true,
          action: "merge" as const,
          amount: closingMergeAmount,
          conditionId: market.conditionId,
          reason: "CTF_MERGE_ENABLED=false",
        };
    if (closingMergeResult.simulated || !closingMergeResult.skipped) {
      const preMergeState = state;
      state = applyMerge(state, {
        amount: closingMergeAmount,
        timestamp: endedAt,
        simulated: closingMergeResult.simulated,
        flowLineage: deriveCarryFlowLineageKey({
          recommendation: arbitrationCarry?.recommendation,
          preferredSeedSide: arbitrationCarry?.preferredSeedSide,
          protectedResidualSide:
            arbitrationCarry?.protectedResidualSide ?? (partialOpenGroupLock ?? runtimeProtectedResidualLock)?.protectedSide,
        }),
      });
      stateStore.recordMerge(preMergeState, state.mergeHistory.at(-1) ?? {
        amount: closingMergeAmount,
        timestamp: endedAt,
        simulated: closingMergeResult.simulated,
      });
      if (config.postMergeOnlyCompletion) {
        const residualAfterMerge = Math.abs(state.upShares - state.downShares);
        if (config.postMergeOnlyCompletionWhileResidual && residualAfterMerge > config.postMergeFlatDustShares) {
          state = {
            ...state,
            reentryDisabled: true,
            postMergeCompletionOnlyUntil: undefined,
          };
        } else if (config.postMergeAllowNewPairIfFlat) {
          state = {
            ...state,
            reentryDisabled: false,
            postMergeCompletionOnlyUntil:
              endedAt + Math.ceil(config.postMergePairReopenCooldownMs / 1000),
          };
        } else {
          state = {
            ...state,
            reentryDisabled: true,
            postMergeCompletionOnlyUntil:
              endedAt + Math.ceil(config.postMergeNewSeedCooldownMs / 1000),
          };
        }
      }
      mergeCount += 1;
      applyRuntimeFlowBudgetAction("merge", {
        quantityShares: closingMergeAmount,
        lineage: currentRuntimeFlowLineage(),
      });
      persistMarketState(state.reentryDisabled ? "post_merge_completion_only" : undefined);
    }
    await traceLogger.write("merge_redeem", {
      action: "merge",
      amount: closingMergeAmount,
      trigger: "market_close",
      txHash: closingMergeResult.txHash ?? null,
      simulated: closingMergeResult.simulated,
      skipped: closingMergeResult.skipped ?? false,
      matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
      matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
      mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
      realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
      remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
      remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
      postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
    });
    emitLiveMirror("merge_submit", {
      marketSlug: market.slug,
      trigger: "market_close",
      amount: closingMergeAmount,
      txHash: closingMergeResult.txHash ?? null,
      simulated: closingMergeResult.simulated,
      skipped: closingMergeResult.skipped ?? false,
      matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
      matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
      mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
      realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
      remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
      remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
      postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
    });
  }
  const finalBooks = buildBooks(marketWs, market);
  const finalPostMergeCompletionOnlyActive =
    config.postMergeOnlyCompletion &&
    (state.reentryDisabled ||
      (state.postMergeCompletionOnlyUntil !== undefined && endedAt < state.postMergeCompletionOnlyUntil));
  const finalDecision = bot.evaluateTick({
    config,
    state,
    books: finalBooks,
    nowTs: endedAt,
    riskContext: {
      secsToClose: Math.max(0, market.endTs - endedAt),
      staleBookMs: 0,
      balanceStaleMs: Math.max(0, (endedAt - lastBalanceSyncAt) * 1000),
      bookIsCrossed: finalBooks.bestBid("UP") > finalBooks.bestAsk("UP") || finalBooks.bestBid("DOWN") > finalBooks.bestAsk("DOWN"),
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: cachedUsdcBalance,
      forceNoNewEntries: startupBlockNewEntries || finalPostMergeCompletionOnlyActive,
      forceCompletionOnly: startupCompletionOnly || finalPostMergeCompletionOnlyActive,
      forceSafeHalt: startupSafeHalt,
      externalReasons: [
        ...startupExternalReasons,
        ...(finalPostMergeCompletionOnlyActive ? ["post_merge_completion_only"] : []),
      ],
    },
    dryRunOrSmallLive: false,
    dailyNegativeEdgeSpentUsdc:
      resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc,
    fairValueSnapshot: latestFairValueSnapshot,
    recentSeedFlowCount: computeRecentSeedFlowCount(state, endedAt),
    semanticRoleAlignmentBias: runtimeFlowCalibrationBias.semanticRoleAlignmentBias,
    completionRoleReleaseOrderBias: runtimeFlowCalibrationBias.completionRoleReleaseOrderBias,
    arbitrationCarry:
      arbitrationCarry !== undefined
        ? {
            recommendation: arbitrationCarry.recommendation,
            preferredSeedSide: arbitrationCarry.preferredSeedSide,
            alignmentStreak: arbitrationCarry.alignmentStreak,
          }
        : undefined,
  });

  const payload: BotSessionReport = {
    runtime: {
      mode: "live",
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER ?? "",
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
      ctfMergeEnabled: env.CTF_MERGE_ENABLED,
    },
    market: {
      selection: selected.selection,
      slug: market.slug,
      conditionId: market.conditionId,
      startTs: market.startTs,
      endTs: market.endTs,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
    },
    options: resolvedOptions,
    summary: {
      startedAt,
      endedAt,
      ticks,
      userTradeCount,
      balanceSyncCount,
      balanceCorrectionCount,
      entrySubmitCount,
      pairGroupCount,
      partialLegCount,
      completionSubmitCount,
      unwindSubmitCount,
      mergeCount,
      adoptedInventory,
      arbitrationCarryCreatedCount,
      arbitrationCarryExtendedCount,
      arbitrationCarryExpiredCount,
      entryArbitrationActionDeltaCount,
      arbitrationCarryExtensionRate:
        arbitrationCarryCreatedCount > 0
          ? Number((arbitrationCarryExtendedCount / arbitrationCarryCreatedCount).toFixed(6))
          : 0,
      entryArbitrationActionDeltaRate:
        entrySubmitCount > 0
          ? Number((entryArbitrationActionDeltaCount / entrySubmitCount).toFixed(6))
          : 0,
    },
    finalState: {
      upShares: state.upShares,
      downShares: state.downShares,
      upAverage: averageCost(state, "UP"),
      downAverage: averageCost(state, "DOWN"),
      fillCount: state.fillHistory.length,
      mergeCount: state.mergeHistory.length,
      negativeEdgeConsumedUsdc: state.negativeEdgeConsumedUsdc,
      negativePairEdgeConsumedUsdc: state.negativePairEdgeConsumedUsdc,
      negativeCompletionEdgeConsumedUsdc: state.negativeCompletionEdgeConsumedUsdc,
      initialDailyNegativeEdgeSpentUsdc: resolvedOptions.initialDailyNegativeEdgeSpentUsdc,
      finalDailyNegativeEdgeSpentUsdc: Number(
        (resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc).toFixed(6),
      ),
    },
    finalDecision,
    dashboard: renderDashboard(state, finalDecision, endedAt),
    events,
  };

  persistDailyBudget(state);
  await traceLogger.write("market_rollover", {
    status: "session_end",
    endedAt,
    upShares: state.upShares,
    downShares: state.downShares,
    mergeCount,
    fillCount: state.fillHistory.length,
    finalDailyNegativeEdgeSpentUsdc: Number(
      (resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc).toFixed(6),
    ),
  });
  stateStore.recordMarketRollover({
    status: "session_end",
    timestamp: endedAt,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    payload: {
      upShares: state.upShares,
      downShares: state.downShares,
      mergeCount,
      fillCount: state.fillHistory.length,
      finalDailyNegativeEdgeSpentUsdc: Number(
        (resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc).toFixed(6),
      ),
    },
  });
  await traceLogger.flush();
  stateStore.close();

  await writeStructuredLog("orders", { event: "bot_live_stateful", ...payload });
  return payload;
}
