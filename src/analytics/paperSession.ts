import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { buildOfflineMarket } from "../infra/gamma/marketDiscovery.js";
import { SystemClock } from "../infra/time/clock.js";
import type { OrderBook, OutcomeSide } from "../infra/clob/types.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { createMarketState, type FillRecord, type XuanMarketState } from "../strategy/xuan5m/marketState.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import { applyFill, applyMerge, averageCost, pairVwapSum } from "../strategy/xuan5m/inventoryState.js";
import { planMerge } from "../strategy/xuan5m/mergeCoordinator.js";
import { takerFeePerShare } from "../strategy/xuan5m/sumAvgEngine.js";
import type { FairValueSnapshot } from "../strategy/xuan5m/fairValueEngine.js";
import { buildFootprintSummary, type FootprintSummary } from "./footprintMetrics.js";

export type PaperSessionVariant = "xuan-flow" | "blocked-completion";

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
  mergePolicy?: "auto" | "skip";
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
  };
  execution: {
    fills: PaperSessionFillEvent[];
    skippedEntrySides: OutcomeSide[];
    skippedCompletion: boolean;
    skippedUnwind: boolean;
    mergeShares: number;
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

function shouldFillEntry(step: PaperSessionStepSpec, entryBuySide: OutcomeSide, entryBuyCount: number): boolean {
  const policy = step.entryFillPolicy ?? "all";
  if (entryBuyCount <= 1) {
    return policy !== "none";
  }
  if (policy === "all") {
    return true;
  }
  if (policy === "none") {
    return false;
  }
  return policy === "up-only" ? entryBuySide === "UP" : entryBuySide === "DOWN";
}

function buildFillEvent(args: {
  kind: PaperSessionFillEvent["kind"];
  side: OutcomeSide;
  action: "BUY" | "SELL";
  size: number;
  price: number;
  reason: string;
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

export function runPaperSession(env: AppEnv, variant: PaperSessionVariant = "xuan-flow"): PaperSessionReport {
  const config = buildStrategyConfig(env);
  const bot = new Xuan5mBot();
  const clock = new SystemClock();
  const startTs = Math.floor(clock.now() / 300) * 300;
  const market = buildOfflineMarket(startTs);
  let state = createMarketState(market);
  let effectiveCostState: EffectiveCostState = { up: 0, down: 0 };
  const steps: PaperSessionStepResult[] = [];

  for (const step of sessionVariants[variant]) {
    const nowTs = market.startTs + step.offsetSec;
    const books = new OrderBookState(
      buildSyntheticBook(market.tokens.UP.tokenId, market.conditionId, step.books.upBid, step.books.upAsk),
      buildSyntheticBook(market.tokens.DOWN.tokenId, market.conditionId, step.books.downBid, step.books.downAsk),
    );
    const stateBefore = snapshotState(state);
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
    });

    const fills: PaperSessionFillEvent[] = [];
    const skippedEntrySides: OutcomeSide[] = [];
    let skippedCompletion = false;
    let skippedUnwind = false;

    for (const entryBuy of decision.entryBuys) {
      if (!shouldFillEntry(step, entryBuy.side, decision.entryBuys.length)) {
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
      });
      fills.push(fillEvent);
      effectiveCostState = applyEffectiveFill(effectiveCostState, state, fillEvent);
      state = applySyntheticFill(state, fillEvent, nowTs);
    }

    if (decision.completion) {
      if (step.completionFill ?? true) {
        const fillEvent = buildFillEvent({
          kind: "completion",
          side: decision.completion.sideToBuy,
          action: "BUY",
          size: decision.completion.missingShares,
          price: decision.completion.order.price ?? 0,
          reason: decision.completion.capMode,
        });
        fills.push(fillEvent);
        effectiveCostState = applyEffectiveFill(effectiveCostState, state, fillEvent);
        state = applySyntheticFill(state, fillEvent, nowTs);
      } else {
        skippedCompletion = true;
      }
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
        });
        fills.push(fillEvent);
        effectiveCostState = applyEffectiveFill(effectiveCostState, state, fillEvent);
        state = applySyntheticFill(state, fillEvent, nowTs);
      } else {
        skippedUnwind = true;
      }
    }

    const mergePlan = planMerge(config, state);
    const mergeShares = step.mergePolicy === "skip" ? 0 : mergePlan.shouldMerge ? mergePlan.mergeable : 0;
    const { nextCostState, pairCost: mergePairCost } = applyEffectiveMerge(effectiveCostState, state, mergeShares);
    const mergeProceeds = mergeShares;
    const realizedMergeProfit =
      mergePairCost !== undefined ? mergeShares * (1 - mergePairCost) : 0;

    if (mergeShares > 0) {
      effectiveCostState = nextCostState;
      state = applyMerge(state, {
        amount: mergeShares,
        timestamp: nowTs,
        simulated: true,
      });
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
      },
      execution: {
        fills,
        skippedEntrySides,
        skippedCompletion,
        skippedUnwind,
        mergeShares,
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
