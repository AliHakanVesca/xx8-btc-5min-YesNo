import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { buildOfflineMarket } from "../infra/gamma/marketDiscovery.js";
import { SystemClock } from "../infra/time/clock.js";
import type { OrderBook, OutcomeSide } from "../infra/clob/types.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import {
  countActiveIndependentFlowCount,
  countRecentSeedFlowCount,
  createMarketState,
  type FillRecord,
  type XuanMarketState,
} from "../strategy/xuan5m/marketState.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import {
  applyFill,
  applyMerge,
  averageCost,
  pairVwapSum,
  shrinkOutcomeToObservedShares,
} from "../strategy/xuan5m/inventoryState.js";
import {
  createMergeBatchTracker,
  evaluateDelayedMergeGate,
  planMerge,
  syncMergeBatchTracker,
} from "../strategy/xuan5m/mergeCoordinator.js";
import { takerFeePerShare } from "../strategy/xuan5m/sumAvgEngine.js";
import type { FairValueSnapshot } from "../strategy/xuan5m/fairValueEngine.js";
import type { EntryBuyDecision, EntryDecisionTrace } from "../strategy/xuan5m/entryLadderEngine.js";
import type { CompletionReleaseRole } from "../strategy/xuan5m/modePolicy.js";
import type { StrategyExecutionMode } from "../strategy/xuan5m/executionModes.js";
import { buildFootprintSummary, type FootprintSummary } from "./footprintMetrics.js";
import type { CanonicalReferenceExtract, CanonicalSequenceEvent } from "./xuanCanonicalReference.js";

export const paperSessionVariants = ["xuan-flow", "blocked-completion"] as const;
export type PaperSessionVariant = (typeof paperSessionVariants)[number];

export function isPaperSessionVariant(value: string): value is PaperSessionVariant {
  return (paperSessionVariants as readonly string[]).includes(value);
}

export interface PaperSessionOptions {
  marketStartTs?: number | undefined;
  referenceFlow?: CanonicalReferenceExtract | undefined;
  completionPatienceMultiplier?: number | undefined;
  openingSeedOffsetShiftSec?: number | undefined;
  overlapSeedOffsetShiftSec?: number | undefined;
  openingSeedReleaseBias?: "neutral" | "earlier" | "later" | undefined;
  recentSeedFlowCountBonus?: number | undefined;
  activeIndependentFlowCountBonus?: number | undefined;
  semanticRoleAlignmentBias?:
    | "neutral"
    | "align_high_low_role"
    | "preserve_raw_side"
    | "cycle_role_arbitration"
    | undefined;
  childOrderMicroTimingBias?: "neutral" | "flow_intent" | undefined;
  completionRoleReleaseOrderBias?: "neutral" | "role_order" | undefined;
  orderPriorityAwareFill?: boolean | undefined;
  mergeCohortCompression?: boolean | undefined;
}

interface ReplayBooks {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
}

interface PaperSessionStepSpec {
  name: string;
  note: string;
  offsetSec: number;
  books: ReplayBooks;
  entryFillPolicy?: "all" | "up-only" | "down-only" | "none";
  completionFill?: boolean;
  unwindFill?: boolean;
  mergePolicy?: "auto" | "skip" | "force";
  redeemPolicy?: "none" | "residual";
}

export interface PaperSessionFillEvent {
  kind: "entry" | "completion" | "unwind";
  side: OutcomeSide;
  action: "BUY" | "SELL";
  size: number;
  price: number;
  rawNotional: number;
  feeUsd: number;
  effectiveNotional: number;
  reason: string;
  executionMode?: StrategyExecutionMode | undefined;
}

export interface PaperSessionStepResult {
  name: string;
  note: string;
  timestamp: number;
  phase: string;
  books: ReplayBooks;
  stateBefore: {
    upShares: number;
    downShares: number;
    upAverage: number;
    downAverage: number;
  };
  decision: {
    entryBuyCount: number;
    hasCompletion: boolean;
    hasUnwind: boolean;
    plannedMergeShares: number;
    allowNewEntries: boolean;
    completionOnly: boolean;
    hardCancel: boolean;
    completionReleaseRole?: CompletionReleaseRole | undefined;
    completionCalibrationPatienceMultiplier?: number | undefined;
    completionRolePatienceMultiplier?: number | undefined;
    completionEffectivePatienceMultiplier?: number | undefined;
    completionWaitUntilSec?: number | undefined;
    entryTrace?: EntryDecisionTrace | undefined;
  };
  execution: {
    fills: PaperSessionFillEvent[];
    skippedEntrySides: OutcomeSide[];
    skippedCompletion: boolean;
    skippedUnwind: boolean;
    mergeShares: number;
    redeemShares: number;
    redeemSide?: OutcomeSide | undefined;
    mergePairCost?: number | undefined;
    mergeProceeds: number;
    realizedMergeProfit: number;
    rawSpend: number;
    feeUsd: number;
    effectiveSpend: number;
  };
  stateAfter: {
    upShares: number;
    downShares: number;
    upAverage: number;
    downAverage: number;
  };
}

export interface PaperSessionReport {
  market: {
    slug: string;
    conditionId: string;
    startTs: number;
    endTs: number;
  };
  variant: PaperSessionVariant;
  summary: {
    stepCount: number;
    entryStepCount: number;
    completionStepCount: number;
    mergeStepCount: number;
    totalBuyShares: number;
    totalEntryBuyShares: number;
    totalCompletionShares: number;
    totalUnwindShares: number;
    totalRawSpend: number;
    totalFeeUsd: number;
    totalEffectiveSpend: number;
    totalMergeShares: number;
    totalRedeemShares: number;
    totalMergeProceeds: number;
    realizedMergeProfit: number;
    roiPct: number;
    finalUpShares: number;
    finalDownShares: number;
    footprint: FootprintSummary;
  };
  steps: PaperSessionStepResult[];
}

