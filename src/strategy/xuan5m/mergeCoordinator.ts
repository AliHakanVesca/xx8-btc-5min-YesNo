import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { mergeableShares } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";

export interface MergePlan {
  mergeable: number;
  shouldMerge: boolean;
}

export function planMerge(config: XuanStrategyConfig, state: XuanMarketState): MergePlan {
  const mergeable = mergeableShares(state);
  return {
    mergeable,
    shouldMerge: mergeable >= config.mergeMinShares,
  };
}
