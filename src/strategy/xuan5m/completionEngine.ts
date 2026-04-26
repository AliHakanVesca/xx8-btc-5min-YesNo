import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { resolveBundledCompletionSequencePrior } from "../../analytics/xuanExactReference.js";
import {
  absoluteShareGap,
  applyFill,
  averageEffectiveCost,
  matchedEffectivePairCost,
  mergeableShares,
  oldestResidualLotTimestamp,
  projectedShareGapAfterBuy,
} from "./inventoryState.js";
import {
  countActiveIndependentFlowCount,
  countRecentSeedFlowCount,
  type XuanMarketState,
} from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";
import {
  classifyResidualSeverity,
  classifyCompletionReleaseRole,
  completionQualitySkipReason,
  type CompletionReleaseRole,
  completionAllowance,
  highSideCompletionQualitySkipReason,
  type FlowPressureBudgetState,
  type MarketBasketClipType,
  deriveFlowPressureBudgetState,
  resolvePartialCompletionPhase,
  resolveResidualBehaviorState,
  resolveCampaignCompletionSizing,
  resolveResidualCompletionDelayProfile,
} from "./modePolicy.js";
import { completionCost } from "./sumAvgEngine.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import { buildTakerBuyOrder, buildTakerSellOrder } from "./marketOrderBuilder.js";
import {
  fairValueGate,
  isCloneRepairFairValueFallbackSnapshot,
  type FairValueSnapshot,
} from "./fairValueEngine.js";

export interface CompletionDecision {
  sideToBuy: OutcomeSide;
  missingShares: number;
  residualAfter: number;
  mode: StrategyExecutionMode;
  order: MarketOrderArgs;
  costWithFees: number;
  capMode: "strict" | "soft" | "hard" | "emergency";
  negativeEdgeUsdc: number;
  oldGap: number;
  newGap: number;
  oppositeAveragePrice: number;
  missingSideAveragePrice: number;
  highLowMismatch: boolean;
  residualSeverityLevel?: "flat" | "micro" | "small" | "medium" | "aggressive";
  residualSeverityPressure?: number;
  residualFlowDensity?: number;
  completionPatienceBias?: number;
  completionReleaseRole?: CompletionReleaseRole;
  completionCalibrationPatienceMultiplier?: number;
  completionRolePatienceMultiplier?: number;
  completionEffectivePatienceMultiplier?: number;
  completionWaitUntilSec?: number;
  marketBasketContinuationDuty?: boolean;
  marketBasketProjectedEffectivePair?: number;
  marketBasketProjectedMatchedQty?: number;
  marketBasketDebtBeforeUSDC?: number;
  marketBasketDebtAfterUSDC?: number;
  marketBasketDebtDeltaUSDC?: number;
  marketBasketPhaseOverride?: boolean;
  campaignMode?: "UNBALANCED_CAMPAIGN_RESIDUAL" | "RESIDUAL_COMPLETION_ACTIVE";
  campaignClipType?: MarketBasketClipType;
  campaignMinClipQty?: number;
  campaignDefaultClipQty?: number;
  microRepairMaxQty?: number;
  residualCompletionFairValueFallback?: boolean;
  residualCompletionFallbackReason?: string;
  overlapRepairArbitration?: "no_overlap_lock" | "standard_pair_reentry" | "favor_independent_overlap" | "favor_residual_repair";
  arbitrationOutcome?: "completion" | "hold";
}

export interface UnwindDecision {
  sideToSell: OutcomeSide;
  unwindShares: number;
  residualAfter: number;
  expectedAveragePrice: number;
  mode: StrategyExecutionMode;
  order: MarketOrderArgs;
  residualSeverityLevel?: "flat" | "micro" | "small" | "medium" | "aggressive";
  residualSeverityPressure?: number;
  residualFlowDensity?: number;
  overlapRepairArbitration?: "no_overlap_lock" | "standard_pair_reentry" | "favor_independent_overlap" | "favor_residual_repair";
  arbitrationOutcome?: "unwind";
}

export interface InventoryAdjustmentDecision {
  completion?: CompletionDecision | undefined;
  unwind?: UnwindDecision | undefined;
}

export interface CompletionContext {
  secsToClose: number;
  usdcBalance?: number;
  nowTs?: number | undefined;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  flowPressureState?: FlowPressureBudgetState | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  completionPatienceMultiplier?: number | undefined;
}

