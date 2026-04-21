import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { pairCostWithBothTaker, completionCost } from "./sumAvgEngine.js";
import { averageCost, mergeableShares } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";

export interface EntryBuyDecision {
  side: OutcomeSide;
  size: number;
  expectedAveragePrice: number;
  order: MarketOrderArgs;
}

export interface EntryLadderContext {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
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

  const pairLot = normalizeOrderSize(
    Math.min(
      ctx.lot,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
    ),
    state.market.minOrderSize,
  );
  const pairCost = pairCostWithBothTaker(
    books.bestAsk("UP"),
    books.bestAsk("DOWN"),
    config.cryptoTakerFeeRate,
  );
  const currentMatched = mergeableShares(state);
  const totalShares = state.upShares + state.downShares;

  if ((totalShares === 0 || currentMatched === 0) && pairLot > 0 && pairCost <= config.entryTakerPairCap) {
    return [
      buildEntryBuy(state, books, "UP", pairLot),
      buildEntryBuy(state, books, "DOWN", pairLot),
    ];
  }

  const shareGap = Math.abs(state.upShares - state.downShares);
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
      const repairCost = completionCost(
        averageCost(state, leadingSide),
        books.bestAsk(laggingSide),
        config.cryptoTakerFeeRate,
      );
      if (repairCost <= config.entryTakerPairCap) {
        return [buildEntryBuy(state, books, laggingSide, repairSize)];
      }
    }
  }

  if (currentMatched > 0 && pairLot > 0 && pairCost <= config.entryTakerPairCap) {
    return [
      buildEntryBuy(state, books, "UP", pairLot),
      buildEntryBuy(state, books, "DOWN", pairLot),
    ];
  }

  return [];
}

function buildEntryBuy(
  state: XuanMarketState,
  books: OrderBookState,
  side: OutcomeSide,
  amount: number,
): EntryBuyDecision {
  const execution = books.quoteForSize(side, "ask", amount);
  return {
    side,
    size: execution.filledSize,
    expectedAveragePrice: execution.averagePrice,
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
