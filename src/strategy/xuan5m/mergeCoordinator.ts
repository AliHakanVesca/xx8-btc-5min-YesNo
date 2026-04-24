import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { imbalance, mergeableShares } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import { resolveBundledMergeClusterPrior, resolveBundledMergeTimingPrior } from "../../analytics/xuanExactReference.js";
import { classifyFlowPressureBudget, type FlowPressureBudgetState } from "./modePolicy.js";

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
    | "public_footprint_hold"
    | "cycle_target"
    | "age_target"
    | "forced_age"
    | "final_window"
    | "hard_imbalance"
    | "hard_imbalance_deferred"
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
  options?: {
    flowPressureBudget?: number;
    activeIndependentFlowCount?: number;
    flowPressureState?: FlowPressureBudgetState;
  },
): MergeBatchTracker {
  const nextObserved = normalize(Math.max(0, observedMergeable));
  const currentTracked = normalize(Math.max(0, tracker.trackedMergeable));
  const delta = normalize(nextObserved - currentTracked);

  if (delta > 1e-6) {
    const flowPressureState =
      options?.flowPressureState ??
      classifyFlowPressureBudget({
        budget: Math.max(0, options?.flowPressureBudget ?? 0),
        matchedInventoryQuality: 1,
      });
    const activeIndependentFlowCount = Math.max(0, options?.activeIndependentFlowCount ?? 0);
    const lastWindow = tracker.windows.at(-1);
    const shouldCoalesceIntoRecentWindow =
      flowPressureState.confirmed &&
      flowPressureState.remainingBudget >= 0.45 &&
      activeIndependentFlowCount >= 2 &&
      lastWindow !== undefined &&
      nowTs - lastWindow.firstAvailableAt <= 18;
    if (shouldCoalesceIntoRecentWindow && lastWindow) {
      return {
        trackedMergeable: nextObserved,
        windows: [
          ...tracker.windows.slice(0, -1),
          {
            amount: normalize(lastWindow.amount + delta),
            firstAvailableAt: lastWindow.firstAvailableAt,
          },
        ],
      };
    }
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
    | "botMode"
    | "mergeMode"
    | "mergeBatchMode"
    | "minCompletedCyclesBeforeFirstMerge"
    | "minFirstMatchedAgeBeforeMergeSec"
    | "maxMatchedAgeBeforeForcedMergeSec"
    | "requireMinAgeForCycleTargetMerge"
    | "mergeShieldSecFromOpen"
    | "forceMergeInLast30S"
    | "forceMergeOnHardImbalance"
    | "forceMergeOnLowCollateral"
    | "finalWindowCompletionOnlySec"
    | "hardImbalanceRatio"
    | "hardImbalanceMergeMinAgeSec"
    | "hardImbalanceMergeOverlapGraceSec"
    | "hardImbalanceMergeMaxDeferrableShares"
    | "controlledOverlapSeedMaxQty"
    | "minUsdcBalanceForNewEntry"
  >,
  state: XuanMarketState,
  args: {
    nowTs: number;
    secsFromOpen?: number | undefined;
    secsToClose: number;
    usdcBalance: number;
    tracker: MergeBatchTracker;
    flowPressureBudget?: number;
    activeIndependentFlowCount?: number;
    flowPressureState?: FlowPressureBudgetState;
  },
): MergeGateDecision {
  const metrics = mergeBatchMetrics(args.tracker, args.nowTs);
  const timingPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" ? resolveBundledMergeTimingPrior(state.market.slug) : undefined;
  const mergeClusterPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" && args.secsFromOpen !== undefined
      ? resolveBundledMergeClusterPrior(state.market.slug, args.secsFromOpen)
      : undefined;
  const exactMergePriorActive = timingPrior?.scope === "exact" || mergeClusterPrior?.scope === "exact";
  const publicFootprintHoldWithoutPrior =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    !exactMergePriorActive;
  const exactTimingPrior = timingPrior?.scope === "exact" ? timingPrior : undefined;
  const mergeShieldSecFromOpen = exactTimingPrior
    ? Math.max(
        config.mergeShieldSecFromOpen,
        exactTimingPrior.firstMergeSec,
      )
    : config.mergeShieldSecFromOpen;
  const minCompletedCyclesBeforeFirstMerge = exactTimingPrior
    ? Math.max(config.minCompletedCyclesBeforeFirstMerge, exactTimingPrior.completedCyclesBeforeMerge)
    : config.minCompletedCyclesBeforeFirstMerge;
  const minFirstMatchedAgeBeforeMergeSec = exactTimingPrior
    ? Math.max(config.minFirstMatchedAgeBeforeMergeSec, exactTimingPrior.firstMergeSec)
    : config.minFirstMatchedAgeBeforeMergeSec;
  const maxMatchedAgeBeforeForcedMergeSec = exactTimingPrior
    ? Math.min(config.maxMatchedAgeBeforeForcedMergeSec, exactTimingPrior.forcedAgeSec)
    : config.maxMatchedAgeBeforeForcedMergeSec;
  const flowPressureState =
    args.flowPressureState ??
    classifyFlowPressureBudget({
      budget: Math.max(0, args.flowPressureBudget ?? 0),
      matchedInventoryQuality: 1,
    });
  const activeIndependentFlowCount = Math.max(0, args.activeIndependentFlowCount ?? 0);
  const preserveMultiFlowBudget =
    flowPressureState.confirmed &&
    flowPressureState.remainingBudget >= 0.45 &&
    activeIndependentFlowCount >= 2;
  const effectiveMinCompletedCyclesBeforeFirstMerge =
    preserveMultiFlowBudget ? minCompletedCyclesBeforeFirstMerge + 1 : minCompletedCyclesBeforeFirstMerge;
  const effectiveMinFirstMatchedAgeBeforeMergeSec =
    preserveMultiFlowBudget ? minFirstMatchedAgeBeforeMergeSec + 12 : minFirstMatchedAgeBeforeMergeSec;

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

  if (config.forceMergeOnHardImbalance && imbalance(state) >= config.hardImbalanceRatio) {
    const hardImbalanceShareGap = Math.abs(state.upShares - state.downShares);
    const oldestMatchedAgeSec = metrics.oldestMatchedAgeSec ?? 0;
    const hardImbalanceDeferrableShares = Math.max(
      config.hardImbalanceMergeMaxDeferrableShares,
      config.controlledOverlapSeedMaxQty,
    );
    const multiFlowGraceActive =
      activeIndependentFlowCount >= 2 ||
      (flowPressureState.confirmed && flowPressureState.remainingBudget >= 0.35);
    const hardImbalanceMinAgeSec =
      multiFlowGraceActive
        ? Math.max(config.hardImbalanceMergeMinAgeSec, config.hardImbalanceMergeOverlapGraceSec)
        : config.hardImbalanceMergeMinAgeSec;
    const canDeferSmallHardImbalance =
      config.botMode === "XUAN" &&
      args.secsToClose > config.finalWindowCompletionOnlySec &&
      oldestMatchedAgeSec < hardImbalanceMinAgeSec &&
      hardImbalanceShareGap <= hardImbalanceDeferrableShares + 1e-9;
    if (canDeferSmallHardImbalance) {
      return {
        allow: false,
        forced: false,
        reason: "hard_imbalance_deferred",
        ...metrics,
      };
    }
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

  if (config.forceMergeInLast30S && args.secsToClose <= config.finalWindowCompletionOnlySec) {
    return {
      allow: true,
      forced: true,
      reason: "final_window",
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
    metrics.completedCycles >= effectiveMinCompletedCyclesBeforeFirstMerge &&
    (!config.requireMinAgeForCycleTargetMerge ||
      exactMergePriorActive ||
      metrics.oldestMatchedAgeSec === undefined ||
      metrics.oldestMatchedAgeSec >= effectiveMinFirstMatchedAgeBeforeMergeSec)
  ) {
    return {
      allow: true,
      forced: false,
      reason: "cycle_target",
      ...metrics,
    };
  }

  if (
    config.requireMinAgeForCycleTargetMerge &&
    metrics.completedCycles >= effectiveMinCompletedCyclesBeforeFirstMerge
  ) {
    return {
      allow: false,
      forced: false,
      reason: "not_ready",
      ...metrics,
    };
  }

  if (
    metrics.oldestMatchedAgeSec !== undefined &&
    metrics.oldestMatchedAgeSec >= effectiveMinFirstMatchedAgeBeforeMergeSec
  ) {
    return {
      allow: true,
      forced: false,
      reason: "age_target",
      ...metrics,
    };
  }

  if (publicFootprintHoldWithoutPrior) {
    return {
      allow: false,
      forced: false,
      reason: "public_footprint_hold",
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
