import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { XuanMarketState } from "./marketState.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import { matchedEffectivePairCost, mergeableShares } from "./inventoryState.js";
import { pairCostWithBothTaker } from "./sumAvgEngine.js";

export interface CompletionAllowance {
  allowed: boolean;
  capMode: "strict" | "soft" | "hard" | "emergency";
  negativeEdgeUsdc: number;
  highLowMismatch?: boolean;
  requiresFairValue?: boolean;
}

export interface PairSweepAllowance {
  allowed: boolean;
  mode?: Extract<
    StrategyExecutionMode,
    "STRICT_PAIR_SWEEP" | "XUAN_SOFT_PAIR_SWEEP" | "XUAN_HARD_PAIR_SWEEP"
  >;
  negativeEdgeUsdc: number;
  projectedMarketBudget: number;
  projectedDailyBudget: number;
  marketBasketBootstrap?: boolean;
  marketBasketContinuation?: boolean;
  marketBasketProjectedEffectivePair?: number;
  marketBasketProjectedMatchedQty?: number;
  continuationClass?: MarketBasketContinuationClass;
  campaignClipType?: MarketBasketClipType;
  avgImprovingBudgetRemainingUSDC?: number;
  avgImprovingClipBudgetRemaining?: number;
  continuationRejectedReason?: string;
  flowShapingBudgetRemainingUSDC?: number | undefined;
  flowShapingClipBudgetRemaining?: number | undefined;
  campaignFlowCount?: number | undefined;
  campaignFlowTarget?: number | undefined;
}

export type MarketBasketContinuationClass = "DEBT_REDUCING" | "AVG_IMPROVING" | "FLOW_SHAPING" | "BAD";
export type MarketBasketClipType =
  | "MICRO_REPAIR"
  | "CAMPAIGN_ENTRY"
  | "CAMPAIGN_COMPLETION"
  | "DEBT_REDUCING_CONTINUATION"
  | "STRONG_HIGH_LOW_CONTINUATION";

export interface CampaignCompletionSizing {
  campaignBaseLot: number;
  minCampaignClipQty: number;
  defaultCampaignClipQty: number;
  targetQty: number;
  maxQty: number;
  clipType: Extract<MarketBasketClipType, "MICRO_REPAIR" | "CAMPAIGN_COMPLETION">;
}

export interface MarketBasketContinuationProjection {
  allowed: boolean;
  projectedEffectivePair: number;
  projectedMatchedQty: number;
  currentMatchedQty: number;
  currentEffectivePair: number;
  improvement: number;
  campaignMode?: "BASKET_CAMPAIGN_ACTIVE" | "ACCUMULATING_CONTINUATION";
  campaignBaseLot?: number;
  plannedContinuationQty?: number;
  deltaAverageCost: number;
  edgePerPair: number;
  qtyNeededToRepayDebt?: number;
  deltaBasketDebtUSDC: number;
  addedDebtUSDC: number;
  continuationClass: MarketBasketContinuationClass;
  campaignClipType: MarketBasketClipType;
  avgImprovingBudgetRemainingUSDC: number;
  avgImprovingClipBudgetRemaining: number;
  flowShapingBudgetRemainingUSDC?: number;
  flowShapingClipBudgetRemaining?: number;
  campaignFlowCount?: number;
  campaignFlowTarget?: number;
  rejectedReason?: string;
  quality: "STRONG_BASKET" | "GOOD_BASKET" | "BORDERLINE_BASKET" | "BAD_BASKET";
}

interface AverageImprovingUsage {
  addedDebtUSDC: number;
  clipCount: number;
}

function estimateCampaignFlowCount(state: XuanMarketState): number {
  const buys = state.fillHistory
    .filter((fill) => fill.side === "BUY")
    .sort((left, right) => left.timestamp - right.timestamp);
  let flowCount = 0;
  let lastTimestamp: number | undefined;

  for (const fill of buys) {
    if (lastTimestamp === undefined || fill.timestamp - lastTimestamp > 4) {
      flowCount += 1;
    }
    lastTimestamp = fill.timestamp;
  }

  return flowCount;
}

function hasXuanCampaignBuy(state: XuanMarketState): boolean {
  return state.fillHistory.some(
    (fill) =>
      fill.side === "BUY" &&
      (
        fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" ||
        fill.executionMode === "PAIRGROUP_COVERED_SEED" ||
        fill.executionMode === "XUAN_HARD_PAIR_SWEEP" ||
        fill.executionMode === "XUAN_SOFT_PAIR_SWEEP" ||
        fill.executionMode === "STRICT_PAIR_SWEEP" ||
        fill.executionMode === "PARTIAL_FAST_COMPLETION" ||
        fill.executionMode === "PARTIAL_SOFT_COMPLETION" ||
        fill.executionMode === "HIGH_LOW_COMPLETION_CHASE"
      ),
  );
}

export interface PartialCompletionPhase {
  phase: "fast" | "soft" | "patient" | "emergency" | "post_merge";
  mode: Extract<
    StrategyExecutionMode,
    | "PARTIAL_FAST_COMPLETION"
    | "PARTIAL_SOFT_COMPLETION"
    | "PARTIAL_EMERGENCY_COMPLETION"
    | "POST_MERGE_RESIDUAL_COMPLETION"
  >;
  cap: number;
  maxQty: number;
  requiresFairValue: boolean;
}

export interface ResidualSeverity {
  level: "flat" | "micro" | "small" | "medium" | "aggressive";
  shares: number;
}

export interface ResidualBehaviorState {
  severity: ResidualSeverity;
  severityPressure: number;
  flowDensity: number;
  overlapRepairArbitration: OverlapRepairArbitration;
  riskToleranceBias: number;
  carryPersistenceBias: number;
  completionPatienceBias: number;
}

export type OverlapRepairArbitration =
  | "no_overlap_lock"
  | "standard_pair_reentry"
  | "favor_independent_overlap"
  | "favor_residual_repair";
export type CompletionReleaseRole = "neutral" | "mid_pair" | "high_low_setup";

export interface FlowPressureBudgetState {
  budget: number;
  budgetCeiling: number;
  consumedBudget: number;
  remainingBudget: number;
  supportive: boolean;
  assertive: boolean;
  confirmed: boolean;
  elite: boolean;
  requiredMatchedInventoryQuality: number;
  pairGateRelief: number;
}

export function estimateNegativeEdgeUsdc(costWithFees: number, size: number): number {
  return Math.max(0, costWithFees - 1) * size;
}

function normalizeTraceNumber(value: number): number {
  return Number(value.toFixed(6));
}

export function resolveCampaignCompletionSizing(
  config: XuanStrategyConfig,
  missingShares: number,
): CampaignCompletionSizing {
  const campaignBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
  const minCampaignPct = Math.max(config.campaignMinClipPct, config.campaignCompletionMinPct);
  const minCampaignClipQty = Math.max(config.completionMinQty, campaignBaseLot * minCampaignPct);
  const defaultCampaignClipQty = Math.max(minCampaignClipQty, campaignBaseLot * config.campaignDefaultClipPct);
  const maxQty = Math.max(config.completionMinQty, config.xuanBasketCampaignCompletionClipMaxQty);
  const boundedMissing = Math.max(0, missingShares);
  const campaignTarget =
    boundedMissing <= config.microRepairMaxQty + 1e-9
      ? boundedMissing
      : Math.min(boundedMissing, defaultCampaignClipQty, maxQty);
  const targetQty = Number(campaignTarget.toFixed(6));
  const clipType =
    boundedMissing <= config.microRepairMaxQty + 1e-9 || targetQty <= config.microRepairMaxQty + 1e-9
      ? "MICRO_REPAIR"
      : "CAMPAIGN_COMPLETION";

  return {
    campaignBaseLot: normalizeTraceNumber(campaignBaseLot),
    minCampaignClipQty: normalizeTraceNumber(minCampaignClipQty),
    defaultCampaignClipQty: normalizeTraceNumber(defaultCampaignClipQty),
    targetQty,
    maxQty: normalizeTraceNumber(maxQty),
    clipType,
  };
}

