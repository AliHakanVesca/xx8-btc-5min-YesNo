import type { AppEnv } from "./schema.js";

export interface XuanStrategyConfig {
  stateStore: "SQLITE" | "JSON";
  stateStorePath: string;
  botMode: "STRICT" | "XUAN";
  xuanCloneMode: "OFF" | "PUBLIC_FOOTPRINT";
  priceToBeatPolicy: "EXPLICIT_ONLY" | "EXPLICIT_OR_START_CAPTURE";
  priceToBeatStartCaptureWindowMs: number;
  priceToBeatMaxFeedAgeMs: number;
  priceToBeatProvisionalAllowed: boolean;
  priceToBeatExplicitOverrideAllowed: boolean;
  priceToBeatFailClosedAfterSec: number;
  priceToBeatLateStartFallbackEnabled: boolean;
  priceToBeatLateStartMaxMarketAgeSec: number;
  priceToBeatLateStartMaxFeedAgeMs: number;
  startupInventoryPolicy: "IGNORE" | "ADOPT_AND_RECONCILE";
  unknownInventoryPolicy: "WARN" | "BLOCK_NEW_ENTRY";
  resolvedInventoryPolicy: "MANUAL" | "AUTO_REDEEM";
  mergeableInventoryPolicy: "MANUAL" | "AUTO_MERGE";
  startupResidualPolicy: "REPORT_ONLY" | "AUTO_MANAGE";
  lowCollateralMode: "STOP" | "NO_NEW_ENTRY_BUT_MANAGE";
  enableMakerLayer: boolean;
  marketAsset: string;
  marketDurationSec: number;
  entryTakerBuyEnabled: boolean;
  entryTakerPairCap: number;
  completionCap: number;
  minEdgePerShare: number;
  strictPairEffectiveCap: number;
  normalPairEffectiveCap: number;
  pairSweepStrictCap: number;
  xuanPairSweepSoftCap: number;
  xuanPairSweepHardCap: number;
  enableXuanHardPairSweep: boolean;
  maxNegativePairEdgePerCycleUsdc: number;
  maxNegativePairEdgePerMarketUsdc: number;
  maxNegativeDailyBudgetUsdc: number;
  xuanSoftSweepMaxQty: number;
  xuanHardSweepMaxQty: number;
  xuanMinTimeLeftForSoftSweep: number;
  xuanMinTimeLeftForHardSweep: number;
  allowInitialNegativePairSweep: boolean;
  allowSingleLegSeed: boolean;
  allowTemporalSingleLegSeed: boolean;
  allowCheapUnderdogSeed: boolean;
  allowNakedSingleLegSeed: boolean;
  allowXuanCoveredSeed: boolean;
  coveredSeedAllowSamePairgroupOppositeOrder: boolean;
  coveredSeedAllowOppositeInventoryCover: boolean;
  coveredSeedRequireSamePairgroupOppositeOrder: boolean;
  coveredSeedMinOppositeCoverageRatio: number;
  coveredSeedMaxQty: number;
  coveredSeedRequiresFairValue: boolean;
  singleLegOrphanCap: number;
  singleLegFairValueVeto: boolean;
  singleLegOrphanMaxFairPremium: number;
  temporalSingleLegTtlSec: number;
  temporalSingleLegMinOppositeDepthRatio: number;
  xuanBehaviorCap: number;
  orphanLegMaxNotionalUsdc: number;
  orphanLegMaxAgeSec: number;
  maxMarketOrphanUsdc: number;
  maxSingleOrphanQty: number;
  singleLegSeedMaxQty: number;
  maxConsecutiveSingleLegSeedsPerSide: number;
  completionQtyMode: "MISSING_ONLY" | "ALLOW_OVERSHOOT";
  partialCompletionQtyMode: "MISSING_ONLY" | "ALLOW_OVERSHOOT";
  postMergeMaxCompletionQtyMode: "MISSING_ONLY" | "RESIDUAL_ONLY";
  repairMinQty: number;
  completionMinQty: number;
  maxCompletionOvershootShares: number;
  forbidBuyThatIncreasesImbalance: boolean;
  partialCompletionRequiresImbalanceReduction: boolean;
  blockNewPairWhilePartialOpen: boolean;
  maxOpenGroupsPerMarket: number;
  maxOpenPartialGroups: number;
  partialOpenAction: "COMPLETION_ONLY" | "ALLOW_OVERLAP";
  allowControlledOverlap: boolean;
  allowOverlapOnlyAfterPartialClassified: boolean;
  allowOverlapOnlyWhenCompletionEngineActive: boolean;
  allowOverlapInLast30S: boolean;
  requireMatchedInventoryBeforeSecondGroup: boolean;
  worstCaseAmplificationToleranceShares: number;
  postMergeNewSeedCooldownMs: number;
  postMergePairReopenCooldownMs: number;
  postMergeOnlyCompletion: boolean;
  postMergeOnlyCompletionWhileResidual: boolean;
  postMergeAllowNewPairIfFlat: boolean;
  postMergeFlatDustShares: number;
  completionStrictCap: number;
  completionSoftCap: number;
  completionHardCap: number;
  emergencyCompletionHardCap: number;
  emergencyCompletionMaxQty: number;
  emergencyRequiresHardImbalance: boolean;
  maxNegativeEdgePerMarketUsdc: number;
  maxMarketExposureShares: number;
  softImbalanceRatio: number;
  hardImbalanceRatio: number;
  highSidePriceThreshold: number;
  lowSideMaxForHighCompletion: number;
  requireStrictCapForHighLowMismatch: boolean;
  allowHighSideEmergencyChase: boolean;
  highSideEmergencyMaxQty: number;
  highSideEmergencyRequiresFairValue: boolean;
  highSideEmergencyRequiresHardImbalance: boolean;
  highSideEmergencyCap: number;
  enableResidualSell: boolean;
  allowUnresolvedSell: boolean;
  allowEmergencySell: boolean;
  allowResidualCompletion: boolean;
  cryptoTakerFeeRate: number;
  enterFromOpenSecMin: number;
  enterFromOpenSecMax: number;
  normalEntryCutoffSecToClose: number;
  completionOnlyCutoffSecToClose: number;
  hardCancelSecToClose: number;
  finalWindowSoftStartSec: number;
  finalWindowCompletionOnlySec: number;
  finalWindowNoChaseSec: number;
  allowNewPairInLast60S: boolean;
  allowNewPairInLast30S: boolean;
  allowSingleLegSeedInLast60S: boolean;
  allowSoftCompletionInLast30S: boolean;
  allowHardCompletionInLast30S: boolean;
  allowHardCompletionInLast10S: boolean;
  allowAnyNewBuyInLast10S: boolean;
  finalHardCompletionMaxQty: number;
  finalHardCompletionMaxNegativeEdgeUsdc: number;
  finalHardCompletionRequiresHardImbalance: boolean;
  partialFastWindowSec: number;
  partialSoftWindowSec: number;
  partialPatientWindowSec: number;
  partialFastCap: number;
  partialSoftCap: number;
  partialHardCap: number;
  partialEmergencyCap: number;
  partialSoftMaxQty: number;
  partialHardMaxQty: number;
  partialEmergencyMaxQty: number;
  partialEmergencyRequiresFairValue: boolean;
  partialNoChaseLastSec: number;
  maxMarketSharesPerSide: number;
  maxOneSidedExposureShares: number;
  maxImbalanceFrac: number;
  forceRebalanceImbalanceFrac: number;
  rebalanceLeadingFraction: number;
  rebalanceMaxLaggingMultiplier: number;
  lotLadder: number[];
  liveSmallLots: number[];
  defaultLot: number;
  maxCyclesPerMarket: number;
  maxBuysPerSide: number;
  reentryDelayMs: number;
  partialCompletionFractions: number[];
  maxResidualHoldShares: number;
  residualUnwindSecToClose: number;
  sellUnwindEnabled: boolean;
  mergeMode: "MANUAL" | "AUTO";
  dailyMaxLossUsdc: number;
  marketMaxLossUsdc: number;
  minUsdcBalance: number;
  minUsdcBalanceForNewEntry: number;
  minUsdcBalanceForCompletion: number;
  minUsdcBalanceForMergeRedeem: number;
  allowCompletionUnderMinBalance: boolean;
  allowNewEntryUnderMinBalance: boolean;
  lowBalanceCompletionMaxQty: number;
  lowBalanceCompletionBudgetUsdc: number;
  enableFairValueFilter: boolean;
  maxFairPremiumForSeed: number;
  maxFairPremiumForCompletion: number;
  maxFairPremiumForEmergency: number;
  fairValueFailClosedForSeed: boolean;
  fairValueFailClosedForNegativePair: boolean;
  fairValueFailClosedForHighSideChase: boolean;
  allowStrictResidualCompletionWithoutFairValue: boolean;
  strictResidualCompletionCap: number;
  softResidualCompletionCap: number;
  forbidUnderdogBuyIfFairBelowPrice: boolean;
  fairValueUnderdogPriceThreshold: number;
  fairValueMaxSourceDivergenceFrac: number;
  fairValueMaxSourceDivergenceUsd: number;
  pairgroupRepairRequiredScope: "MARKET" | "GLOBAL";
  pairgroupRepairRepeatEscalation: "NONE" | "GLOBAL_SAFE_HALT";
  maxGrouplessFillEventsBeforeGlobalHalt: number;
  blockNewEntryOnExternalActivity: boolean;
  requireReconcileAfterManualTrade: boolean;
  externalActivityMode: "NO_NEW_ENTRY" | "SAFE_HALT";
  allowAutoResumeAfterExternalActivity: boolean;
  requireManualResumeConfirm: boolean;
  restartRestorePartialAsCompletionOnly: boolean;
  blockNewPairWhenRestoredPartialExists: boolean;
  restoredPartialAllowSeed: boolean;
  restoredPartialAllowSameSideBuy: boolean;
  stateReconcileToleranceShares: number;
  lotScalingMode: "FIXED" | "BANKROLL_ADJUSTED";
  xuanBaseLotLadder: number[];
  liveSmallLotLadder: number[];
  maxMarketNotionalPct: number;
  maxSingleOrderNotionalPct: number;
  rejectUnclassifiedBuy: boolean;
  validationSequence: "NONE" | "REPLAY_THEN_LIVE";
  replayRequiredBeforeLive: boolean;
  liveSmokeMaxQty: number;
  liveSmokeDisableHardSweep: boolean;
  liveSmokeDisableSeed: boolean;
  pairgroupFinalizeAfterBalanceSync: boolean;
  pairgroupFinalizeTimeoutMs: number;
  pairgroupRequireReconcileBeforeNoneFilled: boolean;
  mergeMinShares: number;
  mergeDebounceMs: number;
  mergeBatchMode: "IMMEDIATE" | "HYBRID_DELAYED";
  minCompletedCyclesBeforeFirstMerge: number;
  minFirstMatchedAgeBeforeMergeSec: number;
  maxMatchedAgeBeforeForcedMergeSec: number;
  forceMergeInLast30S: boolean;
  forceMergeOnHardImbalance: boolean;
  forceMergeOnLowCollateral: boolean;
  mergeOnEachReconcile: boolean;
  mergeOnMarketClose: boolean;
  mergeMaxTxPerMarket: number;
  mergeDustLeaveShares: number;
  allowMergeWithPendingGroups: boolean;
  mergeOnlyConfirmedMatchedUnlockedLots: boolean;
  lockReservedQtyForPendingOrders: boolean;
  redeemMode: "MANUAL" | "AUTO";
  redeemOnResolution: boolean;
  redeemRetryEnabled: boolean;
  redeemRetryMax: number;
  redeemMinShares: number;
  dustSharesThreshold: number;
  inventoryPositionLimit: number;
  inventorySizeThreshold: number;
}

