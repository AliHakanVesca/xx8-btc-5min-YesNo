import type { LimitOrderArgs, OrderResult } from "../infra/clob/types.js";
import { roundDownToTick } from "../utils/math.js";
import { OrderManager } from "./orderManager.js";

export class PostOnlyManager {
  constructor(private readonly orders: OrderManager) {}

  async placeQuotes(quotes: LimitOrderArgs[], tickSize: number): Promise<OrderResult[]> {
    const normalizedQuotes = quotes.map((order) => ({
      ...order,
      price: roundDownToTick(order.price, tickSize),
      postOnly: true,
    }));

    return Promise.all(normalizedQuotes.map((order) => this.orders.placeLimitOrder(order)));
  }

  async placeBalancedPair(
    pair: [LimitOrderArgs, LimitOrderArgs],
    tickSize: number,
  ): Promise<OrderResult[]> {
    return this.placeQuotes(pair, tickSize);
  }
}
