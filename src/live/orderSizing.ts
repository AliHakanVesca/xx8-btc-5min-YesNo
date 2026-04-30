import type { MarketOrderArgs, OrderResult } from "../infra/clob/types.js";
import { normalizeExecutableBuyOrder } from "../infra/clob/orderPrecision.js";

const DEFAULT_FEE_CUSHION_RATIO = 0.04;
const DEFAULT_MIN_MARKET_BUY_AMOUNT = 1;
const USDC_DECIMALS = 6;
const EPSILON = 1e-9;

export interface AffordableBuyOrderOptions {
  usdcBalance?: number | undefined;
  minOrderSize: number;
  minMarketBuyAmount?: number | undefined;
  sizeLadder?: number[] | undefined;
  feeCushionRatio?: number | undefined;
  allowMinMarketBuyAmountBridge?: boolean | undefined;
  maxMinMarketBuyAmountBridgeOvershootShares?: number | undefined;
}

export interface AffordableBuyOrderResult {
  order?: MarketOrderArgs | undefined;
  requestedShares?: number | undefined;
  finalShares?: number | undefined;
  maxAffordableShares?: number | undefined;
  adjusted: boolean;
  skipped: boolean;
  reason:
    | "not_buy"
    | "no_balance_cap"
    | "missing_price_or_shares"
    | "below_min_order_size"
    | "below_min_market_buy_amount"
    | "fits_balance"
    | "bridged_to_min_market_buy_amount"
    | "downshifted_to_affordable_ladder"
    | "insufficient_balance";
}

export function isNonExecutableResidualBuySizingReason(reason: AffordableBuyOrderResult["reason"]): boolean {
  return reason === "below_min_order_size" || reason === "below_min_market_buy_amount";
}

function normalizeAmount(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

function normalizeShares(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

function ceilToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Number((Math.ceil((value + EPSILON) * factor) / factor).toFixed(decimals));
}

function normalizeCandidateSizes(sizes: number[], minOrderSize: number): number[] {
  const normalized = new Set<number>();
  for (const size of sizes) {
    if (!Number.isFinite(size) || size + EPSILON < minOrderSize) {
      continue;
    }
    normalized.add(normalizeShares(size));
  }
  return [...normalized].sort((left, right) => right - left);
}

function withUserUsdcBalance(order: MarketOrderArgs, usdcBalance: number | undefined): MarketOrderArgs {
  if (usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0) {
    return order;
  }
  return {
    ...order,
    userUsdcBalance: normalizeAmount(usdcBalance),
  };
}

function orderCostWithCushion(amount: number, feeCushionRatio: number): number {
  return normalizeAmount(amount * (1 + Math.max(0, feeCushionRatio)));
}

function isExactShareLimitRoutedBuy(order: MarketOrderArgs, minOrderSize: number): boolean {
  return (
    order.side === "BUY" &&
    order.price !== undefined &&
    order.shareTarget !== undefined &&
    Number.isFinite(order.price) &&
    Number.isFinite(order.shareTarget) &&
    order.price > 0 &&
    order.shareTarget >= minOrderSize - EPSILON &&
    minOrderSize >= 1 - EPSILON
  );
}

function resizedBuyOrder(order: MarketOrderArgs, shareTarget: number, price: number, usdcBalance: number): MarketOrderArgs {
  return withUserUsdcBalance(
    normalizeExecutableBuyOrder({
      ...order,
      shareTarget: normalizeShares(shareTarget),
      amount: normalizeAmount(shareTarget * price),
    }),
    usdcBalance,
  );
}

function minSharesForMarketBuyAmount(price: number, minMarketBuyAmount: number): number {
  let shareTarget = ceilToDecimals(minMarketBuyAmount / price, 4);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const normalized = normalizeExecutableBuyOrder({
      tokenId: "sizing-probe",
      side: "BUY",
      amount: normalizeAmount(shareTarget * price),
      shareTarget,
      price,
      orderType: "FAK",
    });
    if (normalized.amount + EPSILON >= minMarketBuyAmount && normalized.shareTarget !== undefined) {
      return normalizeShares(shareTarget);
    }
    shareTarget = ceilToDecimals(shareTarget + 0.0001, 4);
  }
  return normalizeShares(shareTarget);
}

