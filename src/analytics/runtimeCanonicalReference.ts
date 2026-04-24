import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OutcomeSide } from "../infra/clob/types.js";
import { writeJson } from "../utils/fs.js";
import {
  classifyCompletionPhase,
  normalizedClipTier,
  qtyBucket,
  residualBucket,
  timingBucket,
  type CanonicalPhase,
  type CanonicalReferenceBundle,
  type CanonicalReferenceExtract,
  type CanonicalSequenceEvent,
  type NormalizedClipTier,
  type QtyBucket,
} from "./xuanCanonicalReference.js";
import type { HardFailCounts } from "./xuanReplayComparator.js";

const DEFAULT_RUNTIME_LOG_DIR = "logs";
const DEFAULT_REPAIR_MIN_QTY = 0.25;
const DEFAULT_MERGE_MIN_QTY = 1;
const DEFAULT_DUST_TOLERANCE_SHARES = 0.25;
const DEFAULT_GROUP_ASSIGNMENT_WINDOW_SEC = 10;

type RuntimeFamilyLabel = CanonicalPhase;

interface RuntimePairGroupRow {
  groupId: string;
  marketSlug: string;
  conditionId: string;
  intendedQty: number;
  selectedMode: string;
  createdAtSec: number;
  status: string;
  rawPair: number;
  effectivePair: number;
}

interface RuntimeLotRow {
  lotId: string;
  groupId?: string | undefined;
  rawGroupId?: string | undefined;
  marketSlug: string;
  conditionId: string;
  outcome: OutcomeSide;
  side: "BUY" | "SELL";
  qtyOriginal: number;
  price: number;
  timestampSec: number;
  executionMode?: string | undefined;
  source: string;
}

interface RuntimeMergeRedeemRow {
  marketSlug: string;
  action: "merge" | "redeem";
  amount: number;
  timestampSec: number;
  simulated: boolean;
  txHash?: string | undefined;
}

interface RuntimeMarketStateRow {
  marketSlug: string;
  mergeable: number;
  residualUp: number;
  residualDown: number;
}

interface ResidualLot {
  qty: number;
  price: number;
  timestampSec: number;
  cycleId: number;
}

interface RuntimeCycleState {
  id: number;
  key: string;
  groupId?: string | undefined;
  marketSlug: string;
  conditionId: string;
  startTs: number;
  baseLot: number;
  internalLabel: string;
  upLots: ResidualLot[];
  downLots: ResidualLot[];
  upBought: number;
  downBought: number;
  matchedPendingQty: number;
  residualOpenedAt?: number | undefined;
}

interface RuntimeMarketEvents {
  pairGroups: RuntimePairGroupRow[];
  buyLots: RuntimeLotRow[];
  mergeRedeemEvents: RuntimeMergeRedeemRow[];
  repairSizeZeroEvents: Array<{ timestampSec: number; shareGap: number }>;
  marketState?: RuntimeMarketStateRow | undefined;
  childOrderDispatch: RuntimeChildOrderDispatchDiagnostics;
}

interface RuntimeChildOrderDispatchDiagnostics {
  pairSubmitCount: number;
  sequentialPairSubmitCount: number;
  flowIntentPairSubmitCount: number;
  compressedPairSubmitCount: number;
  averageInterChildDelayMs: number | null;
  maxInterChildDelayMs: number | null;
}

