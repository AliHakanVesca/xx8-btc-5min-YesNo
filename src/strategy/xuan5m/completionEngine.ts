import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { resolveBundledCompletionSequencePrior } from "../../analytics/xuanExactReference.js";
import {
  absoluteShareGap,
  averageEffectiveCost,
  oldestResidualLotTimestamp,
  projectedShareGapAfterBuy,
} from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";
import { completionAllowance, resolvePartialCompletionPhase } from "./modePolicy.js";
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
}

export interface UnwindDecision {
  sideToSell: OutcomeSide;
  unwindShares: number;
  residualAfter: number;
  expectedAveragePrice: number;
  mode: StrategyExecutionMode;
  order: MarketOrderArgs;
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
  const residualTimestamp = oldestResidualLotTimestamp(state, leadingSide);
  const partialAgeSec =
    ctx.nowTs !== undefined && residualTimestamp !== undefined
      ? Math.max(0, ctx.nowTs - residualTimestamp)
      : config.partialSoftWindowSec;
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
  const phaseMaxQty =
    exactCompletionQtyPrior && Number.isFinite(phase.maxQty)
      ? Math.max(phase.maxQty, exactCompletionQtyPrior.qty)
      : phase.maxQty;
  const candidateSizes = Array.from(
    new Set(
      buildCandidateSizes(
        config.partialCompletionFractions,
        missingShares,
        config.completionMinQty,
        exactCompletionQtyPrior ? [exactCompletionQtyPrior.qty] : [],
      )
        .map((size) =>
          normalizeSize(
            Math.min(
              size,
              Number.isFinite(phaseMaxQty) ? phaseMaxQty : size,
            ),
          ),
        )
        .filter((size) => size >= config.completionMinQty),
    ),
  ).sort((left, right) => right - left);
  const prioritizedExactQty = exactCompletionQtyPrior ? normalizeSize(exactCompletionQtyPrior.qty) : undefined;
  const orderedCandidateSizes =
    prioritizedExactQty !== undefined && candidateSizes.includes(prioritizedExactQty)
      ? [prioritizedExactQty, ...candidateSizes.filter((size) => Math.abs(size - prioritizedExactQty) > 1e-6)]
      : candidateSizes;

  for (const candidateSize of orderedCandidateSizes) {
    if (candidateSize > phaseMaxQty) {
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
    const allowance = completionAllowance(config, state, {
      costWithFees,
      candidateSize,
      oppositeAveragePrice: existingAverage,
      missingSidePrice: execution.averagePrice,
      partialAgeSec,
    });
    const highLowPhaseCapOverride = Boolean(allowance.highLowMismatch && allowance.allowed);
    if (costWithFees > phase.cap && !highLowPhaseCapOverride) {
      continue;
    }
    const ultraFastCloneFairValueFallback =
      config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
      partialAgeSec <= config.temporalRepairUltraFastWindowSec &&
      isCloneRepairFairValueFallbackSnapshot(ctx.fairValueSnapshot) &&
      costWithFees <= config.temporalRepairUltraFastMissingFairValueCap &&
      allowance.allowed;
    const fairValueRequired =
      ultraFastCloneFairValueFallback
        ? false
        : allowance.highLowMismatch && allowance.allowed && !allowance.requiresFairValue
          ? false
          : !(
              config.allowStrictResidualCompletionWithoutFairValue &&
              costWithFees <= config.strictResidualCompletionCap
            ) || Boolean(allowance.requiresFairValue);
    const fairValueDecision = ultraFastCloneFairValueFallback
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
    const cheapLateCompletionChase =
      allowance.allowed &&
      shouldUseCheapLateCompletionChase({
        config,
        completionQtyPrior,
        oppositeAveragePrice: existingAverage,
        missingSidePrice: execution.averagePrice,
        partialAgeSec,
      });
    if (!allowance.allowed) {
      continue;
    }
    if (!fairValueDecision.allowed && (phase.requiresFairValue || phase.mode === "POST_MERGE_RESIDUAL_COMPLETION")) {
      continue;
    }
    if (!fairValueDecision.allowed && phase.mode !== "POST_MERGE_RESIDUAL_COMPLETION") {
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

    return {
      sideToBuy,
      missingShares: candidateSize,
      residualAfter: normalizeSize(Math.max(0, missingShares - candidateSize)),
      mode: selectedMode,
      costWithFees,
      capMode: allowance.capMode,
      negativeEdgeUsdc: allowance.negativeEdgeUsdc,
      oldGap,
      newGap: projectedGap,
      oppositeAveragePrice: existingAverage,
      missingSideAveragePrice: execution.averagePrice,
      highLowMismatch: allowance.highLowMismatch ?? false,
      order: buildTakerBuyOrder({
        state,
        side: sideToBuy,
        shareTarget: candidateSize,
        limitPrice: execution.limitPrice,
        orderType: "FAK",
      }),
    };
  }

  return null;
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

  if (ctx.secsToClose > config.residualUnwindSecToClose || missingShares <= config.maxResidualHoldShares) {
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

function normalizeSize(value: number): number {
  return Number(value.toFixed(6));
}