export function chooseInventoryAdjustment(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: CompletionContext,
): InventoryAdjustmentDecision | null {
  if (state.upShares === state.downShares) {
    return null;
  }

  const sideToBuy: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
  const leadingSide: OutcomeSide = sideToBuy === "DOWN" ? "UP" : "DOWN";
  const missingShares = Math.abs(state.upShares - state.downShares);
  const existingAverage = averageEffectiveCost(state, leadingSide, config.cryptoTakerFeeRate);

  const completion = chooseCompletion(config, state, books, sideToBuy, existingAverage, missingShares, ctx);
  if (completion) {
    return { completion };
  }

  const unwind = chooseResidualUnwind(config, state, books, ctx, leadingSide, missingShares);
  if (unwind) {
    return { unwind };
  }

  return null;
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

function chooseCompletion(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  sideToBuy: OutcomeSide,
  existingAverage: number,
  missingShares: number,
  ctx: CompletionContext,
): CompletionDecision | null {
  if (!config.allowResidualCompletion) {
    return null;
  }

  const imbalanceShares = Math.abs(state.upShares - state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(state.upShares + state.downShares, 1);
  const lowBalanceInventoryMode =
    ctx.usdcBalance !== undefined && ctx.usdcBalance < config.minUsdcBalanceForNewEntry;
  const completionBlockedByBalance =
    ctx.usdcBalance !== undefined && ctx.usdcBalance < config.minUsdcBalanceForCompletion;
  if (completionBlockedByBalance) {
    return null;
  }

  const oldGap = absoluteShareGap(state);
  const leadingSide: OutcomeSide = sideToBuy === "UP" ? "DOWN" : "UP";
  const recentSeedFlowCount =
    ctx.recentSeedFlowCount ??
    (ctx.nowTs !== undefined ? countRecentSeedFlowCount(state.fillHistory, ctx.nowTs) : 0);
  const activeIndependentFlowCount =
    ctx.activeIndependentFlowCount ??
    (ctx.nowTs !== undefined ? countActiveIndependentFlowCount(state.fillHistory, ctx.nowTs) : 0);
  const residualBehaviorState = resolveResidualBehaviorState({
    config,
    residualShares: missingShares,
    shareGap: missingShares,
    recentSeedFlowCount,
    activeIndependentFlowCount,
  });
  const residualSeverity = residualBehaviorState.severity;
  const unbalancedCampaignResidual = isUnbalancedCampaignResidual(config, state, missingShares);
  const overlapRepairArbitration = residualBehaviorState.overlapRepairArbitration;
  const flowPressureState =
    ctx.flowPressureState ??
    deriveFlowPressureBudgetState({
      recentSeedFlowCount,
      activeIndependentFlowCount,
      residualSeverityPressure: residualBehaviorState.severityPressure,
    });
  const residualTimestamp = oldestResidualLotTimestamp(state, leadingSide);
  const partialAgeSec =
    ctx.nowTs !== undefined && residualTimestamp !== undefined
      ? Math.max(0, ctx.nowTs - residualTimestamp)
      : config.partialSoftWindowSec;
  const stagedResidualAgeSec =
    ctx.nowTs !== undefined ? borderlineStagedResidualAgeSec(state, leadingSide, ctx.nowTs) : undefined;
  if (
    config.borderlinePairStagedEntryEnabled &&
    stagedResidualAgeSec !== undefined &&
    stagedResidualAgeSec < config.borderlinePairReevaluateAfterSec &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec
  ) {
    return null;
  }
  const phase = resolvePartialCompletionPhase({
    config,
    partialAgeSec,
    secsToClose: ctx.secsToClose,
    postMergeCompletionOnly:
      config.postMergeOnlyCompletion &&
      (state.reentryDisabled ||
        (state.postMergeCompletionOnlyUntil !== undefined &&
          ctx.nowTs !== undefined &&
          ctx.nowTs < state.postMergeCompletionOnlyUntil)),
  });
  const secsFromOpen =
    ctx.nowTs !== undefined
      ? Math.max(0, ctx.nowTs - state.market.startTs)
      : Math.max(0, state.market.endTs - ctx.secsToClose - state.market.startTs);
  const completionQtyPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledCompletionSequencePrior(state.market.slug, secsFromOpen, sideToBuy)
      : undefined;
  const exactCompletionQtyPrior = completionQtyPrior?.scope === "exact" ? completionQtyPrior : undefined;
  if (
    shouldHoldHighLowOvershootCompletionResidual({
      config,
      state,
      leadingSide,
      missingShares,
      secsFromOpen,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
    })
  ) {
    return null;
  }
  if (
    shouldHoldLateSmallCompletionResidual({
      config,
      missingShares,
      secsFromOpen,
      secsToClose: ctx.secsToClose,
      residualSeverityLevel: residualSeverity.level,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
    })
  ) {
    return null;
  }
  const highLowOvershootCandidates = buildHighLowOvershootCandidateSizes({
    config,
    sideToBuy,
    books,
    existingAverage,
    missingShares,
    exactPriorActive: Boolean(exactCompletionQtyPrior),
  });
  const basketContinuationCandidateSizes = buildMarketBasketContinuationCandidateSizes({
    config,
    state,
    sideToBuy,
    missingShares,
    missingSideBestAsk: books.bestAsk(sideToBuy),
    exactPriorActive: Boolean(exactCompletionQtyPrior),
  });
  const campaignCompletionSizing =
    unbalancedCampaignResidual && !exactCompletionQtyPrior
      ? resolveCampaignCompletionSizing(config, missingShares)
      : undefined;
  const phaseMaxQty =
    exactCompletionQtyPrior && Number.isFinite(phase.maxQty)
      ? Math.max(phase.maxQty, exactCompletionQtyPrior.qty)
      : Number.isFinite(phase.maxQty) && highLowOvershootCandidates.length > 0
        ? Math.max(phase.maxQty, ...highLowOvershootCandidates)
        : phase.maxQty;
  const campaignPhaseMaxQty =
    unbalancedCampaignResidual &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec &&
    !exactCompletionQtyPrior
      ? Math.max(
          Number.isFinite(phaseMaxQty) ? phaseMaxQty : missingShares,
          campaignCompletionSizing?.targetQty ?? missingShares,
        )
      : phaseMaxQty;
  const campaignMinCandidateQty =
    campaignCompletionSizing?.clipType === "CAMPAIGN_COMPLETION"
      ? Math.min(missingShares, Math.max(config.microRepairMaxQty, campaignCompletionSizing.minCampaignClipQty))
      : 0;
  const candidateSizes = Array.from(
    new Set(
      buildCandidateSizes(
        config.partialCompletionFractions,
        missingShares,
        config.completionMinQty,
        [
          ...(exactCompletionQtyPrior ? [exactCompletionQtyPrior.qty] : []),
          ...highLowOvershootCandidates,
          ...basketContinuationCandidateSizes,
          ...(campaignCompletionSizing ? [campaignCompletionSizing.targetQty] : []),
          ...(Number.isFinite(campaignPhaseMaxQty) ? [campaignPhaseMaxQty] : []),
        ],
      )
        .map((size) => normalizeSize(size))
        .filter((size) => size >= config.completionMinQty)
        .filter((size) => campaignMinCandidateQty <= 0 || size + 1e-9 >= campaignMinCandidateQty),
    ),
  ).sort((left, right) => right - left);
  const prioritizedExactQty = exactCompletionQtyPrior ? normalizeSize(exactCompletionQtyPrior.qty) : undefined;
  const guidedMinCompletionSize = resolveGuidedMinCompletionSize({
    config,
    missingShares,
    secsToClose: ctx.secsToClose,
    recentSeedFlowCount,
    activeIndependentFlowCount,
    flowPressureState,
    exactPriorActive: Boolean(exactCompletionQtyPrior),
  });
  const orderedCandidateSizes =
    prioritizedExactQty !== undefined && candidateSizes.includes(prioritizedExactQty)
      ? [prioritizedExactQty, ...candidateSizes.filter((size) => Math.abs(size - prioritizedExactQty) > 1e-6)]
      : candidateSizes;
  let bestCompletion: CompletionDecision | undefined;
  let bestCompletionScore = Number.POSITIVE_INFINITY;

  for (const candidateSize of orderedCandidateSizes) {
    if (
      guidedMinCompletionSize > 0 &&
      candidateSize + 1e-6 < guidedMinCompletionSize &&
      (prioritizedExactQty === undefined || Math.abs(candidateSize - prioritizedExactQty) > 1e-6)
    ) {
      continue;
    }
    const execution = books.quoteForSize(sideToBuy, "ask", candidateSize);
    if (!execution.fullyFilled) {
      continue;
    }

    const projectedGap = projectedShareGapAfterBuy(state, sideToBuy, candidateSize);
    if (
      (config.forbidBuyThatIncreasesImbalance || config.partialCompletionRequiresImbalanceReduction) &&
      projectedGap > oldGap + config.maxCompletionOvershootShares
    ) {
      continue;
    }

    const costWithFees = completionCost(existingAverage, execution.averagePrice, config.cryptoTakerFeeRate);
    const marketBasketProjection = projectMarketBasketCompletion({
      config,
      state,
      sideToBuy,
      candidateSize,
      missingSidePrice: execution.averagePrice,
      nowTs: ctx.nowTs,
    });
    const allowance = completionAllowance(config, state, {
      costWithFees,
      candidateSize,
      oppositeAveragePrice: existingAverage,
      missingSidePrice: execution.averagePrice,
      partialAgeSec,
    });
    const temporalCostReducingPhaseOverride =
      config.botMode === "XUAN" &&
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      partialAgeSec >= config.xuanTemporalCompletionMinAgeSec &&
      costWithFees <= config.xuanTemporalCompletionEarlyMaxEffectivePair + 1e-9 &&
      candidateSize <= config.marketBasketContinuationMaxQty + 1e-9;
    if (
      candidateSize > campaignPhaseMaxQty &&
      !marketBasketProjection?.phaseMaxOverrideAllowed &&
      !temporalCostReducingPhaseOverride
    ) {
      continue;
    }
    const highLowPhaseCapOverride = Boolean(allowance.highLowMismatch && allowance.allowed);
    const marketBasketPhaseCapOverride = Boolean(marketBasketProjection?.phaseMaxOverrideAllowed);
    const currentMatchedEffectivePair =
      mergeableShares(state) > 1e-6
        ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate)
        : Number.POSITIVE_INFINITY;
    const campaignResidualFallback = residualCompletionFairValueFallback({
      config,
      state,
      unbalancedCampaignResidual,
      repairCost: costWithFees,
      currentMatchedEffectivePair,
      executableSize: candidateSize,
      oldGap,
      newGap: projectedGap,
    });
    const temporalOrphanFallback = temporalSingleLegOrphanCompletionFallback({
      config,
      state,
      leadingSide,
      partialAgeSec,
      secsToClose: ctx.secsToClose,
      repairCost: costWithFees,
      executableSize: candidateSize,
      oldGap,
      newGap: projectedGap,
      negativeEdgeUsdc: allowance.negativeEdgeUsdc,
    });
    const earlyTemporalCompletionWait =
      config.botMode === "XUAN" &&
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      !exactCompletionQtyPrior &&
      partialAgeSec < config.xuanTemporalCompletionMinAgeSec &&
      ctx.secsToClose > config.finalWindowCompletionOnlySec &&
      costWithFees > config.xuanTemporalCompletionEarlyMaxEffectivePair + 1e-9 &&
      !marketBasketProjection?.phaseMaxOverrideAllowed &&
      !temporalOrphanFallback.allowed;
    if (earlyTemporalCompletionWait) {
      continue;
    }
    const campaignPhaseCapOverride = campaignResidualFallback.allowed || temporalOrphanFallback.allowed;
    if (
      costWithFees > phase.cap &&
      !highLowPhaseCapOverride &&
      !marketBasketPhaseCapOverride &&
      !campaignPhaseCapOverride
    ) {
      continue;
    }
    const ultraFastCloneFairValueFallback =
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      partialAgeSec <= config.temporalRepairUltraFastWindowSec &&
      isCloneRepairFairValueFallbackSnapshot(ctx.fairValueSnapshot) &&
      costWithFees <= config.temporalRepairUltraFastMissingFairValueCap &&
      allowance.allowed;
    const fairValueRequired =
      ultraFastCloneFairValueFallback || campaignResidualFallback.allowed || temporalOrphanFallback.allowed
        ? false
        : allowance.highLowMismatch && allowance.allowed && !allowance.requiresFairValue
          ? false
          : !(
              config.allowStrictResidualCompletionWithoutFairValue &&
              costWithFees <= config.strictResidualCompletionCap
            ) || Boolean(allowance.requiresFairValue);
    const fairValueDecision = ultraFastCloneFairValueFallback || campaignResidualFallback.allowed || temporalOrphanFallback.allowed
      ? { allowed: true as const }
      : fairValueGate({
          config,
          snapshot: ctx.fairValueSnapshot,
          side: sideToBuy,
          sidePrice: execution.averagePrice,
          mode: allowance.capMode === "emergency" ? "emergency" : "completion",
          secsToClose: ctx.secsToClose,
          effectiveCost: costWithFees,
          required: fairValueRequired,
        });
    const strictHighSideFairValueDecision =
      execution.averagePrice >= config.highSidePriceThreshold
        ? fairValueGate({
            config,
            snapshot: ctx.fairValueSnapshot,
            side: sideToBuy,
            sidePrice: execution.averagePrice,
            mode: allowance.capMode === "emergency" ? "emergency" : "completion",
            secsToClose: ctx.secsToClose,
            effectiveCost: costWithFees,
            required: true,
          })
        : { allowed: true as const };
    const highSideQualitySkipReason = highSideCompletionQualitySkipReason(config, state, {
      costWithFees,
      candidateSize,
      missingSidePrice: execution.averagePrice,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
      fairValueAllowed: strictHighSideFairValueDecision.allowed,
    });
    const qualitySkipReason = completionQualitySkipReason(config, state, {
      costWithFees,
      candidateSize,
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
        oppositeAveragePrice: existingAverage,
        missingSidePrice: execution.averagePrice,
        partialAgeSec,
      });
    const completionReleaseRole = classifyCompletionReleaseRole({
      config,
      oppositeAveragePrice: existingAverage,
      missingSidePrice: execution.averagePrice,
    });
    const completionDelayProfile = resolveResidualCompletionDelayProfile({
      config,
      residualShares: missingShares,
      partialAgeSec,
      secsToClose: ctx.secsToClose,
      oppositeAveragePrice: existingAverage,
      missingSidePrice: execution.averagePrice,
      exactPriorActive: Boolean(exactCompletionQtyPrior),
      exceptionalMode:
        Boolean(allowance.highLowMismatch) ||
        cheapLateCompletionChase ||
        campaignResidualFallback.allowed ||
        temporalOrphanFallback.allowed,
      recentSeedFlowCount,
      activeIndependentFlowCount,
      ...(ctx.completionPatienceMultiplier !== undefined
        ? { completionPatienceMultiplier: ctx.completionPatienceMultiplier }
        : {}),
    });
    if (!allowance.allowed && !temporalOrphanFallback.allowed) {
      continue;
    }
    if (highSideQualitySkipReason && !temporalOrphanFallback.allowed) {
      continue;
    }
    if (qualitySkipReason && !temporalOrphanFallback.allowed) {
      continue;
    }
    if (
      shouldDeferNibbleCompletionUnderFlowPressure({
        config,
        candidateSize,
        missingShares,
        residualAfter: projectedGap,
        secsToClose: ctx.secsToClose,
        exactPriorActive: Boolean(exactCompletionQtyPrior),
        exceptionalMode:
          Boolean(allowance.highLowMismatch) ||
          cheapLateCompletionChase ||
          campaignResidualFallback.allowed ||
          temporalOrphanFallback.allowed,
        recentSeedFlowCount,
        activeIndependentFlowCount,
        flowPressureState,
      })
    ) {
      continue;
    }
    if (
      !fairValueDecision.allowed &&
      !campaignResidualFallback.allowed &&
      !temporalOrphanFallback.allowed &&
      (phase.requiresFairValue || phase.mode === "POST_MERGE_RESIDUAL_COMPLETION")
    ) {
      continue;
    }
    if (
      !fairValueDecision.allowed &&
      !campaignResidualFallback.allowed &&
      !temporalOrphanFallback.allowed &&
      phase.mode !== "POST_MERGE_RESIDUAL_COMPLETION"
    ) {
      continue;
    }
    if (completionDelayProfile.shouldDelay && !campaignResidualFallback.allowed && !temporalOrphanFallback.allowed) {
      continue;
    }

    if (
      ctx.secsToClose <= config.partialNoChaseLastSec &&
      !config.allowAnyNewBuyInLast10S &&
      allowance.capMode !== "strict"
    ) {
      continue;
    }

    if (lowBalanceInventoryMode) {
      if (candidateSize > config.lowBalanceCompletionMaxQty) {
        continue;
      }
      if (allowance.negativeEdgeUsdc > config.lowBalanceCompletionBudgetUsdc) {
        continue;
      }
    }

    if (ctx.secsToClose <= config.finalWindowCompletionOnlySec) {
      if (allowance.capMode === "soft" && !config.allowSoftCompletionInLast30S) {
        continue;
      }
      if (allowance.capMode === "emergency") {
        if (!config.allowHardCompletionInLast30S) {
          continue;
        }
        if (candidateSize > config.finalHardCompletionMaxQty) {
          continue;
        }
        if (allowance.negativeEdgeUsdc > config.finalHardCompletionMaxNegativeEdgeUsdc) {
          continue;
        }
        if (config.finalHardCompletionRequiresHardImbalance && imbalanceRatio < config.hardImbalanceRatio) {
          continue;
        }
      }
    }

    if (ctx.secsToClose <= config.finalWindowNoChaseSec && allowance.capMode === "emergency") {
      if (!config.allowHardCompletionInLast10S) {
        continue;
      }
    }

    const selectedMode: StrategyExecutionMode =
      allowance.highLowMismatch && allowance.allowed
        ? "HIGH_LOW_COMPLETION_CHASE"
        : cheapLateCompletionChase
          ? "CHEAP_LATE_COMPLETION_CHASE"
          : phase.mode;

    const decision: CompletionDecision = {
      sideToBuy,
      missingShares: candidateSize,
      residualAfter: normalizeSize(Math.max(0, missingShares - candidateSize)),
      mode: selectedMode,
      costWithFees,
      capMode: temporalOrphanFallback.allowed && !allowance.allowed ? "soft" : allowance.capMode,
      negativeEdgeUsdc: allowance.negativeEdgeUsdc,
      oldGap,
      newGap: projectedGap,
      oppositeAveragePrice: existingAverage,
      missingSideAveragePrice: execution.averagePrice,
      highLowMismatch: allowance.highLowMismatch ?? false,
      residualSeverityLevel: residualSeverity.level,
      residualSeverityPressure: residualBehaviorState.severityPressure,
      residualFlowDensity: residualBehaviorState.flowDensity,
      completionPatienceBias: residualBehaviorState.completionPatienceBias,
      completionReleaseRole,
      completionCalibrationPatienceMultiplier: completionDelayProfile.calibrationPatienceMultiplier,
      completionRolePatienceMultiplier: completionDelayProfile.rolePatienceMultiplier,
      completionEffectivePatienceMultiplier: completionDelayProfile.effectivePatienceMultiplier,
      completionWaitUntilSec: completionDelayProfile.waitUntilSec,
      ...(marketBasketProjection
        ? {
            marketBasketContinuationDuty: marketBasketProjection.continuationDuty,
            marketBasketProjectedEffectivePair: marketBasketProjection.projectedEffectivePair,
            marketBasketProjectedMatchedQty: marketBasketProjection.projectedMatchedQty,
            marketBasketDebtBeforeUSDC: marketBasketProjection.debtBeforeUSDC,
            marketBasketDebtAfterUSDC: marketBasketProjection.debtAfterUSDC,
            marketBasketDebtDeltaUSDC: marketBasketProjection.debtDeltaUSDC,
            marketBasketPhaseOverride: marketBasketProjection.phaseMaxOverrideAllowed,
          }
        : {}),
      ...(unbalancedCampaignResidual
        ? {
            campaignMode: campaignResidualFallback.allowed
              ? "RESIDUAL_COMPLETION_ACTIVE"
              : "UNBALANCED_CAMPAIGN_RESIDUAL",
            ...(campaignCompletionSizing
              ? {
                  campaignClipType: campaignCompletionSizing.clipType,
                  campaignMinClipQty: campaignCompletionSizing.minCampaignClipQty,
                  campaignDefaultClipQty: campaignCompletionSizing.defaultCampaignClipQty,
                  microRepairMaxQty: config.microRepairMaxQty,
                }
              : {}),
          }
        : {}),
      ...(campaignResidualFallback.allowed
        ? {
            residualCompletionFairValueFallback: true,
            ...(campaignResidualFallback.reason
              ? { residualCompletionFallbackReason: campaignResidualFallback.reason }
              : {}),
          }
        : {}),
      ...(temporalOrphanFallback.allowed
        ? {
            campaignMode: "RESIDUAL_COMPLETION_ACTIVE",
            residualCompletionFairValueFallback: true,
            ...(temporalOrphanFallback.reason
              ? { residualCompletionFallbackReason: temporalOrphanFallback.reason }
              : {}),
          }
        : {}),
      overlapRepairArbitration,
      arbitrationOutcome: "completion",
      order: buildTakerBuyOrder({
        state,
        side: sideToBuy,
        shareTarget: candidateSize,
        limitPrice: execution.limitPrice,
        orderType: "FAK",
      }),
    };
    const score = completionCandidateScore(config, {
      costWithFees,
      missingSidePrice: execution.averagePrice,
      candidateSize,
      missingShares,
      partialAgeSec,
      fairValuePremium: fairValuePremiumForSide(ctx.fairValueSnapshot, sideToBuy, execution.averagePrice),
      depthCoverageRatio: books.depthAtOrBetter(sideToBuy, execution.limitPrice, "ask") / Math.max(candidateSize, 1e-6),
      gapImprovement: Math.max(0, oldGap - projectedGap),
      oldGap,
      residualAfter: projectedGap,
      exactQtyMatch:
        prioritizedExactQty !== undefined && Math.abs(candidateSize - prioritizedExactQty) <= 1e-6,
      marketBasketDebtDeltaUSDC: marketBasketProjection?.debtDeltaUSDC,
      marketBasketProjectedEffectivePair: marketBasketProjection?.projectedEffectivePair,
      marketBasketPhaseOverride: marketBasketProjection?.phaseMaxOverrideAllowed,
    });
    if (score < bestCompletionScore) {
      bestCompletion = decision;
      bestCompletionScore = score;
    }
  }

  return bestCompletion ?? null;
}

function shouldHoldLateSmallCompletionResidual(args: {
  config: XuanStrategyConfig;
  missingShares: number;
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
    (args.residualSeverityLevel === "flat" && args.missingShares > 0.5);
  if (!holdableSeverity || args.missingShares > 5 + 1e-6) {
    return false;
  }
  return args.secsFromOpen >= 240 || args.secsToClose <= args.config.finalWindowSoftStartSec;
}

function shouldHoldHighLowOvershootCompletionResidual(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  leadingSide: OutcomeSide;
  missingShares: number;
  secsFromOpen: number;
  exactPriorActive: boolean;
}): boolean {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive || args.secsFromOpen < 150) {
    return false;
  }
  if (args.missingShares <= 0 || args.missingShares > Math.max(5, args.config.maxCompletionOvershootShares)) {
    return false;
  }
  const residualLots = args.leadingSide === "UP" ? args.state.upLots : args.state.downLots;
  return residualLots.some((lot) => lot.executionMode === "HIGH_LOW_COMPLETION_CHASE");
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

function completionCandidateScore(
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
    marketBasketDebtDeltaUSDC?: number | undefined;
    marketBasketProjectedEffectivePair?: number | undefined;
    marketBasketPhaseOverride?: boolean | undefined;
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
  const basketDebtBonus = Math.min(0.35, Math.max(0, args.marketBasketDebtDeltaUSDC ?? 0) * 0.08);
  const basketAvgBonus =
    args.marketBasketProjectedEffectivePair !== undefined && args.marketBasketProjectedEffectivePair <= config.marketBasketGoodAvgCap + 1e-9
      ? 0.12
      : args.marketBasketProjectedEffectivePair !== undefined &&
          args.marketBasketProjectedEffectivePair <= config.marketBasketContinuationProjectedEffectivePairCap + 1e-9
        ? 0.06
        : 0;
  const basketPhaseBonus = args.marketBasketPhaseOverride ? 0.08 : 0;
  return Number((
    costPenalty -
    resolutionBonus -
    depthBonus -
    inventoryShapeBonus -
    cleanupBonus -
    exactQtyBonus -
    basketDebtBonus -
    basketAvgBonus -
    basketPhaseBonus
  ).toFixed(9));
}

function buildMarketBasketContinuationCandidateSizes(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  sideToBuy: OutcomeSide;
  missingShares: number;
  missingSideBestAsk: number;
  exactPriorActive: boolean;
}): number[] {
  if (
    args.exactPriorActive ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.config.marketBasketScoringEnabled ||
    !args.config.marketBasketContinuationEnabled
  ) {
    return [];
  }
  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const leadingShares = args.sideToBuy === "UP" ? args.state.downShares : args.state.upShares;
  const currentMatchedQty = mergeableShares(args.state);
  const currentPair = currentMatchedQty > 1e-6
    ? matchedEffectivePairCost(args.state, args.config.cryptoTakerFeeRate)
    : 0;
  const continuationDuty =
    leadingShares >= args.config.marketBasketContinuationMinMatchedShares - 1e-9 &&
    (currentMatchedQty <= 1e-6 || currentPair > args.config.marketBasketGoodAvgCap + 1e-9);
  if (!continuationDuty) {
    return [];
  }

  const sizeCap = Math.min(args.missingShares, args.config.marketBasketContinuationMaxQty);
  const qualityMultipliers =
    args.missingSideBestAsk <= 0.12
      ? [2, 1.5, 1, 0.5, 0.25]
      : [1.5, 1, 0.5, 0.25];
  return qualityMultipliers
    .map((multiplier) => normalizeSize(Math.min(sizeCap, baseLot * multiplier)))
    .filter((size) => size >= args.config.completionMinQty);
}

