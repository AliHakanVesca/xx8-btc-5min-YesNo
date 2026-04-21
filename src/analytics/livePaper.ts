import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { createClobAdapter } from "../infra/clob/index.js";
import type { MarketInfo, OrderBook } from "../infra/clob/types.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { createMarketState } from "../strategy/xuan5m/marketState.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { pairCostWithBothTaker, pairEdge } from "../strategy/xuan5m/sumAvgEngine.js";
import { SystemClock } from "../infra/time/clock.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";

export interface LivePaperOptions {
  durationSec?: number;
  sampleMs?: number;
  initialBookWaitMs?: number;
}

export interface LivePaperSample {
  timestamp: number;
  phase: string;
  secsToClose: number;
  hasBooks: boolean;
  entryBuyCount: number;
  makerOrderCount: number;
  buyShares: number;
  buyNotional: number;
  quotedShares: number;
  quotedNotional: number;
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
}

export interface LivePaperSummary {
  marketSlug: string;
  sampleCount: number;
  samplesWithBooks: number;
  entryBuyReadyCount: number;
  makerReadyCount: number;
  completionReadyCount: number;
  unwindReadyCount: number;
  mergeReadyCount: number;
  allowNewEntriesCount: number;
  completionOnlyCount: number;
  hardCancelCount: number;
  averageBuyShares: number;
  averageBuyNotional: number;
  averageQuotedShares: number;
  averageQuotedNotional: number;
  averagePairAskSum?: number;
  averagePairTakerCost?: number;
  bestPairEdge?: number;
  worstPairEdge?: number;
  startedAt: number;
  endedAt: number;
  configuredDurationSec: number;
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
  options: Required<LivePaperOptions>;
  summary: LivePaperSummary;
  samples: LivePaperSample[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function buildLivePaperSample(args: {
  env: AppEnv;
  market: MarketInfo;
  nowTs: number;
  upBook: OrderBook | undefined;
  downBook: OrderBook | undefined;
}): LivePaperSample {
  const config = buildStrategyConfig(args.env);
  const bot = new Xuan5mBot();
  const state = createMarketState(args.market);
  const books = new OrderBookState(args.upBook, args.downBook);
  const oldestBookStaleMs = Math.max(
    computeBookStaleMs(args.upBook, args.nowTs),
    computeBookStaleMs(args.downBook, args.nowTs),
  );

  const decision = bot.evaluateTick({
    config,
    state,
    books,
    nowTs: args.nowTs,
    riskContext: {
      secsToClose: args.market.endTs - args.nowTs,
      staleBookMs: oldestBookStaleMs,
      balanceStaleMs: 0,
      bookIsCrossed: books.bestBid("UP") > books.bestAsk("UP") || books.bestBid("DOWN") > books.bestAsk("DOWN"),
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    },
    dryRunOrSmallLive: true,
  });

  const buyShares = decision.entryBuys.reduce((acc, order) => acc + order.size, 0);
  const buyNotional = decision.entryBuys.reduce((acc, order) => acc + order.size * order.expectedAveragePrice, 0);
  const quotedShares = decision.makerOrders.reduce((acc, order) => acc + order.size, 0);
  const quotedNotional = decision.makerOrders.reduce((acc, order) => acc + order.size * order.price, 0);
  const hasBooks = Boolean(args.upBook && args.downBook);
  const pairAskSum = hasBooks ? books.bestAsk("UP") + books.bestAsk("DOWN") : undefined;
  const pairTakerCost = hasBooks
    ? pairCostWithBothTaker(books.bestAsk("UP"), books.bestAsk("DOWN"), config.cryptoTakerFeeRate)
    : undefined;

  return {
    timestamp: args.nowTs,
    phase: decision.phase,
    secsToClose: args.market.endTs - args.nowTs,
    hasBooks,
    entryBuyCount: decision.entryBuys.length,
    makerOrderCount: decision.makerOrders.length,
    buyShares,
    buyNotional,
    quotedShares,
    quotedNotional,
    hasCompletion: Boolean(decision.completion),
    hasUnwind: Boolean(decision.unwind),
    mergeShares: decision.mergeShares,
    allowNewEntries: decision.risk.allowNewEntries,
    completionOnly: decision.risk.completionOnly,
    hardCancel: decision.risk.hardCancel,
    riskReasons: decision.risk.reasons,
    ...(pairAskSum !== undefined ? { pairAskSum } : {}),
    ...(pairTakerCost !== undefined ? { pairTakerCost, pairEdge: pairEdge(pairTakerCost) } : {}),
  };
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
    makerReadyCount: args.samples.filter((sample) => sample.makerOrderCount > 0).length,
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
    averageQuotedShares:
      args.samples.reduce((acc, sample) => acc + sample.quotedShares, 0) / Math.max(args.samples.length, 1),
    averageQuotedNotional:
      args.samples.reduce((acc, sample) => acc + sample.quotedNotional, 0) / Math.max(args.samples.length, 1),
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

export async function runLivePaperSession(
  env: AppEnv,
  options: LivePaperOptions = {},
): Promise<LivePaperReport> {
  const resolvedOptions: Required<LivePaperOptions> = {
    durationSec: Math.max(5, Math.floor(options.durationSec ?? 20)),
    sampleMs: Math.max(500, Math.floor(options.sampleMs ?? 2000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
  };

  const clob = createClobAdapter(env);
  const gamma = new GammaClient(env);
  const clock = new SystemClock();
  const config = buildStrategyConfig(env);
  const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
  const secsToCurrentClose = discovery.current.endTs - clock.now();
  const selection: "current" | "next" =
    secsToCurrentClose <= config.normalEntryCutoffSecToClose ? "next" : "current";
  const market = selection === "next" ? discovery.next : discovery.current;
  const client = new MarketWsClient(env);
  const startedAt = clock.now();
  const samples: LivePaperSample[] = [];

  client.connect([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);

  try {
    const waitDeadline = Date.now() + resolvedOptions.initialBookWaitMs;
    while (Date.now() < waitDeadline) {
      if (client.getBook(market.tokens.UP.tokenId) && client.getBook(market.tokens.DOWN.tokenId)) {
        break;
      }
      await sleep(250);
    }

    while (clock.now() - startedAt < resolvedOptions.durationSec && clock.now() < market.endTs) {
      const nowTs = clock.now();
      samples.push(
        buildLivePaperSample({
          env,
          market,
          nowTs,
          upBook: client.getBook(market.tokens.UP.tokenId),
          downBook: client.getBook(market.tokens.DOWN.tokenId),
        }),
      );
      await sleep(resolvedOptions.sampleMs);
    }
  } finally {
    client.disconnect();
  }

  const endedAt = clock.now();

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
    summary: summarizeLivePaperSamples({
      marketSlug: market.slug,
      samples,
      configuredDurationSec: resolvedOptions.durationSec,
      startedAt,
      endedAt,
    }),
    samples,
  };
}
