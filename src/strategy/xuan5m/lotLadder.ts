import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { resolveBundledSeedSequencePrior } from "../../analytics/xuanExactReference.js";
import { deriveFlowPressureBudgetState, type FlowPressureBudgetState } from "./modePolicy.js";

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
      if (!ctx.inventoryBalanced) {
        return cloneBase;
      }
      if (
        sequencePrior &&
        ctx.secsFromOpen >= sequencePrior.activeFromSec - 1e-9 &&
        ctx.secsFromOpen <= sequencePrior.activeUntilSec + 1e-9 &&
        ctx.bookDepthGood
      ) {
        return Number((sequencePrior.scope === "exact" ? sequencePrior.qty : Math.max(cloneBase, sequencePrior.qty)).toFixed(6));
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
