import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import xlsx from "xlsx";
import { average, median, quantile, safeDivide } from "../../utils/math.js";
import { writeJson } from "../../utils/fs.js";

export interface XuanTrade {
  marketSlug: string;
  outcome: "UP" | "DOWN";
  side: string;
  price: number;
  size: number;
  timestamp: number;
  transactionHash?: string | undefined;
  wallet?: string | undefined;
}

export interface XuanLifecycleEvent {
  marketSlug: string;
  type: "MERGE" | "REDEEM";
  timestamp: number;
  secondsFromMarketStart: number;
  sizeTokens: number;
  usdcSize: number;
  transactionHash?: string | undefined;
  conditionId?: string | undefined;
  outcome?: string | undefined;
}

export interface MarketTradeMetrics {
  marketSlug: string;
  fillCount: number;
  upCount: number;
  downCount: number;
  upShares: number;
  downShares: number;
  firstFillSec: number;
  lastFillSec: number;
  upAvg: number;
  downAvg: number;
  pairVwapSum: number;
  imbalance: number;
}

export interface XuanMetricsReport {
  sourceFile: string;
  totalTrades: number;
  marketCount: number;
  buyCount: number;
  sellCount: number;
  upCount: number;
  downCount: number;
  equalFillCountMarketCount: number;
  medianFillsPerMarket: number;
  medianFirstFillSec: number;
  medianLastFillSec: number;
  medianFillSize: number;
  firstBuySec: number;
  lastBuySec: number;
  p75FillSize: number;
  p90FillSize: number;
  p95FillSize: number;
  buyOnlyRate: number;
  mergeCount: number;
  redeemCount: number;
  mergeTimingBuckets: Record<string, number>;
  topGuardBlockers: Array<{ reason: string; count: number }>;
  sameSecondDualBuyRate: number;
  sameSecondDualBuyCount: number;
  oppositeLegGapMedian: number;
  buyRowsPerMarket: number;
  medianTradeSize: number;
  mergeAfterMatchedDelay: number;
  stagedOppositeReleaseRate: number;
  medianPairVwapSum: number;
  medianImbalance: number;
  pairVwapSumBelowOneRate: number;
  pairVwapSumBelow0982Rate: number;
  pairVwapSumBelow0964Rate: number;
  perMarket: MarketTradeMetrics[];
}

export interface XuanActivityImportBundle {
  generatedAt: string;
  sourceFile: string;
  sourceLimitNote: string;
  trades: XuanTrade[];
  lifecycleEvents: XuanLifecycleEvent[];
  report: XuanMetricsReport;
  marketSummaries: Record<string, unknown>[];
  fullHistory?: XuanFullActivityFetchResult | undefined;
}

export interface XuanFullActivityFetchOptions {
  wallet: string;
  baseUrl: string;
  pageLimit?: number | undefined;
  maxPages?: number | undefined;
}

export interface XuanFullActivityFetchResult {
  wallet: string;
  baseUrl: string;
  fetchedRows: number;
  requestCount: number;
  reachedEnd: boolean;
  rawRows: Record<string, unknown>[];
  trades: XuanTrade[];
  lifecycleEvents: XuanLifecycleEvent[];
  report: XuanMetricsReport;
}

function parseNumberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) {
      return Math.floor(asDate / 1000);
    }
  }
  return undefined;
}

function normalizeOutcome(value: unknown): "UP" | "DOWN" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("up")) {
    return "UP";
  }
  if (normalized.includes("down")) {
    return "DOWN";
  }
  return undefined;
}

function normalizeSide(value: unknown): string {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }
  return value.toUpperCase();
}

function parseMarketSlug(raw: any): string | undefined {
  return raw?.marketSlug ?? raw?.market_slug ?? raw?.slug ?? raw?.market_slug_name ?? raw?.market;
}

function parseTimestamp(raw: any): number | undefined {
  return (
    parseNumberish(raw?.timestamp) ??
    parseNumberish(raw?.timestamp_unix) ??
    parseNumberish(raw?.match_time) ??
    parseNumberish(raw?.created_at) ??
    parseNumberish(raw?.createdAt) ??
    parseNumberish(raw?.last_update) ??
    parseNumberish(raw?.time)
  );
}