function isPairedContinuationMode(mode: StrategyExecutionMode | undefined): boolean {
  return mode === "PAIRGROUP_COVERED_SEED" || mode === "XUAN_HARD_PAIR_SWEEP" || mode === "XUAN_SOFT_PAIR_SWEEP";
}

function estimateAverageImprovingContinuationUsage(
  config: XuanStrategyConfig,
  state: XuanMarketState,
): AverageImprovingUsage {
  const buys = state.fillHistory
    .filter((fill) => fill.side === "BUY" && isPairedContinuationMode(fill.executionMode))
    .sort((left, right) => left.timestamp - right.timestamp);
  const used = new Set<number>();
  let addedDebtUSDC = 0;
  let clipCount = 0;

  for (let leftIndex = 0; leftIndex < buys.length; leftIndex += 1) {
    if (used.has(leftIndex)) {
      continue;
    }
    const left = buys[leftIndex]!;
    let matchIndex = -1;
    for (let rightIndex = leftIndex + 1; rightIndex < buys.length; rightIndex += 1) {
      if (used.has(rightIndex)) {
        continue;
      }
      const right = buys[rightIndex]!;
      if (right.outcome === left.outcome) {
        continue;
      }
      if (Math.abs(right.timestamp - left.timestamp) > 4) {
        continue;
      }
      matchIndex = rightIndex;
      break;
    }
    if (matchIndex < 0) {
      continue;
    }
    const right = buys[matchIndex]!;
    used.add(leftIndex);
    used.add(matchIndex);
    const up = left.outcome === "UP" ? left : right;
    const down = left.outcome === "DOWN" ? left : right;
    const spread = Math.abs(up.price - down.price);
    const effectivePair = pairCostWithBothTaker(up.price, down.price, config.cryptoTakerFeeRate);
    if (
      effectivePair < config.highLowDebtReducingEffectiveCap - 1e-9 ||
      effectivePair > config.xuanBasketCampaignFlowShapingEffectiveCap + 1e-9 ||
      (effectivePair > config.highLowAvgImprovingMaxEffectivePair + 1e-9 &&
        spread + 1e-9 < config.highLowContinuationMinSpread)
    ) {
      continue;
    }
    const pairedSize = Math.min(up.size, down.size);
    addedDebtUSDC += Math.max(0, effectivePair - 1) * pairedSize;
    clipCount += 1;
  }

  return {
    addedDebtUSDC: normalizeTraceNumber(addedDebtUSDC),
    clipCount,
  };
}

function classifyContinuationCandidate(
  config: XuanStrategyConfig,
  currentEffectivePair: number,
  candidateEffectivePair: number,
): MarketBasketContinuationClass {
  if (candidateEffectivePair < config.highLowDebtReducingEffectiveCap - 1e-9) {
    return "DEBT_REDUCING";
  }
  if (
    candidateEffectivePair <= config.highLowAvgImprovingMaxEffectivePair + 1e-9 &&
    candidateEffectivePair < currentEffectivePair - config.marketBasketMinAvgImprovement + 1e-9
  ) {
    return "AVG_IMPROVING";
  }
  if (
    candidateEffectivePair <= config.xuanBasketCampaignFlowShapingEffectiveCap + 1e-9 &&
    candidateEffectivePair < currentEffectivePair - config.marketBasketMinAvgImprovement + 1e-9
  ) {
    return "FLOW_SHAPING";
  }
  return "BAD";
}

function classifyCampaignContinuationClipType(args: {
  config: XuanStrategyConfig;
  continuationClass: MarketBasketContinuationClass;
  candidateEffectivePair: number;
  priceSpread?: number | undefined;
}): MarketBasketClipType {
  if (args.continuationClass === "DEBT_REDUCING") {
    const strongHighLow =
      args.priceSpread !== undefined &&
      args.priceSpread + 1e-9 >= args.config.highLowContinuationMinSpread &&
      args.candidateEffectivePair <= args.config.marketBasketStrongAvgCap + 1e-9;
    return strongHighLow ? "STRONG_HIGH_LOW_CONTINUATION" : "DEBT_REDUCING_CONTINUATION";
  }
  if (args.continuationClass === "AVG_IMPROVING") {
    return "CAMPAIGN_COMPLETION";
  }
  if (args.continuationClass === "FLOW_SHAPING") {
    return "CAMPAIGN_ENTRY";
  }
  return "CAMPAIGN_ENTRY";
}

