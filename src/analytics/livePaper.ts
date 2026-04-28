import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig, type XuanStrategyConfig } from "../config/strategyPresets.js";
import { createClobAdapter } from "../infra/clob/index.js";
import type { MarketInfo, MarketOrderArgs, OrderBook, OrderLevel, OutcomeSide, TradeSide } from "../infra/clob/types.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import {
  countActiveIndependentFlowCount,
  createMarketState,
  type FillRecord,
  type XuanMarketState,
} from "../strategy/xuan5m/marketState.js";
import { applyFill, applyMerge, averageCost, mergeableShares } from "../strategy/xuan5m/inventoryState.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import {
  createMergeBatchTracker,
  evaluateDelayedMergeGate,
  planMerge,
  syncMergeBatchTracker,
  type MergeBatchTracker,
  type MergeGateDecision,
} from "../strategy/xuan5m/mergeCoordinator.js";
import { pairCostWithBothTaker, pairEdge, takerFeeUsd } from "../strategy/xuan5m/sumAvgEngine.js";
import { SystemClock } from "../infra/time/clock.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { appendJsonl } from "../utils/fs.js";
import type { StrategyExecutionMode } from "../strategy/xuan5m/executionModes.js";

export interface LivePaperOptions {
  durationSec?: number;
  sampleMs?: number;
  initialBookWaitMs?: number;
  auditFile?: string;
  bookDepthLevels?: number;
}

export interface ResolvedLivePaperOptions {
  durationSec: number;
  sampleMs: number;
  initialBookWaitMs: number;
  auditFile: string;
  bookDepthLevels: number;
}

export interface LivePaperSample {
  timestamp: number;
  phase: string;
  secsToClose: number;
  hasBooks: boolean;
  entryBuyCount: number;
  balancedPairEntryCount: number;
  laggingRebalanceCount: number;
  buyShares: number;
  buyNotional: number;
  hasCompletion: boolean;
  hasUnwind: boolean;
  mergeShares: number;
  allowNewEntries: boolean;
  completionOnly: boolean;
  hardCancel: boolean;
  riskReasons: string[];
  pairAskSum?: number;
  pairTakerCost?: number;
  pairEdge?: number;
  simulatedOrderCount?: number;
  simulatedFillCount?: number;
  simulatedPartialFillCount?: number;
  simulatedRejectedOrderCount?: number;
  simulatedBuyShares?: number;
  simulatedSellShares?: number;
  simulatedRawNotional?: number;
  simulatedFeeUsd?: number;
  simulatedMergeShares?: number;
  paperUpShares?: number;
  paperDownShares?: number;
  paperUpAverage?: number;
  paperDownAverage?: number;
}

export interface LivePaperSummary {
  marketSlug: string;
  sampleCount: number;
  samplesWithBooks: number;
  entryBuyReadyCount: number;
  balancedPairReadyCount: number;
  laggingRebalanceReadyCount: number;
  completionReadyCount: number;
  unwindReadyCount: number;
  mergeReadyCount: number;
  allowNewEntriesCount: number;
  completionOnlyCount: number;
  hardCancelCount: number;
  averageBuyShares: number;
  averageBuyNotional: number;
  averagePairAskSum?: number;
  averagePairTakerCost?: number;
  bestPairEdge?: number;
  worstPairEdge?: number;
  startedAt: number;
  endedAt: number;
  configuredDurationSec: number;
  auditFile?: string;
  simulatedOrderCount?: number;
  simulatedFillCount?: number;
  simulatedPartialFillCount?: number;
  simulatedRejectedOrderCount?: number;
  simulatedBuyShares?: number;
  simulatedSellShares?: number;
  simulatedRawNotional?: number;
  simulatedFeeUsd?: number;
  simulatedMergeCount?: number;
  simulatedMergeShares?: number;
  finalUpShares?: number;
  finalDownShares?: number;
  finalUpAverage?: number;
  finalDownAverage?: number;
  finalFillCount?: number;
  finalMergeCount?: number;
  xuanFirstFillSec?: number;
  xuanCompletionSec?: number;
  xuanLastFillSec?: number;
  xuanFillCount?: number;
  xuanImbalanceShares?: number;
  xuanResidualShares?: number;
  xuanMergeQty?: number;
  xuanMergeRealizedPnl?: number;
  xuanLastMergeRealizedPnl?: number;
  xuanPairUnderOneFillCount?: number;
  xuanPairedContinuationCount?: number;
  xuanIndependentFlowCount?: number;
  xuanCompletionOnlyFillCount?: number;
  xuanBuyRowsPerMarket?: number;
  xuanSameSecondDualBuyCount?: number;
  xuanSameSecondDualBuyRate?: number;
  xuanOppositeLegGapMedianSec?: number;
  xuanMedianTradeSize?: number;
  xuanStagedOppositeSeedCount?: number;
  xuanStagedOppositeReleaseCount?: number;
  xuanStagedOppositeReleaseRate?: number;
  xuanDebtReducingContinuationCount?: number;
  xuanDebtHoldMaxSec?: number;
  xuanRhythmWaitSec?: number;
  xuanCompletionDelayedCount?: number;
  xuanEarlyCompletionReason?: string;
  xuanMergeBlockedReasonTop?: string;
  xuanMergeReadyButSkippedCount?: number;
  xuanPairCapBlockedCount?: number;
  xuanLateFreshSeedCutoffCount?: number;
  xuanPreopenBlockedCount?: number;
  xuanRiskGatedBlockedCount?: number;
  xuanFinalMergeForced?: boolean;
  xuanHighCostSeedCount?: number;
  xuanHighCostSeedMaxPairCost?: number;
  xuanLateSeedUnclosedCount?: number;
  xuanNegativeMergePnlCount?: number;
  xuanResidualDutyBlockedTop?: string;
  xuanNoTradeReason?: string;
  xuanEarlyNoTradeReason?: string;
  xuanPassBlockers?: string[];
  xuanEconomicsWarnings?: string[];
  xuanConformanceScore?: number;
  xuanConformanceStatus?: "PASS" | "WARN" | "FAIL";
  xuanAggressiveClone?: {
    enabled: boolean;
    lastFootprintScore?: number;
    topBlockers: string[];
  };
}

export interface LivePaperReport {
  market: {
    selection: "current" | "next";
    slug: string;
    conditionId: string;
    startTs: number;
    endTs: number;
    upTokenId: string;
    downTokenId: string;
    tickSize: number;
    minOrderSize: number;
  };
  options: ResolvedLivePaperOptions;
  summary: LivePaperSummary;
  samples: LivePaperSample[];
}

export interface LivePaperInventorySnapshot {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upAverage: number;
  downAverage: number;
  fillCount: number;
  mergeCount: number;
  negativeEdgeConsumedUsdc: number;
  negativePairEdgeConsumedUsdc: number;
  negativeCompletionEdgeConsumedUsdc: number;
}

export interface LivePaperBookSideSnapshot {
  tokenId: string;
  timestamp?: number;
  hash?: string;
  bestBid: number;
  bestAsk: number;
  bids: OrderLevel[];
  asks: OrderLevel[];
}

export interface LivePaperBookSnapshot {
  up: LivePaperBookSideSnapshot | null;
  down: LivePaperBookSideSnapshot | null;
}

export interface LivePaperOrderExecution {
  timestamp: number;
  kind: "entry" | "completion" | "unwind";
  status: "filled" | "partial" | "rejected";
  outcome: OutcomeSide;
  tradeSide: TradeSide;
  requestedShares: number;
  filledShares: number;
  averagePrice: number;
  limitPrice: number;
  rawNotional: number;
  feeUsd: number;
  effectiveNotional: number;
  fullyFilled: boolean;
  reason: string;
  orderType: MarketOrderArgs["orderType"];
  order: MarketOrderArgs;
  consumedLevels: OrderLevel[];
  mode?: StrategyExecutionMode;
  pairCostWithFees?: number;
  projectedBasketEffectivePair?: number;
  negativeEdgeUsdc?: number;
  flowLineage?: string;
}