export function fitBuyOrderToUsdcBalance(
  order: MarketOrderArgs,
  options: AffordableBuyOrderOptions,
): AffordableBuyOrderResult {
  if (order.side !== "BUY") {
    return {
      order,
      adjusted: false,
      skipped: false,
      reason: "not_buy",
    };
  }

  const usdcBalance = options.usdcBalance;
  const minMarketBuyAmount = Math.max(0, options.minMarketBuyAmount ?? DEFAULT_MIN_MARKET_BUY_AMOUNT);
  if (usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0) {
    return {
      order,
      adjusted: false,
      skipped: false,
      reason: "no_balance_cap",
    };
  }

  const price = order.price;
  const requestedShares = order.shareTarget;
  if (
    price === undefined ||
    requestedShares === undefined ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(requestedShares) ||
    requestedShares <= 0
  ) {
    if (order.amount + EPSILON < minMarketBuyAmount) {
      return {
        adjusted: false,
        skipped: true,
        reason: "below_min_market_buy_amount",
      };
    }
    const fitsAmount = orderCostWithCushion(order.amount, options.feeCushionRatio ?? DEFAULT_FEE_CUSHION_RATIO) <= usdcBalance + EPSILON;
    return fitsAmount
      ? {
          order: withUserUsdcBalance(order, usdcBalance),
          adjusted: false,
          skipped: false,
          reason: "fits_balance",
        }
      : {
          adjusted: false,
          skipped: true,
          reason: "missing_price_or_shares",
      };
  }

  const feeCushionRatio = options.feeCushionRatio ?? DEFAULT_FEE_CUSHION_RATIO;
  const minOrderSize = Math.max(0, options.minOrderSize);
  const exactShareLimitRoutedBuy = isExactShareLimitRoutedBuy(order, minOrderSize);
  const normalizedRequestedOrder = normalizeExecutableBuyOrder(order);
  const normalizedRequestedAmount = normalizedRequestedOrder.amount;
  const normalizedRequestedShares = normalizeShares(normalizedRequestedOrder.shareTarget ?? requestedShares);
  const requestedCost = orderCostWithCushion(normalizedRequestedAmount, feeCushionRatio);
  const maxAffordableShares = normalizeShares(usdcBalance / (price * (1 + Math.max(0, feeCushionRatio))));

  if (normalizedRequestedShares + EPSILON < minOrderSize) {
    return {
      requestedShares: normalizedRequestedShares,
      maxAffordableShares,
      adjusted: false,
      skipped: true,
      reason: "below_min_order_size",
    };
  }

  if (!exactShareLimitRoutedBuy && normalizedRequestedAmount + EPSILON < minMarketBuyAmount) {
    const bridgedShares = minSharesForMarketBuyAmount(price, minMarketBuyAmount);
    const bridgeOvershootShares = normalizeShares(bridgedShares - normalizedRequestedShares);
    const maxBridgeOvershootShares = Math.max(0, options.maxMinMarketBuyAmountBridgeOvershootShares ?? 0);
    if (
      options.allowMinMarketBuyAmountBridge === true &&
      bridgedShares >= minOrderSize - EPSILON &&
      bridgedShares <= maxAffordableShares + EPSILON &&
      bridgeOvershootShares <= maxBridgeOvershootShares + EPSILON
    ) {
      const bridgedOrder = withUserUsdcBalance(
        normalizeExecutableBuyOrder({
          ...order,
          amount: normalizeAmount(bridgedShares * price),
          shareTarget: bridgedShares,
        }),
        usdcBalance,
      );
      return {
        order: bridgedOrder,
        requestedShares: normalizedRequestedShares,
        finalShares: normalizeShares(bridgedOrder.shareTarget ?? bridgedShares),
        maxAffordableShares,
        adjusted: true,
        skipped: false,
        reason: "bridged_to_min_market_buy_amount",
      };
    }
    return {
      requestedShares: normalizedRequestedShares,
      maxAffordableShares,
      adjusted: false,
      skipped: true,
      reason: "below_min_market_buy_amount",
    };
  }

  if (requestedCost <= usdcBalance + EPSILON) {
    return {
      order: withUserUsdcBalance(normalizedRequestedOrder, usdcBalance),
      requestedShares: normalizedRequestedShares,
      finalShares: normalizeShares(normalizedRequestedOrder.shareTarget ?? normalizedRequestedShares),
      maxAffordableShares,
      adjusted: false,
      skipped: false,
      reason: "fits_balance",
    };
  }

  const candidates = normalizeCandidateSizes(
    [
      ...(options.sizeLadder ?? []),
      requestedShares,
      minOrderSize,
    ],
    minOrderSize,
  ).filter((candidate) => candidate <= requestedShares + EPSILON && candidate <= maxAffordableShares + EPSILON);
  const finalShares = candidates[0];
  if (finalShares === undefined || finalShares + EPSILON < minOrderSize) {
    return {
      requestedShares: normalizeShares(requestedShares),
      maxAffordableShares,
      adjusted: false,
      skipped: true,
      reason: "insufficient_balance",
    };
  }

  return {
    order: resizedBuyOrder(order, finalShares, price, usdcBalance),
    requestedShares: normalizeShares(requestedShares),
    finalShares,
    maxAffordableShares,
    adjusted: finalShares < requestedShares - EPSILON,
    skipped: false,
    reason: "downshifted_to_affordable_ladder",
  };
}

