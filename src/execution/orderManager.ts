import type { ClobAdapter, LimitOrderArgs, MarketOrderArgs, OrderResult } from "../infra/clob/types.js";
import { normalizeExecutableBuyOrder } from "../infra/clob/orderPrecision.js";
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
    const executableOrder = normalizeExecutableBuyOrder(order);
    if (
      executableOrder.side === "BUY" &&
      executableOrder.price !== undefined &&
      executableOrder.shareTarget !== undefined &&
      Number.isFinite(executableOrder.price) &&
      Number.isFinite(executableOrder.shareTarget) &&
      executableOrder.price > 0 &&
      executableOrder.shareTarget > 0
    ) {
      return this.clob.postLimitOrder({
        tokenId: executableOrder.tokenId,
        price: executableOrder.price,
        size: executableOrder.shareTarget,
        side: executableOrder.side,
        orderType: executableOrder.orderType,
        postOnly: false,
        ...(executableOrder.metadata !== undefined ? { metadata: executableOrder.metadata } : {}),
        ...(executableOrder.builderCode !== undefined ? { builderCode: executableOrder.builderCode } : {}),
      });
    }
    return this.clob.postMarketOrder(executableOrder);
  }
}
