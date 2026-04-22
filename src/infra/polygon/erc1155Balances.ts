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

  async getBalanceRaw(tokenId: bigint | string, ownerAddress = this.env.BOT_WALLET_ADDRESS): Promise<bigint> {
    if (this.env.CTF_CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      return 0n;
    }

    return this.client.readContract({
      address: this.env.CTF_CONTRACT_ADDRESS as `0x${string}`,
      abi: erc1155Abi,
      functionName: "balanceOf",
      args: [ownerAddress as `0x${string}`, BigInt(tokenId)],
    });
  }

  async getBalance(tokenId: bigint | string, ownerAddress = this.env.BOT_WALLET_ADDRESS): Promise<number> {
    const raw = await this.getBalanceRaw(tokenId, ownerAddress);
    return Number(raw) / 1_000_000;
  }

  async getBalances(
    tokenIds: Array<bigint | string>,
    ownerAddress = this.env.BOT_WALLET_ADDRESS,
  ): Promise<Map<string, number>> {
    const entries = await Promise.all(
      tokenIds.map(async (tokenId) => [String(tokenId), await this.getBalance(tokenId, ownerAddress)] as const),
    );
    return new Map(entries);
  }

  async getBalancesRaw(
    tokenIds: Array<bigint | string>,
    ownerAddress = this.env.BOT_WALLET_ADDRESS,
  ): Promise<Map<string, bigint>> {
    const entries = await Promise.all(
      tokenIds.map(async (tokenId) => [String(tokenId), await this.getBalanceRaw(tokenId, ownerAddress)] as const),
    );
    return new Map(entries);
  }
}