function projectMarketBasketCompletion(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  sideToBuy: OutcomeSide;
  candidateSize: number;
  missingSidePrice: number;
  nowTs?: number | undefined;
}): {
  continuationDuty: boolean;
  projectedEffectivePair: number;
  projectedMatchedQty: number;
  debtBeforeUSDC: number;
  debtAfterUSDC: number;
  debtDeltaUSDC: number;
  phaseMaxOverrideAllowed: boolean;
} | undefined {
  if (
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.config.marketBasketScoringEnabled ||
    !args.config.marketBasketContinuationEnabled
  ) {
    return undefined;
  }
  const beforeMatchedQty = mergeableShares(args.state);
  const beforeEffectivePair =
    beforeMatchedQty > 1e-6
      ? matchedEffectivePairCost(args.state, args.config.cryptoTakerFeeRate)
      : 0;
  const debtBeforeUSDC = normalizeSize(Math.max(0, beforeEffectivePair - 1) * beforeMatchedQty);
  const leadingShares = args.sideToBuy === "UP" ? args.state.downShares : args.state.upShares;
  const continuationDuty =
    leadingShares >= args.config.marketBasketContinuationMinMatchedShares - 1e-9 &&
    (beforeMatchedQty <= 1e-6 || beforeEffectivePair > args.config.marketBasketGoodAvgCap + 1e-9);
  if (!continuationDuty) {
    return undefined;
  }

  const projectedState = applyFill(args.state, {
    outcome: args.sideToBuy,
    side: "BUY",
    price: args.missingSidePrice,
    size: args.candidateSize,
    timestamp: args.nowTs ?? args.state.market.startTs,
    makerTaker: "taker",
    executionMode: "PARTIAL_FAST_COMPLETION",
  });
  const projectedMatchedQty = mergeableShares(projectedState);
  if (projectedMatchedQty <= beforeMatchedQty + 1e-9) {
    return undefined;
  }
  const projectedEffectivePair = matchedEffectivePairCost(projectedState, args.config.cryptoTakerFeeRate);
  const debtAfterUSDC = normalizeSize(Math.max(0, projectedEffectivePair - 1) * projectedMatchedQty);
  const debtDeltaUSDC = normalizeSize(debtBeforeUSDC - debtAfterUSDC);
  const projectedKeepsBasketInContinuationBand =
    projectedEffectivePair <= args.config.marketBasketContinuationProjectedEffectivePairCap + 1e-9;
  const projectedGoodBasket = projectedEffectivePair <= args.config.marketBasketGoodAvgCap + 1e-9;
  const strongDebtReducer =
    debtDeltaUSDC >= args.config.marketBasketMinAvgImprovement * Math.max(args.candidateSize, 1);
  const lowSideStrongContinuation =
    args.missingSidePrice <= 0.12 &&
    (projectedKeepsBasketInContinuationBand || debtDeltaUSDC > 0);
  const phaseMaxOverrideAllowed =
    args.candidateSize <= args.config.marketBasketContinuationMaxQty + 1e-9 &&
    (projectedGoodBasket || projectedKeepsBasketInContinuationBand || strongDebtReducer || lowSideStrongContinuation);

  return {
    continuationDuty,
    projectedEffectivePair,
    projectedMatchedQty,
    debtBeforeUSDC,
    debtAfterUSDC,
    debtDeltaUSDC,
    phaseMaxOverrideAllowed,
  };
}