function parseTrade(raw: any): XuanTrade | undefined {
  const marketSlug = parseMarketSlug(raw);
  const outcome = normalizeOutcome(raw?.outcome ?? raw?.token_outcome ?? raw?.label);
  const side = normalizeSide(raw?.side ?? raw?.type ?? raw?.action);
  const centsFormula = parseNumberish(raw?.api_price_cents_formula);
  const price =
    parseNumberish(raw?.price) ??
    parseNumberish(raw?.api_price_usd) ??
    (centsFormula !== undefined ? centsFormula / 100 : undefined);
  const size = parseNumberish(raw?.size ?? raw?.amount ?? raw?.shares ?? raw?.size_tokens);
  const timestamp = parseTimestamp(raw);

  if (!marketSlug || !outcome || price === undefined || size === undefined || timestamp === undefined) {
    return undefined;
  }

  return {
    marketSlug,
    outcome,
    side,
    price,
    size,
    timestamp,
    transactionHash:
      typeof raw?.transactionHash === "string"
        ? raw.transactionHash
        : typeof raw?.transaction_hash === "string"
          ? raw.transaction_hash
          : undefined,
    wallet:
      typeof raw?.proxyWallet === "string"
        ? raw.proxyWallet
        : typeof raw?.proxy_wallet === "string"
          ? raw.proxy_wallet
          : typeof raw?.wallet === "string"
            ? raw.wallet
            : undefined,
  };
}

function parseLifecycleEvent(raw: any): XuanLifecycleEvent | undefined {
  const type = normalizeSide(raw?.type ?? raw?.action);
  if (type !== "MERGE" && type !== "REDEEM") {
    return undefined;
  }
  const marketSlug = parseMarketSlug(raw);
  const timestamp = parseTimestamp(raw);
  if (!marketSlug || timestamp === undefined) {
    return undefined;
  }
  const marketStart = parseNumberish(raw?.market_start_unix) ?? parseWindowStart(marketSlug) ?? timestamp;
  const secondsFromMarketStart =
    parseNumberish(raw?.seconds_from_market_start) ?? Math.max(0, timestamp - marketStart);
  const sizeTokens = parseNumberish(raw?.size_tokens) ?? parseNumberish(raw?.size) ?? 0;
  const usdcSize = parseNumberish(raw?.usdcSize) ?? parseNumberish(raw?.usdc_size) ?? sizeTokens;

  return {
    marketSlug,
    type,
    timestamp,
    secondsFromMarketStart,
    sizeTokens,
    usdcSize,
    transactionHash:
      typeof raw?.transactionHash === "string"
        ? raw.transactionHash
        : typeof raw?.transaction_hash === "string"
          ? raw.transaction_hash
          : undefined,
    conditionId: typeof raw?.conditionId === "string" ? raw.conditionId : undefined,
    outcome:
      typeof raw?.inferred_redeem_outcome === "string" && raw.inferred_redeem_outcome.length > 0
        ? raw.inferred_redeem_outcome
        : undefined,
  };
}

export function inferXuanWalletFromPayload(payload: unknown): string | undefined {
  const first = extractXuanTradesFromPayload(payload).find((trade) => typeof trade.wallet === "string" && trade.wallet.length > 0);
  return first?.wallet;
}

export function extractXuanTradesFromPayload(payload: unknown): XuanTrade[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.trades)
      ? (payload as any).trades
      : Array.isArray((payload as any)?.data)
        ? (payload as any).data
        : [];

  return rows
    .map((row: unknown) => parseTrade(row))
    .filter((trade: XuanTrade | undefined): trade is XuanTrade => trade !== undefined);
}

export function extractXuanLifecycleEventsFromPayload(payload: unknown): XuanLifecycleEvent[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.lifecycleEvents)
      ? (payload as any).lifecycleEvents
      : Array.isArray((payload as any)?.events)
        ? (payload as any).events
        : Array.isArray((payload as any)?.data)
          ? (payload as any).data
          : [];

  return rows
    .map((row: unknown) => parseLifecycleEvent(row))
    .filter((event: XuanLifecycleEvent | undefined): event is XuanLifecycleEvent => event !== undefined);
}

