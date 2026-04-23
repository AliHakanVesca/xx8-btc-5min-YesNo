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
  const smallLots = config.liveSmallLotLadder.length > 0 ? config.liveSmallLotLadder : config.liveSmallLots;
  const baseLots = config.xuanBaseLotLadder.length > 0 ? config.xuanBaseLotLadder : config.lotLadder;
  const clippedBase = smallLots[0] ?? config.defaultLot;
  const clippedMid = smallLots[1] ?? clippedBase;
  const clippedHigh = smallLots[2] ?? clippedMid;
  if (ctx.dryRunOrSmallLive) {
    return clippedBase;
  }

  if (config.lotScalingMode === "BANKROLL_ADJUSTED") {
    if (ctx.imbalance >= config.forceRebalanceImbalanceFrac) {
      return clippedBase;
    }
    if (!ctx.pairCostWithinCap) {
      return clippedBase;
    }
    if (!ctx.inventoryBalanced) {
      return clippedBase;
    }
    if (ctx.secsFromOpen < 45) {
      return clippedMid;
    }
    if (ctx.secsFromOpen < 150 && ctx.recentBothSidesFilled && ctx.bookDepthGood) {
      return clippedHigh;
    }
    if (ctx.marketVolumeHigh && ctx.pairCostComfortable && ctx.pnlTodayPositive) {
      return clippedMid;
    }
    return clippedBase;
  }

  if (ctx.imbalance >= config.forceRebalanceImbalanceFrac) {
    return clippedBase;
  }
  if (ctx.secsFromOpen < 45 && ctx.bookDepthGood && ctx.pairCostWithinCap) {
    return baseLots[1] ?? config.defaultLot;
  }
  if (ctx.secsFromOpen < 120 && ctx.pairCostWithinCap && ctx.recentBothSidesFilled) {
    return baseLots[2] ?? config.defaultLot;
  }
  if (
    ctx.inventoryBalanced &&
    ctx.pairCostComfortable &&
    ctx.marketVolumeHigh &&
    ctx.pnlTodayPositive &&
    ctx.bookDepthGood
  ) {
    return baseLots[3] ?? config.defaultLot;
  }
  if (ctx.inventoryBalanced && ctx.pairCostWithinCap) {
    return baseLots[2] ?? config.defaultLot;
  }
  return config.defaultLot;
}
