import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { chooseLot } from "./lotLadder.js";
import { planMerge } from "./mergeCoordinator.js";
import { evaluateRisk, type RiskContext, type RiskEvaluation } from "./riskEngine.js";
import { getStrategyPhase } from "./scheduler.js";
import {
  chooseInventoryAdjustment,
  type CompletionDecision,
  type InventoryAdjustmentDecision,
  type UnwindDecision,
} from "./completionEngine.js";
import {
  evaluateEntryBuys,
  type EntryBuyDecision,
  type EntryDecisionTrace,
} from "./entryLadderEngine.js";
import {
  countActiveIndependentFlowCount,
  countRecentSeedFlowCount,
  type XuanMarketState,
} from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";
import {
  classifyResidualSeverity,
  type FlowPressureBudgetState,
  deriveFlowPressureBudgetState,
  pairEntryCap,
  residualSeverityPressure,
  type OverlapRepairArbitration,
} from "./modePolicy.js";
import { pairCostWithBothTaker } from "./sumAvgEngine.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import type { FairValueSnapshot } from "./fairValueEngine.js";
import type { OutcomeSide } from "../../infra/clob/types.js";
import { resolveBundledCompletionSequencePrior } from "../../analytics/xuanExactReference.js";

export interface BotDecision {
  phase: ReturnType<typeof getStrategyPhase>;
  risk: RiskEvaluation;
  entryBuys: EntryBuyDecision[];
  completion?: CompletionDecision | undefined;
  unwind?: UnwindDecision | undefined;
  mergeShares: number;
  trace: BotDecisionTrace;
}

export interface BotDecisionTrace {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
  totalShares: number;
  shareGap: number;
  inventoryBalanced: boolean;
  bestAskUp: number;
  bestAskDown: number;
  pairCap: number;
  pairTakerCost: number;
  selectedMode?: StrategyExecutionMode | undefined;
  fairValue?: FairValueSnapshot | undefined;
  protectedResidualContext: boolean;
  flowRotationRetryAttempted: boolean;
  flowRotationRetrySelected: boolean;
  sameWindowCompletionAndOverlap: boolean;
  sameSideOverlapPrunedForCompletion?: boolean | undefined;
  sameSideOverlapRecoveryPairCost?: number | undefined;
  entry: EntryDecisionTrace;
}

export interface TickInput {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  books: OrderBookState;
  nowTs: number;
  riskContext: RiskContext;
  dryRunOrSmallLive: boolean;
  dailyNegativeEdgeSpentUsdc?: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  allowControlledOverlap?: boolean | undefined;
  protectedResidualShares?: number | undefined;
  protectedResidualSide?: "UP" | "DOWN" | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  completionPatienceMultiplier?: number | undefined;
  openingSeedReleaseBias?: "neutral" | "earlier" | "later" | undefined;
  semanticRoleAlignmentBias?:
    | "neutral"
    | "align_high_low_role"
    | "preserve_raw_side"
    | "cycle_role_arbitration"
    | undefined;
  childOrderMicroTimingBias?: "neutral" | "flow_intent" | undefined;
  completionRoleReleaseOrderBias?: "neutral" | "role_order" | undefined;
  arbitrationCarry?: {
    recommendation: OverlapRepairArbitration;
    preferredSeedSide?: "UP" | "DOWN" | undefined;
    alignmentStreak?: number | undefined;
    flowConfidence?: number | undefined;
  } | undefined;
  matchedInventoryQuality?: number | undefined;
  flowPressureState?: FlowPressureBudgetState | undefined;
}

function overrideRiskForPhase(
  phase: ReturnType<typeof getStrategyPhase>,
  risk: RiskEvaluation,
): RiskEvaluation {
  if (phase === "PREOPEN") {
    return {
      tradable: false,
      allowNewEntries: false,
      completionOnly: false,
      hardCancel: true,
      reasons: ["preopen"],
    };
  }

  if (phase === "CLOSED") {
    return {
      tradable: false,
      allowNewEntries: false,
      completionOnly: false,
      hardCancel: true,
      reasons: ["closed"],
    };
  }

  return risk;
}

