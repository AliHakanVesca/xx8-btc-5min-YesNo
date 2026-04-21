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

export function pairEdge(pairCost: number): number {
  return 1 - pairCost;
}

export function isProfitablePair(pairCost: number, cap: number, minEdgePerShare: number): boolean {
  return pairCost <= cap && pairEdge(pairCost) >= minEdgePerShare;
}

export function vwap(totalCost: number, shares: number): number {
  return safeDivide(totalCost, shares);
}
