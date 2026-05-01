import type { XuanStrategyConfig } from "../../config/strategyPresets.js";

export const XUAN_STRICT_PAIR_COST_TARGET_CAP = 0.982;
export const XUAN_STRICT_CLOSEABLE_PAIR_COST_CAP = 0.995;
export const XUAN_STRICT_SMALL_LOT_COMPLETION_HARD_STOP_CAP = 1.06;
export const XUAN_STRICT_PROTECTIVE_RELEASE_MIN_WAIT_SEC = 15;
export const XUAN_STRICT_PLANNED_OPPOSITE_MIN_WAIT_SEC = 20;
export const XUAN_STRICT_PLANNED_OPPOSITE_DEADLINE_SEC = 35;
export const XUAN_STRICT_LATE_SEED_FINAL_MERGE_DEADLINE_SEC = 276;

export function isAggressivePublicFootprint(
  config: Pick<XuanStrategyConfig, "botMode" | "xuanCloneMode" | "xuanCloneIntensity">,
): boolean {
  return config.botMode === "XUAN" && config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE";
}

export function strictXuanPairCostTargetCap(config: XuanStrategyConfig): number {
  const caps = [
    config.marketBasketMergeEffectivePairCap,
    config.marketBasketGoodAvgCap,
    config.highLowDebtReducingEffectiveCap,
    isAggressivePublicFootprint(config) ? XUAN_STRICT_PAIR_COST_TARGET_CAP : 1,
    1,
  ].filter((cap) => Number.isFinite(cap) && cap > 0);
  return Math.min(...caps);
}

export function strictXuanCloseablePairCostCap(config: XuanStrategyConfig): number {
  return isAggressivePublicFootprint(config)
    ? Math.max(strictXuanPairCostTargetCap(config), XUAN_STRICT_CLOSEABLE_PAIR_COST_CAP)
    : strictXuanPairCostTargetCap(config);
}

export function isXuanSmallLotAggressiveProfile(
  config: Pick<
    XuanStrategyConfig,
    "botMode" | "xuanCloneMode" | "xuanCloneIntensity" | "defaultLot" | "liveSmallLotLadder"
  >,
): boolean {
  if (!isAggressivePublicFootprint(config)) {
    return false;
  }
  const configuredMaxLot = Math.max(0, config.defaultLot, ...config.liveSmallLotLadder);
  return configuredMaxLot > 0 && configuredMaxLot <= 15 + 1e-9;
}

export function xuanSmallLotCompletionHardStopCap(config: XuanStrategyConfig): number {
  return Math.max(strictXuanCloseablePairCostCap(config), XUAN_STRICT_SMALL_LOT_COMPLETION_HARD_STOP_CAP);
}

export function shouldBlockSmallLotExpensiveCompletion(args: {
  config: XuanStrategyConfig;
  costWithFees: number;
  secsToClose: number;
  oldGap: number;
  minOrderSize: number;
  exactPriorActive?: boolean | undefined;
}): boolean {
  if (!isXuanSmallLotAggressiveProfile(args.config) || args.exactPriorActive) {
    return false;
  }
  if (!Number.isFinite(args.costWithFees)) {
    return true;
  }
  if (args.costWithFees <= xuanSmallLotCompletionHardStopCap(args.config) + 1e-9) {
    return false;
  }
  const finalEmergencyWindow =
    args.secsToClose <= args.config.finalWindowNoChaseSec &&
    args.oldGap >= Math.max(args.minOrderSize, args.config.repairMinQty) - 1e-9;
  return !finalEmergencyWindow;
}

export function plannedOppositeStrictPairReleaseReady(
  config: XuanStrategyConfig,
  costWithFees: number,
  missingSidePrice?: number | undefined,
): boolean {
  if (!isAggressivePublicFootprint(config) || !Number.isFinite(costWithFees)) {
    return false;
  }
  if (
    missingSidePrice !== undefined &&
    Number.isFinite(missingSidePrice) &&
    missingSidePrice > config.highSidePriceThreshold + 1e-9
  ) {
    return false;
  }
  const strictPairCap = Math.max(config.strictPairEffectiveCap, strictXuanCloseablePairCostCap(config));
  return costWithFees <= strictPairCap + 1e-9;
}

export function xuanPairCostImprovesOrMeetsTarget(
  config: XuanStrategyConfig,
  currentEffectivePair: number,
  candidateEffectivePair: number,
): boolean {
  if (!Number.isFinite(candidateEffectivePair)) {
    return false;
  }
  const targetCap = strictXuanPairCostTargetCap(config);
  if (candidateEffectivePair <= targetCap + 1e-9) {
    return true;
  }
  return (
    Number.isFinite(currentEffectivePair) &&
    currentEffectivePair > targetCap + 1e-9 &&
    candidateEffectivePair < currentEffectivePair - config.marketBasketMinAvgImprovement + 1e-9
  );
}

