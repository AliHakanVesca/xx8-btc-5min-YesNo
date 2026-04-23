import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { XuanMarketState } from "./marketState.js";
import type { StrategyExecutionMode } from "./executionModes.js";

export interface CompletionAllowance {
  allowed: boolean;
  capMode: "strict" | "soft" | "hard" | "emergency";
  negativeEdgeUsdc: number;
  highLowMismatch?: boolean;
  requiresFairValue?: boolean;
}

export interface PairSweepAllowance {
  allowed: boolean;
  mode?: Extract<
    StrategyExecutionMode,
    "STRICT_PAIR_SWEEP" | "XUAN_SOFT_PAIR_SWEEP" | "XUAN_HARD_PAIR_SWEEP"
  >;
  negativeEdgeUsdc: number;
  projectedMarketBudget: number;
  projectedDailyBudget: number;
}

export interface PartialCompletionPhase {
  phase: "fast" | "soft" | "patient" | "emergency" | "post_merge";
  mode: Extract<
    StrategyExecutionMode,
    | "PARTIAL_FAST_COMPLETION"
    | "PARTIAL_SOFT_COMPLETION"
    | "PARTIAL_EMERGENCY_COMPLETION"
    | "POST_MERGE_RESIDUAL_COMPLETION"
  >;
  cap: number;
  maxQty: number;
  requiresFairValue: boolean;
}

export function estimateNegativeEdgeUsdc(costWithFees: number, size: number): number {
  return Math.max(0, costWithFees - 1) * size;
}

export function pairEntryCap(config: XuanStrategyConfig): number {
  return config.pairSweepStrictCap;
}

export function resolvePartialCompletionPhase(args: {
  config: XuanStrategyConfig;
  partialAgeSec: number;
  secsToClose: number;
  postMergeCompletionOnly: boolean;
  capFamily?: "partial" | "temporal_repair";
}): PartialCompletionPhase {
  const fastCap =
    args.capFamily === "temporal_repair" ? args.config.temporalRepairFastCap : args.config.partialFastCap;
  const softCap =
    args.capFamily === "temporal_repair" ? args.config.temporalRepairSoftCap : args.config.partialSoftCap;
  const patientCap =
    args.capFamily === "temporal_repair" ? args.config.temporalRepairPatientCap : args.config.partialHardCap;
  const emergencyCap =
    args.capFamily === "temporal_repair"
      ? args.config.temporalRepairEmergencyCap
      : args.config.partialEmergencyCap;

  if (args.postMergeCompletionOnly) {
    return {
      phase: "post_merge",
      mode: "POST_MERGE_RESIDUAL_COMPLETION",
      cap: Math.min(args.config.partialSoftCap, args.config.completionSoftCap),
      maxQty: args.config.partialSoftMaxQty,
      requiresFairValue: false,
    };
  }

  if (args.partialAgeSec <= args.config.partialFastWindowSec) {
    return {
      phase: "fast",
      mode: "PARTIAL_FAST_COMPLETION",
      cap: fastCap,
      maxQty: Number.POSITIVE_INFINITY,
      requiresFairValue: false,
    };
  }

  if (args.partialAgeSec <= args.config.partialSoftWindowSec) {
    return {
      phase: "soft",
      mode: "PARTIAL_SOFT_COMPLETION",
      cap: softCap,
      maxQty: args.config.partialSoftMaxQty,
      requiresFairValue: false,
    };
  }

  if (args.partialAgeSec <= args.config.partialPatientWindowSec) {
    return {
      phase: "patient",
      mode: "PARTIAL_SOFT_COMPLETION",
      cap: patientCap,
      maxQty: args.config.partialHardMaxQty,
      requiresFairValue: false,
    };
  }

  return {
    phase: "emergency",
    mode: "PARTIAL_EMERGENCY_COMPLETION",
    cap: emergencyCap,
    maxQty: args.config.partialEmergencyMaxQty,
    requiresFairValue: args.config.partialEmergencyRequiresFairValue,
  };
}

