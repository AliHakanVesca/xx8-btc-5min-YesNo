import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { ExecutionQuote } from "./orderBookState.js";
import type { MarketOrderArgs, OutcomeSide } from "../../infra/clob/types.js";
import { pairCostWithBothTaker, completionCost, takerFeePerShare } from "./sumAvgEngine.js";
import {
  absoluteShareGap,
  averageCost,
  oldestResidualLotTimestamp,
  projectedShareGapAfterBuy,
} from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";
import {
  completionAllowance,
  pairEntryCap,
  pairSweepAllowance,
  resolvePartialCompletionPhase,
} from "./modePolicy.js";
import { OrderBookState } from "./orderBookState.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import { buildTakerBuyOrder } from "./marketOrderBuilder.js";
import { fairValueGate, type FairValueSnapshot } from "./fairValueEngine.js";

export type EntryBuyReason =
  | "balanced_pair_seed"
  | "balanced_pair_reentry"
  | "lagging_rebalance"
  | "temporal_single_leg_seed";

export interface EntryBuyDecision {
  side: OutcomeSide;
  size: number;
  reason: EntryBuyReason;
  mode: StrategyExecutionMode;
  expectedAveragePrice: number;
  effectivePricePerShare: number;
  negativeEdgeUsdc?: number | undefined;
  pairCostWithFees?: number | undefined;
  rawPairCost?: number | undefined;
  order: MarketOrderArgs;
}

export interface BalancedPairCandidateTrace {
  requestedSize: number;
  upFilledSize: number;
  downFilledSize: number;
  upAveragePrice: number;
  downAveragePrice: number;
  upLimitPrice: number;
  downLimitPrice: number;
  rawPairCost: number;
  pairCost: number;
  pairEdge: number;
  negativeEdgeUsdc: number;
  verdict: "ok" | "up_depth" | "down_depth" | "pair_cap" | "orphan_risk";
  selectedMode?: StrategyExecutionMode | undefined;
  gateReason?: string | undefined;
  upOrphanRisk?: OrphanRiskTrace | undefined;
  downOrphanRisk?: OrphanRiskTrace | undefined;
}

export interface OrphanRiskTrace {
  allowed: boolean;
  effectivePrice: number;
  notionalUsdc: number;
  marketOrphanNotionalUsdc: number;
  fairValue?: number | undefined;
  fairPremium?: number | undefined;
  reason?: string | undefined;
}

export interface SingleLegSeedCandidateTrace {
  side: OutcomeSide;
  requestedSize: number;
  filledSize: number;
  oppositeFilledSize?: number | undefined;
  oppositeCoverageRatio?: number | undefined;
  classifierScore?: number | undefined;
  averagePrice: number;
  limitPrice: number;
  effectivePricePerShare: number;
  referencePairCost: number;
  negativeEdgeUsdc: number;
  orphanRisk?: OrphanRiskTrace | undefined;
  allowed: boolean;
  selectedMode?: StrategyExecutionMode | undefined;
  skipReason?: string | undefined;
}

export interface EntryDecisionTrace {
  mode: "disabled" | "balanced_pair" | "lagging_rebalance" | "temporal_pair_cycle";
  requestedLot: number;
  totalShares: number;
  shareGap: number;
  pairCap: number;
  selectedMode?: StrategyExecutionMode;
  skipReason?: string;
  gatedByRisk?: boolean;
  bestRawPair?: number;
  bestEffectivePair?: number;
  candidates: BalancedPairCandidateTrace[];
  seedCandidates?: SingleLegSeedCandidateTrace[] | undefined;
  laggingSide?: OutcomeSide;
  repairSize?: number;
  repairFilledSize?: number;
  repairCost?: number;
  repairAllowed?: boolean;
  repairCapMode?: "strict" | "soft" | "hard" | "emergency";
  repairRequestedQty?: number;
  repairFinalQty?: number;
  repairOldGap?: number;
  repairNewGap?: number;
  repairWouldIncreaseImbalance?: boolean;
  repairMissingQty?: number;
  repairOppositeAveragePrice?: number;
  repairHighLowMismatch?: boolean;
}

export interface EntryEvaluation {
  decisions: EntryBuyDecision[];
  trace: EntryDecisionTrace;
}

export interface EntryLadderContext {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
  dailyNegativeEdgeSpentUsdc?: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  allowControlledOverlap?: boolean | undefined;
  protectedResidualShares?: number | undefined;
  protectedResidualSide?: OutcomeSide | undefined;
}

interface BalancedPairCandidate {
  requestedSize: number;
  rawPairCost: number;
  pairCost: number;
  mode: Extract<
    StrategyExecutionMode,
    "STRICT_PAIR_SWEEP" | "XUAN_SOFT_PAIR_SWEEP" | "XUAN_HARD_PAIR_SWEEP"
  >;
  negativeEdgeUsdc: number;
  upExecution: ExecutionQuote;
  downExecution: ExecutionQuote;
}

export function chooseEntryBuys(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
): EntryBuyDecision[] {
  return evaluateEntryBuys(config, state, books, ctx).decisions;
}