export class Xuan5mBot {
  evaluateTick(input: TickInput): BotDecision {
    const { config, state, books, nowTs, riskContext } = input;
    const phase = getStrategyPhase(nowTs, state.market.startTs, state.market.endTs, config);
    const risk = overrideRiskForPhase(phase, evaluateRisk(config, state, riskContext));
    const secsFromOpen = nowTs - state.market.startTs;
    const secsToClose = state.market.endTs - nowTs;
    const totalShares = state.upShares + state.downShares;
    const shareGap = Math.abs(state.upShares - state.downShares);
    const bestAskUp = books.bestAsk("UP");
    const bestAskDown = books.bestAsk("DOWN");
    const pairTakerCost = pairCostWithBothTaker(
      bestAskUp,
      bestAskDown,
      config.cryptoTakerFeeRate,
    );
    const pairCap = pairEntryCap(config);
    const pairDecisionCap =
      config.botMode === "XUAN" && config.allowInitialNegativePairSweep
        ? Math.max(pairCap, config.xuanPairSweepSoftCap)
        : pairCap;
    const overlapBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
    const derivedMatchedInventoryQuality = Number(
      Math.min(1.25, Math.min(state.upShares, state.downShares) / Math.max(overlapBaseLot, 1e-6)).toFixed(6),
    );
    const residualSeverity = classifyResidualSeverity(config, shareGap);
    const residualPressure = residualSeverityPressure(config, shareGap);
    const carryFlowConfidence = Math.max(0, input.arbitrationCarry?.flowConfidence ?? 0);
    const carryMatchedInventoryQuality = Math.max(
      0,
      input.matchedInventoryQuality ?? derivedMatchedInventoryQuality,
    );
    const flowPressureState =
      input.flowPressureState ??
      deriveFlowPressureBudgetState({
        carryFlowConfidence,
        matchedInventoryQuality: carryMatchedInventoryQuality,
        recentSeedFlowCount: input.recentSeedFlowCount,
        activeIndependentFlowCount: input.activeIndependentFlowCount,
        residualSeverityPressure: residualPressure,
      });
    const carryPairGateRelief =
      config.botMode === "XUAN" && config.allowInitialNegativePairSweep
        ? flowPressureState.pairGateRelief
        : 0;
    const effectivePairDecisionCap =
      config.botMode === "XUAN"
        ? Math.min(config.xuanBehaviorCap, pairDecisionCap + carryPairGateRelief)
        : pairDecisionCap;
    const pairGatePressure =
      pairTakerCost <= pairCap
        ? 0
        : Number(
            (
              (pairTakerCost - pairCap) /
              Math.max(
                (config.botMode === "XUAN"
                  ? Math.max(config.xuanBehaviorCap, effectivePairDecisionCap + 0.01)
                  : effectivePairDecisionCap + 0.01) -
                  pairCap,
                1e-6,
              )
            ).toFixed(6),
          );
    const inventoryBalanced = residualSeverity.level === "flat" || residualSeverity.level === "micro";
    const recentSeedFlowCount = input.recentSeedFlowCount ?? countRecentSeedFlowCount(state.fillHistory, nowTs);
    const activeIndependentFlowCount =
      input.activeIndependentFlowCount ?? countActiveIndependentFlowCount(state.fillHistory, nowTs);
    const protectedResidualThreshold = Math.max(config.repairMinQty, config.completionMinQty);
    const controlledOverlapResidualThreshold = Math.max(
      protectedResidualThreshold,
      config.controlledOverlapMinResidualShares,
    );
    const hasPartialResidual = shareGap + 1e-9 >= controlledOverlapResidualThreshold;
    const canOpenControlledOverlap =
      config.allowControlledOverlap &&
      hasPartialResidual &&
      activeIndependentFlowCount < config.maxOpenGroupsPerMarket &&
      (config.allowOverlapInLast30S || secsToClose > config.finalWindowCompletionOnlySec);
    const strictXuanPartialCompletionOnly =
      config.botMode === "XUAN" &&
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      config.xuanCloneIntensity !== "AGGRESSIVE" &&
      config.blockNewPairWhilePartialOpen &&
      !config.allowControlledOverlap &&
      hasPartialResidual &&
      risk.allowNewEntries;
    const effectiveRisk = strictXuanPartialCompletionOnly
      ? {
          ...risk,
          allowNewEntries: false,
          completionOnly: true,
          reasons: [...risk.reasons, "xuan_strict_partial_completion_first"],
        }
      : risk;

    const upTopTwoAskDepth = books.depthAtOrBetter(
      "UP",
      Math.min(1, bestAskUp + Math.max(books.tickSize(), 0.01)),
      "ask",
    );
    const downTopTwoAskDepth = books.depthAtOrBetter(
      "DOWN",
      Math.min(1, bestAskDown + Math.max(books.tickSize(), 0.01)),
      "ask",
    );
    const lot = chooseLot(config, {
      marketSlug: state.market.slug,
      dryRunOrSmallLive: input.dryRunOrSmallLive,
      secsFromOpen,
      imbalance: shareGap / Math.max(totalShares, 1),
      residualSeverityLevel: residualSeverity.level,
      residualSeverityPressure: residualPressure,
      recentSeedFlowCount,
      activeIndependentFlowCount,
      flowPressureState,
      arbitrationCarryAlignmentStreak: input.arbitrationCarry?.alignmentStreak,
      arbitrationCarryFlowConfidence: input.arbitrationCarry?.flowConfidence,
      matchedInventoryQuality: carryMatchedInventoryQuality,
      bookDepthGood:
        Math.min(
          books.depthAtOrBetter("UP", bestAskUp, "ask"),
          books.depthAtOrBetter("DOWN", bestAskDown, "ask"),
        ) >= config.defaultLot,
      bestAskUp,
      bestAskDown,
      topTwoAskDepthMin: Math.min(upTopTwoAskDepth, downTopTwoAskDepth),
      flatPosition: totalShares <= Math.max(config.postMergeFlatDustShares * 2, state.market.minOrderSize * 0.01, 0.05),
      postMergeCount: state.mergeHistory.length,
      totalShares,
      pairCostWithinCap: pairTakerCost <= effectivePairDecisionCap,
      pairCostComfortable: pairTakerCost <= effectivePairDecisionCap - config.minEdgePerShare,
      pairGatePressure,
      inventoryBalanced,
      recentBothSidesFilled: state.fillHistory.some((fill) => fill.outcome === "UP") && state.fillHistory.some((fill) => fill.outcome === "DOWN"),
      marketVolumeHigh: true,
      pnlTodayPositive: riskContext.dailyLossUsdc <= 0,
    });

    const baseEntryContext = {
      secsFromOpen,
      secsToClose,
      lot,
      dailyNegativeEdgeSpentUsdc: input.dailyNegativeEdgeSpentUsdc ?? state.negativeEdgeConsumedUsdc,
      fairValueSnapshot: input.fairValueSnapshot,
      allowControlledOverlap: input.allowControlledOverlap ?? canOpenControlledOverlap,
      protectedResidualShares:
        input.protectedResidualShares ?? (canOpenControlledOverlap ? shareGap : undefined),
      protectedResidualSide:
        input.protectedResidualSide ??
        (canOpenControlledOverlap ? (state.upShares >= state.downShares ? "UP" : "DOWN") : undefined),
      recentSeedFlowCount,
      activeIndependentFlowCount,
      pairGatePressure,
      forcedOverlapRepairArbitration: input.arbitrationCarry?.recommendation,
      preferredOverlapSeedSide: input.arbitrationCarry?.preferredSeedSide,
      carryFlowConfidence,
      matchedInventoryQuality: carryMatchedInventoryQuality,
      flowPressureState,
      openingSeedReleaseBias: input.openingSeedReleaseBias,
      semanticRoleAlignmentBias: input.semanticRoleAlignmentBias,
      childOrderMicroTimingBias: input.childOrderMicroTimingBias,
      completionRoleReleaseOrderBias: input.completionRoleReleaseOrderBias,
      completionPatienceMultiplier: input.completionPatienceMultiplier,
    };

    const initialEntryEvaluation = evaluateEntryBuys(config, state, books, baseEntryContext);

    const inventoryAdjustmentProbe = risk.tradable
      ? chooseInventoryAdjustment(config, state, books, {
          secsToClose,
          usdcBalance: riskContext.usdcBalance,
          nowTs,
          fairValueSnapshot: input.fairValueSnapshot,
          flowPressureState,
          recentSeedFlowCount,
          activeIndependentFlowCount,
          completionPatienceMultiplier: input.completionPatienceMultiplier,
        }) ?? undefined
      : undefined;
    const protectedResidualContext =
      (baseEntryContext.protectedResidualShares ?? 0) + 1e-9 >= controlledOverlapResidualThreshold;
    const shouldAttemptFlowRotationRetry =
      effectiveRisk.allowNewEntries &&
      shouldRetrySameWindowFlowRotation(config, initialEntryEvaluation, inventoryAdjustmentProbe, {
        hasProtectedResidualContext: protectedResidualContext,
      });
    const flowRotationEntryEvaluation =
      shouldAttemptFlowRotationRetry
        ? evaluateEntryBuys(config, state, books, {
            ...baseEntryContext,
            allowControlledOverlap: true,
            protectedResidualShares: input.protectedResidualShares ?? shareGap,
            protectedResidualSide:
              input.protectedResidualSide ?? (state.upShares >= state.downShares ? "UP" : "DOWN"),
            forcedOverlapRepairArbitration: "favor_independent_overlap",
            preferredOverlapSeedSide: inventoryAdjustmentProbe?.completion?.sideToBuy,
            carryFlowConfidence: Math.max(carryFlowConfidence, 0.85),
          })
        : undefined;
    const flowRotationRetrySelected = Boolean(
      flowRotationEntryEvaluation?.decisions.some((entryBuy) => entryBuy.reason === "temporal_single_leg_seed"),
    );
    const entryEvaluation =
      flowRotationRetrySelected && flowRotationEntryEvaluation
        ? flowRotationEntryEvaluation
        : initialEntryEvaluation;
    const janitorEntryAllowed =
      !risk.hardCancel &&
      risk.tradable &&
      config.residualJanitorEnabled &&
      entryEvaluation.trace.skipReason === "micro_residual_janitor_pair";
    const rawEntryBuys =
      effectiveRisk.allowNewEntries || janitorEntryAllowed
        ? entryEvaluation.decisions
        : [];
	    const exactCompletionPrior =
	      config.xuanCloneMode === "PUBLIC_FOOTPRINT" && inventoryAdjustmentProbe?.completion !== undefined
	        ? resolveBundledCompletionSequencePrior(
	            state.market.slug,
	            secsFromOpen,
	            inventoryAdjustmentProbe.completion.sideToBuy,
	          )
	        : undefined;
    const exactCompletionPriority =
      exactCompletionPrior?.scope === "exact" && Math.abs(exactCompletionPrior.anchorSec - secsFromOpen) <= 0.5;
	    const sameSideOverlapArbitration = exactCompletionPriority
	      ? {
	          entryBuys: [] as EntryBuyDecision[],
	          forceCompletion: true,
	          prunedForCompletion: rawEntryBuys.length > 0,
	        }
	      : arbitrateSameSideCompletionOverlap(
	          config,
	          state,
	          books,
	          rawEntryBuys,
	          inventoryAdjustmentProbe,
	        );
    const entryBuys = sameSideOverlapArbitration.entryBuys;
    const sameWindowCompletionAndOverlap =
      effectiveRisk.allowNewEntries &&
      (sameSideOverlapArbitration.forceCompletion ||
        shouldAllowSameWindowCompletionAndOverlap(config, state, entryEvaluation, entryBuys, inventoryAdjustmentProbe));
    const inventoryAdjustment =
      !effectiveRisk.allowNewEntries || sameWindowCompletionAndOverlap
        ? inventoryAdjustmentProbe
        : undefined;
    const mergePlan = planMerge(config, projectMergeState(state, entryBuys, inventoryAdjustment?.completion));

    return {
      phase,
      risk: effectiveRisk,
      entryBuys,
      completion: inventoryAdjustment?.completion,
      unwind: inventoryAdjustment?.unwind,
      mergeShares: mergePlan.shouldMerge ? mergePlan.mergeable : 0,
      trace: {
        secsFromOpen,
        secsToClose,
        lot,
        totalShares,
        shareGap,
        inventoryBalanced,
        bestAskUp,
        bestAskDown,
        pairCap,
        pairTakerCost,
        ...(input.fairValueSnapshot ? { fairValue: input.fairValueSnapshot } : {}),
        protectedResidualContext,
        flowRotationRetryAttempted: shouldAttemptFlowRotationRetry,
        flowRotationRetrySelected,
        sameWindowCompletionAndOverlap,
        ...(sameSideOverlapArbitration.prunedForCompletion
          ? {
              sameSideOverlapPrunedForCompletion: true,
              ...(sameSideOverlapArbitration.recoveryPairCost !== undefined
                ? { sameSideOverlapRecoveryPairCost: sameSideOverlapArbitration.recoveryPairCost }
                : {}),
            }
          : {}),
        selectedMode:
          entryBuys[0]?.mode ??
          inventoryAdjustment?.completion?.mode ??
          inventoryAdjustment?.unwind?.mode ??
          entryEvaluation.trace.selectedMode,
        entry: effectiveRisk.allowNewEntries
          ? sameSideOverlapArbitration.prunedForCompletion
            ? {
                ...entryEvaluation.trace,
                skipReason: "same_side_overlap_pruned_for_completion",
              }
            : entryEvaluation.trace
          : {
              ...entryEvaluation.trace,
              gatedByRisk: true,
              skipReason: entryEvaluation.trace.skipReason ?? "risk_blocked",
            },
      },
    };
  }
}

