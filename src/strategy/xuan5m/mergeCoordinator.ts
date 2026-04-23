import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { imbalance, mergeableShares } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { resolveBundledMergeClusterPrior, resolveBundledMergeTimingPrior } from "../../analytics/xuanExactReference.js";

export interface MergePlan {
  mergeable: number;
  shouldMerge: boolean;
}

export interface DeferredMatchedWindow {
  amount: number;
  firstAvailableAt: number;
}

export interface MergeBatchTracker {
  trackedMergeable: number;
  windows: DeferredMatchedWindow[];
}

export interface MergeBatchMetrics {
  completedCycles: number;
  pendingMatchedQty: number;
  oldestMatchedAgeSec?: number | undefined;
}

export interface MergeGateDecision extends MergeBatchMetrics {
  allow: boolean;
  forced: boolean;
  reason:
    | "disabled"
    | "not_ready"
    | "entry_shield"
    | "cluster_window"
    | "cycle_target"
    | "age_target"
    | "forced_age"
    | "final_window"
    | "hard_imbalance"
    | "low_collateral";
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

export function createMergeBatchTracker(): MergeBatchTracker {
  return {
    trackedMergeable: 0,
    windows: [],
  };
}

export function syncMergeBatchTracker(
  tracker: MergeBatchTracker,
  observedMergeable: number,
  nowTs: number,
): MergeBatchTracker {
  const nextObserved = normalize(Math.max(0, observedMergeable));
  const currentTracked = normalize(Math.max(0, tracker.trackedMergeable));
  const delta = normalize(nextObserved - currentTracked);

  if (delta > 1e-6) {
    return {
      trackedMergeable: nextObserved,
      windows: [...tracker.windows, { amount: delta, firstAvailableAt: nowTs }],
    };
  }

  if (delta < -1e-6) {
    let remainingReduction = Math.abs(delta);
    const nextWindows: DeferredMatchedWindow[] = [];
    for (const window of tracker.windows) {
      if (remainingReduction <= 1e-6) {
        nextWindows.push(window);
        continue;
      }
      const reducedAmount = Math.min(window.amount, remainingReduction);
      const keptAmount = normalize(window.amount - reducedAmount);
      remainingReduction = normalize(remainingReduction - reducedAmount);
      if (keptAmount > 1e-6) {
        nextWindows.push({
          ...window,
          amount: keptAmount,
        });
      }
    }
    return {
      trackedMergeable: nextObserved,
      windows: nextWindows,
    };
  }

  return tracker;
}

export function mergeBatchMetrics(tracker: MergeBatchTracker, nowTs: number): MergeBatchMetrics {
  return {
    completedCycles: tracker.windows.length,
    pendingMatchedQty: normalize(tracker.windows.reduce((sum, window) => sum + window.amount, 0)),
    ...(tracker.windows[0]
      ? { oldestMatchedAgeSec: Math.max(0, nowTs - tracker.windows[0].firstAvailableAt) }
      : {}),
  };
}

export function evaluateDelayedMergeGate(
  config: Pick<
    XuanStrategyConfig,
    | "xuanCloneMode"
    | "mergeMode"
    | "mergeBatchMode"
    | "minCompletedCyclesBeforeFirstMerge"
    | "minFirstMatchedAgeBeforeMergeSec"
    | "maxMatchedAgeBeforeForcedMergeSec"
    | "mergeShieldSecFromOpen"
    | "forceMergeInLast30S"
    | "forceMergeOnHardImbalance"
    | "forceMergeOnLowCollateral"
    | "finalWindowCompletionOnlySec"
    | "hardImbalanceRatio"
    | "minUsdcBalanceForNewEntry"
  >,
  state: XuanMarketState,
  args: {
    nowTs: number;
    secsFromOpen?: number | undefined;
    secsToClose: number;
    usdcBalance: number;
    tracker: MergeBatchTracker;
  },
): MergeGateDecision {
  const metrics = mergeBatchMetrics(args.tracker, args.nowTs);
  const timingPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" ? resolveBundledMergeTimingPrior(state.market.slug) : undefined;
  const mergeClusterPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" && args.secsFromOpen !== undefined
      ? resolveBundledMergeClusterPrior(state.market.slug, args.secsFromOpen)
      : undefined;
  const mergeShieldSecFromOpen = timingPrior
    ? Math.max(
        config.mergeShieldSecFromOpen,
        timingPrior.scope === "exact" ? timingPrior.firstMergeSec : Math.max(0, timingPrior.firstMergeSec - 1),
      )
    : config.mergeShieldSecFromOpen;
  const minCompletedCyclesBeforeFirstMerge = timingPrior
    ? Math.max(config.minCompletedCyclesBeforeFirstMerge, timingPrior.completedCyclesBeforeMerge)
    : config.minCompletedCyclesBeforeFirstMerge;
  const minFirstMatchedAgeBeforeMergeSec = timingPrior
    ? timingPrior.scope === "exact"
      ? Math.max(config.minFirstMatchedAgeBeforeMergeSec, timingPrior.firstMergeSec)
      : Math.min(config.minFirstMatchedAgeBeforeMergeSec, timingPrior.firstMergeSec)
    : config.minFirstMatchedAgeBeforeMergeSec;
  const maxMatchedAgeBeforeForcedMergeSec = timingPrior
    ? Math.min(config.maxMatchedAgeBeforeForcedMergeSec, timingPrior.forcedAgeSec)
    : config.maxMatchedAgeBeforeForcedMergeSec;

  if (config.mergeMode !== "AUTO" || metrics.pendingMatchedQty <= 1e-6) {
    return {
      allow: false,
      forced: false,
      reason: "disabled",
      ...metrics,
    };
  }

  if (config.mergeBatchMode === "IMMEDIATE") {
    return {
      allow: true,
      forced: false,
      reason: "cycle_target",
      ...metrics,
    };
  }

  if (config.forceMergeInLast30S && args.secsToClose <= config.finalWindowCompletionOnlySec) {
    return {
      allow: true,
      forced: true,
      reason: "final_window",
      ...metrics,
    };
  }

  if (config.forceMergeOnHardImbalance && imbalance(state) >= config.hardImbalanceRatio) {
    return {
      allow: true,
      forced: true,
      reason: "hard_imbalance",
      ...metrics,
    };
  }

  if (config.forceMergeOnLowCollateral && args.usdcBalance < config.minUsdcBalanceForNewEntry) {
    return {
      allow: true,
      forced: true,
      reason: "low_collateral",
      ...metrics,
    };
  }

  if (
    metrics.oldestMatchedAgeSec !== undefined &&
    metrics.oldestMatchedAgeSec >= maxMatchedAgeBeforeForcedMergeSec
  ) {
    return {
      allow: true,
      forced: true,
      reason: "forced_age",
      ...metrics,
    };
  }

  if ((args.secsFromOpen ?? Number.POSITIVE_INFINITY) < mergeShieldSecFromOpen) {
    return {
      allow: false,
      forced: false,
      reason: "entry_shield",
      ...metrics,
    };
  }

  if (
    mergeClusterPrior?.scope === "exact" &&
    (args.secsFromOpen ?? Number.POSITIVE_INFINITY) < mergeClusterPrior.anchorSec
  ) {
    return {
      allow: false,
      forced: false,
      reason: "cluster_window",
      ...metrics,
    };
  }

  if (metrics.completedCycles >= minCompletedCyclesBeforeFirstMerge) {
    return {
      allow: true,
      forced: false,
      reason: "cycle_target",
      ...metrics,
    };
  }

  if (
    metrics.oldestMatchedAgeSec !== undefined &&
    metrics.oldestMatchedAgeSec >= minFirstMatchedAgeBeforeMergeSec
  ) {
    return {
      allow: true,
      forced: false,
      reason: "age_target",
      ...metrics,
    };
  }

  return {
    allow: false,
    forced: false,
    reason: "not_ready",
    ...metrics,
  };
}

export function planMerge(config: XuanStrategyConfig, state: XuanMarketState): MergePlan {
  const mergeable = mergeableShares(state);
  return {
    mergeable,
    shouldMerge: mergeable >= config.mergeMinShares,
  };
}