export function marketBasketContinuationProjection(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  costWithFees: number;
  candidateSize: number;
  secsToClose: number;
  priceSpread?: number | undefined;
}): MarketBasketContinuationProjection | undefined {
  if (
    !args.config.marketBasketScoringEnabled ||
    !args.config.marketBasketContinuationEnabled ||
    args.candidateSize <= 0 ||
    !Number.isFinite(args.costWithFees)
  ) {
    return undefined;
  }
  const currentMatchedQty = mergeableShares(args.state);
  const currentEffectivePair = matchedEffectivePairCost(args.state, args.config.cryptoTakerFeeRate);
  const residualQty = Math.abs(args.state.upShares - args.state.downShares);
  const currentDebtUSDC = Math.max(0, currentEffectivePair - 1) * currentMatchedQty;
  const campaignBaseLot = args.config.liveSmallLotLadder[0] ?? args.config.defaultLot;
  const campaignFlowCount = estimateCampaignFlowCount(args.state);
  const campaignFlowTarget = Math.max(1, args.config.xuanBasketCampaignMinFlows);
  const campaignMergeTargetQty = Math.max(
    args.config.marketBasketMinMergeShares,
    Math.min(
      args.config.marketBasketMergeTargetMaxShares,
      campaignBaseLot * Math.max(1, args.config.marketBasketMergeTargetMultiplier),
    ),
  );
  const hasCampaignBuy = hasXuanCampaignBuy(args.state);
  const debtPositiveCampaignActive =
    args.config.xuanBasketCampaignEnabled &&
    currentMatchedQty >= args.config.xuanBasketCampaignMinMatchedShares - 1e-9 &&
    currentDebtUSDC > args.config.marketBasketMinDebtUsdc + 1e-9 &&
    currentEffectivePair > args.config.marketBasketGoodAvgCap + 1e-9 &&
    (
      residualQty <= Math.max(args.config.postMergeFlatDustShares, 1e-6) + 1e-9 ||
      hasCampaignBuy
    );
  const postProfitCampaignActive =
    args.config.xuanBasketCampaignEnabled &&
    args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    hasCampaignBuy &&
    currentMatchedQty >= args.config.xuanBasketCampaignMinMatchedShares - 1e-9 &&
    residualQty <= Math.max(args.config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
    currentEffectivePair <= args.config.marketBasketMergeEffectivePairCap + 1e-9 &&
    currentMatchedQty < campaignMergeTargetQty - 1e-9 &&
    campaignFlowCount < campaignFlowTarget &&
    args.secsToClose > args.config.finalWindowCompletionOnlySec;
  const campaignActive = debtPositiveCampaignActive || postProfitCampaignActive;
  if (
    currentMatchedQty < args.config.marketBasketContinuationMinMatchedShares - 1e-9 &&
    !campaignActive
  ) {
    return undefined;
  }
  const projectedMatchedQty = currentMatchedQty + args.candidateSize;
  const projectedEffectivePair =
    (currentMatchedQty * currentEffectivePair + args.candidateSize * args.costWithFees) /
    Math.max(projectedMatchedQty, 1e-9);
  const improvement = currentEffectivePair - projectedEffectivePair;
  const projectedDebtUSDC = Math.max(0, projectedEffectivePair - 1) * projectedMatchedQty;
  const deltaBasketDebtUSDC = currentDebtUSDC - projectedDebtUSDC;
  const edgePerPair = 1 - args.costWithFees;
  const addedDebtUSDC = Math.max(0, args.costWithFees - 1) * args.candidateSize;
  const averageImprovingUsage = estimateAverageImprovingContinuationUsage(args.config, args.state);
  const avgImprovingBudgetRemainingUSDC = Math.max(
    0,
    Math.min(
      args.config.xuanBasketCampaignAvgImprovementMaxAddedDebtUsdc,
      args.config.maxAvgImprovingAddedDebtUsdc,
    ) - averageImprovingUsage.addedDebtUSDC,
  );
  const avgImprovingClipBudgetRemaining = Math.max(
    0,
    args.config.maxAvgImprovingClipsPerMarket - averageImprovingUsage.clipCount,
  );
  const flowShapingBudgetRemainingUSDC = Math.max(
    0,
    args.config.maxFlowShapingAddedDebtUsdc - averageImprovingUsage.addedDebtUSDC,
  );
  const flowShapingClipBudgetRemaining = Math.max(
    0,
    args.config.maxFlowShapingClipsPerMarket - averageImprovingUsage.clipCount,
  );
  const balancedButDebted =
    args.config.balancedDebtContinuationEnabled &&
    currentMatchedQty >= args.config.marketBasketContinuationMinMatchedShares - 1e-9 &&
    residualQty <= Math.max(args.config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
    currentDebtUSDC > args.config.marketBasketMinDebtUsdc + 1e-9;
  const qtyNeededToRepayDebt =
    balancedButDebted && edgePerPair > 1e-9
      ? currentDebtUSDC / edgePerPair
      : undefined;
  const quality =
    projectedEffectivePair <= args.config.marketBasketStrongAvgCap + 1e-9
      ? "STRONG_BASKET"
      : projectedEffectivePair <= args.config.marketBasketGoodAvgCap + 1e-9
        ? "GOOD_BASKET"
        : projectedEffectivePair <= args.config.marketBasketBorderlineAvgCap + 1e-9
          ? "BORDERLINE_BASKET"
          : "BAD_BASKET";
  const continuationClass = classifyContinuationCandidate(args.config, currentEffectivePair, args.costWithFees);
  const campaignClipType = classifyCampaignContinuationClipType({
    config: args.config,
    continuationClass,
    candidateEffectivePair: args.costWithFees,
    priceSpread: args.priceSpread,
  });
  const spreadEligible =
    args.priceSpread === undefined || args.priceSpread + 1e-9 >= args.config.highLowContinuationMinSpread;
  const improvesBorderlineBasket =
    projectedEffectivePair <= args.config.marketBasketBorderlineAvgCap + 1e-9 &&
    deltaBasketDebtUSDC >= args.config.marketBasketMinAvgImprovement * Math.max(args.candidateSize, 1);
  const keepsGoodBasket = projectedEffectivePair <= args.config.marketBasketContinuationProjectedEffectivePairCap + 1e-9;
  const reducesBalancedDebt =
    balancedButDebted &&
    edgePerPair > 1e-9 &&
    args.costWithFees < currentEffectivePair - args.config.marketBasketMinAvgImprovement + 1e-9 &&
    deltaBasketDebtUSDC >= args.config.marketBasketMinAvgImprovement * Math.max(args.candidateSize, 1);
  const averageImprovesCampaign =
    campaignActive &&
    continuationClass === "AVG_IMPROVING" &&
    spreadEligible &&
    args.costWithFees < currentEffectivePair - args.config.marketBasketMinAvgImprovement + 1e-9 &&
    addedDebtUSDC <= avgImprovingBudgetRemainingUSDC + 1e-9 &&
    avgImprovingClipBudgetRemaining > 0 &&
    args.candidateSize <= campaignBaseLot * args.config.xuanBasketCampaignAvgImprovementQtyMultiplier + 1e-9;
  const campaignDebtReducer =
    campaignActive &&
    continuationClass === "DEBT_REDUCING" &&
    edgePerPair > 1e-9 &&
    args.candidateSize <= campaignBaseLot * args.config.xuanBasketCampaignDebtReducingQtyMultiplier + 1e-9;
  const campaignFlowShaping =
    campaignActive &&
    continuationClass === "FLOW_SHAPING" &&
    campaignFlowCount < campaignFlowTarget &&
    args.costWithFees <= args.config.xuanBasketCampaignFlowShapingEffectiveCap + 1e-9 &&
    args.costWithFees < currentEffectivePair - args.config.marketBasketMinAvgImprovement + 1e-9 &&
    addedDebtUSDC <= flowShapingBudgetRemainingUSDC + 1e-9 &&
    flowShapingClipBudgetRemaining > 0 &&
    args.candidateSize <= campaignBaseLot * args.config.xuanBasketCampaignFlowShapingQtyMultiplier + 1e-9;
  const flowShapingTraceOnly =
    campaignFlowShaping &&
    deltaBasketDebtUSDC <= 0 &&
    addedDebtUSDC > 0;
  const continuationWindowOpen = balancedButDebted
    ? args.secsToClose > args.config.finalWindowCompletionOnlySec
    : campaignActive
      ? args.secsToClose > args.config.finalWindowCompletionOnlySec
      : args.secsToClose > args.config.xuanMinTimeLeftForHardSweep;
  const debtReducingBasketAllowed =
    continuationClass === "DEBT_REDUCING" &&
    (keepsGoodBasket || improvesBorderlineBasket || reducesBalancedDebt || campaignDebtReducer);
  const allowed =
    continuationWindowOpen &&
    args.candidateSize <= args.config.marketBasketContinuationMaxQty + 1e-9 &&
    args.costWithFees <= args.config.marketBasketContinuationMaxEffectivePair + 1e-9 &&
    (debtReducingBasketAllowed || averageImprovesCampaign);
  const rejectedReason =
    continuationClass === "BAD"
      ? args.costWithFees > args.config.highLowAvgImprovingMaxEffectivePair + 1e-9 &&
        args.costWithFees < currentEffectivePair - args.config.marketBasketMinAvgImprovement + 1e-9
        ? "avg_improving_pair_too_expensive"
        : "continuation_not_debt_reducing_or_avg_improving"
      : flowShapingTraceOnly
        ? "flow_shaping_trace_only"
      : continuationClass === "FLOW_SHAPING" && campaignFlowCount >= campaignFlowTarget
        ? "flow_shaping_flow_target_met"
      : continuationClass === "FLOW_SHAPING" && flowShapingClipBudgetRemaining <= 0
        ? "flow_shaping_clip_budget_exhausted"
      : continuationClass === "FLOW_SHAPING" && addedDebtUSDC > flowShapingBudgetRemainingUSDC + 1e-9
        ? "flow_shaping_budget_exhausted"
      : continuationClass === "FLOW_SHAPING" &&
          args.candidateSize > campaignBaseLot * args.config.xuanBasketCampaignFlowShapingQtyMultiplier + 1e-9
        ? "flow_shaping_qty_cap"
      : continuationClass === "AVG_IMPROVING" && !spreadEligible
        ? "avg_improving_spread_too_small"
      : continuationClass === "AVG_IMPROVING" && avgImprovingClipBudgetRemaining <= 0
        ? "avg_improving_clip_budget_exhausted"
        : continuationClass === "AVG_IMPROVING" && addedDebtUSDC > avgImprovingBudgetRemainingUSDC + 1e-9
          ? "avg_improving_budget_exhausted"
          : continuationClass === "AVG_IMPROVING" &&
              args.candidateSize > campaignBaseLot * args.config.xuanBasketCampaignAvgImprovementQtyMultiplier + 1e-9
            ? "avg_improving_qty_cap"
            : continuationClass === "DEBT_REDUCING" &&
                args.candidateSize > campaignBaseLot * args.config.xuanBasketCampaignDebtReducingQtyMultiplier + 1e-9
              ? "debt_reducing_qty_cap"
              : undefined;

  return {
    allowed,
    projectedEffectivePair: normalizeTraceNumber(projectedEffectivePair),
    projectedMatchedQty: normalizeTraceNumber(projectedMatchedQty),
    currentMatchedQty: normalizeTraceNumber(currentMatchedQty),
    currentEffectivePair: normalizeTraceNumber(currentEffectivePair),
    improvement: normalizeTraceNumber(improvement),
    ...(campaignActive
      ? {
          campaignMode: allowed ? "ACCUMULATING_CONTINUATION" : "BASKET_CAMPAIGN_ACTIVE",
          campaignBaseLot: normalizeTraceNumber(campaignBaseLot),
          plannedContinuationQty: normalizeTraceNumber(args.candidateSize),
        }
      : {}),
    deltaAverageCost: normalizeTraceNumber(improvement),
    edgePerPair: normalizeTraceNumber(edgePerPair),
    ...(qtyNeededToRepayDebt !== undefined
      ? { qtyNeededToRepayDebt: normalizeTraceNumber(qtyNeededToRepayDebt) }
      : {}),
    deltaBasketDebtUSDC: normalizeTraceNumber(deltaBasketDebtUSDC),
    addedDebtUSDC: normalizeTraceNumber(addedDebtUSDC),
    continuationClass,
    campaignClipType,
    avgImprovingBudgetRemainingUSDC: normalizeTraceNumber(avgImprovingBudgetRemainingUSDC),
    avgImprovingClipBudgetRemaining,
    flowShapingBudgetRemainingUSDC: normalizeTraceNumber(flowShapingBudgetRemainingUSDC),
    flowShapingClipBudgetRemaining,
    campaignFlowCount,
    campaignFlowTarget,
    ...(rejectedReason && !allowed ? { rejectedReason } : {}),
    quality,
  };
}

export function marketBasketBootstrapAllowed(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  costWithFees: number;
  candidateSize: number;
  secsToClose: number;
}): boolean {
  if (
    !args.config.marketBasketScoringEnabled ||
    !args.config.marketBasketBootstrapEnabled ||
    args.config.xuanCloneMode !== "PUBLIC_FOOTPRINT" ||
    args.candidateSize <= 0 ||
    !Number.isFinite(args.costWithFees)
  ) {
    return false;
  }
  const secsFromOpen = Math.max(0, args.config.marketDurationSec - args.secsToClose);
  const flat =
    args.state.upShares + args.state.downShares <= Math.max(args.config.postMergeFlatDustShares, 1e-6) &&
    Math.abs(args.state.upShares - args.state.downShares) <= Math.max(args.config.postMergeFlatDustShares, 1e-6);
  return (
    flat &&
    secsFromOpen <= args.config.marketBasketBootstrapMaxAgeSec + 1e-9 &&
    args.candidateSize <= args.config.marketBasketBootstrapMaxQty + 1e-9 &&
    args.costWithFees <= args.config.marketBasketBootstrapMaxEffectivePair + 1e-9
  );
}

export function pairEntryCap(config: XuanStrategyConfig): number {
  return config.pairSweepStrictCap;
}

function residualSeverityThresholds(
  config: Pick<XuanStrategyConfig, "completionMinQty" | "repairMinQty" | "defaultLot" | "liveSmallLotLadder">,
): {
  microThreshold: number;
  smallThreshold: number;
  mediumThreshold: number;
} {
  const baseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
  const microThreshold = Math.max(config.completionMinQty * 2, Math.min(10, baseLot * 0.15));
  const smallThreshold = Math.max(microThreshold * 2, baseLot * 0.35);
  const mediumThreshold = Math.max(smallThreshold * 2, baseLot * 0.8);
  return {
    microThreshold,
    smallThreshold,
    mediumThreshold,
  };
}

export function classifyResidualSeverity(
  config: Pick<XuanStrategyConfig, "completionMinQty" | "repairMinQty" | "defaultLot" | "liveSmallLotLadder">,
  residualShares: number,
): ResidualSeverity {
  const shares = Math.max(0, residualShares);
  if (shares <= 1e-6) {
    return {
      level: "flat",
      shares: 0,
    };
  }

  const { microThreshold, smallThreshold, mediumThreshold } = residualSeverityThresholds(config);

  return {
    level:
      shares <= microThreshold
        ? "micro"
        : shares <= smallThreshold
          ? "small"
          : shares <= mediumThreshold
            ? "medium"
            : "aggressive",
    shares,
  };
}

export function residualSeverityPressure(
  config: Pick<XuanStrategyConfig, "completionMinQty" | "repairMinQty" | "defaultLot" | "liveSmallLotLadder">,
  residualShares: number,
): number {
  const shares = Math.max(0, residualShares);
  if (shares <= 1e-6) {
    return 0;
  }
  const { mediumThreshold } = residualSeverityThresholds(config);
  const normalized = shares / Math.max(mediumThreshold, 1e-6);
  return Number(Math.min(1.25, normalized).toFixed(6));
}

export function deriveFlowPressureBudget(args: {
  carryFlowConfidence?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  residualSeverityPressure?: number | undefined;
}): number {
  const carryFlowConfidence = Math.max(0, args.carryFlowConfidence ?? 0);
  const matchedInventoryQuality = Math.max(0, args.matchedInventoryQuality ?? 0);
  const recentSeedFlowCount = Math.max(0, args.recentSeedFlowCount ?? 0);
  const activeIndependentFlowCount = Math.max(0, args.activeIndependentFlowCount ?? 0);
  const residualPressure = Math.max(0, args.residualSeverityPressure ?? 0);
  const densityBonus = recentSeedFlowCount >= 2 ? 0.16 : recentSeedFlowCount >= 1 ? 0.08 : 0;
  const independentFlowBonus =
    activeIndependentFlowCount >= 3
      ? 0.18
      : activeIndependentFlowCount >= 2
        ? 0.12
        : activeIndependentFlowCount >= 1
          ? 0.04
          : 0;
  const lowPressureBonus =
    residualPressure <= 0.35
      ? 0.18
      : residualPressure <= 0.55
        ? 0.1
        : residualPressure <= 0.8
          ? 0.04
          : 0;
  return Number(
    Math.min(
      1.45,
      Math.min(0.8, carryFlowConfidence * 0.72) +
        Math.min(0.32, matchedInventoryQuality * 0.28) +
        densityBonus +
        independentFlowBonus +
        lowPressureBonus,
    ).toFixed(6),
  );
}

export function classifyFlowPressureBudget(args: {
  budget: number;
  matchedInventoryQuality?: number | undefined;
}): FlowPressureBudgetState {
  const budget = Math.max(0, args.budget);
  const budgetCeiling = 1.45;
  const normalizedBudget = Math.max(0, Math.min(1, budget / budgetCeiling));
  const remainingBudget = Number(normalizedBudget.toFixed(6));
  const consumedBudget = Number((1 - normalizedBudget).toFixed(6));
  const matchedInventoryQuality = Math.max(0, args.matchedInventoryQuality ?? 0);
  const supportive = budget >= 0.42;
  const assertive = budget >= 0.52;
  const confirmed = budget >= 0.82;
  const elite = budget >= 1.05;
  const requiredMatchedInventoryQuality = elite ? 0.5 : confirmed ? 0.55 : 0.6;
  const pairGateRelief =
    matchedInventoryQuality >= 0.85
      ? elite
        ? 0.003
        : confirmed
          ? 0.0015
          : 0
      : 0;
  return {
    budget,
    budgetCeiling,
    consumedBudget,
    remainingBudget,
    supportive,
    assertive,
    confirmed,
    elite,
    requiredMatchedInventoryQuality,
    pairGateRelief,
  };
}

export function deriveFlowPressureBudgetState(args: {
  carryFlowConfidence?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  recentSeedFlowCount?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  residualSeverityPressure?: number | undefined;
}): FlowPressureBudgetState {
  return classifyFlowPressureBudget({
    budget: deriveFlowPressureBudget(args),
    matchedInventoryQuality: args.matchedInventoryQuality,
  });
}

function computeOverlapRepairArbitration(args: {
  config: Pick<XuanStrategyConfig, "allowControlledOverlap" | "xuanCloneMode">;
  severity: ResidualSeverity["level"];
  severityPressure: number;
  flowDensity: number;
}): OverlapRepairArbitration {
  if (!args.config.allowControlledOverlap) {
    return "no_overlap_lock";
  }
  const allowStackedOverlapBias =
    args.flowDensity >= 2 && (args.severity === "small" || args.severity === "medium");
  const smallResidualBias =
    args.severity === "small" &&
    (args.flowDensity >= 1 || args.severityPressure <= 0.55);
  const mediumResidualBias =
    args.severity === "medium" &&
    ((args.flowDensity >= 1 && args.severityPressure <= 0.55) ||
      (args.flowDensity >= 2 && args.severityPressure <= 0.8));
  if (args.config.xuanCloneMode === "PUBLIC_FOOTPRINT") {
    return args.severity === "micro" || args.severity === "small" || allowStackedOverlapBias || mediumResidualBias
      ? "favor_independent_overlap"
      : "favor_residual_repair";
  }

  return args.severity === "micro" || smallResidualBias || allowStackedOverlapBias || mediumResidualBias
    ? "favor_independent_overlap"
    : "favor_residual_repair";
}

export function resolveResidualBehaviorState(args: {
  config: Pick<XuanStrategyConfig, "allowControlledOverlap" | "xuanCloneMode" | "completionMinQty" | "repairMinQty" | "defaultLot" | "liveSmallLotLadder">;
  residualShares: number;
  shareGap: number;
  recentSeedFlowCount?: number;
  activeIndependentFlowCount?: number;
}): ResidualBehaviorState {
  const severity = classifyResidualSeverity(args.config, Math.max(args.residualShares, args.shareGap));
  const severityPressure = residualSeverityPressure(args.config, Math.max(args.residualShares, args.shareGap));
  const flowDensity = Math.max(args.recentSeedFlowCount ?? 0, args.activeIndependentFlowCount ?? 0);
  const flowDensityBonus = flowDensity >= 2 ? 0.2 : flowDensity >= 1 ? 0.1 : 0;
  const independentFlowBonus =
    (args.activeIndependentFlowCount ?? 0) >= 3
      ? 0.16
      : (args.activeIndependentFlowCount ?? 0) >= 2
        ? 0.08
        : 0;
  const lowPressureBonus =
    severityPressure <= 0.35 ? 0.2 : severityPressure <= 0.55 ? 0.1 : 0;
  const baseRiskTolerance =
    severity.level === "micro"
      ? 0.7
      : severity.level === "small"
        ? 0.52
        : severity.level === "medium"
          ? 0.28
          : severity.level === "flat"
            ? 0.45
            : 0.05;
  const riskToleranceBias = Number(
    Math.max(0, Math.min(1, baseRiskTolerance + flowDensityBonus + independentFlowBonus + lowPressureBonus)).toFixed(6),
  );
  const carryPersistenceBias = Number(
    Math.max(
      0.85,
      Math.min(
        1.8,
        0.85 +
          (severity.level === "micro" ? 0.4 : severity.level === "small" ? 0.3 : severity.level === "medium" ? 0.15 : 0) +
          flowDensityBonus * 1.5 +
          independentFlowBonus * 1.25 +
          Math.max(0, 1 - Math.min(1, severityPressure)) * 0.4,
      ),
    ).toFixed(6),
  );
  const completionPatienceBias = Number(
    Math.max(1, Math.min(1.75, 1 + riskToleranceBias * 0.45 + (flowDensity >= 2 ? 0.1 : 0))).toFixed(6),
  );
  return {
    severity,
    severityPressure,
    flowDensity,
    riskToleranceBias,
    carryPersistenceBias,
    completionPatienceBias,
    overlapRepairArbitration:
      args.residualShares <= 1e-6
        ? "standard_pair_reentry"
        : computeOverlapRepairArbitration({
            config: args.config,
            severity: severity.level,
            severityPressure,
            flowDensity,
          }),
  };
}

export interface ResidualCompletionDelayProfile {
  shouldDelay: boolean;
  completionReleaseRole: CompletionReleaseRole;
  residualSeverityLevel: "flat" | "micro" | "small" | "medium" | "aggressive";
  calibrationPatienceMultiplier: number;
  rolePatienceMultiplier: number;
  effectivePatienceMultiplier: number;
  completionPatienceBias: number;
  waitUntilSec: number;
  pricePremium: number;
  definitelyNotCheapLate: boolean;
}

export function resolveResidualCompletionDelayProfile(args: {
  config: Pick<
    XuanStrategyConfig,
    | "botMode"
    | "allowControlledOverlap"
    | "xuanCloneMode"
    | "partialFastWindowSec"
    | "partialSoftWindowSec"
    | "partialPatientWindowSec"
    | "finalWindowCompletionOnlySec"
    | "completionMinQty"
    | "repairMinQty"
    | "defaultLot"
    | "liveSmallLotLadder"
    | "lowSideMaxForHighCompletion"
    | "highSidePriceThreshold"
    | "completionTargetMaxDelaySec"
    | "completionUrgencyStrictSec"
    | "completionUrgencyPatientSec"
    | "completionUrgencyForceSec"
    | "completionUrgencyMaxPricePremium"
  >;
  residualShares: number;
  partialAgeSec: number;
  secsToClose: number;
  oppositeAveragePrice: number;
  missingSidePrice: number;
  exactPriorActive: boolean;
  exceptionalMode: boolean;
  recentSeedFlowCount?: number;
  activeIndependentFlowCount?: number;
  completionPatienceMultiplier?: number;
}): ResidualCompletionDelayProfile {
  const behaviorState = resolveResidualBehaviorState({
    config: args.config,
    residualShares: args.residualShares,
    shareGap: args.residualShares,
    ...(args.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: args.recentSeedFlowCount } : {}),
    ...(args.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: args.activeIndependentFlowCount } : {}),
  });
  const severity = behaviorState.severity;
  const baseWaitUntilSec =
    severity.level === "micro"
      ? args.config.partialPatientWindowSec
      : severity.level === "small"
        ? args.config.partialSoftWindowSec
        : args.config.partialFastWindowSec;
  const completionReleaseRole = classifyCompletionReleaseRole({
    config: args.config,
    oppositeAveragePrice: args.oppositeAveragePrice,
    missingSidePrice: args.missingSidePrice,
  });
  const calibrationPatienceMultiplier = args.completionPatienceMultiplier ?? 1;
  const rolePatienceMultiplier = completionReleasePatienceMultiplier({
    role: completionReleaseRole,
    severity: severity.level,
    calibrationPatienceMultiplier,
  });
  const effectivePatienceMultiplier = Math.max(
    0.25,
    Math.min(1.35, calibrationPatienceMultiplier * rolePatienceMultiplier),
  );
  const behaviorWaitUntilSec = baseWaitUntilSec * behaviorState.completionPatienceBias * effectivePatienceMultiplier;
  const urgencyPatientSec =
    args.config.botMode === "XUAN"
      ? Math.max(args.config.partialFastWindowSec, args.config.completionUrgencyPatientSec)
      : args.config.partialPatientWindowSec;
  const xuanTargetMaxDelaySec =
    args.config.botMode === "XUAN" && args.config.completionTargetMaxDelaySec > 0
      ? Math.max(args.config.partialFastWindowSec, Math.min(args.config.completionTargetMaxDelaySec, urgencyPatientSec))
      : args.config.partialPatientWindowSec;
  const waitUntilSec = Math.min(
    args.config.partialPatientWindowSec,
    xuanTargetMaxDelaySec,
    behaviorWaitUntilSec,
  );
  const pricePremium = args.missingSidePrice - args.oppositeAveragePrice;
  const definitelyNotCheapLate =
    args.missingSidePrice > args.config.lowSideMaxForHighCompletion + 0.03 ||
    args.oppositeAveragePrice < args.config.highSidePriceThreshold - 0.08;
  const urgencyForceResolution =
    args.config.botMode === "XUAN" &&
    args.config.completionUrgencyForceSec > 0 &&
    args.partialAgeSec >= args.config.completionUrgencyForceSec;
  const delayCandidate =
    args.config.botMode === "XUAN" &&
    !urgencyForceResolution &&
    !args.exactPriorActive &&
    !args.exceptionalMode &&
    severity.level !== "flat" &&
    severity.level !== "aggressive" &&
    args.secsToClose > args.config.finalWindowCompletionOnlySec;

  return {
    shouldDelay:
      delayCandidate &&
      args.partialAgeSec < waitUntilSec &&
      pricePremium > args.config.completionUrgencyMaxPricePremium &&
      definitelyNotCheapLate,
    completionReleaseRole,
    residualSeverityLevel: severity.level,
    calibrationPatienceMultiplier,
    rolePatienceMultiplier,
    effectivePatienceMultiplier,
    completionPatienceBias: behaviorState.completionPatienceBias,
    waitUntilSec,
    pricePremium,
    definitelyNotCheapLate,
  };
}