function shouldDeferNibbleCompletionUnderFlowPressure(args: {
  config: XuanStrategyConfig;
  candidateSize: number;
  missingShares: number;
  residualAfter: number;
  secsToClose: number;
  exactPriorActive: boolean;
  exceptionalMode: boolean;
  recentSeedFlowCount: number;
  activeIndependentFlowCount: number;
  flowPressureState: {
    supportive: boolean;
    remainingBudget: number;
  };
}): boolean {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive || args.exceptionalMode) {
    return false;
  }
  if (args.secsToClose <= Math.max(20, args.config.finalWindowCompletionOnlySec)) {
    return false;
  }
  const denseRecentFlow = args.recentSeedFlowCount >= 2;
  const independentFlowPressure = args.activeIndependentFlowCount >= 2;
  if (!denseRecentFlow && !independentFlowPressure) {
    return false;
  }
  if (!args.flowPressureState.supportive || args.flowPressureState.remainingBudget < 0.3) {
    return false;
  }
  const leavesMaterialResidual = args.residualAfter >= args.config.completionMinQty * 2;
  const isNibble = args.candidateSize <= args.missingShares * 0.5 + 1e-6;
  return leavesMaterialResidual && isNibble;
}

function fairValuePremiumForSide(
  snapshot: FairValueSnapshot | undefined,
  side: OutcomeSide,
  price: number,
): number | undefined {
  if (!snapshot || snapshot.status !== "valid") {
    return undefined;
  }
  const fairValue = side === "UP" ? snapshot.fairUp : snapshot.fairDown;
  if (fairValue === undefined) {
    return undefined;
  }
  return Number((price - fairValue).toFixed(9));
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
    shareGap <= Math.max(config.repairMinQty, config.completionMinQty) + 1e-9 ||
    mergeableShares(state) < config.xuanBasketCampaignMinMatchedShares - 1e-9
  ) {
    return false;
  }
  return state.fillHistory.some(
    (fill) =>
      fill.side === "BUY" &&
      (
        fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" ||
        fill.executionMode === "PAIRGROUP_COVERED_SEED" ||
        fill.executionMode === "XUAN_HARD_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_SOFT_PAIR_SWEEP" ||
        fill.executionMode === "STRICT_PAIR_SWEEP"
      ),
  );
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
  if (
    Number.isFinite(args.currentMatchedEffectivePair) &&
    args.repairCost <= args.config.softResidualCompletionCap + 1e-9 &&
    args.repairCost < args.currentMatchedEffectivePair - args.config.residualCompletionImprovementThreshold + 1e-9
  ) {
    return { allowed: true, reason: "residual_average_improvement" };
  }
  return { allowed: false };
}