export function evaluateEntryBuys(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
): EntryEvaluation {
  const pairCap = pairEntryCap(config);
  const totalShares = state.upShares + state.downShares;
  const shareGap = Math.abs(state.upShares - state.downShares);
  const dailyNegativeEdgeSpentUsdc = ctx.dailyNegativeEdgeSpentUsdc ?? 0;

  if (!config.entryTakerBuyEnabled) {
    return {
      decisions: [],
      trace: {
        mode: "disabled",
        requestedLot: ctx.lot,
        totalShares,
        shareGap,
        pairCap,
        skipReason: "entry_taker_disabled",
        candidates: [],
      },
    };
  }

  if (shareGap === 0) {
    const inspected = inspectBalancedPairCandidates(
      config,
      state,
      books,
      ctx.lot,
      pairCap,
      ctx.secsToClose,
      dailyNegativeEdgeSpentUsdc,
      ctx.fairValueSnapshot,
    );
    const trace: EntryDecisionTrace = {
      mode: "balanced_pair",
      requestedLot: ctx.lot,
      totalShares,
      shareGap,
      pairCap,
      ...(inspected.bestRawPair !== undefined ? { bestRawPair: inspected.bestRawPair } : {}),
      ...(inspected.bestEffectivePair !== undefined ? { bestEffectivePair: inspected.bestEffectivePair } : {}),
      candidates: inspected.traces,
    };

    if (inspected.bestCandidate) {
      return {
        decisions: buildBalancedPairEntryBuys(
          state,
          inspected.bestCandidate,
          config.cryptoTakerFeeRate,
          totalShares === 0 ? "balanced_pair_seed" : "balanced_pair_reentry",
        ),
        trace: {
          ...trace,
          selectedMode: inspected.bestCandidate.mode,
        },
      };
    }

    const temporalSeedEvaluation = evaluateTemporalSingleLegSeed(
      config,
      state,
      books,
      ctx,
      dailyNegativeEdgeSpentUsdc,
    );

    if (temporalSeedEvaluation.decision) {
      return {
        decisions: [temporalSeedEvaluation.decision],
        trace: {
          ...trace,
          mode: "temporal_pair_cycle",
          selectedMode: temporalSeedEvaluation.decision.mode,
          seedCandidates: temporalSeedEvaluation.trace,
          skipReason: determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
        },
      };
    }

    const seedEvaluation = evaluateSingleLegSeed(
      config,
      state,
      books,
      ctx,
      dailyNegativeEdgeSpentUsdc,
    );

    if (seedEvaluation.decisions && seedEvaluation.decisions.length > 0) {
      return {
        decisions: seedEvaluation.decisions,
        trace: {
          ...trace,
          selectedMode: seedEvaluation.decisions[0]!.mode,
          seedCandidates: [...temporalSeedEvaluation.trace, ...seedEvaluation.trace],
          skipReason: determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
        },
      };
    }

    return {
      decisions: [],
      trace: {
        ...trace,
        seedCandidates: [...temporalSeedEvaluation.trace, ...seedEvaluation.trace],
        skipReason:
          temporalSeedEvaluation.trace.length > 0 || seedEvaluation.trace.length > 0
            ? `${determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces)}+single_leg_seed`
            : determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
      },
    };
  }

  const laggingSide: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
  const leadingSide: OutcomeSide = laggingSide === "UP" ? "DOWN" : "UP";
  const preferCloneResidualRepair =
    ctx.allowControlledOverlap &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    (ctx.protectedResidualShares ?? 0) > 0;
  const overlapInspection = ctx.allowControlledOverlap
    ? inspectBalancedPairCandidates(
        config,
        state,
        books,
        ctx.lot,
        pairCap,
        ctx.secsToClose,
        dailyNegativeEdgeSpentUsdc,
        ctx.fairValueSnapshot,
      )
    : undefined;
  const overlapTemporalSeed =
    ctx.allowControlledOverlap && (ctx.protectedResidualShares ?? 0) > 0
      ? evaluateTemporalSingleLegSeed(
          config,
          state,
          books,
          ctx,
          dailyNegativeEdgeSpentUsdc,
        )
      : undefined;
  const buildOverlapPairReentry = (): EntryEvaluation | undefined =>
    overlapInspection?.bestCandidate
      ? {
          decisions: buildBalancedPairEntryBuys(
            state,
            overlapInspection.bestCandidate,
            config.cryptoTakerFeeRate,
            "balanced_pair_reentry",
          ),
          trace: {
            mode: "balanced_pair",
            requestedLot: ctx.lot,
            totalShares,
            shareGap,
            pairCap,
            selectedMode: overlapInspection.bestCandidate.mode,
            laggingSide,
            ...(overlapInspection.bestRawPair !== undefined ? { bestRawPair: overlapInspection.bestRawPair } : {}),
            ...(overlapInspection.bestEffectivePair !== undefined
              ? { bestEffectivePair: overlapInspection.bestEffectivePair }
              : {}),
            candidates: overlapInspection.traces,
            skipReason: "controlled_overlap_pair",
          },
        }
      : undefined;
  const buildOverlapTemporalSeedEvaluation = (): EntryEvaluation | undefined =>
    overlapTemporalSeed?.decision
      ? {
          decisions: [overlapTemporalSeed.decision],
          trace: {
            mode: "temporal_pair_cycle",
            requestedLot: ctx.lot,
            totalShares,
            shareGap,
            pairCap,
            selectedMode: overlapTemporalSeed.decision.mode,
            laggingSide,
            candidates: overlapInspection?.traces ?? [],
            seedCandidates: overlapTemporalSeed.trace,
            skipReason: "protected_residual_overlap_seed",
          },
        }
      : undefined;
  const withCloneOverlapFallback = (fallback: EntryEvaluation): EntryEvaluation =>
    preferCloneResidualRepair
      ? buildOverlapTemporalSeedEvaluation() ?? buildOverlapPairReentry() ?? fallback
      : fallback;

  if (ctx.allowControlledOverlap && !preferCloneResidualRepair) {
    const pairReentry = buildOverlapPairReentry();
    if (pairReentry) {
      return pairReentry;
    }

    const overlapSeedEvaluation = buildOverlapTemporalSeedEvaluation();
    if (overlapSeedEvaluation) {
      return overlapSeedEvaluation;
    }
  }
  const repairRequestedQty = Math.min(
    Math.max(ctx.lot, shareGap),
    ctx.lot * config.rebalanceMaxLaggingMultiplier,
    Math.max(0, config.maxMarketSharesPerSide - (laggingSide === "UP" ? state.upShares : state.downShares)),
    Math.max(0, config.maxOneSidedExposureShares),
  );
  const repairQtyCap =
    config.completionQtyMode === "ALLOW_OVERSHOOT"
      ? shareGap + config.maxCompletionOvershootShares
      : shareGap;
  const repairSize = normalizeOrderSize(
    Math.min(repairRequestedQty, repairQtyCap),
    config.repairMinQty,
  );
  const trace: EntryDecisionTrace = {
    mode: "lagging_rebalance",
    requestedLot: ctx.lot,
    totalShares,
    shareGap,
    pairCap,
    candidates: [],
    laggingSide,
    repairSize,
    repairRequestedQty,
    repairMissingQty: shareGap,
  };

  if (repairSize <= 0) {
    return {
      decisions: [],
      trace: {
        ...trace,
        skipReason: shareGap < config.repairMinQty ? "repair_size_zero" : "repair_qty_cap",
      },
    };
  }

  const nowTs = state.market.endTs - ctx.secsToClose;
  const residualTimestamp = oldestResidualLotTimestamp(state, leadingSide);
  const partialAgeSec =
    residualTimestamp !== undefined ? Math.max(0, nowTs - residualTimestamp) : config.partialSoftWindowSec;
  const phase = resolvePartialCompletionPhase({
    config,
    partialAgeSec,
    secsToClose: ctx.secsToClose,
    capFamily: "temporal_repair",
    postMergeCompletionOnly:
      config.postMergeOnlyCompletion &&
      (state.reentryDisabled ||
        (state.postMergeCompletionOnlyUntil !== undefined && nowTs < state.postMergeCompletionOnlyUntil)),
  });
  const phaseCap =
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    partialAgeSec <= config.temporalRepairUltraFastWindowSec
      ? Math.max(phase.cap, config.temporalRepairUltraFastCap)
      : phase.cap;
  const phasedRepairSize = normalizeOrderSize(
    Math.min(repairSize, Number.isFinite(phase.maxQty) ? phase.maxQty : repairSize),
    config.repairMinQty,
  );
  if (phasedRepairSize <= 0) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        skipReason: "repair_phase_qty_cap",
      },
    });
  }
  const execution = books.quoteForSize(laggingSide, "ask", phasedRepairSize);
  const executableSize = normalizeOrderSize(execution.filledSize, config.repairMinQty);
  if (executableSize <= 0) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        repairFilledSize: executableSize,
        skipReason: "lagging_depth",
      },
    });
  }

  const oldGap = absoluteShareGap(state);
  const newGap = projectedShareGapAfterBuy(state, laggingSide, executableSize);
  const wouldIncreaseImbalance = newGap > oldGap + config.maxCompletionOvershootShares;
  if ((config.forbidBuyThatIncreasesImbalance || config.partialCompletionRequiresImbalanceReduction) && wouldIncreaseImbalance) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        repairFilledSize: executableSize,
        repairFinalQty: executableSize,
        repairOldGap: oldGap,
        repairNewGap: newGap,
        repairWouldIncreaseImbalance: wouldIncreaseImbalance,
        skipReason: "repair_increases_imbalance",
      },
    });
  }

  const oppositeAveragePrice = averageCost(state, leadingSide);
  const repairCost = completionCost(
    oppositeAveragePrice,
    execution.averagePrice,
    config.cryptoTakerFeeRate,
  );
  const allowance = completionAllowance(config, state, {
    costWithFees: repairCost,
    candidateSize: executableSize,
    oppositeAveragePrice,
    missingSidePrice: execution.averagePrice,
  });
  const highLowPhaseCapOverride = Boolean(allowance.highLowMismatch && allowance.allowed);
  if ((repairCost > phaseCap && !highLowPhaseCapOverride) || executableSize > phase.maxQty) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...trace,
        repairFilledSize: executableSize,
        repairFinalQty: executableSize,
        repairCost,
        repairAllowed: false,
        repairCapMode: allowance.capMode,
        repairOldGap: oldGap,
        repairNewGap: newGap,
        repairWouldIncreaseImbalance: wouldIncreaseImbalance,
        repairOppositeAveragePrice: oppositeAveragePrice,
        repairHighLowMismatch: allowance.highLowMismatch ?? false,
        skipReason: executableSize > phase.maxQty ? "repair_phase_qty_cap" : "repair_phase_cap",
      },
    });
  }
  const fairValueRequired =
    allowance.highLowMismatch && allowance.allowed && !allowance.requiresFairValue
      ? false
      : !(
          config.allowStrictResidualCompletionWithoutFairValue &&
          repairCost <= config.strictResidualCompletionCap
        ) || Boolean(allowance.requiresFairValue);
  const fairValueDecision = fairValueGate({
    config,
    snapshot: ctx.fairValueSnapshot,
    side: laggingSide,
    sidePrice: execution.averagePrice,
    mode: phase.mode === "PARTIAL_EMERGENCY_COMPLETION" ? "emergency" : "completion",
    secsToClose: ctx.secsToClose,
    effectiveCost: repairCost,
    required: fairValueRequired,
  });
  const repairMode: StrategyExecutionMode =
    allowance.highLowMismatch && allowance.allowed ? "HIGH_LOW_COMPLETION_CHASE" : phase.mode;
  const detailedTrace: EntryDecisionTrace = {
    ...trace,
    selectedMode: repairMode,
    repairFilledSize: executableSize,
    repairFinalQty: executableSize,
    repairCost,
    repairAllowed: allowance.allowed,
    repairCapMode: allowance.capMode,
    repairOldGap: oldGap,
    repairNewGap: newGap,
    repairWouldIncreaseImbalance: wouldIncreaseImbalance,
    repairOppositeAveragePrice: oppositeAveragePrice,
    repairHighLowMismatch: allowance.highLowMismatch ?? false,
  };
  if (
    ctx.secsToClose <= config.partialNoChaseLastSec &&
    !config.allowAnyNewBuyInLast10S &&
    allowance.capMode !== "strict"
  ) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...detailedTrace,
        skipReason: "repair_last10_strict_only",
      },
    });
  }
  if (!allowance.allowed || !fairValueDecision.allowed) {
    return withCloneOverlapFallback({
      decisions: [],
      trace: {
        ...detailedTrace,
        skipReason: !allowance.allowed ? "repair_cap" : fairValueDecision.reason ?? "repair_fair_value",
      },
    });
  }

  return {
    decisions: [
      buildEntryBuy(
        state,
        laggingSide,
        {
          ...execution,
          requestedSize: executableSize,
          filledSize: executableSize,
          fullyFilled: execution.filledSize + 1e-9 >= executableSize,
        },
        "lagging_rebalance",
        repairMode,
        config.cryptoTakerFeeRate,
        repairCost,
        allowance.negativeEdgeUsdc,
      ),
    ],
    trace: detailedTrace,
  };
}

