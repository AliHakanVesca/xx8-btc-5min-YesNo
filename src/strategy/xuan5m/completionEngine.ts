import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { averageCost } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";
import { completionAllowance } from "./modePolicy.js";
import { completionCost } from "./sumAvgEngine.js";

export interface CompletionDecision {
  sideToBuy: OutcomeSide;
  missingShares: number;
  residualAfter: number;
  order: MarketOrderArgs;
  costWithFees: number;
  capMode: "strict" | "soft" | "emergency";
  negativeEdgeUsdc: number;
}

export interface UnwindDecision {
  sideToSell: OutcomeSide;
  unwindShares: number;
  residualAfter: number;
  expectedAveragePrice: number;
  order: MarketOrderArgs;
}

export interface InventoryAdjustmentDecision {
  completion?: CompletionDecision | undefined;
  unwind?: UnwindDecision | undefined;
}

export interface CompletionContext {
  secsToClose: number;
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
  const existingAverage = averageCost(state, leadingSide);

  const completion = chooseCompletion(config, state, books, sideToBuy, existingAverage, missingShares);
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
): CompletionDecision | null {
  const candidateSizes = buildCandidateSizes(config.partialCompletionFractions, missingShares, state.market.minOrderSize);

  for (const candidateSize of candidateSizes) {
    const execution = books.quoteForSize(sideToBuy, "ask", candidateSize);
    if (!execution.fullyFilled) {
      continue;
    }

    const costWithFees = completionCost(existingAverage, execution.averagePrice, config.cryptoTakerFeeRate);
    const allowance = completionAllowance(config, state, costWithFees, candidateSize);
    if (!allowance.allowed) {
      continue;
    }

    return {
      sideToBuy,
      missingShares: candidateSize,
      residualAfter: normalizeSize(Math.max(0, missingShares - candidateSize)),
      costWithFees,
      capMode: allowance.capMode,
      negativeEdgeUsdc: allowance.negativeEdgeUsdc,
      order: {
        tokenId: state.market.tokens[sideToBuy].tokenId,
        side: "BUY",
        amount: candidateSize,
        price: execution.limitPrice,
        orderType: "FAK",
        userUsdcBalance: candidateSize,
      },
    };
  }

  return null;
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
  if (unwindShares < state.market.minOrderSize) {
    return null;
  }

  const execution = books.quoteForSize(sideToSell, "bid", unwindShares);
  if (!execution.fullyFilled || execution.filledSize < state.market.minOrderSize) {
    return null;
  }

  return {
    sideToSell,
    unwindShares: execution.filledSize,
    residualAfter: normalizeSize(Math.max(0, missingShares - execution.filledSize)),
    expectedAveragePrice: execution.averagePrice,
    order: {
      tokenId: state.market.tokens[sideToSell].tokenId,
      side: "SELL",
      amount: execution.filledSize,
      price: execution.limitPrice,
      orderType: "FAK",
    },
  };
}

function buildCandidateSizes(fractions: number[], missingShares: number, minOrderSize: number): number[] {
  const uniqueFractions = [...new Set([...fractions, 1])]
    .filter((fraction) => fraction > 0)
    .sort((left, right) => right - left);

  const candidateSizes = uniqueFractions
    .map((fraction) => normalizeSize(Math.min(missingShares, missingShares * fraction)))
    .filter((size) => size >= minOrderSize);

  if (missingShares >= minOrderSize) {
    candidateSizes.push(normalizeSize(missingShares));
  }

  return [...new Set(candidateSizes)].sort((left, right) => right - left);
}

function normalizeSize(value: number): number {
  return Number(value.toFixed(6));
}
