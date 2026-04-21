import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { createClobAdapter } from "../infra/clob/index.js";
import type { MarketInfo, OrderBook, OutcomeSide, TradeSide } from "../infra/clob/types.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { Erc1155BalanceReader } from "../infra/polygon/erc1155Balances.js";
import { Erc20BalanceReader } from "../infra/polygon/erc20Balances.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { UserWsClient, type UserOrderEvent, type UserTradeEvent } from "../infra/ws/userWsClient.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { SystemClock } from "../infra/time/clock.js";
import { CtfClient } from "../infra/ctf/ctfClient.js";
import { createLogger, writeStructuredLog } from "../observability/logger.js";
import { renderDashboard } from "../observability/dashboard.js";
import { OrderManager } from "../execution/orderManager.js";
import { TakerCompletionManager } from "../execution/takerCompletionManager.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import { createMarketState, type FillRecord, type XuanMarketState } from "../strategy/xuan5m/marketState.js";
import { applyFill, applyMerge, averageCost } from "../strategy/xuan5m/inventoryState.js";
import { planMerge } from "../strategy/xuan5m/mergeCoordinator.js";

export interface BotSessionOptions {
  durationSec?: number;
  tickMs?: number;
  initialBookWaitMs?: number;
  balanceSyncMs?: number;
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

export interface StateReconcileResult {
  state: XuanMarketState;
  inferredFills: FillRecord[];
  corrections: BalanceCorrection[];
}

export interface SubmittedIntent {
  price?: number | undefined;
  submittedAt: number;
}

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
  };
  finalDecision: ReturnType<Xuan5mBot["evaluateTick"]>;
  dashboard: string;
  events: Array<Record<string, unknown>>;
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

