import { createPublicClient, http, parseAbi } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";

const erc1155Abi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);

export class Erc1155BalanceReader {
  private readonly client;

  constructor(private readonly env: AppEnv) {
    this.client = createPublicClient({
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    });
  }

  async getBalance(tokenId: bigint | string): Promise<number> {
    if (this.env.CTF_CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      return 0;
    }

    const balance = await this.client.readContract({
      address: this.env.CTF_CONTRACT_ADDRESS as `0x${string}`,
      abi: erc1155Abi,
      functionName: "balanceOf",
      args: [this.env.BOT_WALLET_ADDRESS as `0x${string}`, BigInt(tokenId)],
    });
    return Number(balance);
  }

  async getBalances(tokenIds: Array<bigint | string>): Promise<Map<string, number>> {
    const entries = await Promise.all(
      tokenIds.map(async (tokenId) => [String(tokenId), await this.getBalance(tokenId)] as const),
    );
    return new Map(entries);
  }
}
