import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig, type XuanStrategyConfig } from "../config/strategyPresets.js";
import { createClobAdapter } from "../infra/clob/index.js";
import type { MarketInfo, OrderBook, OutcomeSide, TradeSide } from "../infra/clob/types.js";
import type { MarketOrderArgs, OrderResult } from "../infra/clob/types.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { Erc1155BalanceReader } from "../infra/polygon/erc1155Balances.js";
import { Erc20BalanceReader } from "../infra/polygon/erc20Balances.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { UserWsClient, type UserOrderEvent, type UserTradeEvent } from "../infra/ws/userWsClient.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { BtcPriceFeed } from "../infra/ws/btcPriceFeed.js";
import { SystemClock } from "../infra/time/clock.js";
import { CtfClient } from "../infra/ctf/ctfClient.js";
import { createLogger, writeStructuredLog } from "../observability/logger.js";
import { JsonlTraceLogger } from "../observability/jsonlTrace.js";
import { renderDashboard } from "../observability/dashboard.js";
import { OrderManager } from "../execution/orderManager.js";
import {
  applyPairOrderType,
  createPairOrderGroup,
  extractMatchedShares,
  finalizePairExecutionResult,
  resolvePairOrderGroupStatus,
  type PairExecutionResult,
  type PairOrderGroup,
  type PairOrderGroupStatus,
} from "../execution/pairOrderGroup.js";
import { TakerCompletionManager } from "../execution/takerCompletionManager.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import { createMarketState, type FillRecord, type XuanMarketState } from "../strategy/xuan5m/marketState.js";
import { applyFill, applyMerge, averageCost, shrinkOutcomeToObservedShares } from "../strategy/xuan5m/inventoryState.js";
import { chooseInventoryAdjustment } from "../strategy/xuan5m/completionEngine.js";
import {
  createMergeBatchTracker,
  evaluateDelayedMergeGate,
  planMerge,
  syncMergeBatchTracker,
} from "../strategy/xuan5m/mergeCoordinator.js";
import { estimateNegativeEdgeUsdc } from "../strategy/xuan5m/modePolicy.js";
import { resolveConfiguredFunderAddress } from "./topology.js";
import { isClassifiedBuyMode, type StrategyExecutionMode } from "../strategy/xuan5m/executionModes.js";
import type { EntryBuyDecision } from "../strategy/xuan5m/entryLadderEngine.js";
import {
  buildInventoryActionPlan,
  executeInventoryActionPlan,
  fetchInventorySnapshot,
  type InventoryMarketView,
} from "./inventoryManager.js";
import { isOrderResultAccepted, summarizeOrderResult } from "../infra/clob/orderResult.js";
import { PersistentStateStore } from "./persistentStateStore.js";
import { MarketFairValueRuntime } from "./fairValueRuntime.js";
import type { FairValueSnapshot } from "../strategy/xuan5m/fairValueEngine.js";
import { planCloneChildBuyOrders } from "./childOrderPlanner.js";

export interface BotSessionOptions {
  durationSec?: number;
  postCloseReconcileSec?: number;
  tickMs?: number;
  initialBookWaitMs?: number;
  balanceSyncMs?: number;
  marketSelection?: "auto" | "current" | "next";
  initialDailyNegativeEdgeSpentUsdc?: number;
  dailyBudgetStorePath?: string;
}

export interface ObservedTokenBalances {
  up: number;
  down: number;
}

export interface BalanceCorrection {
  outcome: OutcomeSide;
  fromShares: number;
  toShares: number;
}

export interface BalanceShortfallCandidate extends BalanceCorrection {
  nowTs: number;
}

export interface StateReconcileResult {
  state: XuanMarketState;
  inferredFills: FillRecord[];
  corrections: BalanceCorrection[];
}

export interface SubmittedIntent {
  side: TradeSide;
  price?: number | undefined;
  submittedAt: number;
  mode?: StrategyExecutionMode | undefined;
  groupId?: string | undefined;
  orderId?: string | undefined;
  expectedShares?: number | undefined;
  attributedShares: number;
  active: boolean;
}

type SubmittedIntentBook = Partial<Record<OutcomeSide, SubmittedIntent[]>>;

interface ExecutedMarketOrder {
  order: MarketOrderArgs;
  result: OrderResult;
}

type PairOrderPlan = Record<OutcomeSide, MarketOrderArgs[]>;

export interface BotSessionReport {
  runtime: {
    mode: "live";
    stackMode: AppEnv["POLY_STACK_MODE"];
    useClobV2: boolean;
    clobBaseUrl: string;
    signatureType: number;
    funder: string;
    activeCollateralToken: string;
    activeCollateralSymbol: AppEnv["ACTIVE_COLLATERAL_SYMBOL"];
    ctfMergeEnabled: boolean;
  };
  market: {
    selection: "current" | "next";
    slug: string;
    conditionId: string;
    startTs: number;
    endTs: number;
    upTokenId: string;
    downTokenId: string;
  };
  options: Required<BotSessionOptions>;
  summary: {
    startedAt: number;
    endedAt: number;
    ticks: number;
    userTradeCount: number;
    balanceSyncCount: number;
    balanceCorrectionCount: number;
    entrySubmitCount: number;
    pairGroupCount: number;
    partialLegCount: number;
    completionSubmitCount: number;
    unwindSubmitCount: number;
    mergeCount: number;
    adoptedInventory: boolean;
  };
  finalState: {
    upShares: number;
    downShares: number;
    upAverage: number;
    downAverage: number;
    fillCount: number;
    mergeCount: number;
    negativeEdgeConsumedUsdc: number;
    negativePairEdgeConsumedUsdc: number;
    negativeCompletionEdgeConsumedUsdc: number;
    initialDailyNegativeEdgeSpentUsdc: number;
    finalDailyNegativeEdgeSpentUsdc: number;
  };
  finalDecision: ReturnType<Xuan5mBot["evaluateTick"]>;
  dashboard: string;
  events: Array<Record<string, unknown>>;
}

interface PendingPairExecution {
  group: PairOrderGroup;
  upResult: PairExecutionResult["upResult"];
  downResult: PairExecutionResult["downResult"];
  negativeEdgeUsdc: number;
  deadlineAt: number;
  status: PairOrderGroupStatus;
  submittedAt: number;
  reconciledAfterSubmit: boolean;
}

interface PartialOpenGroupLock {
  groupId: string;
  status: Extract<PairOrderGroupStatus, "UP_ONLY" | "DOWN_ONLY">;
  openedAt: number;
}

interface ActivePairSubmission {
  groupId: string;
  expiresAt: number;
  entries: Array<{
    outcome: OutcomeSide;
    price?: number | undefined;
    expectedShares?: number | undefined;
    mode?: StrategyExecutionMode | undefined;
  }>;
}

interface RecentBotOwnedBuyFill {
  outcome: OutcomeSide;
  size: number;
  price: number;
  timestamp: number;
  expiresAt: number;
  groupId?: string | undefined;
  orderId?: string | undefined;
}

const DECISION_TRACE_INTERVAL_SEC = 20;
const BOT_OWNED_ZERO_BALANCE_GRACE_SEC = 3;

interface DecisionTraceContext {
  eventSeq: number;
  decisionLatencyMs: number;
  bookAgeMsUp: number;
  bookAgeMsDown: number;
}

function normalizeMergeAmount(mergeable: number, dustLeaveShares: number): number {
  return Number(Math.max(0, mergeable - Math.max(0, dustLeaveShares)).toFixed(6));
}

function computePendingLockedShares(
  pending: PendingPairExecution | undefined,
  fillSnapshot: { upBoughtQty: number; downBoughtQty: number } | undefined,
  config: Pick<XuanStrategyConfig, "lockReservedQtyForPendingOrders">,
): { up: number; down: number } {
  if (!pending || !config.lockReservedQtyForPendingOrders) {
    return { up: 0, down: 0 };
  }
  return {
    up: Number((fillSnapshot?.upBoughtQty ?? 0).toFixed(6)),
    down: Number((fillSnapshot?.downBoughtQty ?? 0).toFixed(6)),
  };
}

function unlockedMergeableShares(
  state: XuanMarketState,
  locked: { up: number; down: number },
): number {
  return Number(
    Math.min(
      Math.max(0, state.upShares - locked.up),
      Math.max(0, state.downShares - locked.down),
    ).toFixed(6),
  );
}

function shouldAllowControlledOverlap(args: {
  config: Pick<
    XuanStrategyConfig,
    | "allowControlledOverlap"
    | "allowOverlapOnlyAfterPartialClassified"
    | "allowOverlapOnlyWhenCompletionEngineActive"
    | "allowOverlapInLast30S"
    | "finalWindowCompletionOnlySec"
    | "partialFastWindowSec"
    | "partialPatientWindowSec"
    | "maxOpenGroupsPerMarket"
    | "maxOpenPartialGroups"
    | "requireMatchedInventoryBeforeSecondGroup"
    | "worstCaseAmplificationToleranceShares"
  >;
  nowTs: number;
  secsToClose: number;
  partialOpenGroupLock: PartialOpenGroupLock | undefined;
  completionActive: boolean;
  linkageHealthy: boolean;
  entryBuys: EntryBuyDecision[];
  matchedInventoryTargetMet: boolean;
  worstCaseAmplificationShares: number;
}): boolean {
  if (!args.config.allowControlledOverlap) {
    return false;
  }
  if (!args.partialOpenGroupLock || args.entryBuys.length !== 2) {
    return false;
  }
  if (args.config.maxOpenGroupsPerMarket < 2 || args.config.maxOpenPartialGroups < 1) {
    return false;
  }
  if (!args.config.allowOverlapInLast30S && args.secsToClose <= args.config.finalWindowCompletionOnlySec) {
    return false;
  }
  const partialAgeSec = Math.max(0, args.nowTs - args.partialOpenGroupLock.openedAt);
  if (partialAgeSec < args.config.partialFastWindowSec) {
    return false;
  }
  if (partialAgeSec >= args.config.partialPatientWindowSec) {
    return false;
  }
  if (args.config.allowOverlapOnlyAfterPartialClassified && !args.linkageHealthy) {
    return false;
  }
  if (args.config.allowOverlapOnlyWhenCompletionEngineActive && !args.completionActive) {
    return false;
  }
  if (args.config.requireMatchedInventoryBeforeSecondGroup && !args.matchedInventoryTargetMet) {
    return false;
  }
  if (args.worstCaseAmplificationShares > args.config.worstCaseAmplificationToleranceShares + 1e-6) {
    return false;
  }
  return true;
}

function isReplayComparatorStatus(status: string | undefined): status is "pass" | "warn" | "fail" {
  return status === "pass" || status === "warn" || status === "fail";
}

function computeWorstCaseAmplificationShares(
  state: Pick<XuanMarketState, "upShares" | "downShares">,
  entryBuys: EntryBuyDecision[],
): number {
  const baseGap = Math.abs(state.upShares - state.downShares);
  return Number(
    entryBuys
      .map((entryBuy) => {
        const nextUp = state.upShares + (entryBuy.side === "UP" ? entryBuy.size : 0);
        const nextDown = state.downShares + (entryBuy.side === "DOWN" ? entryBuy.size : 0);
        const nextGap = Math.abs(nextUp - nextDown);
        return Math.max(0, nextGap - baseGap);
      })
      .reduce((worst, value) => Math.max(worst, value), 0)
      .toFixed(6),
  );
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

function parseNumeric(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOutcome(value: string | undefined): OutcomeSide | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "UP" || normalized === "YES") {
    return "UP";
  }
  if (normalized === "DOWN" || normalized === "NO") {
    return "DOWN";
  }
  return undefined;
}

function outcomeForAssetId(market: MarketInfo, assetId: string): OutcomeSide | undefined {
  if (assetId === market.tokens.UP.tokenId) {
    return "UP";
  }
  if (assetId === market.tokens.DOWN.tokenId) {
    return "DOWN";
  }
  return undefined;
}

function clampFallbackPrice(price: number | undefined): number {
  if (price !== undefined && Number.isFinite(price) && price > 0) {
    return price;
  }
  return 0.5;
}

function normalizeShares(value: number): number {
  return Number(value.toFixed(6));
}

function pushEvent(events: Array<Record<string, unknown>>, event: Record<string, unknown>, limit = 200): void {
  events.push(event);
  if (events.length > limit) {
    events.shift();
  }
}

function emitLiveMirror(eventType: string, payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      tsIso: new Date().toISOString(),
      eventType,
      ...payload,
    }),
  );
}

function buildDecisionTraceEvent(
  decision: ReturnType<Xuan5mBot["evaluateTick"]>,
  context: DecisionTraceContext,
): Record<string, unknown> {
  const candidateCaps = decision.trace.entry.candidates.map((candidate) => ({
    qty: candidate.requestedSize,
    rawPair: candidate.rawPairCost,
    effectivePair: candidate.pairCost,
    negativeEdgeUsdc: candidate.negativeEdgeUsdc,
    selectedMode: candidate.selectedMode ?? null,
    gateReason: candidate.gateReason ?? null,
    upOrphanReason: candidate.upOrphanRisk?.reason ?? null,
    downOrphanReason: candidate.downOrphanRisk?.reason ?? null,
    upOrphanFairPremium: candidate.upOrphanRisk?.fairPremium ?? null,
    downOrphanFairPremium: candidate.downOrphanRisk?.fairPremium ?? null,
  }));
  const bestEffectivePair =
    decision.trace.entry.candidates.length > 0
      ? Math.min(...decision.trace.entry.candidates.map((candidate) => candidate.pairCost))
      : null;
  const bestRawPair =
    decision.trace.entry.candidates.length > 0
      ? Math.min(...decision.trace.entry.candidates.map((candidate) => candidate.rawPairCost))
      : null;
  return {
    eventSeq: context.eventSeq,
    decisionLatencyMs: context.decisionLatencyMs,
    bookAgeMsUp: context.bookAgeMsUp,
    bookAgeMsDown: context.bookAgeMsDown,
    phase: decision.phase,
    allowNewEntries: decision.risk.allowNewEntries,
    completionOnly: decision.risk.completionOnly,
    hardCancel: decision.risk.hardCancel,
    riskReasons: decision.risk.reasons,
    secsFromOpen: decision.trace.secsFromOpen,
    secsToClose: decision.trace.secsToClose,
    lot: decision.trace.lot,
    totalShares: decision.trace.totalShares,
    shareGap: decision.trace.shareGap,
    inventoryBalanced: decision.trace.inventoryBalanced,
    bestAskUp: decision.trace.bestAskUp,
    bestAskDown: decision.trace.bestAskDown,
    pairCap: decision.trace.pairCap,
    pairTakerCost: decision.trace.pairTakerCost,
    selectedMode: decision.trace.selectedMode ?? null,
    fairValueStatus: decision.trace.fairValue?.status ?? null,
    fairValuePriceToBeat: decision.trace.fairValue?.priceToBeat ?? null,
    fairValueLivePrice: decision.trace.fairValue?.livePrice ?? null,
    fairValueUp: decision.trace.fairValue?.fairUp ?? null,
    fairValueDown: decision.trace.fairValue?.fairDown ?? null,
    fairValueEstimatedThreshold: decision.trace.fairValue?.estimatedThreshold ?? null,
    bestEffectivePair,
    bestRawPair,
    wouldTradeAtCap_1_005: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.005),
    wouldTradeAtCap_1_025: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.025),
    wouldTradeAtCap_1_035: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.035),
    wouldTradeAtCap_1_055: Boolean(bestEffectivePair !== null && bestEffectivePair <= 1.055),
    qtyCaps: candidateCaps,
    entryMode: decision.trace.entry.mode,
    entrySkipReason: decision.trace.entry.skipReason ?? null,
    gatedByRisk: decision.trace.entry.gatedByRisk ?? false,
    laggingSide: decision.trace.entry.laggingSide ?? null,
    repairSize: decision.trace.entry.repairSize ?? null,
    repairFilledSize: decision.trace.entry.repairFilledSize ?? null,
    repairCost: decision.trace.entry.repairCost ?? null,
    repairAllowed: decision.trace.entry.repairAllowed ?? null,
    repairCapMode: decision.trace.entry.repairCapMode ?? null,
    candidates: decision.trace.entry.candidates,
    seedCandidates: decision.trace.entry.seedCandidates ?? [],
  };
}

