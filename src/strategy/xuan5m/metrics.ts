import { average } from "../../utils/math.js";
import { imbalance, pairVwapSum } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";

export interface AcceptanceSnapshot {
  marketCount: number;
  medianImbalance: number;
  averagePairVwapSum: number;
}

export function buildAcceptanceSnapshot(states: XuanMarketState[]): AcceptanceSnapshot {
  return {
    marketCount: states.length,
    medianImbalance: average(states.map((state) => imbalance(state))),
    averagePairVwapSum: average(states.map((state) => pairVwapSum(state))),
  };
}
