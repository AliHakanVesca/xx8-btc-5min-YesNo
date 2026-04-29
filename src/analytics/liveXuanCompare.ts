import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppEnv } from "../config/schema.js";
import { resolveLivePaperMarketSelection, runLivePaperSession, type LivePaperReport } from "./livePaper.js";
import { appendJsonl } from "../utils/fs.js";

export const XUAN_PUBLIC_WALLET = "0xcfb103c37c0234f524c632d964ed31f117b5f694";

export interface LiveXuanCompareOptions {
  runId?: string;
  targetScore?: number;
  confirmations?: number;
  maxIterations?: number;
  durationSec?: number;
  sampleMs?: number;
  initialBookWaitMs?: number;
  bookDepthLevels?: number;
  postClosePollSec?: number;
  xuanPollMs?: number;
  wallet?: string;
  outputDir?: string;
}

export interface ResolvedLiveXuanCompareOptions {
  targetScore: number;
  confirmations: number;
  maxIterations: number;
  durationSec: number;
  sampleMs: number;
  initialBookWaitMs: number;
  bookDepthLevels: number;
  postClosePollSec: number;
  xuanPollMs: number;
  wallet: string;
  outputDir: string;
}

export interface LiveXuanTimelineRow {
  actor: "xuan" | "ours";
  sec: number;
  timestamp: number;
  timeUtc: string;
  action: string;
  side: string;
  qty: number;
  requestedQty?: number | undefined;
  usdc: number;
  upQty: number;
  downQty: number;
  upAfter: number;
  downAfter: number;
  realizedPnl: number;
  cumPnl: number;
  price?: number | undefined;
  feeUsd?: number | undefined;
  pairAvg?: number | undefined;
  pairAsk?: number | undefined;
  upAsk?: number | undefined;
  downAsk?: number | undefined;
  note?: string | undefined;
}

export interface LiveXuanActorSummary {
  rowCount: number;
  buyCount: number;
  mergeCount: number;
  upBought: number;
  downBought: number;
  buyUsdc: number;
  realizedMergePnl: number;
  finalUpShares: number;
  finalDownShares: number;
  firstSec?: number | undefined;
  lastSec?: number | undefined;
}

export interface LiveXuanSimilarityScore {
  score: number;
  status: "PASS" | "WARN" | "FAIL";
  matchedRows: number;
  xuanRows: number;
  oursRows: number;
  actionSideScore: number;
  timingScore: number;
  quantityScore: number;
  notionalScore: number;
  mergeScore: number;
  pnlScore: number;
  gaps: string[];
}

export interface LiveXuanComparisonReport {
  runId: string;
  slug: string;
  marketStart: number;
  generatedAt: string;
  auditFile: string;
  xuanActivityFile: string;
  reportJson: string;
  reportMarkdown: string;
  summary: {
    xuan: LiveXuanActorSummary;
    ours: LiveXuanActorSummary;
  };
  similarity: LiveXuanSimilarityScore;
  paperSummary: LivePaperReport["summary"];
  rows: LiveXuanTimelineRow[];
}

export interface LiveXuanCompareIteration {
  iteration: number;
  paper: LivePaperReport;
  comparison: LiveXuanComparisonReport;
}

function normalize(value: number, decimals = 6): number {
  return Number(Math.max(0, value).toFixed(decimals));
}

function normalizeSigned(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

function utc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

function nowIsoCompact(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseJsonl(text: string): Record<string, any>[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch (error) {
        return { event: "json_parse_error", line: index + 1, error: String(error) };
      }
    });
}

async function readJsonl(path: string): Promise<Record<string, any>[]> {
  const text = await readFile(path, "utf8");
  return parseJsonl(text);
}

