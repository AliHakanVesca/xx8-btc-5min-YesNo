import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { buildOfflineMarket } from "../infra/gamma/marketDiscovery.js";
import type { OrderBook, OutcomeSide } from "../infra/clob/types.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { averageCost, imbalance, mergeableShares, pairVwapSum } from "../strategy/xuan5m/inventoryState.js";
import { createMarketState, type FillRecord, type XuanMarketState } from "../strategy/xuan5m/marketState.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import type { RiskContext } from "../strategy/xuan5m/riskEngine.js";
import { completionCost, pairCostWithBothTaker, pairEdge } from "../strategy/xuan5m/sumAvgEngine.js";
import { buildAcceptanceReport, type AcceptanceReport } from "./acceptanceMetrics.js";

interface ReplayInventory {
  upShares: number;
  upAvg: number;
  downShares: number;
  downAvg: number;
}

interface ReplayBooks {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
}

interface ReplayScenarioSpec {
  name: string;
  note: string;
  offsetSec: number;
  books: ReplayBooks;
  inventory: ReplayInventory;
  riskOverrides?: Partial<RiskContext>;
}

export interface MultiReplayScenarioResult {
  marketSlug: string;
  windowIndex: number;
  scenarioName: string;
  note: string;
  secsFromOpen: number;
  secsToClose: number;
  phase: string;
  acceptance: AcceptanceReport;
  risk: {
    tradable: boolean;
    allowNewEntries: boolean;
    completionOnly: boolean;
    hardCancel: boolean;
    reasons: string[];
  };
  inventoryBefore: {
    upShares: number;
    downShares: number;
    imbalance: number;
    mergeableShares: number;
    pairVwapSum?: number;
  };
  books: ReplayBooks;
  economics: {
    pairAskSum: number;
    pairTakerCost: number;
    pairEdge: number;
    estimatedCompletionCost?: number;
    completionWithinCap?: boolean;
  };
  orders: {
    entryBuyCount: number;
    balancedPairEntryCount: number;
    laggingRebalanceCount: number;
    totalEntryBuyShares: number;
    entryBuyNotional: number;
    entryBuys: Array<{
      side: OutcomeSide;
      size: number;
      reason: string;
      expectedAveragePrice: number;
      effectivePricePerShare: number;
      tokenId: string;
      price: number;
    }>;
    completion?: {
      sideToBuy: OutcomeSide;
      missingShares: number;
      costWithFees: number;
      tokenId: string;
      price: number;
    };
    unwind?: {
      sideToSell: OutcomeSide;
      unwindShares: number;
      expectedAveragePrice: number;
      tokenId: string;
      price: number;
    };
    mergeShares: number;
  };
}

export interface MultiReplaySummary {
  windowCount: number;
  scenariosPerWindow: number;
  totalScenarioCount: number;
  tradableScenarioCount: number;
  entryBuyScenarioCount: number;
  balancedPairScenarioCount: number;
  laggingRebalanceScenarioCount: number;
  completionScenarioCount: number;
  unwindScenarioCount: number;
  mergeScenarioCount: number;
  completionOnlyScenarioCount: number;
  hardCancelScenarioCount: number;
  totalEntryBuyShares: number;
  totalEntryBuyNotional: number;
  totalCompletionShares: number;
  totalUnwindShares: number;
  totalMergeShares: number;
  averagePairTakerCost: number;
  averageImbalanceBefore: number;
  bestPairEdge: number;
  worstPairEdge: number;
}

export interface MultiReplayReport {
  summary: MultiReplaySummary;
  scenarios: MultiReplayScenarioResult[];
}