function temporalSingleLegOrphanCompletionFallback(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  leadingSide: OutcomeSide;
  partialAgeSec: number;
  secsToClose: number;
  repairCost: number;
  executableSize: number;
  oldGap: number;
  newGap: number;
  negativeEdgeUsdc: number;
}): { allowed: boolean; reason?: string | undefined } {
  if (
    args.config.botMode !== "XUAN" ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    !args.config.allowResidualCompletion ||
    args.executableSize <= 0 ||
    args.executableSize > args.oldGap + 1e-9 ||
    args.newGap >= args.oldGap - 1e-9 ||
    args.secsToClose <= args.config.finalWindowNoChaseSec
  ) {
    return { allowed: false };
  }

  const hasTemporalOrphan = (args.leadingSide === "UP" ? args.state.upLots : args.state.downLots).some(
    (lot) => lot.executionMode === "TEMPORAL_SINGLE_LEG_SEED",
  );
  if (!hasTemporalOrphan) {
    return { allowed: false };
  }

  const matchedQty = mergeableShares(args.state);
  if (matchedQty > Math.max(args.config.postMergeFlatDustShares, 1e-6) + 1e-9) {
    return { allowed: false };
  }

  const minReleaseAgeSec = Math.max(
    args.config.xuanTemporalCompletionMinAgeSec,
    Math.min(args.config.completionUrgencyPatientSec, args.config.completionTargetMaxDelaySec),
  );
  if (args.partialAgeSec < minReleaseAgeSec) {
    return { allowed: false };
  }

  const maxEffectiveCost =
    args.partialAgeSec >= args.config.completionUrgencyForceSec
      ? Math.min(args.config.temporalRepairEmergencyCap, args.config.xuanBehaviorCap)
      : args.partialAgeSec >= args.config.completionTargetMaxDelaySec
        ? Math.min(args.config.temporalRepairPatientCap, args.config.xuanBehaviorCap)
        : Math.min(args.config.temporalRepairSoftCap, args.config.xuanBehaviorCap);
  if (args.repairCost > maxEffectiveCost + 1e-9) {
    return { allowed: false };
  }

  const maxAddedDebt =
    args.partialAgeSec >= args.config.completionTargetMaxDelaySec
      ? args.config.terminalCarryMaxAddedDebtUsdc
      : Math.min(args.config.terminalCarryMaxAddedDebtUsdc, args.config.maxAvgImprovingAddedDebtUsdc);
  if (args.negativeEdgeUsdc > maxAddedDebt + 1e-9) {
    return { allowed: false };
  }

  const maxQty =
    args.partialAgeSec >= args.config.completionTargetMaxDelaySec
      ? Math.min(args.oldGap, args.config.xuanBasketCampaignCompletionClipMaxQty)
      : Math.min(
          args.oldGap,
          Math.max(
            args.config.campaignCompletionMinPct * (args.config.liveSmallLotLadder[0] ?? args.config.defaultLot),
            args.config.microRepairMaxQty,
          ),
        );
  if (args.executableSize > maxQty + 1e-9) {
    return { allowed: false };
  }

  return {
    allowed: true,
    reason:
      args.repairCost <= 1
        ? "temporal_orphan_debt_reducing"
        : args.partialAgeSec >= args.config.completionTargetMaxDelaySec
          ? "temporal_orphan_terminal_carry"
          : "temporal_orphan_controlled_negative",
  };
}

