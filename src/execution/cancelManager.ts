import type { ClobAdapter } from "../infra/clob/types.js";

export class CancelManager {
  constructor(private readonly clob: ClobAdapter) {}

  async cancelOrder(orderId: string): Promise<void> {
    await this.clob.cancelOrder(orderId);
  }

  async cancelMarket(market?: string, assetId?: string): Promise<void> {
    const payload = {
      ...(market !== undefined ? { market } : {}),
      ...(assetId !== undefined ? { assetId } : {}),
    };
    await this.clob.cancelMarket(payload);
  }

  async cancelAll(): Promise<void> {
    await this.clob.cancelAll();
  }
}
