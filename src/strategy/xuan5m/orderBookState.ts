import type { OrderBook } from "../../infra/clob/types.js";

export interface ExecutionQuote {
  requestedSize: number;
  filledSize: number;
  averagePrice: number;
  limitPrice: number;
  fullyFilled: boolean;
}

export class OrderBookState {
  constructor(
    public readonly up?: OrderBook,
    public readonly down?: OrderBook,
  ) {}

  bestBid(side: "UP" | "DOWN"): number {
    const book = side === "UP" ? this.up : this.down;
    return book?.bids[0]?.price ?? 0;
  }

  bestAsk(side: "UP" | "DOWN"): number {
    const book = side === "UP" ? this.up : this.down;
    return book?.asks[0]?.price ?? 1;
  }

  tickSize(): number {
    return this.up?.tickSize ?? this.down?.tickSize ?? 0.01;
  }

  quoteForSize(side: "UP" | "DOWN", direction: "bid" | "ask", requestedSize: number): ExecutionQuote {
    const book = side === "UP" ? this.up : this.down;
    const levels = [...(book?.[direction === "bid" ? "bids" : "asks"] ?? [])].sort((left, right) =>
      direction === "bid" ? right.price - left.price : left.price - right.price,
    );

    if (requestedSize <= 0 || levels.length === 0) {
      return {
        requestedSize,
        filledSize: 0,
        averagePrice: direction === "ask" ? 1 : 0,
        limitPrice: direction === "ask" ? 1 : 0,
        fullyFilled: false,
      };
    }

    let remaining = requestedSize;
    let filledSize = 0;
    let totalNotional = 0;
    let limitPrice = direction === "ask" ? 0 : 1;

    for (const level of levels) {
      if (remaining <= 0) {
        break;
      }
      const takeSize = Math.min(remaining, level.size);
      if (takeSize <= 0) {
        continue;
      }
      remaining -= takeSize;
      filledSize += takeSize;
      totalNotional += takeSize * level.price;
      limitPrice = level.price;
    }

    return {
      requestedSize,
      filledSize,
      averagePrice: filledSize > 0 ? totalNotional / filledSize : direction === "ask" ? 1 : 0,
      limitPrice,
      fullyFilled: remaining <= 1e-9,
    };
  }

  depthAtOrBetter(side: "UP" | "DOWN", limitPrice: number, direction: "bid" | "ask"): number {
    const levels = (side === "UP" ? this.up : this.down)?.[direction === "bid" ? "bids" : "asks"] ?? [];
    return levels
      .filter((level) => (direction === "bid" ? level.price >= limitPrice : level.price <= limitPrice))
      .reduce((acc, level) => acc + level.size, 0);
  }
}