function decisionTraceSignature(decision: ReturnType<Xuan5mBot["evaluateTick"]>): string {
  const entry = decision.trace.entry;
  const candidateSignature = entry.candidates
    .map((candidate) => `${candidate.requestedSize}:${candidate.verdict}:${candidate.pairCost.toFixed(6)}`)
    .join("|");
  const seedSignature = (entry.seedCandidates ?? [])
    .map(
      (candidate) =>
        `${candidate.side}:${candidate.allowed ? "ok" : candidate.skipReason ?? "skip"}:${candidate.referencePairCost.toFixed(6)}`,
    )
    .join("|");

  return [
    decision.phase,
    decision.risk.allowNewEntries ? "entry_on" : "entry_off",
    decision.risk.completionOnly ? "completion_only" : "normal",
    decision.risk.hardCancel ? "hard_cancel" : "soft",
    decision.risk.reasons.join(","),
    decision.trace.fairValue?.status ?? "",
    decision.trace.fairValue?.fairUp?.toFixed(4) ?? "",
    decision.trace.fairValue?.fairDown?.toFixed(4) ?? "",
    entry.mode,
    entry.skipReason ?? "",
    entry.gatedByRisk ? "gated" : "open",
    candidateSignature,
    seedSignature,
    entry.repairAllowed === undefined ? "" : entry.repairAllowed ? "repair_ok" : "repair_blocked",
    entry.repairCost?.toFixed(6) ?? "",
  ].join("::");
}

function pickSessionMarket(
  market: { current: MarketInfo; next: MarketInfo },
  nowTs: number,
  normalEntryCutoffSecToClose: number,
): { selection: "current" | "next"; market: MarketInfo } {
  const secsToCurrentClose = market.current.endTs - nowTs;
  if (secsToCurrentClose <= normalEntryCutoffSecToClose) {
    return { selection: "next", market: market.next };
  }
  return { selection: "current", market: market.current };
}

async function waitForInitialBooks(
  client: MarketWsClient,
  market: MarketInfo,
  initialBookWaitMs: number,
): Promise<{ upBook: OrderBook; downBook: OrderBook }> {
  const waitDeadline = Date.now() + initialBookWaitMs;

  while (Date.now() < waitDeadline) {
    const upBook = client.getBook(market.tokens.UP.tokenId);
    const downBook = client.getBook(market.tokens.DOWN.tokenId);
    if (upBook && downBook) {
      return { upBook, downBook };
    }
    await sleep(250);
  }

  throw new Error("Initial orderbooks were not received before timeout.");
}

async function readObservedBalances(
  reader: Erc1155BalanceReader,
  market: MarketInfo,
  ownerAddress: string,
): Promise<ObservedTokenBalances> {
  const balances = await reader.getBalances([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId], ownerAddress);
  return {
    up: balances.get(String(market.tokens.UP.tokenId)) ?? 0,
    down: balances.get(String(market.tokens.DOWN.tokenId)) ?? 0,
  };
}

async function readCollateralBalanceUsdc(env: AppEnv): Promise<number | undefined> {
  if (!env.ACTIVE_COLLATERAL_TOKEN || env.ACTIVE_COLLATERAL_TOKEN === "0x0000000000000000000000000000000000000000") {
    return undefined;
  }
  const reader = new Erc20BalanceReader(env);
  const raw = await reader.getBalance(env.ACTIVE_COLLATERAL_TOKEN, resolveConfiguredFunderAddress(env));
  return raw / 1_000_000;
}

export function inferUserTradeFill(args: {
  event: UserTradeEvent;
  market: MarketInfo;
  nowTs: number;
  submittedPrices: SubmittedIntentBook;
}): FillRecord | undefined {
  const outcome = normalizeOutcome(args.event.outcome) ?? outcomeForAssetId(args.market, args.event.asset_id);
  if (!outcome) {
    return undefined;
  }

  const makerOrders = args.event.maker_orders ?? [];
  const matchedSize = makerOrders.reduce((acc, order) => acc + (parseNumeric(order.matched_amount) ?? 0), 0);
  if (matchedSize <= 0) {
    return undefined;
  }

  const weightedNotional = makerOrders.reduce(
    (acc, order) => acc + (parseNumeric(order.matched_amount) ?? 0) * (parseNumeric(order.price) ?? 0),
    0,
  );
  const weightedPrice = matchedSize > 0 ? weightedNotional / matchedSize : undefined;
  const fallbackIntent = latestSubmittedIntent(args.submittedPrices, outcome);
  const price = parseNumeric(args.event.price) ?? weightedPrice ?? fallbackIntent?.price;
  const makerSide = makerOrders[0]?.side?.toUpperCase();
  const side: TradeSide =
    fallbackIntent?.side ??
    (makerSide === "BUY" ? "SELL" : "BUY");

  return {
    outcome,
    side,
    price: clampFallbackPrice(price),
    size: Number(matchedSize.toFixed(6)),
    timestamp: args.nowTs,
    makerTaker: "taker",
    executionMode: fallbackIntent?.mode,
  };
}

export function reconcileStateWithBalances(args: {
  state: XuanMarketState;
  observed: ObservedTokenBalances;
  nowTs: number;
  fallbackPrices: Record<OutcomeSide, number | undefined>;
  shouldIgnoreShortfall?: ((candidate: BalanceShortfallCandidate) => boolean) | undefined;
}): StateReconcileResult {
  let state = { ...args.state };
  const inferredFills: FillRecord[] = [];
  const corrections: BalanceCorrection[] = [];

  const reconcileOutcome = (outcome: OutcomeSide, observedShares: number): void => {
    const sharesKey = outcome === "UP" ? "upShares" : "downShares";
    const currentShares = state[sharesKey];
    const normalizedObserved = Number(observedShares.toFixed(6));

    if (normalizedObserved > currentShares + 1e-6) {
      const fill: FillRecord = {
        outcome,
        side: "BUY",
        price: clampFallbackPrice(args.fallbackPrices[outcome]),
        size: Number((normalizedObserved - currentShares).toFixed(6)),
        timestamp: args.nowTs,
        makerTaker: "unknown",
      };
      state = applyFill(state, fill);
      inferredFills.push(fill);
      return;
    }

    if (normalizedObserved < currentShares - 1e-6) {
      const candidate: BalanceShortfallCandidate = {
        outcome,
        fromShares: currentShares,
        toShares: normalizedObserved,
        nowTs: args.nowTs,
      };
      if (args.shouldIgnoreShortfall?.(candidate)) {
        return;
      }
      state = shrinkOutcomeToObservedShares(state, outcome, normalizedObserved);
      corrections.push({
        outcome: candidate.outcome,
        fromShares: candidate.fromShares,
        toShares: candidate.toShares,
      });
    }
  };

  reconcileOutcome("UP", args.observed.up);
  reconcileOutcome("DOWN", args.observed.down);

  return { state, inferredFills, corrections };
}

function buildFallbackPrices(
  books: OrderBookState,
  submittedPrices: SubmittedIntentBook,
): Record<OutcomeSide, number | undefined> {
  return {
    UP: latestSubmittedIntent(submittedPrices, "UP")?.price ?? books.bestAsk("UP"),
    DOWN: latestSubmittedIntent(submittedPrices, "DOWN")?.price ?? books.bestAsk("DOWN"),
  };
}

function latestSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
): SubmittedIntent | undefined {
  const intents = submittedPrices[outcome] ?? [];
  return [...intents].reverse().find((intent) => intent.active) ?? intents.at(-1);
}

function recentSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
  nowTs: number,
  maxAgeSec: number,
): SubmittedIntent | undefined {
  const intents = submittedPrices[outcome] ?? [];
  return [...intents]
    .reverse()
    .find((intent) => nowTs - intent.submittedAt <= maxAgeSec);
}

function findActiveSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
): SubmittedIntent | undefined {
  const intents = submittedPrices[outcome] ?? [];
  return intents.find((intent) => intent.active);
}

function consumeSubmittedIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
  filledShares: number,
): SubmittedIntent | undefined {
  const intent = findActiveSubmittedIntent(submittedPrices, outcome);
  if (!intent) {
    return undefined;
  }
  intent.attributedShares = normalizeShares(intent.attributedShares + filledShares);
  if (
    intent.expectedShares === undefined ||
    intent.attributedShares >= normalizeShares(Math.max(0, intent.expectedShares - 1e-6))
  ) {
    intent.active = false;
  }
  return intent;
}

function resolveFillIntent(
  submittedPrices: SubmittedIntentBook,
  outcome: OutcomeSide,
  filledShares: number,
  nowTs: number,
  maxAgeSec: number,
): SubmittedIntent | undefined {
  return (
    consumeSubmittedIntent(submittedPrices, outcome, filledShares) ??
    recentSubmittedIntent(submittedPrices, outcome, nowTs, maxAgeSec)
  );
}

function inferPendingPairExecutionIntent(args: {
  pending: PendingPairExecution | undefined;
  outcome: OutcomeSide;
  filledShares: number;
  fillSnapshot?: { upBoughtQty: number; downBoughtQty: number } | undefined;
}): SubmittedIntent | undefined {
  if (!args.pending) {
    return undefined;
  }

  const alreadyAttributed =
    args.outcome === "UP" ? args.fillSnapshot?.upBoughtQty ?? 0 : args.fillSnapshot?.downBoughtQty ?? 0;
  const remainingQty = normalizeShares(Math.max(0, args.pending.group.intendedQty - alreadyAttributed));
  if (remainingQty <= 1e-6) {
    return undefined;
  }

  const toleranceShares = 0.5;
  if (args.filledShares > remainingQty + toleranceShares) {
    return undefined;
  }

  return {
    side: "BUY",
    price: args.outcome === "UP" ? args.pending.group.maxUpPrice : args.pending.group.maxDownPrice,
    submittedAt: args.pending.submittedAt,
    mode: args.pending.group.selectedMode,
    groupId: args.pending.group.groupId,
    expectedShares: remainingQty,
    attributedShares: normalizeShares(args.filledShares),
    active: false,
  };
}

function extractExpectedSharesFromOrderResult(result: OrderResult | undefined): number | undefined {
  const raw = result?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = Number((raw as { takingAmount?: unknown }).takingAmount);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return normalizeShares(value);
}

function expectedSharesForSubmission(
  shareTarget: number | undefined,
  result: OrderResult | undefined,
): number | undefined {
  return extractExpectedSharesFromOrderResult(result) ?? (shareTarget !== undefined ? normalizeShares(shareTarget) : undefined);
}

function asOrderRawObject(result: OrderResult | undefined): Record<string, unknown> | undefined {
  if (!result?.raw || typeof result.raw !== "object" || Array.isArray(result.raw)) {
    return undefined;
  }
  return result.raw as Record<string, unknown>;
}

function extractOrderResultExecutionPrice(
  result: OrderResult | undefined,
  fallbackPrice: number | undefined,
): number {
  const raw = asOrderRawObject(result);
  const takingAmount = Number(raw?.takingAmount);
  const makingAmount = Number(raw?.makingAmount);
  if (Number.isFinite(takingAmount) && takingAmount > 0 && Number.isFinite(makingAmount) && makingAmount > 0) {
    return Number(clampFallbackPrice(makingAmount / takingAmount).toFixed(6));
  }
  return Number(clampFallbackPrice(fallbackPrice).toFixed(6));
}

export function inferImmediateOrderResultFill(args: {
  result: OrderResult | undefined;
  order: MarketOrderArgs;
  outcome: OutcomeSide;
  nowTs: number;
  mode?: StrategyExecutionMode | undefined;
}): FillRecord | undefined {
  if (!args.result || !isOrderResultAccepted(args.result)) {
    return undefined;
  }
  const size = extractMatchedShares(args.result);
  if (size <= 1e-6) {
    return undefined;
  }
  return {
    outcome: args.outcome,
    side: args.order.side,
    price: extractOrderResultExecutionPrice(args.result, args.order.price),
    size,
    timestamp: args.nowTs,
    makerTaker: "taker",
    executionMode: args.mode,
  };
}

function rememberSubmittedPrices(
  submittedPrices: SubmittedIntentBook,
  market: MarketInfo,
  orders: Array<{
    tokenId: string;
    side: TradeSide;
    price?: number | undefined;
    mode?: StrategyExecutionMode | undefined;
    groupId?: string | undefined;
    orderId?: string | undefined;
    expectedShares?: number | undefined;
  }>,
  submittedAt: number,
): void {
  for (const order of orders) {
    const outcome = outcomeForAssetId(market, order.tokenId);
    if (!outcome) {
      continue;
    }
    const nextIntent: SubmittedIntent = {
      side: order.side,
      price: order.price,
      submittedAt,
      mode: order.mode,
      groupId: order.groupId,
      orderId: order.orderId,
      expectedShares: order.expectedShares,
      attributedShares: 0,
      active: true,
    };
    const bucket = submittedPrices[outcome] ?? [];
    bucket.push(nextIntent);
    submittedPrices[outcome] = bucket;
  }
}

function buildBooks(client: MarketWsClient, market: MarketInfo): OrderBookState {
  return new OrderBookState(client.getBook(market.tokens.UP.tokenId), client.getBook(market.tokens.DOWN.tokenId));
}

function reserveNegativeEdgeBudget(
  state: XuanMarketState,
  negativeEdgeUsdc: number,
  bucket: "pair" | "completion",
): XuanMarketState {
  if (negativeEdgeUsdc <= 0) {
    return state;
  }
  return {
    ...state,
    negativeEdgeConsumedUsdc: Number((state.negativeEdgeConsumedUsdc + negativeEdgeUsdc).toFixed(6)),
    negativePairEdgeConsumedUsdc:
      bucket === "pair"
        ? Number((state.negativePairEdgeConsumedUsdc + negativeEdgeUsdc).toFixed(6))
        : state.negativePairEdgeConsumedUsdc,
    negativeCompletionEdgeConsumedUsdc:
      bucket === "completion"
        ? Number((state.negativeCompletionEdgeConsumedUsdc + negativeEdgeUsdc).toFixed(6))
        : state.negativeCompletionEdgeConsumedUsdc,
  };
}

function consumedPairNegativeEdgeUsdc(args: {
  estimatedNegativeEdgeUsdc: number;
  intendedQty: number;
  filledUpQty: number;
  filledDownQty: number;
}): number {
  if (args.estimatedNegativeEdgeUsdc <= 0 || args.intendedQty <= 0) {
    return 0;
  }
  const fillRatio = Math.min(
    1,
    (Math.max(0, args.filledUpQty) + Math.max(0, args.filledDownQty)) / (args.intendedQty * 2),
  );
  return normalizeShares(args.estimatedNegativeEdgeUsdc * fillRatio);
}

function withAvailableUsdcBalance(order: MarketOrderArgs, usdcBalance: number | undefined): MarketOrderArgs {
  if (order.side !== "BUY" || usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0) {
    return order;
  }

  return {
    ...order,
    userUsdcBalance: Number(usdcBalance.toFixed(6)),
  };
}

function assignSequentialUsdcBalances(
  orders: MarketOrderArgs[],
  usdcBalance: number | undefined,
): MarketOrderArgs[] {
  if (usdcBalance === undefined || !Number.isFinite(usdcBalance) || usdcBalance <= 0) {
    return orders;
  }

  let remainingBalance = usdcBalance;
  return orders.map((order) => {
    const balancedOrder = withAvailableUsdcBalance(order, remainingBalance);
    if (order.side === "BUY") {
      remainingBalance = normalizeShares(Math.max(0, remainingBalance - order.amount));
    }
    return balancedOrder;
  });
}