interface EffectiveCostState {
  up: number;
  down: number;
}

const sessionVariants: Record<PaperSessionVariant, PaperSessionStepSpec[]> = {
  "xuan-flow": [
    {
      name: "open-down-seed",
      note: "First cycle opens with only the DOWN leg filled; UP completion follows a few seconds later.",
      offsetSec: 10,
      books: { upBid: 0.49, upAsk: 0.5, downBid: 0.43, downAsk: 0.44 },
      entryFillPolicy: "down-only",
      mergePolicy: "skip",
    },
    {
      name: "open-up-completion",
      note: "Fast UP completion closes the opening imbalance but leaves the matched set waiting for a batched merge.",
      offsetSec: 20,
      books: { upBid: 0.49, upAsk: 0.5, downBid: 0.43, downAsk: 0.44 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "overlap-up-seed-1",
      note: "A second cycle starts before the first matched inventory is merged, creating the first overlap rung.",
      offsetSec: 26,
      books: { upBid: 0.55, upAsk: 0.56, downBid: 0.31, downAsk: 0.32 },
      entryFillPolicy: "up-only",
      mergePolicy: "skip",
    },
    {
      name: "overlap-down-completion-1",
      note: "The missing DOWN leg completes quickly and keeps the overlap chain alive.",
      offsetSec: 32,
      books: { upBid: 0.54, upAsk: 0.55, downBid: 0.31, downAsk: 0.32 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "overlap-up-seed-2",
      note: "A third cycle repeats the UP-first pattern at a slightly cheaper DOWN completion setup.",
      offsetSec: 56,
      books: { upBid: 0.54, upAsk: 0.55, downBid: 0.33, downAsk: 0.34 },
      entryFillPolicy: "up-only",
      mergePolicy: "skip",
    },
    {
      name: "overlap-down-completion-2",
      note: "DOWN completion lands later in the minute and adds another matched pair to the merge queue.",
      offsetSec: 82,
      books: { upBid: 0.53, upAsk: 0.54, downBid: 0.31, downAsk: 0.32 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "overlap-up-seed-3",
      note: "A fourth cycle opens with an UP-first clip right before the first batched merge flush.",
      offsetSec: 84,
      books: { upBid: 0.6, upAsk: 0.61, downBid: 0.28, downAsk: 0.29 },
      entryFillPolicy: "up-only",
      mergePolicy: "skip",
    },
    {
      name: "merge-flush-1",
      note: "Entry prices are intentionally unattractive so the bot only flushes the earlier matched inventory into merge.",
      offsetSec: 86,
      books: { upBid: 0.62, upAsk: 0.63, downBid: 0.58, downAsk: 0.59 },
      mergePolicy: "force",
    },
    {
      name: "overlap-down-completion-3",
      note: "The fourth cycle completes right after the first merge flush, keeping one fresh matched set open.",
      offsetSec: 90,
      books: { upBid: 0.6, upAsk: 0.61, downBid: 0.28, downAsk: 0.29 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "overlap-down-seed-4",
      note: "A same-second new cycle opens on the DOWN leg, mirroring xuan-like clipped overlap behavior.",
      offsetSec: 90,
      books: { upBid: 0.43, upAsk: 0.44, downBid: 0.49, downAsk: 0.5 },
      entryFillPolicy: "down-only",
      mergePolicy: "skip",
    },
    {
      name: "patient-up-completion",
      note: "This residual waits into the patient window before the missing UP leg finally fills.",
      offsetSec: 160,
      books: { upBid: 0.43, upAsk: 0.44, downBid: 0.49, downAsk: 0.5 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "merge-flush-2",
      note: "A second unattractive-book pause clears the patient residual block so the later high/low cycles start from a flatter inventory base.",
      offsetSec: 161,
      books: { upBid: 0.66, upAsk: 0.67, downBid: 0.66, downAsk: 0.67 },
      mergePolicy: "force",
    },
    {
      name: "high-low-down-seed-1",
      note: "A low-priced DOWN seed opens early enough to satisfy the underdog fair-value gate and set up a clean high/low completion pair.",
      offsetSec: 162,
      books: { upBid: 0.79, upAsk: 0.8, downBid: 0.16, downAsk: 0.17 },
      entryFillPolicy: "down-only",
      mergePolicy: "skip",
    },
    {
      name: "high-low-up-completion-1",
      note: "The matching UP completion prints the first explicit high/low completion pattern.",
      offsetSec: 166,
      books: { upBid: 0.79, upAsk: 0.8, downBid: 0.16, downAsk: 0.17 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "high-low-up-seed-2",
      note: "Another late high-side seed opens while the first high/low cycle is still only matched, not merged.",
      offsetSec: 168,
      books: { upBid: 0.82, upAsk: 0.83, downBid: 0.11, downAsk: 0.12 },
      entryFillPolicy: "up-only",
      mergePolicy: "skip",
    },
    {
      name: "high-low-down-completion-2",
      note: "The opposite low-side completion closes the second explicit high/low cycle.",
      offsetSec: 176,
      books: { upBid: 0.82, upAsk: 0.83, downBid: 0.11, downAsk: 0.12 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "high-low-down-seed-3",
      note: "A mirror-image low-side seed creates one more overlap cycle before the final late mid-price repair.",
      offsetSec: 178,
      books: { upBid: 0.78, upAsk: 0.79, downBid: 0.13, downAsk: 0.14 },
      entryFillPolicy: "down-only",
      mergePolicy: "skip",
    },
    {
      name: "high-low-up-completion-3",
      note: "UP completion finalizes that mirrored high/low pair.",
      offsetSec: 188,
      books: { upBid: 0.78, upAsk: 0.79, downBid: 0.13, downAsk: 0.14 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "merge-flush-2b",
      note: "A short post-high-low merge flush resets the book so the last mid-price cycle starts from flat inventory instead of inherited high-side basis.",
      offsetSec: 190,
      books: { upBid: 0.66, upAsk: 0.67, downBid: 0.66, downAsk: 0.67 },
      mergePolicy: "force",
    },
    {
      name: "late-up-seed",
      note: "One final late-cycle entry opens with UP first while there is still enough time for a strict completion.",
      offsetSec: 194,
      books: { upBid: 0.59, upAsk: 0.6, downBid: 0.35, downAsk: 0.36 },
      entryFillPolicy: "up-only",
      mergePolicy: "skip",
    },
    {
      name: "late-down-completion",
      note: "A final strict completion closes the late cycle before the last merge window.",
      offsetSec: 206,
      books: { upBid: 0.58, upAsk: 0.59, downBid: 0.34, downAsk: 0.35 },
      completionFill: true,
      mergePolicy: "skip",
    },
    {
      name: "merge-flush-3",
      note: "The last merge window converts the late matched inventory before the market enters the final idle stretch.",
      offsetSec: 280,
      books: { upBid: 0.67, upAsk: 0.68, downBid: 0.67, downAsk: 0.68 },
      mergePolicy: "force",
    },
    {
      name: "late-hold",
      note: "Late window remains flat and does not create a new pair.",
      offsetSec: 286,
      books: { upBid: 0.44, upAsk: 0.45, downBid: 0.55, downAsk: 0.56 },
    },
    {
      name: "hard-cancel-window",
      note: "Final seconds disable new entries.",
      offsetSec: 293,
      books: { upBid: 0.49, upAsk: 0.5, downBid: 0.49, downAsk: 0.5 },
    },
    {
      name: "post-settlement-residual-redeem",
      note: "Post-market lifecycle step redeems residual winner dust after merge batching has finished.",
      offsetSec: 556,
      books: { upBid: 0.49, upAsk: 0.5, downBid: 0.49, downAsk: 0.5 },
      entryFillPolicy: "none",
      mergePolicy: "skip",
      redeemPolicy: "residual",
    },
  ],
  "blocked-completion": [
    {
      name: "open-balanced-entry",
      note: "Opening pair seed fills and merges.",
      offsetSec: 15,
      books: { upBid: 0.47, upAsk: 0.48, downBid: 0.47, downAsk: 0.48 },
      entryFillPolicy: "all",
    },
    {
      name: "partial-up-fill",
      note: "Only the UP leg fills and leaves unmatched inventory.",
      offsetSec: 230,
      books: { upBid: 0.47, upAsk: 0.48, downBid: 0.47, downAsk: 0.48 },
      entryFillPolicy: "up-only",
    },
    {
      name: "expensive-completion-blocked",
      note: "Completion is offered too expensively and should be skipped.",
      offsetSec: 245,
      books: { upBid: 0.45, upAsk: 0.46, downBid: 0.58, downAsk: 0.59 },
      completionFill: false,
    },
    {
      name: "late-residual-hold",
      note: "Late window still holds residual because completion stays too expensive.",
      offsetSec: 286,
      books: { upBid: 0.43, upAsk: 0.44, downBid: 0.58, downAsk: 0.59 },
      completionFill: false,
    },
    {
      name: "hard-cancel-window",
      note: "Final seconds hard-cancel with residual still open.",
      offsetSec: 293,
      books: { upBid: 0.49, upAsk: 0.5, downBid: 0.58, downAsk: 0.59 },
      completionFill: false,
    },
  ],
};

function clampPaperBookPrice(value: number | null | undefined, fallback: number): number {
  const raw = Number.isFinite(value) ? Number(value) : fallback;
  return Number(Math.min(0.99, Math.max(0.01, raw)).toFixed(4));
}

function referenceBookFromBuyEvent(event: CanonicalSequenceEvent): ReplayBooks {
  const sideAsk = clampPaperBookPrice(event.price, 0.5);
  const oppositeAsk = clampPaperBookPrice(1.01 - sideAsk, 0.5);
  const upAsk = event.outcome === "UP" ? sideAsk : oppositeAsk;
  const downAsk = event.outcome === "DOWN" ? sideAsk : oppositeAsk;
  return {
    upBid: clampPaperBookPrice(upAsk - 0.01, 0.49),
    upAsk,
    downBid: clampPaperBookPrice(downAsk - 0.01, 0.49),
    downAsk,
  };
}

function buildReferenceFlowReplaySteps(reference: CanonicalReferenceExtract): PaperSessionStepSpec[] {
  const steps: PaperSessionStepSpec[] = [];
  const lifecycleOffsets = new Set<string>();

  for (const event of reference.orderedClipSequence) {
    if (event.kind === "BUY" && event.outcome) {
      const isCompletion = event.phase === "COMPLETION" || event.phase === "HIGH_LOW_COMPLETION";
      steps.push({
        name: `reference-${event.sequenceIndex}-${String(event.phase).toLowerCase()}-${event.outcome.toLowerCase()}`,
        note: `Reference ${event.phase} ${event.outcome} clip from ${reference.slug}.`,
        offsetSec: event.tOffsetSec,
        books: referenceBookFromBuyEvent(event),
        entryFillPolicy: isCompletion ? "none" : event.outcome === "UP" ? "up-only" : "down-only",
        completionFill: isCompletion ? true : false,
        mergePolicy: "skip",
      });
      continue;
    }

    if (event.kind === "MERGE") {
      const key = `MERGE:${event.tOffsetSec}`;
      if (lifecycleOffsets.has(key)) {
        continue;
      }
      lifecycleOffsets.add(key);
      steps.push({
        name: `reference-merge-${event.tOffsetSec}`,
        note: `Reference merge cohort from ${reference.slug}.`,
        offsetSec: event.tOffsetSec,
        books: { upBid: 0.66, upAsk: 0.67, downBid: 0.66, downAsk: 0.67 },
        entryFillPolicy: "none",
        completionFill: false,
        mergePolicy: "force",
      });
      continue;
    }

    if (event.kind === "REDEEM") {
      const key = `REDEEM:${event.tOffsetSec}`;
      if (lifecycleOffsets.has(key)) {
        continue;
      }
      lifecycleOffsets.add(key);
      steps.push({
        name: `reference-redeem-${event.tOffsetSec}`,
        note: `Reference residual redeem from ${reference.slug}.`,
        offsetSec: event.tOffsetSec,
        books: { upBid: 0.49, upAsk: 0.5, downBid: 0.49, downAsk: 0.5 },
        entryFillPolicy: "none",
        completionFill: false,
        mergePolicy: "skip",
        redeemPolicy: "residual",
      });
    }
  }

  return steps.sort((left, right) => left.offsetSec - right.offsetSec);
}

function buildSyntheticBook(assetId: string, market: string, bid: number, ask: number): OrderBook {
  return {
    market,
    assetId,
    timestamp: Math.floor(Date.now() / 1000),
    bids: [{ price: bid, size: 180 }],
    asks: [{ price: ask, size: 180 }],
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
  };
}

function snapshotState(state: XuanMarketState): PaperSessionStepResult["stateBefore"] {
  return {
    upShares: state.upShares,
    downShares: state.downShares,
    upAverage: averageCost(state, "UP"),
    downAverage: averageCost(state, "DOWN"),
  };
}

function shouldFillEntry(
  step: PaperSessionStepSpec,
  entryBuy: EntryBuyDecision,
  entryBuys: EntryBuyDecision[],
  options: PaperSessionOptions,
  entryTrace?: EntryDecisionTrace | undefined,
): boolean {
  const policy = step.entryFillPolicy ?? "all";
  const completionLikeEntry =
    step.completionFill === true &&
    entryBuy.reason === "lagging_rebalance" &&
    (
      entryBuy.mode === "HIGH_LOW_COMPLETION_CHASE" ||
      entryBuy.mode === "CHEAP_LATE_COMPLETION_CHASE" ||
      entryBuy.mode === "PARTIAL_FAST_COMPLETION" ||
      entryBuy.mode === "PARTIAL_SOFT_COMPLETION" ||
      entryBuy.mode === "PARTIAL_EMERGENCY_COMPLETION" ||
      entryBuy.mode === "POST_MERGE_RESIDUAL_COMPLETION"
    );
  if (completionLikeEntry) {
    return true;
  }
  if (entryBuys.length <= 1) {
    return policy !== "none";
  }
  if (policy === "all") {
    return true;
  }
  if (policy === "none") {
    return false;
  }
  const flowIntentPriorityFill =
    entryTrace?.childOrderReason === "flow_intent" &&
    entryTrace.childOrderSelectedSide !== undefined &&
    entryTrace.childOrderSelectedSide === entryBuys[0]?.side;
  if (options.orderPriorityAwareFill || flowIntentPriorityFill) {
    return entryBuy.side === entryBuys[0]?.side;
  }
  return policy === "up-only" ? entryBuy.side === "UP" : entryBuy.side === "DOWN";
}

function buildFillEvent(args: {
  kind: PaperSessionFillEvent["kind"];
  side: OutcomeSide;
  action: "BUY" | "SELL";
  size: number;
  price: number;
  reason: string;
  executionMode?: StrategyExecutionMode | undefined;
}): PaperSessionFillEvent {
  const rawNotional = args.size * args.price;
  const feeUsd = args.action === "BUY" ? args.size * takerFeePerShare(args.price) : 0;
  return {
    kind: args.kind,
    side: args.side,
    action: args.action,
    size: args.size,
    price: args.price,
    rawNotional,
    feeUsd,
    effectiveNotional: rawNotional + feeUsd,
    reason: args.reason,
    ...(args.executionMode !== undefined ? { executionMode: args.executionMode } : {}),
  };
}

function applySyntheticFill(state: XuanMarketState, event: PaperSessionFillEvent, timestamp: number): XuanMarketState {
  const fill: FillRecord = {
    outcome: event.side,
    side: event.action,
    price: event.price,
    size: event.size,
    timestamp,
    makerTaker: "taker",
    ...(event.executionMode !== undefined ? { executionMode: event.executionMode } : {}),
  };
  return applyFill(state, fill);
}

function averageEffectiveCost(costState: EffectiveCostState, state: XuanMarketState, outcome: OutcomeSide): number {
  const totalCost = outcome === "UP" ? costState.up : costState.down;
  const totalShares = outcome === "UP" ? state.upShares : state.downShares;
  return totalShares > 0 ? totalCost / totalShares : 0;
}

function buildPaperFairValueSnapshot(step: PaperSessionStepSpec): FairValueSnapshot {
  return {
    status: "valid",
    estimatedThreshold: false,
    fairUp: Number(step.books.upAsk.toFixed(6)),
    fairDown: Number(step.books.downAsk.toFixed(6)),
    livePrice: 0,
    note: "paper_session_assumed_fair_value",
  };
}

function applyCompletionTimingCalibration(
  steps: PaperSessionStepSpec[],
  options: PaperSessionOptions,
): PaperSessionStepSpec[] {
  const multiplier = options.completionPatienceMultiplier;
  if (multiplier === undefined || !Number.isFinite(multiplier) || Math.abs(multiplier - 1) < 0.001) {
    return steps;
  }

  const calibrated = steps.map((step, index) => {
    if (!step.completionFill || index === 0) {
      return step;
    }
    const previous = steps[index - 1];
    const next = steps[index + 1];
    if (!previous || step.offsetSec <= previous.offsetSec) {
      return step;
    }
    const originalLatency = step.offsetSec - previous.offsetSec;
    const boundedMultiplier = Math.max(0.25, Math.min(1.4, multiplier));
    const patientOutlierLatencyCap =
      originalLatency > 2 * 30
        ? Math.max(10, Math.round(originalLatency * 0.18))
        : originalLatency > 30
          ? Math.max(12, Math.round(originalLatency * 0.34))
          : Number.POSITIVE_INFINITY;
    const calibratedLatency = Math.max(
      2,
      Math.min(
        patientOutlierLatencyCap,
        Math.round(originalLatency * boundedMultiplier),
      ),
    );
    const latestAllowedOffset =
      next && next.offsetSec > previous.offsetSec
        ? Math.max(previous.offsetSec + 1, next.offsetSec - 1)
        : step.offsetSec;
    const offsetSec = Math.max(
      previous.offsetSec + 1,
      Math.min(latestAllowedOffset, previous.offsetSec + calibratedLatency),
    );
    if (offsetSec === step.offsetSec) {
      return step;
    }
    return {
      ...step,
      offsetSec,
      note: `${step.note} Completion timing calibrated from ${step.offsetSec}s to ${offsetSec}s.`,
    };
  });

  return calibrated
    .map((step, index) => ({ step, index }))
    .sort((left, right) => left.step.offsetSec - right.step.offsetSec || left.index - right.index)
    .map(({ step }) => step);
}

function applyOpeningSeedTimingCalibration(
  steps: PaperSessionStepSpec[],
  options: PaperSessionOptions,
): PaperSessionStepSpec[] {
  const requestedShiftSec = options.openingSeedOffsetShiftSec;
  if (
    requestedShiftSec === undefined ||
    !Number.isFinite(requestedShiftSec) ||
    Math.abs(requestedShiftSec) < 1
  ) {
    return steps;
  }

  const firstEntryIndex = steps.findIndex(
    (step) => step.entryFillPolicy !== undefined && step.entryFillPolicy !== "none",
  );
  if (firstEntryIndex < 0) {
    return steps;
  }
  const firstEntry = steps[firstEntryIndex];
  if (!firstEntry) {
    return steps;
  }
  const nextIndependentEntryIndex = steps.findIndex(
    (step, index) =>
      index > firstEntryIndex &&
      step.entryFillPolicy !== undefined &&
      step.entryFillPolicy !== "none",
  );
  const boundedShiftSec = Math.max(-8, Math.min(8, Math.round(requestedShiftSec)));
  const earliestOffsetSec = 2;
  const latestEntryOffsetSec =
    nextIndependentEntryIndex >= 0
      ? Math.max(earliestOffsetSec, (steps[nextIndependentEntryIndex]?.offsetSec ?? firstEntry.offsetSec) - 2)
      : firstEntry.offsetSec + 8;
  const shiftedFirstEntryOffsetSec = Math.max(
    earliestOffsetSec,
    Math.min(latestEntryOffsetSec, firstEntry.offsetSec - boundedShiftSec),
  );
  const effectiveShiftSec = firstEntry.offsetSec - shiftedFirstEntryOffsetSec;
  if (Math.abs(effectiveShiftSec) < 1) {
    return steps;
  }

  return steps.map((step, index) => {
    const inOpeningPrefix =
      index === firstEntryIndex ||
      (index > firstEntryIndex &&
        (nextIndependentEntryIndex < 0 || index < nextIndependentEntryIndex) &&
        Boolean(step.completionFill));
    if (!inOpeningPrefix) {
      return step;
    }
    const offsetSec = Math.max(earliestOffsetSec, step.offsetSec - effectiveShiftSec);
    if (offsetSec === step.offsetSec) {
      return step;
    }
    return {
      ...step,
      offsetSec,
      note: `${step.note} Opening seed timing calibrated from ${step.offsetSec}s to ${offsetSec}s.`,
    };
  });
}

function applyOverlapSeedTimingCalibration(
  steps: PaperSessionStepSpec[],
  options: PaperSessionOptions,
): PaperSessionStepSpec[] {
  const requestedShiftSec = options.overlapSeedOffsetShiftSec;
  if (
    requestedShiftSec === undefined ||
    !Number.isFinite(requestedShiftSec) ||
    Math.abs(requestedShiftSec) < 1
  ) {
    return steps;
  }

  const boundedShiftSec = Math.max(0, Math.min(24, Math.round(requestedShiftSec)));
  const firstEntryIndex = steps.findIndex(
    (step) => step.entryFillPolicy !== undefined && step.entryFillPolicy !== "none",
  );
  if (boundedShiftSec <= 0 || firstEntryIndex < 0) {
    return steps;
  }

  return steps
    .reduce<PaperSessionStepSpec[]>((acc, step, index) => {
      const isOverlapSeed =
        index > firstEntryIndex &&
        step.entryFillPolicy !== undefined &&
        step.entryFillPolicy !== "none";
      if (!isOverlapSeed) {
        acc.push(step);
        return acc;
      }
      const previousOffsetSec = acc.at(-1)?.offsetSec ?? 0;
      const offsetSec = Math.max(previousOffsetSec + 1, step.offsetSec - boundedShiftSec);
      acc.push(
        offsetSec === step.offsetSec
          ? step
          : {
              ...step,
              offsetSec,
              note: `${step.note} Overlap seed cadence calibrated from ${step.offsetSec}s to ${offsetSec}s.`,
            },
      );
      return acc;
    }, [])
    .map((step, index) => ({ step, index }))
    .sort((left, right) => left.step.offsetSec - right.step.offsetSec || left.index - right.index)
    .map(({ step }) => step);
}

function applyEffectiveFill(
  costState: EffectiveCostState,
  stateBefore: XuanMarketState,
  event: PaperSessionFillEvent,
): EffectiveCostState {
  if (event.action === "BUY") {
    return event.side === "UP"
      ? { ...costState, up: costState.up + event.effectiveNotional }
      : { ...costState, down: costState.down + event.effectiveNotional };
  }

  const sharesBefore = event.side === "UP" ? stateBefore.upShares : stateBefore.downShares;
  const averageBefore = averageEffectiveCost(costState, stateBefore, event.side);
  const matchedSize = Math.min(event.size, sharesBefore);

  return event.side === "UP"
    ? { ...costState, up: Math.max(0, costState.up - averageBefore * matchedSize) }
    : { ...costState, down: Math.max(0, costState.down - averageBefore * matchedSize) };
}

function applyEffectiveMerge(
  costState: EffectiveCostState,
  stateBefore: XuanMarketState,
  mergeShares: number,
): { nextCostState: EffectiveCostState; pairCost?: number | undefined } {
  if (mergeShares <= 0) {
    return {
      nextCostState: costState,
    };
  }

  const upAverage = averageEffectiveCost(costState, stateBefore, "UP");
  const downAverage = averageEffectiveCost(costState, stateBefore, "DOWN");

  return {
    nextCostState: {
      up: Math.max(0, costState.up - upAverage * mergeShares),
      down: Math.max(0, costState.down - downAverage * mergeShares),
    },
    pairCost: upAverage + downAverage,
  };
}

function residualRedeemPlan(state: XuanMarketState): { side: OutcomeSide; shares: number } | undefined {
  const gap = Number(Math.abs(state.upShares - state.downShares).toFixed(6));
  if (gap <= 1e-6) {
    return undefined;
  }
  return {
    side: state.upShares >= state.downShares ? "UP" : "DOWN",
    shares: gap,
  };
}

function applyEffectiveRedeem(
  costState: EffectiveCostState,
  stateBefore: XuanMarketState,
  side: OutcomeSide,
  redeemShares: number,
): EffectiveCostState {
  if (redeemShares <= 0) {
    return costState;
  }
  const averageBefore = averageEffectiveCost(costState, stateBefore, side);
  return side === "UP"
    ? { ...costState, up: Math.max(0, costState.up - averageBefore * redeemShares) }
    : { ...costState, down: Math.max(0, costState.down - averageBefore * redeemShares) };
}

export function runPaperSession(
  env: AppEnv,
  variant: PaperSessionVariant = "xuan-flow",
  options: PaperSessionOptions = {},
): PaperSessionReport {
  const config = buildStrategyConfig(env);
  const bot = new Xuan5mBot();
  const clock = new SystemClock();
  const startTs = Number.isFinite(options.marketStartTs)
    ? Math.floor(Number(options.marketStartTs))
    : Math.floor(clock.now() / 300) * 300;
  const market = buildOfflineMarket(startTs);
  let state = createMarketState(market);
  let effectiveCostState: EffectiveCostState = { up: 0, down: 0 };
  const steps: PaperSessionStepResult[] = [];
  const replaySteps = options.referenceFlow
    ? buildReferenceFlowReplaySteps(options.referenceFlow)
    : applyCompletionTimingCalibration(
        applyOverlapSeedTimingCalibration(
          applyOpeningSeedTimingCalibration(sessionVariants[variant], options),
          options,
        ),
        options,
      );
  let mergeBatchTracker = createMergeBatchTracker();
  let nonFinalForcedMergeCohorts = 0;

  for (const step of replaySteps) {
    const nowTs = market.startTs + step.offsetSec;
    const books = new OrderBookState(
      buildSyntheticBook(market.tokens.UP.tokenId, market.conditionId, step.books.upBid, step.books.upAsk),
      buildSyntheticBook(market.tokens.DOWN.tokenId, market.conditionId, step.books.downBid, step.books.downAsk),
    );
    const stateBefore = snapshotState(state);
    const calibratedRecentSeedFlowCount =
      countRecentSeedFlowCount(state.fillHistory, nowTs) + Math.max(0, options.recentSeedFlowCountBonus ?? 0);
    const calibratedActiveIndependentFlowCount =
      countActiveIndependentFlowCount(state.fillHistory, nowTs) +
      Math.max(0, options.activeIndependentFlowCountBonus ?? 0);
    const decision = bot.evaluateTick({
      config,
      state,
      books,
      nowTs,
      riskContext: {
        secsToClose: market.endTs - nowTs,
        staleBookMs: 200,
        balanceStaleMs: 200,
        bookIsCrossed: false,
        dailyLossUsdc: 0,
        marketLossUsdc: 0,
        usdcBalance: 100,
      },
      dryRunOrSmallLive: true,
      fairValueSnapshot: buildPaperFairValueSnapshot(step),
      recentSeedFlowCount: calibratedRecentSeedFlowCount,
      activeIndependentFlowCount: calibratedActiveIndependentFlowCount,
      ...(options.completionPatienceMultiplier !== undefined
        ? { completionPatienceMultiplier: options.completionPatienceMultiplier }
        : {}),
      ...(options.openingSeedReleaseBias !== undefined
        ? { openingSeedReleaseBias: options.openingSeedReleaseBias }
        : {}),
      ...(options.semanticRoleAlignmentBias !== undefined
        ? { semanticRoleAlignmentBias: options.semanticRoleAlignmentBias }
        : {}),
      ...(options.childOrderMicroTimingBias !== undefined
        ? { childOrderMicroTimingBias: options.childOrderMicroTimingBias }
        : {}),
      ...(options.completionRoleReleaseOrderBias !== undefined
        ? { completionRoleReleaseOrderBias: options.completionRoleReleaseOrderBias }
        : {}),
    });

    const fills: PaperSessionFillEvent[] = [];
    const skippedEntrySides: OutcomeSide[] = [];
    let skippedCompletion = false;
    let skippedUnwind = false;
    let completionHandled = false;
    const applyCompletionFill = () => {
      if (!decision.completion || completionHandled) {
        return;
      }
      completionHandled = true;
      if (step.completionFill ?? true) {
        const fillEvent = buildFillEvent({
          kind: "completion",
          side: decision.completion.sideToBuy,
          action: "BUY",
          size: decision.completion.missingShares,
          price: decision.completion.order.price ?? 0,
          reason: decision.completion.capMode,
          executionMode: decision.completion.mode,
        });
        fills.push(fillEvent);
        effectiveCostState = applyEffectiveFill(effectiveCostState, state, fillEvent);
        state = applySyntheticFill(state, fillEvent, nowTs);
      } else {
        skippedCompletion = true;
      }
    };
    const completionBeforeEntries =
      Boolean(decision.completion) &&
      decision.entryBuys.length > 0 &&
      decision.trace.entry.overlapRepairOutcome === "overlap_seed";

    if (completionBeforeEntries) {
      applyCompletionFill();
    }

    for (const entryBuy of decision.entryBuys) {
      if (!shouldFillEntry(step, entryBuy, decision.entryBuys, options, decision.trace.entry)) {
        skippedEntrySides.push(entryBuy.side);
        continue;
      }
      const fillEvent = buildFillEvent({
        kind: "entry",
        side: entryBuy.side,
        action: "BUY",
        size: entryBuy.size,
        price: entryBuy.expectedAveragePrice,
        reason: entryBuy.reason,
        executionMode: entryBuy.mode,
      });
      fills.push(fillEvent);
      effectiveCostState = applyEffectiveFill(effectiveCostState, state, fillEvent);
      state = applySyntheticFill(state, fillEvent, nowTs);
    }

    if (!completionHandled) {
      applyCompletionFill();
    }

    if (decision.unwind) {
      if (step.unwindFill ?? true) {
        const fillEvent = buildFillEvent({
          kind: "unwind",
          side: decision.unwind.sideToSell,
          action: "SELL",
          size: decision.unwind.unwindShares,
          price: decision.unwind.expectedAveragePrice,
          reason: "residual_unwind",
          executionMode: decision.unwind.mode,
        });
        fills.push(fillEvent);
        effectiveCostState = applyEffectiveFill(effectiveCostState, state, fillEvent);
        state = applySyntheticFill(state, fillEvent, nowTs);
      } else {
        skippedUnwind = true;
      }
    }

    const mergePlan = planMerge(config, state);
    const observedMergeable = Math.min(state.upShares, state.downShares);
    const activeIndependentFlowCount = countActiveIndependentFlowCount(state.fillHistory, nowTs);
    mergeBatchTracker = syncMergeBatchTracker(mergeBatchTracker, observedMergeable, nowTs, {
      activeIndependentFlowCount,
    });
    const mergeGate = evaluateDelayedMergeGate(config, state, {
      nowTs,
      secsFromOpen: nowTs - market.startTs,
      secsToClose: market.endTs - nowTs,
      usdcBalance: 100,
      tracker: mergeBatchTracker,
      activeIndependentFlowCount,
    });
    const forceMergeInFinalWindow = market.endTs - nowTs <= config.finalWindowCompletionOnlySec;
    const compressedForcedMerge =
      Boolean(options.mergeCohortCompression) &&
      step.mergePolicy === "force" &&
      !forceMergeInFinalWindow &&
      nonFinalForcedMergeCohorts >= 1;
    const mergeShares =
      step.mergePolicy === "skip" || compressedForcedMerge
        ? 0
        : step.mergePolicy === "force"
          ? observedMergeable
          : mergePlan.shouldMerge && mergeGate.allow
            ? mergePlan.mergeable
            : 0;
    const { nextCostState, pairCost: mergePairCost } = applyEffectiveMerge(effectiveCostState, state, mergeShares);
    const mergeProceeds = mergeShares;
    const realizedMergeProfit =
      mergePairCost !== undefined ? mergeShares * (1 - mergePairCost) : 0;

    if (mergeShares > 0) {
      if (step.mergePolicy === "force" && !forceMergeInFinalWindow) {
        nonFinalForcedMergeCohorts += 1;
      }
      effectiveCostState = nextCostState;
      state = applyMerge(state, {
        amount: mergeShares,
        timestamp: nowTs,
        simulated: true,
      });
      mergeBatchTracker = syncMergeBatchTracker(mergeBatchTracker, Math.min(state.upShares, state.downShares), nowTs);
    }
    const redeemPlan = step.redeemPolicy === "residual" ? residualRedeemPlan(state) : undefined;
    const redeemShares = redeemPlan?.shares ?? 0;
    const redeemSide = redeemPlan?.side;
    if (redeemPlan && redeemShares > 0) {
      effectiveCostState = applyEffectiveRedeem(effectiveCostState, state, redeemPlan.side, redeemShares);
      state = shrinkOutcomeToObservedShares(
        state,
        redeemPlan.side,
        Math.max(0, (redeemPlan.side === "UP" ? state.upShares : state.downShares) - redeemShares),
      );
    }

    const rawSpend = fills
      .filter((fill) => fill.action === "BUY")
      .reduce((acc, fill) => acc + fill.rawNotional, 0);
    const feeUsd = fills.reduce((acc, fill) => acc + fill.feeUsd, 0);
    const effectiveSpend = fills
      .filter((fill) => fill.action === "BUY")
      .reduce((acc, fill) => acc + fill.effectiveNotional, 0);

    steps.push({
      name: step.name,
      note: step.note,
      timestamp: nowTs,
      phase: decision.phase,
      books: step.books,
      stateBefore,
      decision: {
        entryBuyCount: decision.entryBuys.length,
        hasCompletion: Boolean(decision.completion),
        hasUnwind: Boolean(decision.unwind),
        plannedMergeShares: decision.mergeShares,
        allowNewEntries: decision.risk.allowNewEntries,
        completionOnly: decision.risk.completionOnly,
        hardCancel: decision.risk.hardCancel,
        ...(decision.completion?.completionReleaseRole !== undefined
          ? { completionReleaseRole: decision.completion.completionReleaseRole }
          : {}),
        ...(decision.completion?.completionCalibrationPatienceMultiplier !== undefined
          ? { completionCalibrationPatienceMultiplier: decision.completion.completionCalibrationPatienceMultiplier }
          : {}),
        ...(decision.completion?.completionRolePatienceMultiplier !== undefined
          ? { completionRolePatienceMultiplier: decision.completion.completionRolePatienceMultiplier }
          : {}),
        ...(decision.completion?.completionEffectivePatienceMultiplier !== undefined
          ? { completionEffectivePatienceMultiplier: decision.completion.completionEffectivePatienceMultiplier }
          : {}),
        ...(decision.completion?.completionWaitUntilSec !== undefined
          ? { completionWaitUntilSec: decision.completion.completionWaitUntilSec }
          : {}),
        entryTrace: decision.trace.entry,
      },
      execution: {
        fills,
        skippedEntrySides,
        skippedCompletion,
        skippedUnwind,
        mergeShares,
        redeemShares,
        ...(redeemSide !== undefined ? { redeemSide } : {}),
        ...(mergePairCost !== undefined ? { mergePairCost } : {}),
        mergeProceeds,
        realizedMergeProfit,
        rawSpend,
        feeUsd,
        effectiveSpend,
      },
      stateAfter: snapshotState(state),
    });
  }

  const totalBuyShares = steps.reduce(
    (acc, step) => acc + step.execution.fills.filter((fill) => fill.action === "BUY").reduce((inner, fill) => inner + fill.size, 0),
    0,
  );
  const totalEntryBuyShares = steps.reduce(
    (acc, step) => acc + step.execution.fills.filter((fill) => fill.kind === "entry").reduce((inner, fill) => inner + fill.size, 0),
    0,
  );
  const totalCompletionShares = steps.reduce(
    (acc, step) => acc + step.execution.fills.filter((fill) => fill.kind === "completion").reduce((inner, fill) => inner + fill.size, 0),
    0,
  );
  const totalUnwindShares = steps.reduce(
    (acc, step) => acc + step.execution.fills.filter((fill) => fill.kind === "unwind").reduce((inner, fill) => inner + fill.size, 0),
    0,
  );
  const totalRawSpend = steps.reduce((acc, step) => acc + step.execution.rawSpend, 0);
  const totalFeeUsd = steps.reduce((acc, step) => acc + step.execution.feeUsd, 0);
  const totalEffectiveSpend = steps.reduce((acc, step) => acc + step.execution.effectiveSpend, 0);
  const totalMergeShares = steps.reduce((acc, step) => acc + step.execution.mergeShares, 0);
  const totalRedeemShares = steps.reduce((acc, step) => acc + step.execution.redeemShares, 0);
  const totalMergeProceeds = steps.reduce((acc, step) => acc + step.execution.mergeProceeds, 0);
  const realizedMergeProfit = steps.reduce((acc, step) => acc + step.execution.realizedMergeProfit, 0);
  const footprint = buildFootprintSummary({
    steps,
    finalUpShares: state.upShares,
    finalDownShares: state.downShares,
  });

  return {
    market: {
      slug: market.slug,
      conditionId: market.conditionId,
      startTs: market.startTs,
      endTs: market.endTs,
    },
    variant,
    summary: {
      stepCount: steps.length,
      entryStepCount: steps.filter((step) => step.execution.fills.some((fill) => fill.kind === "entry")).length,
      completionStepCount: steps.filter((step) => step.execution.fills.some((fill) => fill.kind === "completion")).length,
      mergeStepCount: steps.filter((step) => step.execution.mergeShares > 0).length,
      totalBuyShares,
      totalEntryBuyShares,
      totalCompletionShares,
      totalUnwindShares,
      totalRawSpend,
      totalFeeUsd,
      totalEffectiveSpend,
      totalMergeShares,
      totalRedeemShares,
      totalMergeProceeds,
      realizedMergeProfit,
      roiPct: realizedMergeProfit / Math.max(totalEffectiveSpend, 1e-9) * 100,
      finalUpShares: state.upShares,
      finalDownShares: state.downShares,
      footprint,
    },
    steps,
  };
}