function parseWindowStart(marketSlug: string): number | undefined {
  const parts = marketSlug.split("-");
  const last = parts.at(-1);
  return last ? parseNumberish(last) : undefined;
}

function computeMarketMetrics(trades: XuanTrade[]): MarketTradeMetrics {
  const byOutcome = {
    UP: trades.filter((trade) => trade.outcome === "UP"),
    DOWN: trades.filter((trade) => trade.outcome === "DOWN"),
  };
  const marketSlug = trades[0]?.marketSlug ?? "unknown";
  const marketStart = parseWindowStart(marketSlug) ?? trades[0]?.timestamp ?? 0;

  const upShares = byOutcome.UP.reduce((acc, trade) => acc + trade.size, 0);
  const downShares = byOutcome.DOWN.reduce((acc, trade) => acc + trade.size, 0);
  const upCost = byOutcome.UP.reduce((acc, trade) => acc + trade.size * trade.price, 0);
  const downCost = byOutcome.DOWN.reduce((acc, trade) => acc + trade.size * trade.price, 0);
  const upAvg = safeDivide(upCost, upShares);
  const downAvg = safeDivide(downCost, downShares);

  return {
    marketSlug,
    fillCount: trades.length,
    upCount: byOutcome.UP.length,
    downCount: byOutcome.DOWN.length,
    upShares,
    downShares,
    firstFillSec: Math.max(0, (trades[0]?.timestamp ?? marketStart) - marketStart),
    lastFillSec: Math.max(0, (trades[trades.length - 1]?.timestamp ?? marketStart) - marketStart),
    upAvg,
    downAvg,
    pairVwapSum: upAvg + downAvg,
    imbalance: safeDivide(Math.abs(upShares - downShares), Math.max(upShares + downShares, 1)),
  };
}

function tradeSecondsFromMarketStart(trade: XuanTrade): number {
  const marketStart = parseWindowStart(trade.marketSlug) ?? trade.timestamp;
  return Math.max(0, trade.timestamp - marketStart);
}

function sameSecondDualBuyStats(trades: XuanTrade[]): { count: number; rate: number } {
  const byMarketSecond = new Map<string, Set<"UP" | "DOWN">>();
  for (const trade of trades.filter((entry) => entry.side === "BUY")) {
    const key = `${trade.marketSlug}:${tradeSecondsFromMarketStart(trade)}`;
    const sides = byMarketSecond.get(key) ?? new Set<"UP" | "DOWN">();
    sides.add(trade.outcome);
    byMarketSecond.set(key, sides);
  }
  const count = [...byMarketSecond.values()].filter((sides) => sides.has("UP") && sides.has("DOWN")).length;
  return {
    count,
    rate: safeDivide(count, byMarketSecond.size),
  };
}

function oppositeLegGapMedian(trades: XuanTrade[]): number {
  const gaps: number[] = [];
  const byMarket = new Map<string, XuanTrade[]>();
  for (const trade of trades.filter((entry) => entry.side === "BUY")) {
    const bucket = byMarket.get(trade.marketSlug) ?? [];
    bucket.push(trade);
    byMarket.set(trade.marketSlug, bucket);
  }
  for (const marketTrades of byMarket.values()) {
    const sorted = marketTrades.sort((a, b) => a.timestamp - b.timestamp);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (previous.outcome !== current.outcome) {
        gaps.push(Math.max(0, current.timestamp - previous.timestamp));
      }
    }
  }
  return median(gaps);
}