async function executeMarketOrdersInSequence(
  completionManager: TakerCompletionManager,
  orders: MarketOrderArgs[],
): Promise<ExecutedMarketOrder[]> {
  const executed: ExecutedMarketOrder[] = [];
  for (const order of orders) {
    executed.push({
      order,
      result: await completionManager.execute(order),
    });
  }
  return executed;
}

function selectRepresentativeExecution(executions: ExecutedMarketOrder[]): ExecutedMarketOrder {
  return executions.find((execution) => isOrderResultAccepted(execution.result)) ?? executions[executions.length - 1]!;
}

function selectRepresentativeResult(executions: ExecutedMarketOrder[]): OrderResult | undefined {
  return executions.length > 0 ? selectRepresentativeExecution(executions).result : undefined;
}

function sumOrderShareTargets(orders: MarketOrderArgs[]): number | undefined {
  const total = orders.reduce((acc, order) => acc + (order.shareTarget ?? 0), 0);
  return total > 0 ? normalizeShares(total) : undefined;
}

function sumOrderAmounts(orders: MarketOrderArgs[]): number {
  return normalizeShares(orders.reduce((acc, order) => acc + order.amount, 0));
}

function buildPairOrderPlan(args: {
  config: XuanStrategyConfig;
  entriesBySide: Record<OutcomeSide, EntryBuyDecision>;
  books: OrderBookState;
  minOrderSize: number;
  cachedUsdcBalance: number | undefined;
}): PairOrderPlan {
  const buildSideOrders = (side: OutcomeSide): MarketOrderArgs[] => {
    const baseOrder = args.entriesBySide[side].order;
    const plannedOrders =
      args.config.xuanCloneMode === "PUBLIC_FOOTPRINT"
        ? planCloneChildBuyOrders({
            order: baseOrder,
            outcome: side,
            books: args.books,
            minOrderSize: args.minOrderSize,
          })
        : [baseOrder];
    return assignSequentialUsdcBalances(plannedOrders, args.cachedUsdcBalance);
  };

  return {
    UP: buildSideOrders("UP"),
    DOWN: buildSideOrders("DOWN"),
  };
}

async function executePairOrderPlan(args: {
  completionManager: TakerCompletionManager;
  orderPlanBySide: PairOrderPlan;
  orderedEntries: EntryBuyDecision[];
  sequentialPairExecutionActive: boolean;
}): Promise<Record<OutcomeSide, ExecutedMarketOrder[]>> {
  const executedBySide: Record<OutcomeSide, ExecutedMarketOrder[]> = {
    UP: [],
    DOWN: [],
  };

  if (args.sequentialPairExecutionActive) {
    let abortRemainingSides = false;
    for (const entryBuy of args.orderedEntries) {
      if (abortRemainingSides) {
        break;
      }
      const sideOrders = args.orderPlanBySide[entryBuy.side];
      for (let index = 0; index < sideOrders.length; index += 1) {
        const order = sideOrders[index]!;
        const execution = {
          order,
          result: await args.completionManager.execute(order),
        };
        executedBySide[entryBuy.side].push(execution);
        if (!isOrderResultAccepted(execution.result)) {
          if (index === 0) {
            abortRemainingSides = true;
          }
          break;
        }
      }
    }
    return executedBySide;
  }

  const maxBatchCount = Math.max(args.orderPlanBySide.UP.length, args.orderPlanBySide.DOWN.length);
  for (let batchIndex = 0; batchIndex < maxBatchCount; batchIndex += 1) {
    const batch = (["UP", "DOWN"] as OutcomeSide[])
      .map((side) => {
        const order = args.orderPlanBySide[side][batchIndex];
        return order ? { side, order } : undefined;
      })
      .filter((item): item is { side: OutcomeSide; order: MarketOrderArgs } => item !== undefined);
    if (batch.length === 0) {
      continue;
    }
    const results = await Promise.all(batch.map((item) => args.completionManager.execute(item.order)));
    let batchAccepted = true;
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]!;
      const result = results[index]!;
      executedBySide[item.side].push({
        order: item.order,
        result,
      });
      if (!isOrderResultAccepted(result)) {
        batchAccepted = false;
      }
    }
    if (!batchAccepted) {
      break;
    }
  }

  return executedBySide;
}

async function logRejectedOrder(args: {
  traceLogger: JsonlTraceLogger;
  phase: "entry" | "completion" | "unwind";
  mode: string;
  side?: OutcomeSide | undefined;
  size: number;
  result: OrderResult;
  order: MarketOrderArgs;
  negativeEdgeUsdc?: number | undefined;
}): Promise<void> {
  await args.traceLogger.write("errors", {
    channel: "order_submit",
    severity: "warn",
    phase: args.phase,
    mode: args.mode,
    outcome: args.side ?? null,
    size: args.size,
    price: args.order.price ?? null,
    shareTarget: args.order.shareTarget ?? null,
    spendAmount: args.order.amount,
    negativeEdgeUsdc: args.negativeEdgeUsdc ?? 0,
    ...summarizeOrderResult(args.result),
  });
}

function updateSeedSubmissionState(
  state: XuanMarketState,
  mode: StrategyExecutionMode,
  side: OutcomeSide,
): XuanMarketState {
  if (mode === "PAIRGROUP_COVERED_SEED" || mode === "TEMPORAL_SINGLE_LEG_SEED") {
    const nextCount = state.consecutiveSeedSide === side ? state.consecutiveSeedCount + 1 : 1;
    return {
      ...state,
      consecutiveSeedSide: side,
      consecutiveSeedCount: nextCount,
      lastExecutionMode: mode,
    };
  }

  return {
    ...state,
    consecutiveSeedSide: undefined,
    consecutiveSeedCount: 0,
    lastExecutionMode: mode,
  };
}

function assertClassifiedBuyMode(mode: StrategyExecutionMode, config: Pick<XuanStrategyConfig, "rejectUnclassifiedBuy">): void {
  if (!config.rejectUnclassifiedBuy) {
    return;
  }
  if (!isClassifiedBuyMode(mode)) {
    throw new Error(`Unclassified BUY mode rejected: ${mode}`);
  }
}

function resolveActivePairExecution(
  pending: PendingPairExecution | undefined,
  state: XuanMarketState,
  fillSnapshot?: { upBoughtQty: number; downBoughtQty: number },
): PendingPairExecution | undefined {
  if (!pending) {
    return undefined;
  }
  const status = resolvePairOrderGroupStatus(pending.group, state, fillSnapshot);
  return {
    ...pending,
    status,
  };
}