function fairValueForOrphanSide(snapshot: FairValueSnapshot | undefined, side: OutcomeSide): number | undefined {
  if (!snapshot || snapshot.status !== "valid") {
    return undefined;
  }
  return side === "UP" ? snapshot.fairUp : snapshot.fairDown;
}

function currentOrphanNotionalUsdc(state: XuanMarketState): number {
  const gap = absoluteShareGap(state);
  if (gap <= 1e-6) {
    return 0;
  }
  const orphanSide: OutcomeSide = state.upShares > state.downShares ? "UP" : "DOWN";
  return Number((gap * averageCost(state, orphanSide)).toFixed(6));
}

function evaluateOrphanRisk(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  side: OutcomeSide;
  execution: ExecutionQuote;
  candidateSize: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
}): OrphanRiskTrace {
  const effectivePrice = args.execution.averagePrice + takerFeePerShare(
    args.execution.averagePrice,
    args.config.cryptoTakerFeeRate,
  );
  const notionalUsdc = Number((effectivePrice * args.candidateSize).toFixed(6));
  const marketOrphanNotionalUsdc = Number((currentOrphanNotionalUsdc(args.state) + notionalUsdc).toFixed(6));
  const fairValue = fairValueForOrphanSide(args.fairValueSnapshot, args.side);
  const fairPremium = fairValue !== undefined ? Number((effectivePrice - fairValue).toFixed(6)) : undefined;
  let reason: string | undefined;

  if (args.candidateSize > args.config.maxSingleOrphanQty + 1e-6) {
    reason = "orphan_qty";
  } else if (notionalUsdc > args.config.orphanLegMaxNotionalUsdc + 1e-6) {
    reason = "orphan_notional";
  } else if (marketOrphanNotionalUsdc > args.config.maxMarketOrphanUsdc + 1e-6) {
    reason = "market_orphan_budget";
  } else if (effectivePrice > args.config.singleLegOrphanCap + 1e-9) {
    reason = "single_leg_orphan_cap";
  } else if (
    args.config.singleLegFairValueVeto &&
    fairPremium !== undefined &&
    fairPremium > args.config.singleLegOrphanMaxFairPremium + 1e-9
  ) {
    reason = "orphan_fair_value";
  }

  return {
    allowed: reason === undefined,
    effectivePrice: Number(effectivePrice.toFixed(6)),
    notionalUsdc,
    marketOrphanNotionalUsdc,
    ...(fairValue !== undefined ? { fairValue } : {}),
    ...(fairPremium !== undefined ? { fairPremium } : {}),
    ...(reason ? { reason } : {}),
  };
}