export function assignAffordableSequentialUsdcBalances(
  orders: MarketOrderArgs[],
  options: AffordableBuyOrderOptions,
): MarketOrderArgs[] {
  let remainingBalance = options.usdcBalance;
  const affordableOrders: MarketOrderArgs[] = [];
  for (const order of orders) {
    const result = fitBuyOrderToUsdcBalance(order, {
      ...options,
      usdcBalance: remainingBalance,
    });
    if (!result.order) {
      break;
    }
    affordableOrders.push(result.order);
    if (remainingBalance !== undefined && Number.isFinite(remainingBalance) && result.order.side === "BUY") {
      remainingBalance = debitBuyOrderFromUsdcBalance(remainingBalance, result.order, options.feeCushionRatio);
    }
  }
  return affordableOrders;
}

export function debitBuyOrderFromUsdcBalance(
  usdcBalance: number | undefined,
  order: MarketOrderArgs,
  feeCushionRatio = DEFAULT_FEE_CUSHION_RATIO,
): number | undefined {
  if (usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0 || order.side !== "BUY") {
    return usdcBalance;
  }
  return normalizeAmount(Math.max(0, usdcBalance - orderCostWithCushion(order.amount, feeCushionRatio)));
}

function findErrorText(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["error", "message", "errorMsg"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  for (const value of Object.values(record)) {
    const nested = findErrorText(value);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function extractInsufficientBalanceUsdc(result: Pick<OrderResult, "raw">): number | undefined {
  const errorText = findErrorText(result.raw);
  if (!errorText || !/not enough balance/i.test(errorText)) {
    return undefined;
  }
  const matched = /balance:\s*(\d+)/i.exec(errorText);
  if (!matched) {
    return undefined;
  }
  const microUsdc = Number(matched[1]);
  if (!Number.isFinite(microUsdc) || microUsdc < 0) {
    return undefined;
  }
  return normalizeAmount(microUsdc / 10 ** USDC_DECIMALS);
}
