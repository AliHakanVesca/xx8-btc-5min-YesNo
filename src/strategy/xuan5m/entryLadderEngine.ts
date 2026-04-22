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

export type EntryBuyReason = "balanced_pair_seed" | "balanced_pair_reentry" | "lagging_rebalance";

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
  verdict: "ok" | "up_depth" | "down_depth" | "pair_cap";
  selectedMode?: StrategyExecutionMode | undefined;
  gateReason?: string | undefined;
}

export interface SingleLegSeedCandidateTrace {
  side: OutcomeSide;
  requestedSize: number;
  filledSize: number;
  averagePrice: number;
  limitPrice: number;
  effectivePricePerShare: number;
  referencePairCost: number;
  negativeEdgeUsdc: number;
  allowed: boolean;
  selectedMode?: StrategyExecutionMode | undefined;
  skipReason?: string | undefined;
}

export interface EntryDecisionTrace {
  mode: "disabled" | "balanced_pair" | "lagging_rebalance";
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

    const seedEvaluation = evaluateSingleLegSeed(
      config,
      state,
      books,
      ctx,
      dailyNegativeEdgeSpentUsdc,
    );

    if (seedEvaluation.decision) {
      return {
        decisions: [seedEvaluation.decision],
        trace: {
          ...trace,
          selectedMode: seedEvaluation.decision.mode,
          seedCandidates: seedEvaluation.trace,
          skipReason: determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
        },
      };
    }

