import type { MarketOrderArgs } from "./types.js";

const MARKET_BUY_MAKER_DECIMALS = 2;
const MARKET_BUY_TAKER_DECIMALS = 4;
const DEFAULT_DECIMALS = 6;
const EPSILON = 1e-12;

function floorToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Number((Math.floor((value + EPSILON) * factor) / factor).toFixed(decimals));
}

export function normalizePositiveAmount(value: number): number {
  return Number(Math.max(0, value).toFixed(DEFAULT_DECIMALS));
}

export function normalizePositiveShares(value: number): number {
  return Number(Math.max(0, value).toFixed(DEFAULT_DECIMALS));
}

export function normalizeClobMarketBuy(args: {
  shareTarget: number;
  price: number;
}): { amount: number; shareTarget: number } {
  if (
    !Number.isFinite(args.shareTarget) ||
    !Number.isFinite(args.price) ||
    args.shareTarget <= 0 ||
    args.price <= 0
  ) {
    return { amount: 0, shareTarget: 0 };
  }

  const amount = floorToDecimals(args.shareTarget * args.price, MARKET_BUY_MAKER_DECIMALS);
  const shareTarget = floorToDecimals(Math.min(args.shareTarget, amount / args.price), MARKET_BUY_TAKER_DECIMALS);
  return { amount, shareTarget };
}

export function normalizeExecutableBuyOrder(order: MarketOrderArgs): MarketOrderArgs {
  if (
    order.side !== "BUY" ||
    order.price === undefined ||
    order.shareTarget === undefined ||
    !Number.isFinite(order.price) ||
    !Number.isFinite(order.shareTarget) ||
    order.price <= 0 ||
    order.shareTarget <= 0
  ) {
    return {
      ...order,
      amount: normalizePositiveAmount(order.amount),
      ...(order.shareTarget !== undefined ? { shareTarget: normalizePositiveShares(order.shareTarget) } : {}),
    };
  }

  const normalized = normalizeClobMarketBuy({
    shareTarget: order.shareTarget,
    price: order.price,
  });
  return {
    ...order,
    amount: normalized.amount,
    shareTarget: normalized.shareTarget,
  };
}