const scenarioSpecs: ReplayScenarioSpec[] = [
  {
    name: "open-balanced-entry",
    note: "Opening phase, empty inventory, pair-seed taker buys should open both sides quickly.",
    offsetSec: 15,
    books: { upBid: 0.48, upAsk: 0.49, downBid: 0.48, downAsk: 0.49 },
    inventory: { upShares: 0, upAvg: 0, downShares: 0, downAvg: 0 },
  },
  {
    name: "mid-balanced-entry",
    note: "Mid-window balanced books should still allow another pair-buy rung.",
    offsetSec: 120,
    books: { upBid: 0.47, upAsk: 0.48, downBid: 0.48, downAsk: 0.49 },
    inventory: { upShares: 0, upAvg: 0, downShares: 0, downAvg: 0 },
  },
  {
    name: "mid-rebalance-buy-only",
    note: "When inventory drifts during entry, keep buying only the lagging side instead of forcing a taker repair.",
    offsetSec: 120,
    books: { upBid: 0.48, upAsk: 0.49, downBid: 0.48, downAsk: 0.49 },
    inventory: { upShares: 40, upAvg: 0.48, downShares: 10, downAvg: 0.49 },
  },
  {
    name: "profitable-completion",
    note: "After entry cut-off, one-sided UP inventory should trigger taker completion on DOWN and immediate merge readiness.",
    offsetSec: 245,
    books: { upBid: 0.45, upAsk: 0.46, downBid: 0.48, downAsk: 0.49 },
    inventory: { upShares: 60, upAvg: 0.46, downShares: 0, downAvg: 0 },
  },
  {
    name: "expensive-completion-blocked",
    note: "Completion should be rejected because fee-inclusive pair cost exceeds cap.",
    offsetSec: 245,
    books: { upBid: 0.45, upAsk: 0.46, downBid: 0.54, downAsk: 0.55 },
    inventory: { upShares: 60, upAvg: 0.46, downShares: 0, downAvg: 0 },
  },
  {
    name: "merge-queue",
    note: "Balanced inventory should go straight into merge queue.",
    offsetSec: 150,
    books: { upBid: 0.47, upAsk: 0.48, downBid: 0.47, downAsk: 0.48 },
    inventory: { upShares: 90, upAvg: 0.47, downShares: 90, downAvg: 0.48 },
  },
  {
    name: "late-residual-hold",
    note: "When completion is too expensive late in the window, buy-only mode should avoid SELL unwind and carry only the residual.",
    offsetSec: 286,
    books: { upBid: 0.43, upAsk: 0.44, downBid: 0.54, downAsk: 0.55 },
    inventory: { upShares: 60, upAvg: 0.46, downShares: 0, downAvg: 0 },
  },
  {
    name: "hard-cancel-window",
    note: "Final seconds should disable new entries and leave only cancel/cleanup path.",
    offsetSec: 293,
    books: { upBid: 0.49, upAsk: 0.5, downBid: 0.49, downAsk: 0.5 },
    inventory: { upShares: 0, upAvg: 0, downShares: 0, downAvg: 0 },
  },
];

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

function seedFillHistory(inventory: ReplayInventory, timestamp: number): FillRecord[] {
  const fills: FillRecord[] = [];

  if (inventory.upShares > 0) {
    fills.push({
      outcome: "UP",
      side: "BUY",
      price: inventory.upAvg,
      size: inventory.upShares,
      timestamp: timestamp - 45,
      makerTaker: "taker",
    });
  }

  if (inventory.downShares > 0) {
    fills.push({
      outcome: "DOWN",
      side: "BUY",
      price: inventory.downAvg,
      size: inventory.downShares,
      timestamp: timestamp - 30,
      makerTaker: "taker",
    });
  }

  return fills;
}

function buildSeededState(
  marketStartTs: number,
  spec: ReplayScenarioSpec,
): { market: ReturnType<typeof buildOfflineMarket>; state: XuanMarketState; nowTs: number; books: OrderBookState } {
  const market = buildOfflineMarket(marketStartTs);
  const nowTs = market.startTs + spec.offsetSec;
  const state = createMarketState(market);
  state.upShares = spec.inventory.upShares;
  state.downShares = spec.inventory.downShares;
  state.upCost = spec.inventory.upShares * spec.inventory.upAvg;
  state.downCost = spec.inventory.downShares * spec.inventory.downAvg;
  state.fillHistory = seedFillHistory(spec.inventory, nowTs);

  const books = new OrderBookState(
    buildSyntheticBook(market.tokens.UP.tokenId, market.conditionId, spec.books.upBid, spec.books.upAsk),
    buildSyntheticBook(market.tokens.DOWN.tokenId, market.conditionId, spec.books.downBid, spec.books.downAsk),
  );

  return { market, state, nowTs, books };
}