function bestAsk(side: any): number | undefined {
  const prices = (side?.asks ?? []).map((level: any) => Number(level.price)).filter(Number.isFinite);
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

function bestBid(side: any): number | undefined {
  const prices = (side?.bids ?? []).map((level: any) => Number(level.price)).filter(Number.isFinite);
  return prices.length > 0 ? Math.max(...prices) : undefined;
}

function bookBySecond(events: Record<string, any>[]): Map<number, { upAsk?: number; downAsk?: number; pairAsk?: number }> {
  const books = new Map<number, { upAsk?: number; downAsk?: number; pairAsk?: number }>();
  for (const event of events) {
    if (event.event !== "paper_live_tick" || typeof event.secsFromOpen !== "number") {
      continue;
    }
    const upAsk = bestAsk(event.books?.up);
    const downAsk = bestAsk(event.books?.down);
    const snapshot: { upAsk?: number; downAsk?: number; pairAsk?: number } = {};
    if (upAsk !== undefined) {
      snapshot.upAsk = upAsk;
    }
    if (downAsk !== undefined) {
      snapshot.downAsk = downAsk;
    }
    if (upAsk !== undefined && downAsk !== undefined) {
      snapshot.pairAsk = normalizeSigned(upAsk + downAsk, 6);
    }
    books.set(event.secsFromOpen, snapshot);
  }
  return books;
}

function nearestBook(
  books: Map<number, { upAsk?: number; downAsk?: number; pairAsk?: number }>,
  sec: number,
): { upAsk?: number; downAsk?: number; pairAsk?: number } {
  const exact = books.get(sec);
  if (exact) {
    return exact;
  }
  let best: { upAsk?: number; downAsk?: number; pairAsk?: number } = {};
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [bookSec, snapshot] of books.entries()) {
    const distance = Math.abs(bookSec - sec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = snapshot;
    }
  }
  return best;
}

function appendOptionalBookFields(
  row: LiveXuanTimelineRow,
  book: { upAsk?: number; downAsk?: number; pairAsk?: number },
): LiveXuanTimelineRow {
  return {
    ...row,
    ...(book.upAsk !== undefined ? { upAsk: book.upAsk } : {}),
    ...(book.downAsk !== undefined ? { downAsk: book.downAsk } : {}),
    ...(book.pairAsk !== undefined ? { pairAsk: book.pairAsk } : {}),
  };
}

function summarizeRows(rows: LiveXuanTimelineRow[], actor: "xuan" | "ours"): LiveXuanActorSummary {
  const actorRows = rows.filter((row) => row.actor === actor);
  const buyRows = actorRows.filter((row) => row.action === "BUY");
  const mergeRows = actorRows.filter((row) => row.action === "MERGE");
  const summary: LiveXuanActorSummary = {
    rowCount: actorRows.length,
    buyCount: buyRows.length,
    mergeCount: mergeRows.length,
    upBought: normalize(buyRows.reduce((acc, row) => acc + row.upQty, 0), 4),
    downBought: normalize(buyRows.reduce((acc, row) => acc + row.downQty, 0), 4),
    buyUsdc: normalize(buyRows.reduce((acc, row) => acc + row.usdc, 0), 4),
    realizedMergePnl: normalizeSigned(mergeRows.reduce((acc, row) => acc + row.realizedPnl, 0), 4),
    finalUpShares: normalize(actorRows.at(-1)?.upAfter ?? 0, 4),
    finalDownShares: normalize(actorRows.at(-1)?.downAfter ?? 0, 4),
  };
  if (actorRows[0]?.sec !== undefined) {
    summary.firstSec = actorRows[0]!.sec;
  }
  if (actorRows.at(-1)?.sec !== undefined) {
    summary.lastSec = actorRows.at(-1)!.sec;
  }
  return summary;
}

