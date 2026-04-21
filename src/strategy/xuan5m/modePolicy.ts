import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { XuanMarketState } from "./marketState.js";

export interface CompletionAllowance {
  allowed: boolean;
  capMode: "strict" | "soft" | "emergency";
  negativeEdgeUsdc: number;
}

export function estimateNegativeEdgeUsdc(costWithFees: number, size: number): number {
  return Math.max(0, costWithFees - 1) * size;
}

export function pairEntryCap(config: XuanStrategyConfig): number {
  return config.botMode === "STRICT" ? config.strictPairEffectiveCap : config.normalPairEffectiveCap;
}

export function completionAllowance(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  costWithFees: number,
  candidateSize: number,
): CompletionAllowance {
  const negativeEdgeUsdc = estimateNegativeEdgeUsdc(costWithFees, candidateSize);
  const imbalanceShares = Math.abs(state.upShares - state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(state.upShares + state.downShares, 1);
  const projectedBudget = state.negativeEdgeConsumedUsdc + negativeEdgeUsdc;

  if (config.botMode === "STRICT") {
    return {
      allowed: costWithFees <= config.strictPairEffectiveCap,
      capMode: "strict",
      negativeEdgeUsdc,
    };
  }

  if (
    costWithFees <= config.completionSoftCap &&
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
    candidateSize <= config.emergencyCompletionMaxQty &&
    costWithFees <= config.completionHardCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    imbalanceRatio >= config.hardImbalanceRatio
  ) {
    return {
      allowed: true,
      capMode: "emergency",
      negativeEdgeUsdc,
    };
  }

  return {
    allowed: false,
    capMode: costWithFees <= config.completionSoftCap ? "soft" : "emergency",
    negativeEdgeUsdc,
  };
}