interface SameSideOverlapArbitrationResult {
  entryBuys: EntryBuyDecision[];
  forceCompletion: boolean;
  prunedForCompletion: boolean;
  recoveryPairCost?: number | undefined;
}

function arbitrateSameSideCompletionOverlap(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  entryBuys: EntryBuyDecision[],
  inventoryAdjustment: InventoryAdjustmentDecision | undefined,
): SameSideOverlapArbitrationResult {
  if (config.botMode !== "XUAN" || config.xuanCloneMode !== "PUBLIC_FOOTPRINT" || !inventoryAdjustment?.completion) {
    return { entryBuys, forceCompletion: false, prunedForCompletion: false };
  }

  const completion = inventoryAdjustment.completion;
  const sameSideTemporalBuys = entryBuys.filter(
    (entryBuy) =>
      entryBuy.reason === "temporal_single_leg_seed" &&
      entryBuy.side === completion.sideToBuy,
  );
  if (sameSideTemporalBuys.length === 0) {
    return { entryBuys, forceCompletion: false, prunedForCompletion: false };
  }
  if (
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE" &&
    completion.missingShares <= state.market.minOrderSize + config.maxCompletionOvershootShares + 1e-6
  ) {
    return { entryBuys, forceCompletion: false, prunedForCompletion: false };
  }

  const sideShares = completion.sideToBuy === "UP" ? state.upShares : state.downShares;
  const oppositeSide: OutcomeSide = completion.sideToBuy === "UP" ? "DOWN" : "UP";
  const oppositeShares = oppositeSide === "UP" ? state.upShares : state.downShares;
  if (oppositeShares <= sideShares + config.maxCompletionOvershootShares + 1e-6) {
    return { entryBuys, forceCompletion: false, prunedForCompletion: false };
  }

  const sameSideQty = sameSideTemporalBuys.reduce((sum, entryBuy) => sum + entryBuy.size, 0);
  const projectedSameSideShares = sideShares + completion.missingShares + sameSideQty;
  const newSameSideResidualQty = Math.max(0, projectedSameSideShares - oppositeShares);
  const largeResidualThreshold = Math.max(
    config.completionMinQty,
    config.controlledOverlapSeedMaxQty * 0.5,
    (config.liveSmallLotLadder[0] ?? config.defaultLot) * 0.35,
  );
  if (newSameSideResidualQty < largeResidualThreshold - 1e-6) {
    return { entryBuys, forceCompletion: false, prunedForCompletion: false };
  }

  const recoveryPairCost = sameSideOverlapRecoveryPairCost({
    config,
    books,
    sameSide: completion.sideToBuy,
    oppositeSide,
    sameSideBuys: sameSideTemporalBuys,
    residualQty: newSameSideResidualQty,
  });
  const recoverablePairCap = Math.min(
    config.highLowAvgImprovingMaxEffectivePair,
    config.xuanBasketCampaignFlowShapingEffectiveCap,
  );
  if (recoveryPairCost !== undefined && recoveryPairCost <= recoverablePairCap + 1e-9) {
    return { entryBuys, forceCompletion: false, prunedForCompletion: false, recoveryPairCost };
  }

  const prunedEntryBuys = entryBuys.filter((entryBuy) => !sameSideTemporalBuys.includes(entryBuy));
  return {
    entryBuys: prunedEntryBuys,
    forceCompletion: true,
    prunedForCompletion: true,
    recoveryPairCost,
  };
}