function orphanGateReason(side: OutcomeSide, risk: OrphanRiskTrace): string | undefined {
  return risk.reason ? `${side.toLowerCase()}_${risk.reason}` : undefined;
}

function orphanRiskSortValue(risk: OrphanRiskTrace): number {
  const premiumPenalty = Math.max(0, risk.fairPremium ?? 0) * 10;
  const disallowedPenalty = risk.allowed ? 0 : 1_000;
  return disallowedPenalty + premiumPenalty + risk.effectivePrice + risk.notionalUsdc / 100;
}

function protectedResidualAllowance(
  ctx: Pick<EntryLadderContext, "protectedResidualShares" | "protectedResidualSide">,
  side: OutcomeSide,
): number {
  if (ctx.protectedResidualSide !== side) {
    return 0;
  }
  return Number(Math.max(0, ctx.protectedResidualShares ?? 0).toFixed(6));
}

function recentTemporalSequenceBias(state: XuanMarketState, side: OutcomeSide): number {
  const recentBuys = state.fillHistory.filter((fill) => fill.side === "BUY").slice(-4);
  if (recentBuys.length === 0) {
    return 0;
  }

  const lastBuy = recentBuys[recentBuys.length - 1]!;
  const sameCount = recentBuys.filter((fill) => fill.outcome === side).length;
  const oppositeCount = recentBuys.length - sameCount;
  let score = lastBuy.outcome !== side ? 1 : -0.4;
  score += (oppositeCount - sameCount) / Math.max(1, recentBuys.length);

  if (
    state.lastFilledSide === side &&
    state.lastExecutionMode !== undefined &&
    [
      "PARTIAL_FAST_COMPLETION",
      "PARTIAL_SOFT_COMPLETION",
      "PARTIAL_EMERGENCY_COMPLETION",
      "POST_MERGE_RESIDUAL_COMPLETION",
      "HIGH_LOW_COMPLETION_CHASE",
    ].includes(state.lastExecutionMode)
  ) {
    score += 0.75;
  }

  if (
    state.lastFilledSide === side &&
    (state.lastExecutionMode === "TEMPORAL_SINGLE_LEG_SEED" || state.lastExecutionMode === "PAIRGROUP_COVERED_SEED")
  ) {
    score -= 0.5;
  }

  return Number(score.toFixed(6));
}

function scoreTemporalSeedCycle(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  side: OutcomeSide;
  seedQuote: ExecutionQuote;
  oppositeQuote: ExecutionQuote;
  candidateSize: number;
  executableSize: number;
  oppositeCoverageRatio: number;
  referencePairCost: number;
  orphanRisk: OrphanRiskTrace;
  fairValueSnapshot?: FairValueSnapshot | undefined;
}): number {
  const oppositeSide: OutcomeSide = args.side === "UP" ? "DOWN" : "UP";
  const ownFairValue = fairValueForOrphanSide(args.fairValueSnapshot, args.side);
  const oppositeFairValue = fairValueForOrphanSide(args.fairValueSnapshot, oppositeSide);
  const ownDiscount = ownFairValue !== undefined ? ownFairValue - args.seedQuote.averagePrice : 0;
  const repairDiscount = oppositeFairValue !== undefined ? oppositeFairValue - args.oppositeQuote.averagePrice : 0;
  const behaviorRoom =
    Number.isFinite(args.referencePairCost) ? args.config.xuanBehaviorCap - args.referencePairCost : -1;
  const depthRatio = args.candidateSize > 0 ? args.executableSize / args.candidateSize : 0;
  const orphanPenalty = orphanRiskSortValue(args.orphanRisk);
  const sequenceBias = recentTemporalSequenceBias(args.state, args.side);

  return Number(
    (
      ownDiscount * args.config.temporalSeedOwnDiscountWeight +
      repairDiscount * args.config.temporalSeedRepairDiscountWeight +
      behaviorRoom * args.config.temporalSeedBehaviorRoomWeight +
      args.oppositeCoverageRatio * args.config.temporalSeedOppositeCoverageWeight +
      depthRatio * args.config.temporalSeedDepthWeight +
      sequenceBias * args.config.temporalSeedSequenceBiasWeight -
      orphanPenalty * args.config.temporalSeedOrphanPenaltyWeight
    ).toFixed(6),
  );
}

