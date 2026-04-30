import { describe, expect, it } from "vitest";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { planCloneChildBuyOrders } from "../../src/live/childOrderPlanner.js";
import { OrderBookState } from "../../src/strategy/xuan5m/orderBookState.js";

function buildBook(
  assetId: string,
  market: string,
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
) {
  return {
    market,
    assetId,
    timestamp: 1713696010,
    bids,
    asks,
    minOrderSize: 5,
    tickSize: 0.01,
    negRisk: false,
  };
}

describe("child order planner", () => {
  it("splits large clone buy orders into sequential child clips using visible ask depth", () => {
    const market = buildOfflineMarket(1713696000);
    const books = new OrderBookState(
      buildBook(
        market.tokens.UP.tokenId,
        market.conditionId,
        [{ price: 0.4, size: 200 }],
        [
          { price: 0.41, size: 20 },
          { price: 0.42, size: 30 },
          { price: 0.43, size: 50 },
        ],
      ),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.59, size: 200 }]),
    );

    const children = planCloneChildBuyOrders({
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.43,
        amount: 43,
        shareTarget: 100,
        orderType: "FAK",
      },
      outcome: "UP",
      books,
      minOrderSize: market.minOrderSize,
      preferredChildShares: 25,
      maxChildOrders: 6,
    });

    expect(children).toHaveLength(4);
    expect(children.map((child) => child.shareTarget)).toEqual([20, 30, 25, 25]);
    expect(children.map((child) => child.price)).toEqual([0.41, 0.42, 0.43, 0.43]);
    expect(children.reduce((total, child) => total + (child.shareTarget ?? 0), 0)).toBe(100);
  });

  it("keeps smaller buy orders as a single clip", () => {
    const market = buildOfflineMarket(1713696000);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.41, size: 100 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.59, size: 200 }]),
    );

    const children = planCloneChildBuyOrders({
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.41,
        amount: 8.2,
        shareTarget: 20,
        orderType: "FAK",
      },
      outcome: "UP",
      books,
      minOrderSize: market.minOrderSize,
    });

    expect(children).toHaveLength(1);
    expect(children[0]?.shareTarget).toBe(20);
  });

  it("prices a single public-footprint child clip from the executable ask to avoid target overfill", () => {
    const market = buildOfflineMarket(1713696000);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.41, size: 100 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.59, size: 200 }]),
    );

    const children = planCloneChildBuyOrders({
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.42,
        amount: 2.1,
        shareTarget: 5,
        orderType: "FAK",
      },
      outcome: "UP",
      books,
      minOrderSize: market.minOrderSize,
    });

    expect(children).toHaveLength(1);
    expect(children[0]?.amount).toBe(2.05);
    expect(children[0]?.price).toBe(0.41);
    expect(children[0]?.shareTarget).toBe(5);
  });

  it("rounds child BUY clips to CLOB-safe maker and taker precision", () => {
    const market = buildOfflineMarket(1713696000);
    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.31, size: 100 }]),
      buildBook(market.tokens.DOWN.tokenId, market.conditionId, [{ price: 0.4, size: 200 }], [{ price: 0.69, size: 200 }]),
    );

    const children = planCloneChildBuyOrders({
      order: {
        tokenId: market.tokens.UP.tokenId,
        side: "BUY",
        price: 0.31,
        amount: 4.6506,
        shareTarget: 15.001934,
        orderType: "FAK",
      },
      outcome: "UP",
      books,
      minOrderSize: market.minOrderSize,
      preferredChildShares: 15.001934,
      maxChildOrders: 2,
    });

    expect(children[0]?.amount).toBe(4.65);
    expect(children[0]?.shareTarget).toBe(15);
  });
});
