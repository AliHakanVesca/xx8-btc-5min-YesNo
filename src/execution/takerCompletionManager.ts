import type { MarketOrderArgs, OrderResult } from "../infra/clob/types.js";
import { OrderManager } from "./orderManager.js";

export class TakerCompletionManager {
  constructor(private readonly orders: OrderManager) {}

  async execute(order: MarketOrderArgs): Promise<OrderResult> {
    return this.orders.placeMarketOrder({
      ...order,
      orderType: order.orderType ?? "FAK",
    });
  }

  async complete(order: MarketOrderArgs): Promise<OrderResult> {
    return this.execute(order);
  }
}