function sameSideOverlapRecoveryPairCost(args: {
  config: XuanStrategyConfig;
  books: OrderBookState;
  sameSide: OutcomeSide;
  oppositeSide: OutcomeSide;
  sameSideBuys: EntryBuyDecision[];
  residualQty: number;
}): number | undefined {
  const quoteQty = Math.min(
    args.residualQty,
    args.sameSideBuys.reduce((sum, entryBuy) => sum + entryBuy.size, 0),
  );
  if (quoteQty <= 1e-6) {
    return undefined;
  }
  const oppositeQuote = args.books.quoteForSize(args.oppositeSide, "ask", quoteQty);
  if (!oppositeQuote.fullyFilled) {
    return undefined;
  }
  const sameSideAveragePrice =
    args.sameSideBuys.reduce((sum, entryBuy) => sum + entryBuy.expectedAveragePrice * entryBuy.size, 0) /
    Math.max(1e-6, args.sameSideBuys.reduce((sum, entryBuy) => sum + entryBuy.size, 0));
  const upPrice = args.sameSide === "UP" ? sameSideAveragePrice : oppositeQuote.averagePrice;
  const downPrice = args.sameSide === "DOWN" ? sameSideAveragePrice : oppositeQuote.averagePrice;
  return Number(pairCostWithBothTaker(upPrice, downPrice, args.config.cryptoTakerFeeRate).toFixed(6));
}

