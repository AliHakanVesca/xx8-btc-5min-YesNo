import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { resolveBundledSeedSequencePrior } from "../../analytics/xuanExactReference.js";

export interface LotContext {
  marketSlug?: string;
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
  const cloneBase = baseLots[0] ?? clippedBase;
  const cloneMid = baseLots[1] ?? cloneBase;
  const cloneHigh = baseLots[2] ?? cloneMid;
  const cloneMax = baseLots[3] ?? cloneHigh;
  const sequencePrior =
    ctx.marketSlug && config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? resolveBundledSeedSequencePrior(ctx.marketSlug, ctx.secsFromOpen)
      : undefined;
  if (ctx.dryRunOrSmallLive && config.xuanCloneMode !== "PUBLIC_FOOTPRINT") {
    return clippedBase;
  }

  if (config.lotScalingMode === "BANKROLL_ADJUSTED") {
    if (ctx.imbalance >= config.forceRebalanceImbalanceFrac) {
      return clippedBase;
    }
    if (config.xuanCloneMode === "PUBLIC_FOOTPRINT") {
    if (!ctx.inventoryBalanced) {
      return cloneBase;
    }
    if (
      sequencePrior?.phase === "ENTRY" &&
      ctx.secsFromOpen <= sequencePrior.activeUntilSec + 1e-9 &&
      ctx.bookDepthGood
    ) {
      return cloneMax;
    }
    if (ctx.secsFromOpen < 45) {
      if (!ctx.bookDepthGood) {
        return cloneBase;
        }
        return ctx.pairCostWithinCap ? cloneHigh : cloneMid;
      }
      if (ctx.secsFromOpen < 150 && ctx.recentBothSidesFilled && ctx.bookDepthGood) {
        return ctx.pairCostComfortable ? cloneMax : cloneHigh;
      }
      if (ctx.marketVolumeHigh && ctx.bookDepthGood) {
        if (ctx.pairCostComfortable && ctx.pnlTodayPositive) {
          return cloneHigh;
        }
        return cloneMid;
      }
      return cloneBase;
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