function mergeAfterMatchedDelay(trades: XuanTrade[], lifecycleEvents: XuanLifecycleEvent[]): number {
  const delays: number[] = [];
  const buyByMarket = new Map<string, XuanTrade[]>();
  for (const trade of trades.filter((entry) => entry.side === "BUY")) {
    const bucket = buyByMarket.get(trade.marketSlug) ?? [];
    bucket.push(trade);
    buyByMarket.set(trade.marketSlug, bucket);
  }
  for (const event of lifecycleEvents.filter((entry) => entry.type === "MERGE")) {
    const buys = (buyByMarket.get(event.marketSlug) ?? []).filter((trade) => trade.timestamp <= event.timestamp);
    if (buys.length === 0) {
      continue;
    }
    const lastBuyTs = Math.max(...buys.map((trade) => trade.timestamp));
    delays.push(Math.max(0, event.timestamp - lastBuyTs));
  }
  return median(delays);
}

function mergeTimingBuckets(events: XuanLifecycleEvent[]): Record<string, number> {
  const buckets: Record<string, number> = {
    before_160s: 0,
    first_window_160_210s: 0,
    mid_211_275s: 0,
    final_276_282s: 0,
    after_282s: 0,
  };
  for (const event of events.filter((entry) => entry.type === "MERGE")) {
    if (event.secondsFromMarketStart < 160) {
      buckets.before_160s = (buckets.before_160s ?? 0) + 1;
    } else if (event.secondsFromMarketStart <= 210) {
      buckets.first_window_160_210s = (buckets.first_window_160_210s ?? 0) + 1;
    } else if (event.secondsFromMarketStart <= 275) {
      buckets.mid_211_275s = (buckets.mid_211_275s ?? 0) + 1;
    } else if (event.secondsFromMarketStart <= 282) {
      buckets.final_276_282s = (buckets.final_276_282s ?? 0) + 1;
    } else {
      buckets.after_282s = (buckets.after_282s ?? 0) + 1;
    }
  }
  return buckets;
}

export async function loadXuanDataset(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export function analyzeXuanPayload(payload: unknown, sourceFile = "inline"): XuanMetricsReport {
  const trades = extractXuanTradesFromPayload(payload).sort((a, b) => a.timestamp - b.timestamp);
  const lifecycleEvents = extractXuanLifecycleEventsFromPayload(payload);
  const marketMap = new Map<string, XuanTrade[]>();

  for (const trade of trades) {
    const bucket = marketMap.get(trade.marketSlug) ?? [];
    bucket.push(trade);
    marketMap.set(trade.marketSlug, bucket);
  }

  const perMarket = [...marketMap.values()]
    .map((marketTrades) => computeMarketMetrics(marketTrades))
    .sort((a, b) => a.marketSlug.localeCompare(b.marketSlug));

  const fillSizes = trades.map((trade) => trade.size);
  const buyTrades = trades.filter((trade) => trade.side === "BUY");
  const buySeconds = buyTrades.map((trade) => tradeSecondsFromMarketStart(trade));
  const sameSecondDualBuy = sameSecondDualBuyStats(trades);
  const pairSums = perMarket.map((entry) => entry.pairVwapSum);
  const imbalances = perMarket.map((entry) => entry.imbalance);

  return {
    sourceFile,
    totalTrades: trades.length,
    marketCount: perMarket.length,
    buyCount: trades.filter((trade) => trade.side === "BUY").length,
    sellCount: trades.filter((trade) => trade.side === "SELL").length,
    upCount: trades.filter((trade) => trade.outcome === "UP").length,
    downCount: trades.filter((trade) => trade.outcome === "DOWN").length,
    equalFillCountMarketCount: perMarket.filter((entry) => entry.upCount === entry.downCount).length,
    medianFillsPerMarket: median(perMarket.map((entry) => entry.fillCount)),
    medianFirstFillSec: median(perMarket.map((entry) => entry.firstFillSec)),
    medianLastFillSec: median(perMarket.map((entry) => entry.lastFillSec)),
    medianFillSize: median(fillSizes),
    firstBuySec: buySeconds.length > 0 ? Math.min(...buySeconds) : 0,
    lastBuySec: buySeconds.length > 0 ? Math.max(...buySeconds) : 0,
    p75FillSize: quantile(fillSizes, 0.75),
    p90FillSize: quantile(fillSizes, 0.9),
    p95FillSize: quantile(fillSizes, 0.95),
    buyOnlyRate: safeDivide(buyTrades.length, trades.length),
    mergeCount: lifecycleEvents.filter((event) => event.type === "MERGE").length,
    redeemCount: lifecycleEvents.filter((event) => event.type === "REDEEM").length,
    mergeTimingBuckets: mergeTimingBuckets(lifecycleEvents),
    topGuardBlockers: [],
    sameSecondDualBuyRate: sameSecondDualBuy.rate,
    sameSecondDualBuyCount: sameSecondDualBuy.count,
    oppositeLegGapMedian: oppositeLegGapMedian(trades),
    buyRowsPerMarket: safeDivide(buyTrades.length, perMarket.length),
    medianTradeSize: median(fillSizes),
    mergeAfterMatchedDelay: mergeAfterMatchedDelay(trades, lifecycleEvents),
    stagedOppositeReleaseRate: 1 - sameSecondDualBuy.rate,
    medianPairVwapSum: median(pairSums),
    medianImbalance: median(imbalances),
    pairVwapSumBelowOneRate: safeDivide(pairSums.filter((value) => value < 1).length, pairSums.length),
    pairVwapSumBelow0982Rate: safeDivide(pairSums.filter((value) => value < 0.982).length, pairSums.length),
    pairVwapSumBelow0964Rate: safeDivide(pairSums.filter((value) => value < 0.964).length, pairSums.length),
    perMarket,
  };
}

export async function analyzeXuanFile(filePath: string): Promise<XuanMetricsReport> {
  const payload = await loadXuanDataset(filePath);
  return analyzeXuanPayload(payload, basename(filePath));
}

function readWorkbookSheetRows(workbook: xlsx.WorkBook, sheetName: string): Record<string, unknown>[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return [];
  }
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: true,
  });
}

