import { describe, expect, it } from "vitest";
import { OrderManager } from "../../src/execution/orderManager.js";
import type { ClobAdapter, LimitOrderArgs, MarketOrderArgs, OrderResult } from "../../src/infra/clob/types.js";

function result(status: string): OrderResult {
  return {
    success: true,
    simulated: false,
    orderId: `${status}-order`,
    status,
    requestedAt: 1713696015,
  };
}

function adapter(captures: { limit: LimitOrderArgs[]; market: MarketOrderArgs[] }): ClobAdapter {
  return {
    version: "v2",
    async getMarket() {
      return {};
    },
    async getClobMarketInfo() {
      return null;
    },
    async getOrderBook() {
      throw new Error("not used");
    },
    async getTickSize() {
      return 0.01;
    },
    async getOpenOrders() {
      return [];
    },
    async postLimitOrder(order) {
      captures.limit.push(order);
      return result("limit");
    },
    async postMarketOrder(order) {
      captures.market.push(order);
      return result("market");
    },
    async cancelOrder() {},
    async cancelMarket() {},
    async cancelAll() {},
  };
}

describe("order manager exact-size taker buys", () => {
  it("routes share-targeted BUY market requests through limit FAK to cap filled shares", async () => {
    const captures = { limit: [] as LimitOrderArgs[], market: [] as MarketOrderArgs[] };
    const manager = new OrderManager(adapter(captures));

    const response = await manager.placeMarketOrder({
      tokenId: "token-down",
      side: "BUY",
      price: 0.32,
      amount: 4.8,
      shareTarget: 15,
      orderType: "FAK",
      metadata: "0xmeta",
      builderCode: "0xbuilder",
    });

    expect(response.status).toBe("limit");
    expect(captures.market).toHaveLength(0);
    expect(captures.limit).toEqual([
      {
        tokenId: "token-down",
        side: "BUY",
        price: 0.32,
        size: 15,
        orderType: "FAK",
        postOnly: false,
        metadata: "0xmeta",
        builderCode: "0xbuilder",
      },
    ]);
  });

  it("keeps non share-targeted market orders on the market-order path", async () => {
    const captures = { limit: [] as LimitOrderArgs[], market: [] as MarketOrderArgs[] };
    const manager = new OrderManager(adapter(captures));

    const order: MarketOrderArgs = {
      tokenId: "token-up",
      side: "BUY",
      amount: 4.8,
      orderType: "FAK",
    };

    const response = await manager.placeMarketOrder(order);

    expect(response.status).toBe("market");
    expect(captures.limit).toHaveLength(0);
    expect(captures.market).toEqual([order]);
  });
});