export function plannedOppositeMinWaitSec(
  config: XuanStrategyConfig,
  _secsFromOpen?: number,
  _secsToClose?: number,
): number {
  if (!isAggressivePublicFootprint(config)) {
    return 0;
  }
  return XUAN_STRICT_PLANNED_OPPOSITE_MIN_WAIT_SEC;
}

export function plannedOppositeDeadlineAgeSec(config: XuanStrategyConfig): number {
  return isAggressivePublicFootprint(config)
    ? XUAN_STRICT_PLANNED_OPPOSITE_DEADLINE_SEC
    : config.completionTargetMaxDelaySec;
}

export function plannedOppositeDeadlineReached(args: {
  config: XuanStrategyConfig;
  ageSec: number;
  secsFromOpen: number;
  secsToClose: number;
}): boolean {
  if (!isAggressivePublicFootprint(args.config)) {
    return false;
  }
  return (
    args.ageSec >= plannedOppositeDeadlineAgeSec(args.config) - 1e-9 ||
    args.secsFromOpen >= 250 ||
    args.secsToClose <= args.config.finalWindowCompletionOnlySec
  );
}

export function plannedOppositeAgeDeadlineReached(config: XuanStrategyConfig, ageSec: number): boolean {
  return isAggressivePublicFootprint(config) && ageSec >= plannedOppositeDeadlineAgeSec(config) - 1e-9;
}

export function plannedOppositeTargetReleaseReady(args: {
  config: XuanStrategyConfig;
  ageSec: number;
  costWithFees: number;
  currentMatchedEffectivePair: number;
  missingSidePrice?: number | undefined;
}): boolean {
  if (plannedOppositeStrictPairReleaseReady(args.config, args.costWithFees, args.missingSidePrice)) {
    return true;
  }
  return (
    args.ageSec >= plannedOppositeMinWaitSec(args.config) - 1e-9 &&
    xuanPairCostImprovesOrMeetsTarget(args.config, args.currentMatchedEffectivePair, args.costWithFees)
  );
}

export function plannedOppositeProtectiveReleaseReady(args: {
  config: XuanStrategyConfig;
  ageSec: number;
  costWithFees: number;
  executableSize: number;
  minOrderSize: number;
  missingSidePrice?: number | undefined;
}): boolean {
  if (!isAggressivePublicFootprint(args.config)) {
    return false;
  }
  if (
    args.executableSize >= args.minOrderSize - 1e-9 &&
    plannedOppositeStrictPairReleaseReady(args.config, args.costWithFees, args.missingSidePrice)
  ) {
    return true;
  }
  const protectiveMinWaitSec = Math.min(
    plannedOppositeMinWaitSec(args.config),
    XUAN_STRICT_PROTECTIVE_RELEASE_MIN_WAIT_SEC,
  );
  return (
    args.ageSec >= protectiveMinWaitSec - 1e-9 &&
    args.executableSize >= args.minOrderSize - 1e-9 &&
    args.costWithFees <= strictXuanCloseablePairCostCap(args.config) + 1e-9
  );
}

export function plannedOppositeCloseableReleaseReady(args: {
  config: XuanStrategyConfig;
  ageSec: number;
  secsFromOpen: number;
  secsToClose: number;
  costWithFees: number;
}): boolean {
  return (
    plannedOppositeAgeDeadlineReached(args.config, args.ageSec) &&
    args.costWithFees <= strictXuanCloseablePairCostCap(args.config) + 1e-9
  );
}

export function plannedOppositeLateSeedDeadlineFits(args: {
  config: XuanStrategyConfig;
  secsFromOpen: number;
  exactPriorActive: boolean;
}): boolean {
  if (!isAggressivePublicFootprint(args.config) || args.exactPriorActive || args.secsFromOpen < 200) {
    return true;
  }
  return args.secsFromOpen + plannedOppositeDeadlineAgeSec(args.config) <= XUAN_STRICT_LATE_SEED_FINAL_MERGE_DEADLINE_SEC + 1e-9;
}

export function buildXuanStrictPlannedOppositeCandidateSizes(args: {
  config: XuanStrategyConfig;
  plannedOppositeQty: number;
  missingQty: number;
  minOrderSize: number;
  baseCandidateSizes: number[];
  normalize: (value: number) => number;
}): number[] {
  if (!isAggressivePublicFootprint(args.config) || args.plannedOppositeQty <= 0) {
    return args.baseCandidateSizes;
  }
  const maxQty = Math.max(0, Math.min(args.plannedOppositeQty, args.missingQty));
  const xuanLadder = [maxQty, 145, 125, 100, 80, 40, 20, args.minOrderSize]
    .map((size) => args.normalize(Math.min(size, maxQty)))
    .filter((size) => size >= args.minOrderSize - 1e-9);
  return [...new Set([...xuanLadder, ...args.baseCandidateSizes])].sort((left, right) => right - left);
}
