import { createPublicClient, erc20Abi, http } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";

export class Erc20BalanceReader {
  private readonly client;

  constructor(private readonly env: AppEnv) {
    this.client = createPublicClient({
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    });
  }

  async getBalance(tokenAddress: string, ownerAddress = this.env.BOT_WALLET_ADDRESS): Promise<number> {
    const balance = await this.client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [ownerAddress as `0x${string}`],
    });
    return Number(balance);
  }
}
