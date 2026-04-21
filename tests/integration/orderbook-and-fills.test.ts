import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { MarketWsClient } from "../../src/infra/ws/marketWsClient.js";
import { inferFillFromBalances } from "../../src/strategy/xuan5m/fillDetector.js";

describe("orderbook and fill reconciliation", () => {
  it("stores snapshot orderbook locally", () => {
    const client = new MarketWsClient(loadEnv());
    client.applyEvent({
      event_type: "book",
      asset_id: "up-token",
      market: "0xmarket",
      timestamp: "1713696010",
      bids: [{ price: "0.48", size: "100" }],
      asks: [{ price: "0.49", size: "120" }],
      min_order_size: "5",
      tick_size: "0.01",
      neg_risk: false,
    });

    const book = client.getBook("up-token");
    expect(book?.bids[0]?.price).toBeCloseTo(0.48, 8);
    expect(book?.asks[0]?.price).toBeCloseTo(0.49, 8);
  });

  it("infers fills from balance deltas", () => {
    const inferred = inferFillFromBalances({ up: 10, down: 10 }, { up: 40, down: 10 });
    expect(inferred.ghost).toBe(false);
    expect(inferred.inferredOutcome).toBe("UP");
    expect(inferred.inferredSize).toBe(30);
  });
});
