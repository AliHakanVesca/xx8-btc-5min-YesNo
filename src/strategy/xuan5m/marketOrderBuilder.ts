import type { MarketOrderArgs, OutcomeSide, TakerOrderType } from "../../infra/clob/types.js";
import type { XuanMarketState } from "./marketState.js";

function normalizeAmount(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

export function buildTakerBuyOrder(args: {
  state: XuanMarketState;
  side: OutcomeSide;
  shareTarget: number;
  limitPrice: number;
  orderType?: TakerOrderType;
  metadata?: string;
}): MarketOrderArgs {
  const spendAmount = normalizeAmount(args.shareTarget * args.limitPrice);
  return {
    tokenId: args.state.market.tokens[args.side].tokenId,
    side: "BUY",
    amount: spendAmount,
    shareTarget: normalizeAmount(args.shareTarget),
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
    amount: normalizeAmount(args.shareTarget),
    shareTarget: normalizeAmount(args.shareTarget),
    price: args.limitPrice,
    orderType: args.orderType ?? "FAK",
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  };
}
