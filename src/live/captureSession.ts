import { join } from "node:path";
import type { AppEnv } from "../config/schema.js";
import type { MarketInfo, OrderBook, OutcomeSide } from "../infra/clob/types.js";
import { createClobAdapter } from "../infra/clob/index.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { Erc1155BalanceReader } from "../infra/polygon/erc1155Balances.js";
import { SystemClock } from "../infra/time/clock.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { UserWsClient } from "../infra/ws/userWsClient.js";
import { appendJsonl, writeJson } from "../utils/fs.js";

export interface CaptureSessionOptions {
  durationSec?: number;
  initialBookWaitMs?: number;
}

interface TokenBalanceReport {
  tokenId: string;
  rawBalance: string;
  shares: number;
}

interface MarketBalanceReport {
  slug: string;
  conditionId: string;
  up: TokenBalanceReport;
  down: TokenBalanceReport;
}

export interface CaptureSessionReport {
  startedAt: number;
  endedAt: number;
  captureDir: string;
  markets: {
    current: CaptureMarketDescriptor;
    next: CaptureMarketDescriptor;
  };
  subscriptions: {
    marketAssetIds: string[];
    userMarkets: string[];
    userWsEnabled: boolean;
  };
  wsStatus: {
    marketWsOpened: boolean;
    userWsOpened: boolean;
    userWsWarnings: string[];
    userWsErrors: string[];
  };
  initialBalances: {
    current: MarketBalanceReport;
    next: MarketBalanceReport;
  };
  finalBalances: {
    current: MarketBalanceReport;
    next: MarketBalanceReport;
  };
  balanceDeltaShares: {
    current: { up: number; down: number };
    next: { up: number; down: number };
  };
  normalization: {
    assumedScale: 1000000;
    rationale: string;
    confidence: "high" | "medium" | "low";
  };
  captureStats: {
    marketRawEventCount: number;
    userRawEventCount: number;
    marketEventTypes: Record<string, number>;
    userEventTypes: Record<string, number>;
    booksSeenByAssetId: Record<string, number>;
  };
  mappingValidation: {
    current: { upBookSeen: boolean; downBookSeen: boolean };
    next: { upBookSeen: boolean; downBookSeen: boolean };
  };
  latestBooks: Record<string, { bid?: number; ask?: number; timestamp?: number }>;
  files: {
    report: string;
    markets: string;
    balances: string;
    marketWs: string;
    userWs: string;
  };
}

