import type { ClobAdapter, LimitOrderArgs, MarketOrderArgs, OrderResult } from "../infra/clob/types.js";
import { RateLimiter } from "./rateLimiter.js";

export class OrderManager {
  private readonly limiter = new RateLimiter(20, 10);

  constructor(private readonly clob: ClobAdapter) {}

  async placeLimitOrder(order: LimitOrderArgs): Promise<OrderResult> {
    if (!this.limiter.tryRemove()) {
      return {
        success: false,
        simulated: true,
        orderId: "rate-limited",
        status: "rate_limited",
        requestedAt: Date.now(),
      };
    }
    return this.clob.postLimitOrder(order);
  }

  async placeMarketOrder(order: MarketOrderArgs): Promise<OrderResult> {
    if (!this.limiter.tryRemove()) {
      return {
        success: false,
        simulated: true,
        orderId: "rate-limited",
        status: "rate_limited",
        requestedAt: Date.now(),
      };
    }
    if (
      order.side === "BUY" &&
      order.price !== undefined &&
      order.shareTarget !== undefined &&
      Number.isFinite(order.price) &&
      Number.isFinite(order.shareTarget) &&
      order.price > 0 &&
      order.shareTarget > 0
    ) {
      return this.clob.postLimitOrder({
        tokenId: order.tokenId,
        price: order.price,
        size: order.shareTarget,
        side: order.side,
        orderType: order.orderType,
        postOnly: false,
        ...(order.metadata !== undefined ? { metadata: order.metadata } : {}),
        ...(order.builderCode !== undefined ? { builderCode: order.builderCode } : {}),
      });
    }
    return this.clob.postMarketOrder(order);
  }
}
