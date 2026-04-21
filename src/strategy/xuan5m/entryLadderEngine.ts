import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { ExecutionQuote } from "./orderBookState.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { pairCostWithBothTaker, completionCost, takerFeePerShare } from "./sumAvgEngine.js";
import { averageCost } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";

export type EntryBuyReason = "balanced_pair_seed" | "balanced_pair_reentry" | "lagging_rebalance";

export interface EntryBuyDecision {
  side: OutcomeSide;
  size: number;
  reason: EntryBuyReason;
  expectedAveragePrice: number;
  effectivePricePerShare: number;
  pairCostWithFees?: number | undefined;
  order: MarketOrderArgs;
}

export interface EntryLadderContext {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
}

interface BalancedPairCandidate {
  pairCost: number;
  upExecution: ExecutionQuote;
  downExecution: ExecutionQuote;
}

export function chooseEntryBuys(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
): EntryBuyDecision[] {
  if (!config.entryTakerBuyEnabled) {
    return [];
  }

  const totalShares = state.upShares + state.downShares;
  const shareGap = Math.abs(state.upShares - state.downShares);

  if (shareGap === 0) {
    const candidate = findBalancedPairCandidate(config, state, books, ctx.lot);
    if (!candidate) {
      return [];
    }
    const paired = buildBalancedPairEntryBuys(
      state,
      candidate,
      config.cryptoTakerFeeRate,
      totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
    );
    if (paired.length > 0) {
      return paired;
    }
  }

  if (shareGap > 0) {
    const laggingSide: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
    const leadingSide: OutcomeSide = laggingSide === "UP" ? "DOWN" : "UP";
    const repairSize = normalizeOrderSize(
      Math.min(
        Math.max(ctx.lot, shareGap),
        ctx.lot * config.rebalanceMaxLaggingMultiplier,
        Math.max(0, config.maxMarketSharesPerSide - (laggingSide === "UP" ? state.upShares : state.downShares)),
      ),
      state.market.minOrderSize,
    );

    if (repairSize > 0) {
      const execution = books.quoteForSize(laggingSide, "ask", repairSize);
      const executableSize = normalizeOrderSize(execution.filledSize, state.market.minOrderSize);
      if (executableSize > 0) {
        const repairCost = completionCost(
          averageCost(state, leadingSide),
          execution.averagePrice,
          config.cryptoTakerFeeRate,
        );
        if (repairCost <= config.entryTakerPairCap) {
          return [
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
              config.cryptoTakerFeeRate,
              repairCost,
            ),
          ];
        }
      }
    }
  }

  return [];
}

function findBalancedPairCandidate(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  requestedMaxLot: number,
): BalancedPairCandidate | undefined {
  const maxCandidateSize = normalizeOrderSize(
    Math.min(
      requestedMaxLot,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
    ),
    state.market.minOrderSize,
  );

  if (maxCandidateSize <= 0) {
    return undefined;
  }

  const requestedSizes = buildCandidateSizes(config.lotLadder, maxCandidateSize, state.market.minOrderSize);
  let bestCandidate: BalancedPairCandidate | undefined;

  for (const requestedSize of requestedSizes) {
    const upExecution = books.quoteForSize("UP", "ask", requestedSize);
    const downExecution = books.quoteForSize("DOWN", "ask", requestedSize);
    if (!upExecution.fullyFilled || !downExecution.fullyFilled) {
      continue;
    }

    const pairCost = pairCostWithBothTaker(
      upExecution.averagePrice,
      downExecution.averagePrice,
      config.cryptoTakerFeeRate,
    );
    if (pairCost > config.entryTakerPairCap) {
      continue;
    }

    bestCandidate = {
      pairCost,
      upExecution,
      downExecution,
    };
  }

  return bestCandidate;
}

function buildCandidateSizes(ladder: number[], maxCandidateSize: number, minOrderSize: number): number[] {
  const normalized = Array.from(
    new Set(
      ladder
        .map((size) => normalizeOrderSize(size, minOrderSize))
        .filter((size) => size > 0 && size <= maxCandidateSize),
    ),
  ).sort((left, right) => left - right);

  if (normalized.length > 0) {
    return normalized;
  }

  return [maxCandidateSize];
}

function buildBalancedPairEntryBuys(
  state: XuanMarketState,
  candidate: BalancedPairCandidate,
  feeRate: number,
  reason: EntryBuyReason,
): EntryBuyDecision[] {
  return [
    buildEntryBuy(state, "UP", candidate.upExecution, reason, feeRate, candidate.pairCost),
    buildEntryBuy(state, "DOWN", candidate.downExecution, reason, feeRate, candidate.pairCost),
  ];
}

function buildEntryBuy(
  state: XuanMarketState,
  side: OutcomeSide,
  execution: ExecutionQuote,
  reason: EntryBuyReason,
  feeRate: number,
  pairCost?: number,
): EntryBuyDecision {
  return {
    side,
    size: execution.filledSize,
    reason,
    expectedAveragePrice: execution.averagePrice,
    effectivePricePerShare: execution.averagePrice + takerFeePerShare(execution.averagePrice, feeRate),
    ...(pairCost !== undefined ? { pairCostWithFees: pairCost } : {}),
    order: {
      tokenId: state.market.tokens[side].tokenId,
      side: "BUY",
      amount: execution.filledSize,
      price: execution.limitPrice,
      orderType: "FAK",
      userUsdcBalance: execution.filledSize,
    },
  };
}

function normalizeOrderSize(size: number, minOrderSize: number): number {
  const normalized = Number(size.toFixed(6));
  if (normalized < minOrderSize) {
    return 0;
  }
  return normalized;
}