function resolveGuidedMinCompletionSize(args: {
  config: XuanStrategyConfig;
  missingShares: number;
  secsToClose: number;
  recentSeedFlowCount: number;
  activeIndependentFlowCount: number;
  flowPressureState: {
    supportive: boolean;
    assertive: boolean;
    remainingBudget: number;
  };
  exactPriorActive: boolean;
}): number {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive) {
    return 0;
  }
  if (args.secsToClose <= Math.max(20, args.config.finalWindowCompletionOnlySec)) {
    return 0;
  }

  const moderateMultiFlowPressure =
    args.activeIndependentFlowCount >= 2 &&
    args.flowPressureState.supportive &&
    args.flowPressureState.remainingBudget >= 0.3 &&
    args.missingShares >= args.config.completionMinQty * 4;
  if (!moderateMultiFlowPressure) {
    return 0;
  }

  const baseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const strongMultiFlowPressure =
    args.activeIndependentFlowCount >= 2 &&
    args.recentSeedFlowCount >= 2 &&
    args.flowPressureState.assertive &&
    args.flowPressureState.remainingBudget >= 0.45;
  const targetFloor = strongMultiFlowPressure
    ? Math.max(args.missingShares * 0.5, baseLot * 0.22)
    : Math.max(args.missingShares * 0.35, baseLot * 0.18);

  return normalizeSize(
    Math.max(
      args.config.completionMinQty,
      Math.min(args.missingShares, targetFloor),
    ),
  );
}