export interface RuntimeCanonicalExtractBundle {
  generatedAt: string;
  slugs: string[];
  sources: {
    stateDbPath: string;
    logsDir: string;
  };
  references: CanonicalReferenceExtract[];
  hardFailsBySlug: Record<string, HardFailCounts>;
  diagnosticsBySlug: Record<
    string,
    {
      marketBaseLot: number;
      groupCount: number;
      grouplessBuyCount: number;
      buyCount: number;
      lifecycleEventCount: number;
      mergeableAtEnd: number;
      childOrderDispatch: RuntimeChildOrderDispatchDiagnostics;
      runtimeDataStatus: "runtime_fills_present" | "runtime_lifecycle_only" | "no_runtime_fills";
    }
  >;
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeTimestampSec(value: number): number {
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function sumLots(lots: ResidualLot[]): number {
  return normalize(lots.reduce((acc, lot) => acc + lot.qty, 0));
}

function averageLotPrice(lots: ResidualLot[]): number | undefined {
  const qty = lots.reduce((acc, lot) => acc + lot.qty, 0);
  if (qty <= 1e-9) {
    return undefined;
  }
  return lots.reduce((acc, lot) => acc + lot.qty * lot.price, 0) / qty;
}

function marketResidualTotals(cycles: RuntimeCycleState[]): { up: number; down: number } {
  return cycles.reduce(
    (acc, cycle) => {
      acc.up += sumLots(cycle.upLots);
      acc.down += sumLots(cycle.downLots);
      return acc;
    },
    { up: 0, down: 0 },
  );
}

function absoluteGap(cycles: RuntimeCycleState[]): number {
  const totals = marketResidualTotals(cycles);
  return normalize(Math.abs(totals.up - totals.down));
}

function dominantResidualSide(cycles: RuntimeCycleState[]): OutcomeSide | "FLAT" {
  const totals = marketResidualTotals(cycles);
  if (Math.abs(totals.up - totals.down) <= 1e-9) {
    return "FLAT";
  }
  return totals.up > totals.down ? "UP" : "DOWN";
}

function marketResidualMergeable(cycles: RuntimeCycleState[]): number {
  const totals = marketResidualTotals(cycles);
  return normalize(Math.min(totals.up, totals.down));
}

function marketReadyToMergeQty(cycles: RuntimeCycleState[]): number {
  const matchedPendingQty = cycles.reduce((acc, cycle) => acc + cycle.matchedPendingQty, 0);
  return normalize(matchedPendingQty + marketResidualMergeable(cycles));
}

function consumeResidualLots(lots: ResidualLot[], requestedQty: number): number {
  let remaining = normalize(requestedQty);
  let consumed = 0;
  while (remaining > 1e-9 && lots.length > 0) {
    const head = lots[0]!;
    const used = Math.min(remaining, head.qty);
    consumed += used;
    head.qty = normalize(head.qty - used);
    remaining = normalize(remaining - used);
    if (head.qty <= 1e-9) {
      lots.shift();
    }
  }
  return normalize(consumed);
}

function consumeGlobalLots(
  cycles: RuntimeCycleState[],
  outcome: OutcomeSide,
  requestedQty: number,
): Array<{ cycleId: number; qty: number }> {
  let remaining = normalize(requestedQty);
  const consumed: Array<{ cycleId: number; qty: number }> = [];
  const entries = cycles
    .flatMap((cycle) =>
      (outcome === "UP" ? cycle.upLots : cycle.downLots).map((lot) => ({
        cycle,
        lot,
      })),
    )
    .sort((left, right) => left.lot.timestampSec - right.lot.timestampSec || left.cycle.id - right.cycle.id);

  for (const entry of entries) {
    if (remaining <= 1e-9) {
      break;
    }
    const used = Math.min(remaining, entry.lot.qty);
    if (used <= 1e-9) {
      continue;
    }
    entry.lot.qty = normalize(entry.lot.qty - used);
    consumed.push({
      cycleId: entry.cycle.id,
      qty: normalize(used),
    });
    remaining = normalize(remaining - used);
  }

  for (const cycle of cycles) {
    cycle.upLots = cycle.upLots.filter((lot) => lot.qty > 1e-9);
    cycle.downLots = cycle.downLots.filter((lot) => lot.qty > 1e-9);
  }

  return consumed;
}

function consumeMatchedPendingQty(cycles: RuntimeCycleState[], requestedQty: number): Array<{ cycleId: number; qty: number }> {
  let remaining = normalize(requestedQty);
  const consumed: Array<{ cycleId: number; qty: number }> = [];
  const orderedCycles = [...cycles].sort((left, right) => left.startTs - right.startTs || left.id - right.id);

  for (const cycle of orderedCycles) {
    if (remaining <= 1e-9) {
      break;
    }
    const used = Math.min(remaining, cycle.matchedPendingQty);
    if (used <= 1e-9) {
      continue;
    }
    cycle.matchedPendingQty = normalize(cycle.matchedPendingQty - used);
    consumed.push({
      cycleId: cycle.id,
      qty: normalize(used),
    });
    remaining = normalize(remaining - used);
  }

  return consumed;
}

function currentCycleGap(cycle: RuntimeCycleState): number {
  return normalize(Math.abs(sumLots(cycle.upLots) - sumLots(cycle.downLots)));
}

function activeOtherCycleExists(cycles: RuntimeCycleState[], currentCycleId: number): boolean {
  return cycles.some(
    (cycle) =>
      cycle.id !== currentCycleId && (sumLots(cycle.upLots) > 1e-9 || sumLots(cycle.downLots) > 1e-9),
  );
}

async function readJsonlRecords(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function buildEmptyHardFails(): HardFailCounts {
  return {
    overshoot: 0,
    sameSideAmplification: 0,
    completionQtyExceedsMissing: 0,
    grouplessBotFill: 0,
    repairSizeZeroWithGap: 0,
    mergeMissWithValidQty: 0,
  };
}

function loadRuntimeData(stateDbPath: string): {
  pairGroups: RuntimePairGroupRow[];
  lots: RuntimeLotRow[];
  mergeRedeemEvents: RuntimeMergeRedeemRow[];
  marketStates: RuntimeMarketStateRow[];
} {
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const pairGroups = db
      .prepare(`
        SELECT group_id, market_slug, condition_id, intended_qty, selected_mode, created_at, status, raw_pair, effective_pair
        FROM pair_groups
        ORDER BY created_at ASC, group_id ASC
      `)
      .all() as Array<{
      group_id: string;
      market_slug: string;
      condition_id: string;
      intended_qty: number;
      selected_mode: string;
      created_at: number;
      status: string;
      raw_pair: number;
      effective_pair: number;
    }>;

    const lots = db
      .prepare(`
        SELECT lot_id, group_id, market_slug, condition_id, outcome, side, qty_original, price, timestamp, execution_mode, source
        FROM inventory_lots
        WHERE side = 'BUY'
        ORDER BY timestamp ASC, lot_id ASC
      `)
      .all() as Array<{
      lot_id: string;
      group_id: string | null;
      market_slug: string;
      condition_id: string;
      outcome: OutcomeSide;
      side: "BUY" | "SELL";
      qty_original: number;
      price: number;
      timestamp: number;
      execution_mode: string | null;
      source: string;
    }>;

    const mergeRedeemEvents = db
      .prepare(`
        SELECT market_slug, action, amount, timestamp, simulated, tx_hash
        FROM merge_redeem_events
        ORDER BY timestamp ASC, event_id ASC
      `)
      .all() as Array<{
      market_slug: string;
      action: "merge" | "redeem";
      amount: number | null;
      timestamp: number;
      simulated: number;
      tx_hash: string | null;
    }>;

    const marketStates = db
      .prepare(`
        SELECT market_slug, mergeable, residual_up, residual_down
        FROM market_state
      `)
      .all() as Array<{
      market_slug: string;
      mergeable: number;
      residual_up: number;
      residual_down: number;
    }>;

    return {
      pairGroups: pairGroups.map((row) => ({
        groupId: row.group_id,
        marketSlug: row.market_slug,
        conditionId: row.condition_id,
        intendedQty: row.intended_qty,
        selectedMode: row.selected_mode,
        createdAtSec: normalizeTimestampSec(row.created_at),
        status: row.status,
        rawPair: row.raw_pair,
        effectivePair: row.effective_pair,
      })),
      lots: lots.map((row) => ({
        lotId: row.lot_id,
        groupId: row.group_id ?? undefined,
        rawGroupId: row.group_id ?? undefined,
        marketSlug: row.market_slug,
        conditionId: row.condition_id,
        outcome: row.outcome,
        side: row.side,
        qtyOriginal: row.qty_original,
        price: row.price,
        timestampSec: normalizeTimestampSec(row.timestamp),
        executionMode: row.execution_mode ?? undefined,
        source: row.source,
      })),
      mergeRedeemEvents: mergeRedeemEvents.map((row) => ({
        marketSlug: row.market_slug,
        action: row.action,
        amount: row.amount ?? 0,
        timestampSec: normalizeTimestampSec(row.timestamp),
        simulated: Boolean(row.simulated),
        txHash: row.tx_hash ?? undefined,
      })),
      marketStates: marketStates.map((row) => ({
        marketSlug: row.market_slug,
        mergeable: row.mergeable,
        residualUp: row.residual_up,
        residualDown: row.residual_down,
      })),
    };
  } finally {
    db.close();
  }
}

function mergeRepairEvents(
  decisionTrace: Record<string, unknown>[],
  riskEvents: Record<string, unknown>[],
  repairMinQty: number,
): Map<string, Array<{ timestampSec: number; shareGap: number }>> {
  const events = new Map<string, Array<{ timestampSec: number; shareGap: number }>>();

  for (const record of decisionTrace) {
    const marketSlug = typeof record.marketSlug === "string" ? record.marketSlug : undefined;
    const skipReason = typeof record.entrySkipReason === "string" ? record.entrySkipReason : undefined;
    const shareGap = typeof record.shareGap === "number" ? record.shareGap : undefined;
    const ts = typeof record.ts === "number" ? normalizeTimestampSec(record.ts) : undefined;
    if (!marketSlug || skipReason !== "repair_size_zero" || shareGap === undefined || ts === undefined || shareGap <= repairMinQty) {
      continue;
    }
    const bucket = events.get(marketSlug) ?? [];
    bucket.push({ timestampSec: ts, shareGap });
    events.set(marketSlug, bucket);
  }

  for (const record of riskEvents) {
    const marketSlug = typeof record.marketSlug === "string" ? record.marketSlug : undefined;
    const reason = typeof record.reason === "string" ? record.reason : undefined;
    const ts = typeof record.ts === "number" ? normalizeTimestampSec(record.ts) : undefined;
    if (!marketSlug || reason !== "repair_size_zero" || ts === undefined) {
      continue;
    }
    const bucket = events.get(marketSlug) ?? [];
    if (!bucket.some((item) => item.timestampSec === ts)) {
      bucket.push({ timestampSec: ts, shareGap: repairMinQty + 1 });
      events.set(marketSlug, bucket);
    }
  }

  return events;
}

function buildChildOrderDispatchDiagnostics(
  ordersTrace: Record<string, unknown>[],
  marketSlug: string,
): RuntimeChildOrderDispatchDiagnostics {
  const pairSubmits = ordersTrace.filter(
    (record) =>
      record.marketSlug === marketSlug &&
      record.eventType === "pair_orders_submit",
  );
  const delays = pairSubmits
    .map((record) => record.interChildDelayMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const averageDelay =
    delays.length > 0
      ? normalize(delays.reduce((sum, value) => sum + value, 0) / delays.length)
      : null;
  const maxDelay = delays.length > 0 ? Math.max(...delays) : null;

  return {
    pairSubmitCount: pairSubmits.length,
    sequentialPairSubmitCount: pairSubmits.filter((record) => record.sequentialPairExecution === true).length,
    flowIntentPairSubmitCount: pairSubmits.filter(
      (record) =>
        record.childOrderReason === "flow_intent" ||
        record.childOrderMicroTimingBias === "flow_intent",
    ).length,
    compressedPairSubmitCount: pairSubmits.filter(
      (record) =>
        typeof record.interChildDelayMs === "number" &&
        Number.isFinite(record.interChildDelayMs) &&
        record.interChildDelayMs <= 40,
    ).length,
    averageInterChildDelayMs: averageDelay,
    maxInterChildDelayMs: maxDelay,
  };
}

function assignGroupToLot(
  lot: RuntimeLotRow,
  pairGroups: RuntimePairGroupRow[],
  assignmentWindowSec: number,
): string | undefined {
  if (lot.groupId) {
    return lot.groupId;
  }

  const candidates = pairGroups
    .filter(
      (group) =>
        group.createdAtSec <= lot.timestampSec &&
        lot.timestampSec - group.createdAtSec <= assignmentWindowSec,
    )
    .sort((left, right) => right.createdAtSec - left.createdAtSec);

  return candidates[0]?.groupId;
}

function buildMarketEvents(args: {
  marketSlug: string;
  pairGroups: RuntimePairGroupRow[];
  lots: RuntimeLotRow[];
  mergeRedeemEvents: RuntimeMergeRedeemRow[];
  marketState?: RuntimeMarketStateRow | undefined;
  repairEvents: Map<string, Array<{ timestampSec: number; shareGap: number }>>;
  childOrderDispatch: RuntimeChildOrderDispatchDiagnostics;
}): RuntimeMarketEvents {
  const marketPairGroups = args.pairGroups
    .filter((group) => group.marketSlug === args.marketSlug)
    .sort((left, right) => left.createdAtSec - right.createdAtSec || left.groupId.localeCompare(right.groupId));
  const marketLots = args.lots
    .filter((lot) => lot.marketSlug === args.marketSlug)
    .map((lot) => ({
      ...lot,
      groupId: assignGroupToLot(lot, marketPairGroups, DEFAULT_GROUP_ASSIGNMENT_WINDOW_SEC),
    }))
    .sort((left, right) => left.timestampSec - right.timestampSec || left.lotId.localeCompare(right.lotId));
  const marketMergeRedeemEvents = args.mergeRedeemEvents
    .filter((event) => event.marketSlug === args.marketSlug)
    .sort((left, right) => left.timestampSec - right.timestampSec);

  return {
    pairGroups: marketPairGroups,
    buyLots: marketLots,
    mergeRedeemEvents: marketMergeRedeemEvents,
    repairSizeZeroEvents: args.repairEvents.get(args.marketSlug) ?? [],
    marketState: args.marketState,
    childOrderDispatch: args.childOrderDispatch,
  };
}

function createOrderedBuyEvent(args: {
  sequenceIndex: number;
  clipIndex: number;
  cycleId: number;
  phase: RuntimeFamilyLabel;
  marketStartTs: number;
  lot: RuntimeLotRow;
  baseLot: number;
  internalLabel: string;
}): CanonicalSequenceEvent {
  return {
    sequenceIndex: args.sequenceIndex,
    clipIndex: args.clipIndex,
    cycleId: args.cycleId,
    phase: args.phase,
    kind: "BUY",
    tOffsetSec: Math.max(0, args.lot.timestampSec - args.marketStartTs),
    tOffsetMs: Math.max(0, args.lot.timestampSec - args.marketStartTs) * 1000,
    outcome: args.lot.outcome,
    price: args.lot.price,
    qty: normalize(args.lot.qtyOriginal),
    qtyBucket: qtyBucket(args.lot.qtyOriginal),
    baseLot: args.baseLot,
    normalizedClipTier: normalizedClipTier(args.lot.qtyOriginal, args.baseLot),
    familyLabel: args.phase,
    internalLabel: args.internalLabel,
  };
}

function buildRuntimeReferenceForMarket(args: {
  marketSlug: string;
  marketEvents: RuntimeMarketEvents;
  repairMinQty: number;
  mergeMinQty: number;
  dustToleranceShares: number;
}): {
  reference: CanonicalReferenceExtract;
  hardFails: HardFailCounts;
  diagnostics: {
    marketBaseLot: number;
    groupCount: number;
    grouplessBuyCount: number;
    buyCount: number;
    lifecycleEventCount: number;
    mergeableAtEnd: number;
    childOrderDispatch: RuntimeChildOrderDispatchDiagnostics;
    runtimeDataStatus: "runtime_fills_present" | "runtime_lifecycle_only" | "no_runtime_fills";
  };
} {
  const maybeStart = Number(args.marketSlug.split("-").at(-1) ?? 0);
  const startTs = Number.isFinite(maybeStart) ? maybeStart : 0;
  const endTs = startTs + 300;
  const pairGroups = args.marketEvents.pairGroups;
  const buyLots = args.marketEvents.buyLots;
  const lifecycleEvents = args.marketEvents.mergeRedeemEvents;
  const hardFails = buildEmptyHardFails();
  hardFails.grouplessBotFill = buyLots.filter((lot) => !lot.rawGroupId).length;
  hardFails.repairSizeZeroWithGap = args.marketEvents.repairSizeZeroEvents.length;

  const baseLot =
    pairGroups.find((group) => group.intendedQty > 0)?.intendedQty ??
    buyLots[0]?.qtyOriginal ??
    1;
  const cycleOrder = new Map<string, number>();
  const cycleByKey = new Map<string, RuntimeCycleState>();
  const orderedClipSequence: CanonicalSequenceEvent[] = [];
  const buySequence: OutcomeSide[] = [];
  const repairLatencies: number[] = [];
  const mergeLatencies: number[] = [];
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

  let nextPseudoCycleId = pairGroups.length + 1;
  let sequenceIndex = 0;
  let clipIndex = 0;
  let overlapClipCount = 0;
  let completionCount = 0;
  let mergeCount = 0;
  let redeemCount = 0;
  let firstMergeableAvailableAt: number | undefined;

  const pairGroupMeta = new Map(pairGroups.map((group) => [group.groupId, group]));

  const ensureCycle = (lot: RuntimeLotRow): RuntimeCycleState => {
    const cycleKey = lot.groupId ?? `ungrouped:${lot.lotId}`;
    const existing = cycleByKey.get(cycleKey);
    if (existing) {
      return existing;
    }
    const group = lot.groupId ? pairGroupMeta.get(lot.groupId) : undefined;
    const createdCycleId = group
      ? (cycleOrder.get(group.groupId) ??
          (() => {
            const id = cycleOrder.size + 1;
            cycleOrder.set(group.groupId, id);
            return id;
          })())
      : nextPseudoCycleId++;
    const cycle: RuntimeCycleState = {
      id: createdCycleId,
      key: cycleKey,
      groupId: group?.groupId,
      marketSlug: lot.marketSlug,
      conditionId: lot.conditionId,
      startTs: group?.createdAtSec ?? lot.timestampSec,
      baseLot: group?.intendedQty ?? baseLot,
      internalLabel: group?.selectedMode ?? lot.executionMode ?? "UNGROUPED_BUY",
      upLots: [],
      downLots: [],
      upBought: 0,
      downBought: 0,
      matchedPendingQty: 0,
      residualOpenedAt: undefined,
    };
    cycleByKey.set(cycleKey, cycle);
    return cycle;
  };

  const allEvents = [
    ...buyLots.map((lot) => ({ type: "BUY" as const, timestampSec: lot.timestampSec, lot })),
    ...lifecycleEvents.map((event) => ({ type: event.action === "merge" ? ("MERGE" as const) : ("REDEEM" as const), timestampSec: event.timestampSec, event })),
  ].sort((left, right) => left.timestampSec - right.timestampSec);

  for (const item of allEvents) {
    const cycles = [...cycleByKey.values()].sort((left, right) => left.id - right.id);

    if (item.type === "BUY") {
      const lot = item.lot;
      const cycle = ensureCycle(lot);
      const beforeMarketGap = absoluteGap(cycles);
      const cycleOppositeLots = lot.outcome === "UP" ? cycle.downLots : cycle.upLots;
      const cycleSameLots = lot.outcome === "UP" ? cycle.upLots : cycle.downLots;
      const cycleMissingQty = sumLots(cycleOppositeLots);
      const oppositeAvgPrice = averageLotPrice(cycleOppositeLots);
      const firstFillForCycle = cycle.upBought + cycle.downBought <= 1e-9;
      const phase: RuntimeFamilyLabel =
        cycleMissingQty > 1e-9
          ? classifyCompletionPhase(lot.price, oppositeAvgPrice)
          : activeOtherCycleExists(cycles, cycle.id)
            ? "OVERLAP"
            : "ENTRY";

      const consumedQty = consumeResidualLots(cycleOppositeLots, lot.qtyOriginal);
      const residualQty = normalize(lot.qtyOriginal - consumedQty);
      if (residualQty > 1e-9) {
        cycleSameLots.push({
          qty: residualQty,
          price: lot.price,
          timestampSec: lot.timestampSec,
          cycleId: cycle.id,
        });
      }
      if (lot.outcome === "UP") {
        cycle.upBought = normalize(cycle.upBought + lot.qtyOriginal);
      } else {
        cycle.downBought = normalize(cycle.downBought + lot.qtyOriginal);
      }
      if (consumedQty > 1e-9) {
        cycle.matchedPendingQty = normalize(cycle.matchedPendingQty + consumedQty);
      }

      if (cycleMissingQty > 1e-9) {
        completionCount += 1;
        if (cycle.residualOpenedAt !== undefined && consumedQty > 1e-9 && repairLatencies.length === 0) {
          repairLatencies.push(Math.max(0, lot.timestampSec - cycle.residualOpenedAt));
        } else if (cycle.residualOpenedAt !== undefined && consumedQty > 1e-9) {
          repairLatencies.push(Math.max(0, lot.timestampSec - cycle.residualOpenedAt));
        }
        if (lot.qtyOriginal > cycleMissingQty + args.dustToleranceShares) {
          hardFails.completionQtyExceedsMissing += 1;
        }
      } else if (phase === "OVERLAP") {
        overlapClipCount += 1;
      }

      const cycleGapAfter = currentCycleGap(cycle);
      if (cycleGapAfter > 1e-9 && cycle.residualOpenedAt === undefined) {
        cycle.residualOpenedAt = lot.timestampSec;
      } else if (cycleGapAfter <= 1e-9) {
        cycle.residualOpenedAt = undefined;
      }

      const afterCycles = [...cycleByKey.values()].sort((left, right) => left.id - right.id);
      const afterMarketGap = absoluteGap(afterCycles);
      if (beforeMarketGap > args.dustToleranceShares && afterMarketGap > beforeMarketGap + args.dustToleranceShares) {
        hardFails.sameSideAmplification += 1;
      }

      if (cycleMissingQty > 1e-9) {
        const afterDominant = dominantResidualSide([cycle]);
        const beforeDominant =
          lot.outcome === "UP"
            ? cycleMissingQty > 0
              ? "DOWN"
              : "FLAT"
            : cycleMissingQty > 0
              ? "UP"
              : "FLAT";
        if (beforeDominant !== "FLAT" && afterDominant === lot.outcome && cycleGapAfter > args.dustToleranceShares) {
          hardFails.overshoot += 1;
        }
      }

      const previousMergeable = marketReadyToMergeQty(cycles);
      const currentMergeable = marketReadyToMergeQty(afterCycles);
      if (previousMergeable < args.mergeMinQty && currentMergeable >= args.mergeMinQty && firstMergeableAvailableAt === undefined) {
        firstMergeableAvailableAt = lot.timestampSec;
      }

      clipIndex += 1;
      clipBucketCounts[qtyBucket(lot.qtyOriginal)] += 1;
      normalizedClipTierCounts[normalizedClipTier(lot.qtyOriginal, cycle.baseLot)] += 1;
      buySequence.push(lot.outcome);
      orderedClipSequence.push(
        createOrderedBuyEvent({
          sequenceIndex: sequenceIndex++,
          clipIndex,
          cycleId: cycle.id,
          phase,
          marketStartTs: startTs,
          lot,
          baseLot: cycle.baseLot,
          internalLabel: cycle.internalLabel,
        }),
      );
      continue;
    }

    if (item.type === "MERGE") {
      const mergeAmount = normalize(item.event.amount);
      if (mergeAmount <= 1e-9) {
        continue;
      }
      const cyclesBeforeMerge = [...cycleByKey.values()].sort((left, right) => left.id - right.id);
      const available = marketReadyToMergeQty(cyclesBeforeMerge);
      if (available <= 1e-9) {
        continue;
      }
      const used = Math.min(mergeAmount, available);
      const cyclesForMerge = [...cycleByKey.values()];
      const consumedMatched = consumeMatchedPendingQty(cyclesForMerge, used);
      const matchedConsumedQty = normalize(consumedMatched.reduce((acc, entry) => acc + entry.qty, 0));
      const residualMergeQty = normalize(used - matchedConsumedQty);
      const consumedUp = residualMergeQty > 1e-9 ? consumeGlobalLots(cyclesForMerge, "UP", residualMergeQty) : consumedMatched;
      const consumedDown =
        residualMergeQty > 1e-9 ? consumeGlobalLots(cyclesForMerge, "DOWN", residualMergeQty) : consumedMatched;
      mergeCount += 1;
      if (firstMergeableAvailableAt !== undefined) {
        mergeLatencies.push(Math.max(0, item.event.timestampSec - firstMergeableAvailableAt));
      }
      const dominantCycleId = consumedUp[0]?.cycleId ?? consumedDown[0]?.cycleId ?? 0;
      orderedClipSequence.push({
        sequenceIndex: sequenceIndex++,
        clipIndex: null,
        cycleId: dominantCycleId,
        phase: "MERGE",
        kind: "MERGE",
        tOffsetSec: Math.max(0, item.event.timestampSec - startTs),
        tOffsetMs: Math.max(0, item.event.timestampSec - startTs) * 1000,
        outcome: null,
        price: null,
        qty: normalize(used),
        qtyBucket: qtyBucket(used),
        baseLot,
        normalizedClipTier: normalizedClipTier(used, baseLot),
        familyLabel: "MERGE",
        internalLabel: "MERGE",
        transactionHash: item.event.txHash,
      });
      if (marketReadyToMergeQty([...cycleByKey.values()]) < args.mergeMinQty) {
        firstMergeableAvailableAt = undefined;
      }
      continue;
    }

    if (item.type === "REDEEM") {
      const redeemAmount = normalize(item.event.amount);
      if (redeemAmount <= 1e-9) {
        continue;
      }
      const side = dominantResidualSide([...cycleByKey.values()]);
      if (side === "FLAT") {
        continue;
      }
      const consumed = consumeGlobalLots([...cycleByKey.values()], side, redeemAmount);
      redeemCount += 1;
      orderedClipSequence.push({
        sequenceIndex: sequenceIndex++,
        clipIndex: null,
        cycleId: consumed[0]?.cycleId ?? 0,
        phase: "REDEEM",
        kind: "REDEEM",
        tOffsetSec: Math.max(0, item.event.timestampSec - startTs),
        tOffsetMs: Math.max(0, item.event.timestampSec - startTs) * 1000,
        outcome: side,
        price: null,
        qty: redeemAmount,
        qtyBucket: qtyBucket(redeemAmount),
        baseLot,
        normalizedClipTier: normalizedClipTier(redeemAmount, baseLot),
        familyLabel: "REDEEM",
        internalLabel: "REDEEM",
        transactionHash: item.event.txHash,
      });
    }
  }

  const cycles = [...cycleByKey.values()].sort((left, right) => left.id - right.id);
  const finalMergeable = args.marketEvents.marketState?.mergeable ?? marketReadyToMergeQty(cycles);
  if (finalMergeable >= args.mergeMinQty && mergeCount === 0) {
    hardFails.mergeMissWithValidQty += 1;
  }

  const alternatingTransitionCount = buySequence.reduce((acc, side, index) => {
    if (index === 0) {
      return 0;
    }
    return acc + (buySequence[index - 1] !== side ? 1 : 0);
  }, 0);
  const totals = marketResidualTotals(cycles);
  const finalResidualSide =
    Math.abs(totals.up - totals.down) <= 1e-9 ? "FLAT" : totals.up > totals.down ? "UP" : "DOWN";
  const finalResidualQty = normalize(Math.abs(totals.up - totals.down));

  return {
    reference: {
      slug: args.marketSlug,
      startTs,
      endTs,
      orderedClipSequence,
      cycleCount: cycleByKey.size,
      mergeCount,
      redeemCount,
      completionCount,
      overlapClipCount,
      hasOverlap: overlapClipCount > 0,
      repairLatencyBucket: timingBucket(repairLatencies.length > 0 ? Math.min(...repairLatencies) : undefined),
      mergeTimingBucket: timingBucket(mergeLatencies.length > 0 ? Math.min(...mergeLatencies) : undefined),
      finalResidualSide,
      finalResidualBucket: residualBucket(finalResidualQty),
      clipBucketCounts,
      normalizedClipTierCounts,
      buySequence,
      alternatingTransitionCount,
      authority: {
        tradeTape: "paper",
        lifecycle: "paper",
        verifiedBuyCount: buyLots.length,
        totalBuyCount: buyLots.length,
        mergeEventCount: mergeCount,
        redeemEventCount: redeemCount,
      },
    },
    hardFails,
    diagnostics: {
      marketBaseLot: baseLot,
      groupCount: pairGroups.length,
      grouplessBuyCount: hardFails.grouplessBotFill,
      buyCount: buyLots.length,
      lifecycleEventCount: lifecycleEvents.length,
      mergeableAtEnd: finalMergeable,
      childOrderDispatch: args.marketEvents.childOrderDispatch,
      runtimeDataStatus:
        buyLots.length > 0
          ? "runtime_fills_present"
          : lifecycleEvents.length > 0
            ? "runtime_lifecycle_only"
            : "no_runtime_fills",
    },
  };
}

export async function buildRuntimeCanonicalExtractBundle(args: {
  stateDbPath: string;
  logsDir?: string | undefined;
  marketSlugs?: string[] | undefined;
}): Promise<RuntimeCanonicalExtractBundle> {
  const logsDir = args.logsDir ?? DEFAULT_RUNTIME_LOG_DIR;
  const decisionTrace = await readJsonlRecords(join(logsDir, "decision_trace.jsonl"));
  const ordersTrace = await readJsonlRecords(join(logsDir, "orders.jsonl"));
  const riskEvents = await readJsonlRecords(join(logsDir, "risk_events.jsonl"));
  const runtimeData = loadRuntimeData(args.stateDbPath);
  const repairEvents = mergeRepairEvents(decisionTrace, riskEvents, DEFAULT_REPAIR_MIN_QTY);
  const stateMarketMap = new Map(runtimeData.marketStates.map((row) => [row.marketSlug, row]));

  const discoveredSlugs = new Set<string>();
  for (const group of runtimeData.pairGroups) discoveredSlugs.add(group.marketSlug);
  for (const lot of runtimeData.lots) discoveredSlugs.add(lot.marketSlug);
  for (const event of runtimeData.mergeRedeemEvents) discoveredSlugs.add(event.marketSlug);
  for (const record of decisionTrace) {
    if (typeof record.marketSlug === "string") {
      discoveredSlugs.add(record.marketSlug);
    }
  }

  const slugs = args.marketSlugs && args.marketSlugs.length > 0 ? args.marketSlugs : [...discoveredSlugs].sort();
  const references: CanonicalReferenceExtract[] = [];
  const hardFailsBySlug: Record<string, HardFailCounts> = {};
  const diagnosticsBySlug: RuntimeCanonicalExtractBundle["diagnosticsBySlug"] = {};

  for (const marketSlug of slugs) {
    const marketEvents = buildMarketEvents({
      marketSlug,
      pairGroups: runtimeData.pairGroups,
      lots: runtimeData.lots,
      mergeRedeemEvents: runtimeData.mergeRedeemEvents,
      marketState: stateMarketMap.get(marketSlug),
      repairEvents,
      childOrderDispatch: buildChildOrderDispatchDiagnostics(ordersTrace, marketSlug),
    });
    const result = buildRuntimeReferenceForMarket({
      marketSlug,
      marketEvents,
      repairMinQty: DEFAULT_REPAIR_MIN_QTY,
      mergeMinQty: DEFAULT_MERGE_MIN_QTY,
      dustToleranceShares: DEFAULT_DUST_TOLERANCE_SHARES,
    });
    references.push(result.reference);
    hardFailsBySlug[marketSlug] = result.hardFails;
    diagnosticsBySlug[marketSlug] = result.diagnostics;
  }

  return {
    generatedAt: new Date().toISOString(),
    slugs,
    sources: {
      stateDbPath: args.stateDbPath,
      logsDir,
    },
    references,
    hardFailsBySlug,
    diagnosticsBySlug,
  };
}

export async function writeRuntimeCanonicalExtractBundle(
  bundle: RuntimeCanonicalExtractBundle,
  filePath = "reports/runtime_canonical_references.json",
): Promise<string> {
  await writeJson(filePath, bundle);
  return filePath;
}

export function toCanonicalReferenceBundle(bundle: RuntimeCanonicalExtractBundle): CanonicalReferenceBundle {
  return {
    generatedAt: bundle.generatedAt,
    slugs: bundle.slugs,
    sources: {
      tradeTapeFile: bundle.sources.stateDbPath,
      lifecycleSqlitePath: bundle.sources.logsDir,
    },
    references: bundle.references,
  };
}