function evaluateTemporalSingleLegSeed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
  dailyNegativeEdgeSpentUsdc: number,
): {
  decision?: EntryBuyDecision;
  trace: SingleLegSeedCandidateTrace[];
} {
  if (
    config.botMode !== "XUAN" ||
    !config.allowTemporalSingleLegSeed ||
    ctx.secsToClose <= Math.max(config.finalWindowNoChaseSec, config.temporalSingleLegTtlSec) ||
    (ctx.secsToClose <= config.finalWindowSoftStartSec && !config.allowSingleLegSeedInLast60S)
  ) {
    return { trace: [] };
  }

  const candidateSize = normalizeOrderSize(
    Math.min(
      ctx.lot,
      config.singleLegSeedMaxQty,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
      Math.max(0, config.maxOneSidedExposureShares),
    ),
    state.market.minOrderSize,
  );
  if (candidateSize <= 0) {
    return { trace: [] };
  }

  const selectedMode: StrategyExecutionMode = "TEMPORAL_SINGLE_LEG_SEED";
  const candidates = (["UP", "DOWN"] as OutcomeSide[]).map((side) => {
    const oppositeSide: OutcomeSide = side === "UP" ? "DOWN" : "UP";
    const currentSideShares = side === "UP" ? state.upShares : state.downShares;
    const oppositeShares = oppositeSide === "UP" ? state.upShares : state.downShares;
    const initialSeedQuote = books.quoteForSize(side, "ask", candidateSize);
    const initialSeedFilledSize = normalizeOrderSize(initialSeedQuote.filledSize, state.market.minOrderSize);
    const initialOppositeQuote = books.quoteForSize(oppositeSide, "ask", candidateSize);
    const initialOppositeFilledSize = normalizeOrderSize(initialOppositeQuote.filledSize, state.market.minOrderSize);
    const maxSeedByOppositeDepth = initialOppositeFilledSize / Math.max(config.temporalSingleLegMinOppositeDepthRatio, 1e-6);
    const executableSize = normalizeOrderSize(
      Math.min(candidateSize, initialSeedFilledSize, maxSeedByOppositeDepth),
      state.market.minOrderSize,
    );
    const seedQuote =
      executableSize > 0 ? books.quoteForSize(side, "ask", executableSize) : initialSeedQuote;
    const oppositeQuote =
      executableSize > 0 ? books.quoteForSize(oppositeSide, "ask", executableSize) : initialOppositeQuote;
    const oppositeFilledSize = normalizeOrderSize(oppositeQuote.filledSize, state.market.minOrderSize);
    const oppositeCoverageRatio =
      executableSize > 0 ? Number((oppositeFilledSize / executableSize).toFixed(6)) : 0;
    const effectivePricePerShare =
      seedQuote.averagePrice + takerFeePerShare(seedQuote.averagePrice, config.cryptoTakerFeeRate);
    const referencePairCost =
      executableSize > 0
        ? pairCostWithBothTaker(
            side === "UP" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
            side === "DOWN" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
            config.cryptoTakerFeeRate,
          )
        : Number.POSITIVE_INFINITY;
    const negativeEdgeUsdc = executableSize > 0 ? Math.max(0, referencePairCost - 1) * executableSize : 0;
    const projectedGap = Math.abs(currentSideShares + executableSize - oppositeShares);
    const effectiveProjectedGap = Math.max(0, projectedGap - protectedResidualAllowance(ctx, side));
    let skipReason: string | undefined;

    if (state.consecutiveSeedSide === side && state.consecutiveSeedCount >= config.maxConsecutiveSingleLegSeedsPerSide) {
      skipReason = "temporal_seed_side_limit";
    } else if (initialSeedFilledSize <= 0 || executableSize <= 0) {
      skipReason = "temporal_seed_depth";
    } else if (oppositeCoverageRatio + 1e-6 < config.temporalSingleLegMinOppositeDepthRatio) {
      skipReason = "temporal_seed_opposite_depth";
    } else if (effectiveProjectedGap > config.maxOneSidedExposureShares + 1e-6) {
      skipReason = "temporal_seed_one_sided_exposure";
    } else if (referencePairCost > config.xuanBehaviorCap + 1e-9) {
      skipReason = "temporal_behavior_cap";
    } else if (negativeEdgeUsdc > config.maxNegativePairEdgePerCycleUsdc + 1e-9) {
      skipReason = "temporal_cycle_budget";
    } else if (state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc > config.maxNegativePairEdgePerMarketUsdc + 1e-9) {
      skipReason = "temporal_market_budget";
    } else if (dailyNegativeEdgeSpentUsdc + negativeEdgeUsdc > config.maxNegativeDailyBudgetUsdc + 1e-9) {
      skipReason = "temporal_daily_budget";
    }

    const fairValueDecision = fairValueGate({
      config,
      snapshot: ctx.fairValueSnapshot,
      side,
      sidePrice: seedQuote.averagePrice,
      mode: "seed",
      secsToClose: ctx.secsToClose,
      effectiveCost: referencePairCost,
      required: config.fairValueFailClosedForSeed,
    });
    const orphanRisk = evaluateOrphanRisk({
      config,
      state,
      side,
      execution: seedQuote,
      candidateSize: executableSize > 0 ? executableSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const classifierScore = scoreTemporalSeedCycle({
      config,
      state,
      side,
      seedQuote,
      oppositeQuote,
      candidateSize,
      executableSize,
      oppositeCoverageRatio,
      referencePairCost,
      orphanRisk,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });

    return {
      side,
      seedQuote,
      oppositeQuote,
      executableSize,
      oppositeFilledSize,
      oppositeCoverageRatio,
      effectivePricePerShare,
      referencePairCost,
      negativeEdgeUsdc,
      orphanRisk,
      fairValueDecision,
      classifierScore,
      skipReason,
    };
  }).sort((left, right) => {
    if (right.classifierScore !== left.classifierScore) {
      return right.classifierScore - left.classifierScore;
    }
    return orphanRiskSortValue(left.orphanRisk) - orphanRiskSortValue(right.orphanRisk);
  });

  const traces: SingleLegSeedCandidateTrace[] = [];
  let decision: EntryBuyDecision | undefined;

  for (const candidate of candidates) {
    const traceSkipReason = candidate.skipReason ?? candidate.fairValueDecision.reason ?? candidate.orphanRisk.reason;
    traces.push({
      side: candidate.side,
      requestedSize: candidateSize,
      filledSize: candidate.executableSize,
      oppositeFilledSize: candidate.oppositeFilledSize,
      oppositeCoverageRatio: candidate.oppositeCoverageRatio,
      classifierScore: candidate.classifierScore,
      averagePrice: candidate.seedQuote.averagePrice,
      limitPrice: candidate.seedQuote.limitPrice,
      effectivePricePerShare: candidate.effectivePricePerShare,
      referencePairCost: candidate.referencePairCost,
      negativeEdgeUsdc: candidate.negativeEdgeUsdc,
      orphanRisk: candidate.orphanRisk,
      allowed: candidate.skipReason === undefined && candidate.fairValueDecision.allowed && candidate.orphanRisk.allowed,
      ...(candidate.skipReason === undefined && candidate.fairValueDecision.allowed && candidate.orphanRisk.allowed
        ? { selectedMode }
        : {}),
      ...(traceSkipReason ? { skipReason: traceSkipReason } : {}),
    });

    if (!decision && candidate.skipReason === undefined && candidate.fairValueDecision.allowed && candidate.orphanRisk.allowed) {
      decision = buildEntryBuy(
        state,
        candidate.side,
        {
          ...candidate.seedQuote,
          requestedSize: candidate.executableSize,
          filledSize: candidate.executableSize,
          fullyFilled: candidate.seedQuote.filledSize + 1e-9 >= candidate.executableSize,
        },
        "temporal_single_leg_seed",
        selectedMode,
        config.cryptoTakerFeeRate,
        candidate.referencePairCost,
        candidate.negativeEdgeUsdc,
        candidate.seedQuote.averagePrice + candidate.oppositeQuote.averagePrice,
      );
    }
  }

  return {
    ...(decision ? { decision } : {}),
    trace: traces,
  };
}

function inspectBalancedPairCandidates(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  requestedMaxLot: number,
  cap: number,
  secsToClose: number,
  dailyNegativeEdgeSpentUsdc: number,
  fairValueSnapshot: FairValueSnapshot | undefined,
): {
  bestCandidate?: BalancedPairCandidate;
  traces: BalancedPairCandidateTrace[];
  maxCandidateSize: number;
  bestRawPair?: number;
  bestEffectivePair?: number;
} {
  const maxCandidateSize = normalizeOrderSize(
    Math.min(
      requestedMaxLot,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
      Math.max(0, config.maxMarketExposureShares - Math.max(state.upShares, state.downShares)),
    ),
    state.market.minOrderSize,
  );

  if (maxCandidateSize <= 0) {
    return {
      traces: [],
      maxCandidateSize,
    };
  }

  const requestedSizes = buildCandidateSizes(config.lotLadder, maxCandidateSize, state.market.minOrderSize);
  let bestCandidate: BalancedPairCandidate | undefined;
  const traces: BalancedPairCandidateTrace[] = [];
  let bestRawPair: number | undefined;
  let bestEffectivePair: number | undefined;

  for (const requestedSize of requestedSizes) {
    const upExecution = books.quoteForSize("UP", "ask", requestedSize);
    const downExecution = books.quoteForSize("DOWN", "ask", requestedSize);
    const rawPairCost = upExecution.averagePrice + downExecution.averagePrice;
    const pairCost = pairCostWithBothTaker(
      upExecution.averagePrice,
      downExecution.averagePrice,
      config.cryptoTakerFeeRate,
    );
    bestRawPair = bestRawPair === undefined ? rawPairCost : Math.min(bestRawPair, rawPairCost);
    bestEffectivePair = bestEffectivePair === undefined ? pairCost : Math.min(bestEffectivePair, pairCost);

    const allowance =
      upExecution.fullyFilled && downExecution.fullyFilled
        ? pairSweepAllowance({
            config,
            state,
            costWithFees: pairCost,
            candidateSize: requestedSize,
            secsToClose,
            dailyNegativeEdgeSpentUsdc,
          })
        : undefined;
    const upFairValue = fairValueGate({
      config,
      snapshot: fairValueSnapshot,
      side: "UP",
      sidePrice: upExecution.averagePrice,
      mode: allowance?.mode === "STRICT_PAIR_SWEEP" ? "pair" : "completion",
      secsToClose,
      effectiveCost: pairCost,
      required:
        allowance !== undefined &&
        allowance.mode !== "STRICT_PAIR_SWEEP" &&
        config.fairValueFailClosedForNegativePair,
    });
    const downFairValue = fairValueGate({
      config,
      snapshot: fairValueSnapshot,
      side: "DOWN",
      sidePrice: downExecution.averagePrice,
      mode: allowance?.mode === "STRICT_PAIR_SWEEP" ? "pair" : "completion",
      secsToClose,
      effectiveCost: pairCost,
      required:
        allowance !== undefined &&
        allowance.mode !== "STRICT_PAIR_SWEEP" &&
        config.fairValueFailClosedForNegativePair,
    });
    const fairValueAllowed =
      (upFairValue.allowed && downFairValue.allowed) ||
      shouldAllowPairedHighLowFairValueOverride(
        config,
        allowance,
        upExecution.averagePrice,
        downExecution.averagePrice,
        pairCost,
        [upFairValue.reason, downFairValue.reason].filter((reason): reason is string => Boolean(reason)),
      );
    const upOrphanRisk = evaluateOrphanRisk({
      config,
      state,
      side: "UP",
      execution: upExecution,
      candidateSize: requestedSize,
      fairValueSnapshot,
    });
    const downOrphanRisk = evaluateOrphanRisk({
      config,
      state,
      side: "DOWN",
      execution: downExecution,
      candidateSize: requestedSize,
      fairValueSnapshot,
    });
    const orphanRiskAllowed = upOrphanRisk.allowed && downOrphanRisk.allowed;
    const verdict =
      !upExecution.fullyFilled
        ? "up_depth"
        : !downExecution.fullyFilled
          ? "down_depth"
          : allowance?.allowed && fairValueAllowed && orphanRiskAllowed
            ? "ok"
            : allowance?.allowed && fairValueAllowed && !orphanRiskAllowed
              ? "orphan_risk"
              : "pair_cap";
    const gateReason =
      verdict === "pair_cap"
        ? fairValueAllowed
          ? describePairGate(config, pairCost, requestedSize, allowance, secsToClose, cap)
          : upFairValue.reason ?? downFairValue.reason ?? "pair_fair_value"
        : verdict === "orphan_risk"
          ? orphanGateReason("UP", upOrphanRisk) ?? orphanGateReason("DOWN", downOrphanRisk)
        : undefined;

    traces.push({
      requestedSize,
      upFilledSize: upExecution.filledSize,
      downFilledSize: downExecution.filledSize,
      upAveragePrice: upExecution.averagePrice,
      downAveragePrice: downExecution.averagePrice,
      upLimitPrice: upExecution.limitPrice,
      downLimitPrice: downExecution.limitPrice,
      rawPairCost,
      pairCost,
      pairEdge: 1 - pairCost,
      negativeEdgeUsdc: allowance?.negativeEdgeUsdc ?? 0,
      verdict,
      ...(allowance?.mode ? { selectedMode: allowance.mode } : {}),
      ...(gateReason ? { gateReason } : {}),
      upOrphanRisk,
      downOrphanRisk,
    });

    if (verdict === "ok") {
      bestCandidate = {
        requestedSize,
        rawPairCost,
        pairCost,
        mode: allowance!.mode!,
        negativeEdgeUsdc: allowance!.negativeEdgeUsdc,
        upExecution,
        downExecution,
      };
    }
  }

  return {
    ...(bestCandidate ? { bestCandidate } : {}),
    traces,
    maxCandidateSize,
    ...(bestRawPair !== undefined ? { bestRawPair } : {}),
    ...(bestEffectivePair !== undefined ? { bestEffectivePair } : {}),
  };
}

function evaluateSingleLegSeed(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  books: OrderBookState,
  ctx: EntryLadderContext,
  dailyNegativeEdgeSpentUsdc: number,
): {
  decisions?: EntryBuyDecision[];
  trace: SingleLegSeedCandidateTrace[];
} {
  if (
    config.botMode !== "XUAN" ||
    !config.allowXuanCoveredSeed ||
    ctx.secsToClose <= config.finalWindowNoChaseSec ||
    (ctx.secsToClose <= config.finalWindowSoftStartSec && !config.allowSingleLegSeedInLast60S)
  ) {
    return { trace: [] };
  }

  const candidateSize = normalizeOrderSize(
    Math.min(
      ctx.lot,
      config.coveredSeedMaxQty,
      config.singleLegSeedMaxQty,
      Math.max(0, config.maxMarketSharesPerSide - state.upShares),
      Math.max(0, config.maxMarketSharesPerSide - state.downShares),
    ),
    state.market.minOrderSize,
  );
  if (candidateSize <= 0) {
    return { trace: [] };
  }

  const sideOrder = (["UP", "DOWN"] as OutcomeSide[]).sort((left, right) => {
    const leftQuote = books.quoteForSize(left, "ask", candidateSize);
    const rightQuote = books.quoteForSize(right, "ask", candidateSize);
    const leftSize = normalizeOrderSize(leftQuote.filledSize || candidateSize, state.market.minOrderSize);
    const rightSize = normalizeOrderSize(rightQuote.filledSize || candidateSize, state.market.minOrderSize);
    const leftRisk = evaluateOrphanRisk({
      config,
      state,
      side: left,
      execution: leftQuote,
      candidateSize: leftSize > 0 ? leftSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const rightRisk = evaluateOrphanRisk({
      config,
      state,
      side: right,
      execution: rightQuote,
      candidateSize: rightSize > 0 ? rightSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    return orphanRiskSortValue(leftRisk) - orphanRiskSortValue(rightRisk);
  });
  const traces: SingleLegSeedCandidateTrace[] = [];
  let decisions: EntryBuyDecision[] | undefined;

  for (const side of sideOrder) {
    const oppositeSide: OutcomeSide = side === "UP" ? "DOWN" : "UP";
    const currentSideShares = side === "UP" ? state.upShares : state.downShares;
    const oppositeShares = oppositeSide === "UP" ? state.upShares : state.downShares;
    const oldGap = absoluteShareGap(state);
    const seedQuote = books.quoteForSize(side, "ask", candidateSize);
    const seedExecutableSize = normalizeOrderSize(seedQuote.filledSize, state.market.minOrderSize);
    const oppositeQuote = books.quoteForSize(oppositeSide, "ask", seedExecutableSize > 0 ? seedExecutableSize : candidateSize);
    const oppositeExecutableSize = normalizeOrderSize(oppositeQuote.filledSize, state.market.minOrderSize);
    const pairExecutableSize = normalizeOrderSize(
      Math.min(seedExecutableSize, oppositeExecutableSize),
      state.market.minOrderSize,
    );
    const projectedGap = Math.abs(currentSideShares + (pairExecutableSize > 0 ? pairExecutableSize : candidateSize) - oppositeShares);
    const effectivePricePerShare =
      seedQuote.averagePrice + takerFeePerShare(seedQuote.averagePrice, config.cryptoTakerFeeRate);
    const referencePairCost = pairExecutableSize > 0
      ? pairCostWithBothTaker(
          side === "UP" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
          side === "DOWN" ? seedQuote.averagePrice : oppositeQuote.averagePrice,
          config.cryptoTakerFeeRate,
        )
      : Number.POSITIVE_INFINITY;
    const negativeEdgeUsdc =
      pairExecutableSize > 0
        ? Math.max(0, referencePairCost - 1) * Math.max(pairExecutableSize, candidateSize)
        : 0;
    let skipReason: string | undefined;

    const hasOppositeInventoryCover =
      pairExecutableSize > 0 &&
      oppositeShares + 1e-6 >= pairExecutableSize * config.coveredSeedMinOppositeCoverageRatio;
    const canUseInventoryCover =
      config.coveredSeedAllowOppositeInventoryCover && hasOppositeInventoryCover;
    const requiresSamePairgroupOppositeOrder =
      config.coveredSeedRequireSamePairgroupOppositeOrder &&
      !canUseInventoryCover &&
      config.coveredSeedAllowSamePairgroupOppositeOrder;
    const effectiveProjectedGap = requiresSamePairgroupOppositeOrder ? oldGap : projectedGap;
    const protectedProjectedGap = Math.max(
      0,
      effectiveProjectedGap - protectedResidualAllowance(ctx, side),
    );

    if (!config.coveredSeedAllowSamePairgroupOppositeOrder && !canUseInventoryCover && !config.allowNakedSingleLegSeed) {
      skipReason = "seed_requires_same_pairgroup_opposite_order";
    } else if (!config.allowNakedSingleLegSeed && !canUseInventoryCover && !requiresSamePairgroupOppositeOrder) {
      skipReason = "seed_missing_opposite_inventory";
    } else if (state.consecutiveSeedSide === side && state.consecutiveSeedCount >= config.maxConsecutiveSingleLegSeedsPerSide) {
      skipReason = "seed_side_limit";
    } else if (
      config.forbidBuyThatIncreasesImbalance &&
      effectiveProjectedGap > oldGap + config.maxCompletionOvershootShares
    ) {
      skipReason = "seed_increases_imbalance";
    } else if (protectedProjectedGap > config.maxOneSidedExposureShares) {
      skipReason = "seed_one_sided_exposure";
    } else if (pairExecutableSize <= 0) {
      skipReason = "seed_depth";
    } else if (referencePairCost > config.xuanPairSweepHardCap) {
      skipReason = "seed_reference_pair_cap";
    } else if (negativeEdgeUsdc > config.maxNegativePairEdgePerCycleUsdc) {
      skipReason = "seed_cycle_budget";
    } else if (state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc > config.maxNegativePairEdgePerMarketUsdc) {
      skipReason = "seed_market_budget";
    } else if (dailyNegativeEdgeSpentUsdc + negativeEdgeUsdc > config.maxNegativeDailyBudgetUsdc) {
      skipReason = "seed_daily_budget";
    }

    const selectedMode: StrategyExecutionMode = "PAIRGROUP_COVERED_SEED";
    const fairValueDecision = fairValueGate({
      config,
      snapshot: ctx.fairValueSnapshot,
      side,
      sidePrice: seedQuote.averagePrice,
      mode: "seed",
      secsToClose: ctx.secsToClose,
      effectiveCost: referencePairCost,
      required: config.coveredSeedRequiresFairValue || config.fairValueFailClosedForSeed,
    });
    const orphanRisk = evaluateOrphanRisk({
      config,
      state,
      side,
      execution: seedQuote,
      candidateSize: pairExecutableSize > 0 ? pairExecutableSize : candidateSize,
      fairValueSnapshot: ctx.fairValueSnapshot,
    });
    const traceSkipReason = skipReason ?? fairValueDecision.reason ?? orphanRisk.reason;
    traces.push({
      side,
      requestedSize: candidateSize,
      filledSize: pairExecutableSize,
      averagePrice: seedQuote.averagePrice,
      limitPrice: seedQuote.limitPrice,
      effectivePricePerShare,
      referencePairCost,
      negativeEdgeUsdc,
      orphanRisk,
      allowed: skipReason === undefined && fairValueDecision.allowed && orphanRisk.allowed,
      ...(skipReason === undefined && fairValueDecision.allowed && orphanRisk.allowed ? { selectedMode } : {}),
      ...(traceSkipReason ? { skipReason: traceSkipReason } : {}),
    });

    if (!decisions && skipReason === undefined && fairValueDecision.allowed && orphanRisk.allowed) {
      const seedExecution: ExecutionQuote = {
        ...seedQuote,
        requestedSize: pairExecutableSize,
        filledSize: pairExecutableSize,
        fullyFilled: seedQuote.filledSize + 1e-9 >= pairExecutableSize,
      };
      const coveredExecution: ExecutionQuote = {
        ...oppositeQuote,
        requestedSize: pairExecutableSize,
        filledSize: pairExecutableSize,
        fullyFilled: oppositeQuote.filledSize + 1e-9 >= pairExecutableSize,
      };
      decisions = [
        buildEntryBuy(
          state,
          side,
          seedExecution,
          "balanced_pair_seed",
          selectedMode,
          config.cryptoTakerFeeRate,
          referencePairCost,
          negativeEdgeUsdc,
          seedQuote.averagePrice + oppositeQuote.averagePrice,
        ),
        buildEntryBuy(
          state,
          oppositeSide,
          coveredExecution,
          "balanced_pair_seed",
          selectedMode,
          config.cryptoTakerFeeRate,
          referencePairCost,
          negativeEdgeUsdc,
          seedQuote.averagePrice + oppositeQuote.averagePrice,
        ),
      ];
    }
  }

  return {
    ...(decisions ? { decisions } : {}),
    trace: traces,
  };
}

function buildCandidateSizes(ladder: number[], maxCandidateSize: number, minOrderSize: number): number[] {
  const normalized = Array.from(
    new Set(
      ladder
        .map((size) => normalizeOrderSize(size, minOrderSize))
        .filter((size) => size > 0 && size <= maxCandidateSize),
    ),
  ).sort((left, right) => left - right);

  if (normalized.length > 0) {
    return normalized;
  }

  return [maxCandidateSize];
}

function determineBalancedPairSkipReason(
  maxCandidateSize: number,
  traces: BalancedPairCandidateTrace[],
): string {
  if (maxCandidateSize <= 0) {
    return "max_market_exposure";
  }

  if (traces.length === 0) {
    return "no_candidate_sizes";
  }

  const gateReasons = new Set(
    traces
      .map((trace) => trace.gateReason)
      .filter((reason): reason is string => Boolean(reason)),
  );
  if (gateReasons.has("pair_market_budget")) return "pair_market_budget";
  if (gateReasons.has("pair_cycle_budget")) return "pair_cycle_budget";
  if (gateReasons.has("pair_daily_budget")) return "pair_daily_budget";
  if (gateReasons.has("pair_qty_limit")) return "pair_qty_limit";
  if (gateReasons.has("pair_time_gate")) return "pair_time_gate";
  if ([...gateReasons].some((reason) => reason.includes("orphan"))) return "orphan_risk";

  const hasPairCap = traces.some((trace) => trace.verdict === "pair_cap");
  const hasOrphanRisk = traces.some((trace) => trace.verdict === "orphan_risk");
  const hasDepthIssue = traces.some((trace) => trace.verdict === "up_depth" || trace.verdict === "down_depth");

  if (hasPairCap && hasDepthIssue) {
    return "pair_cap_and_depth";
  }
  if (hasOrphanRisk) {
    return "orphan_risk";
  }
  if (hasPairCap) {
    return "pair_cap";
  }
  if (hasDepthIssue) {
    return "insufficient_depth";
  }

  return "no_viable_pair";
}

function buildBalancedPairEntryBuys(
  state: XuanMarketState,
  candidate: BalancedPairCandidate,
  feeRate: number,
  reason: EntryBuyReason,
): EntryBuyDecision[] {
  return [
    buildEntryBuy(
      state,
      "UP",
      candidate.upExecution,
      reason,
      candidate.mode,
      feeRate,
      candidate.pairCost,
      candidate.negativeEdgeUsdc,
      candidate.rawPairCost,
    ),
    buildEntryBuy(
      state,
      "DOWN",
      candidate.downExecution,
      reason,
      candidate.mode,
      feeRate,
      candidate.pairCost,
      candidate.negativeEdgeUsdc,
      candidate.rawPairCost,
    ),
  ];
}

function buildEntryBuy(
  state: XuanMarketState,
  side: OutcomeSide,
  execution: ExecutionQuote,
  reason: EntryBuyReason,
  mode: StrategyExecutionMode,
  feeRate: number,
  pairCost?: number,
  negativeEdgeUsdc?: number,
  rawPairCost?: number,
): EntryBuyDecision {
  return {
    side,
    size: execution.filledSize,
    reason,
    mode,
    expectedAveragePrice: execution.averagePrice,
    effectivePricePerShare: execution.averagePrice + takerFeePerShare(execution.averagePrice, feeRate),
    ...(negativeEdgeUsdc !== undefined ? { negativeEdgeUsdc } : {}),
    ...(pairCost !== undefined ? { pairCostWithFees: pairCost } : {}),
    ...(rawPairCost !== undefined ? { rawPairCost } : {}),
    order: buildTakerBuyOrder({
      state,
      side,
      shareTarget: execution.filledSize,
      limitPrice: execution.limitPrice,
      orderType: "FAK",
    }),
  };
}

function describePairGate(
  config: XuanStrategyConfig,
  pairCost: number,
  requestedSize: number,
  allowance: ReturnType<typeof pairSweepAllowance> | undefined,
  secsToClose: number,
  cap: number,
): string {
  if (!allowance) {
    return "pair_cap";
  }
  if (pairCost <= cap) {
    return "pair_cap";
  }
  if (!config.allowInitialNegativePairSweep || config.botMode !== "XUAN") {
    return "pair_cap";
  }
  if (pairCost > config.xuanPairSweepHardCap) {
    return "pair_cap";
  }
  if (allowance.projectedDailyBudget > config.maxNegativeDailyBudgetUsdc) {
    return "pair_daily_budget";
  }
  if (allowance.projectedMarketBudget > config.maxNegativePairEdgePerMarketUsdc) {
    return "pair_market_budget";
  }
  if (allowance.negativeEdgeUsdc > config.maxNegativePairEdgePerCycleUsdc) {
    return "pair_cycle_budget";
  }
  if (requestedSize > config.xuanSoftSweepMaxQty && requestedSize > config.xuanHardSweepMaxQty) {
    return "pair_qty_limit";
  }
  if (secsToClose <= config.xuanMinTimeLeftForHardSweep) {
    return "pair_time_gate";
  }
  if (secsToClose <= config.finalWindowNoChaseSec && !config.allowAnyNewBuyInLast10S) {
    return "pair_time_gate";
  }
  if (secsToClose <= config.finalWindowCompletionOnlySec && !config.allowNewPairInLast30S) {
    return "pair_time_gate";
  }
  if (secsToClose <= config.finalWindowSoftStartSec && !config.allowNewPairInLast60S) {
    return "pair_time_gate";
  }
  return "pair_cap";
}

function shouldAllowPairedHighLowFairValueOverride(
  config: XuanStrategyConfig,
  allowance: ReturnType<typeof pairSweepAllowance> | undefined,
  upPrice: number,
  downPrice: number,
  pairCost: number,
  reasons: string[],
): boolean {
  if (!allowance?.allowed || allowance.mode === "STRICT_PAIR_SWEEP" || reasons.length === 0) {
    return false;
  }
  if (reasons.some((reason) => reason !== "fair_value_high_side_price")) {
    return false;
  }

  const highSide = Math.max(upPrice, downPrice);
  const lowSide = Math.min(upPrice, downPrice);
  if (highSide < config.highSidePriceThreshold || lowSide > config.lowSideMaxForHighCompletion) {
    return false;
  }

  const cap = allowance.mode === "XUAN_HARD_PAIR_SWEEP" ? config.xuanPairSweepHardCap : config.xuanPairSweepSoftCap;
  return pairCost <= cap;
}

function normalizeOrderSize(size: number, minOrderSize: number): number {
  const normalized = Number(size.toFixed(6));
  if (normalized < minOrderSize) {
    return 0;
  }
  return normalized;
}