export function buildStrategyConfig(env: AppEnv): XuanStrategyConfig {
  const resolvedStateStorePath = env.STATE_DB_PATH || env.STATE_STORE_PATH;
  const resolvedLotLadder = env.LIVE_SMALL_LOT_LADDER.length > 0 ? env.LIVE_SMALL_LOT_LADDER : env.LOT_LADDER;
  const resolvedBaseLotLadder = env.XUAN_BASE_LOT_LADDER.length > 0 ? env.XUAN_BASE_LOT_LADDER : env.LOT_LADDER;
  const baseConfig: XuanStrategyConfig = {
    stateStore: env.STATE_STORE,
    stateStorePath: resolvedStateStorePath,
    botMode: env.BOT_MODE,
    xuanCloneMode: env.XUAN_CLONE_MODE,
    priceToBeatPolicy: env.PRICE_TO_BEAT_POLICY,
    priceToBeatStartCaptureWindowMs: env.PRICE_TO_BEAT_START_CAPTURE_WINDOW_MS,
    priceToBeatMaxFeedAgeMs: env.PRICE_TO_BEAT_MAX_FEED_AGE_MS,
    priceToBeatProvisionalAllowed: env.PRICE_TO_BEAT_PROVISIONAL_ALLOWED,
    priceToBeatExplicitOverrideAllowed: env.PRICE_TO_BEAT_EXPLICIT_OVERRIDE_ALLOWED,
    priceToBeatFailClosedAfterSec: env.PRICE_TO_BEAT_FAIL_CLOSED_AFTER_SEC,
    priceToBeatLateStartFallbackEnabled: env.PRICE_TO_BEAT_LATE_START_FALLBACK_ENABLED,
    priceToBeatLateStartMaxMarketAgeSec: env.PRICE_TO_BEAT_LATE_START_MAX_MARKET_AGE_SEC,
    priceToBeatLateStartMaxFeedAgeMs: env.PRICE_TO_BEAT_LATE_START_MAX_FEED_AGE_MS,
    startupInventoryPolicy: env.STARTUP_INVENTORY_POLICY,
    unknownInventoryPolicy: env.UNKNOWN_INVENTORY_POLICY,
    resolvedInventoryPolicy: env.RESOLVED_INVENTORY_POLICY,
    mergeableInventoryPolicy: env.MERGEABLE_INVENTORY_POLICY,
    startupResidualPolicy: env.STARTUP_RESIDUAL_POLICY,
    lowCollateralMode: env.LOW_COLLATERAL_MODE,
    enableMakerLayer: env.ENABLE_MAKER_LAYER,
    marketAsset: "btc",
    marketDurationSec: 300,
    entryTakerBuyEnabled: env.ENTRY_TAKER_BUY_ENABLED,
    entryTakerPairCap: env.ENTRY_TAKER_PAIR_CAP,
    completionCap: env.COMPLETION_CAP,
    minEdgePerShare: env.MIN_EDGE_PER_SHARE,
    strictPairEffectiveCap: env.STRICT_PAIR_EFFECTIVE_CAP,
    normalPairEffectiveCap: env.NORMAL_PAIR_EFFECTIVE_CAP,
    pairSweepStrictCap: env.PAIR_SWEEP_STRICT_CAP,
    xuanPairSweepSoftCap: env.XUAN_PAIR_SWEEP_SOFT_CAP,
    xuanPairSweepHardCap: env.XUAN_PAIR_SWEEP_HARD_CAP,
    enableXuanHardPairSweep: env.ENABLE_XUAN_HARD_PAIR_SWEEP,
    maxNegativePairEdgePerCycleUsdc: env.MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC,
    maxNegativePairEdgePerMarketUsdc: env.MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC,
    maxNegativeDailyBudgetUsdc: env.MAX_NEGATIVE_DAILY_BUDGET_USDC,
    xuanSoftSweepMaxQty: env.XUAN_SOFT_SWEEP_MAX_QTY,
    xuanHardSweepMaxQty: env.XUAN_HARD_SWEEP_MAX_QTY,
    xuanMinTimeLeftForSoftSweep: env.XUAN_MIN_TIME_LEFT_FOR_SOFT_SWEEP,
    xuanMinTimeLeftForHardSweep: env.XUAN_MIN_TIME_LEFT_FOR_HARD_SWEEP,
    allowInitialNegativePairSweep: env.ALLOW_INITIAL_NEGATIVE_PAIR_SWEEP,
    allowSingleLegSeed: env.ALLOW_SINGLE_LEG_SEED,
    allowTemporalSingleLegSeed: env.ALLOW_TEMPORAL_SINGLE_LEG_SEED,
    allowCheapUnderdogSeed: env.ALLOW_CHEAP_UNDERDOG_SEED,
    allowNakedSingleLegSeed: env.ALLOW_NAKED_SINGLE_LEG_SEED,
    allowXuanCoveredSeed: env.ALLOW_XUAN_COVERED_SEED,
    coveredSeedAllowSamePairgroupOppositeOrder:
      env.ALLOW_COVERED_SEED_SAME_PAIRGROUP ||
      env.COVERED_SEED_ALLOW_SAME_PAIRGROUP_OPPOSITE_ORDER ||
      env.COVERED_SEED_REQUIRE_SAME_PAIRGROUP_OPPOSITE_ORDER,
    coveredSeedAllowOppositeInventoryCover:
      env.ALLOW_COVERED_SEED_OPPOSITE_INVENTORY || env.COVERED_SEED_ALLOW_OPPOSITE_INVENTORY_COVER,
    coveredSeedRequireSamePairgroupOppositeOrder: env.COVERED_SEED_REQUIRE_SAME_PAIRGROUP_OPPOSITE_ORDER,
    coveredSeedMinOppositeCoverageRatio: env.COVERED_SEED_MIN_OPPOSITE_COVERAGE_RATIO,
    coveredSeedMaxQty: env.COVERED_SEED_MAX_QTY,
    coveredSeedRequiresFairValue: env.COVERED_SEED_REQUIRES_FAIR_VALUE,
    singleLegOrphanCap: env.SINGLE_LEG_ORPHAN_CAP,
    singleLegFairValueVeto: env.SINGLE_LEG_FAIR_VALUE_VETO,
    singleLegOrphanMaxFairPremium: env.SINGLE_LEG_ORPHAN_MAX_FAIR_PREMIUM,
    temporalSingleLegTtlSec: env.TEMPORAL_SINGLE_LEG_TTL_SEC,
    temporalSingleLegMinOppositeDepthRatio: env.TEMPORAL_SINGLE_LEG_MIN_OPPOSITE_DEPTH_RATIO,
    xuanBehaviorCap: env.XUAN_BEHAVIOR_CAP,
    orphanLegMaxNotionalUsdc: env.ORPHAN_LEG_MAX_NOTIONAL_USDC,
    orphanLegMaxAgeSec: env.ORPHAN_LEG_MAX_AGE_SEC,
    maxMarketOrphanUsdc: env.MAX_MARKET_ORPHAN_USDC,
    maxSingleOrphanQty: env.MAX_SINGLE_ORPHAN_QTY,
    singleLegSeedMaxQty: env.SINGLE_LEG_SEED_MAX_QTY,
    maxConsecutiveSingleLegSeedsPerSide: env.MAX_CONSECUTIVE_SINGLE_LEG_SEEDS_PER_SIDE,
    completionQtyMode: env.COMPLETION_QTY_MODE,
    partialCompletionQtyMode: env.PARTIAL_COMPLETION_QTY_MODE,
    postMergeMaxCompletionQtyMode: env.POST_MERGE_MAX_COMPLETION_QTY_MODE,
    repairMinQty: env.REPAIR_MIN_QTY,
    completionMinQty: env.COMPLETION_MIN_QTY,
    maxCompletionOvershootShares: env.MAX_COMPLETION_OVERSHOOT_SHARES,
    forbidBuyThatIncreasesImbalance: env.FORBID_BUY_THAT_INCREASES_IMBALANCE,
    partialCompletionRequiresImbalanceReduction: env.PARTIAL_COMPLETION_REQUIRES_IMBALANCE_REDUCTION,
    blockNewPairWhilePartialOpen: env.BLOCK_NEW_PAIR_WHILE_PARTIAL_OPEN,
    maxOpenGroupsPerMarket: env.MAX_OPEN_GROUPS_PER_MARKET,
    maxOpenPartialGroups: env.MAX_OPEN_PARTIAL_GROUPS_PER_MARKET || env.MAX_OPEN_PARTIAL_GROUPS,
    partialOpenAction: env.PARTIAL_OPEN_ACTION,
    allowControlledOverlap: env.ALLOW_CONTROLLED_OVERLAP,
    allowOverlapOnlyAfterPartialClassified: env.ALLOW_OVERLAP_ONLY_AFTER_PARTIAL_CLASSIFIED,
    allowOverlapOnlyWhenCompletionEngineActive: env.ALLOW_OVERLAP_ONLY_WHEN_COMPLETION_ENGINE_ACTIVE,
    allowOverlapInLast30S: env.ALLOW_OVERLAP_IN_LAST_30S,
    requireMatchedInventoryBeforeSecondGroup: env.REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP,
    worstCaseAmplificationToleranceShares: env.WORST_CASE_AMPLIFICATION_TOLERANCE_SHARES,
    postMergeNewSeedCooldownMs: env.POST_MERGE_NEW_SEED_COOLDOWN_MS,
    postMergePairReopenCooldownMs: env.POST_MERGE_PAIR_REOPEN_COOLDOWN_MS,
    postMergeOnlyCompletion: env.POST_MERGE_ONLY_COMPLETION,
    postMergeOnlyCompletionWhileResidual: env.POST_MERGE_ONLY_COMPLETION_WHILE_RESIDUAL,
    postMergeAllowNewPairIfFlat: env.POST_MERGE_ALLOW_NEW_PAIR_IF_FLAT,
    postMergeFlatDustShares: env.POST_MERGE_FLAT_DUST_SHARES,
    completionStrictCap: env.COMPLETION_STRICT_CAP,
    completionSoftCap: env.COMPLETION_SOFT_CAP,
    completionHardCap: env.COMPLETION_HARD_CAP,
    emergencyCompletionHardCap: env.EMERGENCY_COMPLETION_HARD_CAP,
    emergencyCompletionMaxQty: env.EMERGENCY_COMPLETION_MAX_QTY,
    emergencyRequiresHardImbalance: env.EMERGENCY_REQUIRES_HARD_IMBALANCE,
    maxNegativeEdgePerMarketUsdc: env.MAX_NEGATIVE_EDGE_PER_MARKET_USDC,
    maxMarketExposureShares: env.MAX_MARKET_EXPOSURE_SHARES,
    softImbalanceRatio: env.SOFT_IMBALANCE_RATIO,
    hardImbalanceRatio: env.HARD_IMBALANCE_RATIO,
    highSidePriceThreshold: env.HIGH_SIDE_PRICE_THRESHOLD,
    lowSideMaxForHighCompletion: env.LOW_SIDE_MAX_FOR_HIGH_COMPLETION,
    requireStrictCapForHighLowMismatch: env.REQUIRE_STRICT_CAP_FOR_HIGH_LOW_MISMATCH,
    allowHighSideEmergencyChase: env.ALLOW_HIGH_SIDE_EMERGENCY_CHASE,
    highSideEmergencyMaxQty: env.HIGH_SIDE_EMERGENCY_MAX_QTY,
    highSideEmergencyRequiresFairValue: env.HIGH_SIDE_EMERGENCY_REQUIRES_FAIR_VALUE,
    highSideEmergencyRequiresHardImbalance: env.HIGH_SIDE_EMERGENCY_REQUIRES_HARD_IMBALANCE,
    highSideEmergencyCap: env.HIGH_SIDE_EMERGENCY_CAP,
    enableResidualSell: env.ENABLE_RESIDUAL_SELL,
    allowUnresolvedSell: env.ALLOW_UNRESOLVED_SELL,
    allowEmergencySell: env.ALLOW_EMERGENCY_SELL,
    allowResidualCompletion: env.ALLOW_RESIDUAL_COMPLETION,
    cryptoTakerFeeRate: 0.072,
    enterFromOpenSecMin: env.ENTER_FROM_OPEN_SEC_MIN,
    enterFromOpenSecMax: env.ENTER_FROM_OPEN_SEC_MAX,
    normalEntryCutoffSecToClose: env.FINAL_WINDOW_SOFT_START_SEC || env.NORMAL_ENTRY_CUTOFF_SEC_TO_CLOSE,
    completionOnlyCutoffSecToClose:
      env.FINAL_WINDOW_COMPLETION_ONLY_SEC || env.COMPLETION_ONLY_CUTOFF_SEC_TO_CLOSE,
    hardCancelSecToClose: env.FINAL_WINDOW_NO_CHASE_SEC || env.HARD_CANCEL_SEC_TO_CLOSE,
    finalWindowSoftStartSec: env.FINAL_WINDOW_SOFT_START_SEC,
    finalWindowCompletionOnlySec: env.FINAL_WINDOW_COMPLETION_ONLY_SEC,
    finalWindowNoChaseSec: env.FINAL_WINDOW_NO_CHASE_SEC,
    allowNewPairInLast60S: env.ALLOW_NEW_PAIR_IN_LAST_60S,
    allowNewPairInLast30S: env.ALLOW_NEW_PAIR_IN_LAST_30S,
    allowSingleLegSeedInLast60S: env.ALLOW_SINGLE_LEG_SEED_IN_LAST_60S,
    allowSoftCompletionInLast30S: env.ALLOW_SOFT_COMPLETION_IN_LAST_30S,
    allowHardCompletionInLast30S: env.ALLOW_HARD_COMPLETION_IN_LAST_30S,
    allowHardCompletionInLast10S: env.ALLOW_HARD_COMPLETION_IN_LAST_10S,
    allowAnyNewBuyInLast10S: env.ALLOW_ANY_NEW_BUY_IN_LAST_10S,
    finalHardCompletionMaxQty: env.FINAL_HARD_COMPLETION_MAX_QTY,
    finalHardCompletionMaxNegativeEdgeUsdc: env.FINAL_HARD_COMPLETION_MAX_NEGATIVE_EDGE_USDC,
    finalHardCompletionRequiresHardImbalance: env.FINAL_HARD_COMPLETION_REQUIRES_HARD_IMBALANCE,
    partialFastWindowSec: env.PARTIAL_FAST_WINDOW_SEC,
    partialSoftWindowSec: env.PARTIAL_SOFT_WINDOW_SEC,
    partialPatientWindowSec: env.PARTIAL_PATIENT_WINDOW_SEC,
    partialFastCap: env.PARTIAL_FAST_CAP,
    partialSoftCap: env.PARTIAL_SOFT_CAP,
    partialHardCap: env.PARTIAL_HARD_CAP,
    partialEmergencyCap: env.PARTIAL_EMERGENCY_CAP,
    partialSoftMaxQty: env.PARTIAL_SOFT_MAX_QTY,
    partialHardMaxQty: env.PARTIAL_HARD_MAX_QTY,
    partialEmergencyMaxQty: env.PARTIAL_EMERGENCY_MAX_QTY,
    partialEmergencyRequiresFairValue: env.PARTIAL_EMERGENCY_REQUIRES_FAIR_VALUE,
    partialNoChaseLastSec: env.PARTIAL_NO_CHASE_LAST_SEC,
    maxMarketSharesPerSide: env.MAX_MARKET_SHARES_PER_SIDE,
    maxOneSidedExposureShares: env.MAX_ONE_SIDED_EXPOSURE_SHARES,
    maxImbalanceFrac: env.MAX_IMBALANCE_FRAC,
    forceRebalanceImbalanceFrac: env.FORCE_REBALANCE_IMBALANCE_FRAC,
    rebalanceLeadingFraction: env.REBALANCE_LEADING_FRACTION,
    rebalanceMaxLaggingMultiplier: env.REBALANCE_MAX_LAGGING_MULTIPLIER,
    lotLadder: resolvedBaseLotLadder,
    liveSmallLots: resolvedLotLadder,
    defaultLot: env.DEFAULT_LOT || resolvedLotLadder[0] || env.LOT_LADDER[0] || 5,
    mergeMinShares: env.MIN_MERGE_SHARES || env.MERGE_MIN_SHARES,
    maxCyclesPerMarket: env.MAX_CYCLES_PER_MARKET,
    maxBuysPerSide: env.MAX_BUYS_PER_SIDE,
    reentryDelayMs: 1000,
    partialCompletionFractions: env.PARTIAL_COMPLETION_FRACTIONS,
    maxResidualHoldShares: env.MAX_RESIDUAL_HOLD_SHARES,
    residualUnwindSecToClose: env.RESIDUAL_UNWIND_SEC_TO_CLOSE,
    sellUnwindEnabled:
      (env.SELL_UNWIND_ENABLED || env.ENABLE_RESIDUAL_SELL) &&
      (env.ALLOW_UNRESOLVED_SELL || env.ALLOW_EMERGENCY_SELL),
    mergeMode: env.MERGE_MODE,
    dailyMaxLossUsdc: env.DAILY_MAX_LOSS_USDC,
    marketMaxLossUsdc: env.MARKET_MAX_LOSS_USDC,
    minUsdcBalance: env.MIN_USDC_BALANCE,
    minUsdcBalanceForNewEntry: env.MIN_USDC_BALANCE_FOR_NEW_ENTRY,
    minUsdcBalanceForCompletion: env.MIN_USDC_BALANCE_FOR_COMPLETION,
    minUsdcBalanceForMergeRedeem: env.MIN_USDC_BALANCE_FOR_MERGE_REDEEM,
    allowCompletionUnderMinBalance: env.ALLOW_COMPLETION_UNDER_MIN_BALANCE,
    allowNewEntryUnderMinBalance: env.ALLOW_NEW_ENTRY_UNDER_MIN_BALANCE,
    lowBalanceCompletionMaxQty: env.LOW_BALANCE_COMPLETION_MAX_QTY,
    lowBalanceCompletionBudgetUsdc: env.LOW_BALANCE_COMPLETION_BUDGET_USDC,
    enableFairValueFilter: env.ENABLE_FAIR_VALUE_FILTER,
    maxFairPremiumForSeed: env.MAX_FAIR_PREMIUM_FOR_SEED,
    maxFairPremiumForCompletion: env.MAX_FAIR_PREMIUM_FOR_COMPLETION,
    maxFairPremiumForEmergency: env.MAX_FAIR_PREMIUM_FOR_EMERGENCY,
    fairValueFailClosedForSeed: env.FAIR_VALUE_FAIL_CLOSED_FOR_SEED,
    fairValueFailClosedForNegativePair: env.FAIR_VALUE_FAIL_CLOSED_FOR_NEGATIVE_PAIR,
    fairValueFailClosedForHighSideChase: env.FAIR_VALUE_FAIL_CLOSED_FOR_HIGH_SIDE_CHASE,
    allowStrictResidualCompletionWithoutFairValue: env.ALLOW_STRICT_RESIDUAL_COMPLETION_WITHOUT_FAIR_VALUE,
    strictResidualCompletionCap: env.STRICT_RESIDUAL_COMPLETION_CAP,
    softResidualCompletionCap: env.SOFT_RESIDUAL_COMPLETION_CAP,
    forbidUnderdogBuyIfFairBelowPrice: env.FORBID_UNDERDOG_BUY_IF_FAIR_BELOW_PRICE,
    fairValueUnderdogPriceThreshold: env.FAIR_VALUE_UNDERDOG_PRICE_THRESHOLD,
    fairValueMaxSourceDivergenceFrac: env.FAIR_VALUE_MAX_SOURCE_DIVERGENCE_FRAC,
    fairValueMaxSourceDivergenceUsd: env.FAIR_VALUE_MAX_SOURCE_DIVERGENCE_USD,
    pairgroupRepairRequiredScope: env.PAIRGROUP_REPAIR_REQUIRED_SCOPE,
    pairgroupRepairRepeatEscalation: env.PAIRGROUP_REPAIR_REPEAT_ESCALATION,
    maxGrouplessFillEventsBeforeGlobalHalt: env.MAX_GROUPLESS_FILL_EVENTS_BEFORE_GLOBAL_HALT,
    blockNewEntryOnExternalActivity: env.BLOCK_NEW_ENTRY_ON_EXTERNAL_ACTIVITY,
    requireReconcileAfterManualTrade: env.REQUIRE_RECONCILE_AFTER_MANUAL_TRADE,
    externalActivityMode: env.EXTERNAL_ACTIVITY_MODE,
    allowAutoResumeAfterExternalActivity: env.ALLOW_AUTO_RESUME_AFTER_EXTERNAL_ACTIVITY,
    requireManualResumeConfirm: env.REQUIRE_MANUAL_RESUME_CONFIRM,
    restartRestorePartialAsCompletionOnly: env.RESTART_RESTORE_PARTIAL_AS_COMPLETION_ONLY,
    blockNewPairWhenRestoredPartialExists: env.BLOCK_NEW_PAIR_WHEN_RESTORED_PARTIAL_EXISTS,
    restoredPartialAllowSeed: env.RESTORED_PARTIAL_ALLOW_SEED,
    restoredPartialAllowSameSideBuy: env.RESTORED_PARTIAL_ALLOW_SAME_SIDE_BUY,
    stateReconcileToleranceShares: env.STATE_RECONCILE_TOLERANCE_SHARES,
    lotScalingMode: env.LOT_SCALING_MODE,
    xuanBaseLotLadder: resolvedBaseLotLadder,
    liveSmallLotLadder: resolvedLotLadder,
    maxMarketNotionalPct: env.MAX_MARKET_NOTIONAL_PCT,
    maxSingleOrderNotionalPct: env.MAX_SINGLE_ORDER_NOTIONAL_PCT,
    rejectUnclassifiedBuy: env.REJECT_UNCLASSIFIED_BUY,
    validationSequence: env.VALIDATION_SEQUENCE,
    replayRequiredBeforeLive: env.REPLAY_REQUIRED_BEFORE_LIVE,
    liveSmokeMaxQty: env.LIVE_SMOKE_MAX_QTY,
    liveSmokeDisableHardSweep: env.LIVE_SMOKE_DISABLE_HARD_SWEEP,
    liveSmokeDisableSeed: env.LIVE_SMOKE_DISABLE_SEED,
    pairgroupFinalizeAfterBalanceSync: env.PAIRGROUP_FINALIZE_AFTER_BALANCE_SYNC,
    pairgroupFinalizeTimeoutMs: env.PAIRGROUP_FINALIZE_TIMEOUT_MS,
    pairgroupRequireReconcileBeforeNoneFilled: env.PAIRGROUP_REQUIRE_RECONCILE_BEFORE_NONE_FILLED,
    mergeDebounceMs: env.MERGE_DEBOUNCE_MS,
    mergeBatchMode: env.MERGE_BATCH_MODE,
    minCompletedCyclesBeforeFirstMerge: env.MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE,
    minFirstMatchedAgeBeforeMergeSec: env.MIN_FIRST_MATCHED_AGE_BEFORE_MERGE_SEC,
    maxMatchedAgeBeforeForcedMergeSec: env.MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC,
    forceMergeInLast30S: env.FORCE_MERGE_IN_LAST_30S,
    forceMergeOnHardImbalance: env.FORCE_MERGE_ON_HARD_IMBALANCE,
    forceMergeOnLowCollateral: env.FORCE_MERGE_ON_LOW_COLLATERAL,
    mergeOnEachReconcile: env.MERGE_ON_EACH_RECONCILE,
    mergeOnMarketClose: env.MERGE_ON_MARKET_CLOSE,
    mergeMaxTxPerMarket: env.MERGE_MAX_TX_PER_MARKET,
    mergeDustLeaveShares: env.MERGE_DUST_LEAVE_SHARES,
    allowMergeWithPendingGroups: env.ALLOW_MERGE_WITH_PENDING_GROUPS,
    mergeOnlyConfirmedMatchedUnlockedLots: env.MERGE_ONLY_CONFIRMED_MATCHED_UNLOCKED_LOTS,
    lockReservedQtyForPendingOrders: env.LOCK_RESERVED_QTY_FOR_PENDING_ORDERS,
    redeemMode: env.REDEEM_MODE,
    redeemOnResolution: env.REDEEM_ON_RESOLUTION,
    redeemRetryEnabled: env.REDEEM_RETRY_ENABLED,
    redeemRetryMax: env.REDEEM_RETRY_MAX,
    redeemMinShares: env.REDEEM_MIN_SHARES,
    dustSharesThreshold: env.DUST_SHARES_THRESHOLD,
    inventoryPositionLimit: env.INVENTORY_POSITION_LIMIT,
    inventorySizeThreshold: env.INVENTORY_SIZE_THRESHOLD,
  };
  return baseConfig.xuanCloneMode === "PUBLIC_FOOTPRINT" ? applyPublicFootprintClone(baseConfig) : baseConfig;
}