export function shouldDelayResidualCompletion(
  args: Parameters<typeof resolveResidualCompletionDelayProfile>[0],
): boolean {
  return resolveResidualCompletionDelayProfile(args).shouldDelay;
}

export function completionReleasePatienceMultiplier(args: {
  role: CompletionReleaseRole;
  severity: "flat" | "micro" | "small" | "medium" | "aggressive";
  calibrationPatienceMultiplier: number;
}): number {
  if (args.calibrationPatienceMultiplier > 1) {
    return 1;
  }
  if (args.role === "high_low_setup") {
    if (args.severity === "micro") {
      return 0.78;
    }
    if (args.severity === "small") {
      return 0.86;
    }
    return 0.94;
  }
  if (args.role === "mid_pair") {
    return args.severity === "micro" ? 0.96 : 1;
  }
  return 1;
}

export function classifyCompletionReleaseRole(args: {
  config: Pick<XuanStrategyConfig, "lowSideMaxForHighCompletion" | "highSidePriceThreshold">;
  oppositeAveragePrice: number;
  missingSidePrice: number;
}): CompletionReleaseRole {
  const lowPrice = Math.min(args.oppositeAveragePrice, args.missingSidePrice);
  const highPrice = Math.max(args.oppositeAveragePrice, args.missingSidePrice);
  const spread = highPrice - lowPrice;
  const highLowVisible =
    spread >= 0.24 &&
    lowPrice <= args.config.lowSideMaxForHighCompletion + 0.06 &&
    highPrice >= args.config.highSidePriceThreshold - 0.12;
  if (highLowVisible) {
    return "high_low_setup";
  }
  if (
    args.oppositeAveragePrice >= 0.38 &&
    args.oppositeAveragePrice <= 0.62 &&
    args.missingSidePrice >= 0.38 &&
    args.missingSidePrice <= 0.62
  ) {
    return "mid_pair";
  }
  return "neutral";
}

