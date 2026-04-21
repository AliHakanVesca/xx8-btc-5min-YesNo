import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { GammaClient } from "../../src/infra/gamma/gammaClient.js";
import { discoverWindowMarket } from "../../src/infra/gamma/marketDiscovery.js";
import type { ClobAdapter } from "../../src/infra/clob/types.js";

describe("market discovery", () => {
  it("maps market metadata and token outcomes", async () => {
    const env = loadEnv();
    const gamma = new GammaClient(env, async () =>
      new Response(
        JSON.stringify([
          {
            slug: "btc-updown-5m-1713696000",
            conditionId: "0xcondition",
            tokens: [
              { token_id: "up-token", outcome: "Up" },
              { token_id: "down-token", outcome: "Down" },
            ],
          },
        ]),
      ),
    );
    const clob: ClobAdapter = {
      version: "v2",
      async getMarket() {
        return {};
      },
      async getClobMarketInfo() {
        return {
          tickSize: 0.01,
          minOrderSize: 5,
          feeRate: 0.072,
          feeExponent: 0,
          takerOnlyFees: true,
          negRisk: false,
          tokens: [],
        };
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
      async postLimitOrder() {
        throw new Error("not used");
      },
      async postMarketOrder() {
        throw new Error("not used");
      },
      async cancelOrder() {},
      async cancelMarket() {},
      async cancelAll() {},
    };

    const market = await discoverWindowMarket({
      env,
      gammaClient: gamma,
      clob,
      slug: "btc-updown-5m-1713696000",
      startTs: 1713696000,
      endTs: 1713696300,
    });

    expect(market.tokens.UP.tokenId).toBe("up-token");
    expect(market.tokens.DOWN.tokenId).toBe("down-token");
    expect(market.tickSize).toBe(0.01);
  });
});