export interface LivePaperMergeExecution {
  timestamp: number;
  status: "merged" | "skipped";
  requestedShares: number;
  mergedShares: number;
  reason: MergeGateDecision["reason"] | "below_min" | "debounce";
  forced: boolean;
  realizedPnl: number;
  mergeReturn: number;
  gate: MergeGateDecision;
}

export interface LivePaperTickResult {
  tickIndex: number;
  sample: LivePaperSample;
  decision: ReturnType<Xuan5mBot["evaluateTick"]>;
  bookSnapshot: LivePaperBookSnapshot;
  stateBefore: LivePaperInventorySnapshot;
  stateAfter: LivePaperInventorySnapshot;
  executions: LivePaperOrderExecution[];
  mergeGate: MergeGateDecision;
  mergeTracker: MergeBatchTracker;
  state: XuanMarketState;
  lastMergeAtMs: number;
  merge?: LivePaperMergeExecution;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function medianNumber(values: number[]): number | undefined {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return undefined;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const XUAN_STAGED_OPPOSITE_MIN_GAP_SEC = 8;
const XUAN_STAGED_OPPOSITE_MAX_GAP_SEC = 180;

export interface XuanLivePaperBehaviorMetrics {
  stagedOppositeSeedCount: number;
  stagedOppositeReleaseCount: number;
  stagedOppositeReleaseRate: number;
  pairedContinuationCount: number;
  independentFlowCount: number;
  debtReducingContinuationCount: number;
}

function isXuanStagedSeed(execution: LivePaperOrderExecution): boolean {
  return execution.mode === "PAIRGROUP_COVERED_SEED" || execution.mode === "TEMPORAL_SINGLE_LEG_SEED";
}

function isXuanStagedRelease(execution: LivePaperOrderExecution): boolean {
  return (
    execution.kind === "completion" ||
    execution.reason === "lagging_rebalance" ||
    execution.mode === "PARTIAL_SOFT_COMPLETION" ||
    execution.mode === "PARTIAL_FAST_COMPLETION" ||
    execution.mode === "CHEAP_LATE_COMPLETION_CHASE" ||
    execution.mode === "HIGH_LOW_COMPLETION_CHASE"
  );
}

export function computeXuanLivePaperBehaviorMetrics(
  executions: LivePaperOrderExecution[],
): XuanLivePaperBehaviorMetrics {
  const buyFills = executions
    .filter((execution) => execution.tradeSide === "BUY" && execution.filledShares > 1e-9)
    .sort((left, right) => left.timestamp - right.timestamp);
  const sameTickContinuationGroups = new Map<number, Set<OutcomeSide>>();
  let debtReducingContinuationCount = 0;
  for (const execution of buyFills) {
    const isSameTickPairContinuation =
      execution.kind === "entry" &&
      execution.reason !== "lagging_rebalance" &&
      (execution.reason === "balanced_pair_reentry" ||
        execution.mode === "STRICT_PAIR_SWEEP" ||
        execution.mode === "XUAN_SOFT_PAIR_SWEEP" ||
        execution.mode === "XUAN_HARD_PAIR_SWEEP" ||
        execution.projectedBasketEffectivePair !== undefined);
    if (!isSameTickPairContinuation) {
      continue;
    }
    const sides = sameTickContinuationGroups.get(execution.timestamp) ?? new Set<OutcomeSide>();
    sides.add(execution.outcome);
    sameTickContinuationGroups.set(execution.timestamp, sides);
  }
  const sameTickPairedContinuationCount = [...sameTickContinuationGroups.values()].filter(
    (sides) => sides.has("UP") && sides.has("DOWN"),
  ).length;
  let stagedOppositeReleaseCount = 0;
  for (let index = 1; index < buyFills.length; index += 1) {
    const execution = buyFills[index]!;
    if (!isXuanStagedRelease(execution)) {
      continue;
    }
    const previousOpposite = [...buyFills]
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.outcome !== execution.outcome);
    if (!previousOpposite) {
      continue;
    }
    const gapSec = execution.timestamp - previousOpposite.timestamp;
    if (gapSec < XUAN_STAGED_OPPOSITE_MIN_GAP_SEC || gapSec > XUAN_STAGED_OPPOSITE_MAX_GAP_SEC) {
      continue;
    }
    stagedOppositeReleaseCount += 1;
    const effectivePair = execution.projectedBasketEffectivePair ?? execution.pairCostWithFees;
    if (effectivePair !== undefined && effectivePair <= 1 + 1e-9) {
      debtReducingContinuationCount += 1;
    }
  }
  const stagedOppositeSeedCount = buyFills.filter(isXuanStagedSeed).length;
  const stagedOppositeReleaseRate = Math.min(
    1,
    stagedOppositeReleaseCount / Math.max(stagedOppositeSeedCount, 1),
  );
  return {
    stagedOppositeSeedCount,
    stagedOppositeReleaseCount,
    stagedOppositeReleaseRate: normalize(stagedOppositeReleaseRate),
    pairedContinuationCount: sameTickPairedContinuationCount + stagedOppositeReleaseCount,
    independentFlowCount: stagedOppositeReleaseCount,
    debtReducingContinuationCount,
  };
}

export function scoreXuanConformance(args: {
  rawScore: number;
  fillCount: number;
  minFillCountForPass: number;
  mergedQty: number;
  mergeRealizedPnl?: number | undefined;
  requireProfit?: boolean | undefined;
  pairedContinuationCount?: number | undefined;
  independentFlowCount?: number | undefined;
  requirePairedContinuation?: boolean | undefined;
  debtHoldMaxSec?: number | undefined;
  firstFillSec?: number | undefined;
  completionSec?: number | undefined;
  imbalanceShares: number;
  residualShares: number;
  sameSecondDualBuyRate?: number | undefined;
  oppositeLegGapMedianSec?: number | undefined;
  buyRowsPerMarket?: number | undefined;
  highCostSeedCount?: number | undefined;
  lateSeedUnclosedCount?: number | undefined;
  negativeMergePnlCount?: number | undefined;
}): { score: number; status: "PASS" | "WARN" | "FAIL"; blockers: string[]; economicsWarnings: string[] } {
  const negativeMergePnlActive =
    args.requireProfit === true &&
    ((args.negativeMergePnlCount ?? 0) > 0 || (args.mergeRealizedPnl ?? 0) < 0);
  const economicsWarnings = [
    ...(negativeMergePnlActive ? ["negative_merge_pnl"] : []),
  ];
  const blockers = [
    ...(args.mergedQty > 0 ? [] : ["missing_merge"]),
    ...(args.fillCount >= args.minFillCountForPass ? [] : ["insufficient_fill_count"]),
    ...(negativeMergePnlActive ? ["negative_merge_pnl"] : []),
    ...((args.highCostSeedCount ?? 0) > 0 ? ["high_cost_seed"] : []),
    ...((args.lateSeedUnclosedCount ?? 0) > 0 ? ["late_seed_unclosed"] : []),
    ...(args.requirePairedContinuation !== true || (args.pairedContinuationCount ?? 0) > 0
      ? []
      : ["missing_paired_continuation"]),
    ...(args.requirePairedContinuation !== true || (args.independentFlowCount ?? 0) > 0
      ? []
      : ["insufficient_independent_flow"]),
    ...((args.debtHoldMaxSec ?? 0) >= 270 ? ["debt_carried_too_long"] : []),
    ...(args.firstFillSec !== undefined && args.firstFillSec <= 15 ? [] : ["late_or_missing_first_fill"]),
    ...(args.completionSec !== undefined && args.completionSec <= 120 ? [] : ["late_or_missing_completion"]),
    ...(args.imbalanceShares <= 0.02 && args.residualShares <= 0.02 ? [] : ["residual_not_flat"]),
    ...((args.sameSecondDualBuyRate ?? 0) <= 0.12 ? [] : ["same_second_dual_buy_rate_high"]),
    ...(args.oppositeLegGapMedianSec === undefined || args.oppositeLegGapMedianSec >= 8
      ? []
      : ["opposite_leg_gap_too_short"]),
    ...((args.buyRowsPerMarket ?? 0) <= 35 ? [] : ["buy_density_too_high"]),
  ];
  const score = blockers.length === 0 ? args.rawScore : Math.min(args.rawScore, 74);
  return {
    score,
    status: blockers.length === 0 && score >= 75 ? "PASS" : score >= 45 ? "WARN" : "FAIL",
    blockers,
    economicsWarnings,
  };
}

function normalizeBookTimestampSec(book: OrderBook): number {
  return book.timestamp > 10_000_000_000 ? Math.floor(book.timestamp / 1000) : book.timestamp;
}

function computeBookStaleMs(book: OrderBook | undefined, nowTs: number): number {
  if (!book) {
    return 60_000;
  }
  return Math.max(0, (nowTs - normalizeBookTimestampSec(book)) * 1000);
}

function defaultAuditFile(marketSlug: string, startedAt: number): string {
  const iso = new Date(startedAt * 1000).toISOString().replace(/[:.]/g, "-");
  return `logs/paper-live/${iso}-${marketSlug}.jsonl`;
}

async function writeAuditEvent(auditFile: string, payload: Record<string, unknown>): Promise<void> {
  await appendJsonl(auditFile, payload);
}

function buildStateSnapshot(state: XuanMarketState): LivePaperInventorySnapshot {
  return {
    upShares: normalize(state.upShares),
    downShares: normalize(state.downShares),
    upCost: normalize(state.upCost),
    downCost: normalize(state.downCost),
    upAverage: normalize(averageCost(state, "UP")),
    downAverage: normalize(averageCost(state, "DOWN")),
    fillCount: state.fillHistory.length,
    mergeCount: state.mergeHistory.length,
    negativeEdgeConsumedUsdc: normalize(state.negativeEdgeConsumedUsdc),
    negativePairEdgeConsumedUsdc: normalize(state.negativePairEdgeConsumedUsdc),
    negativeCompletionEdgeConsumedUsdc: normalize(state.negativeCompletionEdgeConsumedUsdc),
  };
}

function trimLevels(levels: OrderLevel[], depth: number, direction: "bid" | "ask"): OrderLevel[] {
  return [...levels]
    .sort((left, right) => (direction === "bid" ? right.price - left.price : left.price - right.price))
    .slice(0, depth)
    .map((level) => ({
      price: normalize(level.price, 4),
      size: normalize(level.size),
    }));
}

function buildBookSideSnapshot(tokenId: string, book: OrderBook | undefined, depth: number): LivePaperBookSideSnapshot | null {
  if (!book) {
    return null;
  }
  const snapshot: LivePaperBookSideSnapshot = {
    tokenId,
    timestamp: normalizeBookTimestampSec(book),
    bestBid: normalize(book.bids[0]?.price ?? 0, 4),
    bestAsk: normalize(book.asks[0]?.price ?? 1, 4),
    bids: trimLevels(book.bids, depth, "bid"),
    asks: trimLevels(book.asks, depth, "ask"),
  };
  if (book.hash !== undefined) {
    snapshot.hash = book.hash;
  }
  return snapshot;
}

function buildBookSnapshot(args: {
  market: MarketInfo;
  upBook: OrderBook | undefined;
  downBook: OrderBook | undefined;
  depth: number;
}): LivePaperBookSnapshot {
  return {
    up: buildBookSideSnapshot(args.market.tokens.UP.tokenId, args.upBook, args.depth),
    down: buildBookSideSnapshot(args.market.tokens.DOWN.tokenId, args.downBook, args.depth),
  };
}

function evaluateDecision(args: {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  market: MarketInfo;
  books: OrderBookState;
  upBook: OrderBook | undefined;
  downBook: OrderBook | undefined;
  nowTs: number;
}): ReturnType<Xuan5mBot["evaluateTick"]> {
  const bot = new Xuan5mBot();
  const oldestBookStaleMs = Math.max(
    computeBookStaleMs(args.upBook, args.nowTs),
    computeBookStaleMs(args.downBook, args.nowTs),
  );

  return bot.evaluateTick({
    config: args.config,
    state: args.state,
    books: args.books,
    nowTs: args.nowTs,
    riskContext: {
      secsToClose: args.market.endTs - args.nowTs,
      staleBookMs: oldestBookStaleMs,
      balanceStaleMs: 0,
      bookIsCrossed:
        args.books.bestBid("UP") > args.books.bestAsk("UP") ||
        args.books.bestBid("DOWN") > args.books.bestAsk("DOWN"),
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    },
    dryRunOrSmallLive: true,
  });
}

function buildSampleFromDecision(args: {
  config: XuanStrategyConfig;
  market: MarketInfo;
  nowTs: number;
  books: OrderBookState;
  upBook: OrderBook | undefined;
  downBook: OrderBook | undefined;
  decision: ReturnType<Xuan5mBot["evaluateTick"]>;
}): LivePaperSample {
  const buyShares = args.decision.entryBuys.reduce((acc, order) => acc + order.size, 0);
  const buyNotional = args.decision.entryBuys.reduce(
    (acc, order) => acc + order.size * order.expectedAveragePrice,
    0,
  );
  const balancedPairEntryCount = args.decision.entryBuys.filter((order) => order.reason !== "lagging_rebalance").length;
  const laggingRebalanceCount = args.decision.entryBuys.filter((order) => order.reason === "lagging_rebalance").length;
  const hasBooks = Boolean(args.upBook && args.downBook);
  const pairAskSum = hasBooks ? args.books.bestAsk("UP") + args.books.bestAsk("DOWN") : undefined;
  const pairTakerCost = hasBooks
    ? pairCostWithBothTaker(args.books.bestAsk("UP"), args.books.bestAsk("DOWN"), args.config.cryptoTakerFeeRate)
    : undefined;
  const sample: LivePaperSample = {
    timestamp: args.nowTs,
    phase: args.decision.phase,
    secsToClose: args.market.endTs - args.nowTs,
    hasBooks,
    entryBuyCount: args.decision.entryBuys.length,
    balancedPairEntryCount,
    laggingRebalanceCount,
    buyShares: normalize(buyShares),
    buyNotional: normalize(buyNotional),
    hasCompletion: Boolean(args.decision.completion),
    hasUnwind: Boolean(args.decision.unwind),
    mergeShares: normalize(args.decision.mergeShares),
    allowNewEntries: args.decision.risk.allowNewEntries,
    completionOnly: args.decision.risk.completionOnly,
    hardCancel: args.decision.risk.hardCancel,
    riskReasons: args.decision.risk.reasons,
  };
  if (pairAskSum !== undefined) {
    sample.pairAskSum = normalize(pairAskSum, 4);
  }
  if (pairTakerCost !== undefined) {
    sample.pairTakerCost = normalize(pairTakerCost);
    sample.pairEdge = normalize(pairEdge(pairTakerCost));
  }
  return sample;
}

export function buildLivePaperSample(args: {
  env: AppEnv;
  market: MarketInfo;
  nowTs: number;
  upBook: OrderBook | undefined;
  downBook: OrderBook | undefined;
}): LivePaperSample {
  const config = buildStrategyConfig(args.env);
  const state = createMarketState(args.market);
  const books = new OrderBookState(args.upBook, args.downBook);
  const decision = evaluateDecision({
    config,
    state,
    books,
    market: args.market,
    nowTs: args.nowTs,
    upBook: args.upBook,
    downBook: args.downBook,
  });
  return buildSampleFromDecision({
    config,
    market: args.market,
    nowTs: args.nowTs,
    books,
    upBook: args.upBook,
    downBook: args.downBook,
    decision,
  });
}

function levelsForExecution(book: OrderBook | undefined, tradeSide: TradeSide): OrderLevel[] {
  const levels = tradeSide === "BUY" ? book?.asks ?? [] : book?.bids ?? [];
  return [...levels].sort((left, right) => (tradeSide === "BUY" ? left.price - right.price : right.price - left.price));
}

function cloneBook(book: OrderBook | undefined): OrderBook | undefined {
  if (!book) {
    return undefined;
  }
  return {
    ...book,
    bids: book.bids.map((level) => ({ ...level })),
    asks: book.asks.map((level) => ({ ...level })),
  };
}

function pricePassesLimit(price: number, tradeSide: TradeSide, limitPrice: number): boolean {
  return tradeSide === "BUY" ? price <= limitPrice + 1e-9 : price >= limitPrice - 1e-9;
}

function simulateOrderExecution(args: {
  config: XuanStrategyConfig;
  books: OrderBookState;
  nowTs: number;
  kind: LivePaperOrderExecution["kind"];
  outcome: OutcomeSide;
  tradeSide: TradeSide;
  requestedShares: number;
  reason: string;
  order: MarketOrderArgs;
  mode?: StrategyExecutionMode;
  pairCostWithFees?: number;
  projectedBasketEffectivePair?: number;
  negativeEdgeUsdc?: number;
  flowLineage?: string;
}): LivePaperOrderExecution {
  const book = args.outcome === "UP" ? args.books.up : args.books.down;
  const requestedShares = normalize(Math.max(0, args.requestedShares));
  const fallbackLimit = args.tradeSide === "BUY" ? args.books.bestAsk(args.outcome) : args.books.bestBid(args.outcome);
  const limitPrice = normalize(args.order.price ?? fallbackLimit, 4);
  const consumedLevels: OrderLevel[] = [];
  let remaining = requestedShares;
  let filledShares = 0;
  let rawNotional = 0;

  for (const level of levelsForExecution(book, args.tradeSide)) {
    if (remaining <= 1e-9 || !pricePassesLimit(level.price, args.tradeSide, limitPrice)) {
      break;
    }
    const takeSize = Math.min(remaining, level.size);
    if (takeSize <= 0) {
      continue;
    }
    remaining = normalize(remaining - takeSize);
    filledShares = normalize(filledShares + takeSize);
    rawNotional = normalize(rawNotional + takeSize * level.price);
    consumedLevels.push({
      price: normalize(level.price, 4),
      size: normalize(takeSize),
    });
  }

  const fullyFilled = requestedShares > 0 && remaining <= 1e-9;
  const fokRejected = args.order.orderType === "FOK" && !fullyFilled;
  if (fokRejected) {
    filledShares = 0;
    rawNotional = 0;
    consumedLevels.length = 0;
  }
  const averagePrice = filledShares > 0 ? rawNotional / filledShares : 0;
  const feeUsd = filledShares > 0 ? takerFeeUsd(filledShares, averagePrice, args.config.cryptoTakerFeeRate) : 0;
  const status: LivePaperOrderExecution["status"] =
    filledShares <= 1e-9 ? "rejected" : fullyFilled ? "filled" : "partial";
  const scaledNegativeEdge =
    args.negativeEdgeUsdc !== undefined && args.negativeEdgeUsdc > 0 && requestedShares > 0
      ? normalize(args.negativeEdgeUsdc * Math.min(1, filledShares / requestedShares))
      : undefined;
  const execution: LivePaperOrderExecution = {
    timestamp: args.nowTs,
    kind: args.kind,
    status,
    outcome: args.outcome,
    tradeSide: args.tradeSide,
    requestedShares,
    filledShares: normalize(filledShares),
    averagePrice: normalize(averagePrice, 6),
    limitPrice,
    rawNotional: normalize(rawNotional),
    feeUsd: normalize(feeUsd),
    effectiveNotional: normalize(args.tradeSide === "BUY" ? rawNotional + feeUsd : Math.max(0, rawNotional - feeUsd)),
    fullyFilled,
    reason: args.reason,
    orderType: args.order.orderType,
    order: args.order,
    consumedLevels,
  };
  if (args.mode !== undefined) {
    execution.mode = args.mode;
  }
  if (args.pairCostWithFees !== undefined) {
    execution.pairCostWithFees = normalize(args.pairCostWithFees);
  }
  if (args.projectedBasketEffectivePair !== undefined) {
    execution.projectedBasketEffectivePair = normalize(args.projectedBasketEffectivePair);
  }
  if (scaledNegativeEdge !== undefined) {
    execution.negativeEdgeUsdc = scaledNegativeEdge;
  }
  if (args.flowLineage !== undefined) {
    execution.flowLineage = args.flowLineage;
  }
  return execution;
}

function depletePaperBook(book: OrderBook | undefined, execution: LivePaperOrderExecution): void {
  if (!book || execution.consumedLevels.length === 0) {
    return;
  }
  const levels = execution.tradeSide === "BUY" ? book.asks : book.bids;
  for (const consumed of execution.consumedLevels) {
    let remaining = consumed.size;
    for (let index = 0; index < levels.length && remaining > 1e-9; index += 1) {
      const level = levels[index];
      if (!level || Math.abs(level.price - consumed.price) > 1e-9) {
        continue;
      }
      const takeSize = Math.min(level.size, remaining);
      level.size = normalize(level.size - takeSize);
      remaining = normalize(remaining - takeSize);
      if (level.size <= 1e-9) {
        levels.splice(index, 1);
        index -= 1;
      }
    }
  }
}

function depletePaperBooks(books: OrderBookState, execution: LivePaperOrderExecution): void {
  depletePaperBook(execution.outcome === "UP" ? books.up : books.down, execution);
}

function applyExecutionToState(state: XuanMarketState, execution: LivePaperOrderExecution, nowTs: number): XuanMarketState {
  if (execution.filledShares <= 1e-9) {
    return state;
  }
  const fill: FillRecord = {
    outcome: execution.outcome,
    side: execution.tradeSide,
    price: execution.averagePrice,
    size: execution.filledShares,
    timestamp: nowTs,
    makerTaker: "taker",
  };
  if (execution.mode !== undefined) {
    fill.executionMode = execution.mode;
  }
  if (execution.flowLineage !== undefined) {
    fill.flowLineage = execution.flowLineage;
  }
  const next = applyFill(state, fill);
  if (execution.negativeEdgeUsdc === undefined || execution.negativeEdgeUsdc <= 0) {
    return next;
  }
  const bucket = execution.kind === "completion" ? "completion" : "pair";
  return {
    ...next,
    negativeEdgeConsumedUsdc: normalize(next.negativeEdgeConsumedUsdc + execution.negativeEdgeUsdc),
    negativePairEdgeConsumedUsdc:
      bucket === "pair"
        ? normalize(next.negativePairEdgeConsumedUsdc + execution.negativeEdgeUsdc)
        : next.negativePairEdgeConsumedUsdc,
    negativeCompletionEdgeConsumedUsdc:
      bucket === "completion"
        ? normalize(next.negativeCompletionEdgeConsumedUsdc + execution.negativeEdgeUsdc)
        : next.negativeCompletionEdgeConsumedUsdc,
  };
}

function normalizeMergeAmount(mergeable: number, dustLeaveShares: number): number {
  return normalize(Math.max(0, mergeable - Math.max(0, dustLeaveShares)));
}

export function buildLivePaperTick(args: {
  config: XuanStrategyConfig;
  market: MarketInfo;
  state: XuanMarketState;
  mergeTracker: MergeBatchTracker;
  nowTs: number;
  tickIndex?: number;
  upBook: OrderBook | undefined;
  downBook: OrderBook | undefined;
  bookDepthLevels?: number;
  lastMergeAtMs?: number;
}): LivePaperTickResult {
  const tickIndex = args.tickIndex ?? 0;
  const books = new OrderBookState(args.upBook, args.downBook);
  const decision = evaluateDecision({
    config: args.config,
    state: args.state,
    books,
    market: args.market,
    nowTs: args.nowTs,
    upBook: args.upBook,
    downBook: args.downBook,
  });
  const sample = buildSampleFromDecision({
    config: args.config,
    market: args.market,
    nowTs: args.nowTs,
    books,
    upBook: args.upBook,
    downBook: args.downBook,
    decision,
  });
  const stateBefore = buildStateSnapshot(args.state);
  let state = args.state;
  const executions: LivePaperOrderExecution[] = [];
  const executionBooks = new OrderBookState(cloneBook(args.upBook), cloneBook(args.downBook));
  const flowBase = `paper-live:${args.market.slug}:${args.nowTs}:${tickIndex}`;

  decision.entryBuys.forEach((entry, index) => {
    const execution = simulateOrderExecution({
      config: args.config,
      books: executionBooks,
      nowTs: args.nowTs,
      kind: "entry",
      outcome: entry.side,
      tradeSide: "BUY",
      requestedShares: entry.size,
      reason: entry.reason,
      order: entry.order,
      mode: entry.mode,
      flowLineage: `${flowBase}:entry:${entry.reason}:${index}`,
      ...(entry.pairCostWithFees !== undefined ? { pairCostWithFees: entry.pairCostWithFees } : {}),
      ...(decision.trace.entry?.marketBasketProjectedEffectivePair !== undefined
        ? { projectedBasketEffectivePair: decision.trace.entry.marketBasketProjectedEffectivePair }
        : {}),
      ...(entry.negativeEdgeUsdc !== undefined ? { negativeEdgeUsdc: entry.negativeEdgeUsdc } : {}),
    });
    executions.push(execution);
    state = applyExecutionToState(state, execution, args.nowTs);
    depletePaperBooks(executionBooks, execution);
  });

  if (decision.completion) {
    const execution = simulateOrderExecution({
      config: args.config,
      books: executionBooks,
      nowTs: args.nowTs,
      kind: "completion",
      outcome: decision.completion.sideToBuy,
      tradeSide: "BUY",
      requestedShares: decision.completion.missingShares,
      reason: decision.completion.capMode,
      order: decision.completion.order,
      mode: decision.completion.mode,
      negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
      flowLineage: `${flowBase}:completion:${decision.completion.sideToBuy}`,
    });
    executions.push(execution);
    state = applyExecutionToState(state, execution, args.nowTs);
    depletePaperBooks(executionBooks, execution);
  }

  if (decision.unwind) {
    const execution = simulateOrderExecution({
      config: args.config,
      books: executionBooks,
      nowTs: args.nowTs,
      kind: "unwind",
      outcome: decision.unwind.sideToSell,
      tradeSide: "SELL",
      requestedShares: decision.unwind.unwindShares,
      reason: "residual_unwind",
      order: decision.unwind.order,
      mode: decision.unwind.mode,
      flowLineage: `${flowBase}:unwind:${decision.unwind.sideToSell}`,
    });
    executions.push(execution);
    state = applyExecutionToState(state, execution, args.nowTs);
    depletePaperBooks(executionBooks, execution);
  }

  let mergeTracker = syncMergeBatchTracker(args.mergeTracker, mergeableShares(state), args.nowTs, {
    activeIndependentFlowCount: countActiveIndependentFlowCount(state.fillHistory, args.nowTs),
  });
  const mergePlan = planMerge(args.config, state);
  const mergeGate = evaluateDelayedMergeGate(args.config, state, {
    nowTs: args.nowTs,
    secsFromOpen: args.nowTs - args.market.startTs,
    secsToClose: args.market.endTs - args.nowTs,
    usdcBalance: 100,
    tracker: mergeTracker,
    activeIndependentFlowCount: countActiveIndependentFlowCount(state.fillHistory, args.nowTs),
  });
  const mergeAmount = normalizeMergeAmount(mergePlan.mergeable, args.config.mergeDustLeaveShares);
  const previousMergeAtMs = args.lastMergeAtMs ?? 0;
  const debouncePassed = previousMergeAtMs <= 0 || args.nowTs * 1000 - previousMergeAtMs >= args.config.mergeDebounceMs;
  let lastMergeAtMs = previousMergeAtMs;
  let merge: LivePaperMergeExecution | undefined;

  if (mergePlan.shouldMerge && mergeGate.allow && mergeAmount >= args.config.mergeMinShares && debouncePassed) {
    state = applyMerge(state, {
      amount: mergeAmount,
      timestamp: args.nowTs,
      simulated: true,
      flowLineage: `${flowBase}:merge`,
    });
    lastMergeAtMs = args.nowTs * 1000;
    const lastMerge = state.mergeHistory.at(-1);
    merge = {
      timestamp: args.nowTs,
      status: "merged",
      requestedShares: normalize(mergePlan.mergeable),
      mergedShares: normalize(mergeAmount),
      reason: mergeGate.reason,
      forced: mergeGate.forced,
      realizedPnl: normalize(lastMerge?.realizedPnl ?? 0),
      mergeReturn: normalize(lastMerge?.mergeReturn ?? mergeAmount),
      gate: mergeGate,
    };
    mergeTracker = syncMergeBatchTracker(mergeTracker, mergeableShares(state), args.nowTs);
  } else if (mergePlan.shouldMerge || mergeGate.pendingMatchedQty > 0) {
    merge = {
      timestamp: args.nowTs,
      status: "skipped",
      requestedShares: normalize(mergePlan.mergeable),
      mergedShares: 0,
      reason: !debouncePassed ? "debounce" : mergeAmount < args.config.mergeMinShares ? "below_min" : mergeGate.reason,
      forced: mergeGate.forced,
      realizedPnl: 0,
      mergeReturn: 0,
      gate: mergeGate,
    };
  }

  const filledExecutions = executions.filter((execution) => execution.filledShares > 1e-9);
  sample.simulatedOrderCount = executions.length;
  sample.simulatedFillCount = filledExecutions.length;
  sample.simulatedPartialFillCount = executions.filter((execution) => execution.status === "partial").length;
  sample.simulatedRejectedOrderCount = executions.filter((execution) => execution.status === "rejected").length;
  sample.simulatedBuyShares = normalize(
    filledExecutions
      .filter((execution) => execution.tradeSide === "BUY")
      .reduce((acc, execution) => acc + execution.filledShares, 0),
  );
  sample.simulatedSellShares = normalize(
    filledExecutions
      .filter((execution) => execution.tradeSide === "SELL")
      .reduce((acc, execution) => acc + execution.filledShares, 0),
  );
  sample.simulatedRawNotional = normalize(filledExecutions.reduce((acc, execution) => acc + execution.rawNotional, 0));
  sample.simulatedFeeUsd = normalize(filledExecutions.reduce((acc, execution) => acc + execution.feeUsd, 0));
  sample.simulatedMergeShares = normalize(merge?.mergedShares ?? 0);
  const stateAfter = buildStateSnapshot(state);
  sample.paperUpShares = stateAfter.upShares;
  sample.paperDownShares = stateAfter.downShares;
  sample.paperUpAverage = stateAfter.upAverage;
  sample.paperDownAverage = stateAfter.downAverage;

  const result: LivePaperTickResult = {
    tickIndex,
    sample,
    decision,
    bookSnapshot: buildBookSnapshot({
      market: args.market,
      upBook: args.upBook,
      downBook: args.downBook,
      depth: Math.max(1, Math.floor(args.bookDepthLevels ?? 10)),
    }),
    stateBefore,
    stateAfter,
    executions,
    mergeGate,
    mergeTracker,
    state,
    lastMergeAtMs,
  };
  if (merge !== undefined) {
    result.merge = merge;
  }
  return result;
}

export function summarizeLivePaperSamples(args: {
  marketSlug: string;
  samples: LivePaperSample[];
  configuredDurationSec: number;
  startedAt: number;
  endedAt: number;
}): LivePaperSummary {
  const samplesWithBooks = args.samples.filter((sample) => sample.hasBooks);
  const pairAskSums = samplesWithBooks
    .map((sample) => sample.pairAskSum)
    .filter((value): value is number => value !== undefined);
  const pairTakerCosts = samplesWithBooks
    .map((sample) => sample.pairTakerCost)
    .filter((value): value is number => value !== undefined);
  const pairEdges = samplesWithBooks
    .map((sample) => sample.pairEdge)
    .filter((value): value is number => value !== undefined);

  return {
    marketSlug: args.marketSlug,
    sampleCount: args.samples.length,
    samplesWithBooks: samplesWithBooks.length,
    entryBuyReadyCount: args.samples.filter((sample) => sample.entryBuyCount > 0).length,
    balancedPairReadyCount: args.samples.filter((sample) => sample.balancedPairEntryCount > 0).length,
    laggingRebalanceReadyCount: args.samples.filter((sample) => sample.laggingRebalanceCount > 0).length,
    completionReadyCount: args.samples.filter((sample) => sample.hasCompletion).length,
    unwindReadyCount: args.samples.filter((sample) => sample.hasUnwind).length,
    mergeReadyCount: args.samples.filter((sample) => sample.mergeShares > 0).length,
    allowNewEntriesCount: args.samples.filter((sample) => sample.allowNewEntries).length,
    completionOnlyCount: args.samples.filter((sample) => sample.completionOnly).length,
    hardCancelCount: args.samples.filter((sample) => sample.hardCancel).length,
    averageBuyShares:
      args.samples.reduce((acc, sample) => acc + sample.buyShares, 0) / Math.max(args.samples.length, 1),
    averageBuyNotional:
      args.samples.reduce((acc, sample) => acc + sample.buyNotional, 0) / Math.max(args.samples.length, 1),
    ...(pairAskSums.length > 0
      ? { averagePairAskSum: pairAskSums.reduce((acc, value) => acc + value, 0) / pairAskSums.length }
      : {}),
    ...(pairTakerCosts.length > 0
      ? { averagePairTakerCost: pairTakerCosts.reduce((acc, value) => acc + value, 0) / pairTakerCosts.length }
      : {}),
    ...(pairEdges.length > 0
      ? {
          bestPairEdge: Math.max(...pairEdges),
          worstPairEdge: Math.min(...pairEdges),
        }
      : {}),
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    configuredDurationSec: args.configuredDurationSec,
  };
}

function enrichSummaryWithExecution(args: {
  summary: LivePaperSummary;
  config: XuanStrategyConfig;
  state: XuanMarketState;
  marketStartTs: number;
  xuanMinFillCountForPass: number;
  xuanTruePassRequiresProfit: boolean;
  xuanTruePassRequiresPairedContinuation: boolean;
  auditFile: string;
  executions: LivePaperOrderExecution[];
  merges: LivePaperMergeExecution[];
  pairCapBlockedCount: number;
  lateFreshSeedCutoffCount: number;
  preopenBlockedCount: number;
  riskGatedBlockedCount: number;
  xuanRhythmWaitSec?: number | undefined;
  xuanCompletionDelayedCount: number;
  xuanEarlyCompletionReason?: string | undefined;
  noTradeReasons: Map<string, number>;
}): LivePaperSummary {
  const filledExecutions = args.executions.filter((execution) => execution.filledShares > 1e-9);
  const finalState = buildStateSnapshot(args.state);
  const buyFills = filledExecutions.filter((execution) => execution.tradeSide === "BUY");
  const completionFills = filledExecutions.filter((execution) => execution.kind === "completion");
  const buyFillsByTimestamp = new Map<number, Set<OutcomeSide>>();
  for (const execution of buyFills) {
    const sides = buyFillsByTimestamp.get(execution.timestamp) ?? new Set<OutcomeSide>();
    sides.add(execution.outcome);
    buyFillsByTimestamp.set(execution.timestamp, sides);
  }
  const sameSecondDualBuyCount = [...buyFillsByTimestamp.values()].filter(
    (sides) => sides.has("UP") && sides.has("DOWN"),
  ).length;
  const sameSecondDualBuyRate = sameSecondDualBuyCount / Math.max(buyFillsByTimestamp.size, 1);
  const oppositeLegGaps = [...buyFills]
    .sort((left, right) => left.timestamp - right.timestamp)
    .reduce<number[]>((gaps, execution, index, sorted) => {
      if (index === 0) {
        return gaps;
      }
      const previous = sorted[index - 1]!;
      if (previous.outcome !== execution.outcome) {
        gaps.push(Math.max(0, execution.timestamp - previous.timestamp));
      }
      return gaps;
    }, []);
  const oppositeLegGapMedianSec = medianNumber(oppositeLegGaps);
  const medianTradeSize = medianNumber(buyFills.map((execution) => execution.filledShares));
  const behaviorMetrics = computeXuanLivePaperBehaviorMetrics(filledExecutions);
  const pairedContinuationCount = behaviorMetrics.pairedContinuationCount;
  const independentFlowCount = behaviorMetrics.independentFlowCount;
  const completionOnlyFillCount = completionFills.length;
  const firstFillTs = buyFills.length > 0 ? Math.min(...buyFills.map((execution) => execution.timestamp)) : undefined;
  const completionTs =
    completionFills.length > 0 ? Math.min(...completionFills.map((execution) => execution.timestamp)) : undefined;
  const lastFillTs = buyFills.length > 0 ? Math.max(...buyFills.map((execution) => execution.timestamp)) : undefined;
  const mergedQty = normalize(args.merges.reduce((acc, merge) => acc + merge.mergedShares, 0));
  const mergedExecutions = args.merges.filter((merge) => merge.status === "merged");
  const mergeRealizedPnl = normalize(mergedExecutions.reduce((acc, merge) => acc + merge.realizedPnl, 0));
  const lastMergeRealizedPnl = normalize(mergedExecutions.at(-1)?.realizedPnl ?? 0);
  const negativeMergePnlCount = mergedExecutions.filter((merge) => merge.realizedPnl < -1e-9).length;
  const imbalanceShares = normalize(Math.abs(finalState.upShares - finalState.downShares));
  const residualShares = normalize(finalState.upShares + finalState.downShares);
  const pairUnderOneFillCount = buyFills.filter((execution) => execution.averagePrice <= 0.5).length;
  const highCostSeedPairs = buyFills
    .filter(
      (execution) =>
        isXuanStagedSeed(execution) &&
        execution.filledShares > 20 + 1e-9 &&
        (execution.pairCostWithFees ?? execution.projectedBasketEffectivePair ?? 0) > 1.06 + 1e-9,
    )
    .map((execution) => execution.pairCostWithFees ?? execution.projectedBasketEffectivePair ?? 0)
    .filter((pairCost) => Number.isFinite(pairCost) && pairCost > 0);
  const highCostSeedMaxPairCost =
    highCostSeedPairs.length > 0 ? normalize(Math.max(...highCostSeedPairs)) : undefined;
  const lateStagedSeeds = buyFills.filter(
    (execution) => isXuanStagedSeed(execution) && execution.timestamp - args.marketStartTs >= 200,
  );
  const residualDominantSide: OutcomeSide | undefined =
    residualShares > 0.02
      ? finalState.upShares > finalState.downShares + 0.02
        ? "UP"
        : finalState.downShares > finalState.upShares + 0.02
          ? "DOWN"
          : undefined
      : undefined;
  const lateSeedUnclosedCount =
    residualShares > 0.02
      ? lateStagedSeeds.filter(
          (execution) => residualDominantSide === undefined || execution.outcome === residualDominantSide,
        ).length
      : 0;
  const mergeReadyButSkippedCount = args.merges.filter(
    (merge) => merge.status === "skipped" && merge.requestedShares > 0,
  ).length;
  const mergeBlockedReasons = new Map<string, number>();
  for (const merge of args.merges) {
    if (merge.status !== "skipped" || merge.requestedShares <= 0) {
      continue;
    }
    mergeBlockedReasons.set(merge.reason, (mergeBlockedReasons.get(merge.reason) ?? 0) + 1);
  }
  const xuanMergeBlockedReasonTop = [...mergeBlockedReasons.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const firstDebtHoldTs = args.merges.find(
    (merge) => merge.status === "skipped" && merge.reason === "basket_debt_hold" && merge.requestedShares > 0,
  )?.timestamp;
  const lastDebtHoldTs = [...args.merges]
    .reverse()
    .find((merge) => merge.status === "skipped" && merge.reason === "basket_debt_hold" && merge.requestedShares > 0)
    ?.timestamp;
  const debtHoldMaxSec =
    firstDebtHoldTs !== undefined && lastDebtHoldTs !== undefined
      ? Math.max(0, lastDebtHoldTs - firstDebtHoldTs)
      : 0;
  const residualDutyReasonPrefixes = [
    "lagging_depth",
    "residual_completion_cost_basis_cap",
    "repair_phase_cap",
    "repair_qty_cap",
    "below_min",
    "rebalance_imbalance",
    "planned_opposite_hold",
    "xuan_pair_cost_wait",
    "pair_cap+single_leg_seed",
    "temporal_cycle_density",
  ];
  const residualDutyBlockedTop = [...args.noTradeReasons.entries()]
    .filter(([reason]) => residualDutyReasonPrefixes.some((prefix) => reason === prefix || reason.startsWith(`${prefix}:`)))
    .sort((left, right) => right[1] - left[1])[0]?.[0];
  const scoreParts = [
    firstFillTs !== undefined && firstFillTs - args.marketStartTs <= 15 ? 20 : 0,
    completionTs !== undefined && completionTs - args.marketStartTs <= 120 ? 20 : 0,
    buyFills.length >= 6 ? 20 : buyFills.length >= 3 ? 10 : 0,
    imbalanceShares <= 1 ? 15 : imbalanceShares <= 5 ? 8 : 0,
    mergedQty > 0 ? 15 : 0,
    pairUnderOneFillCount >= Math.max(1, Math.floor(buyFills.length / 2)) ? 10 : 0,
  ];
  const rawXuanConformanceScore = scoreParts.reduce((acc, value) => acc + value, 0);
  const xuanScore = scoreXuanConformance({
    rawScore: rawXuanConformanceScore,
    fillCount: buyFills.length,
    minFillCountForPass: args.xuanMinFillCountForPass,
    mergedQty,
    mergeRealizedPnl,
    requireProfit: args.xuanTruePassRequiresProfit,
    pairedContinuationCount,
    independentFlowCount,
    requirePairedContinuation: args.xuanTruePassRequiresPairedContinuation,
    debtHoldMaxSec,
    ...(firstFillTs !== undefined ? { firstFillSec: firstFillTs - args.marketStartTs } : {}),
    ...(completionTs !== undefined ? { completionSec: completionTs - args.marketStartTs } : {}),
    imbalanceShares,
    residualShares,
    sameSecondDualBuyRate,
    ...(oppositeLegGapMedianSec !== undefined ? { oppositeLegGapMedianSec } : {}),
    buyRowsPerMarket: buyFills.length,
    highCostSeedCount: highCostSeedPairs.length,
    lateSeedUnclosedCount,
    negativeMergePnlCount,
  });
  const xuanNoTradeReason = [...args.noTradeReasons.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const xuanFinalMergeForced = args.merges.some((merge) => merge.status === "merged" && merge.forced);
  return {
    ...args.summary,
    auditFile: args.auditFile,
    simulatedOrderCount: args.executions.length,
    simulatedFillCount: filledExecutions.length,
    simulatedPartialFillCount: args.executions.filter((execution) => execution.status === "partial").length,
    simulatedRejectedOrderCount: args.executions.filter((execution) => execution.status === "rejected").length,
    simulatedBuyShares: normalize(
      filledExecutions
        .filter((execution) => execution.tradeSide === "BUY")
        .reduce((acc, execution) => acc + execution.filledShares, 0),
    ),
    simulatedSellShares: normalize(
      filledExecutions
        .filter((execution) => execution.tradeSide === "SELL")
        .reduce((acc, execution) => acc + execution.filledShares, 0),
    ),
    simulatedRawNotional: normalize(filledExecutions.reduce((acc, execution) => acc + execution.rawNotional, 0)),
    simulatedFeeUsd: normalize(filledExecutions.reduce((acc, execution) => acc + execution.feeUsd, 0)),
    simulatedMergeCount: args.merges.filter((merge) => merge.status === "merged").length,
    simulatedMergeShares: normalize(args.merges.reduce((acc, merge) => acc + merge.mergedShares, 0)),
    finalUpShares: finalState.upShares,
    finalDownShares: finalState.downShares,
    finalUpAverage: finalState.upAverage,
    finalDownAverage: finalState.downAverage,
    finalFillCount: finalState.fillCount,
    finalMergeCount: finalState.mergeCount,
    ...(firstFillTs !== undefined ? { xuanFirstFillSec: normalize(firstFillTs - args.marketStartTs) } : {}),
    ...(completionTs !== undefined ? { xuanCompletionSec: normalize(completionTs - args.marketStartTs) } : {}),
    ...(lastFillTs !== undefined ? { xuanLastFillSec: normalize(lastFillTs - args.marketStartTs) } : {}),
    xuanFillCount: buyFills.length,
    xuanImbalanceShares: imbalanceShares,
    xuanResidualShares: residualShares,
    xuanMergeQty: mergedQty,
    xuanMergeRealizedPnl: mergeRealizedPnl,
    xuanLastMergeRealizedPnl: lastMergeRealizedPnl,
    xuanPairUnderOneFillCount: pairUnderOneFillCount,
    xuanPairedContinuationCount: pairedContinuationCount,
    xuanIndependentFlowCount: independentFlowCount,
    xuanCompletionOnlyFillCount: completionOnlyFillCount,
    xuanBuyRowsPerMarket: buyFills.length,
    xuanSameSecondDualBuyCount: sameSecondDualBuyCount,
    xuanSameSecondDualBuyRate: normalize(sameSecondDualBuyRate),
    ...(oppositeLegGapMedianSec !== undefined ? { xuanOppositeLegGapMedianSec: normalize(oppositeLegGapMedianSec) } : {}),
    ...(medianTradeSize !== undefined ? { xuanMedianTradeSize: normalize(medianTradeSize) } : {}),
    xuanStagedOppositeSeedCount: behaviorMetrics.stagedOppositeSeedCount,
    xuanStagedOppositeReleaseCount: behaviorMetrics.stagedOppositeReleaseCount,
    xuanStagedOppositeReleaseRate: behaviorMetrics.stagedOppositeReleaseRate,
    xuanDebtReducingContinuationCount: behaviorMetrics.debtReducingContinuationCount,
    xuanDebtHoldMaxSec: normalize(debtHoldMaxSec),
    ...(args.xuanRhythmWaitSec !== undefined ? { xuanRhythmWaitSec: normalize(args.xuanRhythmWaitSec) } : {}),
    xuanCompletionDelayedCount: args.xuanCompletionDelayedCount,
    ...(args.xuanEarlyCompletionReason ? { xuanEarlyCompletionReason: args.xuanEarlyCompletionReason } : {}),
    ...(xuanMergeBlockedReasonTop ? { xuanMergeBlockedReasonTop } : {}),
    xuanMergeReadyButSkippedCount: mergeReadyButSkippedCount,
    xuanPairCapBlockedCount: args.pairCapBlockedCount,
    xuanLateFreshSeedCutoffCount: args.lateFreshSeedCutoffCount,
    xuanPreopenBlockedCount: args.preopenBlockedCount,
    xuanRiskGatedBlockedCount: args.riskGatedBlockedCount,
    xuanFinalMergeForced,
    xuanHighCostSeedCount: highCostSeedPairs.length,
    ...(highCostSeedMaxPairCost !== undefined ? { xuanHighCostSeedMaxPairCost: highCostSeedMaxPairCost } : {}),
    xuanLateSeedUnclosedCount: lateSeedUnclosedCount,
    xuanNegativeMergePnlCount: negativeMergePnlCount,
    ...(residualDutyBlockedTop ? { xuanResidualDutyBlockedTop: residualDutyBlockedTop } : {}),
    ...(xuanNoTradeReason ? { xuanNoTradeReason } : {}),
    xuanPassBlockers: xuanScore.blockers,
    xuanEconomicsWarnings: xuanScore.economicsWarnings,
    xuanConformanceScore: xuanScore.score,
    xuanConformanceStatus: xuanScore.status,
    xuanAggressiveClone: {
      enabled: args.config.xuanCloneMode === "PUBLIC_FOOTPRINT" && args.config.xuanCloneIntensity === "AGGRESSIVE",
      lastFootprintScore: xuanScore.score,
      topBlockers: xuanScore.blockers.slice(0, 5),
    },
  };
}

export async function runLivePaperSession(
  env: AppEnv,
  options: LivePaperOptions = {},
): Promise<LivePaperReport> {
  const baseOptions = {
    durationSec: Math.max(5, Math.floor(options.durationSec ?? 20)),
    sampleMs: Math.max(500, Math.floor(options.sampleMs ?? 2000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
    bookDepthLevels: Math.max(1, Math.floor(options.bookDepthLevels ?? 10)),
  };

  const clob = createClobAdapter(env);
  const gamma = new GammaClient(env);
  const clock = new SystemClock();
  const config = buildStrategyConfig(env);
  const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
  const discoveryNowTs = clock.now();
  const secsToCurrentClose = discovery.current.endTs - discoveryNowTs;
  const secsFromCurrentOpen = discoveryNowTs - discovery.current.startTs;
  const currentMarketAlreadyStarted =
    env.LIVE_PAPER_START_AT_MARKET_OPEN &&
    secsFromCurrentOpen > 0 &&
    discovery.next.startTs > discoveryNowTs;
  const currentMarketTooOldForEarlyPaper =
    env.LIVE_PAPER_MAX_CURRENT_MARKET_AGE_SEC > 0 &&
    secsFromCurrentOpen > env.LIVE_PAPER_MAX_CURRENT_MARKET_AGE_SEC &&
    discovery.next.startTs > discoveryNowTs;
  const selection: "current" | "next" =
    secsToCurrentClose <= config.normalEntryCutoffSecToClose ||
    currentMarketAlreadyStarted ||
    currentMarketTooOldForEarlyPaper
      ? "next"
      : "current";
  const market = selection === "next" ? discovery.next : discovery.current;
  const client = new MarketWsClient(env);
  const startedAt = clock.now();
  const auditFile =
    options.auditFile !== undefined && options.auditFile.trim().length > 0
      ? options.auditFile
      : defaultAuditFile(market.slug, startedAt);
  const resolvedOptions: ResolvedLivePaperOptions = {
    ...baseOptions,
    auditFile,
  };
  const samples: LivePaperSample[] = [];
  const executions: LivePaperOrderExecution[] = [];
  const merges: LivePaperMergeExecution[] = [];
  let pairCapBlockedCount = 0;
  let lateFreshSeedCutoffCount = 0;
  let preopenBlockedCount = 0;
  let riskGatedBlockedCount = 0;
  let xuanRhythmWaitSec: number | undefined;
  let xuanCompletionDelayedCount = 0;
  let xuanEarlyCompletionReason: string | undefined;
  const noTradeReasons = new Map<string, number>();
  let state = createMarketState(market);
  let mergeTracker = createMergeBatchTracker();
  let lastMergeAtMs = 0;

  await writeAuditEvent(auditFile, {
    event: "paper_live_session_started",
    timestamp: startedAt,
    market: {
      selection,
      startAtMarketOpen: env.LIVE_PAPER_START_AT_MARKET_OPEN,
      secsFromCurrentOpen: normalize(secsFromCurrentOpen),
      slug: market.slug,
      conditionId: market.conditionId,
      startTs: market.startTs,
      endTs: market.endTs,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    },
    options: resolvedOptions,
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
      dryRun: env.DRY_RUN,
      ctfMergeEnabled: env.CTF_MERGE_ENABLED,
    },
    strategy: {
      botMode: config.botMode,
      xuanCloneMode: config.xuanCloneMode,
      liveSmallLotLadder: config.liveSmallLotLadder,
      mergeMode: config.mergeMode,
      mergeBatchMode: config.mergeBatchMode,
      mergeMinShares: config.mergeMinShares,
      entryTakerBuyEnabled: config.entryTakerBuyEnabled,
      sellUnwindEnabled: config.sellUnwindEnabled,
    },
  });

  client.connect([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);

  try {
    const waitDeadline = Date.now() + resolvedOptions.initialBookWaitMs;
    while (Date.now() < waitDeadline) {
      if (client.getBook(market.tokens.UP.tokenId) && client.getBook(market.tokens.DOWN.tokenId)) {
        break;
      }
      await sleep(250);
    }

    await writeAuditEvent(auditFile, {
      event: "paper_live_initial_books",
      timestamp: clock.now(),
      hasUpBook: Boolean(client.getBook(market.tokens.UP.tokenId)),
      hasDownBook: Boolean(client.getBook(market.tokens.DOWN.tokenId)),
    });

    const durationAnchorTs = Math.max(startedAt, market.startTs);
    while (clock.now() - durationAnchorTs < resolvedOptions.durationSec && clock.now() < market.endTs) {
      const nowTs = clock.now();
      const tick = buildLivePaperTick({
        config,
        market,
        state,
        mergeTracker,
        nowTs,
        tickIndex: samples.length,
        upBook: client.getBook(market.tokens.UP.tokenId),
        downBook: client.getBook(market.tokens.DOWN.tokenId),
        bookDepthLevels: resolvedOptions.bookDepthLevels,
        lastMergeAtMs,
      });
      state = tick.state;
      mergeTracker = tick.mergeTracker;
      lastMergeAtMs = tick.lastMergeAtMs;
      samples.push(tick.sample);
      executions.push(...tick.executions);
      if (tick.merge !== undefined) {
        merges.push(tick.merge);
      }
      const entrySkipReason =
        tick.decision.trace.entry?.skipReason ??
        tick.decision.trace.entry?.cycleSkippedReason ??
        tick.decision.trace.entry?.plannedOppositeBlockedReason;
      if (entrySkipReason !== undefined) {
        if (tick.decision.phase === "PREOPEN") {
          preopenBlockedCount += 1;
        } else if (!tick.decision.risk.tradable || !tick.decision.risk.allowNewEntries) {
          riskGatedBlockedCount += 1;
        } else {
          noTradeReasons.set(entrySkipReason, (noTradeReasons.get(entrySkipReason) ?? 0) + 1);
          if (entrySkipReason === "pair_cap" || entrySkipReason === "pair_cap+single_leg_seed") {
            pairCapBlockedCount += 1;
          }
          if (entrySkipReason === "late_fresh_seed_cutoff") {
            lateFreshSeedCutoffCount += 1;
          }
        }
      }
      if (tick.decision.trace.entry?.xuanRhythmWaitSec !== undefined) {
        xuanRhythmWaitSec = Math.max(xuanRhythmWaitSec ?? 0, tick.decision.trace.entry.xuanRhythmWaitSec);
      }
      if (tick.decision.trace.entry?.xuanCompletionDelayedCount !== undefined) {
        xuanCompletionDelayedCount += tick.decision.trace.entry.xuanCompletionDelayedCount;
      }
      if (tick.decision.trace.entry?.xuanEarlyCompletionReason !== undefined) {
        xuanEarlyCompletionReason = tick.decision.trace.entry.xuanEarlyCompletionReason;
      }
      await writeAuditEvent(auditFile, {
        event: "paper_live_tick",
        tickIndex: tick.tickIndex,
        timestamp: nowTs,
        marketSlug: market.slug,
        secsFromOpen: nowTs - market.startTs,
        secsToClose: market.endTs - nowTs,
        books: tick.bookSnapshot,
        stateBefore: tick.stateBefore,
        decision: tick.decision,
        executions: tick.executions,
        mergeGate: tick.mergeGate,
        merge: tick.merge ?? null,
        stateAfter: tick.stateAfter,
      });
      await sleep(resolvedOptions.sampleMs);
    }
  } finally {
    client.disconnect();
  }

  const endedAt = clock.now();
  const summary = enrichSummaryWithExecution({
    summary: summarizeLivePaperSamples({
      marketSlug: market.slug,
      samples,
      configuredDurationSec: resolvedOptions.durationSec,
      startedAt,
      endedAt,
    }),
    config,
    state,
    marketStartTs: market.startTs,
    xuanMinFillCountForPass: config.xuanMinFillCountForPass,
    xuanTruePassRequiresProfit: config.xuanTruePassRequiresProfit,
    xuanTruePassRequiresPairedContinuation: config.xuanTruePassRequiresPairedContinuation,
    auditFile,
    executions,
    merges,
    pairCapBlockedCount,
    lateFreshSeedCutoffCount,
    preopenBlockedCount,
    riskGatedBlockedCount,
    xuanRhythmWaitSec,
    xuanCompletionDelayedCount,
    xuanEarlyCompletionReason,
    noTradeReasons,
  });

  await writeAuditEvent(auditFile, {
    event: "paper_live_session_summary",
    timestamp: endedAt,
    marketSlug: market.slug,
    summary,
    finalState: buildStateSnapshot(state),
  });

  return {
    market: {
      selection,
      slug: market.slug,
      conditionId: market.conditionId,
      startTs: market.startTs,
      endTs: market.endTs,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    },
    options: resolvedOptions,
    summary,
    samples,
  };
}
