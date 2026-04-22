import { createWalletClient, encodeFunctionData, erc20Abi, http, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";
import { RelayerApiClient } from "../relayer/relayerApiClient.js";
import { resolveCollateralApprovalSpenders } from "./polymarketContracts.js";

export interface CollateralApprovalResult {
  spender: string;
  txHash?: string;
  transactionId?: string;
  mode: "direct" | "safe" | "proxy";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function buildApproveCalldata(spender: string): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender as `0x${string}`, maxUint256],
  });
}

export async function approveCollateralSpenders(
  env: AppEnv,
  spenders = resolveCollateralApprovalSpenders(env.USE_CLOB_V2),
): Promise<CollateralApprovalResult[]> {
  const normalizedSpenders = unique(spenders);
  if (normalizedSpenders.length === 0) {
    return [];
  }

  if (env.POLY_SIGNATURE_TYPE === 0) {
    const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({
      account,
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    });
    const results: CollateralApprovalResult[] = [];
    for (const spender of normalizedSpenders) {
      const txHash = await wallet.writeContract({
        address: env.ACTIVE_COLLATERAL_TOKEN as `0x${string}`,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender as `0x${string}`, maxUint256],
      });
      results.push({
        spender,
        txHash,
        mode: "direct",
      });
    }
    return results;
  }

  const relayer = new RelayerApiClient(env);
  const result = await relayer.executeTransactions(
    normalizedSpenders.map((spender) => ({
      to: env.ACTIVE_COLLATERAL_TOKEN,
      data: buildApproveCalldata(spender),
      value: "0",
    })),
    "Collateral approval",
  );

  return normalizedSpenders.map((spender) => ({
    spender,
    ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
    ...(result.transactionId ? { transactionId: result.transactionId } : {}),
    mode: relayer.mode,
  }));
}
