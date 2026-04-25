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
      risk.allowNewEntries &&
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
    const entryBuys =
      risk.allowNewEntries || janitorEntryAllowed
        ? entryEvaluation.decisions
        : [];
    const sameWindowCompletionAndOverlap =
      risk.allowNewEntries &&
      shouldAllowSameWindowCompletionAndOverlap(config, state, entryEvaluation, entryBuys, inventoryAdjustmentProbe);
    const inventoryAdjustment =
      !risk.allowNewEntries || sameWindowCompletionAndOverlap
        ? inventoryAdjustmentProbe
        : undefined;
    const mergePlan = planMerge(config, projectMergeState(state, entryBuys, inventoryAdjustment?.completion));

    return {
      phase,
      risk,
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
        selectedMode:
          entryBuys[0]?.mode ??
          inventoryAdjustment?.completion?.mode ??
          inventoryAdjustment?.unwind?.mode ??
          entryEvaluation.trace.selectedMode,
        entry: risk.allowNewEntries
          ? entryEvaluation.trace
          : {
              ...entryEvaluation.trace,
              gatedByRisk: true,
              skipReason: entryEvaluation.trace.skipReason ?? "risk_blocked",
            },
      },
    };
  }
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