export async function analyzeXuanActivityWorkbook(filePath: string): Promise<XuanActivityImportBundle> {
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const activityRows = readWorkbookSheetRows(workbook, "Activity_Log");
  const marketSummaries = readWorkbookSheetRows(workbook, "Market_Summary");
  const payload = {
    trades: activityRows,
    lifecycleEvents: activityRows,
  };
  const trades = extractXuanTradesFromPayload(payload).sort((a, b) => a.timestamp - b.timestamp);
  const lifecycleEvents = extractXuanLifecycleEventsFromPayload(payload).sort((a, b) => a.timestamp - b.timestamp);
  const report = analyzeXuanPayload(payload, basename(filePath));

  return {
    generatedAt: new Date().toISOString(),
    sourceFile: basename(filePath),
    sourceLimitNote: `Workbook contains ${activityRows.length} captured Activity_Log rows; treat it as a slice, not full wallet history. Use Polymarket activity pagination for the full public history cache.`,
    trades,
    lifecycleEvents,
    report,
    marketSummaries,
  };
}

function extractActivityRows(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.data)
      ? (payload as any).data
      : Array.isArray((payload as any)?.activity)
        ? (payload as any).activity
        : [];
  return rows.filter(
    (row: unknown): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

export async function fetchXuanFullActivityHistory(
  options: XuanFullActivityFetchOptions,
): Promise<XuanFullActivityFetchResult> {
  const pageLimit = Math.max(1, Math.min(Math.floor(options.pageLimit ?? 500), 500));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 40));
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const rawRows: Record<string, unknown>[] = [];
  let requestCount = 0;
  let reachedEnd = false;

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageLimit;
    const url = new URL(`${baseUrl}/activity`);
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sortBy", "TIMESTAMP");
    url.searchParams.set("sortDirection", "DESC");
    url.searchParams.set("user", options.wallet);
    const response = await fetch(url);
    requestCount += 1;
    if (!response.ok) {
      throw new Error(`Polymarket activity fetch failed: ${response.status} ${response.statusText}`);
    }
    const rows = extractActivityRows(await response.json());
    rawRows.push(...rows);
    if (rows.length < pageLimit) {
      reachedEnd = true;
      break;
    }
  }

  const payload = {
    trades: rawRows,
    lifecycleEvents: rawRows,
  };
  const trades = extractXuanTradesFromPayload(payload).sort((a, b) => a.timestamp - b.timestamp);
  const lifecycleEvents = extractXuanLifecycleEventsFromPayload(payload).sort((a, b) => a.timestamp - b.timestamp);

  return {
    wallet: options.wallet,
    baseUrl,
    fetchedRows: rawRows.length,
    requestCount,
    reachedEnd,
    rawRows,
    trades,
    lifecycleEvents,
    report: analyzeXuanPayload(payload, `polymarket-activity:${options.wallet}`),
  };
}

