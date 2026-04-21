import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppEnv } from "../../config/schema.js";
import type { OrderBook, OrderLevel } from "../clob/types.js";
import { appendJsonl } from "../../utils/fs.js";

type MarketEvent = {
  event_type: string;
  asset_id?: string;
  market?: string;
  timestamp?: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
  hash?: string;
  best_bid?: string;
  best_ask?: string;
  [key: string]: unknown;
};

function toLevel(level: { price: string; size: string }): OrderLevel {
  return {
    price: Number(level.price),
    size: Number(level.size),
  };
}

export class MarketWsClient extends EventEmitter {
  private socket: WebSocket | undefined;
  private readonly books = new Map<string, OrderBook>();

  constructor(private readonly env: AppEnv) {
    super();
  }

  connect(assetIds: string[]): void {
    this.socket = new WebSocket(this.env.POLY_MARKET_WS_URL);
    this.socket.on("open", () => {
      this.socket?.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      this.emit("open");
    });

    this.socket.on("message", (buffer: WebSocket.RawData) => {
      const payload = JSON.parse(buffer.toString()) as MarketEvent | MarketEvent[];
      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        this.emit("raw", event);
        this.applyEvent(event);
      }
    });

    this.socket.on("close", () => this.emit("close"));
    this.socket.on("error", (error: Error) => this.emit("error", error));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  getBook(assetId: string): OrderBook | undefined {
    return this.books.get(assetId);
  }

  applyEvent(event: MarketEvent): void {
    if (!event.asset_id) {
      this.emit("event", event);
      return;
    }

    if (event.event_type === "book") {
      const book: OrderBook = {
        market: event.market ?? "unknown-market",
        assetId: event.asset_id,
        timestamp: Number(event.timestamp ?? Date.now()),
        bids: (event.bids ?? []).map(toLevel),
        asks: (event.asks ?? []).map(toLevel),
        minOrderSize: Number(event.min_order_size ?? 5),
        tickSize: Number(event.tick_size ?? 0.01),
        negRisk: Boolean(event.neg_risk),
        hash: event.hash,
      };
      this.books.set(event.asset_id, book);
      void this.record(book);
      this.emit("book", book);
      return;
    }

    if (event.event_type === "best_bid_ask") {
      const existing = this.books.get(event.asset_id);
      if (existing) {
        const bestBid = event.best_bid ? Number(event.best_bid) : existing.bids[0]?.price ?? 0;
        const bestAsk = event.best_ask ? Number(event.best_ask) : existing.asks[0]?.price ?? 1;
        existing.bids = [{ price: bestBid, size: existing.bids[0]?.size ?? 0 }];
        existing.asks = [{ price: bestAsk, size: existing.asks[0]?.size ?? 0 }];
        existing.timestamp = Number(event.timestamp ?? Date.now());
        void this.record(existing);
        this.emit("book", existing);
      }
      return;
    }

    this.emit("event", event);
  }

  private async record(book: OrderBook): Promise<void> {
    if (!this.env.RECORDER_ENABLED) {
      return;
    }

    const day = new Date().toISOString().slice(0, 10);
    await appendJsonl(`data/recorder/${day}/market-books.jsonl`, book);
  }
}
