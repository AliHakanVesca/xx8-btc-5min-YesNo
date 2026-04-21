import type { XuanStrategyConfig } from "../../config/strategyPresets.js";

export interface LotContext {
  dryRunOrSmallLive: boolean;
  secsFromOpen: number;
  imbalance: number;
  bookDepthGood: boolean;
  pairCostWithinCap: boolean;
  pairCostComfortable: boolean;
  inventoryBalanced: boolean;
  recentBothSidesFilled: boolean;
  marketVolumeHigh: boolean;
  pnlTodayPositive: boolean;
}

export function chooseLot(config: XuanStrategyConfig, ctx: LotContext): number {
  if (ctx.dryRunOrSmallLive) {
    return config.liveSmallLots[0] ?? config.defaultLot;
  }
  if (ctx.imbalance >= config.forceRebalanceImbalanceFrac) {
    return config.liveSmallLots[0] ?? config.defaultLot;
  }
  if (ctx.secsFromOpen < 45 && ctx.bookDepthGood && ctx.pairCostWithinCap) {
    return config.lotLadder[1] ?? config.defaultLot;
  }
  if (ctx.secsFromOpen < 120 && ctx.pairCostWithinCap && ctx.recentBothSidesFilled) {
    return config.lotLadder[2] ?? config.defaultLot;
  }
  if (
    ctx.inventoryBalanced &&
    ctx.pairCostComfortable &&
    ctx.marketVolumeHigh &&
    ctx.pnlTodayPositive &&
    ctx.bookDepthGood
  ) {
    return config.lotLadder[4] ?? config.defaultLot;
  }
  if (ctx.inventoryBalanced && ctx.pairCostWithinCap) {
    return config.lotLadder[3] ?? config.defaultLot;
  }
  return config.defaultLot;
}