export async function runStatefulBotSession(
  env: AppEnv,
  options: BotSessionOptions = {},
): Promise<BotSessionReport> {
  if (!env.BOT_PRIVATE_KEY || !env.POLY_API_KEY || !env.POLY_API_SECRET || !env.POLY_API_PASSPHRASE) {
    throw new Error("Stateful bot:live icin BOT_PRIVATE_KEY ve POLY_API_* credential seti gerekli.");
  }

  const resolvedOptions: Required<BotSessionOptions> = {
    durationSec: Math.max(10, Math.floor(options.durationSec ?? 240)),
    postCloseReconcileSec: Math.max(0, Math.floor(options.postCloseReconcileSec ?? 0)),
    tickMs: Math.max(250, Math.floor(options.tickMs ?? 1000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
    balanceSyncMs: Math.max(1000, Math.floor(options.balanceSyncMs ?? 5000)),
    marketSelection: options.marketSelection ?? "auto",
    initialDailyNegativeEdgeSpentUsdc: Math.max(0, Number(options.initialDailyNegativeEdgeSpentUsdc ?? 0)),
    dailyBudgetStorePath: options.dailyBudgetStorePath ?? "",
  };

  const logger = createLogger(env);
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  if (!env.DRY_RUN && config.validationSequence === "REPLAY_THEN_LIVE" && config.replayRequiredBeforeLive) {
    const latestReplayValidation = stateStore.latestValidationRun("replay");
    if (!latestReplayValidation || !isReplayComparatorStatus(latestReplayValidation.status) || latestReplayValidation.status === "fail") {
      stateStore.close();
      throw new Error(
        "Live once comparator replay validation gerekli. Once npm run xuan:compare-paper veya npm run xuan:compare-runtime calistir.",
      );
    }
  }
  const clob = createClobAdapter(env);
  const gamma = new GammaClient(env);
  const clock = new SystemClock();
  const bot = new Xuan5mBot();
  const orderManager = new OrderManager(clob);
  const completionManager = new TakerCompletionManager(orderManager);
  const ctf = new CtfClient(env);
  const marketWs = new MarketWsClient(env);
  const userWs = new UserWsClient(env);
  const balanceReader = new Erc1155BalanceReader(env);
  const startedAt = clock.now();

  const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
  let selected =
    resolvedOptions.marketSelection === "current"
      ? { selection: "current" as const, market: discovery.current }
      : resolvedOptions.marketSelection === "next"
        ? { selection: "next" as const, market: discovery.next }
        : pickSessionMarket(discovery, startedAt, config.normalEntryCutoffSecToClose);
  let startupInventorySnapshot =
    config.startupInventoryPolicy === "ADOPT_AND_RECONCILE"
      ? await fetchInventorySnapshot(env, config)
      : undefined;
  if (
    resolvedOptions.marketSelection === "auto" &&
    startupInventorySnapshot?.currentMarket &&
    startupInventorySnapshot.currentMarket.totalShares >= config.dustSharesThreshold
  ) {
    selected = {
      selection: "current",
      market: discovery.current,
    };
  }
  const market = selected.market;
  const balanceOwnerAddress = resolveConfiguredFunderAddress(env);
  const persistedBudget = stateStore.loadRiskBudget({
    wallet: balanceOwnerAddress,
    now: new Date(startedAt * 1000),
  });
  const initialDailyNegativeEdgeSpentUsdc = Math.max(
    0,
    Number(
      options.initialDailyNegativeEdgeSpentUsdc ?? persistedBudget.dailyNegativeSpentUsdc,
    ),
  );
  resolvedOptions.initialDailyNegativeEdgeSpentUsdc = initialDailyNegativeEdgeSpentUsdc;
  const runId = `live-${market.slug}-${startedAt}`;
  const traceLogger = new JsonlTraceLogger(env, {
    runId,
    source: "stateful_session",
    botMode: config.botMode,
    dryRun: env.DRY_RUN,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    upTokenId: market.tokens.UP.tokenId,
    downTokenId: market.tokens.DOWN.tokenId,
  });
  let state = createMarketState(market);
  let cachedUsdcBalance = (await readCollateralBalanceUsdc(env)) ?? Math.max(config.minUsdcBalance, 100);
  let startupBlockNewEntries = false;
  let startupCompletionOnly = false;
  let startupSafeHalt = false;
  let startupExternalReasons: string[] = [];
  let externalActivityDetected = false;
  let pairgroupLinkageHealthy = true;
  let grouplessFillEvents = 0;
  let lastBalanceSyncAt = 0;
  let actionCooldownUntil = 0;
  let lastMergeAtMs = 0;
  let mergeTxCount = 0;
  let adoptedInventory = false;
  let userTradeCount = 0;
  let balanceSyncCount = 0;
  let balanceCorrectionCount = 0;
  let entrySubmitCount = 0;
  let pairGroupCount = 0;
  let partialLegCount = 0;
  let completionSubmitCount = 0;
  let unwindSubmitCount = 0;
  let mergeCount = 0;
  let ticks = 0;
  const submittedPrices: SubmittedIntentBook = {};
  const seenTradeIds = new Set<string>();
  const orderResultFillSuppressions: Array<{
    outcome: OutcomeSide;
    size: number;
    price: number;
    expiresAt: number;
  }> = [];
  const recentBotOwnedBuyFills: RecentBotOwnedBuyFill[] = [];
  const events: Array<Record<string, unknown>> = [];
  let pendingPairExecution: PendingPairExecution | undefined;
  let partialOpenGroupLock: PartialOpenGroupLock | undefined;
  let activePairSubmission: ActivePairSubmission | undefined;
  let lastDecisionTraceAt = 0;
  let lastDecisionTraceSignature = "";
  let marketEventSeq = 0;
  let mergeBatchTracker = createMergeBatchTracker();
  let latestBookEventAtMs = Date.now();
  let lastBookEventAtMs: Record<OutcomeSide, number> = {
    UP: Date.now(),
    DOWN: Date.now(),
  };
  let pendingDecisionPulseResolve: (() => void) | undefined;
  let latestFairValueSnapshot: FairValueSnapshot | undefined;
  const btcPriceFeed = new BtcPriceFeed();
  const fairValueRuntime = new MarketFairValueRuntime(config, market, stateStore, btcPriceFeed);
  const persistedSafeHalt = stateStore.loadSafeHalt();
  if (persistedSafeHalt.active && config.requireManualResumeConfirm) {
    stateStore.close();
    throw new Error(
      `SAFE_HALT aktif (${persistedSafeHalt.reason ?? "external_activity"}). Once npm run inventory:reconcile, sonra npm run inventory:report, en son npm run bot:resume --confirm calistir.`,
    );
  }

  const persistDailyBudget = (nextState: XuanMarketState): void => {
    stateStore.upsertRiskBudget({
      wallet: balanceOwnerAddress,
      dailyNegativeSpentUsdc: initialDailyNegativeEdgeSpentUsdc + nextState.negativeEdgeConsumedUsdc,
      marketSlug: market.slug,
      marketNegativeSpentUsdc: nextState.negativePairEdgeConsumedUsdc,
      now: new Date(clock.now() * 1000),
    });
  };
  const submittedIntentMaxAgeSec = Math.max(15, Math.ceil(config.pairgroupFinalizeTimeoutMs / 1000) + 2);

  const rememberOrderResultFillSuppression = (fill: FillRecord): void => {
    orderResultFillSuppressions.push({
      outcome: fill.outcome,
      size: fill.size,
      price: fill.price,
      expiresAt: fill.timestamp + submittedIntentMaxAgeSec,
    });
  };

  const consumeOrderResultFillSuppression = (fill: FillRecord): boolean => {
    const nowTs = fill.timestamp;
    for (let index = orderResultFillSuppressions.length - 1; index >= 0; index -= 1) {
      if (orderResultFillSuppressions[index]!.expiresAt < nowTs) {
        orderResultFillSuppressions.splice(index, 1);
      }
    }
    const matchedIndex = orderResultFillSuppressions.findIndex(
      (candidate) =>
        candidate.outcome === fill.outcome &&
        Math.abs(candidate.size - fill.size) <= Math.max(1e-6, fill.size * 0.001) &&
        Math.abs(candidate.price - fill.price) <= 0.005,
    );
    if (matchedIndex < 0) {
      return false;
    }
    orderResultFillSuppressions.splice(matchedIndex, 1);
    return true;
  };

  const rememberBotOwnedBuyFill = (
    fill: FillRecord,
    context: { groupId?: string | undefined; orderId?: string | undefined } = {},
  ): void => {
    if (fill.side !== "BUY") {
      return;
    }
    recentBotOwnedBuyFills.push({
      outcome: fill.outcome,
      size: fill.size,
      price: fill.price,
      timestamp: fill.timestamp,
      expiresAt: fill.timestamp + submittedIntentMaxAgeSec,
      groupId: context.groupId,
      orderId: context.orderId,
    });
  };

  const pruneBotOwnedBuyFills = (nowTs: number): void => {
    for (let index = recentBotOwnedBuyFills.length - 1; index >= 0; index -= 1) {
      if (recentBotOwnedBuyFills[index]!.expiresAt < nowTs) {
        recentBotOwnedBuyFills.splice(index, 1);
      }
    }
  };

  const findBotOwnedFillForShortfall = (
    candidate: Pick<BalanceShortfallCandidate, "outcome" | "fromShares" | "toShares" | "nowTs">,
  ): RecentBotOwnedBuyFill | undefined => {
    pruneBotOwnedBuyFills(candidate.nowTs);
    return [...recentBotOwnedBuyFills].reverse().find((fill) => {
      if (fill.outcome !== candidate.outcome) {
        return false;
      }
      const fillTolerance = Math.max(0.5, fill.size * 0.08);
      if (candidate.toShares <= 1e-6) {
        return Math.abs(candidate.fromShares - fill.size) <= fillTolerance;
      }
      const shortfall = candidate.fromShares - candidate.toShares;
      return candidate.fromShares >= fill.size - fillTolerance && shortfall > 0 && shortfall <= fillTolerance;
    });
  };

  const shouldIgnoreTransientBotOwnedShortfall = (candidate: BalanceShortfallCandidate): boolean => {
    if (candidate.toShares > 1e-6) {
      return false;
    }
    const matchedFill = findBotOwnedFillForShortfall(candidate);
    if (!matchedFill) {
      return false;
    }
    return candidate.nowTs - matchedFill.timestamp <= BOT_OWNED_ZERO_BALANCE_GRACE_SEC;
  };

  const matchActivePairSubmission = (fill: FillRecord): ActivePairSubmission["entries"][number] | undefined => {
    const active = activePairSubmission;
    if (!active || fill.timestamp > active.expiresAt) {
      activePairSubmission = undefined;
      return undefined;
    }
    return active.entries.find((entry) => {
      if (entry.outcome !== fill.outcome) {
        return false;
      }
      if (entry.expectedShares !== undefined) {
        const shareTolerance = Math.max(0.5, entry.expectedShares * 0.1);
        if (fill.size > entry.expectedShares + shareTolerance) {
          return false;
        }
      }
      if (entry.price !== undefined && Math.abs(fill.price - entry.price) > 0.05) {
        return false;
      }
      return true;
    });
  };

  const signalDecisionPulse = (): void => {
    const resolve = pendingDecisionPulseResolve;
    pendingDecisionPulseResolve = undefined;
    resolve?.();
  };

  const waitForDecisionPulse = async (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingDecisionPulseResolve === onPulse) {
          pendingDecisionPulseResolve = undefined;
        }
        resolve();
      }, resolvedOptions.tickMs);

      const onPulse = () => {
        clearTimeout(timer);
        resolve();
      };

      pendingDecisionPulseResolve = onPulse;
    });

  const writeRiskEvent = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await traceLogger.write("risk_events", {
      reason,
      ...extra,
    });
  };

  const markExternalActivity = async (
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    if (externalActivityDetected) {
      return;
    }
    externalActivityDetected = true;
    startupBlockNewEntries = config.blockNewEntryOnExternalActivity;
    startupCompletionOnly =
      config.externalActivityMode === "SAFE_HALT" ? false : config.requireReconcileAfterManualTrade;
    startupSafeHalt = config.externalActivityMode === "SAFE_HALT";
    if (startupSafeHalt) {
      stateStore.setSafeHalt({
        active: true,
        reason,
        timestamp: clock.now(),
      });
      try {
        await clob.cancelAll();
      } catch (error) {
        logger.warn({ error }, "SAFE_HALT cancelAll failed.");
      }
    }
    startupExternalReasons = [...new Set([...startupExternalReasons, reason])];
    stateStore.recordExternalActivity({
      marketSlug: market.slug,
      conditionId: market.conditionId,
      timestamp: clock.now(),
      type: "runtime",
      action: reason,
      reason,
      botRecognized: false,
      responseMode: config.externalActivityMode,
    });
    await writeRiskEvent(reason, {
      stage: "runtime",
      blockNewEntries: startupBlockNewEntries,
      completionOnly: startupCompletionOnly,
      safeHalt: startupSafeHalt,
      ...extra,
    });
  };

  const markPairgroupRepairRequired = async (
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    pairgroupLinkageHealthy = false;
    grouplessFillEvents += 1;
    const escalateToGlobalSafeHalt =
      config.pairgroupRepairRequiredScope === "GLOBAL" ||
      config.pairgroupRepairRepeatEscalation === "GLOBAL_SAFE_HALT" &&
      grouplessFillEvents >= config.maxGrouplessFillEventsBeforeGlobalHalt;

    startupCompletionOnly = true;
    startupBlockNewEntries = true;
    startupExternalReasons = [...new Set([...startupExternalReasons, reason])];
    if (escalateToGlobalSafeHalt) {
      startupCompletionOnly = false;
      startupSafeHalt = true;
      stateStore.setSafeHalt({
        active: true,
        reason,
        timestamp: clock.now(),
      });
      try {
        await clob.cancelAll();
      } catch (error) {
        logger.warn({ error }, "pairgroup repair escalation cancelAll failed.");
      }
    }
    stateStore.upsertMarketState(state, reason);
    stateStore.recordReconcileRun({
      scope: "pairgroup_repair_required",
      marketSlug: market.slug,
      conditionId: market.conditionId,
      timestamp: clock.now(),
      status: escalateToGlobalSafeHalt ? "safe_halt" : "repair_required",
      requiresManualResume: true,
      payload: {
        scope: config.pairgroupRepairRequiredScope,
        grouplessFillEvents,
        escalated: escalateToGlobalSafeHalt,
        ...extra,
      },
    });
    await writeRiskEvent(reason, {
      stage: "pairgroup_repair",
      scope: config.pairgroupRepairRequiredScope,
      grouplessFillEvents,
      escalated: escalateToGlobalSafeHalt,
      ...extra,
    });
  };

  const persistFinalizedPairGroup = async (
    finalized: PairExecutionResult,
    pending: PendingPairExecution,
    finalizedAtTs: number,
  ): Promise<void> => {
    const actualNegativeEdgeUsdc = consumedPairNegativeEdgeUsdc({
      estimatedNegativeEdgeUsdc: pending.negativeEdgeUsdc,
      intendedQty: finalized.group.intendedQty,
      filledUpQty: finalized.filledUpQty,
      filledDownQty: finalized.filledDownQty,
    });
    const finalizedGroup = {
      ...finalized.group,
      negativeEdgeUsdc: actualNegativeEdgeUsdc,
      marketNegativeSpentAfter: normalizeShares(
        finalized.group.marketNegativeSpentBefore + actualNegativeEdgeUsdc,
      ),
    };

    if (actualNegativeEdgeUsdc > 0) {
      state = reserveNegativeEdgeBudget(state, actualNegativeEdgeUsdc, "pair");
      persistDailyBudget(state);
    }
    if (finalized.status === "UP_ONLY" || finalized.status === "DOWN_ONLY") {
      partialLegCount += 1;
      partialOpenGroupLock = {
        groupId: finalized.group.groupId,
        status: finalized.status,
        openedAt: finalizedAtTs,
      };
    } else if (partialOpenGroupLock?.groupId === finalized.group.groupId) {
      partialOpenGroupLock = undefined;
    }
    pushEvent(events, {
      timestamp: finalizedAtTs,
      type: "pair_group_finalized",
      groupId: finalized.group.groupId,
      status: finalized.status,
      intendedQty: finalized.group.intendedQty,
      negativeEdgeUsdc: actualNegativeEdgeUsdc,
      filledUpQty: finalized.filledUpQty,
      filledDownQty: finalized.filledDownQty,
      upResult: pending.upResult,
      downResult: pending.downResult,
    });
    await traceLogger.write("pair_groups", {
      eventType: "pair_group_finalized",
      pairGroupId: finalized.group.groupId,
      status: finalized.status,
      normalizedStatus:
        finalized.status === "UP_ONLY" || finalized.status === "DOWN_ONLY"
          ? "PARTIAL"
          : finalized.status,
      selectedMode: finalizedGroup.selectedMode,
      intendedQty: finalizedGroup.intendedQty,
      rawPair: finalizedGroup.rawPair,
      effectivePair: finalizedGroup.effectivePair,
      negativeEdgeUsdc: actualNegativeEdgeUsdc,
      marketNegativeSpentBefore: finalizedGroup.marketNegativeSpentBefore,
      marketNegativeSpentAfter: finalizedGroup.marketNegativeSpentAfter,
      filledUpQty: finalized.filledUpQty,
      filledDownQty: finalized.filledDownQty,
    });
    stateStore.upsertPairGroup(finalizedGroup);
    stateStore.upsertMarketState(
      state,
      partialOpenGroupLock?.groupId ? "partial_group_open" : undefined,
    );
  };

  const writeInventorySnapshotTrace = async (
    label: string,
    snapshot: Awaited<ReturnType<typeof fetchInventorySnapshot>>,
  ): Promise<void> => {
    await traceLogger.write("inventory_snapshots", {
      label,
      walletAddress: snapshot.walletAddress,
      currentSlug: snapshot.currentSlug,
      previousSlug: snapshot.previousSlug,
      nextSlug: snapshot.nextSlug,
      markets: snapshot.markets.map((inventoryMarket) => ({
        slug: inventoryMarket.slug,
        relation: inventoryMarket.relation,
        knownBtc5m: inventoryMarket.knownBtc5m,
        resolved: inventoryMarket.resolved,
        redeemable: inventoryMarket.redeemable,
        upShares: inventoryMarket.upShares,
        downShares: inventoryMarket.downShares,
        mergeable: inventoryMarket.mergeable,
        residualUp: inventoryMarket.residualUp,
        residualDown: inventoryMarket.residualDown,
        imbalanceRatio: inventoryMarket.imbalanceRatio,
      })),
    });
  };

  await traceLogger.write("market_rollover", {
    status: "session_start",
    selection: selected.selection,
    startedAt,
  });
  stateStore.recordMarketRollover({
    status: "session_start",
    timestamp: startedAt,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    payload: {
      selection: selected.selection,
      initialDailyNegativeEdgeSpentUsdc,
    },
  });
  state = stateStore.loadMarketState(state);
  stateStore.upsertMarketState(state);
  if (config.restartRestorePartialAsCompletionOnly) {
    const restoredPartialGroup = stateStore.loadLatestOpenPartialPairGroup(market.slug);
    const restoredGap = Math.abs(state.upShares - state.downShares);
    if (
      restoredPartialGroup &&
      restoredGap > Math.max(config.repairMinQty, config.completionMinQty)
    ) {
      partialOpenGroupLock = {
        groupId: restoredPartialGroup.groupId,
        status: restoredPartialGroup.status,
        openedAt: restoredPartialGroup.createdAt,
      };
      startupCompletionOnly = true;
      if (config.blockNewPairWhenRestoredPartialExists) {
        startupBlockNewEntries = true;
      }
      state = {
        ...state,
        reentryDisabled: true,
      };
      stateStore.upsertMarketState(state, "restored_partial_group_open");
      await writeRiskEvent("restored_partial_group_open", {
        groupId: restoredPartialGroup.groupId,
        status: restoredPartialGroup.status,
        restoredGap,
      });
    }
  }

  if (startupInventorySnapshot) {
    await writeInventorySnapshotTrace("startup_before_manage", startupInventorySnapshot);
    const startupPlan = buildInventoryActionPlan(startupInventorySnapshot, config);
    startupBlockNewEntries = startupPlan.blockNewEntries;
    startupExternalReasons = [...startupPlan.blockReasons];

    if (startupPlan.redeem.length > 0 || startupPlan.merge.length > 0) {
      const startupActions = await executeInventoryActionPlan(env, startupPlan, config);
      for (const action of startupActions) {
        await traceLogger.write("merge_redeem", {
          action: action.type,
          slug: action.slug,
          relation: action.relation,
          amount: action.amount ?? null,
          reason: action.reason,
          txHash: action.result.txHash ?? null,
          simulated: action.result.simulated,
          skipped: action.result.skipped ?? false,
        });
      }
      startupInventorySnapshot = await fetchInventorySnapshot(env, config);
      await writeInventorySnapshotTrace("startup_after_manage", startupInventorySnapshot);
    }

    const startupGuardPlan = buildInventoryActionPlan(startupInventorySnapshot, config);
    startupBlockNewEntries = startupGuardPlan.blockNewEntries;
    startupExternalReasons = [...startupGuardPlan.blockReasons];
    const startupCurrentInventory =
      startupInventorySnapshot.markets.find(
        (inventoryMarket) => inventoryMarket.conditionId === market.conditionId || inventoryMarket.slug === market.slug,
      ) ?? startupInventorySnapshot.currentMarket;
    if (startupCurrentInventory && startupCurrentInventory.imbalanceRatio >= config.hardImbalanceRatio) {
      startupBlockNewEntries = true;
      startupCompletionOnly = true;
      startupExternalReasons.push("startup_current_inventory_hard_imbalance");
    }
    for (const reason of startupExternalReasons) {
      await writeRiskEvent(reason, {
        stage: "startup",
      });
    }
  }

  btcPriceFeed.connect();
  marketWs.connect([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);
  userWs.connect([market.conditionId]);

  marketWs.on("book", (book: OrderBook) => {
    marketEventSeq += 1;
    latestBookEventAtMs = Date.now();
    const outcome = outcomeForAssetId(market, book.assetId);
    if (outcome) {
      lastBookEventAtMs[outcome] = latestBookEventAtMs;
    }
    signalDecisionPulse();
  });
  btcPriceFeed.on("price", () => {
    signalDecisionPulse();
  });
  btcPriceFeed.on("warn", (error: Error) => {
    logger.warn({ error }, "BTC price feed warning.");
    pushEvent(events, { timestamp: clock.now(), type: "btc_price_warn", message: error.message });
    void traceLogger.write("errors", {
      channel: "btc_price_feed",
      severity: "warn",
      message: error.message,
    });
  });

  userWs.on("warn", (error: Error) => {
    logger.warn({ error }, "User websocket warning.");
    pushEvent(events, { timestamp: clock.now(), type: "user_ws_warn", message: error.message });
    void traceLogger.write("errors", {
      channel: "user_ws",
      severity: "warn",
      message: error.message,
    });
  });
  userWs.on("error", (error: Error) => {
    logger.error({ error }, "User websocket error.");
    pushEvent(events, { timestamp: clock.now(), type: "user_ws_error", message: error.message });
    void traceLogger.write("errors", {
      channel: "user_ws",
      severity: "error",
      message: error.message,
    });
  });
  userWs.on("order", (event: UserOrderEvent) => {
    pushEvent(events, {
      timestamp: clock.now(),
      type: "user_order",
      eventType: event.type,
      orderId: event.id,
      assetId: event.asset_id,
      price: event.price,
      matchedSize: event.size_matched,
    });
    void traceLogger.write("orders", {
      eventType: "user_order",
      orderId: event.id,
      assetId: event.asset_id,
      price: event.price,
      matchedSize: event.size_matched,
    });
  });
  userWs.on("trade", (event: UserTradeEvent) => {
    if (seenTradeIds.has(event.id)) {
      return;
    }
    seenTradeIds.add(event.id);
    const fill = inferUserTradeFill({
      event,
      market,
      nowTs: clock.now(),
      submittedPrices,
    });
    if (!fill) {
      pushEvent(events, {
        timestamp: clock.now(),
        type: "user_trade_unparsed",
        eventId: event.id,
        assetId: event.asset_id,
      });
      void traceLogger.write("errors", {
        channel: "user_trade",
        severity: "warn",
        message: "user_trade_unparsed",
        eventId: event.id,
        assetId: event.asset_id,
      });
      return;
    }

    const pendingFillSnapshot = pendingPairExecution
      ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
      : undefined;
    const submittedIntent =
      resolveFillIntent(
        submittedPrices,
        fill.outcome,
        fill.size,
        fill.timestamp,
        submittedIntentMaxAgeSec,
      ) ??
      inferPendingPairExecutionIntent({
        pending: pendingPairExecution,
        outcome: fill.outcome,
        filledShares: fill.size,
        fillSnapshot: pendingFillSnapshot,
      });
    const normalizedFill: FillRecord = {
      ...fill,
      executionMode: fill.executionMode ?? submittedIntent?.mode,
    };
    const activePairMatch = !submittedIntent?.groupId ? matchActivePairSubmission(normalizedFill) : undefined;
    if (activePairMatch) {
      pushEvent(events, {
        timestamp: normalizedFill.timestamp,
        type: "user_fill_suppressed_pair_submit_window",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        side: normalizedFill.side,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: activePairSubmission?.groupId ?? null,
      });
      void traceLogger.write("user_fills", {
        eventType: "user_fill_suppressed_pair_submit_window",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        side: normalizedFill.side,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: activePairSubmission?.groupId ?? null,
        source: "PAIR_SUBMIT_WINDOW",
      });
      return;
    }
    if (normalizedFill.side === "BUY" && consumeOrderResultFillSuppression(normalizedFill)) {
      pushEvent(events, {
        timestamp: normalizedFill.timestamp,
        type: "user_fill_suppressed_order_result_duplicate",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
      });
      void traceLogger.write("user_fills", {
        eventType: "user_fill_suppressed_order_result_duplicate",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
        source: "ORDER_RESULT",
      });
      return;
    }
    if (pendingPairExecution && !submittedIntent?.groupId) {
      void markPairgroupRepairRequired("pairgroup_repair_required", {
        source: "user_ws",
        eventId: event.id,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        pendingPairGroupId: pendingPairExecution.group.groupId,
      });
    }
    state = applyFill(state, normalizedFill);
    stateStore.recordFill(state, normalizedFill, {
      orderId: submittedIntent?.orderId,
      groupId: submittedIntent?.groupId,
      executionMode: submittedIntent?.mode,
      source: "USER_WS",
    });
    if (submittedIntent?.groupId || submittedIntent?.orderId) {
      rememberBotOwnedBuyFill(normalizedFill, {
        groupId: submittedIntent.groupId,
        orderId: submittedIntent.orderId,
      });
    }
    stateStore.upsertMarketState(state);
    userTradeCount += 1;
    pushEvent(events, {
      timestamp: normalizedFill.timestamp,
      type: "user_fill",
      eventId: event.id,
      outcome: normalizedFill.outcome,
      side: normalizedFill.side,
      size: normalizedFill.size,
      price: normalizedFill.price,
      groupId: submittedIntent?.groupId ?? null,
      orderId: submittedIntent?.orderId ?? null,
    });
    void traceLogger.write("user_fills", {
      eventId: event.id,
      outcome: normalizedFill.outcome,
      side: normalizedFill.side,
      size: normalizedFill.size,
      price: normalizedFill.price,
      groupId: submittedIntent?.groupId ?? null,
      orderId: submittedIntent?.orderId ?? null,
      correlationId: submittedIntent?.groupId ?? event.id,
    });
    emitLiveMirror("user_fill", {
      marketSlug: market.slug,
      eventId: event.id,
      outcome: normalizedFill.outcome,
      side: normalizedFill.side,
      size: normalizedFill.size,
      price: normalizedFill.price,
      executionMode: normalizedFill.executionMode ?? null,
      groupId: submittedIntent?.groupId ?? null,
      orderId: submittedIntent?.orderId ?? null,
      upShares: state.upShares,
      downShares: state.downShares,
      upAverage: averageCost(state, "UP"),
      downAverage: averageCost(state, "DOWN"),
    });
  });

  const performBalanceSync = async (args: {
    nowTs: number;
    books: OrderBookState;
    scope: string;
    traceLabel: string;
  }): Promise<void> => {
    lastBalanceSyncAt = args.nowTs;
    balanceSyncCount += 1;
    cachedUsdcBalance = (await readCollateralBalanceUsdc(env)) ?? cachedUsdcBalance;

    const observedBalances = await readObservedBalances(balanceReader, market, balanceOwnerAddress);
    const reconciled = reconcileStateWithBalances({
      state,
      observed: observedBalances,
      nowTs: args.nowTs,
      fallbackPrices: buildFallbackPrices(args.books, submittedPrices),
      shouldIgnoreShortfall: shouldIgnoreTransientBotOwnedShortfall,
    });
    state = reconciled.state;
    balanceCorrectionCount += reconciled.corrections.length;

    for (const fill of reconciled.inferredFills) {
      const pendingFillSnapshot = pendingPairExecution
        ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
        : undefined;
      const submittedIntent =
        resolveFillIntent(
          submittedPrices,
          fill.outcome,
          fill.size,
          fill.timestamp,
          submittedIntentMaxAgeSec,
        ) ??
        inferPendingPairExecutionIntent({
          pending: pendingPairExecution,
          outcome: fill.outcome,
          filledShares: fill.size,
          fillSnapshot: pendingFillSnapshot,
        });
      const normalizedFill: FillRecord = {
        ...fill,
        executionMode: fill.executionMode ?? submittedIntent?.mode,
      };
      if (pendingPairExecution && !submittedIntent?.groupId) {
        await markPairgroupRepairRequired("pairgroup_repair_required", {
          source: args.scope,
          outcome: normalizedFill.outcome,
          size: normalizedFill.size,
          pendingPairGroupId: pendingPairExecution.group.groupId,
        });
      }
      stateStore.recordFill(state, normalizedFill, {
        orderId: submittedIntent?.orderId,
        groupId: submittedIntent?.groupId,
        executionMode: submittedIntent?.mode,
        source: "BALANCE_RECONCILE",
      });
      if (submittedIntent?.groupId || submittedIntent?.orderId) {
        rememberBotOwnedBuyFill(normalizedFill, {
          groupId: submittedIntent.groupId,
          orderId: submittedIntent.orderId,
        });
      }
      pushEvent(events, {
        timestamp: args.nowTs,
        type: "balance_sync_fill",
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: submittedIntent?.groupId ?? null,
        orderId: submittedIntent?.orderId ?? null,
      });
      await traceLogger.write("balance_sync", {
        balanceEvent: "fill",
        scope: args.scope,
        outcome: normalizedFill.outcome,
        size: normalizedFill.size,
        price: normalizedFill.price,
        groupId: submittedIntent?.groupId ?? null,
        orderId: submittedIntent?.orderId ?? null,
      });
    }
    for (const correction of reconciled.corrections) {
      const botOwnedCorrection = Boolean(
        findBotOwnedFillForShortfall({
          ...correction,
          nowTs: args.nowTs,
        }),
      );
      const persistedShrink = botOwnedCorrection
        ? stateStore.shrinkOpenLotsToObservedShares(
            market.slug,
            correction.outcome,
            correction.toShares,
            args.nowTs,
          )
        : undefined;
      pushEvent(events, {
        timestamp: args.nowTs,
        type: "balance_sync_correction",
        outcome: correction.outcome,
        fromShares: correction.fromShares,
        toShares: correction.toShares,
        botOwned: botOwnedCorrection,
      });
      await traceLogger.write("balance_sync", {
        balanceEvent: "correction",
        scope: args.scope,
        outcome: correction.outcome,
        fromShares: correction.fromShares,
        toShares: correction.toShares,
        botOwned: botOwnedCorrection,
        persistedFromShares: persistedShrink?.fromShares ?? null,
        persistedToShares: persistedShrink?.toShares ?? null,
        persistedConsumedQty: persistedShrink?.consumedQty ?? null,
      });
      if (
        !botOwnedCorrection &&
        config.blockNewEntryOnExternalActivity &&
        correction.toShares + 1e-6 < correction.fromShares
      ) {
        await markExternalActivity("external_inventory_delta", {
          outcome: correction.outcome,
          fromShares: correction.fromShares,
          toShares: correction.toShares,
        });
      }
    }
    stateStore.upsertMarketState(state);
    stateStore.recordReconcileRun({
      scope: args.scope,
      marketSlug: market.slug,
      conditionId: market.conditionId,
      timestamp: args.nowTs,
      status: reconciled.corrections.length > 0 ? "corrected" : "ok",
      requiresManualResume: externalActivityDetected,
      mismatchShares: reconciled.corrections.reduce(
        (sum, correction) => sum + Math.abs(correction.fromShares - correction.toShares),
        0,
      ),
      payload: {
        inferredFills: reconciled.inferredFills.length,
        corrections: reconciled.corrections.length,
      },
    });

    if (config.mergeOnEachReconcile) {
      await traceLogger.write("inventory_snapshots", {
        label: args.traceLabel,
        upShares: state.upShares,
        downShares: state.downShares,
        mergeable: Math.min(state.upShares, state.downShares),
        negativeEdgeConsumedUsdc: state.negativeEdgeConsumedUsdc,
      });
    }

    if (pendingPairExecution && args.nowTs >= pendingPairExecution.submittedAt) {
      pendingPairExecution = {
        ...pendingPairExecution,
        reconciledAfterSubmit: true,
      };
    }
  };

  const finalizePendingPairExecutionIfReady = async (
    nowTs: number,
    options: { forceDeadline?: boolean } = {},
  ): Promise<void> => {
    const pendingFillSnapshot = pendingPairExecution
      ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
      : undefined;
    pendingPairExecution = resolveActivePairExecution(pendingPairExecution, state, pendingFillSnapshot);
    if (!pendingPairExecution) {
      return;
    }

    const deadlinePassed = options.forceDeadline || Date.now() >= pendingPairExecution.deadlineAt;
    const finalized =
      pendingPairExecution.status !== "PENDING" ||
      (deadlinePassed &&
        (!config.pairgroupFinalizeAfterBalanceSync || pendingPairExecution.reconciledAfterSubmit))
        ? finalizePairExecutionResult({
            group: pendingPairExecution.group,
            upResult: pendingPairExecution.upResult,
            downResult: pendingPairExecution.downResult,
            state,
            fillSnapshot: stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId),
            reconcileObservedAfterSubmit: pendingPairExecution.reconciledAfterSubmit,
            requireReconcileBeforeNoneFilled: config.pairgroupRequireReconcileBeforeNoneFilled,
          })
        : undefined;

    if (finalized) {
      await persistFinalizedPairGroup(finalized, pendingPairExecution, nowTs);
      pendingPairExecution = undefined;
    }
  };

  try {
    const initial = await waitForInitialBooks(marketWs, market, resolvedOptions.initialBookWaitMs);
    const initialBooks = new OrderBookState(initial.upBook, initial.downBook);
    const initialBalances = await readObservedBalances(balanceReader, market, balanceOwnerAddress);
    latestFairValueSnapshot = fairValueRuntime.evaluate(startedAt);
    if (initialBalances.up > 0 || initialBalances.down > 0) {
      const adopted = reconcileStateWithBalances({
        state,
        observed: initialBalances,
        nowTs: startedAt,
        fallbackPrices: {
          UP: initialBooks.bestAsk("UP"),
          DOWN: initialBooks.bestAsk("DOWN"),
        },
      });
      state = adopted.state;
      for (const fill of adopted.inferredFills) {
        stateStore.recordFill(state, fill, {
          source: "BALANCE_RECONCILE",
        });
      }
      stateStore.upsertMarketState(state);
      adoptedInventory = adopted.inferredFills.length > 0 || adopted.corrections.length > 0;
      if (adoptedInventory) {
        pushEvent(events, {
          timestamp: startedAt,
          type: "startup_inventory_adopted",
          upShares: state.upShares,
          downShares: state.downShares,
        });
        await traceLogger.write("inventory_snapshots", {
          label: "startup_adopted_market_state",
          upShares: state.upShares,
          downShares: state.downShares,
          fillCount: state.fillHistory.length,
          startupBlockNewEntries,
          startupCompletionOnly,
        });
      }
      const startupCorrectionMagnitude = adopted.corrections.reduce(
        (acc, correction) => acc + Math.abs(correction.fromShares - correction.toShares),
        0,
      );
      if (startupCorrectionMagnitude > config.stateReconcileToleranceShares) {
        startupSafeHalt = true;
        startupBlockNewEntries = true;
        startupCompletionOnly = false;
        startupExternalReasons.push("startup_reconcile_mismatch");
      }
    }

    const sessionDeadline = Math.min(startedAt + resolvedOptions.durationSec, market.endTs);
    while (clock.now() < sessionDeadline && clock.now() < market.endTs) {
      const nowTs = clock.now();
      ticks += 1;
      const books = buildBooks(marketWs, market);
      const upBook = marketWs.getBook(market.tokens.UP.tokenId);
      const downBook = marketWs.getBook(market.tokens.DOWN.tokenId);

      if (!upBook || !downBook) {
        await waitForDecisionPulse();
        continue;
      }

      latestFairValueSnapshot = fairValueRuntime.evaluate(nowTs);

      if (nowTs - lastBalanceSyncAt >= Math.floor(resolvedOptions.balanceSyncMs / 1000)) {
        await performBalanceSync({
          nowTs,
          books,
          scope: "session_balance_sync",
          traceLabel: "reconcile_state",
        });
      }

      await finalizePendingPairExecutionIfReady(nowTs);

      if (Date.now() >= actionCooldownUntil) {
        const mergePlan = planMerge(config, state);
        const pendingMergeFillSnapshot = pendingPairExecution
          ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
          : undefined;
        const lockedPendingShares = computePendingLockedShares(
          pendingPairExecution,
          pendingMergeFillSnapshot,
          config,
        );
        const mergeableUnlocked = config.mergeOnlyConfirmedMatchedUnlockedLots
          ? unlockedMergeableShares(state, lockedPendingShares)
          : mergePlan.mergeable;
        mergeBatchTracker = syncMergeBatchTracker(mergeBatchTracker, mergeableUnlocked, nowTs);
        const mergeGate = evaluateDelayedMergeGate(config, state, {
          nowTs,
          secsToClose: market.endTs - nowTs,
          usdcBalance: cachedUsdcBalance,
          tracker: mergeBatchTracker,
        });
        const mergeAmount = normalizeMergeAmount(mergeableUnlocked, config.mergeDustLeaveShares);
        const mergeAllowed =
          mergePlan.shouldMerge &&
          mergeGate.allow &&
          mergeAmount >= config.mergeMinShares &&
          Date.now() - lastMergeAtMs >= config.mergeDebounceMs &&
          (!pendingPairExecution || config.allowMergeWithPendingGroups) &&
          mergeTxCount < config.mergeMaxTxPerMarket;
        if (mergeAllowed) {
          const mergeResult = env.CTF_MERGE_ENABLED
            ? await ctf.mergePositions(market.conditionId, mergeAmount)
            : {
                simulated: true,
                skipped: true,
                action: "merge" as const,
                amount: mergeAmount,
                conditionId: market.conditionId,
                reason: "CTF_MERGE_ENABLED=false",
              };
          if (mergeResult.simulated || !mergeResult.skipped) {
            const preMergeState = state;
            state = applyMerge(state, {
              amount: mergeAmount,
              timestamp: nowTs,
              simulated: mergeResult.simulated,
            });
            stateStore.recordMerge(preMergeState, state.mergeHistory.at(-1) ?? {
              amount: mergeAmount,
              timestamp: nowTs,
              simulated: mergeResult.simulated,
            });
            const residualAfterMerge = Math.abs(state.upShares - state.downShares);
            if (config.postMergeOnlyCompletion) {
              if (config.postMergeOnlyCompletionWhileResidual && residualAfterMerge > config.postMergeFlatDustShares) {
                state = {
                  ...state,
                  reentryDisabled: true,
                  postMergeCompletionOnlyUntil: undefined,
                };
              } else if (config.postMergeAllowNewPairIfFlat) {
                state = {
                  ...state,
                  reentryDisabled: false,
                  postMergeCompletionOnlyUntil:
                    nowTs + Math.ceil(config.postMergePairReopenCooldownMs / 1000),
                };
              } else {
                state = {
                  ...state,
                  reentryDisabled: true,
                  postMergeCompletionOnlyUntil:
                    nowTs + Math.ceil(config.postMergeNewSeedCooldownMs / 1000),
                };
              }
            }
            mergeCount += 1;
            mergeTxCount += 1;
            lastMergeAtMs = Date.now();
            const pendingPostMergeFillSnapshot = pendingPairExecution
              ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
              : undefined;
            const postMergeLockedPendingShares = computePendingLockedShares(
              pendingPairExecution,
              pendingPostMergeFillSnapshot,
              config,
            );
            const postMergeObserved = config.mergeOnlyConfirmedMatchedUnlockedLots
              ? unlockedMergeableShares(state, postMergeLockedPendingShares)
              : Math.min(state.upShares, state.downShares);
            mergeBatchTracker = syncMergeBatchTracker(mergeBatchTracker, postMergeObserved, nowTs);
            stateStore.upsertMarketState(state, state.reentryDisabled ? "post_merge_completion_only" : undefined);
          }
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          pushEvent(events, {
            timestamp: nowTs,
            type: "merge",
            amount: mergeAmount,
            mergeGateReason: mergeGate.reason,
            mergeGateForced: mergeGate.forced,
            result: mergeResult,
          });
          await traceLogger.write("merge_redeem", {
            action: "merge",
            amount: mergeAmount,
            mergeGateReason: mergeGate.reason,
            mergeGateForced: mergeGate.forced,
            mergePendingMatchedQty: mergeGate.pendingMatchedQty,
            mergeCompletedCycles: mergeGate.completedCycles,
            mergeOldestMatchedAgeSec: mergeGate.oldestMatchedAgeSec ?? null,
            txHash: mergeResult.txHash ?? null,
            simulated: mergeResult.simulated,
            skipped: mergeResult.skipped ?? false,
            lockedPendingUpShares: lockedPendingShares.up,
            lockedPendingDownShares: lockedPendingShares.down,
            matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
            matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
            mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
            realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
            remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
            remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
            postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
          });
          emitLiveMirror("merge_submit", {
            marketSlug: market.slug,
            trigger: "runtime",
            amount: mergeAmount,
            mergeGateReason: mergeGate.reason,
            mergeGateForced: mergeGate.forced,
            mergePendingMatchedQty: mergeGate.pendingMatchedQty,
            mergeCompletedCycles: mergeGate.completedCycles,
            txHash: mergeResult.txHash ?? null,
            simulated: mergeResult.simulated,
            skipped: mergeResult.skipped ?? false,
            matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
            matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
            mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
            realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
            remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
            remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
            postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
          });
          await waitForDecisionPulse();
          continue;
        }
      }

      const decisionEvalStartedAtMs = Date.now();
      if (
        partialOpenGroupLock &&
        Math.abs(state.upShares - state.downShares) <= Math.max(config.repairMinQty, config.completionMinQty)
      ) {
        partialOpenGroupLock = undefined;
        stateStore.upsertMarketState(state);
      }
      if (
        state.reentryDisabled &&
        Math.abs(state.upShares - state.downShares) <= config.postMergeFlatDustShares &&
        config.postMergeAllowNewPairIfFlat
      ) {
        state = {
          ...state,
          reentryDisabled: false,
          postMergeCompletionOnlyUntil:
            nowTs + Math.ceil(config.postMergePairReopenCooldownMs / 1000),
        };
        stateStore.upsertMarketState(state);
      }
      const overlapCompletionProbe =
        partialOpenGroupLock !== undefined
          ? chooseInventoryAdjustment(config, state, books, {
              secsToClose: market.endTs - nowTs,
              usdcBalance: cachedUsdcBalance,
              nowTs,
              fairValueSnapshot: latestFairValueSnapshot,
            })
          : undefined;
      const overlapCompletionActive = Boolean(overlapCompletionProbe?.completion);
      const partialAgeSec =
        partialOpenGroupLock !== undefined ? Math.max(0, nowTs - partialOpenGroupLock.openedAt) : undefined;
      const overlapBaseLot = config.liveSmallLotLadder[0] ?? config.defaultLot;
      const openMatchedQty = Number(Math.min(state.upShares, state.downShares).toFixed(6));
      const matchedInventoryTargetMet =
        mergeBatchTracker.windows.length >= 1 || openMatchedQty + 1e-6 >= overlapBaseLot;
      const previewControlledOverlapAllowed =
        partialOpenGroupLock !== undefined &&
        config.allowControlledOverlap &&
        config.maxOpenGroupsPerMarket >= 2 &&
        config.maxOpenPartialGroups >= 1 &&
        (!config.allowOverlapOnlyAfterPartialClassified || pairgroupLinkageHealthy) &&
        (!config.allowOverlapOnlyWhenCompletionEngineActive || overlapCompletionActive) &&
        (!config.requireMatchedInventoryBeforeSecondGroup || matchedInventoryTargetMet) &&
        partialAgeSec !== undefined &&
        partialAgeSec >= config.partialFastWindowSec &&
        partialAgeSec < config.partialPatientWindowSec &&
        (config.allowOverlapInLast30S || nowTs < market.endTs - config.finalWindowCompletionOnlySec);
      const postMergeCompletionOnlyActive =
        config.postMergeOnlyCompletion &&
        (state.reentryDisabled ||
          (state.postMergeCompletionOnlyUntil !== undefined && nowTs < state.postMergeCompletionOnlyUntil));
      const partialOpenCompletionOnlyActive =
        config.blockNewPairWhilePartialOpen &&
        partialOpenGroupLock !== undefined &&
        config.maxOpenPartialGroups <= 1 &&
        !previewControlledOverlapAllowed;
      const decision = bot.evaluateTick({
        config,
        state,
        books,
        nowTs,
        riskContext: {
          secsToClose: market.endTs - nowTs,
          staleBookMs: Math.max(computeBookStaleMs(upBook, nowTs), computeBookStaleMs(downBook, nowTs)),
          balanceStaleMs: Math.max(0, (nowTs - lastBalanceSyncAt) * 1000),
          bookIsCrossed: books.bestBid("UP") > books.bestAsk("UP") || books.bestBid("DOWN") > books.bestAsk("DOWN"),
          dailyLossUsdc: 0,
          marketLossUsdc: 0,
          usdcBalance: cachedUsdcBalance,
          forceNoNewEntries:
            startupBlockNewEntries || postMergeCompletionOnlyActive || partialOpenCompletionOnlyActive,
          forceCompletionOnly:
            startupCompletionOnly || postMergeCompletionOnlyActive || partialOpenCompletionOnlyActive,
          forceSafeHalt: startupSafeHalt,
          externalReasons: [
            ...startupExternalReasons,
            ...(postMergeCompletionOnlyActive ? ["post_merge_completion_only"] : []),
            ...(partialOpenCompletionOnlyActive ? ["partial_group_open"] : []),
          ],
        },
        dryRunOrSmallLive: false,
        dailyNegativeEdgeSpentUsdc:
          resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc,
        fairValueSnapshot: latestFairValueSnapshot,
        allowControlledOverlap: previewControlledOverlapAllowed,
      });
      const decisionTraceContext: DecisionTraceContext = {
        eventSeq: marketEventSeq,
        decisionLatencyMs: Math.max(0, Date.now() - Math.max(latestBookEventAtMs, decisionEvalStartedAtMs)),
        bookAgeMsUp: Math.max(0, Date.now() - lastBookEventAtMs.UP),
        bookAgeMsDown: Math.max(0, Date.now() - lastBookEventAtMs.DOWN),
      };

      if (decision.entryBuys.length === 0 && !decision.completion && !decision.unwind) {
        const traceSignature = decisionTraceSignature(decision);
        if (
          traceSignature !== lastDecisionTraceSignature ||
          nowTs - lastDecisionTraceAt >= DECISION_TRACE_INTERVAL_SEC
        ) {
          pushEvent(events, {
            timestamp: nowTs,
            type: "decision_trace",
            ...buildDecisionTraceEvent(decision, decisionTraceContext),
          });
          const decisionTraceEvent = buildDecisionTraceEvent(decision, decisionTraceContext);
          await traceLogger.write("decision_trace", decisionTraceEvent);
          emitLiveMirror("decision_trace", {
            marketSlug: market.slug,
            phase: decision.phase,
            allowNewEntries: decision.risk.allowNewEntries,
            completionOnly: decision.risk.completionOnly,
            hardCancel: decision.risk.hardCancel,
            riskReasons: decision.risk.reasons,
            lot: decision.trace.lot,
            shareGap: decision.trace.shareGap,
            bestAskUp: decision.trace.bestAskUp,
            bestAskDown: decision.trace.bestAskDown,
            bestEffectivePair: decisionTraceEvent.bestEffectivePair,
            bestRawPair: decisionTraceEvent.bestRawPair,
            selectedMode: decision.trace.selectedMode ?? null,
            skipReason: decision.trace.entry.skipReason ?? null,
            gateReasons: decision.trace.entry.candidates
              .map((candidate) => candidate.gateReason)
              .filter((reason): reason is string => Boolean(reason)),
            allowControlledOverlap: previewControlledOverlapAllowed,
            partialOpenGroupId: partialOpenGroupLock?.groupId ?? null,
          });
          if (decision.risk.reasons.length > 0 || decision.trace.entry.gatedByRisk) {
            await traceLogger.write("risk_events", {
              reason: decision.trace.entry.skipReason ?? "risk_gate",
              riskReasons: decision.risk.reasons,
              phase: decision.phase,
              allowNewEntries: decision.risk.allowNewEntries,
              completionOnly: decision.risk.completionOnly,
              hardCancel: decision.risk.hardCancel,
            });
          }
          lastDecisionTraceSignature = traceSignature;
          lastDecisionTraceAt = nowTs;
        }
      }

      if (Date.now() < actionCooldownUntil) {
        await waitForDecisionPulse();
        continue;
      }

      if (pendingPairExecution && decision.entryBuys.length > 1) {
        await waitForDecisionPulse();
        continue;
      }

      const worstCaseAmplificationShares = computeWorstCaseAmplificationShares(state, decision.entryBuys);
      const controlledOverlapActive = shouldAllowControlledOverlap({
        config,
        nowTs,
        secsToClose: market.endTs - nowTs,
        partialOpenGroupLock,
        completionActive: overlapCompletionActive,
        linkageHealthy: pairgroupLinkageHealthy,
        entryBuys: decision.entryBuys,
        matchedInventoryTargetMet,
        worstCaseAmplificationShares,
      });

      if (partialOpenGroupLock && decision.entryBuys.length > 1 && !controlledOverlapActive) {
        await traceLogger.write("risk_events", {
          reason: "controlled_overlap_blocked",
          partialGroupId: partialOpenGroupLock.groupId,
          partialStatus: partialOpenGroupLock.status,
          partialAgeSec,
          completionActive: overlapCompletionActive,
          linkageHealthy: pairgroupLinkageHealthy,
          matchedInventoryTargetMet,
          worstCaseAmplificationShares,
          secsToClose: market.endTs - nowTs,
        });
        await waitForDecisionPulse();
        continue;
      }

      if (decision.entryBuys.length > 0) {
        const submittedAtTs = nowTs;
        const submittedAtMs = Date.now();
        for (const entryBuy of decision.entryBuys) {
          assertClassifiedBuyMode(entryBuy.mode, config);
        }
        if (decision.entryBuys.length === 2) {
          const upEntry = decision.entryBuys.find((entryBuy) => entryBuy.side === "UP");
          const downEntry = decision.entryBuys.find((entryBuy) => entryBuy.side === "DOWN");
          if (!upEntry || !downEntry) {
            throw new Error("Balanced pair entry expected both UP and DOWN legs.");
          }

          const group = createPairOrderGroup({
            conditionId: market.conditionId,
            marketSlug: market.slug,
            upTokenId: market.tokens.UP.tokenId,
            downTokenId: market.tokens.DOWN.tokenId,
            intendedQty: Math.min(upEntry.size, downEntry.size),
            maxUpPrice: upEntry.order.price,
            maxDownPrice: downEntry.order.price,
            mode: config.botMode,
            selectedMode: upEntry.mode as
              | "STRICT_PAIR_SWEEP"
              | "XUAN_SOFT_PAIR_SWEEP"
              | "XUAN_HARD_PAIR_SWEEP"
              | "TEMPORAL_SINGLE_LEG_SEED"
              | "PAIRGROUP_COVERED_SEED",
            createdAt: submittedAtMs,
            state,
            rawPair: upEntry.rawPairCost ?? 0,
            effectivePair: upEntry.pairCostWithFees ?? 0,
            negativeEdgeUsdc: upEntry.negativeEdgeUsdc ?? 0,
          });
          const groupedEntries = applyPairOrderType(decision.entryBuys, group);
          const missingSide: OutcomeSide = state.upShares > state.downShares ? "DOWN" : "UP";
          const sequentialPairExecutionActive =
            controlledOverlapActive || group.selectedMode === "PAIRGROUP_COVERED_SEED";
          const orderedEntries =
            group.selectedMode === "PAIRGROUP_COVERED_SEED"
              ? groupedEntries
              : controlledOverlapActive
                ? [...groupedEntries].sort((left, right) => {
                    if (left.side === right.side) return 0;
                    return left.side === missingSide ? -1 : 1;
                  })
                : groupedEntries;
          const groupedEntryBySide = {
            UP: groupedEntries.find((entryBuy) => entryBuy.side === "UP")!,
            DOWN: groupedEntries.find((entryBuy) => entryBuy.side === "DOWN")!,
          } satisfies Record<OutcomeSide, EntryBuyDecision>;
          const orderPlanBySide = buildPairOrderPlan({
            config,
            entriesBySide: groupedEntryBySide,
            books,
            minOrderSize: state.market.minOrderSize,
            cachedUsdcBalance,
          });
          activePairSubmission = {
            groupId: group.groupId,
            expiresAt: submittedAtTs + submittedIntentMaxAgeSec,
            entries: groupedEntries.map((entryBuy) => ({
              outcome: entryBuy.side,
              price: orderPlanBySide[entryBuy.side][0]?.price,
              expectedShares: sumOrderShareTargets(orderPlanBySide[entryBuy.side]),
              mode: entryBuy.mode,
            })),
          };
          const executedBySide = await executePairOrderPlan({
            completionManager,
            orderPlanBySide,
            orderedEntries,
            sequentialPairExecutionActive,
          });
          const upResult = selectRepresentativeResult(executedBySide.UP);
          const downResult = selectRepresentativeResult(executedBySide.DOWN);
          const allExecutions = [...executedBySide.UP, ...executedBySide.DOWN];

          rememberSubmittedPrices(
            submittedPrices,
            market,
            allExecutions.map(({ order, result }) => ({
              ...order,
              side: order.side,
              mode:
                order.tokenId === market.tokens.UP.tokenId
                  ? groupedEntryBySide.UP.mode
                  : groupedEntryBySide.DOWN.mode,
              groupId: group.groupId,
              orderId: result.orderId,
              expectedShares: expectedSharesForSubmission(order.shareTarget, result),
            })),
            submittedAtTs,
          );
          const negativeEdgeUsdc = estimateNegativeEdgeUsdc(upEntry.pairCostWithFees ?? 1, group.intendedQty);
          pairGroupCount += 1;
          entrySubmitCount += allExecutions.length;
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          const anyAccepted = Boolean(
            (upResult && isOrderResultAccepted(upResult)) ||
              (downResult && isOrderResultAccepted(downResult)),
          );
          const pairFinalizeTimeoutMs = anyAccepted
            ? Math.max(config.pairgroupFinalizeTimeoutMs, submittedIntentMaxAgeSec * 1000)
            : config.pairgroupFinalizeTimeoutMs;
          pendingPairExecution = {
            group,
            upResult,
            downResult,
            negativeEdgeUsdc,
            deadlineAt: Date.now() + Math.max(config.reentryDelayMs * 3, pairFinalizeTimeoutMs),
            status: "PENDING",
            submittedAt: submittedAtTs,
            reconciledAfterSubmit: false,
          };
          stateStore.upsertPairGroup(group);
          let immediateFinalizedPairExecution: PairExecutionResult | undefined;
          const immediateOrderResultFills = allExecutions.flatMap(({ order, result }) => {
            const outcome: OutcomeSide = order.tokenId === market.tokens.UP.tokenId ? "UP" : "DOWN";
            const mode = outcome === "UP" ? upEntry.mode : downEntry.mode;
            const fill = inferImmediateOrderResultFill({
              result,
              order,
              outcome,
              nowTs,
              mode,
            });
            return fill ? [{ fill, result, mode }] : [];
          });
          for (const immediateFill of immediateOrderResultFills) {
            state = applyFill(state, immediateFill.fill);
            stateStore.recordFill(state, immediateFill.fill, {
              orderId: immediateFill.result?.orderId,
              groupId: group.groupId,
              executionMode: immediateFill.mode,
              source: "ORDER_RESULT",
            });
            rememberBotOwnedBuyFill(immediateFill.fill, {
              groupId: group.groupId,
              orderId: immediateFill.result?.orderId,
            });
            consumeSubmittedIntent(submittedPrices, immediateFill.fill.outcome, immediateFill.fill.size);
            rememberOrderResultFillSuppression(immediateFill.fill);
            pushEvent(events, {
              timestamp: nowTs,
              type: "order_result_fill",
              groupId: group.groupId,
              outcome: immediateFill.fill.outcome,
              size: immediateFill.fill.size,
              price: immediateFill.fill.price,
              orderId: immediateFill.result?.orderId ?? null,
            });
            await traceLogger.write("user_fills", {
              eventType: "order_result_fill",
              outcome: immediateFill.fill.outcome,
              side: immediateFill.fill.side,
              size: immediateFill.fill.size,
              price: immediateFill.fill.price,
              executionMode: immediateFill.mode,
              groupId: group.groupId,
              orderId: immediateFill.result?.orderId ?? null,
              source: "ORDER_RESULT",
              correlationId: group.groupId,
            });
          }
          if (immediateOrderResultFills.length > 0) {
            immediateFinalizedPairExecution = finalizePairExecutionResult({
              group,
              upResult,
              downResult,
              state,
              fillSnapshot: stateStore.loadPairGroupFillSnapshot(group.groupId),
              reconcileObservedAfterSubmit: false,
              requireReconcileBeforeNoneFilled: true,
            });
            pendingPairExecution = {
              ...pendingPairExecution,
              status: immediateFinalizedPairExecution.status,
            };
            stateStore.upsertMarketState(state, "order_result_fill");
          }
          pushEvent(events, {
            timestamp: nowTs,
            type: "pair_group_submit",
            groupId: group.groupId,
            selectedMode: group.selectedMode,
            orderType: group.orderType,
            intendedQty: group.intendedQty,
            maxUpPrice: group.maxUpPrice,
            maxDownPrice: group.maxDownPrice,
            rawPair: group.rawPair,
            pairCostWithFees: upEntry.pairCostWithFees,
            negativeEdgeUsdc,
            marketNegativeSpentBefore: group.marketNegativeSpentBefore,
            marketNegativeSpentAfter: group.marketNegativeSpentAfter,
            controlledOverlap: controlledOverlapActive,
            upChildOrderCount: executedBySide.UP.length,
            downChildOrderCount: executedBySide.DOWN.length,
            upResult,
            downResult,
          });
          await traceLogger.write("pair_groups", {
            eventType: "pair_group_submit",
            pairGroupId: group.groupId,
            status: "SUBMITTED",
            selectedMode: group.selectedMode,
            intendedQty: group.intendedQty,
            rawPair: group.rawPair,
            effectivePair: group.effectivePair,
            negativeEdgeUsdc,
            maxUpPrice: group.maxUpPrice ?? null,
            maxDownPrice: group.maxDownPrice ?? null,
            orderType: group.orderType,
            marketNegativeSpentBefore: group.marketNegativeSpentBefore,
            marketNegativeSpentAfter: group.marketNegativeSpentAfter,
            filledUpQty: null,
            filledDownQty: null,
            correlationId: group.groupId,
          });
          await traceLogger.write("orders", {
            eventType: "pair_orders_submit",
            pairGroupId: group.groupId,
            orderType: group.orderType,
            controlledOverlap: controlledOverlapActive,
            sequentialPairExecution: sequentialPairExecutionActive,
            upChildOrderCount: executedBySide.UP.length,
            downChildOrderCount: executedBySide.DOWN.length,
            upOrderId: upResult?.orderId ?? null,
            downOrderId: downResult?.orderId ?? null,
            upStatus: upResult?.status ?? null,
            downStatus: downResult?.status ?? null,
            upAccepted: upResult ? isOrderResultAccepted(upResult) : false,
            downAccepted: downResult ? isOrderResultAccepted(downResult) : false,
            upChildResults: executedBySide.UP.map((execution) => summarizeOrderResult(execution.result)),
            downChildResults: executedBySide.DOWN.map((execution) => summarizeOrderResult(execution.result)),
            upResult: upResult ? summarizeOrderResult(upResult) : null,
            downResult: downResult ? summarizeOrderResult(downResult) : null,
          });
          emitLiveMirror("pair_group_submit", {
            marketSlug: market.slug,
            pairGroupId: group.groupId,
            selectedMode: group.selectedMode,
            orderType: group.orderType,
            intendedQty: group.intendedQty,
            rawPair: group.rawPair,
            effectivePair: group.effectivePair,
            negativeEdgeUsdc,
            controlledOverlap: controlledOverlapActive,
            sequentialPairExecution: sequentialPairExecutionActive,
            up: {
              price: group.maxUpPrice ?? null,
              shareTarget: sumOrderShareTargets(orderPlanBySide.UP) ?? null,
              spendAmount: sumOrderAmounts(orderPlanBySide.UP),
              childOrderCount: executedBySide.UP.length,
              orderId: upResult?.orderId ?? null,
              status: upResult?.status ?? null,
              accepted: upResult ? isOrderResultAccepted(upResult) : false,
            },
            down: {
              price: group.maxDownPrice ?? null,
              shareTarget: sumOrderShareTargets(orderPlanBySide.DOWN) ?? null,
              spendAmount: sumOrderAmounts(orderPlanBySide.DOWN),
              childOrderCount: executedBySide.DOWN.length,
              orderId: downResult?.orderId ?? null,
              status: downResult?.status ?? null,
              accepted: downResult ? isOrderResultAccepted(downResult) : false,
            },
          });
          if (immediateFinalizedPairExecution && pendingPairExecution) {
            await persistFinalizedPairGroup(immediateFinalizedPairExecution, pendingPairExecution, nowTs);
            pendingPairExecution = undefined;
            activePairSubmission = undefined;
          }
        } else {
          const entryBuy = decision.entryBuys[0];
          if (!entryBuy) {
            throw new Error("Expected a single entry buy decision.");
          }
          const temporalSeedGroup =
            entryBuy.mode === "TEMPORAL_SINGLE_LEG_SEED"
              ? createPairOrderGroup({
                  conditionId: market.conditionId,
                  marketSlug: market.slug,
                  upTokenId: market.tokens.UP.tokenId,
                  downTokenId: market.tokens.DOWN.tokenId,
                  intendedQty: entryBuy.size,
                  ...(entryBuy.side === "UP" ? { maxUpPrice: entryBuy.order.price } : {}),
                  ...(entryBuy.side === "DOWN" ? { maxDownPrice: entryBuy.order.price } : {}),
                  mode: config.botMode,
                  selectedMode: "TEMPORAL_SINGLE_LEG_SEED",
                  createdAt: submittedAtMs,
                  state,
                  rawPair: entryBuy.rawPairCost ?? 0,
                  effectivePair: entryBuy.pairCostWithFees ?? 0,
                  negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
                })
              : undefined;
          const groupedSingleOrder = temporalSeedGroup
            ? {
                ...entryBuy.order,
                metadata: `${temporalSeedGroup.groupId}:${entryBuy.side}`,
              }
            : entryBuy.order;
          const plannedOrders =
            config.xuanCloneMode === "PUBLIC_FOOTPRINT"
              ? planCloneChildBuyOrders({
                  order: groupedSingleOrder,
                  outcome: entryBuy.side,
                  books,
                  minOrderSize: state.market.minOrderSize,
                })
              : [groupedSingleOrder];
          const liveOrders = assignSequentialUsdcBalances(plannedOrders, cachedUsdcBalance);
          if (temporalSeedGroup) {
            stateStore.upsertPairGroup(temporalSeedGroup);
            activePairSubmission = {
              groupId: temporalSeedGroup.groupId,
              expiresAt: submittedAtTs + submittedIntentMaxAgeSec,
              entries: [
                {
                  outcome: entryBuy.side,
                  price: liveOrders[0]?.price,
                  expectedShares: entryBuy.size,
                  mode: entryBuy.mode,
                },
              ],
            };
          }
          const executions = await executeMarketOrdersInSequence(completionManager, liveOrders);
          const representativeExecution = selectRepresentativeExecution(executions);
          const result = representativeExecution.result;
          const accepted = executions.some((execution) => isOrderResultAccepted(execution.result));
          rememberSubmittedPrices(
            submittedPrices,
            market,
            executions.map(({ order, result: executionResult }) => ({
              ...order,
              side: order.side,
              mode: entryBuy.mode,
              groupId: temporalSeedGroup?.groupId,
              orderId: executionResult.orderId,
              expectedShares: expectedSharesForSubmission(order.shareTarget, executionResult),
            })),
            submittedAtTs,
          );
          if (temporalSeedGroup) {
            pendingPairExecution = {
              group: temporalSeedGroup,
              upResult: entryBuy.side === "UP" ? result : undefined,
              downResult: entryBuy.side === "DOWN" ? result : undefined,
              negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
              deadlineAt: Date.now() + Math.max(config.reentryDelayMs * 3, config.pairgroupFinalizeTimeoutMs),
              status: "PENDING",
              submittedAt: submittedAtTs,
              reconciledAfterSubmit: false,
            };
          }
          if (accepted && !temporalSeedGroup) {
            state = reserveNegativeEdgeBudget(state, entryBuy.negativeEdgeUsdc ?? 0, "pair");
            persistDailyBudget(state);
            state = updateSeedSubmissionState(state, entryBuy.mode, entryBuy.side);
            stateStore.upsertMarketState(state);
          } else if (!accepted) {
            await logRejectedOrder({
              traceLogger,
              phase: "entry",
              mode: entryBuy.mode,
              side: entryBuy.side,
              size: entryBuy.size,
              result,
              order: representativeExecution.order,
              negativeEdgeUsdc: entryBuy.negativeEdgeUsdc,
            });
          }
          if (temporalSeedGroup && pendingPairExecution) {
            let sawImmediateFill = false;
            for (const execution of executions) {
              const immediateFill = inferImmediateOrderResultFill({
                result: execution.result,
                order: execution.order,
                outcome: entryBuy.side,
                nowTs,
                mode: entryBuy.mode,
              });
              if (!immediateFill) {
                continue;
              }
              sawImmediateFill = true;
              state = applyFill(state, immediateFill);
              stateStore.recordFill(state, immediateFill, {
                orderId: execution.result.orderId,
                groupId: temporalSeedGroup.groupId,
                executionMode: entryBuy.mode,
                source: "ORDER_RESULT",
              });
              rememberBotOwnedBuyFill(immediateFill, {
                groupId: temporalSeedGroup.groupId,
                orderId: execution.result.orderId,
              });
              consumeSubmittedIntent(submittedPrices, immediateFill.outcome, immediateFill.size);
              rememberOrderResultFillSuppression(immediateFill);
              pushEvent(events, {
                timestamp: nowTs,
                type: "order_result_fill",
                groupId: temporalSeedGroup.groupId,
                outcome: immediateFill.outcome,
                size: immediateFill.size,
                price: immediateFill.price,
                orderId: execution.result.orderId ?? null,
              });
              await traceLogger.write("user_fills", {
                eventType: "order_result_fill",
                outcome: immediateFill.outcome,
                side: immediateFill.side,
                size: immediateFill.size,
                price: immediateFill.price,
                executionMode: entryBuy.mode,
                groupId: temporalSeedGroup.groupId,
                orderId: execution.result.orderId ?? null,
                source: "ORDER_RESULT",
                correlationId: temporalSeedGroup.groupId,
              });
            }
            if (sawImmediateFill || !accepted) {
              const finalized = finalizePairExecutionResult({
                group: temporalSeedGroup,
                upResult: entryBuy.side === "UP" ? result : undefined,
                downResult: entryBuy.side === "DOWN" ? result : undefined,
                state,
                fillSnapshot: stateStore.loadPairGroupFillSnapshot(temporalSeedGroup.groupId),
                reconcileObservedAfterSubmit: false,
                requireReconcileBeforeNoneFilled: true,
              });
              pendingPairExecution = {
                ...pendingPairExecution,
                status: finalized.status,
              };
              await persistFinalizedPairGroup(finalized, pendingPairExecution, nowTs);
              pendingPairExecution = undefined;
              activePairSubmission = undefined;
            }
          }
          entrySubmitCount += 1;
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          pushEvent(events, {
            timestamp: nowTs,
            type: "entry_submit",
            orders: executions.map(({ order, result: executionResult }) => ({
              side: entryBuy.side,
              size: order.shareTarget ?? entryBuy.size,
              price: order.price,
              reason: entryBuy.reason,
              mode: entryBuy.mode,
              rawPair: entryBuy.rawPairCost ?? null,
              effectivePair: entryBuy.pairCostWithFees ?? null,
              negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
              shareTarget: order.shareTarget ?? null,
              spendAmount: order.amount,
              result: summarizeOrderResult(executionResult),
            })),
          });
          await traceLogger.write("orders", {
            eventType: "entry_submit",
            selectedMode: entryBuy.mode,
            side: entryBuy.side,
            size: entryBuy.size,
            childOrderCount: executions.length,
            price: representativeExecution.order.price ?? null,
            shareTarget: entryBuy.size,
            spendAmount: Number(executions.reduce((total, execution) => total + execution.order.amount, 0).toFixed(6)),
            negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
            orderId: result.orderId,
            orderStatus: result.status,
            orderAccepted: accepted,
            orderResult: summarizeOrderResult(result),
            oldGap: decision.trace.entry.repairOldGap ?? decision.trace.shareGap,
            newGapEstimate: decision.trace.entry.repairNewGap ?? null,
            wouldIncreaseImbalance: decision.trace.entry.repairWouldIncreaseImbalance ?? null,
            requestedQty: decision.trace.entry.repairRequestedQty ?? entryBuy.size,
            finalQty: decision.trace.entry.repairFinalQty ?? entryBuy.size,
            missingQty: decision.trace.entry.repairMissingQty ?? null,
            residualOppositeAveragePrice: decision.trace.entry.repairOppositeAveragePrice ?? null,
            effectiveCompletionCost: decision.trace.entry.repairCost ?? entryBuy.pairCostWithFees ?? null,
            capUsed: decision.trace.entry.repairCapMode ?? null,
            rejectReason: accepted ? null : decision.trace.entry.skipReason ?? null,
            correlationId: result.orderId,
          });
          emitLiveMirror("entry_submit", {
            marketSlug: market.slug,
            selectedMode: entryBuy.mode,
            outcome: entryBuy.side,
            reason: entryBuy.reason,
            size: entryBuy.size,
            childOrderCount: executions.length,
            price: representativeExecution.order.price ?? null,
            shareTarget: entryBuy.size,
            spendAmount: Number(executions.reduce((total, execution) => total + execution.order.amount, 0).toFixed(6)),
            rawPair: entryBuy.rawPairCost ?? null,
            effectivePair: entryBuy.pairCostWithFees ?? null,
            negativeEdgeUsdc: entryBuy.negativeEdgeUsdc ?? 0,
            orderId: result.orderId ?? null,
            orderStatus: result.status,
            orderAccepted: accepted,
            oldGap: decision.trace.entry.repairOldGap ?? decision.trace.shareGap,
            newGapEstimate: decision.trace.entry.repairNewGap ?? null,
            missingQty: decision.trace.entry.repairMissingQty ?? null,
            capUsed: decision.trace.entry.repairCapMode ?? null,
            rejectReason: accepted ? null : decision.trace.entry.skipReason ?? null,
          });
        }
        await waitForDecisionPulse();
        continue;
      }

      if (decision.completion) {
        assertClassifiedBuyMode(decision.completion.mode, config);
        const liveOrder = withAvailableUsdcBalance(decision.completion.order, cachedUsdcBalance);
        const result = await completionManager.complete(liveOrder);
        rememberSubmittedPrices(
          submittedPrices,
          market,
          [
            {
              ...decision.completion.order,
              side: decision.completion.order.side,
              mode: decision.completion.mode,
              orderId: result.orderId,
              expectedShares: expectedSharesForSubmission(liveOrder.shareTarget, result),
            },
          ],
          nowTs,
        );
        const accepted = isOrderResultAccepted(result);
        if (accepted) {
          state = reserveNegativeEdgeBudget(state, decision.completion.negativeEdgeUsdc, "completion");
          persistDailyBudget(state);
          state = updateSeedSubmissionState(state, decision.completion.mode, decision.completion.sideToBuy);
          stateStore.upsertMarketState(state);
        } else {
          await logRejectedOrder({
            traceLogger,
            phase: "completion",
            mode: decision.completion.mode,
            side: decision.completion.sideToBuy,
            size: decision.completion.missingShares,
            result,
            order: liveOrder,
            negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          });
        }
        completionSubmitCount += 1;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "completion_submit",
          outcome: decision.completion.sideToBuy,
          mode: decision.completion.mode,
          size: decision.completion.missingShares,
          price: liveOrder.price,
          shareTarget: liveOrder.shareTarget ?? null,
          spendAmount: liveOrder.amount,
          costWithFees: decision.completion.costWithFees,
          capMode: decision.completion.capMode,
          negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          result: summarizeOrderResult(result),
        });
        await traceLogger.write("orders", {
          eventType: "completion_submit",
          normalizedMode: `COMPLETION_${decision.completion.sideToBuy}`,
          outcome: decision.completion.sideToBuy,
          size: decision.completion.missingShares,
          price: liveOrder.price ?? null,
          shareTarget: liveOrder.shareTarget ?? null,
          spendAmount: liveOrder.amount,
          capMode: decision.completion.capMode,
          negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          orderId: result.orderId,
          orderStatus: result.status,
          orderAccepted: accepted,
          orderResult: summarizeOrderResult(result),
          oldGap: decision.completion.oldGap,
          newGapEstimate: decision.completion.newGap,
          wouldIncreaseImbalance:
            decision.completion.newGap > decision.completion.oldGap + config.maxCompletionOvershootShares,
          requestedQty: decision.completion.missingShares,
          finalQty: decision.completion.missingShares,
          missingQty: Math.abs(state.upShares - state.downShares),
          residualOppositeAveragePrice: decision.completion.oppositeAveragePrice,
          missingSideAveragePrice: decision.completion.missingSideAveragePrice,
          effectiveCompletionCost: decision.completion.costWithFees,
          highLowMismatch: decision.completion.highLowMismatch,
          capUsed: decision.completion.capMode,
          rejectReason: accepted ? null : "completion_rejected",
          correlationId: result.orderId,
        });
        emitLiveMirror("completion_submit", {
          marketSlug: market.slug,
          normalizedMode: `COMPLETION_${decision.completion.sideToBuy}`,
          outcome: decision.completion.sideToBuy,
          size: decision.completion.missingShares,
          price: liveOrder.price ?? null,
          shareTarget: liveOrder.shareTarget ?? null,
          spendAmount: liveOrder.amount,
          capMode: decision.completion.capMode,
          negativeEdgeUsdc: decision.completion.negativeEdgeUsdc,
          orderId: result.orderId ?? null,
          orderStatus: result.status,
          orderAccepted: accepted,
          oldGap: decision.completion.oldGap,
          newGapEstimate: decision.completion.newGap,
          missingQty: Math.abs(state.upShares - state.downShares),
          residualOppositeAveragePrice: decision.completion.oppositeAveragePrice,
          missingSideAveragePrice: decision.completion.missingSideAveragePrice,
          effectiveCompletionCost: decision.completion.costWithFees,
          highLowMismatch: decision.completion.highLowMismatch,
          rejectReason: accepted ? null : "completion_rejected",
        });
        await waitForDecisionPulse();
        continue;
      }

      if (decision.unwind) {
        const liveOrder = withAvailableUsdcBalance(decision.unwind.order, cachedUsdcBalance);
        const result = await completionManager.complete(liveOrder);
        rememberSubmittedPrices(
          submittedPrices,
          market,
          [
            {
              ...decision.unwind.order,
              side: decision.unwind.order.side,
              mode: decision.unwind.mode,
              orderId: result.orderId,
              expectedShares: expectedSharesForSubmission(liveOrder.shareTarget, result),
            },
          ],
          nowTs,
        );
        const accepted = isOrderResultAccepted(result);
        if (accepted) {
          state = updateSeedSubmissionState(state, decision.unwind.mode, decision.unwind.sideToSell);
          stateStore.upsertMarketState(state);
        } else {
          await logRejectedOrder({
            traceLogger,
            phase: "unwind",
            mode: decision.unwind.mode,
            side: decision.unwind.sideToSell,
            size: decision.unwind.unwindShares,
            result,
            order: liveOrder,
          });
        }
        unwindSubmitCount += 1;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "unwind_submit",
          outcome: decision.unwind.sideToSell,
          mode: decision.unwind.mode,
          size: decision.unwind.unwindShares,
          price: liveOrder.price,
          shareTarget: liveOrder.shareTarget ?? null,
          amount: liveOrder.amount,
          result: summarizeOrderResult(result),
        });
        await traceLogger.write("orders", {
          eventType: "unwind_submit",
          outcome: decision.unwind.sideToSell,
          size: decision.unwind.unwindShares,
          price: liveOrder.price ?? null,
          shareTarget: liveOrder.shareTarget ?? null,
          amount: liveOrder.amount,
          orderId: result.orderId,
          orderStatus: result.status,
          orderAccepted: accepted,
          orderResult: summarizeOrderResult(result),
          correlationId: result.orderId,
        });
      }

      await waitForDecisionPulse();
    }

    if (resolvedOptions.postCloseReconcileSec > 0 && clock.now() >= market.endTs) {
      const postCloseStartedAt = clock.now();
      const postCloseDeadline = postCloseStartedAt + resolvedOptions.postCloseReconcileSec;
      let postCloseReconcileCount = 0;
      await traceLogger.write("market_rollover", {
        status: "post_close_reconcile_start",
        marketSlug: market.slug,
        startedAt: postCloseStartedAt,
        deadlineTs: postCloseDeadline,
        pendingPairGroupId: pendingPairExecution?.group.groupId ?? null,
      });
      while (clock.now() <= postCloseDeadline) {
        const nowTs = clock.now();
        const books = buildBooks(marketWs, market);
        if (
          postCloseReconcileCount === 0 ||
          nowTs - lastBalanceSyncAt >= Math.floor(resolvedOptions.balanceSyncMs / 1000)
        ) {
          await performBalanceSync({
            nowTs,
            books,
            scope: "post_close_reconcile",
            traceLabel: "post_close_reconcile_state",
          });
          postCloseReconcileCount += 1;
          await finalizePendingPairExecutionIfReady(nowTs, { forceDeadline: true });
        }

        if (postCloseReconcileCount >= 2 && !pendingPairExecution) {
          break;
        }

        const remainingMs = Math.max(0, (postCloseDeadline - clock.now()) * 1000);
        if (remainingMs <= 0) {
          break;
        }
        await sleep(Math.min(resolvedOptions.balanceSyncMs, remainingMs));
      }
      await traceLogger.write("market_rollover", {
        status: "post_close_reconcile_end",
        marketSlug: market.slug,
        endedAt: clock.now(),
        balanceSyncCount: postCloseReconcileCount,
        pendingPairGroupId: pendingPairExecution?.group.groupId ?? null,
      });
    }
  } finally {
    btcPriceFeed.disconnect();
    marketWs.disconnect();
    userWs.disconnect();
  }

  const endedAt = clock.now();
  const closingMergePlan = planMerge(config, state);
  const closingPendingFillSnapshot = pendingPairExecution
    ? stateStore.loadPairGroupFillSnapshot(pendingPairExecution.group.groupId)
    : undefined;
  const closingLockedPendingShares = computePendingLockedShares(
    pendingPairExecution,
    closingPendingFillSnapshot,
    config,
  );
  const closingMergeableUnlocked = config.mergeOnlyConfirmedMatchedUnlockedLots
    ? unlockedMergeableShares(state, closingLockedPendingShares)
    : closingMergePlan.mergeable;
  const closingMergeAmount = normalizeMergeAmount(closingMergeableUnlocked, config.mergeDustLeaveShares);
  if (
    config.mergeMode === "AUTO" &&
    config.mergeOnMarketClose &&
    endedAt >= market.endTs &&
    closingMergeAmount >= config.mergeMinShares &&
    (!pendingPairExecution || config.allowMergeWithPendingGroups) &&
    mergeTxCount < config.mergeMaxTxPerMarket
  ) {
    const closingMergeResult = env.CTF_MERGE_ENABLED
      ? await ctf.mergePositions(market.conditionId, closingMergeAmount)
      : {
          simulated: true,
          skipped: true,
          action: "merge" as const,
          amount: closingMergeAmount,
          conditionId: market.conditionId,
          reason: "CTF_MERGE_ENABLED=false",
        };
    if (closingMergeResult.simulated || !closingMergeResult.skipped) {
      const preMergeState = state;
      state = applyMerge(state, {
        amount: closingMergeAmount,
        timestamp: endedAt,
        simulated: closingMergeResult.simulated,
      });
      stateStore.recordMerge(preMergeState, state.mergeHistory.at(-1) ?? {
        amount: closingMergeAmount,
        timestamp: endedAt,
        simulated: closingMergeResult.simulated,
      });
      if (config.postMergeOnlyCompletion) {
        const residualAfterMerge = Math.abs(state.upShares - state.downShares);
        if (config.postMergeOnlyCompletionWhileResidual && residualAfterMerge > config.postMergeFlatDustShares) {
          state = {
            ...state,
            reentryDisabled: true,
            postMergeCompletionOnlyUntil: undefined,
          };
        } else if (config.postMergeAllowNewPairIfFlat) {
          state = {
            ...state,
            reentryDisabled: false,
            postMergeCompletionOnlyUntil:
              endedAt + Math.ceil(config.postMergePairReopenCooldownMs / 1000),
          };
        } else {
          state = {
            ...state,
            reentryDisabled: true,
            postMergeCompletionOnlyUntil:
              endedAt + Math.ceil(config.postMergeNewSeedCooldownMs / 1000),
          };
        }
      }
      mergeCount += 1;
      stateStore.upsertMarketState(state, state.reentryDisabled ? "post_merge_completion_only" : undefined);
    }
    await traceLogger.write("merge_redeem", {
      action: "merge",
      amount: closingMergeAmount,
      trigger: "market_close",
      txHash: closingMergeResult.txHash ?? null,
      simulated: closingMergeResult.simulated,
      skipped: closingMergeResult.skipped ?? false,
      matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
      matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
      mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
      realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
      remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
      remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
      postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
    });
    emitLiveMirror("merge_submit", {
      marketSlug: market.slug,
      trigger: "market_close",
      amount: closingMergeAmount,
      txHash: closingMergeResult.txHash ?? null,
      simulated: closingMergeResult.simulated,
      skipped: closingMergeResult.skipped ?? false,
      matchedUpCost: state.mergeHistory.at(-1)?.matchedUpCost ?? null,
      matchedDownCost: state.mergeHistory.at(-1)?.matchedDownCost ?? null,
      mergeReturn: state.mergeHistory.at(-1)?.mergeReturn ?? null,
      realizedPnl: state.mergeHistory.at(-1)?.realizedPnl ?? null,
      remainingUpShares: state.mergeHistory.at(-1)?.remainingUpShares ?? null,
      remainingDownShares: state.mergeHistory.at(-1)?.remainingDownShares ?? null,
      postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
    });
  }
  const finalBooks = buildBooks(marketWs, market);
  const finalPostMergeCompletionOnlyActive =
    config.postMergeOnlyCompletion &&
    (state.reentryDisabled ||
      (state.postMergeCompletionOnlyUntil !== undefined && endedAt < state.postMergeCompletionOnlyUntil));
  const finalDecision = bot.evaluateTick({
    config,
    state,
    books: finalBooks,
    nowTs: endedAt,
    riskContext: {
      secsToClose: Math.max(0, market.endTs - endedAt),
      staleBookMs: 0,
      balanceStaleMs: Math.max(0, (endedAt - lastBalanceSyncAt) * 1000),
      bookIsCrossed: finalBooks.bestBid("UP") > finalBooks.bestAsk("UP") || finalBooks.bestBid("DOWN") > finalBooks.bestAsk("DOWN"),
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: cachedUsdcBalance,
      forceNoNewEntries: startupBlockNewEntries || finalPostMergeCompletionOnlyActive,
      forceCompletionOnly: startupCompletionOnly || finalPostMergeCompletionOnlyActive,
      forceSafeHalt: startupSafeHalt,
      externalReasons: [
        ...startupExternalReasons,
        ...(finalPostMergeCompletionOnlyActive ? ["post_merge_completion_only"] : []),
      ],
    },
    dryRunOrSmallLive: false,
    dailyNegativeEdgeSpentUsdc:
      resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc,
    fairValueSnapshot: latestFairValueSnapshot,
  });

  const payload: BotSessionReport = {
    runtime: {
      mode: "live",
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER ?? "",
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
      ctfMergeEnabled: env.CTF_MERGE_ENABLED,
    },
    market: {
      selection: selected.selection,
      slug: market.slug,
      conditionId: market.conditionId,
      startTs: market.startTs,
      endTs: market.endTs,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
    },
    options: resolvedOptions,
    summary: {
      startedAt,
      endedAt,
      ticks,
      userTradeCount,
      balanceSyncCount,
      balanceCorrectionCount,
      entrySubmitCount,
      pairGroupCount,
      partialLegCount,
      completionSubmitCount,
      unwindSubmitCount,
      mergeCount,
      adoptedInventory,
    },
    finalState: {
      upShares: state.upShares,
      downShares: state.downShares,
      upAverage: averageCost(state, "UP"),
      downAverage: averageCost(state, "DOWN"),
      fillCount: state.fillHistory.length,
      mergeCount: state.mergeHistory.length,
      negativeEdgeConsumedUsdc: state.negativeEdgeConsumedUsdc,
      negativePairEdgeConsumedUsdc: state.negativePairEdgeConsumedUsdc,
      negativeCompletionEdgeConsumedUsdc: state.negativeCompletionEdgeConsumedUsdc,
      initialDailyNegativeEdgeSpentUsdc: resolvedOptions.initialDailyNegativeEdgeSpentUsdc,
      finalDailyNegativeEdgeSpentUsdc: Number(
        (resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc).toFixed(6),
      ),
    },
    finalDecision,
    dashboard: renderDashboard(state, finalDecision, endedAt),
    events,
  };

  persistDailyBudget(state);
  await traceLogger.write("market_rollover", {
    status: "session_end",
    endedAt,
    upShares: state.upShares,
    downShares: state.downShares,
    mergeCount,
    fillCount: state.fillHistory.length,
    finalDailyNegativeEdgeSpentUsdc: Number(
      (resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc).toFixed(6),
    ),
  });
  stateStore.recordMarketRollover({
    status: "session_end",
    timestamp: endedAt,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    payload: {
      upShares: state.upShares,
      downShares: state.downShares,
      mergeCount,
      fillCount: state.fillHistory.length,
      finalDailyNegativeEdgeSpentUsdc: Number(
        (resolvedOptions.initialDailyNegativeEdgeSpentUsdc + state.negativeEdgeConsumedUsdc).toFixed(6),
      ),
    },
  });
  await traceLogger.flush();
  stateStore.close();

  await writeStructuredLog("orders", { event: "bot_live_stateful", ...payload });
  return payload;
}
