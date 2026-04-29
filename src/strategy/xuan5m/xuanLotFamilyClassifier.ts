import type { XuanStrategyConfig } from "../../config/strategyPresets.js";

export type XuanLotFamily =
  | "MICRO_23"
  | "EARLY_43"
  | "BASE_82"
  | "BASE_83"
  | "HIGH_103"
  | "MID_120"
  | "LARGE_139"
  | "DOUBLE_164"
  | "MERGE_TARGET_269";

export interface XuanLotFamilyContext {
  secsFromOpen: number;
  inventoryBalanced: boolean;
  recentBothSidesFilled: boolean;
  bookDepthGood: boolean;
  flatPosition?: boolean | undefined;
  postMergeCount?: number | undefined;
  totalShares?: number | undefined;
  bestAskUp?: number | undefined;
  bestAskDown?: number | undefined;
  topTwoAskDepthMin?: number | undefined;
  pairGatePressure?: number | undefined;
}

export interface XuanLotFamilyDecision {
  family: XuanLotFamily;
  lot: number;
  reason: string;
}

const FAMILY_LOTS: Record<XuanLotFamily, number> = {
  MICRO_23: 23.4,
  EARLY_43: 43.4,
  BASE_82: 81.9,
  BASE_83: 83,
  HIGH_103: 102.7,
  MID_120: 119.9,
  LARGE_139: 139.19,
  DOUBLE_164: 163.8,
  MERGE_TARGET_269: 269.1,
};

export function xuanFamilyLot(family: XuanLotFamily): number {
  return FAMILY_LOTS[family];
}

export function classifyXuanLotFamily(
  config: Pick<XuanStrategyConfig, "botMode" | "xuanCloneMode" | "xuanCloneIntensity">,
  ctx: XuanLotFamilyContext,
): XuanLotFamilyDecision | undefined {
  if (
    config.botMode !== "XUAN" ||
    config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    config.xuanCloneIntensity !== "AGGRESSIVE"
  ) {
    return undefined;
  }

  const up = finiteOrUndefined(ctx.bestAskUp);
  const down = finiteOrUndefined(ctx.bestAskDown);
  const highAsk = Math.max(up ?? 0, down ?? 0);
  const lowAsk = Math.min(up ?? 1, down ?? 1);
  const spread = up !== undefined && down !== undefined ? Math.abs(up - down) : 0;
  const totalShares = Math.max(0, ctx.totalShares ?? 0);
  const flat = ctx.flatPosition === true || totalShares <= 0.05;
  const pairGatePressure = Math.max(0, ctx.pairGatePressure ?? 1);
  const depth = Math.max(0, ctx.topTwoAskDepthMin ?? 0);
  const depthSupportsFamily = ctx.bookDepthGood && depth >= FAMILY_LOTS.EARLY_43 * 2 - 1e-9;

  if (flat && (ctx.postMergeCount ?? 0) > 0) {
    if (ctx.secsFromOpen >= 255 && highAsk >= 0.88 && lowAsk <= 0.12) {
      return decision("BASE_83", "post_merge_final_carry_family");
    }
    if (ctx.secsFromOpen >= 225 && ctx.secsFromOpen <= 285) {
      return decision("BASE_83", "post_merge_recycle_family");
    }
  }

  if (flat) {
    if (
      ctx.secsFromOpen < 25 &&
      spread <= 0.08 + 1e-9 &&
      highAsk <= 0.54 + 1e-9 &&
      lowAsk >= 0.47 - 1e-9 &&
      depthSupportsFamily
    ) {
      return decision("EARLY_43", "early_tight_mid_micro_pair_family");
    }
    if (ctx.secsFromOpen < 25 && spread >= 0.18 && depthSupportsFamily) {
      return decision("EARLY_43", "early_high_low_micro_pair_family");
    }
    if (
      ctx.secsFromOpen >= 25 &&
      ctx.secsFromOpen < 65 &&
      spread >= 0.18 &&
      highAsk >= 0.58 - 1e-9 &&
      highAsk <= 0.7 + 1e-9 &&
      depth >= FAMILY_LOTS.LARGE_139 * 1.5 - 1e-9
    ) {
      return decision("LARGE_139", "early_high_low_large_family");
    }
    if (ctx.secsFromOpen < 130) {
      return decision("MICRO_23", "mature_probe_family");
    }
  }

  if (ctx.recentBothSidesFilled) {
    if (
      ctx.secsFromOpen >= 45 &&
      ctx.secsFromOpen < 130 &&
      spread <= 0.18 + 1e-9 &&
      totalShares >= FAMILY_LOTS.LARGE_139 * 1.5 - 1e-9 &&
      pairGatePressure <= 0.85
    ) {
      return decision("MID_120", "early_large_family_continuation");
    }
    if (ctx.secsFromOpen >= 188 && highAsk >= 0.9 && lowAsk <= 0.12) {
      return decision("HIGH_103", "late_extreme_high_low_family");
    }
    if (ctx.secsFromOpen >= 150 && highAsk >= 0.86 && lowAsk <= 0.16) {
      return decision("BASE_83", "late_high_low_base_family");
    }
    if (
      ctx.secsFromOpen >= 165 &&
      ctx.secsFromOpen < 215 &&
      spread <= 0.22 + 1e-9 &&
      totalShares >= FAMILY_LOTS.BASE_82 * 1.5 - 1e-9 &&
      pairGatePressure <= 0.85
    ) {
      return decision("DOUBLE_164", "balanced_double_family");
    }
    if (totalShares >= FAMILY_LOTS.EARLY_43 * 2 - 1e-9) {
      return decision("BASE_83", "paired_base_family");
    }
    return decision("EARLY_43", "paired_micro_family");
  }

  if (!ctx.inventoryBalanced && totalShares >= FAMILY_LOTS.MICRO_23 - 1e-9) {
    if (totalShares >= FAMILY_LOTS.BASE_82 * 2 - 1e-9 && ctx.secsFromOpen >= 150) {
      return decision("DOUBLE_164", "unbalanced_continuation_double_family");
    }
    return decision("BASE_82", "unbalanced_repair_base_family");
  }

  return undefined;
}

function decision(family: XuanLotFamily, reason: string): XuanLotFamilyDecision {
  return {
    family,
    lot: FAMILY_LOTS[family],
    reason,
  };
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}
