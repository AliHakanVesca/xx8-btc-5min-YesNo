import type { AppEnv } from "./schema.js";

export interface XuanStrategyConfig {
  stateStore: "SQLITE" | "JSON";
  stateStorePath: string;
  botMode: "STRICT" | "XUAN";
  xuanCloneMode: "OFF" | "PUBLIC_FOOTPRINT";
  xuanCloneIntensity: "CONTROLLED" | "AGGRESSIVE";
  xuanMinFillCountForPass: number;
  xuanTruePassRequiresProfit: boolean;
  xuanTruePassRequiresPairedContinuation: boolean;
  xuanMicroPairContinuationEnabled: boolean;
  xuanMicroPairProjectedEffectiveCap: number;
  xuanMicroPairMaxQty: number;
  xuanRhythmMinWaitSec: number;
  xuanRhythmBaseWaitSec: number;
  xuanRhythmMaxWaitSec: number;
  xuanCompletionEarlyReleaseMaxEffectivePair: number;
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
  strictNewCycleCap: number;
  softNewCycleCap: number;
  hardNewCycleCap: number;
  allowHardNewCycleOnlyIfPreviousCyclePositive: boolean;
  allowNewCycleWhenFlatOnly: boolean;
  maxConsecutiveBadCycles: number;
  badCycleCooldownSec: number;
  badCycleMode: "OFF" | "COMPLETION_ONLY";
  minSecondsBetweenNewCycles: number;
  requireReevaluationAfterEachCycle: boolean;
  maxNewCyclesPer30Sec: number;
  flatStateHardPairMaxQty: number;
  flatStateSoftPairMaxQty: number;
  residualStateSoftCompletionMaxQty: number;
  xuanBorderlineEntryEnabled: boolean;
  xuanBorderlineEntryMaxAgeSec: number;
  xuanBorderlineEntryMidMaxAgeSec: number;
  xuanBorderlineEntryLateMaxAgeSec: number;
  freshSeedHardCutoffSec: number;
  xuanBorderlineEntryMaxQty: number;
  xuanBorderlineEntryMidMaxQty: number;
  xuanBorderlineEntryLateMaxQty: number;
  xuanBorderlineEntryRequiresCoveredSeed: boolean;
  xuanBorderlineRawPairCap: number;
  xuanBorderlineEffectivePairCap: number;
  xuanBorderlineMidRawPairCap: number;
  xuanBorderlineMidEffectivePairCap: number;
  xuanBorderlineLateRawPairCap: number;
  xuanBorderlineLateEffectivePairCap: number;
  marketBasketScoringEnabled: boolean;
  marketBasketStrongRawPairCap: number;
  marketBasketStrongEffectivePairCap: number;
  marketBasketStrongMaxDegradation: number;
  marketBasketStrongAvgCap: number;
  marketBasketGoodAvgCap: number;
  marketBasketBorderlineAvgCap: number;
  marketBasketMinAvgImprovement: number;
  marketBasketMinMergeShares: number;
  marketBasketMergeEffectivePairCap: number;
  marketBasketMergeTargetMultiplier: number;
  marketBasketMergeTargetMaxShares: number;
  marketBasketContinuationEnabled: boolean;
  allowMarketBasketContinuationWithoutFairValue: boolean;
  marketBasketContinuationMinMatchedShares: number;
  marketBasketContinuationMaxEffectivePair: number;
  marketBasketContinuationProjectedEffectivePairCap: number;
  marketBasketContinuationMaxQty: number;
  balancedDebtContinuationEnabled: boolean;
  marketBasketMinDebtUsdc: number;
  initialBasketRecoveryPlanEnabled: boolean;
  initialBasketDebtSoftEffectiveCap: number;
  initialBasketDebtHardEffectiveCap: number;
  initialBasketWeakRecoveryQtyMultiplier: number;
  initialBasketMediumRecoveryQtyMultiplier: number;
  initialBasketHardDebtNoPlanMaxQty: number;
  initialNoRecoveryProbeMode: "SAFE" | "XUAN_FOOTPRINT";
  initialNoRecoveryProbePct: number;
  campaignLaunchStrongEffectiveCap: number;
  campaignLaunchRecoverableEffectiveCap: number;
  campaignLaunchApproachingEffectiveCap: number;
  campaignLaunchDiagnosticQty: number;
  campaignLaunchVwapTiers: number[];
  campaignLaunchXuanProbeEffectiveCap: number;
  campaignLaunchXuanProbeMaxAgeSec: number;
  campaignLaunchXuanProbePct: number;
  campaignLaunchXuanProbeMaxDebtUsdc: number;
  campaignLaunchXuanProbeMaxFairValueDrag: number;
  initialBasketMediumTerminalFairValueEdge: number;
  initialBasketStrongTerminalFairValueEdge: number;
  terminalCarryImprovementEnabled: boolean;
  terminalCarryMinEvGainUsdc: number;
  terminalCarryMinMinPnlImprovementUsdc: number;
  terminalCarryMaxAddedDebtUsdc: number;
  xuanBasketCampaignEnabled: boolean;
  xuanBasketCampaignMinMatchedShares: number;
  xuanBasketCampaignAvgImprovementMaxAddedDebtUsdc: number;
  xuanBasketCampaignAvgImprovementQtyMultiplier: number;
  xuanBasketCampaignDebtReducingQtyMultiplier: number;
  xuanBasketCampaignCompletionClipMaxQty: number;
  xuanBasketCampaignMinFlows: number;
  xuanBasketCampaignTargetFlows: number;
  xuanBasketCampaignFlowShapingEffectiveCap: number;
  xuanBasketCampaignFlowShapingQtyMultiplier: number;
  maxFlowShapingAddedDebtUsdc: number;
  maxFlowShapingClipsPerMarket: number;
  initialDebtyCampaignMaxHedgeRatio: number;
  fullRebalanceOnlyIfEffectivePairBelow: number;
  microRepairMaxQty: number;
  campaignMinClipPct: number;
  campaignDefaultClipPct: number;
  campaignCompletionMinPct: number;
  highLowDebtReducingEffectiveCap: number;
  highLowAvgImprovingMaxEffectivePair: number;
  highLowContinuationMinSpread: number;
  maxAvgImprovingAddedDebtUsdc: number;
  maxAvgImprovingClipsPerMarket: number;
  xuanTemporalCompletionMinAgeSec: number;
  xuanTemporalCompletionEarlyMaxEffectivePair: number;
  marketBasketBootstrapEnabled: boolean;
  marketBasketBootstrapMaxAgeSec: number;
  marketBasketBootstrapMaxEffectivePair: number;
  marketBasketBootstrapMaxQty: number;
  openingWeakPairRawThreshold: number;
  openingFollowupPlanMaxAgeSec: number;
  openingFollowupMinSpread: number;
  openingFollowupHighSideMinPrice: number;
  openingFollowupMaxEffectivePair: number;
  borderlinePairStagedEntryEnabled: boolean;
  borderlinePairInitialQty: number;
  borderlinePairFollowupQty: number;
  borderlinePairReevaluateAfterSec: number;
  borderlinePairRepeatCooldownSec: number;
  borderlinePairRepeatMinEffectiveImprovement: number;
  clipSplitMode: "OFF" | "DEPTH_ADAPTIVE_XUAN_BIAS";
  preferMulticlipWhenCostNeutral: boolean;
  deterministicTemplateDebugOnly: boolean;
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
  coveredSeedMissingFairValueMode: "FAIL_CLOSED" | "ALLOW_PAIR_REFERENCE_CAP";
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
  controlledOverlapMinResidualShares: number;
  controlledOverlapSeedMaxQty: number;
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
  highSideCompletionMaxQty: number;
  highSideCompletionSoftPriceThreshold: number;
  highSideCompletionMaxCost: number;
  highSideCompletionRequiresFairValue: boolean;
  highSideCompletionRequiresHardImbalance: boolean;
  highSideCompletionExactPriorBypass: boolean;
  completionQualityMaxEffectiveCost: number;
  completionQualityMaxNegativeEdgeUsdc: number;
  completionQualityEnforceAfterSec: number;
  completionTargetMaxDelaySec: number;
  completionUrgencyStrictSec: number;
  completionUrgencyPatientSec: number;
  completionUrgencyForceSec: number;
  completionUrgencyMaxPricePremium: number;
  residualJanitorEnabled: boolean;
  residualJanitorMaxQty: number;
  residualJanitorMaxShareGap: number;
  residualJanitorMaxInventoryShares: number;
  residualJanitorMaxEffectivePair: number;
  residualJanitorUnlockMaxEffectivePair: number;
  residualJanitorMinUnlockNetUsdc: number;
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
  temporalRepairFastCap: number;
  temporalRepairSoftCap: number;
  temporalRepairPatientCap: number;
  temporalRepairEmergencyCap: number;
  temporalRepairUltraFastWindowSec: number;
  temporalRepairUltraFastCap: number;
  temporalRepairUltraFastMissingFairValueCap: number;
  partialSoftMaxQty: number;
  partialHardMaxQty: number;
  partialEmergencyMaxQty: number;
  partialEmergencyRequiresFairValue: boolean;
  partialNoChaseLastSec: number;
  temporalSeedOwnDiscountWeight: number;
  temporalSeedRepairDiscountWeight: number;
  temporalSeedBehaviorRoomWeight: number;
  temporalSeedOppositeCoverageWeight: number;
  temporalSeedDepthWeight: number;
  temporalSeedSequenceBiasWeight: number;
  temporalSeedOrphanPenaltyWeight: number;
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
  cloneChildPreferredShares: number;
  cloneChildOrderDelayMs: number;
  cloneStaleCheapOppositeQuoteMinAgeSec: number;
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
  allowResidualCompletionWithoutFairValue: boolean;
  residualCompletionCostBasisCap: number;
  residualCompletionImprovementThreshold: number;
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
  forbidFlatBadCycleSpam: boolean;
  pairgroupFinalizeAfterBalanceSync: boolean;
  pairgroupFinalizeTimeoutMs: number;
  pairgroupRequireReconcileBeforeNoneFilled: boolean;
  mergeMinShares: number;
  mergeDebounceMs: number;
  mergeBatchMode: "IMMEDIATE" | "HYBRID_DELAYED";
  minCompletedCyclesBeforeFirstMerge: number;
  minFirstMatchedAgeBeforeMergeSec: number;
  maxMatchedAgeBeforeForcedMergeSec: number;
  requireMinAgeForCycleTargetMerge: boolean;
  mergeShieldSecFromOpen: number;
  forceMergeInLast30S: boolean;
  forceMergeOnHardImbalance: boolean;
  forceMergeOnLowCollateral: boolean;
  mergeOnEachReconcile: boolean;
  mergeOnMarketClose: boolean;
  mergeMaxTxPerMarket: number;
  mergeDustLeaveShares: number;
  hardImbalanceMergeMinAgeSec: number;
  hardImbalanceMergeOverlapGraceSec: number;
  hardImbalanceMergeMaxDeferrableShares: number;
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
    xuanCloneIntensity: env.XUAN_CLONE_INTENSITY,
    xuanMinFillCountForPass: env.XUAN_MIN_FILL_COUNT_FOR_PASS,
    xuanTruePassRequiresProfit: env.XUAN_TRUE_PASS_REQUIRES_PROFIT,
    xuanTruePassRequiresPairedContinuation: env.XUAN_TRUE_PASS_REQUIRES_PAIRED_CONTINUATION,
    xuanMicroPairContinuationEnabled: env.XUAN_MICRO_PAIR_CONTINUATION_ENABLED,
    xuanMicroPairProjectedEffectiveCap: env.XUAN_MICRO_PAIR_PROJECTED_EFFECTIVE_CAP,
    xuanMicroPairMaxQty: env.XUAN_MICRO_PAIR_MAX_QTY,
    xuanRhythmMinWaitSec: env.XUAN_RHYTHM_MIN_WAIT_SEC,
    xuanRhythmBaseWaitSec: env.XUAN_RHYTHM_BASE_WAIT_SEC,
    xuanRhythmMaxWaitSec: env.XUAN_RHYTHM_MAX_WAIT_SEC,
    xuanCompletionEarlyReleaseMaxEffectivePair: env.XUAN_COMPLETION_EARLY_RELEASE_MAX_EFFECTIVE_PAIR,
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
    strictNewCycleCap: env.STRICT_NEW_CYCLE_CAP,
    softNewCycleCap: env.SOFT_NEW_CYCLE_CAP,
    hardNewCycleCap: env.HARD_NEW_CYCLE_CAP,
    allowHardNewCycleOnlyIfPreviousCyclePositive: env.ALLOW_HARD_NEW_CYCLE_ONLY_IF_PREVIOUS_CYCLE_POSITIVE,
    allowNewCycleWhenFlatOnly: env.ALLOW_NEW_CYCLE_WHEN_FLAT_ONLY,
    maxConsecutiveBadCycles: env.MAX_CONSECUTIVE_BAD_CYCLES,
    badCycleCooldownSec: env.BAD_CYCLE_COOLDOWN_SEC,
    badCycleMode: env.BAD_CYCLE_MODE,
    minSecondsBetweenNewCycles: env.MIN_SECONDS_BETWEEN_NEW_CYCLES,
    requireReevaluationAfterEachCycle: env.REQUIRE_REEVALUATION_AFTER_EACH_CYCLE,
    maxNewCyclesPer30Sec: env.MAX_NEW_CYCLES_PER_30S,
    flatStateHardPairMaxQty: env.FLAT_STATE_HARD_PAIR_MAX_QTY,
    flatStateSoftPairMaxQty: env.FLAT_STATE_SOFT_PAIR_MAX_QTY,
    residualStateSoftCompletionMaxQty: env.RESIDUAL_STATE_SOFT_COMPLETION_MAX_QTY,
    xuanBorderlineEntryEnabled: env.XUAN_BORDERLINE_ENTRY_ENABLED,
    xuanBorderlineEntryMaxAgeSec: env.XUAN_BORDERLINE_ENTRY_MAX_AGE_SEC,
    xuanBorderlineEntryMidMaxAgeSec: env.XUAN_BORDERLINE_ENTRY_MID_MAX_AGE_SEC,
    xuanBorderlineEntryLateMaxAgeSec: env.XUAN_BORDERLINE_ENTRY_LATE_MAX_AGE_SEC,
    freshSeedHardCutoffSec: env.FRESH_SEED_HARD_CUTOFF_SEC,
    xuanBorderlineEntryMaxQty: env.XUAN_BORDERLINE_ENTRY_MAX_QTY,
    xuanBorderlineEntryMidMaxQty: env.XUAN_BORDERLINE_ENTRY_MID_MAX_QTY,
    xuanBorderlineEntryLateMaxQty: env.XUAN_BORDERLINE_ENTRY_LATE_MAX_QTY,
    xuanBorderlineEntryRequiresCoveredSeed: env.XUAN_BORDERLINE_ENTRY_REQUIRES_COVERED_SEED,
    xuanBorderlineRawPairCap: env.XUAN_BORDERLINE_RAW_PAIR_CAP,
    xuanBorderlineEffectivePairCap: env.XUAN_BORDERLINE_EFFECTIVE_PAIR_CAP,
    xuanBorderlineMidRawPairCap: env.XUAN_BORDERLINE_MID_RAW_PAIR_CAP,
    xuanBorderlineMidEffectivePairCap: env.XUAN_BORDERLINE_MID_EFFECTIVE_PAIR_CAP,
    xuanBorderlineLateRawPairCap: env.XUAN_BORDERLINE_LATE_RAW_PAIR_CAP,
    xuanBorderlineLateEffectivePairCap: env.XUAN_BORDERLINE_LATE_EFFECTIVE_PAIR_CAP,
    marketBasketScoringEnabled: env.MARKET_BASKET_SCORING_ENABLED,
    marketBasketStrongRawPairCap: env.MARKET_BASKET_STRONG_RAW_PAIR_CAP,
    marketBasketStrongEffectivePairCap: env.MARKET_BASKET_STRONG_EFFECTIVE_PAIR_CAP,
    marketBasketStrongMaxDegradation: env.MARKET_BASKET_STRONG_MAX_DEGRADATION,
    marketBasketStrongAvgCap: env.MARKET_BASKET_STRONG_AVG_CAP,
    marketBasketGoodAvgCap: env.MARKET_BASKET_GOOD_AVG_CAP,
    marketBasketBorderlineAvgCap: env.MARKET_BASKET_BORDERLINE_AVG_CAP,
    marketBasketMinAvgImprovement: env.MARKET_BASKET_MIN_AVG_IMPROVEMENT,
    marketBasketMinMergeShares: env.MARKET_BASKET_MIN_MERGE_SHARES,
    marketBasketMergeEffectivePairCap: env.MARKET_BASKET_MERGE_EFFECTIVE_PAIR_CAP,
    marketBasketMergeTargetMultiplier: env.MARKET_BASKET_MERGE_TARGET_MULTIPLIER,
    marketBasketMergeTargetMaxShares: env.MARKET_BASKET_MERGE_TARGET_MAX_SHARES,
    marketBasketContinuationEnabled: env.MARKET_BASKET_CONTINUATION_ENABLED,
    allowMarketBasketContinuationWithoutFairValue: env.ALLOW_MARKET_BASKET_CONTINUATION_WITHOUT_FAIR_VALUE,
    marketBasketContinuationMinMatchedShares: env.MARKET_BASKET_CONTINUATION_MIN_MATCHED_SHARES,
    marketBasketContinuationMaxEffectivePair: env.MARKET_BASKET_CONTINUATION_MAX_EFFECTIVE_PAIR,
    marketBasketContinuationProjectedEffectivePairCap: env.MARKET_BASKET_CONTINUATION_PROJECTED_EFFECTIVE_PAIR_CAP,
    marketBasketContinuationMaxQty: env.MARKET_BASKET_CONTINUATION_MAX_QTY,
    balancedDebtContinuationEnabled: env.BALANCED_DEBT_CONTINUATION_ENABLED,
    marketBasketMinDebtUsdc: env.MARKET_BASKET_MIN_DEBT_USDC,
    initialBasketRecoveryPlanEnabled: env.INITIAL_BASKET_RECOVERY_PLAN_ENABLED,
    initialBasketDebtSoftEffectiveCap: env.INITIAL_BASKET_DEBT_SOFT_EFFECTIVE_CAP,
    initialBasketDebtHardEffectiveCap: env.INITIAL_BASKET_DEBT_HARD_EFFECTIVE_CAP,
    initialBasketWeakRecoveryQtyMultiplier: env.INITIAL_BASKET_WEAK_RECOVERY_QTY_MULTIPLIER,
    initialBasketMediumRecoveryQtyMultiplier: env.INITIAL_BASKET_MEDIUM_RECOVERY_QTY_MULTIPLIER,
    initialBasketHardDebtNoPlanMaxQty: env.INITIAL_BASKET_HARD_DEBT_NO_PLAN_MAX_QTY,
    initialNoRecoveryProbeMode: env.INITIAL_NO_RECOVERY_PROBE_MODE,
    initialNoRecoveryProbePct: env.INITIAL_NO_RECOVERY_PROBE_PCT,
    campaignLaunchStrongEffectiveCap: env.CAMPAIGN_LAUNCH_STRONG_EFFECTIVE_CAP,
    campaignLaunchRecoverableEffectiveCap: env.CAMPAIGN_LAUNCH_RECOVERABLE_EFFECTIVE_CAP,
    campaignLaunchApproachingEffectiveCap: env.CAMPAIGN_LAUNCH_APPROACHING_EFFECTIVE_CAP,
    campaignLaunchDiagnosticQty: env.CAMPAIGN_LAUNCH_DIAGNOSTIC_QTY,
    campaignLaunchVwapTiers: env.CAMPAIGN_LAUNCH_VWAP_TIERS,
    campaignLaunchXuanProbeEffectiveCap: env.CAMPAIGN_LAUNCH_XUAN_PROBE_EFFECTIVE_CAP,
    campaignLaunchXuanProbeMaxAgeSec: env.CAMPAIGN_LAUNCH_XUAN_PROBE_MAX_AGE_SEC,
    campaignLaunchXuanProbePct: env.CAMPAIGN_LAUNCH_XUAN_PROBE_PCT,
    campaignLaunchXuanProbeMaxDebtUsdc: env.CAMPAIGN_LAUNCH_XUAN_PROBE_MAX_DEBT_USDC,
    campaignLaunchXuanProbeMaxFairValueDrag: env.CAMPAIGN_LAUNCH_XUAN_PROBE_MAX_FAIR_VALUE_DRAG,
    initialBasketMediumTerminalFairValueEdge: env.INITIAL_BASKET_MEDIUM_TERMINAL_FAIR_VALUE_EDGE,
    initialBasketStrongTerminalFairValueEdge: env.INITIAL_BASKET_STRONG_TERMINAL_FAIR_VALUE_EDGE,
    terminalCarryImprovementEnabled: env.TERMINAL_CARRY_IMPROVEMENT_ENABLED,
    terminalCarryMinEvGainUsdc: env.TERMINAL_CARRY_MIN_EV_GAIN_USDC,
    terminalCarryMinMinPnlImprovementUsdc: env.TERMINAL_CARRY_MIN_MIN_PNL_IMPROVEMENT_USDC,
    terminalCarryMaxAddedDebtUsdc: env.TERMINAL_CARRY_MAX_ADDED_DEBT_USDC,
    xuanBasketCampaignEnabled: env.XUAN_BASKET_CAMPAIGN_ENABLED,
    xuanBasketCampaignMinMatchedShares: env.XUAN_BASKET_CAMPAIGN_MIN_MATCHED_SHARES,
    xuanBasketCampaignAvgImprovementMaxAddedDebtUsdc: env.XUAN_BASKET_CAMPAIGN_AVG_IMPROVEMENT_MAX_ADDED_DEBT_USDC,
    xuanBasketCampaignAvgImprovementQtyMultiplier: env.XUAN_BASKET_CAMPAIGN_AVG_IMPROVEMENT_QTY_MULTIPLIER,
    xuanBasketCampaignDebtReducingQtyMultiplier: env.XUAN_BASKET_CAMPAIGN_DEBT_REDUCING_QTY_MULTIPLIER,
    xuanBasketCampaignCompletionClipMaxQty: env.XUAN_BASKET_CAMPAIGN_COMPLETION_CLIP_MAX_QTY,
    xuanBasketCampaignMinFlows: env.XUAN_BASKET_CAMPAIGN_MIN_FLOWS,
    xuanBasketCampaignTargetFlows: env.XUAN_BASKET_CAMPAIGN_TARGET_FLOWS,
    xuanBasketCampaignFlowShapingEffectiveCap: env.XUAN_BASKET_CAMPAIGN_FLOW_SHAPING_EFFECTIVE_CAP,
    xuanBasketCampaignFlowShapingQtyMultiplier: env.XUAN_BASKET_CAMPAIGN_FLOW_SHAPING_QTY_MULTIPLIER,
    maxFlowShapingAddedDebtUsdc: env.MAX_FLOW_SHAPING_ADDED_DEBT_USDC,
    maxFlowShapingClipsPerMarket: env.MAX_FLOW_SHAPING_CLIPS_PER_MARKET,
    initialDebtyCampaignMaxHedgeRatio: env.INITIAL_DEBTY_CAMPAIGN_MAX_HEDGE_RATIO,
    fullRebalanceOnlyIfEffectivePairBelow: env.FULL_REBALANCE_ONLY_IF_EFFECTIVE_PAIR_BELOW,
    microRepairMaxQty: env.MICRO_REPAIR_MAX_QTY,
    campaignMinClipPct: env.CAMPAIGN_MIN_CLIP_PCT,
    campaignDefaultClipPct: env.CAMPAIGN_DEFAULT_CLIP_PCT,
    campaignCompletionMinPct: env.CAMPAIGN_COMPLETION_MIN_PCT,
    highLowDebtReducingEffectiveCap: env.HIGH_LOW_DEBT_REDUCING_EFFECTIVE_CAP,
    highLowAvgImprovingMaxEffectivePair: env.HIGH_LOW_AVG_IMPROVING_MAX_EFFECTIVE_PAIR,
    highLowContinuationMinSpread: env.HIGH_LOW_CONTINUATION_MIN_SPREAD,
    maxAvgImprovingAddedDebtUsdc: env.MAX_AVG_IMPROVING_ADDED_DEBT_USDC,
    maxAvgImprovingClipsPerMarket: env.MAX_AVG_IMPROVING_CLIPS_PER_MARKET,
    xuanTemporalCompletionMinAgeSec: env.XUAN_TEMPORAL_COMPLETION_MIN_AGE_SEC,
    xuanTemporalCompletionEarlyMaxEffectivePair: env.XUAN_TEMPORAL_COMPLETION_EARLY_MAX_EFFECTIVE_PAIR,
    marketBasketBootstrapEnabled: env.MARKET_BASKET_BOOTSTRAP_ENABLED,
    marketBasketBootstrapMaxAgeSec: env.MARKET_BASKET_BOOTSTRAP_MAX_AGE_SEC,
    marketBasketBootstrapMaxEffectivePair: env.MARKET_BASKET_BOOTSTRAP_MAX_EFFECTIVE_PAIR,
    marketBasketBootstrapMaxQty: env.MARKET_BASKET_BOOTSTRAP_MAX_QTY,
    openingWeakPairRawThreshold: env.OPENING_WEAK_PAIR_RAW_THRESHOLD,
    openingFollowupPlanMaxAgeSec: env.OPENING_FOLLOWUP_PLAN_MAX_AGE_SEC,
    openingFollowupMinSpread: env.OPENING_FOLLOWUP_MIN_SPREAD,
    openingFollowupHighSideMinPrice: env.OPENING_FOLLOWUP_HIGH_SIDE_MIN_PRICE,
    openingFollowupMaxEffectivePair: env.OPENING_FOLLOWUP_MAX_EFFECTIVE_PAIR,
    borderlinePairStagedEntryEnabled: env.BORDERLINE_PAIR_STAGED_ENTRY_ENABLED,
    borderlinePairInitialQty: env.BORDERLINE_PAIR_INITIAL_QTY,
    borderlinePairFollowupQty: env.BORDERLINE_PAIR_FOLLOWUP_QTY,
    borderlinePairReevaluateAfterSec: env.BORDERLINE_PAIR_REEVALUATE_AFTER_SEC,
    borderlinePairRepeatCooldownSec: env.BORDERLINE_PAIR_REPEAT_COOLDOWN_SEC,
    borderlinePairRepeatMinEffectiveImprovement: env.BORDERLINE_PAIR_REPEAT_MIN_EFFECTIVE_IMPROVEMENT,
    clipSplitMode: env.CLIP_SPLIT_MODE,
    preferMulticlipWhenCostNeutral: env.PREFER_MULTICLIP_WHEN_COST_NEUTRAL,
    deterministicTemplateDebugOnly: env.DETERMINISTIC_TEMPLATE_DEBUG_ONLY,
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
    coveredSeedMissingFairValueMode: env.COVERED_SEED_MISSING_FAIR_VALUE_MODE,
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
    allowControlledOverlap: env.ALLOW_CONTROLLED_OVERLAP || env.ALLOW_TRUE_CONTROLLED_OVERLAP,
    controlledOverlapMinResidualShares: env.CONTROLLED_OVERLAP_MIN_RESIDUAL_SHARES,
    controlledOverlapSeedMaxQty: env.CONTROLLED_OVERLAP_SEED_MAX_QTY,
    allowOverlapOnlyAfterPartialClassified: env.ALLOW_OVERLAP_ONLY_AFTER_PARTIAL_CLASSIFIED,
    allowOverlapOnlyWhenCompletionEngineActive: env.ALLOW_OVERLAP_ONLY_WHEN_COMPLETION_ENGINE_ACTIVE,
    allowOverlapInLast30S: env.ALLOW_OVERLAP_IN_LAST_30S,
    requireMatchedInventoryBeforeSecondGroup: env.REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP,
    worstCaseAmplificationToleranceShares:
      env.MAX_WORST_CASE_AMPLIFICATION_SHARES > 0
        ? env.MAX_WORST_CASE_AMPLIFICATION_SHARES
        : env.WORST_CASE_AMPLIFICATION_TOLERANCE_SHARES,
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
    highSideCompletionMaxQty: env.HIGH_SIDE_COMPLETION_MAX_QTY,
    highSideCompletionSoftPriceThreshold: env.HIGH_SIDE_COMPLETION_SOFT_PRICE_THRESHOLD,
    highSideCompletionMaxCost: env.HIGH_SIDE_COMPLETION_MAX_COST,
    highSideCompletionRequiresFairValue: env.HIGH_SIDE_COMPLETION_REQUIRES_FAIR_VALUE,
    highSideCompletionRequiresHardImbalance: env.HIGH_SIDE_COMPLETION_REQUIRES_HARD_IMBALANCE,
    highSideCompletionExactPriorBypass: env.HIGH_SIDE_COMPLETION_EXACT_PRIOR_BYPASS,
    completionQualityMaxEffectiveCost: env.COMPLETION_QUALITY_MAX_EFFECTIVE_COST,
    completionQualityMaxNegativeEdgeUsdc: env.COMPLETION_QUALITY_MAX_NEGATIVE_EDGE_USDC,
    completionQualityEnforceAfterSec: env.COMPLETION_QUALITY_ENFORCE_AFTER_SEC,
    completionTargetMaxDelaySec: env.COMPLETION_TARGET_MAX_DELAY_SEC,
    completionUrgencyStrictSec: env.COMPLETION_URGENCY_STRICT_SEC,
    completionUrgencyPatientSec: env.COMPLETION_URGENCY_PATIENT_SEC,
    completionUrgencyForceSec: env.COMPLETION_URGENCY_FORCE_SEC,
    completionUrgencyMaxPricePremium: env.COMPLETION_URGENCY_MAX_PRICE_PREMIUM,
    residualJanitorEnabled: env.RESIDUAL_JANITOR_ENABLED,
    residualJanitorMaxQty: env.RESIDUAL_JANITOR_MAX_QTY,
    residualJanitorMaxShareGap: env.RESIDUAL_JANITOR_MAX_SHARE_GAP,
    residualJanitorMaxInventoryShares: env.RESIDUAL_JANITOR_MAX_INVENTORY_SHARES,
    residualJanitorMaxEffectivePair: env.RESIDUAL_JANITOR_MAX_EFFECTIVE_PAIR,
    residualJanitorUnlockMaxEffectivePair: env.RESIDUAL_JANITOR_UNLOCK_MAX_EFFECTIVE_PAIR,
    residualJanitorMinUnlockNetUsdc: env.RESIDUAL_JANITOR_MIN_UNLOCK_NET_USDC,
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
    temporalRepairFastCap: env.PARTIAL_FAST_CAP,
    temporalRepairSoftCap: env.PARTIAL_SOFT_CAP,
    temporalRepairPatientCap: env.PARTIAL_HARD_CAP,
    temporalRepairEmergencyCap: env.PARTIAL_EMERGENCY_CAP,
    temporalRepairUltraFastWindowSec: 0,
    temporalRepairUltraFastCap: env.PARTIAL_FAST_CAP,
    temporalRepairUltraFastMissingFairValueCap: env.PARTIAL_FAST_CAP,
    partialSoftMaxQty: env.PARTIAL_SOFT_MAX_QTY,
    partialHardMaxQty: env.PARTIAL_HARD_MAX_QTY,
    partialEmergencyMaxQty: env.PARTIAL_EMERGENCY_MAX_QTY,
    partialEmergencyRequiresFairValue: env.PARTIAL_EMERGENCY_REQUIRES_FAIR_VALUE,
    partialNoChaseLastSec: env.PARTIAL_NO_CHASE_LAST_SEC,
    temporalSeedOwnDiscountWeight: 12,
    temporalSeedRepairDiscountWeight: 4,
    temporalSeedBehaviorRoomWeight: 4,
    temporalSeedOppositeCoverageWeight: 2,
    temporalSeedDepthWeight: 1,
    temporalSeedSequenceBiasWeight: 1.5,
    temporalSeedOrphanPenaltyWeight: 0.05,
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
    cloneChildPreferredShares: 25,
    cloneChildOrderDelayMs: 0,
    cloneStaleCheapOppositeQuoteMinAgeSec: 75,
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
    allowResidualCompletionWithoutFairValue: env.ALLOW_RESIDUAL_COMPLETION_WITHOUT_FAIR_VALUE,
    residualCompletionCostBasisCap: env.RESIDUAL_COMPLETION_COST_BASIS_CAP,
    residualCompletionImprovementThreshold: env.RESIDUAL_COMPLETION_IMPROVEMENT_THRESHOLD,
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
    forbidFlatBadCycleSpam: env.FORBID_FLAT_BAD_CYCLE_SPAM,
    pairgroupFinalizeAfterBalanceSync: env.PAIRGROUP_FINALIZE_AFTER_BALANCE_SYNC,
    pairgroupFinalizeTimeoutMs: env.PAIRGROUP_FINALIZE_TIMEOUT_MS,
    pairgroupRequireReconcileBeforeNoneFilled: env.PAIRGROUP_REQUIRE_RECONCILE_BEFORE_NONE_FILLED,
    mergeDebounceMs: env.MERGE_DEBOUNCE_MS,
    mergeBatchMode: env.MERGE_BATCH_MODE,
    minCompletedCyclesBeforeFirstMerge: env.MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE,
    minFirstMatchedAgeBeforeMergeSec: env.MIN_FIRST_MATCHED_AGE_BEFORE_MERGE_SEC,
    maxMatchedAgeBeforeForcedMergeSec: env.MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC,
    requireMinAgeForCycleTargetMerge: env.REQUIRE_MIN_AGE_FOR_CYCLE_TARGET_MERGE,
    mergeShieldSecFromOpen: 0,
    forceMergeInLast30S: env.FORCE_MERGE_IN_LAST_30S,
    forceMergeOnHardImbalance: env.FORCE_MERGE_ON_HARD_IMBALANCE,
    forceMergeOnLowCollateral: env.FORCE_MERGE_ON_LOW_COLLATERAL,
    mergeOnEachReconcile: env.MERGE_ON_EACH_RECONCILE,
    mergeOnMarketClose: env.MERGE_ON_MARKET_CLOSE,
    mergeMaxTxPerMarket: env.MERGE_MAX_TX_PER_MARKET,
    mergeDustLeaveShares: env.MERGE_DUST_LEAVE_SHARES,
    hardImbalanceMergeMinAgeSec: env.HARD_IMBALANCE_MERGE_MIN_AGE_SEC,
    hardImbalanceMergeOverlapGraceSec: env.HARD_IMBALANCE_MERGE_OVERLAP_GRACE_SEC,
    hardImbalanceMergeMaxDeferrableShares: env.HARD_IMBALANCE_MERGE_MAX_DEFERRABLE_SHARES,
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

const DEFAULT_XUAN_BASE_LOT_LADDER = [30, 60, 90, 120];
const DEFAULT_LIVE_SMALL_LOT_LADDER = [5, 10, 15];

function sameNumberList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) <= 1e-9);
}