function buildRiskContext(spec: ReplayScenarioSpec, marketEndTs: number, nowTs: number): RiskContext {
  return {
    secsToClose: marketEndTs - nowTs,
    staleBookMs: 200,
    balanceStaleMs: 200,
    bookIsCrossed: false,
    dailyLossUsdc: 0,
    marketLossUsdc: 0,
    usdcBalance: 100,
    ...spec.riskOverrides,
  };
}

function runSingleScenario(
  env: AppEnv,
  marketStartTs: number,
  windowIndex: number,
  spec: ReplayScenarioSpec,
): MultiReplayScenarioResult {
  const config = buildStrategyConfig(env);
  const bot = new Xuan5mBot();
  const { market, state, nowTs, books } = buildSeededState(marketStartTs, spec);
  const riskContext = buildRiskContext(spec, market.endTs, nowTs);
  const decision = bot.evaluateTick({
    config,
    state,
    books,
    nowTs,
    riskContext,
    dryRunOrSmallLive: true,
  });

  const pairAskSum = books.bestAsk("UP") + books.bestAsk("DOWN");
  const pairTakerCost = pairCostWithBothTaker(books.bestAsk("UP"), books.bestAsk("DOWN"), config.cryptoTakerFeeRate);
  const totalInventory = state.upShares + state.downShares;
  const completionEstimate =
    state.upShares === state.downShares
      ? undefined
      : completionCost(
          averageCost(state, state.upShares > state.downShares ? "UP" : "DOWN"),
          books.bestAsk(state.upShares > state.downShares ? "DOWN" : "UP"),
          config.cryptoTakerFeeRate,
        );
  const acceptance = buildAcceptanceReport(decision);
  const entryBuys = decision.entryBuys.map((entryBuy) => ({
    side: entryBuy.side,
    size: entryBuy.size,
    reason: entryBuy.reason,
    expectedAveragePrice: entryBuy.expectedAveragePrice,
    effectivePricePerShare: entryBuy.effectivePricePerShare,
    tokenId: entryBuy.order.tokenId,
    price: entryBuy.order.price ?? 0,
  }));
  const balancedPairEntryCount = decision.entryBuys.filter((entryBuy) => entryBuy.reason !== "lagging_rebalance").length;
  const laggingRebalanceCount = decision.entryBuys.filter((entryBuy) => entryBuy.reason === "lagging_rebalance").length;
  const totalEntryBuyShares = decision.entryBuys.reduce((acc, order) => acc + order.size, 0);
  const entryBuyNotional = decision.entryBuys.reduce(
    (acc, order) => acc + order.size * order.expectedAveragePrice,
    0,
  );

  return {
    marketSlug: market.slug,
    windowIndex,
    scenarioName: spec.name,
    note: spec.note,
    secsFromOpen: spec.offsetSec,
    secsToClose: market.endTs - nowTs,
    phase: decision.phase,
    acceptance,
    risk: {
      tradable: decision.risk.tradable,
      allowNewEntries: decision.risk.allowNewEntries,
      completionOnly: decision.risk.completionOnly,
      hardCancel: decision.risk.hardCancel,
      reasons: decision.risk.reasons,
    },
    inventoryBefore: {
      upShares: state.upShares,
      downShares: state.downShares,
      imbalance: imbalance(state),
      mergeableShares: mergeableShares(state),
      ...(totalInventory > 0 ? { pairVwapSum: pairVwapSum(state) } : {}),
    },
    books: spec.books,
    economics: {
      pairAskSum,
      pairTakerCost,
      pairEdge: pairEdge(pairTakerCost),
      ...(completionEstimate !== undefined ? { estimatedCompletionCost: completionEstimate } : {}),
      ...(completionEstimate !== undefined ? { completionWithinCap: completionEstimate <= config.completionCap } : {}),
    },
    orders: {
      entryBuyCount: decision.entryBuys.length,
      balancedPairEntryCount,
      laggingRebalanceCount,
      totalEntryBuyShares,
      entryBuyNotional,
      entryBuys,
      ...(decision.completion
        ? {
            completion: {
              sideToBuy: decision.completion.sideToBuy,
              missingShares: decision.completion.missingShares,
              costWithFees: decision.completion.costWithFees,
              tokenId: decision.completion.order.tokenId,
              price: decision.completion.order.price ?? 0,
            },
          }
        : {}),
      ...(decision.unwind
        ? {
            unwind: {
              sideToSell: decision.unwind.sideToSell,
              unwindShares: decision.unwind.unwindShares,
              expectedAveragePrice: decision.unwind.expectedAveragePrice,
              tokenId: decision.unwind.order.tokenId,
              price: decision.unwind.order.price ?? 0,
            },
          }
        : {}),
      mergeShares: decision.mergeShares,
    },
  };
}

