import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { XuanMarketState } from "./marketState.js";
import type { StrategyExecutionMode } from "./executionModes.js";

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
  const waitUntilSec = Math.min(
    args.config.partialPatientWindowSec,
    baseWaitUntilSec * behaviorState.completionPatienceBias * effectivePatienceMultiplier,
  );
  const pricePremium = args.missingSidePrice - args.oppositeAveragePrice;
  const definitelyNotCheapLate =
    args.missingSidePrice > args.config.lowSideMaxForHighCompletion + 0.03 ||
    args.oppositeAveragePrice < args.config.highSidePriceThreshold - 0.08;
  const delayCandidate =
    args.config.botMode === "XUAN" &&
    !args.exactPriorActive &&
    !args.exceptionalMode &&
    severity.level !== "flat" &&
    severity.level !== "aggressive" &&
    args.secsToClose > args.config.finalWindowCompletionOnlySec;

  return {
    shouldDelay: delayCandidate && args.partialAgeSec < waitUntilSec && pricePremium > 0.015 && definitelyNotCheapLate,
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
