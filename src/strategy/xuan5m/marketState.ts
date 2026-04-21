import type { MarketInfo, OutcomeSide, TradeSide } from "../../infra/clob/types.js";

export interface FillRecord {
  outcome: OutcomeSide;
  side: TradeSide;
  price: number;
  size: number;
  timestamp: number;
  makerTaker: "maker" | "taker" | "unknown";
}

export interface MergeRecord {
  amount: number;
  timestamp: number;
  simulated: boolean;
}

export interface XuanMarketState {
  market: MarketInfo;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  openOrderIds: string[];
  fillHistory: FillRecord[];
  mergeHistory: MergeRecord[];
  cycleNo: number;
  lastFilledSide?: OutcomeSide;
  stuckSide?: OutcomeSide;
  reentryDisabled: boolean;
}

export function createMarketState(market: MarketInfo): XuanMarketState {
  return {
    market,
    upShares: 0,
    downShares: 0,
    upCost: 0,
    downCost: 0,
    openOrderIds: [],
    fillHistory: [],
    mergeHistory: [],
    cycleNo: 0,
    reentryDisabled: false,
  };
}
