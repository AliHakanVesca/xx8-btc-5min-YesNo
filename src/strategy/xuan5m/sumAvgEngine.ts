import { safeDivide } from "../../utils/math.js";

export function takerFeeUsd(size: number, price: number, feeRate = 0.072): number {
  return size * feeRate * price * (1 - price);
}

export function takerFeePerShare(price: number, feeRate = 0.072): number {
  return feeRate * price * (1 - price);
}

export function pairCostWithBothTaker(askUp: number, askDown: number, feeRate = 0.072): number {
  return askUp + askDown + takerFeePerShare(askUp, feeRate) + takerFeePerShare(askDown, feeRate);
}

export function completionCost(existingAverage: number, completionAsk: number, feeRate = 0.072): number {
  return existingAverage + completionAsk + takerFeePerShare(completionAsk, feeRate);
}

export function maxCompletionAskForCostCap(existingAverage: number, cap: number, feeRate = 0.072): number {
  if (!Number.isFinite(existingAverage) || !Number.isFinite(cap) || cap <= 0) {
    return 0;
  }

  const minPrice = 0.01;
  const maxPrice = 0.99;
  if (completionCost(existingAverage, minPrice, feeRate) > cap + 1e-9) {
    return 0;
  }
  if (completionCost(existingAverage, maxPrice, feeRate) <= cap + 1e-9) {
    return maxPrice;
  }

  let low = minPrice;
  let high = maxPrice;
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2;
    if (completionCost(existingAverage, mid, feeRate) <= cap + 1e-9) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

export function pairEdge(pairCost: number): number {
  return 1 - pairCost;
}

export function isProfitablePair(pairCost: number, cap: number, minEdgePerShare: number): boolean {
  return pairCost <= cap && pairEdge(pairCost) >= minEdgePerShare;
}

export function vwap(totalCost: number, shares: number): number {
  return safeDivide(totalCost, shares);
}
