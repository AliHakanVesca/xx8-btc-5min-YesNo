import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { buildOfflineMarket } from "../infra/gamma/marketDiscovery.js";
import { SystemClock } from "../infra/time/clock.js";
import type { OrderBook } from "../infra/clob/types.js";
import { Xuan5mBot } from "../strategy/xuan5m/Xuan5mBot.js";
import { createMarketState } from "../strategy/xuan5m/marketState.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";
import { buildAcceptanceReport } from "./acceptanceMetrics.js";

export interface ReplayResult {
  marketSlug: string;
  decision: ReturnType<typeof buildAcceptanceReport>;
}

export function buildSyntheticBook(assetId: string, market: string, bid: number, ask: number): OrderBook {
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

export function runSyntheticReplay(env: AppEnv): ReplayResult {
  const clock = new SystemClock();
  const startTs = Math.floor(clock.now() / 300) * 300;
  const market = buildOfflineMarket(startTs);
  const state = createMarketState(market);
  const config = buildStrategyConfig(env);
  const bot = new Xuan5mBot();

  const decision = bot.evaluateTick({
    config,
    state,
    books: new OrderBookState(
      buildSyntheticBook(market.tokens.UP.tokenId, market.conditionId, 0.48, 0.49),
      buildSyntheticBook(market.tokens.DOWN.tokenId, market.conditionId, 0.48, 0.49),
    ),
    nowTs: startTs + 15,
    riskContext: {
      secsToClose: market.endTs - (startTs + 15),
      staleBookMs: 200,
      balanceStaleMs: 200,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    },
    dryRunOrSmallLive: true,
  });

  return {
    marketSlug: market.slug,
    decision: buildAcceptanceReport(decision),
  };
}
