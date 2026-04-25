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
  negativeEdgeUsdc?: number;
  flowLineage?: string;
}

export interface LivePaperMergeExecution {
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
  kind: LivePaperOrderExecution["kind"];
  outcome: OutcomeSide;
  tradeSide: TradeSide;
  requestedShares: number;
  reason: string;
  order: MarketOrderArgs;
  mode?: StrategyExecutionMode;
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
      kind: "entry",
      outcome: entry.side,
      tradeSide: "BUY",
      requestedShares: entry.size,
      reason: entry.reason,
      order: entry.order,
      mode: entry.mode,
      flowLineage: `${flowBase}:entry:${entry.reason}:${index}`,
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
  state: XuanMarketState;
  auditFile: string;
  executions: LivePaperOrderExecution[];
  merges: LivePaperMergeExecution[];
}): LivePaperSummary {
  const filledExecutions = args.executions.filter((execution) => execution.filledShares > 1e-9);
  const finalState = buildStateSnapshot(args.state);
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
    state,
    auditFile,
    executions,
    merges,
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
