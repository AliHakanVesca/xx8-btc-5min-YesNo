import { safeDivide } from "../../utils/math.js";
import type { OutcomeSide } from "../../infra/clob/types.js";
import type { FillRecord, MergeRecord, XuanMarketState } from "./marketState.js";

export function applyFill(state: XuanMarketState, fill: FillRecord): XuanMarketState {
  const next = {
    ...state,
    fillHistory: [...state.fillHistory, fill],
    lastFilledSide: fill.outcome,
  };

  if (fill.outcome === "UP") {
    next.upShares += fill.size;
    next.upCost += fill.size * fill.price;
  } else {
    next.downShares += fill.size;
    next.downCost += fill.size * fill.price;
  }

  return next;
}

export function applyMerge(state: XuanMarketState, merge: MergeRecord): XuanMarketState {
  const matched = Math.min(state.upShares, state.downShares, merge.amount);
  return {
    ...state,
    upShares: state.upShares - matched,
    downShares: state.downShares - matched,
    mergeHistory: [...state.mergeHistory, merge],
  };
}

export function averageCost(state: XuanMarketState, outcome: OutcomeSide): number {
  return outcome === "UP"
    ? safeDivide(state.upCost, state.upShares)
    : safeDivide(state.downCost, state.downShares);
}

export function pairVwapSum(state: XuanMarketState): number {
  return averageCost(state, "UP") + averageCost(state, "DOWN");
}

export function mergeableShares(state: XuanMarketState): number {
  return Math.min(state.upShares, state.downShares);
}

export function imbalance(state: XuanMarketState): number {
  return safeDivide(Math.abs(state.upShares - state.downShares), Math.max(state.upShares + state.downShares, 1));
}
