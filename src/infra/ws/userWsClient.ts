import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppEnv } from "../../config/schema.js";

export interface UserTradeEvent {
  event_type: "trade";
  asset_id: string;
  id: string;
  market: string;
  price?: string;
  outcome?: string;
  status?: string;
  maker_orders?: Array<{ order_id: string; matched_amount: string; price: string; side: string }>;
}

export interface UserOrderEvent {
  event_type: "order";
  id: string;
  market: string;
  asset_id: string;
  price: string;
  side: string;
  size_matched: string;
  original_size: string;
  type: "PLACEMENT" | "UPDATE" | "CANCELLATION";
}

export class UserWsClient extends EventEmitter {
  private socket: WebSocket | undefined;

  constructor(private readonly env: AppEnv) {
    super();
  }

  connect(markets: string[]): void {
    if (!this.env.POLY_API_KEY || !this.env.POLY_API_SECRET || !this.env.POLY_API_PASSPHRASE) {
      this.emit("warn", new Error("User websocket skipped because API credentials are missing."));
      return;
    }

    this.socket = new WebSocket(this.env.POLY_USER_WS_URL);
    this.socket.on("open", () => {
      this.socket?.send(
        JSON.stringify({
          auth: {
            apiKey: this.env.POLY_API_KEY,
            secret: this.env.POLY_API_SECRET,
            passphrase: this.env.POLY_API_PASSPHRASE,
          },
          markets,
          type: "user",
        }),
      );
      this.emit("open");
    });

    this.socket.on("message", (buffer: WebSocket.RawData) => {
      const payload = JSON.parse(buffer.toString()) as UserTradeEvent | UserOrderEvent | Array<UserTradeEvent | UserOrderEvent>;
      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        this.applyMessage(event);
      }
    });

    this.socket.on("close", () => this.emit("close"));
    this.socket.on("error", (error: Error) => this.emit("error", error));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  applyMessage(event: UserTradeEvent | UserOrderEvent): void {
    if (event.event_type === "trade") {
      this.emit("trade", event);
      return;
    }
    if (event.event_type === "order") {
      this.emit("order", event);
      return;
    }
    this.emit("event", event);
  }
}
