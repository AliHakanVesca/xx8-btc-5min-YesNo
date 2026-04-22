import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { BtcPricePoint } from "../../strategy/xuan5m/fairValueEngine.js";

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const BINANCE_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade";
const MAX_HISTORY_POINTS = 600;

export interface BtcPriceFeedSnapshot {
  primary?: BtcPricePoint | undefined;
  secondary?: BtcPricePoint | undefined;
  chainlink?: BtcPricePoint | undefined;
  history: BtcPricePoint[];
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

export class BtcPriceFeed extends EventEmitter {
  private rtdsSocket: WebSocket | undefined;
  private binanceSocket: WebSocket | undefined;
  private rtdsPingTimer: NodeJS.Timeout | undefined;
  private readonly history: BtcPricePoint[] = [];
  private primary: BtcPricePoint | undefined;
  private secondary: BtcPricePoint | undefined;
  private chainlink: BtcPricePoint | undefined;

  connect(): void {
    this.connectRtds();
    this.connectBinance();
  }

  disconnect(): void {
    if (this.rtdsPingTimer) {
      clearInterval(this.rtdsPingTimer);
      this.rtdsPingTimer = undefined;
    }
    this.rtdsSocket?.close();
    this.binanceSocket?.close();
    this.rtdsSocket = undefined;
    this.binanceSocket = undefined;
  }

  snapshot(): BtcPriceFeedSnapshot {
    return {
      ...(this.primary ? { primary: this.primary } : {}),
      ...(this.secondary ? { secondary: this.secondary } : {}),
      ...(this.chainlink ? { chainlink: this.chainlink } : {}),
      history: [...this.history],
    };
  }

  private connectRtds(): void {
    this.rtdsSocket = new WebSocket(RTDS_URL);
    this.rtdsSocket.on("open", () => {
      this.rtdsSocket?.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices",
              type: "update",
            },
            {
              topic: "crypto_prices_chainlink",
              type: "*",
            },
          ],
        }),
      );
      this.rtdsPingTimer = setInterval(() => {
        try {
          this.rtdsSocket?.send("PING");
        } catch {
          return;
        }
      }, 5_000);
      this.emit("open", { source: "rtds" });
    });
    this.rtdsSocket.on("message", (buffer: WebSocket.RawData) => {
      const text = buffer.toString();
      if (!text) {
        return;
      }
      if (text === "PONG") {
        return;
      }

      try {
        const payload = JSON.parse(text) as {
          topic?: string;
          type?: string;
          timestamp?: number;
          payload?: { symbol?: string; timestamp?: number; value?: number };
        };
        const topic = payload.topic ?? "";
        const point = payload.payload;
        if (!point || typeof point.value !== "number") {
          return;
        }
        if (topic === "crypto_prices" && point.symbol?.toLowerCase() === "btcusdt") {
          this.primary = {
            source: "rtds",
            price: normalize(point.value),
            timestampMs: point.timestamp ?? payload.timestamp ?? Date.now(),
          };
          this.pushHistory(this.primary);
          this.emit("price", this.snapshot());
          return;
        }
        if (topic === "crypto_prices_chainlink" && point.symbol?.toLowerCase() === "btc/usd") {
          this.chainlink = {
            source: "chainlink",
            price: normalize(point.value),
            timestampMs: point.timestamp ?? payload.timestamp ?? Date.now(),
          };
          this.emit("price", this.snapshot());
        }
      } catch (error) {
        this.emit("warn", error);
      }
    });
    this.rtdsSocket.on("close", () => {
      if (this.rtdsPingTimer) {
        clearInterval(this.rtdsPingTimer);
        this.rtdsPingTimer = undefined;
      }
      this.emit("close", { source: "rtds" });
    });
    this.rtdsSocket.on("error", (error: Error) => this.emit("warn", error));
  }

  private connectBinance(): void {
    this.binanceSocket = new WebSocket(BINANCE_URL);
    this.binanceSocket.on("open", () => {
      this.emit("open", { source: "binance" });
    });
    this.binanceSocket.on("message", (buffer: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(buffer.toString()) as {
          e?: string;
          E?: number;
          T?: number;
          p?: string;
        };
        if (payload.e !== "trade" || !payload.p) {
          return;
        }
        this.secondary = {
          source: "binance",
          price: normalize(Number(payload.p)),
          timestampMs: payload.T ?? payload.E ?? Date.now(),
        };
        this.emit("price", this.snapshot());
      } catch (error) {
        this.emit("warn", error);
      }
    });
    this.binanceSocket.on("close", () => this.emit("close", { source: "binance" }));
    this.binanceSocket.on("error", (error: Error) => this.emit("warn", error));
  }

  private pushHistory(point: BtcPricePoint): void {
    this.history.push(point);
    while (this.history.length > MAX_HISTORY_POINTS) {
      this.history.shift();
    }
  }
}