export async function writeXuanActivityImportBundle(
  bundle: XuanActivityImportBundle,
  outputPath = "reports/xuan_activity_import.json",
): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeJson(outputPath, bundle);
  return outputPath;
}

export async function writeXuanMarkdownReport(report: XuanMetricsReport): Promise<string> {
  await mkdir("reports", { recursive: true });

  const lines = [
    "# Xuan Metrics",
    "",
    `- Source: ${report.sourceFile}`,
    `- Total trades: ${report.totalTrades}`,
    `- Market count: ${report.marketCount}`,
    `- BUY / SELL: ${report.buyCount} / ${report.sellCount}`,
    `- UP / DOWN: ${report.upCount} / ${report.downCount}`,
    `- Equal fill-count markets: ${report.equalFillCountMarketCount}`,
    `- Median fills per market: ${report.medianFillsPerMarket.toFixed(2)}`,
    `- Median first fill sec: ${report.medianFirstFillSec.toFixed(2)}`,
    `- Median last fill sec: ${report.medianLastFillSec.toFixed(2)}`,
    `- Median fill size: ${report.medianFillSize.toFixed(2)}`,
    `- First / last BUY sec: ${report.firstBuySec.toFixed(0)} / ${report.lastBuySec.toFixed(0)}`,
    `- BUY-only rate: ${(report.buyOnlyRate * 100).toFixed(2)}%`,
    `- MERGE / REDEEM: ${report.mergeCount} / ${report.redeemCount}`,
    `- Same-second dual BUY count/rate: ${report.sameSecondDualBuyCount} / ${(report.sameSecondDualBuyRate * 100).toFixed(2)}%`,
    `- Opposite-leg gap median: ${report.oppositeLegGapMedian.toFixed(2)}s`,
    `- BUY rows per market: ${report.buyRowsPerMarket.toFixed(2)}`,
    `- Merge after matched delay median: ${report.mergeAfterMatchedDelay.toFixed(2)}s`,
    `- Fill size p75/p90/p95: ${report.p75FillSize.toFixed(2)} / ${report.p90FillSize.toFixed(2)} / ${report.p95FillSize.toFixed(2)}`,
    `- Median pair VWAP sum: ${report.medianPairVwapSum.toFixed(4)}`,
    `- Median imbalance: ${(report.medianImbalance * 100).toFixed(2)}%`,
    `- Pair sum < 1.00: ${(report.pairVwapSumBelowOneRate * 100).toFixed(2)}%`,
    `- Pair sum < 0.982: ${(report.pairVwapSumBelow0982Rate * 100).toFixed(2)}%`,
    `- Pair sum < 0.964: ${(report.pairVwapSumBelow0964Rate * 100).toFixed(2)}%`,
    "",
    "## Markets",
    "",
    "| Market | Fills | Up | Down | First | Last | PairSum | Imbalance |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.perMarket.map(
      (entry) =>
        `| ${entry.marketSlug} | ${entry.fillCount} | ${entry.upCount} | ${entry.downCount} | ${entry.firstFillSec.toFixed(
          0,
        )} | ${entry.lastFillSec.toFixed(0)} | ${entry.pairVwapSum.toFixed(4)} | ${(entry.imbalance * 100).toFixed(2)}% |`,
    ),
  ];

  const outputPath = "reports/xuan_metrics.md";
  await writeJson("reports/xuan_metrics.json", report);
  await writeFile(outputPath, lines.join("\n"), "utf8");
  return outputPath;
}
