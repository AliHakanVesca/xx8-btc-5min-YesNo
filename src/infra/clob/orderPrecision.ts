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

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

export function normalizePositiveAmount(value: number): number {
  return Number(Math.max(0, value).toFixed(DEFAULT_DECIMALS));
}

export function normalizePositiveShares(value: number): number {
  return Number(Math.max(0, value).toFixed(DEFAULT_DECIMALS));
}

export function normalizeLimitBuyShareTarget(args: {
  shareTarget: number;
  price: number;
}): number {
  if (
    !Number.isFinite(args.shareTarget) ||
    !Number.isFinite(args.price) ||
    args.shareTarget <= 0 ||
    args.price <= 0
  ) {
    return 0;
  }

  const priceCents = Math.round(args.price * 10 ** MARKET_BUY_MAKER_DECIMALS);
  const priceIsCentTick = Math.abs(priceCents / 10 ** MARKET_BUY_MAKER_DECIMALS - args.price) <= 1e-9;
  if (!priceIsCentTick || priceCents <= 0) {
    return floorToDecimals(args.shareTarget, MARKET_BUY_TAKER_DECIMALS);
  }

  const takerScale = 10 ** MARKET_BUY_TAKER_DECIMALS;
  const units = Math.floor((args.shareTarget + EPSILON) * takerScale);
  const stepUnits = takerScale / gcd(priceCents, takerScale);
  const normalizedUnits = Math.floor(units / stepUnits) * stepUnits;
  return Number((Math.max(0, normalizedUnits) / takerScale).toFixed(MARKET_BUY_TAKER_DECIMALS));
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

  const maxAmount = floorToDecimals(args.shareTarget * args.price, MARKET_BUY_MAKER_DECIMALS);
  const shareTarget = normalizeLimitBuyShareTarget({
    shareTarget: Math.min(args.shareTarget, maxAmount / args.price),
    price: args.price,
  });
  const amount = floorToDecimals(shareTarget * args.price, MARKET_BUY_MAKER_DECIMALS);
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
