import type { MarketInfo, OutcomeSide, TradeSide } from "../../infra/clob/types.js";
import type { StrategyExecutionMode } from "./executionModes.js";

export interface InventoryLot {
  size: number;
  price: number;
  timestamp: number;
  executionMode?: StrategyExecutionMode | undefined;
}

export interface FillRecord {
  outcome: OutcomeSide;
  side: TradeSide;
  price: number;
  size: number;
  timestamp: number;
  makerTaker: "maker" | "taker" | "unknown";
  executionMode?: StrategyExecutionMode | undefined;
}

export interface MergeRecord {
  amount: number;
  timestamp: number;
  simulated: boolean;
  matchedUpCost?: number | undefined;
  matchedDownCost?: number | undefined;
  mergeReturn?: number | undefined;
  realizedPnl?: number | undefined;
  remainingUpShares?: number | undefined;
  remainingDownShares?: number | undefined;
}

export interface XuanMarketState {
  market: MarketInfo;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upLots: InventoryLot[];
  downLots: InventoryLot[];
  openOrderIds: string[];
  fillHistory: FillRecord[];
  mergeHistory: MergeRecord[];
  cycleNo: number;
  negativeEdgeConsumedUsdc: number;
  negativePairEdgeConsumedUsdc: number;
  negativeCompletionEdgeConsumedUsdc: number;
  lastFilledSide?: OutcomeSide;
  stuckSide?: OutcomeSide;
  lastExecutionMode?: StrategyExecutionMode | undefined;
  consecutiveSeedSide?: OutcomeSide | undefined;
  consecutiveSeedCount: number;
  reentryDisabled: boolean;
  postMergeCompletionOnlyUntil?: number | undefined;
}

export function createMarketState(market: MarketInfo): XuanMarketState {
  return {
    market,
    upShares: 0,
    downShares: 0,
    upCost: 0,
    downCost: 0,
    upLots: [],
    downLots: [],
    openOrderIds: [],
    fillHistory: [],
    mergeHistory: [],
    cycleNo: 0,
    negativeEdgeConsumedUsdc: 0,
    negativePairEdgeConsumedUsdc: 0,
    negativeCompletionEdgeConsumedUsdc: 0,
    consecutiveSeedCount: 0,
    reentryDisabled: false,
  };
}