function shouldAllowSameWindowCompletionAndOverlap(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  entryEvaluation: { trace: EntryDecisionTrace },
  entryBuys: EntryBuyDecision[],
  inventoryAdjustment: InventoryAdjustmentDecision | undefined,
): boolean {
  if (config.botMode !== "XUAN" || !config.allowControlledOverlap || !inventoryAdjustment?.completion) {
    return false;
  }
  if (entryBuys.length !== 1 || entryBuys[0]?.reason !== "temporal_single_leg_seed") {
    return false;
  }
  if (entryEvaluation.trace.overlapRepairOutcome !== "overlap_seed") {
    return false;
  }

  const shareGap = Math.abs(state.upShares - state.downShares);
  if (shareGap <= Math.max(config.repairMinQty, config.completionMinQty)) {
    return false;
  }

  const completion = inventoryAdjustment.completion;
  const rotatesResidualIntoNewFlow =
    entryBuys[0].side === completion.sideToBuy &&
    entryBuys[0].size <= completion.oldGap + config.maxCompletionOvershootShares + 1e-6;
  if (completion.residualSeverityLevel === "aggressive" && !rotatesResidualIntoNewFlow) {
    return false;
  }
  if (completion.newGap > completion.oldGap + config.maxCompletionOvershootShares) {
    return false;
  }
  return true;
}