export interface CaptureMarketDescriptor {
  slug: string;
  conditionId: string;
  startTs: number;
  endTs: number;
  tickSize: number;
  minOrderSize: number;
  upTokenId: string;
  downTokenId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDescriptor(market: MarketInfo): CaptureMarketDescriptor {
  return {
    slug: market.slug,
    conditionId: market.conditionId,
    startTs: market.startTs,
    endTs: market.endTs,
    tickSize: market.tickSize,
    minOrderSize: market.minOrderSize,
    upTokenId: market.tokens.UP.tokenId,
    downTokenId: market.tokens.DOWN.tokenId,
  };
}

function buildCaptureDir(startedAt: number): string {
  const timestamp = new Date(startedAt * 1000).toISOString().replace(/[:.]/g, "-");
  return join("data", "capture", timestamp);
}

function normalizeBookTimestampSec(book: OrderBook): number {
  return book.timestamp > 10_000_000_000 ? Math.floor(book.timestamp / 1000) : book.timestamp;
}

function pushCount(bag: Record<string, number>, key: string): void {
  bag[key] = (bag[key] ?? 0) + 1;
}

function buildBalanceDelta(initial: MarketBalanceReport, final: MarketBalanceReport): { up: number; down: number } {
  return {
    up: Number((final.up.shares - initial.up.shares).toFixed(6)),
    down: Number((final.down.shares - initial.down.shares).toFixed(6)),
  };
}

async function captureBalances(
  reader: Erc1155BalanceReader,
  market: MarketInfo,
): Promise<MarketBalanceReport> {
  const raw = await reader.getBalancesRaw([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);
  const shares = await reader.getBalances([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);
  return {
    slug: market.slug,
    conditionId: market.conditionId,
    up: {
      tokenId: market.tokens.UP.tokenId,
      rawBalance: String(raw.get(String(market.tokens.UP.tokenId)) ?? 0n),
      shares: shares.get(String(market.tokens.UP.tokenId)) ?? 0,
    },
    down: {
      tokenId: market.tokens.DOWN.tokenId,
      rawBalance: String(raw.get(String(market.tokens.DOWN.tokenId)) ?? 0n),
      shares: shares.get(String(market.tokens.DOWN.tokenId)) ?? 0,
    },
  };
}

function determineNormalizationConfidence(initial: {
  current: MarketBalanceReport;
  next: MarketBalanceReport;
}): "high" | "medium" | "low" {
  const rawValues = [
    initial.current.up.rawBalance,
    initial.current.down.rawBalance,
    initial.next.up.rawBalance,
    initial.next.down.rawBalance,
  ].map((value) => BigInt(value));

  const nonZero = rawValues.filter((value) => value > 0n);
  if (nonZero.length === 0) {
    return "low";
  }
  if (nonZero.every((value) => value % 1000000n === 0n)) {
    return "high";
  }
  return "medium";
}

async function waitForInitialBooks(
  client: MarketWsClient,
  markets: { current: MarketInfo; next: MarketInfo },
  initialBookWaitMs: number,
): Promise<void> {
  const requiredAssetIds = [
    markets.current.tokens.UP.tokenId,
    markets.current.tokens.DOWN.tokenId,
    markets.next.tokens.UP.tokenId,
    markets.next.tokens.DOWN.tokenId,
  ];
  const deadline = Date.now() + initialBookWaitMs;

  while (Date.now() < deadline) {
    if (requiredAssetIds.every((assetId) => client.getBook(assetId))) {
      return;
    }
    await sleep(250);
  }
}

function latestBookSummary(book: OrderBook | undefined): { bid?: number; ask?: number; timestamp?: number } {
  if (!book) {
    return {};
  }
  return {
    ...(book.bids[0]?.price !== undefined ? { bid: book.bids[0].price } : {}),
    ...(book.asks[0]?.price !== undefined ? { ask: book.asks[0].price } : {}),
    timestamp: normalizeBookTimestampSec(book),
  };
}

export async function runCaptureSession(
  env: AppEnv,
  options: CaptureSessionOptions = {},
): Promise<CaptureSessionReport> {
  const resolvedOptions: Required<CaptureSessionOptions> = {
    durationSec: Math.max(10, Math.floor(options.durationSec ?? 75)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
  };

  const clob = createClobAdapter(env);
  const gamma = new GammaClient(env);
  const clock = new SystemClock();
  const startedAt = clock.now();
  const captureDir = buildCaptureDir(startedAt);
  const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
  const markets = {
    current: discovery.current,
    next: discovery.next,
  };

  const balanceReader = new Erc1155BalanceReader(env);
  const initialBalances = {
    current: await captureBalances(balanceReader, markets.current),
    next: await captureBalances(balanceReader, markets.next),
  };

  const marketWsPath = join(captureDir, "market-ws.jsonl");
  const userWsPath = join(captureDir, "user-ws.jsonl");
  const marketsPath = join(captureDir, "markets.json");
  const balancesPath = join(captureDir, "balances.json");
  const reportPath = join(captureDir, "report.json");

  await writeJson(marketsPath, {
    current: toDescriptor(markets.current),
    next: toDescriptor(markets.next),
  });
  await writeJson(balancesPath, {
    initial: initialBalances,
  });

  const marketWs = new MarketWsClient(env);
  const userWs = new UserWsClient(env);
  const marketAssetIds = [
    markets.current.tokens.UP.tokenId,
    markets.current.tokens.DOWN.tokenId,
    markets.next.tokens.UP.tokenId,
    markets.next.tokens.DOWN.tokenId,
  ];
  const userMarkets = [markets.current.conditionId, markets.next.conditionId];
  const captureStats = {
    marketRawEventCount: 0,
    userRawEventCount: 0,
    marketEventTypes: {} as Record<string, number>,
    userEventTypes: {} as Record<string, number>,
    booksSeenByAssetId: {} as Record<string, number>,
  };
  const wsStatus = {
    marketWsOpened: false,
    userWsOpened: false,
    userWsWarnings: [] as string[],
    userWsErrors: [] as string[],
  };

  marketWs.once("open", () => {
    wsStatus.marketWsOpened = true;
  });
  userWs.once("open", () => {
    wsStatus.userWsOpened = true;
  });
  userWs.on("warn", (error: Error) => {
    wsStatus.userWsWarnings.push(error.message);
  });
  userWs.on("error", (error: Error) => {
    wsStatus.userWsErrors.push(error.message);
  });

  marketWs.on("raw", (event: Record<string, unknown>) => {
    captureStats.marketRawEventCount += 1;
    pushCount(captureStats.marketEventTypes, String(event.event_type ?? "unknown"));
    if (typeof event.asset_id === "string") {
      pushCount(captureStats.booksSeenByAssetId, event.asset_id);
    }
    void appendJsonl(marketWsPath, {
      capturedAt: clock.now(),
      payload: event,
    });
  });

  userWs.on("raw", (event: Record<string, unknown>) => {
    captureStats.userRawEventCount += 1;
    pushCount(captureStats.userEventTypes, String(event.event_type ?? "unknown"));
    void appendJsonl(userWsPath, {
      capturedAt: clock.now(),
      payload: event,
    });
  });

  marketWs.connect(marketAssetIds);
  const userWsEnabled = Boolean(env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE);
  if (userWsEnabled) {
    userWs.connect(userMarkets);
  }

  try {
    await waitForInitialBooks(marketWs, markets, resolvedOptions.initialBookWaitMs);
    await sleep(resolvedOptions.durationSec * 1000);
  } finally {
    marketWs.disconnect();
    userWs.disconnect();
  }

  const endedAt = clock.now();
  const finalBalances = {
    current: await captureBalances(balanceReader, markets.current),
    next: await captureBalances(balanceReader, markets.next),
  };

  const report: CaptureSessionReport = {
    startedAt,
    endedAt,
    captureDir,
    markets: {
      current: toDescriptor(markets.current),
      next: toDescriptor(markets.next),
    },
    subscriptions: {
      marketAssetIds,
      userMarkets,
      userWsEnabled,
    },
    wsStatus,
    initialBalances,
    finalBalances,
    balanceDeltaShares: {
      current: buildBalanceDelta(initialBalances.current, finalBalances.current),
      next: buildBalanceDelta(initialBalances.next, finalBalances.next),
    },
    normalization: {
      assumedScale: 1000000,
      rationale: "ERC1155 balance report includes raw on-chain amount and shares=raw/1e6 hypothesis; local CTF write path already uses 6-decimal base units.",
      confidence: determineNormalizationConfidence(initialBalances),
    },
    captureStats,
    mappingValidation: {
      current: {
        upBookSeen: Boolean(captureStats.booksSeenByAssetId[markets.current.tokens.UP.tokenId]),
        downBookSeen: Boolean(captureStats.booksSeenByAssetId[markets.current.tokens.DOWN.tokenId]),
      },
      next: {
        upBookSeen: Boolean(captureStats.booksSeenByAssetId[markets.next.tokens.UP.tokenId]),
        downBookSeen: Boolean(captureStats.booksSeenByAssetId[markets.next.tokens.DOWN.tokenId]),
      },
    },
    latestBooks: {
      [markets.current.tokens.UP.tokenId]: latestBookSummary(marketWs.getBook(markets.current.tokens.UP.tokenId)),
      [markets.current.tokens.DOWN.tokenId]: latestBookSummary(marketWs.getBook(markets.current.tokens.DOWN.tokenId)),
      [markets.next.tokens.UP.tokenId]: latestBookSummary(marketWs.getBook(markets.next.tokens.UP.tokenId)),
      [markets.next.tokens.DOWN.tokenId]: latestBookSummary(marketWs.getBook(markets.next.tokens.DOWN.tokenId)),
    },
    files: {
      report: reportPath,
      markets: marketsPath,
      balances: balancesPath,
      marketWs: marketWsPath,
      userWs: userWsPath,
    },
  };

  await writeJson(balancesPath, {
    initial: initialBalances,
    final: finalBalances,
    deltaShares: report.balanceDeltaShares,
  });
  await writeJson(reportPath, report);

  return report;
}