function pushEvent(events: Array<Record<string, unknown>>, event: Record<string, unknown>, limit = 200): void {
  events.push(event);
  if (events.length > limit) {
    events.shift();
  }
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
): Promise<ObservedTokenBalances> {
  const balances = await reader.getBalances([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);
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
  const raw = await reader.getBalance(env.ACTIVE_COLLATERAL_TOKEN);
  return raw / 1_000_000;
}

export function inferUserTradeFill(args: {
  event: UserTradeEvent;
  market: MarketInfo;
  nowTs: number;
  submittedPrices: Partial<Record<OutcomeSide, SubmittedIntent>>;
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
  const fallbackIntent = args.submittedPrices[outcome];
  const price = parseNumeric(args.event.price) ?? weightedPrice ?? fallbackIntent?.price;
  const makerSide = makerOrders[0]?.side?.toUpperCase();
  const side: TradeSide = makerSide === "BUY" ? "SELL" : "BUY";

  return {
    outcome,
    side,
    price: clampFallbackPrice(price),
    size: Number(matchedSize.toFixed(6)),
    timestamp: args.nowTs,
    makerTaker: "taker",
  };
}

export function reconcileStateWithBalances(args: {
  state: XuanMarketState;
  observed: ObservedTokenBalances;
  nowTs: number;
  fallbackPrices: Record<OutcomeSide, number | undefined>;
}): StateReconcileResult {
  let state = { ...args.state };
  const inferredFills: FillRecord[] = [];
  const corrections: BalanceCorrection[] = [];

  const reconcileOutcome = (outcome: OutcomeSide, observedShares: number): void => {
    const sharesKey = outcome === "UP" ? "upShares" : "downShares";
    const costKey = outcome === "UP" ? "upCost" : "downCost";
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
      const averageBefore = averageCost(state, outcome);
      state = {
        ...state,
        [sharesKey]: normalizedObserved,
        [costKey]: Number((normalizedObserved * averageBefore).toFixed(6)),
      };
      corrections.push({
        outcome,
        fromShares: currentShares,
        toShares: normalizedObserved,
      });
    }
  };

  reconcileOutcome("UP", args.observed.up);
  reconcileOutcome("DOWN", args.observed.down);

  return { state, inferredFills, corrections };
}

function buildFallbackPrices(
  books: OrderBookState,
  submittedPrices: Partial<Record<OutcomeSide, SubmittedIntent>>,
): Record<OutcomeSide, number | undefined> {
  return {
    UP: submittedPrices.UP?.price ?? books.bestAsk("UP"),
    DOWN: submittedPrices.DOWN?.price ?? books.bestAsk("DOWN"),
  };
}

function rememberSubmittedPrices(
  submittedPrices: Partial<Record<OutcomeSide, SubmittedIntent>>,
  market: MarketInfo,
  orders: Array<{ tokenId: string; price?: number | undefined }>,
  submittedAt: number,
): void {
  for (const order of orders) {
    const outcome = outcomeForAssetId(market, order.tokenId);
    if (!outcome) {
      continue;
    }
    submittedPrices[outcome] = {
      price: order.price,
      submittedAt,
    };
  }
}

function buildBooks(client: MarketWsClient, market: MarketInfo): OrderBookState {
  return new OrderBookState(client.getBook(market.tokens.UP.tokenId), client.getBook(market.tokens.DOWN.tokenId));
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
    tickMs: Math.max(250, Math.floor(options.tickMs ?? 1000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
    balanceSyncMs: Math.max(1000, Math.floor(options.balanceSyncMs ?? 5000)),
  };

  const logger = createLogger(env);
  const config = buildStrategyConfig(env);
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
  const selected = pickSessionMarket(discovery, startedAt, config.normalEntryCutoffSecToClose);
  const market = selected.market;
  let state = createMarketState(market);
  let cachedUsdcBalance = (await readCollateralBalanceUsdc(env)) ?? Math.max(config.minUsdcBalance, 100);
  let lastBalanceSyncAt = 0;
  let actionCooldownUntil = 0;
  let adoptedInventory = false;
  let userTradeCount = 0;
  let balanceSyncCount = 0;
  let balanceCorrectionCount = 0;
  let entrySubmitCount = 0;
  let completionSubmitCount = 0;
  let unwindSubmitCount = 0;
  let mergeCount = 0;
  let ticks = 0;
  const submittedPrices: Partial<Record<OutcomeSide, SubmittedIntent>> = {};
  const seenTradeIds = new Set<string>();
  const events: Array<Record<string, unknown>> = [];

  marketWs.connect([market.tokens.UP.tokenId, market.tokens.DOWN.tokenId]);
  userWs.connect([market.conditionId]);

  userWs.on("warn", (error: Error) => {
    logger.warn({ error }, "User websocket warning.");
    pushEvent(events, { timestamp: clock.now(), type: "user_ws_warn", message: error.message });
  });
  userWs.on("error", (error: Error) => {
    logger.error({ error }, "User websocket error.");
    pushEvent(events, { timestamp: clock.now(), type: "user_ws_error", message: error.message });
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
      return;
    }

    state = applyFill(state, fill);
    userTradeCount += 1;
    pushEvent(events, {
      timestamp: fill.timestamp,
      type: "user_fill",
      eventId: event.id,
      outcome: fill.outcome,
      side: fill.side,
      size: fill.size,
      price: fill.price,
    });
  });

  try {
    const initial = await waitForInitialBooks(marketWs, market, resolvedOptions.initialBookWaitMs);
    const initialBooks = new OrderBookState(initial.upBook, initial.downBook);
    const initialBalances = await readObservedBalances(balanceReader, market);
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
      adoptedInventory = adopted.inferredFills.length > 0 || adopted.corrections.length > 0;
      if (adoptedInventory) {
        pushEvent(events, {
          timestamp: startedAt,
          type: "startup_inventory_adopted",
          upShares: state.upShares,
          downShares: state.downShares,
        });
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
        await sleep(resolvedOptions.tickMs);
        continue;
      }

      if (nowTs - lastBalanceSyncAt >= Math.floor(resolvedOptions.balanceSyncMs / 1000)) {
        lastBalanceSyncAt = nowTs;
        balanceSyncCount += 1;
        cachedUsdcBalance = (await readCollateralBalanceUsdc(env)) ?? cachedUsdcBalance;

        const reconciled = reconcileStateWithBalances({
          state,
          observed: await readObservedBalances(balanceReader, market),
          nowTs,
          fallbackPrices: buildFallbackPrices(books, submittedPrices),
        });
        state = reconciled.state;
        balanceCorrectionCount += reconciled.corrections.length;

        for (const fill of reconciled.inferredFills) {
          pushEvent(events, {
            timestamp: nowTs,
            type: "balance_sync_fill",
            outcome: fill.outcome,
            size: fill.size,
            price: fill.price,
          });
        }
        for (const correction of reconciled.corrections) {
          pushEvent(events, {
            timestamp: nowTs,
            type: "balance_sync_correction",
            outcome: correction.outcome,
            fromShares: correction.fromShares,
            toShares: correction.toShares,
          });
        }
      }

      if (Date.now() >= actionCooldownUntil) {
        const mergePlan = planMerge(config, state);
        if (mergePlan.shouldMerge && mergePlan.mergeable > 0) {
          const mergeResult = env.CTF_MERGE_ENABLED
            ? await ctf.mergePositions(market.conditionId, mergePlan.mergeable)
            : {
                simulated: true,
                skipped: true,
                action: "merge" as const,
                amount: mergePlan.mergeable,
                conditionId: market.conditionId,
                reason: "CTF_MERGE_ENABLED=false",
              };
          if (mergeResult.simulated || !mergeResult.skipped) {
            state = applyMerge(state, {
              amount: mergePlan.mergeable,
              timestamp: nowTs,
              simulated: mergeResult.simulated,
            });
            mergeCount += 1;
          }
          actionCooldownUntil = Date.now() + config.reentryDelayMs;
          pushEvent(events, {
            timestamp: nowTs,
            type: "merge",
            amount: mergePlan.mergeable,
            result: mergeResult,
          });
          await sleep(resolvedOptions.tickMs);
          continue;
        }
      }

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
        },
        dryRunOrSmallLive: false,
      });

      if (Date.now() < actionCooldownUntil) {
        await sleep(resolvedOptions.tickMs);
        continue;
      }

      if (decision.entryBuys.length > 0) {
        const submittedAt = Date.now();
        const results = await Promise.all(decision.entryBuys.map((entryBuy) => completionManager.execute(entryBuy.order)));
        rememberSubmittedPrices(submittedPrices, market, decision.entryBuys.map((entryBuy) => entryBuy.order), submittedAt);
        entrySubmitCount += decision.entryBuys.length;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "entry_submit",
          orders: decision.entryBuys.map((entryBuy, index) => ({
            side: entryBuy.side,
            size: entryBuy.size,
            price: entryBuy.order.price,
            reason: entryBuy.reason,
            result: results[index],
          })),
        });
        await sleep(resolvedOptions.tickMs);
        continue;
      }

      if (decision.completion) {
        const result = await completionManager.complete(decision.completion.order);
        rememberSubmittedPrices(submittedPrices, market, [decision.completion.order], Date.now());
        completionSubmitCount += 1;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "completion_submit",
          outcome: decision.completion.sideToBuy,
          size: decision.completion.missingShares,
          price: decision.completion.order.price,
          costWithFees: decision.completion.costWithFees,
          result,
        });
        await sleep(resolvedOptions.tickMs);
        continue;
      }

      if (decision.unwind) {
        const result = await completionManager.complete(decision.unwind.order);
        rememberSubmittedPrices(submittedPrices, market, [decision.unwind.order], Date.now());
        unwindSubmitCount += 1;
        actionCooldownUntil = Date.now() + config.reentryDelayMs;
        pushEvent(events, {
          timestamp: nowTs,
          type: "unwind_submit",
          outcome: decision.unwind.sideToSell,
          size: decision.unwind.unwindShares,
          price: decision.unwind.order.price,
          result,
        });
      }

      await sleep(resolvedOptions.tickMs);
    }
  } finally {
    marketWs.disconnect();
    userWs.disconnect();
  }

  const endedAt = clock.now();
  const finalBooks = buildBooks(marketWs, market);
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
    },
    dryRunOrSmallLive: false,
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
    },
    finalDecision,
    dashboard: renderDashboard(state, finalDecision, endedAt),
    events,
  };

  await writeStructuredLog("orders", { event: "bot_live_stateful", ...payload });
  return payload;
}