function shouldRetrySameWindowFlowRotation(
  config: XuanStrategyConfig,
  entryEvaluation: { decisions: EntryBuyDecision[]; trace: EntryDecisionTrace },
  inventoryAdjustment: InventoryAdjustmentDecision | undefined,
  context: { hasProtectedResidualContext: boolean },
): boolean {
  if (config.botMode !== "XUAN" || !config.allowControlledOverlap || !inventoryAdjustment?.completion) {
    return false;
  }
  if (!context.hasProtectedResidualContext) {
    return false;
  }
  if (entryEvaluation.decisions.some((entryBuy) => entryBuy.reason === "temporal_single_leg_seed")) {
    return false;
  }
  if (
    entryEvaluation.trace.overlapRepairOutcome === "overlap_seed" ||
    entryEvaluation.trace.overlapRepairOutcome === "pair_reentry"
  ) {
    return false;
  }

  const completion = inventoryAdjustment.completion;
  if (completion.newGap > completion.oldGap + config.maxCompletionOvershootShares) {
    return false;
  }
  return completion.residualSeverityLevel !== "flat";
}

function projectMergeState(
  state: XuanMarketState,
  entryBuys: EntryBuyDecision[],
  completion: CompletionDecision | undefined,
): XuanMarketState {
  let projectedState = {
    ...state,
    upShares: state.upShares,
    downShares: state.downShares,
  };

  for (const entryBuy of entryBuys) {
    if (entryBuy.side === "UP") {
      projectedState = {
        ...projectedState,
        upShares: projectedState.upShares + entryBuy.size,
      };
    } else {
      projectedState = {
        ...projectedState,
        downShares: projectedState.downShares + entryBuy.size,
      };
    }
  }

  if (!completion) {
    return projectedState;
  }

  return {
    ...projectedState,
    upShares: projectedState.upShares + (completion.sideToBuy === "UP" ? completion.missingShares : 0),
    downShares: projectedState.downShares + (completion.sideToBuy === "DOWN" ? completion.missingShares : 0),
  };
}