function groupTotals(rows: LiveXuanTimelineRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.action}:${row.side}`;
    totals.set(key, (totals.get(key) ?? 0) + row.qty);
  }
  return totals;
}

function ratioScore(left: number, right: number): number {
  if (left <= 1e-9 && right <= 1e-9) {
    return 100;
  }
  if (left <= 1e-9 || right <= 1e-9) {
    return 0;
  }
  return 100 * (Math.min(left, right) / Math.max(left, right));
}

function aggregateRatioScore(xuanRows: LiveXuanTimelineRow[], ourRows: LiveXuanTimelineRow[]): number {
  const xuanTotals = groupTotals(xuanRows);
  const ourTotals = groupTotals(ourRows);
  const keys = new Set([...xuanTotals.keys(), ...ourTotals.keys()]);
  if (keys.size === 0) {
    return 100;
  }
  return normalizeSigned(
    [...keys].reduce((acc, key) => acc + ratioScore(xuanTotals.get(key) ?? 0, ourTotals.get(key) ?? 0), 0) / keys.size,
    4,
  );
}

function notionalRatioScore(xuanRows: LiveXuanTimelineRow[], ourRows: LiveXuanTimelineRow[]): number {
  return ratioScore(
    xuanRows.reduce((acc, row) => acc + row.usdc, 0),
    ourRows.reduce((acc, row) => acc + row.usdc, 0),
  );
}

function pnlRatioScore(xuanRows: LiveXuanTimelineRow[], ourRows: LiveXuanTimelineRow[]): number {
  const xuanMergeRows = xuanRows.filter((row) => row.action === "MERGE");
  const ourMergeRows = ourRows.filter((row) => row.action === "MERGE");
  const xuanPnl = xuanMergeRows.reduce((acc, row) => acc + row.realizedPnl, 0);
  const ourPnl = ourMergeRows.reduce((acc, row) => acc + row.realizedPnl, 0);
  const rawScore = ratioScore(Math.max(0, xuanPnl), Math.max(0, ourPnl));
  const xuanMergeQty = xuanMergeRows.reduce((acc, row) => acc + row.qty, 0);
  const ourMergeQty = ourMergeRows.reduce((acc, row) => acc + row.qty, 0);
  const mergeQtyAligned = ratioScore(xuanMergeQty, ourMergeQty) >= 95;
  if (mergeQtyAligned && xuanMergeQty > 0 && ourMergeQty > 0) {
    const pnlPerShareDelta = Math.abs(xuanPnl / xuanMergeQty - ourPnl / ourMergeQty);
    if (pnlPerShareDelta <= 0.01 + 1e-9) {
      return Math.max(rawScore, 90);
    }
  }
  return rawScore;
}

export function scoreTradeBehaviorSimilarity(rows: LiveXuanTimelineRow[]): LiveXuanSimilarityScore {
  const xuanRows = rows.filter((row) => row.actor === "xuan" && (row.action === "BUY" || row.action === "MERGE"));
  const ourRows = rows.filter((row) => row.actor === "ours" && (row.action === "BUY" || row.action === "MERGE"));
  const timingParts: number[] = [];
  let matchedRows = 0;
  let searchFrom = 0;

  for (const xuan of xuanRows) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = searchFrom; index < ourRows.length; index += 1) {
      const ours = ourRows[index]!;
      if (ours.action !== xuan.action || ours.side !== xuan.side) {
        continue;
      }
      const distance = Math.abs(ours.sec - xuan.sec);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      searchFrom = bestIndex + 1;
      matchedRows += 1;
      const tolerance = xuan.action === "MERGE" ? 120 : 45;
      timingParts.push(Math.max(0, 100 * (1 - bestDistance / tolerance)));
    }
  }

  const actionSideScore =
    xuanRows.length === 0 && ourRows.length === 0 ? 100 : (100 * matchedRows) / Math.max(xuanRows.length, ourRows.length, 1);
  const timingScore =
    timingParts.length === 0 ? 0 : timingParts.reduce((acc, value) => acc + value, 0) / timingParts.length;
  const quantityScore = aggregateRatioScore(xuanRows, ourRows);
  const notionalScore = notionalRatioScore(
    xuanRows.filter((row) => row.action === "BUY"),
    ourRows.filter((row) => row.action === "BUY"),
  );
  const mergeScore = aggregateRatioScore(
    xuanRows.filter((row) => row.action === "MERGE"),
    ourRows.filter((row) => row.action === "MERGE"),
  );
  const pnlScore = pnlRatioScore(xuanRows, ourRows);
  const score = normalizeSigned(
    actionSideScore * 0.35 +
      timingScore * 0.2 +
      quantityScore * 0.2 +
      notionalScore * 0.1 +
      mergeScore * 0.1 +
      pnlScore * 0.05,
    2,
  );
  const gaps = [
    ...(actionSideScore < 90 ? ["action_side_sequence_mismatch"] : []),
    ...(timingScore < 90 ? ["timing_mismatch"] : []),
    ...(quantityScore < 90 ? ["quantity_exposure_mismatch"] : []),
    ...(notionalScore < 90 ? ["notional_scale_mismatch"] : []),
    ...(mergeScore < 90 ? ["merge_size_mismatch"] : []),
    ...(pnlScore < 90 ? ["merge_pnl_mismatch"] : []),
  ];

  return {
    score,
    status: score >= 95 && gaps.length === 0 ? "PASS" : score >= 75 ? "WARN" : "FAIL",
    matchedRows,
    xuanRows: xuanRows.length,
    oursRows: ourRows.length,
    actionSideScore: normalizeSigned(actionSideScore, 4),
    timingScore: normalizeSigned(timingScore, 4),
    quantityScore: normalizeSigned(quantityScore, 4),
    notionalScore: normalizeSigned(notionalScore, 4),
    mergeScore: normalizeSigned(mergeScore, 4),
    pnlScore: normalizeSigned(pnlScore, 4),
    gaps,
  };
}

export async function buildLiveXuanComparisonReport(args: {
  runId: string;
  slug: string;
  marketStart: number;
  auditFile: string;
  xuanActivityFile: string;
  reportBasePath: string;
  paperSummary: LivePaperReport["summary"];
}): Promise<LiveXuanComparisonReport> {
  const auditEvents = await readJsonl(args.auditFile);
  const xuanEvents = await readJsonl(args.xuanActivityFile);
  const books = bookBySecond(auditEvents);
  const rows: LiveXuanTimelineRow[] = [];

  let ourUpShares = 0;
  let ourDownShares = 0;
  let ourUpCost = 0;
  let ourDownCost = 0;
  let ourCumPnl = 0;

  for (const tick of auditEvents.filter((event) => event.event === "paper_live_tick")) {
    for (const execution of tick.executions ?? []) {
      if (execution.status !== "filled" && execution.status !== "partial") {
        continue;
      }
      const qty = Number(execution.filledShares ?? 0);
      const cost = Number(execution.effectiveNotional ?? Number(execution.rawNotional ?? 0) + Number(execution.feeUsd ?? 0));
      if (execution.outcome === "UP") {
        ourUpShares += qty;
        ourUpCost += cost;
      } else if (execution.outcome === "DOWN") {
        ourDownShares += qty;
        ourDownCost += cost;
      }
      const pairAvg =
        ourUpShares > 0 && ourDownShares > 0 ? ourUpCost / ourUpShares + ourDownCost / ourDownShares : undefined;
      const row: LiveXuanTimelineRow = {
        actor: "ours",
        sec: Number(tick.secsFromOpen ?? Number(execution.timestamp) - args.marketStart),
        timestamp: Number(execution.timestamp),
        timeUtc: utc(Number(execution.timestamp)),
        action: String(execution.tradeSide ?? "BUY"),
        side: String(execution.outcome ?? ""),
        qty: normalize(qty, 4),
        price: normalizeSigned(Number(execution.averagePrice ?? 0), 6),
        usdc: normalizeSigned(cost, 6),
        feeUsd: normalizeSigned(Number(execution.feeUsd ?? 0), 6),
        upQty: execution.outcome === "UP" ? normalize(qty, 4) : 0,
        downQty: execution.outcome === "DOWN" ? normalize(qty, 4) : 0,
        upAfter: normalize(ourUpShares, 4),
        downAfter: normalize(ourDownShares, 4),
        realizedPnl: 0,
        cumPnl: normalizeSigned(ourCumPnl, 6),
        ...(pairAvg !== undefined ? { pairAvg: normalizeSigned(pairAvg, 6) } : {}),
        ...(execution.mode !== undefined ? { note: String(execution.mode) } : {}),
      };
      rows.push(appendOptionalBookFields(row, nearestBook(books, row.sec)));
    }

    const merge = tick.merge;
    if (merge?.status === "merged" && Number(merge.mergedShares ?? 0) > 0) {
      const qty = Number(merge.mergedShares);
      const avgUp = ourUpShares > 0 ? ourUpCost / ourUpShares : 0;
      const avgDown = ourDownShares > 0 ? ourDownCost / ourDownShares : 0;
      const realizedPnl = Number(merge.realizedPnl ?? 0);
      ourCumPnl += realizedPnl;
      ourUpShares = Math.max(0, ourUpShares - qty);
      ourDownShares = Math.max(0, ourDownShares - qty);
      ourUpCost = Math.max(0, ourUpCost - avgUp * qty);
      ourDownCost = Math.max(0, ourDownCost - avgDown * qty);
      const row: LiveXuanTimelineRow = {
        actor: "ours",
        sec: Number(tick.secsFromOpen ?? Number(merge.timestamp) - args.marketStart),
        timestamp: Number(merge.timestamp),
        timeUtc: utc(Number(merge.timestamp)),
        action: "MERGE",
        side: "PAIR",
        qty: normalize(qty, 4),
        usdc: normalizeSigned(Number(merge.mergeReturn ?? qty), 6),
        upQty: normalize(qty, 4),
        downQty: normalize(qty, 4),
        upAfter: normalize(ourUpShares, 4),
        downAfter: normalize(ourDownShares, 4),
        pairAvg: normalizeSigned(avgUp + avgDown, 6),
        realizedPnl: normalizeSigned(realizedPnl, 6),
        cumPnl: normalizeSigned(ourCumPnl, 6),
        note: String(merge.reason ?? ""),
      };
      rows.push(appendOptionalBookFields(row, nearestBook(books, row.sec)));
    }
  }

  const uniqueXuanRows = new Map<string, any>();
  for (const event of xuanEvents) {
    for (const row of event.rows ?? []) {
      const key = `${row.transactionHash ?? ""}:${row.type}:${row.timestamp}:${row.outcome}:${row.size}`;
      uniqueXuanRows.set(key, row);
    }
  }

  let xuanUpShares = 0;
  let xuanDownShares = 0;
  let xuanUpCost = 0;
  let xuanDownCost = 0;
  let xuanCumPnl = 0;
  for (const row of [...uniqueXuanRows.values()].sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0))) {
    const timestamp = Number(row.timestamp ?? 0);
    const sec = timestamp - args.marketStart;
    if (row.type === "TRADE") {
      const side = String(row.outcome ?? "").toUpperCase().includes("UP")
        ? "UP"
        : String(row.outcome ?? "").toUpperCase().includes("DOWN")
          ? "DOWN"
          : String(row.outcome ?? "").toUpperCase();
      const qty = Number(row.size ?? 0);
      const usdc = Number(row.usdcSize ?? Number(row.price ?? 0) * qty);
      if (side === "UP") {
        xuanUpShares += qty;
        xuanUpCost += usdc;
      } else if (side === "DOWN") {
        xuanDownShares += qty;
        xuanDownCost += usdc;
      }
      const pairAvg =
        xuanUpShares > 0 && xuanDownShares > 0 ? xuanUpCost / xuanUpShares + xuanDownCost / xuanDownShares : undefined;
      const xuanRow: LiveXuanTimelineRow = {
        actor: "xuan",
        sec,
        timestamp,
        timeUtc: utc(timestamp),
        action: String(row.side ?? "BUY"),
        side,
        qty: normalize(qty, 4),
        price: normalizeSigned(Number(row.price ?? 0), 6),
        usdc: normalizeSigned(usdc, 6),
        upQty: side === "UP" ? normalize(qty, 4) : 0,
        downQty: side === "DOWN" ? normalize(qty, 4) : 0,
        upAfter: normalize(xuanUpShares, 4),
        downAfter: normalize(xuanDownShares, 4),
        realizedPnl: 0,
        cumPnl: normalizeSigned(xuanCumPnl, 6),
        ...(pairAvg !== undefined ? { pairAvg: normalizeSigned(pairAvg, 6) } : {}),
        ...(row.transactionHash !== undefined ? { note: String(row.transactionHash) } : {}),
      };
      rows.push(appendOptionalBookFields(xuanRow, nearestBook(books, sec)));
    } else if (row.type === "MERGE") {
      const requestedQty = Number(row.size ?? 0);
      const mergeQty = Math.min(requestedQty, xuanUpShares, xuanDownShares);
      const avgUp = xuanUpShares > 0 ? xuanUpCost / xuanUpShares : 0;
      const avgDown = xuanDownShares > 0 ? xuanDownCost / xuanDownShares : 0;
      const realizedPnl = mergeQty - mergeQty * (avgUp + avgDown);
      xuanCumPnl += realizedPnl;
      xuanUpShares = Math.max(0, xuanUpShares - mergeQty);
      xuanDownShares = Math.max(0, xuanDownShares - mergeQty);
      xuanUpCost = Math.max(0, xuanUpCost - avgUp * mergeQty);
      xuanDownCost = Math.max(0, xuanDownCost - avgDown * mergeQty);
      const xuanRow: LiveXuanTimelineRow = {
        actor: "xuan",
        sec,
        timestamp,
        timeUtc: utc(timestamp),
        action: "MERGE",
        side: "PAIR",
        qty: normalize(mergeQty, 4),
        requestedQty: normalize(requestedQty, 4),
        usdc: normalizeSigned(mergeQty, 6),
        upQty: normalize(mergeQty, 4),
        downQty: normalize(mergeQty, 4),
        upAfter: normalize(xuanUpShares, 4),
        downAfter: normalize(xuanDownShares, 4),
        pairAvg: normalizeSigned(avgUp + avgDown, 6),
        realizedPnl: normalizeSigned(realizedPnl, 6),
        cumPnl: normalizeSigned(xuanCumPnl, 6),
        note: [
          row.transactionHash !== undefined ? String(row.transactionHash) : undefined,
          mergeQty + 1e-9 < requestedQty ? `requested_merge_qty=${normalize(requestedQty, 4)}` : undefined,
        ].filter(Boolean).join(";"),
      };
      rows.push(appendOptionalBookFields(xuanRow, nearestBook(books, sec)));
    }
  }

  rows.sort((left, right) => left.sec - right.sec || left.actor.localeCompare(right.actor));
  const reportJson = `${args.reportBasePath}.json`;
  const reportMarkdown = `${args.reportBasePath}.md`;
  const report: LiveXuanComparisonReport = {
    runId: args.runId,
    slug: args.slug,
    marketStart: args.marketStart,
    generatedAt: new Date().toISOString(),
    auditFile: args.auditFile,
    xuanActivityFile: args.xuanActivityFile,
    reportJson,
    reportMarkdown,
    summary: {
      xuan: summarizeRows(rows, "xuan"),
      ours: summarizeRows(rows, "ours"),
    },
    similarity: scoreTradeBehaviorSimilarity(rows),
    paperSummary: args.paperSummary,
    rows,
  };

  await mkdir(dirname(reportJson), { recursive: true });
  await writeFile(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportMarkdown, renderLiveXuanMarkdown(report));
  return report;
}

function renderLiveXuanMarkdown(report: LiveXuanComparisonReport): string {
  const rows = report.rows
    .map(
      (row) =>
        `| ${row.sec} | ${row.actor} | ${row.action} | ${row.side} | ${row.qty.toFixed(2)} | ${
          row.price?.toFixed(4) ?? ""
        } | ${row.usdc.toFixed(4)} | ${row.upAfter.toFixed(2)} | ${row.downAfter.toFixed(2)} | ${
          row.pairAvg?.toFixed(4) ?? ""
        } | ${row.realizedPnl.toFixed(4)} | ${row.cumPnl.toFixed(4)} | ${row.pairAsk?.toFixed(4) ?? ""} | ${
          row.note?.slice(0, 18) ?? ""
        } |`,
    )
    .join("\n");
  return [
    `# Live Xuan Compare ${report.slug}`,
    "",
    `Similarity: ${report.similarity.score} (${report.similarity.status})`,
    `Gaps: ${report.similarity.gaps.join(", ") || "none"}`,
    "",
    "## Summary",
    "```json",
    JSON.stringify({ summary: report.summary, similarity: report.similarity }, null, 2),
    "```",
    "",
    "## Timeline",
    "| sec | actor | action | side | qty | price | usdc | upAfter | downAfter | pairAvg | realizedPnl | cumPnl | pairAsk | note |",
    "|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    rows,
    "",
  ].join("\n");
}