function applyPublicFootprintClone(config: XuanStrategyConfig): XuanStrategyConfig {
  const ladder = [80, 90, 100, 125];
  const elevatedBehaviorCap = Math.max(config.xuanBehaviorCap, 1.25);

  return {
    ...config,
    allowSingleLegSeed: true,
    allowTemporalSingleLegSeed: true,
    allowNakedSingleLegSeed: false,
    allowXuanCoveredSeed: true,
    allowCheapUnderdogSeed: true,
    coveredSeedRequiresFairValue: false,
    singleLegFairValueVeto: false,
    xuanBaseLotLadder: ladder,
    liveSmallLotLadder: ladder,
    liveSmallLots: ladder,
    lotLadder: ladder,
    defaultLot: ladder[0] ?? config.defaultLot,
    xuanSoftSweepMaxQty: Math.max(config.xuanSoftSweepMaxQty, ladder[ladder.length - 1] ?? 125),
    xuanHardSweepMaxQty: Math.max(config.xuanHardSweepMaxQty, ladder[ladder.length - 1] ?? 125),
    coveredSeedMaxQty: Math.max(config.coveredSeedMaxQty, ladder[ladder.length - 1] ?? 125),
    singleLegSeedMaxQty: Math.max(config.singleLegSeedMaxQty, ladder[ladder.length - 1] ?? 125),
    maxSingleOrphanQty: Math.max(config.maxSingleOrphanQty, ladder[ladder.length - 1] ?? 125),
    orphanLegMaxNotionalUsdc: Math.max(config.orphanLegMaxNotionalUsdc, 80),
    maxMarketOrphanUsdc: Math.max(config.maxMarketOrphanUsdc, 160),
    maxNegativePairEdgePerCycleUsdc: Math.max(config.maxNegativePairEdgePerCycleUsdc, 20),
    maxNegativePairEdgePerMarketUsdc: Math.max(config.maxNegativePairEdgePerMarketUsdc, 20),
    maxNegativeDailyBudgetUsdc: Math.max(config.maxNegativeDailyBudgetUsdc, 25),
    maxNegativeEdgePerMarketUsdc: Math.max(config.maxNegativeEdgePerMarketUsdc, 25),
    blockNewPairWhilePartialOpen: false,
    maxOpenGroupsPerMarket: Math.max(config.maxOpenGroupsPerMarket, 4),
    maxOpenPartialGroups: Math.max(config.maxOpenPartialGroups, 3),
    partialOpenAction: "ALLOW_OVERLAP",
    allowOverlapOnlyAfterPartialClassified: false,
    allowOverlapOnlyWhenCompletionEngineActive: false,
    requireMatchedInventoryBeforeSecondGroup: false,
    worstCaseAmplificationToleranceShares: Math.max(config.worstCaseAmplificationToleranceShares, 125),
    postMergeNewSeedCooldownMs: 0,
    postMergePairReopenCooldownMs: 0,
    postMergeOnlyCompletion: false,
    postMergeOnlyCompletionWhileResidual: false,
    allowHighSideEmergencyChase: true,
    highSideEmergencyMaxQty: Math.max(config.highSideEmergencyMaxQty, ladder[ladder.length - 1] ?? 125),
    highSideEmergencyRequiresFairValue: false,
    highSideEmergencyRequiresHardImbalance: false,
    highSideEmergencyCap: Math.max(config.highSideEmergencyCap, elevatedBehaviorCap),
    emergencyCompletionMaxQty: Math.max(config.emergencyCompletionMaxQty, ladder[ladder.length - 1] ?? 125),
    emergencyCompletionHardCap: Math.max(config.emergencyCompletionHardCap, elevatedBehaviorCap),
    partialSoftMaxQty: Math.max(config.partialSoftMaxQty, ladder[ladder.length - 1] ?? 125),
    partialHardMaxQty: Math.max(config.partialHardMaxQty, ladder[ladder.length - 1] ?? 125),
    partialEmergencyMaxQty: Math.max(config.partialEmergencyMaxQty, ladder[ladder.length - 1] ?? 125),
    partialEmergencyRequiresFairValue: false,
    finalHardCompletionMaxQty: Math.max(config.finalHardCompletionMaxQty, ladder[ladder.length - 1] ?? 125),
    fairValueFailClosedForSeed: false,
    fairValueFailClosedForNegativePair: false,
    fairValueFailClosedForHighSideChase: false,
    requireStrictCapForHighLowMismatch: false,
    xuanBehaviorCap: elevatedBehaviorCap,
  };
}