export function resolveOverlapRepairArbitration(args: {
  config: Pick<XuanStrategyConfig, "allowControlledOverlap" | "xuanCloneMode" | "completionMinQty" | "repairMinQty" | "defaultLot" | "liveSmallLotLadder">;
  protectedResidualShares: number;
  shareGap: number;
  recentSeedFlowCount?: number;
  activeIndependentFlowCount?: number;
}): OverlapRepairArbitration {
  return resolveResidualBehaviorState({
    config: args.config,
    residualShares: args.protectedResidualShares,
    shareGap: args.shareGap,
    ...(args.recentSeedFlowCount !== undefined ? { recentSeedFlowCount: args.recentSeedFlowCount } : {}),
    ...(args.activeIndependentFlowCount !== undefined ? { activeIndependentFlowCount: args.activeIndependentFlowCount } : {}),
  }).overlapRepairArbitration;
}

export function resolvePartialCompletionPhase(args: {
  config: XuanStrategyConfig;
  partialAgeSec: number;
  secsToClose: number;
  postMergeCompletionOnly: boolean;
  capFamily?: "partial" | "temporal_repair";
}): PartialCompletionPhase {
  const fastCap =
    args.capFamily === "temporal_repair" ? args.config.temporalRepairFastCap : args.config.partialFastCap;
  const softCap =
    args.capFamily === "temporal_repair" ? args.config.temporalRepairSoftCap : args.config.partialSoftCap;
  const patientCap =
    args.capFamily === "temporal_repair" ? args.config.temporalRepairPatientCap : args.config.partialHardCap;
  const emergencyCap =
    args.capFamily === "temporal_repair"
      ? args.config.temporalRepairEmergencyCap
      : args.config.partialEmergencyCap;

  if (args.postMergeCompletionOnly) {
    return {
      phase: "post_merge",
      mode: "POST_MERGE_RESIDUAL_COMPLETION",
      cap: Math.min(args.config.partialSoftCap, args.config.completionSoftCap),
      maxQty: args.config.partialSoftMaxQty,
      requiresFairValue: false,
    };
  }

  if (args.partialAgeSec <= args.config.partialFastWindowSec) {
    return {
      phase: "fast",
      mode: "PARTIAL_FAST_COMPLETION",
      cap: fastCap,
      maxQty: Number.POSITIVE_INFINITY,
      requiresFairValue: false,
    };
  }

  if (args.partialAgeSec <= args.config.partialSoftWindowSec) {
    return {
      phase: "soft",
      mode: "PARTIAL_SOFT_COMPLETION",
      cap: softCap,
      maxQty: args.config.partialSoftMaxQty,
      requiresFairValue: false,
    };
  }

  if (args.partialAgeSec <= args.config.partialPatientWindowSec) {
    return {
      phase: "patient",
      mode: "PARTIAL_SOFT_COMPLETION",
      cap: patientCap,
      maxQty: args.config.partialHardMaxQty,
      requiresFairValue: false,
    };
  }

  return {
    phase: "emergency",
    mode: "PARTIAL_EMERGENCY_COMPLETION",
    cap: emergencyCap,
    maxQty: args.config.partialEmergencyMaxQty,
    requiresFairValue: args.config.partialEmergencyRequiresFairValue,
  };
}

