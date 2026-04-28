import type { XuanStrategyConfig } from "../../config/strategyPresets.js";

export const XUAN_STRICT_PAIR_COST_TARGET_CAP = 0.982;
export const XUAN_STRICT_CLOSEABLE_PAIR_COST_CAP = 0.995;
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
}): boolean {
  return (
    args.ageSec >= plannedOppositeMinWaitSec(args.config) - 1e-9 &&
    xuanPairCostImprovesOrMeetsTarget(args.config, args.currentMatchedEffectivePair, args.costWithFees)
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
