import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { imbalance, matchedEffectivePairCost, mergeableShares } from "./inventoryState.js";
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
  mergeVsCarryDecision?: "MERGE_NOW" | "CARRY_TO_SETTLEMENT" | "NOT_APPLICABLE" | undefined;
  mergeVsCarryReason?: string | undefined;
  basketEffectivePair?: number | undefined;
  reason:
    | "disabled"
    | "not_ready"
    | "entry_shield"
    | "cluster_window"
    | "public_footprint_hold"
    | "basket_debt_hold"
    | "cycle_target"
    | "basket_target"
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
    | "defaultLot"
    | "liveSmallLotLadder"
    | "minUsdcBalanceForNewEntry"
    | "marketBasketScoringEnabled"
    | "marketBasketStrongAvgCap"
    | "marketBasketMinMergeShares"
    | "marketBasketMergeEffectivePairCap"
    | "marketBasketMergeTargetMultiplier"
    | "marketBasketMergeTargetMaxShares"
    | "cryptoTakerFeeRate"
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
  const baseBasketLot = Math.max(
    config.controlledOverlapSeedMaxQty,
    config.marketBasketMinMergeShares,
    config.liveSmallLotLadder[0] ?? config.defaultLot,
  );
  const basketMergeTargetShares = normalize(
    config.xuanCloneMode === "PUBLIC_FOOTPRINT"
      ? Math.max(
          config.marketBasketMinMergeShares,
          Math.min(
            config.marketBasketMergeTargetMaxShares,
            baseBasketLot * Math.max(1, config.marketBasketMergeTargetMultiplier),
          ),
        )
      : config.marketBasketMinMergeShares,
  );
  const publicHardImbalanceBatchFloor = normalize(
    Math.min(
      basketMergeTargetShares,
      Math.max(config.marketBasketMinMergeShares, baseBasketLot * 2),
    ),
  );

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

  const basketEffectivePair =
    config.marketBasketScoringEnabled && metrics.pendingMatchedQty > 1e-6
      ? matchedEffectivePairCost(state, config.cryptoTakerFeeRate)
      : undefined;

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
    const shouldHoldDebtPositiveHardImbalance =
      publicFootprintHoldWithoutPrior &&
      basketEffectivePair !== undefined &&
      basketEffectivePair > config.marketBasketMergeEffectivePairCap + 1e-9 &&
      metrics.pendingMatchedQty < publicHardImbalanceBatchFloor - 1e-9 &&
      args.secsToClose > config.finalWindowCompletionOnlySec;
    if (shouldHoldDebtPositiveHardImbalance) {
      return {
        allow: false,
        forced: false,
        reason: "basket_debt_hold",
        ...metrics,
      };
    }
    const shouldHoldPublicHardImbalanceForBatch =
      publicFootprintHoldWithoutPrior &&
      basketEffectivePair !== undefined &&
      metrics.pendingMatchedQty < publicHardImbalanceBatchFloor - 1e-9 &&
      args.secsToClose > config.finalWindowCompletionOnlySec;
    if (shouldHoldPublicHardImbalanceForBatch) {
      return {
        allow: false,
        forced: false,
        reason: "public_footprint_hold",
        ...metrics,
      };
    }
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
    const debtPositiveFinalWindow =
      basketEffectivePair !== undefined &&
      basketEffectivePair > config.marketBasketMergeEffectivePairCap + 1e-9;
    const shouldCarrySmallDebtPositiveBasket =
      publicFootprintHoldWithoutPrior &&
      debtPositiveFinalWindow &&
      metrics.pendingMatchedQty < basketMergeTargetShares - 1e-9 &&
      args.usdcBalance >= config.minUsdcBalanceForNewEntry &&
      imbalance(state) < config.hardImbalanceRatio;
    if (shouldCarrySmallDebtPositiveBasket) {
      return {
        allow: false,
        forced: false,
        reason: "basket_debt_hold",
        ...(basketEffectivePair !== undefined ? { basketEffectivePair: normalize(basketEffectivePair) } : {}),
        mergeVsCarryDecision: "CARRY_TO_SETTLEMENT",
        mergeVsCarryReason: "small_debt_positive_basket_below_xuan_merge_target",
        ...metrics,
      };
    }
    return {
      allow: true,
      forced: true,
      reason: "final_window",
      ...(basketEffectivePair !== undefined ? { basketEffectivePair: normalize(basketEffectivePair) } : {}),
      mergeVsCarryDecision: debtPositiveFinalWindow ? "MERGE_NOW" : "NOT_APPLICABLE",
      ...(debtPositiveFinalWindow
        ? { mergeVsCarryReason: "debt_positive_final_window_forced_merge" }
        : {}),
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

  const basketDebtHoldActive =
    publicFootprintHoldWithoutPrior &&
    basketEffectivePair !== undefined &&
    basketEffectivePair > config.marketBasketMergeEffectivePairCap + 1e-9 &&
    args.secsToClose > config.finalWindowCompletionOnlySec;

  if (
    metrics.oldestMatchedAgeSec !== undefined &&
    metrics.oldestMatchedAgeSec >= maxMatchedAgeBeforeForcedMergeSec
  ) {
    if (basketDebtHoldActive) {
      return {
        allow: false,
        forced: false,
        reason: "basket_debt_hold",
        ...metrics,
      };
    }
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

  const strongEarlyBasketMerge =
    basketEffectivePair !== undefined &&
    metrics.pendingMatchedQty >= config.marketBasketMinMergeShares - 1e-9 &&
    basketEffectivePair <= config.marketBasketStrongAvgCap + 1e-9;
  if (
    !exactMergePriorActive &&
    basketEffectivePair !== undefined &&
    (metrics.pendingMatchedQty >= basketMergeTargetShares - 1e-9 || strongEarlyBasketMerge) &&
    basketEffectivePair <= config.marketBasketMergeEffectivePairCap + 1e-9
  ) {
    return {
      allow: true,
      forced: false,
      reason: "basket_target",
      ...metrics,
    };
  }

  const shouldHoldForPublicFootprintBasket =
    publicFootprintHoldWithoutPrior &&
    basketEffectivePair !== undefined &&
    !strongEarlyBasketMerge &&
    metrics.pendingMatchedQty < basketMergeTargetShares - 1e-9;

  if (
    metrics.completedCycles >= effectiveMinCompletedCyclesBeforeFirstMerge &&
    (!config.requireMinAgeForCycleTargetMerge ||
      exactMergePriorActive ||
      metrics.oldestMatchedAgeSec === undefined ||
      metrics.oldestMatchedAgeSec >= effectiveMinFirstMatchedAgeBeforeMergeSec)
  ) {
    if (basketDebtHoldActive) {
      return {
        allow: false,
        forced: false,
        reason: "basket_debt_hold",
        ...metrics,
      };
    }
    if (shouldHoldForPublicFootprintBasket) {
      return {
        allow: false,
        forced: false,
        reason: "public_footprint_hold",
        ...metrics,
      };
    }
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
    if (basketDebtHoldActive) {
      return {
        allow: false,
        forced: false,
        reason: "basket_debt_hold",
        ...metrics,
      };
    }
    if (shouldHoldForPublicFootprintBasket) {
      return {
        allow: false,
        forced: false,
        reason: "public_footprint_hold",
        ...metrics,
      };
    }
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