export function pairSweepAllowance(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  costWithFees: number;
  candidateSize: number;
  secsToClose: number;
  priceSpread?: number | undefined;
  dailyNegativeEdgeSpentUsdc?: number | undefined;
  carryFlowConfidence?: number | undefined;
  matchedInventoryQuality?: number | undefined;
  activeIndependentFlowCount?: number | undefined;
  flowPressureState?: FlowPressureBudgetState | undefined;
}): PairSweepAllowance {
  const negativeEdgeUsdc = estimateNegativeEdgeUsdc(args.costWithFees, args.candidateSize);
  const imbalanceShares = Math.abs(args.state.upShares - args.state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(args.state.upShares + args.state.downShares, 1);
  const projectedMarketBudget = args.state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc;
  const projectedDailyBudget = (args.dailyNegativeEdgeSpentUsdc ?? 0) + negativeEdgeUsdc;
  const bootstrapAllowed = marketBasketBootstrapAllowed(args);
  const basketContinuation = marketBasketContinuationProjection(args);

  if (args.secsToClose <= args.config.finalWindowNoChaseSec && !args.config.allowAnyNewBuyInLast10S) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.secsToClose <= args.config.finalWindowCompletionOnlySec && !args.config.allowNewPairInLast30S) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (basketContinuation?.allowed) {
    return {
      allowed: true,
      mode: "XUAN_HARD_PAIR_SWEEP",
      negativeEdgeUsdc: 0,
      projectedMarketBudget: args.state.negativePairEdgeConsumedUsdc,
      projectedDailyBudget: args.dailyNegativeEdgeSpentUsdc ?? 0,
      marketBasketContinuation: true,
      marketBasketProjectedEffectivePair: basketContinuation.projectedEffectivePair,
      marketBasketProjectedMatchedQty: basketContinuation.projectedMatchedQty,
      continuationClass: basketContinuation.continuationClass,
      campaignClipType: basketContinuation.campaignClipType,
      avgImprovingBudgetRemainingUSDC: basketContinuation.avgImprovingBudgetRemainingUSDC,
      avgImprovingClipBudgetRemaining: basketContinuation.avgImprovingClipBudgetRemaining,
      flowShapingBudgetRemainingUSDC: basketContinuation.flowShapingBudgetRemainingUSDC,
      flowShapingClipBudgetRemaining: basketContinuation.flowShapingClipBudgetRemaining,
      campaignFlowCount: basketContinuation.campaignFlowCount,
      campaignFlowTarget: basketContinuation.campaignFlowTarget,
    };
  }

  if (basketContinuation) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
      marketBasketContinuation: true,
      marketBasketProjectedEffectivePair: basketContinuation.projectedEffectivePair,
      marketBasketProjectedMatchedQty: basketContinuation.projectedMatchedQty,
      continuationClass: basketContinuation.continuationClass,
      campaignClipType: basketContinuation.campaignClipType,
      avgImprovingBudgetRemainingUSDC: basketContinuation.avgImprovingBudgetRemainingUSDC,
      avgImprovingClipBudgetRemaining: basketContinuation.avgImprovingClipBudgetRemaining,
      flowShapingBudgetRemainingUSDC: basketContinuation.flowShapingBudgetRemainingUSDC,
      flowShapingClipBudgetRemaining: basketContinuation.flowShapingClipBudgetRemaining,
      campaignFlowCount: basketContinuation.campaignFlowCount,
      campaignFlowTarget: basketContinuation.campaignFlowTarget,
      ...(basketContinuation.rejectedReason
        ? { continuationRejectedReason: basketContinuation.rejectedReason }
        : {}),
    };
  }

  if (args.secsToClose <= args.config.finalWindowSoftStartSec && !args.config.allowNewPairInLast60S) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.costWithFees <= args.config.pairSweepStrictCap) {
    return {
      allowed: true,
      mode: "STRICT_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (args.config.botMode !== "XUAN" || !args.config.allowInitialNegativePairSweep) {
    return {
      allowed: false,
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  const withinCycleBudget = negativeEdgeUsdc <= args.config.maxNegativePairEdgePerCycleUsdc;
  const withinMarketBudget = projectedMarketBudget <= args.config.maxNegativePairEdgePerMarketUsdc;
  const withinDailyBudget = projectedDailyBudget <= args.config.maxNegativeDailyBudgetUsdc;
  const flowPressureState =
    args.flowPressureState ??
    deriveFlowPressureBudgetState({
      carryFlowConfidence: args.carryFlowConfidence,
      matchedInventoryQuality: args.matchedInventoryQuality,
      recentSeedFlowCount: Math.round(imbalanceRatio <= args.config.softImbalanceRatio ? 1 : 0),
      activeIndependentFlowCount: args.activeIndependentFlowCount,
      residualSeverityPressure: residualSeverityPressure(args.config, imbalanceShares),
    });
  const effectiveSoftSweepCap = Math.min(
    args.config.xuanBehaviorCap,
    args.config.xuanPairSweepSoftCap + flowPressureState.pairGateRelief,
  );

  if (
    args.costWithFees <= effectiveSoftSweepCap &&
    args.candidateSize <= args.config.xuanSoftSweepMaxQty &&
    args.secsToClose > args.config.xuanMinTimeLeftForSoftSweep &&
    imbalanceRatio <= args.config.softImbalanceRatio &&
    withinCycleBudget &&
    withinMarketBudget &&
    withinDailyBudget
  ) {
    return {
      allowed: true,
      mode: "XUAN_SOFT_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (
    args.config.enableXuanHardPairSweep &&
    args.costWithFees <= args.config.xuanPairSweepHardCap &&
    args.candidateSize <= args.config.xuanHardSweepMaxQty &&
    args.secsToClose > args.config.xuanMinTimeLeftForHardSweep &&
    imbalanceRatio <= args.config.hardImbalanceRatio &&
    withinCycleBudget &&
    withinMarketBudget &&
    withinDailyBudget
  ) {
    return {
      allowed: true,
      mode: "XUAN_HARD_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
    };
  }

  if (bootstrapAllowed && withinCycleBudget && withinMarketBudget && withinDailyBudget) {
    return {
      allowed: true,
      mode: "XUAN_HARD_PAIR_SWEEP",
      negativeEdgeUsdc,
      projectedMarketBudget,
      projectedDailyBudget,
      marketBasketBootstrap: true,
    };
  }

  return {
    allowed: false,
    negativeEdgeUsdc,
    projectedMarketBudget,
    projectedDailyBudget,
  };
}

export function completionAllowance(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  args: {
    costWithFees: number;
    candidateSize: number;
    oppositeAveragePrice: number;
    missingSidePrice: number;
    partialAgeSec?: number;
  },
): CompletionAllowance {
  const strictResidualCap = Math.min(config.completionStrictCap, config.strictResidualCompletionCap);
  const softResidualCap = Math.min(config.completionSoftCap, config.softResidualCompletionCap);
  const negativeEdgeUsdc = estimateNegativeEdgeUsdc(args.costWithFees, args.candidateSize);
  const imbalanceShares = Math.abs(state.upShares - state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(state.upShares + state.downShares, 1);
  const projectedBudget = state.negativeCompletionEdgeConsumedUsdc + negativeEdgeUsdc;
  const priceSpikeDelta = args.missingSidePrice - args.oppositeAveragePrice;
  const priceSpikeRatio = args.missingSidePrice / Math.max(args.oppositeAveragePrice, 0.01);
  const cloneSpikeMismatch =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    (args.partialAgeSec ?? 0) >= Math.max(10, config.partialFastWindowSec) &&
    args.missingSidePrice >= config.highSidePriceThreshold - 0.02 &&
    priceSpikeDelta >= 0.45 &&
    priceSpikeRatio >= 2.25;
  const highLowMismatch =
    (config.requireStrictCapForHighLowMismatch || config.xuanCloneMode === "PUBLIC_FOOTPRINT") &&
    ((args.missingSidePrice >= config.highSidePriceThreshold &&
      args.oppositeAveragePrice <= config.lowSideMaxForHighCompletion) ||
      cloneSpikeMismatch);

  if (config.botMode === "STRICT") {
    return {
      allowed: args.costWithFees <= strictResidualCap,
      capMode: "strict",
      negativeEdgeUsdc,
      ...(highLowMismatch ? { highLowMismatch } : {}),
    };
  }

  if (args.costWithFees <= strictResidualCap) {
    return {
      allowed: true,
      capMode: "strict",
      negativeEdgeUsdc,
      ...(highLowMismatch ? { highLowMismatch } : {}),
    };
  }

  if (highLowMismatch) {
    if (
      config.allowHighSideEmergencyChase &&
      args.candidateSize <= config.highSideEmergencyMaxQty &&
      args.costWithFees <= config.highSideEmergencyCap &&
      (!config.highSideEmergencyRequiresHardImbalance || imbalanceRatio >= config.hardImbalanceRatio)
    ) {
      return {
        allowed: true,
        capMode: "emergency",
        negativeEdgeUsdc,
        highLowMismatch,
        requiresFairValue: config.highSideEmergencyRequiresFairValue,
      };
    }
    return {
      allowed: false,
      capMode: "strict",
      negativeEdgeUsdc,
      highLowMismatch,
    };
  }

  if (
    args.costWithFees <= softResidualCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    imbalanceRatio >= config.softImbalanceRatio
  ) {
    return {
      allowed: true,
      capMode: "soft",
      negativeEdgeUsdc,
    };
  }

  if (
    args.costWithFees <= config.completionHardCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    imbalanceRatio >= config.hardImbalanceRatio
  ) {
    return {
      allowed: true,
      capMode: "hard",
      negativeEdgeUsdc,
    };
  }

  if (
    args.candidateSize <= config.emergencyCompletionMaxQty &&
    args.costWithFees <= config.emergencyCompletionHardCap &&
    projectedBudget <= config.maxNegativeEdgePerMarketUsdc &&
    (!config.emergencyRequiresHardImbalance || imbalanceRatio >= config.hardImbalanceRatio)
  ) {
    return {
      allowed: true,
      capMode: "emergency",
      negativeEdgeUsdc,
    };
  }

  return {
    allowed: false,
    capMode:
      args.costWithFees <= softResidualCap
        ? "soft"
        : args.costWithFees <= config.completionHardCap
          ? "hard"
          : "emergency",
    negativeEdgeUsdc,
    ...(highLowMismatch ? { highLowMismatch } : {}),
  };
}

export function highSideCompletionQualitySkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  args: {
    costWithFees: number;
    candidateSize: number;
    missingSidePrice: number;
    exactPriorActive: boolean;
    fairValueAllowed: boolean;
  },
): string | undefined {
  if (config.botMode !== "XUAN") {
    return undefined;
  }
  if (args.exactPriorActive && config.highSideCompletionExactPriorBypass) {
    return undefined;
  }
  if (args.missingSidePrice < config.highSidePriceThreshold) {
    return undefined;
  }

  const imbalanceShares = Math.abs(state.upShares - state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(state.upShares + state.downShares, 1);

  if (args.candidateSize > config.highSideCompletionMaxQty + 1e-9) {
    return "high_side_completion_qty_cap";
  }
  if (args.costWithFees > config.highSideCompletionMaxCost + 1e-9) {
    return "high_side_completion_cost_cap";
  }
  if (config.highSideCompletionRequiresHardImbalance && imbalanceRatio < config.hardImbalanceRatio) {
    return "high_side_completion_hard_imbalance";
  }
  if (config.highSideCompletionRequiresFairValue && !args.fairValueAllowed) {
    return "high_side_completion_fair_value";
  }
  return undefined;
}

export function completionQualitySkipReason(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  args: {
    costWithFees: number;
    candidateSize: number;
    partialAgeSec: number;
    capMode: "strict" | "soft" | "hard" | "emergency";
    exactPriorActive: boolean;
    secsToClose: number;
  },
): string | undefined {
  if (config.botMode !== "XUAN" || args.exactPriorActive) {
    return undefined;
  }
  if (args.partialAgeSec < config.completionQualityEnforceAfterSec) {
    return undefined;
  }

  const negativeEdgeUsdc = estimateNegativeEdgeUsdc(args.costWithFees, args.candidateSize);
  if (negativeEdgeUsdc <= 1e-9) {
    return undefined;
  }

  const imbalanceShares = Math.abs(state.upShares - state.downShares);
  const imbalanceRatio = imbalanceShares / Math.max(state.upShares + state.downShares, 1);
  const finalEmergency =
    args.secsToClose <= config.finalWindowCompletionOnlySec &&
    imbalanceRatio >= config.hardImbalanceRatio &&
    args.candidateSize <= config.finalHardCompletionMaxQty + 1e-9 &&
    negativeEdgeUsdc <= config.finalHardCompletionMaxNegativeEdgeUsdc + 1e-9;
  if (finalEmergency) {
    return undefined;
  }

  if (args.costWithFees > config.completionQualityMaxEffectiveCost + 1e-9) {
    return "completion_quality_cost_cap";
  }
  if (negativeEdgeUsdc > config.completionQualityMaxNegativeEdgeUsdc + 1e-9) {
    return "completion_quality_edge_cap";
  }
  return undefined;
}
