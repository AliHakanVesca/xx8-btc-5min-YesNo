import type { MarketOrderArgs, OutcomeSide, TakerOrderType } from "../../infra/clob/types.js";
import { normalizeClobMarketBuy, normalizePositiveAmount, normalizePositiveShares } from "../../infra/clob/orderPrecision.js";
import type { XuanMarketState } from "./marketState.js";

export function buildTakerBuyOrder(args: {
  state: XuanMarketState;
  side: OutcomeSide;
  shareTarget: number;
  limitPrice: number;
  orderType?: TakerOrderType;
  metadata?: string;
}): MarketOrderArgs {
  const normalized = normalizeClobMarketBuy({
    shareTarget: args.shareTarget,
    price: args.limitPrice,
  });
  return {
    tokenId: args.state.market.tokens[args.side].tokenId,
    side: "BUY",
    amount: normalized.amount,
    shareTarget: normalized.shareTarget,
    price: args.limitPrice,
    orderType: args.orderType ?? "FAK",
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  };
}

export function buildTakerSellOrder(args: {
  state: XuanMarketState;
  side: OutcomeSide;
  shareTarget: number;
  limitPrice: number;
  orderType?: TakerOrderType;
  metadata?: string;
}): MarketOrderArgs {
  return {
    tokenId: args.state.market.tokens[args.side].tokenId,
    side: "SELL",
    amount: normalizePositiveAmount(args.shareTarget),
    shareTarget: normalizePositiveShares(args.shareTarget),
    price: args.limitPrice,
    orderType: args.orderType ?? "FAK",
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  };
}