function chooseResidualUnwind(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: CompletionContext,
  sideToSell: OutcomeSide,
  missingShares: number,
): UnwindDecision | null {
  if (!config.sellUnwindEnabled) {
    return null;
  }
  const residualBehaviorState = resolveResidualBehaviorState({
    config,
    residualShares: missingShares,
    shareGap: missingShares,
    recentSeedFlowCount:
      ctx.recentSeedFlowCount ??
      (ctx.nowTs !== undefined ? countRecentSeedFlowCount(state.fillHistory, ctx.nowTs) : 0),
    activeIndependentFlowCount:
      ctx.activeIndependentFlowCount ??
      (ctx.nowTs !== undefined ? countActiveIndependentFlowCount(state.fillHistory, ctx.nowTs) : 0),
  });
  const residualSeverity = residualBehaviorState.severity;
  const overlapRepairArbitration = residualBehaviorState.overlapRepairArbitration;
  const flowPressureState =
    ctx.flowPressureState ??
    deriveFlowPressureBudgetState({
      recentSeedFlowCount:
        ctx.recentSeedFlowCount ??
        (ctx.nowTs !== undefined ? countRecentSeedFlowCount(state.fillHistory, ctx.nowTs) : 0),
      activeIndependentFlowCount:
        ctx.activeIndependentFlowCount ??
        (ctx.nowTs !== undefined ? countActiveIndependentFlowCount(state.fillHistory, ctx.nowTs) : 0),
      residualSeverityPressure: residualBehaviorState.severityPressure,
    });

  if (ctx.secsToClose > config.residualUnwindSecToClose || missingShares <= config.maxResidualHoldShares) {
    return null;
  }
  if (
    flowPressureState.confirmed &&
    flowPressureState.remainingBudget >= 0.4 &&
    residualSeverity.level !== "aggressive" &&
    ctx.secsToClose > Math.max(15, Math.min(config.residualUnwindSecToClose, config.finalWindowCompletionOnlySec))
  ) {
    return null;
  }

  const unwindShares = normalizeSize(missingShares - config.maxResidualHoldShares);
  if (unwindShares < config.completionMinQty) {
    return null;
  }

  const execution = books.quoteForSize(sideToSell, "bid", unwindShares);
  if (!execution.fullyFilled || execution.filledSize < config.completionMinQty) {
    return null;
  }

  return {
    sideToSell,
    unwindShares: execution.filledSize,
    residualAfter: normalizeSize(Math.max(0, missingShares - execution.filledSize)),
      expectedAveragePrice: execution.averagePrice,
      mode: "UNWIND",
      residualSeverityLevel: residualSeverity.level,
      residualSeverityPressure: residualBehaviorState.severityPressure,
      residualFlowDensity: residualBehaviorState.flowDensity,
      overlapRepairArbitration,
      arbitrationOutcome: "unwind",
    order: buildTakerSellOrder({
      state,
      side: sideToSell,
      shareTarget: execution.filledSize,
      limitPrice: execution.limitPrice,
      orderType: "FAK",
    }),
  };
}

