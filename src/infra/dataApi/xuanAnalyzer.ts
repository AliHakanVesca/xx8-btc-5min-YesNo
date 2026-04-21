import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { average, median, quantile, safeDivide } from "../../utils/math.js";
import { writeJson } from "../../utils/fs.js";

export interface XuanTrade {
  marketSlug: string;
  outcome: "UP" | "DOWN";
  side: string;
  price: number;
  size: number;
  timestamp: number;
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
  p75FillSize: number;
  p90FillSize: number;
  p95FillSize: number;
  medianPairVwapSum: number;
  medianImbalance: number;
  pairVwapSumBelowOneRate: number;
  pairVwapSumBelow0982Rate: number;
  pairVwapSumBelow0964Rate: number;
  perMarket: MarketTradeMetrics[];
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
  const price = parseNumberish(raw?.price);
  const size = parseNumberish(raw?.size ?? raw?.amount ?? raw?.shares);
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
  };
}

function parseTrades(payload: unknown): XuanTrade[] {
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

export async function loadXuanDataset(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export function analyzeXuanPayload(payload: unknown, sourceFile = "inline"): XuanMetricsReport {
  const trades = parseTrades(payload).sort((a, b) => a.timestamp - b.timestamp);
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
    p75FillSize: quantile(fillSizes, 0.75),
    p90FillSize: quantile(fillSizes, 0.9),
    p95FillSize: quantile(fillSizes, 0.95),
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