function normalizePublicFootprintLadder(ladder: readonly number[], fallback: number): number[] {
  const cleaned = [...new Set(ladder.filter((value) => Number.isFinite(value) && value > 0).map((value) => Number(value.toFixed(6))))].sort(
    (a, b) => a - b,
  );
  if (cleaned.length > 0) {
    return cleaned;
  }
  return [fallback].filter((value) => Number.isFinite(value) && value > 0);
}

function hasExplicitPublicFootprintLadder(config: XuanStrategyConfig): boolean {
  return (
    !sameNumberList(config.xuanBaseLotLadder, DEFAULT_XUAN_BASE_LOT_LADDER) ||
    !sameNumberList(config.liveSmallLotLadder, DEFAULT_LIVE_SMALL_LOT_LADDER)
  );
}

function aggressiveFloor(configured: number, defaultFloor: number, customFloor: number, customProfile: boolean): number {
  return Math.max(configured, customProfile ? customFloor : defaultFloor);
}

function applyPublicFootprintClone(config: XuanStrategyConfig): XuanStrategyConfig {
  const aggressive = config.xuanCloneIntensity === "AGGRESSIVE";
  const customAggressiveLadder = aggressive && hasExplicitPublicFootprintLadder(config);
  const configuredLadder = config.xuanBaseLotLadder.length > 0 ? config.xuanBaseLotLadder : config.liveSmallLotLadder;
  const ladder = aggressive
    ? customAggressiveLadder
      ? normalizePublicFootprintLadder(configuredLadder, config.defaultLot)
      : [60, 80, 145, 214, 265]
    : [30, 60, 90, 120, 145];
  const elevatedBehaviorCap = Math.max(config.xuanBehaviorCap, aggressive ? 1.3 : 1.25);
  const maxLadderLot = Math.max(ladder[ladder.length - 1] ?? 145, customAggressiveLadder ? 1 : 145);
  const customMarketBasketMinMergeShares = customAggressiveLadder
    ? Math.max(config.mergeMinShares, Math.min(config.marketBasketMinMergeShares, maxLadderLot))
    : config.marketBasketMinMergeShares;
  const publicFootprintMergeTargetMaxShares = customAggressiveLadder
    ? Math.max(
        customMarketBasketMinMergeShares,
        Math.min(
          config.marketBasketMergeTargetMaxShares,
          maxLadderLot * Math.max(1, config.marketBasketMergeTargetMultiplier),
        ),
      )
    : Math.max(config.marketBasketMergeTargetMaxShares, 900);
  const publicFootprintForcedMergeAgeSec = customAggressiveLadder
    ? config.maxMatchedAgeBeforeForcedMergeSec
    : Math.max(config.maxMatchedAgeBeforeForcedMergeSec, 180);
  const customSmallLadderMaxLot = customAggressiveLadder && maxLadderLot < 23.4 ? maxLadderLot : undefined;
  const publicFootprintMicroPairMaxQty =
    customSmallLadderMaxLot !== undefined
      ? Math.max(config.xuanMicroPairMaxQty, customSmallLadderMaxLot)
      : Math.min(Math.max(config.xuanMicroPairMaxQty, 5), ladder[0] ?? 5);
  const controlledRhythmMin = Math.max(1, Math.min(config.xuanRhythmMinWaitSec, config.xuanRhythmBaseWaitSec));
  const controlledRhythmBase = Math.max(config.xuanRhythmBaseWaitSec, controlledRhythmMin);
  const controlledRhythmMax = Math.max(config.xuanRhythmMaxWaitSec, controlledRhythmBase);
  const aggressiveRhythmMin = Math.max(4, Math.min(config.xuanRhythmMinWaitSec, 8));
  const aggressiveRhythmBase = Math.max(aggressiveRhythmMin, Math.min(config.xuanRhythmBaseWaitSec, 10));
  const aggressiveRhythmMax = Math.max(aggressiveRhythmBase, Math.min(config.xuanRhythmMaxWaitSec, 12));

  return {
    ...config,
    allowSingleLegSeed: true,
    allowTemporalSingleLegSeed: true,
    allowNakedSingleLegSeed: false,
    allowXuanCoveredSeed: true,
    allowCheapUnderdogSeed: true,
    xuanMinFillCountForPass: Math.max(config.xuanMinFillCountForPass, 3),
    xuanTruePassRequiresProfit: true,
    xuanTruePassRequiresPairedContinuation: true,
    xuanMicroPairContinuationEnabled: true,
    xuanMicroPairProjectedEffectiveCap: Math.max(config.xuanMicroPairProjectedEffectiveCap, 1.01),
    xuanMicroPairMaxQty: publicFootprintMicroPairMaxQty,
    xuanRhythmMinWaitSec: aggressive ? aggressiveRhythmMin : controlledRhythmMin,
    xuanRhythmBaseWaitSec: aggressive ? aggressiveRhythmBase : controlledRhythmBase,
    xuanRhythmMaxWaitSec: aggressive ? aggressiveRhythmMax : controlledRhythmMax,
    xuanCompletionEarlyReleaseMaxEffectivePair: Math.max(config.xuanCompletionEarlyReleaseMaxEffectivePair, 1),
    priceToBeatLateStartFallbackEnabled: aggressive ? true : config.priceToBeatLateStartFallbackEnabled,
    priceToBeatLateStartMaxMarketAgeSec: aggressive
      ? Math.max(config.priceToBeatLateStartMaxMarketAgeSec, 240)
      : config.priceToBeatLateStartMaxMarketAgeSec,
    coveredSeedRequiresFairValue: config.coveredSeedRequiresFairValue,
    coveredSeedAllowSamePairgroupOppositeOrder: true,
    coveredSeedAllowOppositeInventoryCover: true,
    coveredSeedRequireSamePairgroupOppositeOrder: aggressive ? false : config.coveredSeedRequireSamePairgroupOppositeOrder,
    singleLegFairValueVeto: config.singleLegFairValueVeto,
    xuanBaseLotLadder: ladder,
    liveSmallLotLadder: ladder,
    liveSmallLots: ladder,
    lotLadder: ladder,
    defaultLot: ladder[0] ?? config.defaultLot,
    xuanSoftSweepMaxQty: Math.max(config.xuanSoftSweepMaxQty, maxLadderLot),
    xuanHardSweepMaxQty: Math.max(config.xuanHardSweepMaxQty, maxLadderLot),
    coveredSeedMaxQty: Math.max(config.coveredSeedMaxQty, maxLadderLot),
    singleLegSeedMaxQty: Math.max(config.singleLegSeedMaxQty, maxLadderLot),
    maxSingleOrphanQty: Math.max(config.maxSingleOrphanQty, maxLadderLot),
    singleLegOrphanCap: Math.max(config.singleLegOrphanCap, aggressive ? 0.97 : 0.78),
    orphanLegMaxNotionalUsdc: aggressiveFloor(
      config.orphanLegMaxNotionalUsdc,
      320,
      Math.max(20, maxLadderLot * 0.98),
      customAggressiveLadder,
    ),
    maxMarketOrphanUsdc: aggressiveFloor(
      config.maxMarketOrphanUsdc,
      650,
      Math.max(20, maxLadderLot * 1.1),
      customAggressiveLadder,
    ),
    maxNegativePairEdgePerCycleUsdc: aggressiveFloor(
      config.maxNegativePairEdgePerCycleUsdc,
      60,
      Math.max(4, maxLadderLot * 0.08),
      customAggressiveLadder,
    ),
    maxNegativePairEdgePerMarketUsdc: aggressiveFloor(
      config.maxNegativePairEdgePerMarketUsdc,
      140,
      Math.max(8, maxLadderLot * 0.14),
      customAggressiveLadder,
    ),
    maxNegativeDailyBudgetUsdc: aggressiveFloor(
      config.maxNegativeDailyBudgetUsdc,
      180,
      Math.max(12, maxLadderLot * 0.2),
      customAggressiveLadder,
    ),
    maxNegativeEdgePerMarketUsdc: aggressiveFloor(
      config.maxNegativeEdgePerMarketUsdc,
      140,
      Math.max(8, maxLadderLot * 0.14),
      customAggressiveLadder,
    ),
    marketBasketBootstrapMaxQty: Math.max(config.marketBasketBootstrapMaxQty, maxLadderLot),
    marketBasketBootstrapMaxEffectivePair: Math.max(config.marketBasketBootstrapMaxEffectivePair, 1.055),
    freshSeedHardCutoffSec: aggressive ? Math.max(config.freshSeedHardCutoffSec, 290) : config.freshSeedHardCutoffSec,
    campaignLaunchXuanProbePct: Math.max(
      config.campaignLaunchXuanProbePct,
      aggressive ? 1 : config.campaignLaunchXuanProbePct,
    ),
    campaignLaunchXuanProbeMaxDebtUsdc: Math.max(
      config.campaignLaunchXuanProbeMaxDebtUsdc,
      aggressive ? 10 : config.campaignLaunchXuanProbeMaxDebtUsdc,
    ),
    campaignLaunchXuanProbeMaxAgeSec: Math.max(
      config.campaignLaunchXuanProbeMaxAgeSec,
      aggressive ? 285 : config.campaignLaunchXuanProbeMaxAgeSec,
    ),
    marketBasketContinuationMaxQty: Math.max(config.marketBasketContinuationMaxQty, maxLadderLot),
    marketBasketContinuationMinMatchedShares: Math.min(config.marketBasketContinuationMinMatchedShares, 30),
    marketBasketContinuationMaxEffectivePair: Math.max(config.marketBasketContinuationMaxEffectivePair, 1.2),
    marketBasketContinuationProjectedEffectivePairCap: Math.max(
      config.marketBasketContinuationProjectedEffectivePairCap,
      1.01,
    ),
    marketBasketBorderlineAvgCap: Math.max(config.marketBasketBorderlineAvgCap, 1.02),
    marketBasketMinMergeShares: customMarketBasketMinMergeShares,
    marketBasketMergeTargetMultiplier: Math.max(config.marketBasketMergeTargetMultiplier, 2.5),
    marketBasketMergeTargetMaxShares: publicFootprintMergeTargetMaxShares,
    xuanPairSweepSoftCap: Math.max(config.xuanPairSweepSoftCap, aggressive ? 1.08 : config.xuanPairSweepSoftCap),
    xuanPairSweepHardCap: Math.max(config.xuanPairSweepHardCap, aggressive ? 1.12 : config.xuanPairSweepHardCap),
    xuanMinTimeLeftForSoftSweep: aggressive ? Math.min(config.xuanMinTimeLeftForSoftSweep, 5) : config.xuanMinTimeLeftForSoftSweep,
    xuanMinTimeLeftForHardSweep: aggressive ? Math.min(config.xuanMinTimeLeftForHardSweep, 5) : config.xuanMinTimeLeftForHardSweep,
    maxMarketExposureShares: aggressiveFloor(
      config.maxMarketExposureShares,
      4200,
      Math.max(maxLadderLot * 2, config.maxMarketExposureShares),
      customAggressiveLadder,
    ),
    maxMarketSharesPerSide: aggressiveFloor(
      config.maxMarketSharesPerSide,
      4200,
      Math.max(maxLadderLot * 2, config.maxMarketSharesPerSide),
      customAggressiveLadder,
    ),
    maxOneSidedExposureShares: aggressiveFloor(
      config.maxOneSidedExposureShares,
      1800,
      Math.max(maxLadderLot, config.maxOneSidedExposureShares),
      customAggressiveLadder,
    ),
    maxCyclesPerMarket: aggressiveFloor(config.maxCyclesPerMarket, 45, config.maxCyclesPerMarket, customAggressiveLadder),
    maxBuysPerSide: aggressiveFloor(config.maxBuysPerSide, 45, config.maxBuysPerSide, customAggressiveLadder),
    maxConsecutiveSingleLegSeedsPerSide: Math.max(
      config.maxConsecutiveSingleLegSeedsPerSide,
      aggressive ? 3 : config.maxConsecutiveSingleLegSeedsPerSide,
    ),
    blockNewPairWhilePartialOpen: aggressive ? false : config.blockNewPairWhilePartialOpen,
    maxOpenGroupsPerMarket: Math.max(config.maxOpenGroupsPerMarket, aggressive ? 10 : config.maxOpenGroupsPerMarket),
    maxOpenPartialGroups: aggressive ? Math.max(config.maxOpenPartialGroups, 4) : config.maxOpenPartialGroups,
    partialOpenAction: "ALLOW_OVERLAP",
    allowControlledOverlap: true,
    controlledOverlapMinResidualShares: config.controlledOverlapMinResidualShares,
    controlledOverlapSeedMaxQty: config.controlledOverlapSeedMaxQty,
    allowOverlapOnlyAfterPartialClassified: aggressive ? false : config.allowOverlapOnlyAfterPartialClassified,
    allowOverlapOnlyWhenCompletionEngineActive: aggressive ? false : config.allowOverlapOnlyWhenCompletionEngineActive,
    requireMatchedInventoryBeforeSecondGroup: aggressive ? false : config.requireMatchedInventoryBeforeSecondGroup,
    worstCaseAmplificationToleranceShares: config.worstCaseAmplificationToleranceShares,
    postMergeNewSeedCooldownMs: 0,
    postMergePairReopenCooldownMs: 0,
    postMergeOnlyCompletion: false,
    postMergeOnlyCompletionWhileResidual: false,
    allowHighSideEmergencyChase: true,
    highSideEmergencyMaxQty: Math.max(config.highSideEmergencyMaxQty, maxLadderLot),
    highSideEmergencyRequiresFairValue: false,
    highSideEmergencyRequiresHardImbalance: false,
    highSideEmergencyCap: Math.max(config.highSideEmergencyCap, elevatedBehaviorCap),
    emergencyCompletionMaxQty: Math.max(config.emergencyCompletionMaxQty, maxLadderLot),
    emergencyCompletionHardCap: Math.max(config.emergencyCompletionHardCap, elevatedBehaviorCap),
    temporalRepairFastCap: Math.max(config.temporalRepairFastCap, aggressive ? 1.095 : 1.065),
    temporalRepairSoftCap: Math.max(config.temporalRepairSoftCap, aggressive ? 1.14 : 1.105),
    temporalRepairPatientCap: Math.max(config.temporalRepairPatientCap, aggressive ? 1.2 : 1.16),
    temporalRepairEmergencyCap: Math.max(config.temporalRepairEmergencyCap, elevatedBehaviorCap),
    temporalRepairUltraFastWindowSec: Math.max(config.temporalRepairUltraFastWindowSec, 12),
    temporalRepairUltraFastCap: Math.max(config.temporalRepairUltraFastCap, 1.095),
    temporalRepairUltraFastMissingFairValueCap: Math.max(
      config.temporalRepairUltraFastMissingFairValueCap,
      1.11,
    ),
    partialSoftMaxQty: aggressive
      ? Math.max(config.partialSoftMaxQty, maxLadderLot)
      : Math.min(Math.max(config.partialSoftMaxQty, maxLadderLot), config.residualStateSoftCompletionMaxQty),
    partialHardMaxQty: aggressive
      ? Math.max(config.partialHardMaxQty, maxLadderLot)
      : Math.min(Math.max(config.partialHardMaxQty, maxLadderLot), config.residualStateSoftCompletionMaxQty),
    partialEmergencyMaxQty: Math.max(config.partialEmergencyMaxQty, maxLadderLot),
    partialEmergencyRequiresFairValue: false,
    temporalSeedOwnDiscountWeight: 11,
    temporalSeedRepairDiscountWeight: 6,
    temporalSeedBehaviorRoomWeight: 5,
    temporalSeedOppositeCoverageWeight: 3,
    temporalSeedDepthWeight: 1,
    temporalSeedSequenceBiasWeight: 2.75,
    temporalSeedOrphanPenaltyWeight: 0.03,
    finalHardCompletionMaxQty: Math.max(config.finalHardCompletionMaxQty, maxLadderLot),
    normalEntryCutoffSecToClose: aggressive ? 30 : config.normalEntryCutoffSecToClose,
    completionOnlyCutoffSecToClose: aggressive ? 10 : config.completionOnlyCutoffSecToClose,
    hardCancelSecToClose: aggressive ? 5 : config.hardCancelSecToClose,
    finalWindowSoftStartSec: aggressive ? 30 : config.finalWindowSoftStartSec,
    finalWindowCompletionOnlySec: aggressive ? 10 : config.finalWindowCompletionOnlySec,
    finalWindowNoChaseSec: aggressive ? 5 : config.finalWindowNoChaseSec,
    allowNewPairInLast60S: aggressive ? true : config.allowNewPairInLast60S,
    allowNewPairInLast30S: aggressive ? true : config.allowNewPairInLast30S,
    allowSingleLegSeedInLast60S: aggressive ? true : config.allowSingleLegSeedInLast60S,
    allowAnyNewBuyInLast10S: aggressive ? false : config.allowAnyNewBuyInLast10S,
    fairValueFailClosedForSeed: false,
    fairValueFailClosedForNegativePair: config.fairValueFailClosedForNegativePair,
    fairValueFailClosedForHighSideChase: false,
    allowStrictResidualCompletionWithoutFairValue: true,
    allowResidualCompletionWithoutFairValue: true,
    residualCompletionCostBasisCap: Math.max(config.residualCompletionCostBasisCap, aggressive ? elevatedBehaviorCap : 1.095),
    softResidualCompletionCap: Math.max(config.softResidualCompletionCap, aggressive ? elevatedBehaviorCap : 1.13),
    completionQualityMaxEffectiveCost: Math.max(config.completionQualityMaxEffectiveCost, aggressive ? elevatedBehaviorCap : 1.13),
    completionQualityMaxNegativeEdgeUsdc: Math.max(config.completionQualityMaxNegativeEdgeUsdc, 2.25),
    campaignMinClipPct: aggressive ? Math.max(config.campaignMinClipPct, 0.75) : config.campaignMinClipPct,
    campaignCompletionMinPct: aggressive
      ? Math.max(config.campaignCompletionMinPct, 0.75)
      : config.campaignCompletionMinPct,
    campaignDefaultClipPct: aggressive ? Math.max(config.campaignDefaultClipPct, 1) : config.campaignDefaultClipPct,
    completionTargetMaxDelaySec: aggressive
      ? Math.min(config.completionTargetMaxDelaySec, 35)
      : Math.min(config.completionTargetMaxDelaySec, 45),
    completionUrgencyPatientSec: Math.min(config.completionUrgencyPatientSec, 30),
    completionUrgencyForceSec: Math.min(config.completionUrgencyForceSec, 90),
    xuanTemporalCompletionMinAgeSec: Math.max(
      config.xuanTemporalCompletionMinAgeSec,
      Math.max(1, Math.min(config.xuanRhythmMinWaitSec, config.xuanRhythmBaseWaitSec)),
    ),
    xuanTemporalCompletionEarlyMaxEffectivePair: Math.max(config.xuanTemporalCompletionEarlyMaxEffectivePair, 1.045),
    requireStrictCapForHighLowMismatch: false,
    highSideCompletionMaxQty: Math.max(config.highSideCompletionMaxQty, aggressive ? maxLadderLot : config.highSideCompletionMaxQty),
    highSideCompletionMaxCost: Math.max(config.highSideCompletionMaxCost, aggressive ? elevatedBehaviorCap : config.highSideCompletionMaxCost),
    highSideCompletionRequiresFairValue: aggressive ? false : config.highSideCompletionRequiresFairValue,
    highSideCompletionRequiresHardImbalance: aggressive ? false : config.highSideCompletionRequiresHardImbalance,
    xuanBehaviorCap: elevatedBehaviorCap,
    cloneChildPreferredShares: aggressive
      ? Math.max(config.cloneChildPreferredShares, ladder[0] ?? 80, customAggressiveLadder ? 1 : 80)
      : Math.min(config.cloneChildPreferredShares, 20),
    cloneChildOrderDelayMs: Math.max(config.cloneChildOrderDelayMs, 120),
    cloneStaleCheapOppositeQuoteMinAgeSec: Math.min(config.cloneStaleCheapOppositeQuoteMinAgeSec, 75),
    mergeBatchMode: "HYBRID_DELAYED",
    minCompletedCyclesBeforeFirstMerge: config.minCompletedCyclesBeforeFirstMerge,
    minFirstMatchedAgeBeforeMergeSec: config.minFirstMatchedAgeBeforeMergeSec,
    maxMatchedAgeBeforeForcedMergeSec: publicFootprintForcedMergeAgeSec,
    mergeShieldSecFromOpen: config.mergeShieldSecFromOpen,
    forceMergeInLast30S: true,
    forceMergeOnHardImbalance: true,
    reentryDelayMs: Math.min(config.reentryDelayMs, 350),
  };
}
