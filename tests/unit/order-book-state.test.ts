import { describe, expect, it } from "vitest";
import { OrderBookState } from "../../src/strategy/xuan5m/orderBookState.js";

describe("order book state", () => {
  it("derives best bid and ask from unsorted websocket levels", () => {
    const book = {
      market: "0xmarket",
      assetId: "token",
      timestamp: 1_700_000_000,
      bids: [
        { price: 0.01, size: 10 },
        { price: 0.74, size: 20 },
        { price: 0.7, size: 30 },
      ],
      asks: [
        { price: 0.99, size: 10 },
        { price: 0.31, size: 20 },
        { price: 0.35, size: 30 },
      ],
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    };

    const books = new OrderBookState(book, book);

    expect(books.bestBid("UP")).toBe(0.74);
    expect(books.bestAsk("UP")).toBe(0.31);
  });

  it("uses opposite bids as synthetic binary asks when direct asks are missing", () => {
    const upBook = {
      market: "0xmarket",
      assetId: "up",
      timestamp: 1_700_000_000,
      bids: [],
      asks: [],
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    };
    const downBook = {
      ...upBook,
      assetId: "down",
      bids: [
        { price: 0.34, size: 55 },
        { price: 0.3, size: 20 },
      ],
    };

    const books = new OrderBookState(upBook, downBook);
    const quote = books.quoteForSize("UP", "ask", 55);

    expect(books.bestAsk("UP")).toBeCloseTo(0.66, 6);
    expect(books.depthAtOrBetter("UP", 0.66, "ask")).toBe(55);
    expect(quote.fullyFilled).toBe(true);
    expect(quote.averagePrice).toBeCloseTo(0.66, 6);
  });
});