export function pairSweepAllowance(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  costWithFees: number;
  candidateSize: number;
  secsToClose: number;
  dailyNegativeEdgeSpentUsdc?: number;
}): PairSweepAllowance {
  const negativeEdgeUsdc = estimateNegativeEdgeUsdc(args.costWithFees, args.candidateSize);
  const imbalanceShares = Math.abs(args.state.upShares - args.state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(args.state.upShares + args.state.downShares, 1);
  const projectedMarketBudget = args.state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc;
  const projectedDailyBudget = (args.dailyNegativeEdgeSpentUsdc ?? 0) + negativeEdgeUsdc;

  if (args.secsToClose <= args.config.finalWindowNoChaseSec && !args.config.allowAnyNewBuyInLast10S) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.secsToClose <= args.config.finalWindowCompletionOnlySec && !args.config.allowNewPairInLast30S) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.secsToClose <= args.config.finalWindowSoftStartSec && !args.config.allowNewPairInLast60S) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.costWithFees <= args.config.pairSweepStrictCap) {
    return {
      allowed: true,
      mode: "STRICT_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.config.botMode !== "XUAN" || !args.config.allowInitialNegativePairSweep) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  const withinCycleBudget = negativeEdgeUsdc <= args.config.maxNegativePairEdgePerCycleUsdc;
  const withinMarketBudget = projectedMarketBudget <= args.config.maxNegativePairEdgePerMarketUsdc;
  const withinDailyBudget = projectedDailyBudget <= args.config.maxNegativeDailyBudgetUsdc;

  if (
    args.costWithFees <= args.config.xuanPairSweepSoftCap &&
    args.candidateSize <= args.config.xuanSoftSweepMaxQty &&
    args.secsToClose > args.config.xuanMinTimeLeftForSoftSweep &&
    imbalanceRatio <= args.config.softImbalanceRatio &&
    withinCycleBudget &&
    withinMarketBudget &&
    withinDailyBudget
  ) {
    return {
      allowed: true,
      mode: "XUAN_SOFT_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (
    args.config.enableXuanHardPairSweep &&
    args.costWithFees <= args.config.xuanPairSweepHardCap &&
    args.candidateSize <= args.config.xuanHardSweepMaxQty &&
    args.secsToClose > args.config.xuanMinTimeLeftForHardSweep &&
    imbalanceRatio <= args.config.hardImbalanceRatio &&
    withinCycleBudget &&
    withinMarketBudget &&
    withinDailyBudget
  ) {
    return {
      allowed: true,
      mode: "XUAN_HARD_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  return {
    allowed: false,
    negativeEdgeUsdc,
    projectedMarketBudget,
    projectedDailyBudget,
  };
}

export function completionAllowance(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  args: {
    costWithFees: number;
    candidateSize: number;
    oppositeAveragePrice: number;
    missingSidePrice: number;
    partialAgeSec?: number;
  },
): CompletionAllowance {
  const strictResidualCap = Math.min(config.completionStrictCap, config.strictResidualCompletionCap);
  const softResidualCap = Math.min(config.completionSoftCap, config.softResidualCompletionCap);
  const negativeEdgeUsdc = estimateNegativeEdgeUsdc(args.costWithFees, args.candidateSize);
  const imbalanceShares = Math.abs(state.upShares - state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(state.upShares + state.downShares, 1);
  const projectedBudget = state.negativeCompletionEdgeConsumedUsdc + negativeEdgeUsdc;
  const priceSpikeDelta = args.missingSidePrice - args.oppositeAveragePrice;
  const priceSpikeRatio = args.missingSidePrice / Math.max(args.oppositeAveragePrice, 0.01);
  const cloneSpikeMismatch =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    (args.partialAgeSec ?? 0) >= Math.max(10, config.partialFastWindowSec) &&
    args.missingSidePrice >= config.highSidePriceThreshold - 0.02 &&
    priceSpikeDelta >= 0.45 &&
    priceSpikeRatio >= 2.25;
  const highLowMismatch =
    (config.requireStrictCapForHighLowMismatch || config.xuanCloneMode === "PUBLIC_FOOTPRINT") &&
    ((args.missingSidePrice >= config.highSidePriceThreshold &&
      args.oppositeAveragePrice <= config.lowSideMaxForHighCompletion) ||
      cloneSpikeMismatch);

  if (config.botMode === "STRICT") {
    return {
      allowed: args.costWithFees <= strictResidualCap,
      capMode: "strict",
      negativeEdgeUsdc,
      ...(highLowMismatch ? { highLowMismatch } : {}),
    };
  }

  if (args.costWithFees <= strictResidualCap) {
    return {
      allowed: true,
      capMode: "strict",
      negativeEdgeUsdc,
      ...(highLowMismatch ? { highLowMismatch } : {}),
    };
  }

  if (highLowMismatch) {
    if (
      config.allowHighSideEmergencyChase &&
      args.candidateSize <= config.highSideEmergencyMaxQty &&
      args.costWithFees <= config.highSideEmergencyCap &&
      (!config.highSideEmergencyRequiresHardImbalance || imbalanceRatio >= config.hardImbalanceRatio)
    ) {
      return {
        allowed: true,
        capMode: "emergency",
        negativeEdgeUsdc,
        highLowMismatch,
        requiresFairValue: config.highSideEmergencyRequiresFairValue,
      };
    }
    return {
      allowed: false,
      capMode: "strict",
      negativeEdgeUsdc,
      highLowMismatch,
    };
  }

  if (
    args.costWithFees <= softResidualCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    imbalanceRatio >= config.softImbalanceRatio
  ) {
    return {
      allowed: true,
      capMode: "soft",
      negativeEdgeUsdc,
    };
  }

  if (
    args.costWithFees <= config.completionHardCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    imbalanceRatio >= config.hardImbalanceRatio
  ) {
    return {
      allowed: true,
      capMode: "hard",
      negativeEdgeUsdc,
    };
  }

  if (
    args.candidateSize <= config.emergencyCompletionMaxQty &&
    args.costWithFees <= config.emergencyCompletionHardCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    (!config.emergencyRequiresHardImbalance || imbalanceRatio >= config.hardImbalanceRatio)
  ) {
    return {
      allowed: true,
      capMode: "emergency",
      negativeEdgeUsdc,
    };
  }

  return {
    allowed: false,
    capMode:
      args.costWithFees <= softResidualCap
        ? "soft"
        : args.costWithFees <= config.completionHardCap
          ? "hard"
          : "emergency",
    negativeEdgeUsdc,
    ...(highLowMismatch ? { highLowMismatch } : {}),
  };
}