    return {
      decisions: [],
      trace: {
        ...trace,
        seedCandidates: seedEvaluation.trace,
        skipReason:
          seedEvaluation.trace.length > 0
            ? `${determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces)}+single_leg_seed`
            : determineBalancedPairSkipReason(inspected.maxCandidateSize, inspected.traces),
      },
    };
  }

  const laggingSide: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
  const leadingSide: OutcomeSide = laggingSide === "UP" ? "DOWN" : "UP";
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
    postMergeCompletionOnly:
      config.postMergeOnlyCompletion &&
      (state.reentryDisabled ||
        (state.postMergeCompletionOnlyUntil !== undefined && nowTs < state.postMergeCompletionOnlyUntil)),
  });
  const phasedRepairSize = normalizeOrderSize(
    Math.min(repairSize, Number.isFinite(phase.maxQty) ? phase.maxQty : repairSize),
    config.repairMinQty,
  );
  if (phasedRepairSize <= 0) {
    return {
      decisions: [],
      trace: {
        ...trace,
        skipReason: "repair_phase_qty_cap",
      },
    };
  }
  const execution = books.quoteForSize(laggingSide, "ask", phasedRepairSize);
  const executableSize = normalizeOrderSize(execution.filledSize, config.repairMinQty);
  if (executableSize <= 0) {
    return {
      decisions: [],
      trace: {
        ...trace,
        repairFilledSize: executableSize,
        skipReason: "lagging_depth",
      },
    };
  }

  const oldGap = absoluteShareGap(state);
  const newGap = projectedShareGapAfterBuy(state, laggingSide, executableSize);
  const wouldIncreaseImbalance = newGap > oldGap + config.maxCompletionOvershootShares;
  if ((config.forbidBuyThatIncreasesImbalance || config.partialCompletionRequiresImbalanceReduction) && wouldIncreaseImbalance) {
    return {
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
    };
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
  if (repairCost > phase.cap || executableSize > phase.maxQty) {
    return {
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
    };
  }
  const fairValueDecision = fairValueGate({
    config,
    snapshot: ctx.fairValueSnapshot,
    side: laggingSide,
    sidePrice: execution.averagePrice,
    mode: phase.mode === "PARTIAL_EMERGENCY_COMPLETION" ? "emergency" : "completion",
    secsToClose: ctx.secsToClose,
    effectiveCost: repairCost,
    required: !(
      config.allowStrictResidualCompletionWithoutFairValue &&
      repairCost <= config.strictResidualCompletionCap
    ) || Boolean(allowance.requiresFairValue),
  });
  const detailedTrace: EntryDecisionTrace = {
    ...trace,
    selectedMode: phase.mode,
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
    return {
      decisions: [],
      trace: {
        ...detailedTrace,
        skipReason: "repair_last10_strict_only",
      },
    };
  }
  if (!allowance.allowed || !fairValueDecision.allowed) {
    return {
      decisions: [],
      trace: {
        ...detailedTrace,
        skipReason: !allowance.allowed ? "repair_cap" : fairValueDecision.reason ?? "repair_fair_value",
      },
    };
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
        phase.mode,
        config.cryptoTakerFeeRate,
        repairCost,
        allowance.negativeEdgeUsdc,
      ),
    ],
    trace: detailedTrace,
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
    const fairValueAllowed = upFairValue.allowed && downFairValue.allowed;
    const verdict =
      !upExecution.fullyFilled
        ? "up_depth"
        : !downExecution.fullyFilled
          ? "down_depth"
          : allowance?.allowed && fairValueAllowed
            ? "ok"
            : "pair_cap";
    const gateReason =
      verdict === "pair_cap"
        ? fairValueAllowed
          ? describePairGate(config, pairCost, requestedSize, allowance, secsToClose, cap)
          : upFairValue.reason ?? downFairValue.reason ?? "pair_fair_value"
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
  decision?: EntryBuyDecision;
  trace: SingleLegSeedCandidateTrace[];
} {
  if (
    config.botMode !== "XUAN" ||
    !config.allowSingleLegSeed ||
    !config.allowXuanCoveredSeed ||
    !config.allowCheapUnderdogSeed ||
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

  const sideOrder: OutcomeSide[] = books.bestAsk("UP") <= books.bestAsk("DOWN") ? ["UP", "DOWN"] : ["DOWN", "UP"];
  const traces: SingleLegSeedCandidateTrace[] = [];
  let decision: EntryBuyDecision | undefined;

  for (const side of sideOrder) {
    const oppositeSide: OutcomeSide = side === "UP" ? "DOWN" : "UP";
    const currentSideShares = side === "UP" ? state.upShares : state.downShares;
    const oppositeShares = oppositeSide === "UP" ? state.upShares : state.downShares;
    const oldGap = absoluteShareGap(state);
    const projectedGap = Math.abs(currentSideShares + candidateSize - oppositeShares);
    const execution = books.quoteForSize(side, "ask", candidateSize);
    const executableSize = normalizeOrderSize(execution.filledSize, state.market.minOrderSize);
    const effectivePricePerShare = execution.averagePrice + takerFeePerShare(execution.averagePrice, config.cryptoTakerFeeRate);
    const oppositeQuote = books.quoteForSize(oppositeSide, "ask", executableSize > 0 ? executableSize : candidateSize);
    const referencePairCost = pairCostWithBothTaker(
      side === "UP" ? execution.averagePrice : oppositeQuote.averagePrice,
      side === "DOWN" ? execution.averagePrice : oppositeQuote.averagePrice,
      config.cryptoTakerFeeRate,
    );
    const negativeEdgeUsdc = Math.max(0, referencePairCost - 1) * Math.max(executableSize, candidateSize);
    let skipReason: string | undefined;

    const hasOppositeInventoryCover =
      executableSize > 0 &&
      oppositeShares + 1e-6 >= executableSize * config.coveredSeedMinOppositeCoverageRatio;
    const canUseInventoryCover =
      config.coveredSeedAllowOppositeInventoryCover && hasOppositeInventoryCover;
    const requiresSamePairgroupOppositeOrder =
      config.coveredSeedRequireSamePairgroupOppositeOrder &&
      !canUseInventoryCover &&
      config.coveredSeedAllowSamePairgroupOppositeOrder;

    if (!config.allowNakedSingleLegSeed && !canUseInventoryCover && requiresSamePairgroupOppositeOrder) {
      skipReason = "seed_requires_same_pairgroup_opposite_order";
    } else if (!config.allowNakedSingleLegSeed && !canUseInventoryCover) {
      skipReason = "seed_missing_opposite_inventory";
    } else if (state.consecutiveSeedSide === side && state.consecutiveSeedCount >= config.maxConsecutiveSingleLegSeedsPerSide) {
      skipReason = "seed_side_limit";
    } else if (
      config.forbidBuyThatIncreasesImbalance &&
      projectedGap > oldGap + config.maxCompletionOvershootShares
    ) {
      skipReason = "seed_increases_imbalance";
    } else if (projectedGap > config.maxOneSidedExposureShares) {
      skipReason = "seed_one_sided_exposure";
    } else if (executableSize <= 0) {
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
      sidePrice: execution.averagePrice,
      mode: "seed",
      secsToClose: ctx.secsToClose,
      effectiveCost: referencePairCost,
      required: config.coveredSeedRequiresFairValue || config.fairValueFailClosedForSeed,
    });
    traces.push({
      side,
      requestedSize: candidateSize,
      filledSize: executableSize,
      averagePrice: execution.averagePrice,
      limitPrice: execution.limitPrice,
      effectivePricePerShare,
      referencePairCost,
      negativeEdgeUsdc,
      allowed: skipReason === undefined && fairValueDecision.allowed,
      ...(skipReason === undefined ? { selectedMode } : {}),
      ...(skipReason ?? fairValueDecision.reason ? { skipReason: skipReason ?? fairValueDecision.reason } : {}),
    });

    if (!decision && skipReason === undefined && fairValueDecision.allowed) {
      decision = buildEntryBuy(
        state,
        side,
        {
          ...execution,
          requestedSize: executableSize,
          filledSize: executableSize,
          fullyFilled: execution.filledSize + 1e-9 >= executableSize,
        },
        "balanced_pair_seed",
        selectedMode,
        config.cryptoTakerFeeRate,
        referencePairCost,
        negativeEdgeUsdc,
        execution.averagePrice + oppositeQuote.averagePrice,
      );
    }
  }

  return {
    ...(decision ? { decision } : {}),
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

  const hasPairCap = traces.some((trace) => trace.verdict === "pair_cap");
  const hasDepthIssue = traces.some((trace) => trace.verdict === "up_depth" || trace.verdict === "down_depth");

  if (hasPairCap && hasDepthIssue) {
    return "pair_cap_and_depth";
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

function normalizeOrderSize(size: number, minOrderSize: number): number {
  const normalized = Number(size.toFixed(6));
  if (normalized < minOrderSize) {
    return 0;
  }
  return normalized;
}
