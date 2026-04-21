import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseUnits,
  parseAbi,
  zeroHash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";
import { RelayerApiClient } from "../relayer/relayerApiClient.js";
import { resolveRelayerExecutionMode } from "../relayer/txType.js";

const ctfAbi = parseAbi([
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);

export interface CtfTxResult {
  simulated: boolean;
  skipped?: boolean;
  action: "split" | "merge" | "redeem";
  amount?: number;
  txHash?: string;
  conditionId: string;
  reason?: string;
}

function asHex(value: string, name: string): `0x${string}` {
  if (!value.startsWith("0x")) {
    throw new Error(`${name} 0x-prefixed hex olmali.`);
  }
  return value as `0x${string}`;
}

function sharesToBaseUnits(amount: number): bigint {
  const normalized = amount.toFixed(6).replace(/\.?0+$/, "");
  return parseUnits(normalized === "" ? "0" : normalized, 6);
}

export class CtfClient {
  private readonly publicClient: PublicClient;

  private readonly walletClient?: WalletClient;

  private readonly relayerClient?: RelayerApiClient;

  constructor(private readonly env: AppEnv) {
    this.publicClient = createPublicClient({
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    });
    if (env.BOT_PRIVATE_KEY) {
      const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex);
      this.walletClient = createWalletClient({
        account,
        chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
        transport: http(env.POLY_RPC_URL),
      });
    }
    if (
      resolveRelayerExecutionMode(env.POLY_SIGNATURE_TYPE) !== "direct" &&
      env.POLY_RELAYER_API_KEY &&
      env.POLY_RELAYER_API_KEY_ADDRESS
    ) {
      this.relayerClient = new RelayerApiClient(env);
    }
  }

  async mergePositions(conditionId: string, amount: number): Promise<CtfTxResult> {
    return this.write("merge", conditionId, amount, "mergePositions", [1n, 2n]);
  }

  async splitPosition(conditionId: string, amount: number): Promise<CtfTxResult> {
    return this.write("split", conditionId, amount, "splitPosition", [1n, 2n]);
  }

  async redeemPositions(conditionId: string): Promise<CtfTxResult> {
    if (this.env.DRY_RUN) {
      return {
        simulated: true,
        action: "redeem",
        conditionId,
      };
    }
    if (!this.walletClient) {
      throw new Error("Live CTF redeem icin BOT_PRIVATE_KEY gerekli.");
    }

    if (this.relayerClient) {
      const result = await this.relayerClient.executeTransactions(
        [
          {
            to: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
            data: encodeFunctionData({
              abi: ctfAbi,
              functionName: "redeemPositions",
              args: [
                asHex(this.env.ACTIVE_COLLATERAL_TOKEN, "ACTIVE_COLLATERAL_TOKEN"),
                zeroHash,
                asHex(conditionId, "conditionId"),
                [1n, 2n],
              ],
            }),
            value: "0",
          },
        ],
        "CTF redeem",
      );
      return {
        simulated: false,
        action: "redeem",
        conditionId,
        ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
      };
    }

    const txHash = await this.walletClient.writeContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName: "redeemPositions",
      args: [
        asHex(this.env.ACTIVE_COLLATERAL_TOKEN, "ACTIVE_COLLATERAL_TOKEN"),
        zeroHash,
        asHex(conditionId, "conditionId"),
        [1n, 2n],
      ],
      chain: undefined,
      account: this.walletClient.account!,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      simulated: false,
      action: "redeem",
      conditionId,
      txHash,
    };
  }

  private async write(
    action: "split" | "merge",
    conditionId: string,
    amount: number,
    functionName: "splitPosition" | "mergePositions",
    partition: bigint[],
  ): Promise<CtfTxResult> {
    if (this.env.DRY_RUN) {
      return {
        simulated: true,
        action,
        amount,
        conditionId,
      };
    }
    if (!this.walletClient) {
      throw new Error(`Live CTF ${action} icin BOT_PRIVATE_KEY gerekli.`);
    }

    if (this.relayerClient) {
      const result = await this.relayerClient.executeTransactions(
        [
          {
            to: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
            data: encodeFunctionData({
              abi: ctfAbi,
              functionName,
              args: [
                asHex(this.env.ACTIVE_COLLATERAL_TOKEN, "ACTIVE_COLLATERAL_TOKEN"),
                zeroHash,
                asHex(conditionId, "conditionId"),
                partition,
                sharesToBaseUnits(amount),
              ],
            }),
            value: "0",
          },
        ],
        `CTF ${action}`,
      );
      return {
        simulated: false,
        action,
        amount,
        conditionId,
        ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
      };
    }

    const txHash = await this.walletClient.writeContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName,
      args: [
        asHex(this.env.ACTIVE_COLLATERAL_TOKEN, "ACTIVE_COLLATERAL_TOKEN"),
        zeroHash,
        asHex(conditionId, "conditionId"),
        partition,
        sharesToBaseUnits(amount),
      ],
      chain: undefined,
      account: this.walletClient.account!,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      simulated: false,
      action,
      amount,
      conditionId,
      txHash,
    };
  }
}