export async function pollXuanActivityForMarket(args: {
  baseUrl: string;
  slug: string;
  wallet: string;
  outputFile: string;
  deadlineMs: number;
  intervalMs: number;
  requestTimeoutMs?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const requestTimeoutMs = Math.max(1000, Math.floor(args.requestTimeoutMs ?? 5000));
  const maxPages = Math.max(1, Math.floor(args.maxPages ?? 5));
  const limit = 100;
  await appendJsonl(args.outputFile, {
    event: "xuan_activity_poll_started",
    slug: args.slug,
    wallet: args.wallet,
    startedAt: Math.floor(Date.now() / 1000),
  });
  let polls = 0;
  while (Date.now() < args.deadlineMs) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    try {
      const rows: any[] = [];
      let ok = true;
      let status = 200;
      let pageCount = 0;
      for (let page = 0; page < maxPages && Date.now() < args.deadlineMs; page += 1) {
        const url = new URL("/activity", args.baseUrl);
        url.searchParams.set("user", args.wallet);
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(page * limit));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetchImpl(url, {
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          status = response.status;
          ok = ok && response.ok;
          const payload = response.ok ? await response.json() : [];
          const pageRows = Array.isArray(payload) ? payload : [];
          rows.push(...pageRows.filter((row) => row?.slug === args.slug || row?.eventSlug === args.slug));
          pageCount += 1;
          if (pageRows.length < limit) {
            break;
          }
        } finally {
          clearTimeout(timer);
        }
      }
      await appendJsonl(args.outputFile, {
        event: "xuan_activity_poll",
        fetchedAt,
        slug: args.slug,
        wallet: args.wallet,
        ok,
        status,
        pages: pageCount,
        matchedCount: rows.length,
        rows,
      });
      polls += 1;
    } catch (error) {
      await appendJsonl(args.outputFile, {
        event: "xuan_activity_poll",
        fetchedAt,
        slug: args.slug,
        wallet: args.wallet,
        ok: false,
        error: String(error),
      });
    }
    const sleepMs = Math.max(0, Math.min(args.intervalMs, args.deadlineMs - Date.now()));
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
  await appendJsonl(args.outputFile, {
    event: "xuan_activity_poll_done",
    slug: args.slug,
    wallet: args.wallet,
    finishedAt: Math.floor(Date.now() / 1000),
    polls,
  });
}

export function resolveLiveXuanCompareOptions(options: LiveXuanCompareOptions = {}): ResolvedLiveXuanCompareOptions {
  return {
    targetScore: Math.max(0, Math.min(100, options.targetScore ?? 95)),
    confirmations: Math.max(1, Math.floor(options.confirmations ?? 2)),
    maxIterations: Math.max(0, Math.floor(options.maxIterations ?? 0)),
    durationSec: Math.max(60, Math.floor(options.durationSec ?? 305)),
    sampleMs: Math.max(500, Math.floor(options.sampleMs ?? 1000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
    bookDepthLevels: Math.max(1, Math.floor(options.bookDepthLevels ?? 20)),
    postClosePollSec: Math.max(30, Math.floor(options.postClosePollSec ?? 150)),
    xuanPollMs: Math.max(500, Math.floor(options.xuanPollMs ?? 1000)),
    wallet: options.wallet ?? XUAN_PUBLIC_WALLET,
    outputDir: options.outputDir ?? "logs/paper-live",
  };
}

export async function runLiveXuanCompareOnce(
  env: AppEnv,
  options: LiveXuanCompareOptions = {},
): Promise<LiveXuanCompareIteration> {
  const resolved = resolveLiveXuanCompareOptions(options);
  const marketOverride = await resolveLivePaperMarketSelection(env);
  const marketStart = marketOverride.market.startTs;
  const slug = marketOverride.market.slug;
  const runId = options.runId ?? nowIsoCompact();
  const basePath = `${resolved.outputDir}/xuan_loop_${runId}_${slug}`;
  const auditFile = `${basePath}.jsonl`;
  const xuanActivityFile = `${basePath}_xuan_activity.jsonl`;
  const reportBasePath = `reports/xuan_loop_${runId}_${slug}`;
  const deadlineMs = Math.max(Date.now() + 30_000, (marketStart + resolved.durationSec + resolved.postClosePollSec) * 1000);
  const poller = pollXuanActivityForMarket({
    baseUrl: env.POLY_DATA_API_BASE_URL,
    slug,
    wallet: resolved.wallet,
    outputFile: xuanActivityFile,
    deadlineMs,
    intervalMs: resolved.xuanPollMs,
  });
  const paper = await runLivePaperSession(env, {
    durationSec: resolved.durationSec,
    sampleMs: resolved.sampleMs,
    initialBookWaitMs: resolved.initialBookWaitMs,
    bookDepthLevels: resolved.bookDepthLevels,
    auditFile,
    marketOverride,
  });
  await poller;
  const comparison = await buildLiveXuanComparisonReport({
    runId,
    slug: paper.market.slug,
    marketStart: paper.market.startTs,
    auditFile,
    xuanActivityFile,
    reportBasePath,
    paperSummary: paper.summary,
  });
  return {
    iteration: 1,
    paper,
    comparison,
  };
}

export async function runLiveXuanCompareLoop(
  env: AppEnv,
  options: LiveXuanCompareOptions = {},
): Promise<LiveXuanCompareIteration[]> {
  const resolved = resolveLiveXuanCompareOptions(options);
  const results: LiveXuanCompareIteration[] = [];
  let consecutivePasses = 0;
  let iteration = 0;
  while (resolved.maxIterations === 0 || iteration < resolved.maxIterations) {
    iteration += 1;
    const result = await runLiveXuanCompareOnce(env, {
      ...resolved,
      runId: `${options.runId ?? nowIsoCompact()}-i${iteration}`,
    });
    result.iteration = iteration;
    results.push(result);
    const paperBlockers = result.paper.summary.xuanPassBlockers ?? [];
    const iterationPassed =
      result.comparison.similarity.score >= resolved.targetScore &&
      result.comparison.similarity.status === "PASS" &&
      result.paper.summary.xuanConformanceStatus === "PASS" &&
      paperBlockers.length === 0;
    if (iterationPassed) {
      consecutivePasses += 1;
    } else {
      consecutivePasses = 0;
    }
    if (consecutivePasses >= resolved.confirmations) {
      break;
    }
  }
  return results;
}
