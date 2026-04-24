import { mkdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { writeJson } from "../utils/fs.js";
import type { OutcomeSide } from "../infra/clob/types.js";
import type { XuanTrade } from "../infra/dataApi/xuanAnalyzer.js";
import {
  extractXuanTradesFromPayload,
  inferXuanWalletFromPayload,
  loadXuanDataset,
} from "../infra/dataApi/xuanAnalyzer.js";
import type { PaperSessionReport } from "./paperSession.js";

export type CanonicalPhase =
  | "ENTRY"
  | "OVERLAP"
  | "COMPLETION"
  | "HIGH_LOW_COMPLETION"
  | "MERGE"
  | "REDEEM";

export type QtyBucket = "1_5" | "6_10" | "11_15" | "16_30" | "31_plus";
export type NormalizedClipTier = "0_5x" | "1x" | "2x" | "3x" | "4x_plus";
export type TimingBucket = "none" | "0_10" | "10_30" | "30_90" | "90_plus";
export type ResidualBucket = "flat" | "dust" | "small" | "medium" | "large";
export type TradeAuthority = "json" | "json_verified_by_activity" | "paper";
export type LifecycleAuthority = "inferred" | "sqlite_activity" | "paper";

export interface CanonicalSequenceEvent {
  sequenceIndex: number;
  clipIndex: number | null;
  cycleId: number;
  phase: CanonicalPhase;
  kind: "BUY" | "MERGE" | "REDEEM";
  tOffsetSec: number;
  tOffsetMs: number;
  outcome: OutcomeSide | null;
  price: number | null;
  qty: number;
  qtyBucket: QtyBucket;
  baseLot: number;
  normalizedClipTier: NormalizedClipTier;
  familyLabel: CanonicalPhase;
  internalLabel: string;
  transactionHash?: string | undefined;
}

export interface CanonicalReferenceExtract {
  slug: string;
  startTs: number;
  endTs: number;
  orderedClipSequence: CanonicalSequenceEvent[];
  cycleCount: number;
  mergeCount: number;
  redeemCount: number;
  completionCount: number;
  overlapClipCount: number;
  hasOverlap: boolean;
  repairLatencyBucket: TimingBucket;
  mergeTimingBucket: TimingBucket;
  finalResidualSide: OutcomeSide | "FLAT";
  finalResidualBucket: ResidualBucket;
  clipBucketCounts: Record<QtyBucket, number>;
  normalizedClipTierCounts: Record<NormalizedClipTier, number>;
  buySequence: OutcomeSide[];
  alternatingTransitionCount: number;
  authority: {
    tradeTape: TradeAuthority;
    lifecycle: LifecycleAuthority;
    wallet?: string | undefined;
    verifiedBuyCount: number;
    totalBuyCount: number;
    mergeEventCount: number;
    redeemEventCount: number;
  };
}

export interface CanonicalReferenceBundle {
  generatedAt: string;
  slugs: string[];
  sources: {
    tradeTapeFile: string;
    lifecycleSqlitePath?: string | undefined;
    wallet?: string | undefined;
  };
  references: CanonicalReferenceExtract[];
}

interface ResidualLot {
  qty: number;
  price: number;
  timestamp: number;
}

interface BuyClip {
  outcome: OutcomeSide;
  price: number;
  qty: number;
  timestamp: number;
  baseLot?: number | undefined;
  internalLabel?: string | undefined;
  transactionHash?: string | undefined;
}

interface LifecycleEvent {
  type: "MERGE" | "REDEEM";
  timestamp: number;
  qty: number;
  transactionHash?: string | undefined;
}

interface ActivityTradeRecord {
  timestamp: number;
  outcome: OutcomeSide;
  price: number;
  qty: number;
  transactionHash?: string | undefined;
}

interface HybridLifecycleAuthority {
  wallet: string;
  tradeRecords: ActivityTradeRecord[];
  lifecycleEvents: LifecycleEvent[];
}

interface InferredCycle {
  id: number;
  startTs: number;
  baseLot: number;
  upResidualLots: ResidualLot[];
  downResidualLots: ResidualLot[];
  matchedPendingQty: number;
  residualOpenedAt?: number | undefined;
  firstMergeableAvailableAt?: number | undefined;
}

interface BuildCanonicalArgs {
  slug: string;
  buyClips: BuyClip[];
  lifecycleEvents?: LifecycleEvent[] | undefined;
  tradeAuthority: TradeAuthority;
  lifecycleAuthority: LifecycleAuthority;
  verifiedBuyCount: number;
  totalBuyCount: number;
  mergeEventCount: number;
  redeemEventCount: number;
  wallet?: string | undefined;
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

export function qtyBucket(qty: number): QtyBucket {
  if (qty <= 5) return "1_5";
  if (qty <= 10) return "6_10";
  if (qty <= 15) return "11_15";
  if (qty <= 30) return "16_30";
  return "31_plus";
}

export function normalizedClipTier(qty: number, baseLot: number): NormalizedClipTier {
  const anchor = Math.max(baseLot, 1e-9);
  const ratio = qty / anchor;
  if (ratio <= 0.75) return "0_5x";
  if (ratio <= 1.5) return "1x";
  if (ratio <= 2.5) return "2x";
  if (ratio <= 3.5) return "3x";
  return "4x_plus";
}

export function timingBucket(value: number | undefined): TimingBucket {
  if (value === undefined) return "none";
  if (value <= 10) return "0_10";
  if (value <= 30) return "10_30";
  if (value <= 90) return "30_90";
  return "90_plus";
}

export function residualBucket(qty: number): ResidualBucket {
  if (qty <= 0) return "flat";
  if (qty <= 0.5) return "dust";
  if (qty <= 5) return "small";
  if (qty <= 15) return "medium";
  return "large";
}

function parseMarketWindow(slug: string): { startTs: number; endTs: number } {
  const maybeStart = Number(slug.split("-").at(-1) ?? 0);
  const startTs = Number.isFinite(maybeStart) ? maybeStart : 0;
  return {
    startTs,
    endTs: startTs + 300,
  };
}

function sumLots(lots: ResidualLot[]): number {
  return normalize(lots.reduce((acc, lot) => acc + lot.qty, 0));
}

function averageLotPrice(lots: ResidualLot[]): number | undefined {
  const qty = lots.reduce((acc, lot) => acc + lot.qty, 0);
  if (qty <= 1e-9) return undefined;
  return lots.reduce((acc, lot) => acc + lot.qty * lot.price, 0) / qty;
}

function cycleGap(cycle: InferredCycle): number {
  return Math.abs(sumLots(cycle.upResidualLots) - sumLots(cycle.downResidualLots));
}

function cycleResidualSide(cycle: InferredCycle): OutcomeSide | "FLAT" {
  const up = sumLots(cycle.upResidualLots);
  const down = sumLots(cycle.downResidualLots);
  if (up <= 1e-9 && down <= 1e-9) return "FLAT";
  return up >= down ? "UP" : "DOWN";
}

function hasOpenExposure(cycle: InferredCycle): boolean {
  return cycle.matchedPendingQty > 1e-9 || sumLots(cycle.upResidualLots) > 1e-9 || sumLots(cycle.downResidualLots) > 1e-9;
}

function consumeLots(lots: ResidualLot[], qty: number): { consumedQty: number; averagePrice?: number | undefined } {
  let remaining = qty;
  let consumedQty = 0;
  let consumedCost = 0;
  while (remaining > 1e-9 && lots.length > 0) {
    const head = lots[0]!;
    const used = Math.min(remaining, head.qty);
    consumedQty += used;
    consumedCost += used * head.price;
    head.qty = normalize(head.qty - used);
    remaining = normalize(remaining - used);
    if (head.qty <= 1e-9) {
      lots.shift();
    }
  }
  return {
    consumedQty: normalize(consumedQty),
    averagePrice: consumedQty > 1e-9 ? consumedCost / consumedQty : undefined,
  };
}

function appendClipCount(counts: Record<QtyBucket, number>, qty: number): void {
  counts[qtyBucket(qty)] += 1;
}

function appendNormalizedClipCount(counts: Record<NormalizedClipTier, number>, qty: number, baseLot: number): void {
  counts[normalizedClipTier(qty, baseLot)] += 1;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function dominantResidualSideFromCycles(cycles: InferredCycle[]): OutcomeSide | "FLAT" {
  const totals = cycles.reduce(
    (acc, cycle) => {
      acc.up += sumLots(cycle.upResidualLots);
      acc.down += sumLots(cycle.downResidualLots);
      return acc;
    },
    { up: 0, down: 0 },
  );
  if (Math.abs(totals.up - totals.down) <= 1e-9) {
    return "FLAT";
  }
  return totals.up > totals.down ? "UP" : "DOWN";
}

function totalResidualQty(cycles: InferredCycle[]): number {
  const totals = cycles.reduce(
    (acc, cycle) => {
      acc.up += sumLots(cycle.upResidualLots);
      acc.down += sumLots(cycle.downResidualLots);
      return acc;
    },
    { up: 0, down: 0 },
  );
  return normalize(Math.abs(totals.up - totals.down));
}

export function classifyCompletionPhase(currentPrice: number, oppositeResidualAvgPrice: number | undefined): CanonicalPhase {
  if (oppositeResidualAvgPrice === undefined) {
    return "COMPLETION";
  }
  const high = Math.max(currentPrice, oppositeResidualAvgPrice);
  const low = Math.min(currentPrice, oppositeResidualAvgPrice);
  return high >= 0.75 && low <= 0.2 ? "HIGH_LOW_COMPLETION" : "COMPLETION";
}

function selectCompletionCycle(cycles: InferredCycle[], clip: BuyClip): {
  cycle: InferredCycle;
  oppositeResidualAvgPrice?: number | undefined;
} | undefined {
  let best:
    | {
        cycle: InferredCycle;
        improvement: number;
        oppositeResidualAvgPrice?: number | undefined;
      }
    | undefined;

  for (const cycle of cycles) {
    const oppositeLots = clip.outcome === "UP" ? cycle.downResidualLots : cycle.upResidualLots;
    const oppositeQty = sumLots(oppositeLots);
    if (oppositeQty <= 1e-9) {
      continue;
    }

    const oldGap = cycleGap(cycle);
    const newGap = Math.abs(oppositeQty - clip.qty);
    const improvement = oldGap - newGap;
    if (improvement <= 0) {
      continue;
    }

    const candidate = {
      cycle,
      improvement,
      oppositeResidualAvgPrice: averageLotPrice(oppositeLots),
    };

    if (
      !best ||
      candidate.improvement > best.improvement ||
      (Math.abs(candidate.improvement - best.improvement) <= 1e-9 && candidate.cycle.startTs < best.cycle.startTs)
    ) {
      best = candidate;
    }
  }

  if (!best) {
    return undefined;
  }

  return {
    cycle: best.cycle,
    oppositeResidualAvgPrice: best.oppositeResidualAvgPrice,
  };
}

function allocateMergeAcrossCycles(args: {
  cycles: InferredCycle[];
  qty: number;
  timestamp: number;
  startTs: number;
  sequenceIndex: number;
  mergeLatencies: number[];
  orderedClipSequence: CanonicalSequenceEvent[];
}): number {
  let sequenceIndex = args.sequenceIndex;
  let remaining = args.qty;
  const candidates = args.cycles
    .filter((cycle) => cycle.matchedPendingQty > 1e-9)
    .sort((left, right) => left.startTs - right.startTs || left.id - right.id);

  for (const cycle of candidates) {
    if (remaining <= 1e-9) break;
    const used = Math.min(remaining, cycle.matchedPendingQty);
    if (used <= 1e-9) continue;
    cycle.matchedPendingQty = normalize(cycle.matchedPendingQty - used);
    args.mergeLatencies.push(Math.max(0, args.timestamp - (cycle.firstMergeableAvailableAt ?? cycle.startTs)));
    args.orderedClipSequence.push({
      sequenceIndex: sequenceIndex++,
      clipIndex: null,
      cycleId: cycle.id,
      phase: "MERGE",
      kind: "MERGE",
      tOffsetSec: Math.max(0, args.timestamp - args.startTs),
      tOffsetMs: Math.max(0, args.timestamp - args.startTs) * 1000,
      outcome: null,
      price: null,
      qty: normalize(used),
      qtyBucket: qtyBucket(used),
      baseLot: cycle.baseLot,
      normalizedClipTier: normalizedClipTier(used, cycle.baseLot),
      familyLabel: "MERGE",
      internalLabel: "MERGE",
    });
    if (cycle.matchedPendingQty <= 1e-9) {
      cycle.firstMergeableAvailableAt = undefined;
    }
    remaining = normalize(remaining - used);
  }

  return sequenceIndex;
}

function allocateRedeemAcrossCycles(args: {
  cycles: InferredCycle[];
  qty: number;
  timestamp: number;
  startTs: number;
  sequenceIndex: number;
  orderedClipSequence: CanonicalSequenceEvent[];
}): number {
  let sequenceIndex = args.sequenceIndex;
  let remaining = args.qty;
  const globalResidualSide = dominantResidualSideFromCycles(args.cycles);
  const candidates = args.cycles
    .filter((cycle) => {
      if (globalResidualSide === "FLAT") {
        return sumLots(cycle.upResidualLots) > 1e-9 || sumLots(cycle.downResidualLots) > 1e-9;
      }
      return globalResidualSide === "UP"
        ? sumLots(cycle.upResidualLots) > 1e-9
        : sumLots(cycle.downResidualLots) > 1e-9;
    })
    .sort((left, right) => left.startTs - right.startTs || left.id - right.id);

  for (const cycle of candidates) {
    if (remaining <= 1e-9) break;
    const redeemSide = globalResidualSide === "FLAT" ? cycleResidualSide(cycle) : globalResidualSide;
    if (redeemSide === "FLAT") continue;
    const lots = redeemSide === "UP" ? cycle.upResidualLots : cycle.downResidualLots;
    const available = sumLots(lots);
    if (available <= 1e-9) continue;
    const used = Math.min(remaining, available);
    if (used <= 1e-9) continue;
    consumeLots(lots, used);
    args.orderedClipSequence.push({
      sequenceIndex: sequenceIndex++,
      clipIndex: null,
      cycleId: cycle.id,
      phase: "REDEEM",
      kind: "REDEEM",
      tOffsetSec: Math.max(0, args.timestamp - args.startTs),
      tOffsetMs: Math.max(0, args.timestamp - args.startTs) * 1000,
      outcome: redeemSide,
      price: null,
      qty: normalize(used),
      qtyBucket: qtyBucket(used),
      baseLot: cycle.baseLot,
      normalizedClipTier: normalizedClipTier(used, cycle.baseLot),
      familyLabel: "REDEEM",
      internalLabel: "REDEEM",
    });
    remaining = normalize(remaining - used);
  }

  return sequenceIndex;
}

function buildCanonicalFromInputs(args: BuildCanonicalArgs): CanonicalReferenceExtract {
  const { startTs, endTs } = parseMarketWindow(args.slug);
  const orderedClipSequence: CanonicalSequenceEvent[] = [];
  const clipBucketCounts: Record<QtyBucket, number> = {
    "1_5": 0,
    "6_10": 0,
    "11_15": 0,
    "16_30": 0,
    "31_plus": 0,
  };
  const normalizedClipTierCounts: Record<NormalizedClipTier, number> = {
    "0_5x": 0,
    "1x": 0,
    "2x": 0,
    "3x": 0,
    "4x_plus": 0,
  };
  const buySequence: OutcomeSide[] = [];
  const mergeLatencies: number[] = [];
  const repairLatencies: number[] = [];
  const activeCycles: InferredCycle[] = [];
  let cycleCount = 0;
  let clipIndex = 0;
  let sequenceIndex = 0;
  let completionCount = 0;
  let overlapClipCount = 0;
  let actualMergeCount = 0;
  let actualRedeemCount = 0;

  const sortedBuys = args.buyClips
    .map((clip, index) => ({ ...clip, sourceIndex: index }))
    .sort((left, right) => left.timestamp - right.timestamp || left.sourceIndex - right.sourceIndex);

  const sortedLifecycle = [...(args.lifecycleEvents ?? [])].sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.type.localeCompare(right.type);
  });

  let lifecycleIndex = 0;

  const flushLifecycleUntil = (timestamp: number): void => {
    while (lifecycleIndex < sortedLifecycle.length && sortedLifecycle[lifecycleIndex]!.timestamp <= timestamp) {
      const event = sortedLifecycle[lifecycleIndex]!;
      if (event.type === "MERGE") {
        actualMergeCount += 1;
        sequenceIndex = allocateMergeAcrossCycles({
          cycles: activeCycles,
          qty: event.qty,
          timestamp: event.timestamp,
          startTs,
          sequenceIndex,
          mergeLatencies,
          orderedClipSequence,
        });
      } else if (event.type === "REDEEM") {
        actualRedeemCount += 1;
        sequenceIndex = allocateRedeemAcrossCycles({
          cycles: activeCycles,
          qty: event.qty,
          timestamp: event.timestamp,
          startTs,
          sequenceIndex,
          orderedClipSequence,
        });
      }
      lifecycleIndex += 1;
    }
  };

  for (const clip of sortedBuys) {
    flushLifecycleUntil(clip.timestamp);
    const selectedCompletion = selectCompletionCycle(activeCycles, clip);
    const phase = selectedCompletion
      ? classifyCompletionPhase(clip.price, selectedCompletion.oppositeResidualAvgPrice)
      : activeCycles.some((cycle) => hasOpenExposure(cycle))
        ? "OVERLAP"
        : "ENTRY";

    let cycle: InferredCycle;
    if (selectedCompletion) {
      cycle = selectedCompletion.cycle;
      completionCount += 1;
      if (cycle.residualOpenedAt !== undefined) {
        repairLatencies.push(Math.max(0, clip.timestamp - cycle.residualOpenedAt));
      }
    } else {
      cycleCount += 1;
      cycle = {
        id: cycleCount,
        startTs: clip.timestamp,
        baseLot: clip.baseLot ?? clip.qty,
        upResidualLots: [],
        downResidualLots: [],
        matchedPendingQty: 0,
        residualOpenedAt: clip.timestamp,
        firstMergeableAvailableAt: undefined,
      };
      activeCycles.push(cycle);
      if (phase === "OVERLAP") {
        overlapClipCount += 1;
      }
    }

    const wasImbalanced = cycleGap(cycle) > 1e-9;
    const sameSideLots = clip.outcome === "UP" ? cycle.upResidualLots : cycle.downResidualLots;
    const oppositeLots = clip.outcome === "UP" ? cycle.downResidualLots : cycle.upResidualLots;
    const matchedBefore = cycle.matchedPendingQty;
    const { consumedQty } = consumeLots(oppositeLots, clip.qty);
    const residualQty = normalize(clip.qty - consumedQty);

    if (consumedQty > 1e-9) {
      cycle.matchedPendingQty = normalize(cycle.matchedPendingQty + consumedQty);
      if (matchedBefore <= 1e-9) {
        cycle.firstMergeableAvailableAt = clip.timestamp;
      }
    }
    if (residualQty > 1e-9) {
      sameSideLots.push({
        qty: residualQty,
        price: clip.price,
        timestamp: clip.timestamp,
      });
    }

    const stillImbalanced = cycleGap(cycle) > 1e-9;
    if (!wasImbalanced && stillImbalanced) {
      cycle.residualOpenedAt = clip.timestamp;
    } else if (!stillImbalanced) {
      cycle.residualOpenedAt = undefined;
    }

    clipIndex += 1;
    appendClipCount(clipBucketCounts, clip.qty);
    appendNormalizedClipCount(normalizedClipTierCounts, clip.qty, clip.baseLot ?? cycle.baseLot);
    buySequence.push(clip.outcome);
    orderedClipSequence.push({
      sequenceIndex: sequenceIndex++,
      clipIndex,
      cycleId: cycle.id,
      phase,
      kind: "BUY",
      tOffsetSec: Math.max(0, clip.timestamp - startTs),
      tOffsetMs: Math.max(0, clip.timestamp - startTs) * 1000,
      outcome: clip.outcome,
      price: clip.price,
      qty: normalize(clip.qty),
      qtyBucket: qtyBucket(clip.qty),
      baseLot: clip.baseLot ?? cycle.baseLot,
      normalizedClipTier: normalizedClipTier(clip.qty, clip.baseLot ?? cycle.baseLot),
      familyLabel: phase,
      internalLabel: clip.internalLabel ?? phase,
      transactionHash: clip.transactionHash,
    });

    if (args.lifecycleAuthority === "inferred" && cycle.matchedPendingQty > 1e-9) {
      actualMergeCount += 1;
      sequenceIndex = allocateMergeAcrossCycles({
        cycles: activeCycles,
        qty: cycle.matchedPendingQty,
        timestamp: clip.timestamp,
        startTs,
        sequenceIndex,
        mergeLatencies,
        orderedClipSequence,
      });
    }
  }

  flushLifecycleUntil(Number.MAX_SAFE_INTEGER);

  const alternatingTransitionCount = buySequence.reduce((acc, side, index) => {
    if (index === 0) return 0;
    return acc + (buySequence[index - 1] !== side ? 1 : 0);
  }, 0);
  const finalResidualSide = dominantResidualSideFromCycles(activeCycles);
  return {
    slug: args.slug,
    startTs,
    endTs,
    orderedClipSequence,
    cycleCount,
    mergeCount: actualMergeCount,
    redeemCount: actualRedeemCount,
    completionCount,
    overlapClipCount,
    hasOverlap: overlapClipCount > 0,
    repairLatencyBucket: timingBucket(median(repairLatencies)),
    mergeTimingBucket: timingBucket(median(mergeLatencies)),
    finalResidualSide,
    finalResidualBucket: residualBucket(totalResidualQty(activeCycles)),
    clipBucketCounts,
    normalizedClipTierCounts,
    buySequence,
    alternatingTransitionCount,
    authority: {
      tradeTape: args.tradeAuthority,
      lifecycle: args.lifecycleAuthority,
      wallet: args.wallet,
      verifiedBuyCount: args.verifiedBuyCount,
      totalBuyCount: args.totalBuyCount,
      mergeEventCount: args.mergeEventCount,
      redeemEventCount: args.redeemEventCount,
    },
  };
}

function toBuyClips(trades: XuanTrade[]): BuyClip[] {
  return trades
    .filter((trade) => trade.side === "BUY")
    .map((trade) => ({
      outcome: trade.outcome,
      price: trade.price,
      qty: trade.size,
      timestamp: trade.timestamp,
      transactionHash: trade.transactionHash,
    }));
}

function inferTradeVerification(
  trades: XuanTrade[],
  activityTrades: ActivityTradeRecord[],
): { verifiedTrades: XuanTrade[]; verifiedCount: number } {
  if (activityTrades.length === 0) {
    return {
      verifiedTrades: trades.filter((trade) => trade.side === "BUY"),
      verifiedCount: trades.filter((trade) => trade.side === "BUY").length,
    };
  }

  const byTxHash = new Set(
    activityTrades
      .map((trade) => trade.transactionHash)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  const verifiedTrades = trades.filter((trade) => {
    if (trade.side !== "BUY") return false;
    if (trade.transactionHash && byTxHash.has(trade.transactionHash)) {
      return true;
    }
    return activityTrades.some(
      (activity) =>
        activity.outcome === trade.outcome &&
        Math.abs(activity.timestamp - trade.timestamp) <= 2 &&
        Math.abs(activity.price - trade.price) <= 1e-6 &&
        Math.abs(activity.qty - trade.size) <= 1e-4,
    );
  });

  return {
    verifiedTrades: verifiedTrades.length > 0 ? verifiedTrades : trades.filter((trade) => trade.side === "BUY"),
    verifiedCount: verifiedTrades.length,
  };
}

function loadLifecycleAuthorityFromSqlite(args: {
  sqlitePath: string;
  wallet: string;
  slugs: string[];
}): Map<string, HybridLifecycleAuthority> {
  const db = new DatabaseSync(args.sqlitePath, { readOnly: true });
  try {
    const rows = db
      .prepare(`
        SELECT slug, type, timestamp, size, price, side, outcome, transaction_hash
        FROM activity_events
        WHERE wallet = ? AND slug IN (${args.slugs.map(() => "?").join(",")})
        ORDER BY timestamp ASC, id ASC
      `)
      .all(args.wallet, ...args.slugs) as Array<{
        slug: string;
        type: string;
        timestamp: number | null;
        size: number | null;
        price: number | null;
        side: string | null;
        outcome: string | null;
        transaction_hash: string | null;
      }>;

    const map = new Map<string, HybridLifecycleAuthority>();
    for (const slug of args.slugs) {
      map.set(slug, {
        wallet: args.wallet,
        tradeRecords: [],
        lifecycleEvents: [],
      });
    }

    for (const row of rows) {
      if (!row.slug || row.timestamp === null) continue;
      const bucket = map.get(row.slug);
      if (!bucket) continue;
      if (row.type === "TRADE" && row.side?.toUpperCase() === "BUY" && row.size !== null && row.price !== null) {
        const normalizedOutcome =
          row.outcome?.toLowerCase().includes("up")
            ? "UP"
            : row.outcome?.toLowerCase().includes("down")
              ? "DOWN"
              : undefined;
        if (!normalizedOutcome) continue;
        bucket.tradeRecords.push({
          timestamp: row.timestamp,
          outcome: normalizedOutcome,
          price: row.price,
          qty: row.size,
          transactionHash: row.transaction_hash ?? undefined,
        });
        continue;
      }

      if ((row.type === "MERGE" || row.type === "REDEEM") && row.size !== null) {
        bucket.lifecycleEvents.push({
          type: row.type,
          timestamp: row.timestamp,
          qty: row.size,
          transactionHash: row.transaction_hash ?? undefined,
        });
      }
    }

    return map;
  } finally {
    db.close();
  }
}

export function buildCanonicalReferenceFromTrades(args: {
  slug: string;
  trades: XuanTrade[];
}): CanonicalReferenceExtract {
  const buyTrades = args.trades.filter((trade) => trade.side === "BUY");
  return buildCanonicalFromInputs({
    slug: args.slug,
    buyClips: toBuyClips(buyTrades),
    tradeAuthority: "json",
    lifecycleAuthority: "inferred",
    verifiedBuyCount: buyTrades.length,
    totalBuyCount: buyTrades.length,
    mergeEventCount: 0,
    redeemEventCount: 0,
    wallet: buyTrades[0]?.wallet,
  });
}

export function buildCanonicalReferenceFromPaperSession(report: PaperSessionReport): CanonicalReferenceExtract {
  const buyClips: BuyClip[] = [];
  const lifecycleEvents: LifecycleEvent[] = [];
  for (const step of report.steps) {
    for (const fill of step.execution.fills) {
      if (fill.action !== "BUY") continue;
      buyClips.push({
        outcome: fill.side,
        price: fill.price,
        qty: fill.size,
        timestamp: step.timestamp,
      });
    }
    if (step.execution.mergeShares > 0) {
      lifecycleEvents.push({
        type: "MERGE",
        timestamp: step.timestamp,
        qty: step.execution.mergeShares,
      });
    }
    if (step.execution.redeemShares > 0) {
      lifecycleEvents.push({
        type: "REDEEM",
        timestamp: step.timestamp,
        qty: step.execution.redeemShares,
      });
    }
  }

  return buildCanonicalFromInputs({
    slug: report.market.slug,
    buyClips,
    lifecycleEvents,
    tradeAuthority: "paper",
    lifecycleAuthority: "paper",
    verifiedBuyCount: buyClips.length,
    totalBuyCount: buyClips.length,
    mergeEventCount: lifecycleEvents.filter((event) => event.type === "MERGE").length,
    redeemEventCount: lifecycleEvents.filter((event) => event.type === "REDEEM").length,
  });
}

export async function buildCanonicalReferenceBundle(args: {
  filePath: string;
  slugs: string[];
  sqlitePath?: string | undefined;
  wallet?: string | undefined;
}): Promise<CanonicalReferenceBundle> {
  const payload = await loadXuanDataset(args.filePath);
  const trades = extractXuanTradesFromPayload(payload).sort((a, b) => a.timestamp - b.timestamp);
  const wallet = args.wallet ?? inferXuanWalletFromPayload(payload);
  const lifecycleBySlug =
    args.sqlitePath && wallet
      ? loadLifecycleAuthorityFromSqlite({
          sqlitePath: args.sqlitePath,
          wallet,
          slugs: args.slugs,
        })
      : new Map<string, HybridLifecycleAuthority>();

  const references = args.slugs.map((slug) => {
    const slugTrades = trades.filter((trade) => trade.marketSlug === slug);
    const lifecycle = lifecycleBySlug.get(slug);
    const buyTrades = slugTrades.filter((trade) => trade.side === "BUY");
    if (!lifecycle) {
      return buildCanonicalFromInputs({
        slug,
        buyClips: toBuyClips(buyTrades),
        tradeAuthority: "json",
        lifecycleAuthority: "inferred",
        verifiedBuyCount: buyTrades.length,
        totalBuyCount: buyTrades.length,
        mergeEventCount: 0,
        redeemEventCount: 0,
        wallet,
      });
    }

    const verification = inferTradeVerification(buyTrades, lifecycle.tradeRecords);
    return buildCanonicalFromInputs({
      slug,
      buyClips: toBuyClips(verification.verifiedTrades),
      lifecycleEvents: lifecycle.lifecycleEvents,
      tradeAuthority: "json_verified_by_activity",
      lifecycleAuthority: "sqlite_activity",
      verifiedBuyCount: verification.verifiedCount,
      totalBuyCount: buyTrades.length,
      mergeEventCount: lifecycle.lifecycleEvents.filter((event) => event.type === "MERGE").length,
      redeemEventCount: lifecycle.lifecycleEvents.filter((event) => event.type === "REDEEM").length,
      wallet: lifecycle.wallet,
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    slugs: args.slugs,
    sources: {
      tradeTapeFile: args.filePath,
      lifecycleSqlitePath: args.sqlitePath,
      wallet,
    },
    references,
  };
}

export async function writeCanonicalReferenceBundle(
  bundle: CanonicalReferenceBundle,
  filePath = "reports/xuan_canonical_references.json",
): Promise<string> {
  await mkdir("reports", { recursive: true });
  await writeJson(filePath, bundle);
  return filePath;
}

export async function loadCanonicalReferenceBundleFile(filePath: string): Promise<CanonicalReferenceBundle> {
  return JSON.parse(await readFile(filePath, "utf8")) as CanonicalReferenceBundle;
}