function buildCandidateSizes(
  fractions: number[],
  missingShares: number,
  minOrderSize: number,
  extraCandidateSizes: number[] = [],
): number[] {
  const uniqueFractions = [...new Set([...fractions, 1])]
    .filter((fraction) => fraction > 0)
    .sort((left, right) => right - left);

  const candidateSizes = uniqueFractions
    .map((fraction) => normalizeSize(Math.min(missingShares, missingShares * fraction)))
    .filter((size) => size >= minOrderSize);

  if (missingShares >= minOrderSize) {
    candidateSizes.push(normalizeSize(missingShares));
  }

  for (const extraSize of extraCandidateSizes) {
    const normalizedExtra = normalizeSize(extraSize);
    if (normalizedExtra >= minOrderSize) {
      candidateSizes.push(normalizedExtra);
    }
  }

  return [...new Set(candidateSizes)].sort((left, right) => right - left);
}

function buildHighLowOvershootCandidateSizes(args: {
  config: XuanStrategyConfig;
  sideToBuy: OutcomeSide;
  books: OrderBookState;
  existingAverage: number;
  missingShares: number;
  exactPriorActive: boolean;
}): number[] {
  if (args.config.botMode !== "XUAN" || args.exactPriorActive || args.missingShares <= 0) {
    return [];
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
    return [];
  }
  const overshootRatio = missingSidePrice >= args.config.highSidePriceThreshold ? 0.055 : 0.035;
  const overshootQty = normalizeSize(args.missingShares * (1 + overshootRatio));
  if (overshootQty <= args.missingShares + 1e-6) {
    return [];
  }
  return [overshootQty];
}

function normalizeSize(value: number): number {
  return Number(value.toFixed(6));
}
