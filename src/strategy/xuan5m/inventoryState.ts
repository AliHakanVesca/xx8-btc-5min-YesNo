import { safeDivide } from "../../utils/math.js";
import type { OutcomeSide } from "../../infra/clob/types.js";
import type { FillRecord, MergeRecord, XuanMarketState } from "./marketState.js";

export function applyFill(state: XuanMarketState, fill: FillRecord): XuanMarketState {
  const next = {
    ...state,
    fillHistory: [...state.fillHistory, fill],
    lastFilledSide: fill.outcome,
  };

  const sideKey = fill.outcome === "UP" ? "up" : "down";
  const sharesKey = sideKey === "up" ? "upShares" : "downShares";
  const costKey = sideKey === "up" ? "upCost" : "downCost";

  if (fill.side === "BUY") {
    next[sharesKey] += fill.size;
    next[costKey] += fill.size * fill.price;
    return next;
  }

  const sharesBefore = next[sharesKey];
  const matchedSize = Math.min(fill.size, sharesBefore);
  const averageBefore = safeDivide(next[costKey], sharesBefore);
  next[sharesKey] = Math.max(0, sharesBefore - matchedSize);
  next[costKey] = Math.max(0, next[costKey] - averageBefore * matchedSize);

  return next;
}

export function applyMerge(state: XuanMarketState, merge: MergeRecord): XuanMarketState {
  const matched = Math.min(state.upShares, state.downShares, merge.amount);
  const upAverage = averageCost(state, "UP");
  const downAverage = averageCost(state, "DOWN");
  return {
    ...state,
    upShares: state.upShares - matched,
    downShares: state.downShares - matched,
    upCost: Math.max(0, state.upCost - upAverage * matched),
    downCost: Math.max(0, state.downCost - downAverage * matched),
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
