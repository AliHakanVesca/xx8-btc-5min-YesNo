import { safeDivide } from "../../utils/math.js";
import type { OutcomeSide } from "../../infra/clob/types.js";
import type { FillRecord, InventoryLot, MergeRecord, XuanMarketState } from "./marketState.js";
import { takerFeePerShare } from "./sumAvgEngine.js";

interface ConsumedLots {
  lots: InventoryLot[];
  consumedCost: number;
  consumedSize: number;
}

function cloneLots(lots: InventoryLot[]): InventoryLot[] {
  return lots.map((lot) => ({ ...lot }));
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function consumeLotsFifo(lots: InventoryLot[], requestedSize: number): ConsumedLots {
  let remaining = normalize(requestedSize);
  let consumedCost = 0;
  let consumedSize = 0;
  const nextLots = cloneLots(lots);

  while (remaining > 1e-6 && nextLots.length > 0) {
    const current = nextLots[0]!;
    const takeSize = Math.min(current.size, remaining);
    consumedCost += takeSize * current.price;
    consumedSize += takeSize;
    remaining = normalize(remaining - takeSize);
    current.size = normalize(current.size - takeSize);
    if (current.size <= 1e-6) {
      nextLots.shift();
    }
  }

  return {
    lots: nextLots,
    consumedCost: normalize(consumedCost),
    consumedSize: normalize(consumedSize),
  };
}

function appendLot(lots: InventoryLot[], fill: FillRecord): InventoryLot[] {
  return [
    ...lots,
    {
      size: normalize(fill.size),
      price: fill.price,
      timestamp: fill.timestamp,
      executionMode: fill.executionMode,
    },
  ];
}

function replaceOutcomeState(
  state: XuanMarketState,
  outcome: OutcomeSide,
  lots: InventoryLot[],
  shares: number,
  cost: number,
): XuanMarketState {
  if (outcome === "UP") {
    return {
      ...state,
      upLots: lots,
      upShares: normalize(shares),
      upCost: normalize(cost),
    };
  }
  return {
    ...state,
    downLots: lots,
    downShares: normalize(shares),
    downCost: normalize(cost),
  };
}

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
    const lotsKey = sideKey === "up" ? "upLots" : "downLots";
    next[sharesKey] = normalize(next[sharesKey] + fill.size);
    next[costKey] = normalize(next[costKey] + fill.size * fill.price);
    next[lotsKey] = appendLot(next[lotsKey], fill);
    return next;
  }

  const sharesBefore = next[sharesKey];
  const matchedSize = Math.min(fill.size, sharesBefore);
  const lotsKey = sideKey === "up" ? "upLots" : "downLots";
  const consumed = consumeLotsFifo(next[lotsKey], matchedSize);
  const fallbackAverage = safeDivide(next[costKey], sharesBefore);
  const reducedCost = consumed.consumedSize > 0 ? consumed.consumedCost : fallbackAverage * matchedSize;
  next[sharesKey] = normalize(Math.max(0, sharesBefore - matchedSize));
  next[costKey] = normalize(Math.max(0, next[costKey] - reducedCost));
  next[lotsKey] = consumed.lots;

  return next;
}

export function applyMerge(state: XuanMarketState, merge: MergeRecord): XuanMarketState {
  const matched = Math.min(state.upShares, state.downShares, merge.amount);
  const upConsumed = consumeLotsFifo(state.upLots, matched);
  const downConsumed = consumeLotsFifo(state.downLots, matched);
  const mergeReturn = normalize(matched);
  const realizedPnl = normalize(mergeReturn - upConsumed.consumedCost - downConsumed.consumedCost);
  return {
    ...state,
    upShares: normalize(state.upShares - matched),
    downShares: normalize(state.downShares - matched),
    upCost: normalize(Math.max(0, state.upCost - upConsumed.consumedCost)),
    downCost: normalize(Math.max(0, state.downCost - downConsumed.consumedCost)),
    upLots: upConsumed.lots,
    downLots: downConsumed.lots,
    mergeHistory: [
      ...state.mergeHistory,
      {
        ...merge,
        matchedUpCost: upConsumed.consumedCost,
        matchedDownCost: downConsumed.consumedCost,
        mergeReturn,
        realizedPnl,
        remainingUpShares: normalize(state.upShares - matched),
        remainingDownShares: normalize(state.downShares - matched),
      },
    ],
  };
}

export function shrinkOutcomeToObservedShares(
  state: XuanMarketState,
  outcome: OutcomeSide,
  targetShares: number,
): XuanMarketState {
  const sharesKey = outcome === "UP" ? "upShares" : "downShares";
  const lots = outcome === "UP" ? state.upLots : state.downLots;
  const currentShares = state[sharesKey];
  const normalizedTarget = normalize(Math.max(0, targetShares));
  if (normalizedTarget >= currentShares - 1e-6) {
    return state;
  }

  const shrinkBy = normalize(currentShares - normalizedTarget);
  const consumed = consumeLotsFifo(lots, shrinkBy);
  const currentCost = outcome === "UP" ? state.upCost : state.downCost;
  const averageBefore = averageCost(state, outcome);
  const reducedCost =
    consumed.consumedSize >= shrinkBy - 1e-6
      ? consumed.consumedCost
      : normalize(shrinkBy * averageBefore);
  return replaceOutcomeState(
    state,
    outcome,
    consumed.lots,
    normalizedTarget,
    Math.max(0, currentCost - reducedCost),
  );
}

export function averageCost(state: XuanMarketState, outcome: OutcomeSide): number {
  return outcome === "UP"
    ? safeDivide(state.upCost, state.upShares)
    : safeDivide(state.downCost, state.downShares);
}

export function averageEffectiveCost(state: XuanMarketState, outcome: OutcomeSide, feeRate = 0.072): number {
  const lots = outcome === "UP" ? state.upLots : state.downLots;
  if (lots.length === 0) {
    const rawAverage = averageCost(state, outcome);
    return rawAverage > 0 ? rawAverage + takerFeePerShare(rawAverage, feeRate) : 0;
  }

  const totalShares = lots.reduce((acc, lot) => acc + lot.size, 0);
  const totalEffectiveCost = lots.reduce(
    (acc, lot) => acc + lot.size * (lot.price + takerFeePerShare(lot.price, feeRate)),
    0,
  );
  return safeDivide(totalEffectiveCost, totalShares);
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

export function absoluteShareGap(state: XuanMarketState): number {
  return normalize(Math.abs(state.upShares - state.downShares));
}

export function projectedShareGapAfterBuy(
  state: XuanMarketState,
  sideToBuy: OutcomeSide,
  qty: number,
): number {
  const nextUp = sideToBuy === "UP" ? state.upShares + qty : state.upShares;
  const nextDown = sideToBuy === "DOWN" ? state.downShares + qty : state.downShares;
  return normalize(Math.abs(nextUp - nextDown));
}

export function oldestResidualLotTimestamp(
  state: XuanMarketState,
  sideWithResidual: OutcomeSide,
): number | undefined {
  const leadingLots = cloneLots(sideWithResidual === "UP" ? state.upLots : state.downLots);
  const matchedShares = sideWithResidual === "UP" ? state.downShares : state.upShares;
  const consumed = consumeLotsFifo(leadingLots, matchedShares);
  return consumed.lots[0]?.timestamp;
}