function summarize(results: MultiReplayScenarioResult[], windowCount: number): MultiReplaySummary {
  const pairCosts = results.map((result) => result.economics.pairTakerCost);
  const imbalances = results.map((result) => result.inventoryBefore.imbalance);

  return {
    windowCount,
    scenariosPerWindow: scenarioSpecs.length,
    totalScenarioCount: results.length,
    tradableScenarioCount: results.filter((result) => result.risk.tradable).length,
    entryBuyScenarioCount: results.filter((result) => result.orders.entryBuyCount > 0).length,
    balancedPairScenarioCount: results.filter((result) => result.orders.balancedPairEntryCount > 0).length,
    laggingRebalanceScenarioCount: results.filter((result) => result.orders.laggingRebalanceCount > 0).length,
    completionScenarioCount: results.filter((result) => result.acceptance.hasCompletion).length,
    unwindScenarioCount: results.filter((result) => result.acceptance.hasUnwind).length,
    mergeScenarioCount: results.filter((result) => result.orders.mergeShares > 0).length,
    completionOnlyScenarioCount: results.filter((result) => result.risk.completionOnly).length,
    hardCancelScenarioCount: results.filter((result) => result.risk.hardCancel).length,
    totalEntryBuyShares: results.reduce((acc, result) => acc + result.orders.totalEntryBuyShares, 0),
    totalEntryBuyNotional: results.reduce((acc, result) => acc + result.orders.entryBuyNotional, 0),
    totalCompletionShares: results.reduce(
      (acc, result) => acc + (result.orders.completion?.missingShares ?? 0),
      0,
    ),
    totalUnwindShares: results.reduce((acc, result) => acc + (result.orders.unwind?.unwindShares ?? 0), 0),
    totalMergeShares: results.reduce((acc, result) => acc + result.orders.mergeShares, 0),
    averagePairTakerCost: pairCosts.reduce((acc, value) => acc + value, 0) / Math.max(pairCosts.length, 1),
    averageImbalanceBefore: imbalances.reduce((acc, value) => acc + value, 0) / Math.max(imbalances.length, 1),
    bestPairEdge: Math.max(...results.map((result) => result.economics.pairEdge)),
    worstPairEdge: Math.min(...results.map((result) => result.economics.pairEdge)),
  };
}

export function runMultiSyntheticReplay(env: AppEnv, windowCount = 3): MultiReplayReport {
  const boundedWindowCount = Math.max(1, Math.floor(windowCount));
  const baseStartTs = Math.floor(Date.now() / 1000 / 300) * 300;
  const scenarios: MultiReplayScenarioResult[] = [];

  for (let windowIndex = 0; windowIndex < boundedWindowCount; windowIndex += 1) {
    const marketStartTs = baseStartTs + windowIndex * 300;
    for (const spec of scenarioSpecs) {
      scenarios.push(runSingleScenario(env, marketStartTs, windowIndex, spec));
    }
  }

  return {
    summary: summarize(scenarios, boundedWindowCount),
    scenarios,
  };
}
