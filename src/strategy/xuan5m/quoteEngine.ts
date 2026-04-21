import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { OutcomeSide } from "../../infra/clob/types.js";
import { clamp, roundDownToTick } from "../../utils/math.js";
import { imbalance } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";

export interface MakerPairQuote {
  combinedCap: number;
  lot: number;
  upPrice: number;
  downPrice: number;
  upSize: number;
  downSize: number;
  skewedSide?: OutcomeSide | undefined;
}

export interface QuoteContext {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
}

export function chooseCombinedCap(config: XuanStrategyConfig, secsFromOpen: number, secsToClose: number): number {
  if (secsFromOpen < 45) {
    return config.combinedCapAggressive;
  }
  if (secsToClose < config.normalEntryCutoffSecToClose) {
    return config.combinedCapSafe;
  }
  return config.combinedCapBase;
}

export function buildMakerPairQuote(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: QuoteContext,
): MakerPairQuote | null {
  const tick = books.tickSize();
  const minOrderSize = state.market.minOrderSize;
  const combinedCap = chooseCombinedCap(config, ctx.secsFromOpen, ctx.secsToClose);
  const currentImbalance = imbalance(state);
  const skewedSide = currentImbalance >= config.maxImbalanceFrac ? (state.upShares > state.downShares ? "DOWN" : "UP") : undefined;

  const referenceUpBid = clamp(books.bestBid("UP") + tick, tick, combinedCap - tick);
  let upPrice = roundDownToTick(referenceUpBid, tick);
  let downPrice = roundDownToTick(combinedCap - upPrice, tick);

  if (skewedSide === "DOWN") {
    upPrice = roundDownToTick(Math.max(tick, upPrice - tick), tick);
    downPrice = roundDownToTick(combinedCap - upPrice, tick);
  }
  if (skewedSide === "UP") {
    downPrice = roundDownToTick(Math.max(tick, downPrice - tick), tick);
    upPrice = roundDownToTick(combinedCap - downPrice, tick);
  }

  if (upPrice <= 0 || downPrice <= 0 || upPrice + downPrice > combinedCap + tick / 2) {
    return null;
  }

  const shareGap = Math.abs(state.upShares - state.downShares);
  let upSize = normalizeOrderSize(Math.min(ctx.lot, Math.max(0, config.maxMarketSharesPerSide - state.upShares)), minOrderSize);
  let downSize = normalizeOrderSize(Math.min(ctx.lot, Math.max(0, config.maxMarketSharesPerSide - state.downShares)), minOrderSize);

  if (skewedSide) {
    const laggingTarget = Math.min(
      Math.max(ctx.lot, shareGap),
      ctx.lot * config.rebalanceMaxLaggingMultiplier,
      Math.max(
        0,
        config.maxMarketSharesPerSide - (skewedSide === "UP" ? state.upShares : state.downShares),
      ),
    );
    const laggingSize = normalizeOrderSize(laggingTarget, minOrderSize);
    const leadingSize = normalizeOrderSize(
      Math.min(
        currentImbalance >= config.forceRebalanceImbalanceFrac ? 0 : ctx.lot * config.rebalanceLeadingFraction,
        Math.max(
          0,
          config.maxMarketSharesPerSide - (skewedSide === "UP" ? state.downShares : state.upShares),
        ),
      ),
      minOrderSize,
    );

    if (skewedSide === "UP") {
      upSize = laggingSize;
      downSize = leadingSize;
    } else {
      downSize = laggingSize;
      upSize = leadingSize;
    }
  }

  if (upSize <= 0 && downSize <= 0) {
    return null;
  }

  return {
    combinedCap,
    lot: ctx.lot,
    upPrice,
    downPrice,
    upSize,
    downSize,
    skewedSide,
  };
}

function normalizeOrderSize(size: number, minOrderSize: number): number {
  const normalized = Number(size.toFixed(6));
  if (normalized < minOrderSize) {
    return 0;
  }
  return normalized;
}
