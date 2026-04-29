import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { resolveBundledSeedSequencePrior } from "../../analytics/xuanExactReference.js";
import { deriveFlowPressureBudgetState, type FlowPressureBudgetState } from "./modePolicy.js";
import { classifyXuanLotFamily } from "./xuanLotFamilyClassifier.js";

export interface LotContext {
  marketSlug?: string | undefined;
  dryRunOrSmallLive: boolean;
  secsFromOpen: number;
  imbalance: number;
  residualSeverityLevel?: "flat" | "micro" | "small" | "medium" | "aggressive" | undefined;
  residualSeverityPressure?: number | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  flowPressureState?: FlowPressureBudgetState | undefined;
  arbitrationCarryAlignmentStreak?: number | undefined;
  arbitrationCarryFlowConfidence?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  bookDepthGood: boolean;
  bestAskUp?: number | undefined;
  bestAskDown?: number | undefined;
  topTwoAskDepthMin?: number | undefined;
  flatPosition?: boolean | undefined;
  postMergeCount?: number | undefined;
  totalShares?: number | undefined;
  pairCostWithinCap: boolean;
  pairCostComfortable: boolean;
  pairGatePressure?: number | undefined;
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
  const cloneApex = baseLots[4] ?? cloneMax;
  const capAggressivePublicFootprintLot = (lot: number): number =>
    config.xuanCloneIntensity === "AGGRESSIVE" ? Number(Math.min(lot, cloneMax).toFixed(6)) : Number(lot.toFixed(6));
  const pairGatePressure = Math.max(0, ctx.pairGatePressure ?? (ctx.pairCostWithinCap ? 0 : 1));
  const mildPairGate = pairGatePressure <= 0.55;
  const permissivePairGate = pairGatePressure <= 0.85;
  const effectiveFlowDensity = Math.max(ctx.recentSeedFlowCount ?? 0, ctx.activeIndependentFlowCount ?? 0);
  const arbitrationCarryAlignmentStreak = Math.max(0, ctx.arbitrationCarryAlignmentStreak ?? 0);
  const arbitrationCarryFlowConfidence = Math.max(
    0,
    ctx.arbitrationCarryFlowConfidence ??
      (arbitrationCarryAlignmentStreak >= 3 ? 0.9 : arbitrationCarryAlignmentStreak >= 2 ? 0.8 : 0),
  );
  const matchedInventoryQuality = Math.max(0, ctx.matchedInventoryQuality ?? 0);
  const flowPressureState =
    ctx.flowPressureState ??
    deriveFlowPressureBudgetState({
      carryFlowConfidence: arbitrationCarryFlowConfidence,
      matchedInventoryQuality,
      recentSeedFlowCount: ctx.recentSeedFlowCount,
      activeIndependentFlowCount: ctx.activeIndependentFlowCount,
      residualSeverityPressure: ctx.residualSeverityPressure,
    });
  const confirmedCarryBias =
    flowPressureState.confirmed &&
    flowPressureState.remainingBudget >= 0.45 &&
    arbitrationCarryFlowConfidence >= 0.72;
  const strongCarryBias =
    flowPressureState.elite &&
    flowPressureState.remainingBudget >= 0.65 &&
    arbitrationCarryFlowConfidence >= 0.9;
  const alignedCarryBias =
    arbitrationCarryAlignmentStreak >= 2 &&
    flowPressureState.confirmed &&
    effectiveFlowDensity >= 1 &&
    ctx.bookDepthGood &&
    (ctx.residualSeverityLevel === "micro" || ctx.residualSeverityLevel === "small" || ctx.residualSeverityLevel === "medium");
  const denseAlignedCarryBias =
    arbitrationCarryAlignmentStreak >= 3 &&
    flowPressureState.elite &&
    effectiveFlowDensity >= 2 &&
    ctx.bookDepthGood &&
    ctx.marketVolumeHigh;
  const highQualityMatchedInventory = matchedInventoryQuality >= 0.85;
  const eliteQualityMatchedInventory = matchedInventoryQuality >= 1;
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
      const microResidualStackBias =
        ctx.residualSeverityLevel === "micro" && ctx.recentBothSidesFilled && ctx.bookDepthGood;
      const smallResidualStackBias =
        (ctx.residualSeverityLevel === "micro" || ctx.residualSeverityLevel === "small") &&
        effectiveFlowDensity >= 1 &&
        ctx.bookDepthGood;
      const mediumResidualStackBias =
        ctx.residualSeverityLevel === "medium" &&
        effectiveFlowDensity >= 2 &&
        ctx.bookDepthGood &&
        ctx.marketVolumeHigh;
      const continuousStackBias =
        (ctx.residualSeverityPressure ?? 1) <= 0.55 &&
        effectiveFlowDensity >= 1 &&
        ctx.bookDepthGood &&
        ctx.marketVolumeHigh;
      const xuanFamilyLot = classifyXuanLotFamily(config, ctx);
      if (xuanFamilyLot !== undefined) {
        return capAggressivePublicFootprintLot(xuanFamilyLot.lot);
      }
      if (!ctx.inventoryBalanced) {
        return cloneBase;
      }
      const aggressiveUnknownLargeOpening =
        config.xuanCloneIntensity === "AGGRESSIVE" &&
        ctx.flatPosition === true &&
        (ctx.postMergeCount ?? 0) === 0 &&
        ctx.secsFromOpen >= 10 &&
        ctx.secsFromOpen < 25 &&
        (ctx.topTwoAskDepthMin ?? 0) >= Math.max(500, cloneMax * 2.5) &&
        Math.max(ctx.bestAskUp ?? 1, ctx.bestAskDown ?? 1) <= 0.56 + 1e-9 &&
        Math.min(ctx.bestAskUp ?? 0, ctx.bestAskDown ?? 0) >= 0.44 - 1e-9;
      if (aggressiveUnknownLargeOpening) {
        return cloneMax;
      }
      const aggressivePostMergeLargeRecycle =
        config.xuanCloneIntensity === "AGGRESSIVE" &&
        ctx.flatPosition === true &&
        (ctx.postMergeCount ?? 0) > 0 &&
        ctx.secsFromOpen >= 210 &&
        ctx.secsFromOpen < 276 &&
        Math.max(ctx.bestAskUp ?? 1, ctx.bestAskDown ?? 1) <= 0.82 + 1e-9 &&
        Math.min(ctx.bestAskUp ?? 0, ctx.bestAskDown ?? 0) >= 0.18 - 1e-9;
      if (aggressivePostMergeLargeRecycle) {
        return Number(Math.max(cloneMax, cloneApex * 0.963).toFixed(6));
      }
      const aggressiveBalancedLargeContinuation =
        config.xuanCloneIntensity === "AGGRESSIVE" &&
        ctx.inventoryBalanced &&
        ctx.recentBothSidesFilled &&
        (ctx.totalShares ?? Number.POSITIVE_INFINITY) >= cloneMax * 1.75 &&
        matchedInventoryQuality >= 1.2 &&
        ctx.secsFromOpen >= 40 &&
        ctx.secsFromOpen < 185 &&
        ctx.marketVolumeHigh &&
        Math.max(ctx.bestAskUp ?? 1, ctx.bestAskDown ?? 1) <= 0.82 + 1e-9 &&
        Math.min(ctx.bestAskUp ?? 0, ctx.bestAskDown ?? 0) >= 0.18 - 1e-9 &&
        permissivePairGate;
      if (aggressiveBalancedLargeContinuation) {
        return cloneMax;
      }
      const aggressiveSmallLateHighLowContinuation =
        config.xuanCloneIntensity === "AGGRESSIVE" &&
        ctx.inventoryBalanced &&
        ctx.recentBothSidesFilled &&
        (ctx.totalShares ?? 0) >= cloneBase * 8 - 1e-9 &&
        ctx.secsFromOpen >= 158 &&
        ctx.secsFromOpen < 185 &&
        Math.max(ctx.bestAskUp ?? 0, ctx.bestAskDown ?? 0) >= 0.88 - 1e-9 &&
        Math.min(ctx.bestAskUp ?? 1, ctx.bestAskDown ?? 1) <= 0.15 + 1e-9;
      if (aggressiveSmallLateHighLowContinuation) {
        return cloneMid;
      }
      if (
        sequencePrior &&
        ctx.secsFromOpen >= sequencePrior.activeFromSec - 1e-9 &&
        ctx.secsFromOpen <= sequencePrior.activeUntilSec + 1e-9 &&
        ctx.bookDepthGood
      ) {
        if (sequencePrior.scope === "exact") {
          return capAggressivePublicFootprintLot(sequencePrior.qty);
        }
        if (config.xuanCloneIntensity === "AGGRESSIVE" && ctx.secsFromOpen < 160) {
          return cloneBase;
        }
        return capAggressivePublicFootprintLot(
          familySequencePriorLot({
            secsFromOpen: ctx.secsFromOpen,
            priorQty: sequencePrior.qty,
            cloneBase,
            cloneHigh,
            cloneMax,
          }),
        );
      }
      if (config.xuanCloneIntensity === "AGGRESSIVE" && ctx.secsFromOpen < 160) {
        return cloneBase;
      }
      if (ctx.secsFromOpen < 20) {
        if (!ctx.bookDepthGood) {
          return cloneMid;
        }
        return ctx.pairCostComfortable || mildPairGate ? cloneMax : cloneHigh;
      }
      if (ctx.secsFromOpen < 60) {
        if (!ctx.bookDepthGood) {
          return cloneBase;
        }
        if ((alignedCarryBias || denseAlignedCarryBias) && highQualityMatchedInventory && permissivePairGate) {
          if (!confirmedCarryBias) {
            return cloneMid;
          }
          return denseAlignedCarryBias && strongCarryBias && eliteQualityMatchedInventory ? cloneMax : cloneHigh;
        }
        if ((microResidualStackBias || smallResidualStackBias || continuousStackBias) && ctx.marketVolumeHigh) {
          return cloneHigh;
        }
        return permissivePairGate ? cloneHigh : cloneMid;
      }
      if (ctx.secsFromOpen < 120) {
        if (!ctx.bookDepthGood) {
          return cloneBase;
        }
        if ((alignedCarryBias || denseAlignedCarryBias) && ctx.marketVolumeHigh && highQualityMatchedInventory && permissivePairGate) {
          if (!confirmedCarryBias) {
            return cloneBase;
          }
          return denseAlignedCarryBias && eliteQualityMatchedInventory && strongCarryBias ? cloneHigh : cloneMid;
        }
        if ((microResidualStackBias || smallResidualStackBias || mediumResidualStackBias || continuousStackBias) && ctx.marketVolumeHigh) {
          return cloneMid;
        }
        if (ctx.recentBothSidesFilled || ctx.marketVolumeHigh) {
          return ctx.pairCostComfortable ? cloneMid : cloneBase;
        }
        return cloneBase;
      }
      if (ctx.marketVolumeHigh && ctx.bookDepthGood) {
        if ((alignedCarryBias || denseAlignedCarryBias) && highQualityMatchedInventory && mildPairGate) {
          if (!confirmedCarryBias) {
            return cloneBase;
          }
          return denseAlignedCarryBias && strongCarryBias ? cloneHigh : cloneMid;
        }
        if ((ctx.pairCostComfortable || mildPairGate) && ctx.pnlTodayPositive && ctx.secsFromOpen < 180) {
          return cloneMid;
        }
        return cloneBase;
      }
      return cloneBase;
    }
    if (!ctx.pairCostWithinCap && config.botMode !== "XUAN") {
      return clippedBase;
    }
    if (!ctx.inventoryBalanced) {
      return clippedBase;
    }
    if (!ctx.pairCostWithinCap && config.botMode === "XUAN") {
      const residualStackBias =
        (ctx.residualSeverityLevel === "micro" || ctx.residualSeverityLevel === "small") &&
        effectiveFlowDensity >= 1 &&
        ctx.bookDepthGood;
      const carryLotBias =
        (alignedCarryBias || denseAlignedCarryBias) && highQualityMatchedInventory && confirmedCarryBias;
      if (ctx.secsFromOpen < 45) {
        return mildPairGate && ctx.bookDepthGood ? (carryLotBias ? clippedHigh : clippedMid) : clippedBase;
      }
      if (ctx.secsFromOpen < 150 && ctx.bookDepthGood && (ctx.recentBothSidesFilled || residualStackBias || carryLotBias)) {
        return mildPairGate ? (carryLotBias ? clippedHigh : clippedHigh) : clippedMid;
      }
      if (ctx.marketVolumeHigh && ctx.bookDepthGood && (mildPairGate || residualStackBias || carryLotBias) && ctx.pnlTodayPositive) {
        return carryLotBias && mildPairGate ? clippedHigh : clippedMid;
      }
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
  if (ctx.secsFromOpen < 45 && ctx.bookDepthGood && (ctx.pairCostWithinCap || (config.botMode === "XUAN" && mildPairGate))) {
    return baseLots[1] ?? config.defaultLot;
  }
  if (
    ctx.secsFromOpen < 120 &&
    (ctx.pairCostWithinCap || (config.botMode === "XUAN" && mildPairGate)) &&
    ctx.recentBothSidesFilled
  ) {
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

function familySequencePriorLot(args: {
  secsFromOpen: number;
  priorQty: number;
  cloneBase: number;
  cloneHigh: number;
  cloneMax: number;
}): number {
  if (args.secsFromOpen < 18) {
    return Number((args.priorQty * 0.25 + args.cloneMax * 0.75).toFixed(6));
  }
  if (args.secsFromOpen < 40) {
    return Number((args.priorQty * 0.6 + args.cloneHigh * 0.4).toFixed(6));
  }
  if (args.secsFromOpen >= 40) {
    return Number(args.priorQty.toFixed(6));
  }
  return Number(Math.max(args.cloneBase, args.priorQty).toFixed(6));
}
