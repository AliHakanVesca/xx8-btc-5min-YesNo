import { createPublicClient, http } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";

export class TxWatcher {
  private readonly client;

  constructor(private readonly env: AppEnv) {
    this.client = createPublicClient({
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    });
  }

  async waitForReceipt(txHash: string): Promise<unknown> {
    return this.client.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  }
}
