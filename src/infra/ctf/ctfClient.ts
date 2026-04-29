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
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) pure returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
]);

export interface CtfPositionTokenIds {
  upTokenId?: string | undefined;
  downTokenId?: string | undefined;
}

export interface CtfActionOptions {
  positionTokenIds?: CtfPositionTokenIds | undefined;
}

export interface CtfTxResult {
  simulated: boolean;
  skipped?: boolean;
  confirmed?: boolean;
  state?: string;
  action: "split" | "merge" | "redeem";
  amount?: number;
  txHash?: string;
  conditionId: string;
  collateralToken?: string;
  collateralSource?: string;
  reason?: string;
}

export function shouldAccountCtfTxResult(result: CtfTxResult | undefined): boolean {
  if (!result || result.skipped) {
    return false;
  }
  return result.simulated || result.confirmed === true;
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

interface CtfCollateralCandidate {
  token: string;
  source: string;
}

interface ResolvedCtfCollateral {
  token: string;
  source: string;
  upPositionId?: string | undefined;
  downPositionId?: string | undefined;
}

function normalizeTokenId(value: string | bigint | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return BigInt(value).toString();
}

function matchesExpectedPositionIds(
  resolved: { upPositionId: string; downPositionId: string },
  expected: CtfPositionTokenIds,
): boolean {
  const expectedUp = normalizeTokenId(expected.upTokenId);
  const expectedDown = normalizeTokenId(expected.downTokenId);
  if (!expectedUp && !expectedDown) {
    return false;
  }
  if (expectedUp && normalizeTokenId(resolved.upPositionId) !== expectedUp) {
    return false;
  }
  if (expectedDown && normalizeTokenId(resolved.downPositionId) !== expectedDown) {
    return false;
  }
  return true;
}

export async function resolveCtfCollateralCandidate(args: {
  candidates: CtfCollateralCandidate[];
  expected: CtfPositionTokenIds;
  resolvePositionIds: (collateralToken: string) => Promise<{ upPositionId: string; downPositionId: string }>;
}): Promise<ResolvedCtfCollateral> {
  for (const candidate of args.candidates) {
    const resolved = await args.resolvePositionIds(candidate.token);
    if (matchesExpectedPositionIds(resolved, args.expected)) {
      return {
        token: candidate.token,
        source: candidate.source,
        upPositionId: resolved.upPositionId,
        downPositionId: resolved.downPositionId,
      };
    }
  }
  const expectedParts = [
    args.expected.upTokenId ? `up=${args.expected.upTokenId}` : undefined,
    args.expected.downTokenId ? `down=${args.expected.downTokenId}` : undefined,
  ].filter(Boolean);
  throw new Error(
    `ctf_collateral_mismatch: no collateral candidate maps condition token ids (${expectedParts.join(", ")})`,
  );
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

  async mergePositions(conditionId: string, amount: number, options: CtfActionOptions = {}): Promise<CtfTxResult> {
    return this.write("merge", conditionId, amount, "mergePositions", [1n, 2n], options);
  }

  async splitPosition(conditionId: string, amount: number, options: CtfActionOptions = {}): Promise<CtfTxResult> {
    return this.write("split", conditionId, amount, "splitPosition", [1n, 2n], options);
  }

  async redeemPositions(conditionId: string, options: CtfActionOptions = {}): Promise<CtfTxResult> {
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
    const collateral = await this.resolveCollateral(conditionId, options.positionTokenIds);

    if (this.relayerClient) {
      const result = await this.relayerClient.executeTransactions(
        [
          {
            to: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
            data: encodeFunctionData({
              abi: ctfAbi,
              functionName: "redeemPositions",
              args: [
                asHex(collateral.token, "collateralToken"),
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
        confirmed: result.confirmed,
        state: result.state,
        action: "redeem",
        conditionId,
        collateralToken: collateral.token,
        collateralSource: collateral.source,
        ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
      };
    }

    const txHash = await this.walletClient.writeContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName: "redeemPositions",
      args: [
        asHex(collateral.token, "collateralToken"),
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
      confirmed: true,
      action: "redeem",
      conditionId,
      collateralToken: collateral.token,
      collateralSource: collateral.source,
      txHash,
    };
  }

  private collateralCandidates(): CtfCollateralCandidate[] {
    const candidates: CtfCollateralCandidate[] = [
      { token: this.env.ACTIVE_COLLATERAL_TOKEN, source: "active" },
      { token: this.env.POLY_USDC_TOKEN, source: "POLY_USDC_TOKEN" },
      { token: this.env.POLY_PUSD_TOKEN, source: "POLY_PUSD_TOKEN" },
    ];
    const unique = new Map<string, CtfCollateralCandidate>();
    for (const candidate of candidates) {
      if (!candidate.token || candidate.token === "0x0000000000000000000000000000000000000000") {
        continue;
      }
      const key = candidate.token.toLowerCase();
      if (!unique.has(key)) {
        unique.set(key, candidate);
      }
    }
    return [...unique.values()];
  }

  private async resolvePositionIds(
    conditionId: string,
    collateralToken: string,
  ): Promise<{ upPositionId: string; downPositionId: string }> {
    const upCollectionId = await this.publicClient.readContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName: "getCollectionId",
      args: [zeroHash, asHex(conditionId, "conditionId"), 1n],
    });
    const downCollectionId = await this.publicClient.readContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName: "getCollectionId",
      args: [zeroHash, asHex(conditionId, "conditionId"), 2n],
    });
    const upPositionId = await this.publicClient.readContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName: "getPositionId",
      args: [asHex(collateralToken, "collateralToken"), upCollectionId],
    });
    const downPositionId = await this.publicClient.readContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName: "getPositionId",
      args: [asHex(collateralToken, "collateralToken"), downCollectionId],
    });
    return {
      upPositionId: upPositionId.toString(),
      downPositionId: downPositionId.toString(),
    };
  }

  private async resolveCollateral(
    conditionId: string,
    positionTokenIds: CtfPositionTokenIds | undefined,
  ): Promise<ResolvedCtfCollateral> {
    if (!positionTokenIds?.upTokenId && !positionTokenIds?.downTokenId) {
      return {
        token: this.env.ACTIVE_COLLATERAL_TOKEN,
        source: "active_default",
      };
    }
    return resolveCtfCollateralCandidate({
      candidates: this.collateralCandidates(),
      expected: positionTokenIds,
      resolvePositionIds: (collateralToken) => this.resolvePositionIds(conditionId, collateralToken),
    });
  }

  private async assertSufficientMergeBalances(positionTokenIds: CtfPositionTokenIds | undefined, rawAmount: bigint): Promise<void> {
    if (!positionTokenIds?.upTokenId || !positionTokenIds.downTokenId) {
      return;
    }
    const owner = asHex(this.env.POLY_FUNDER ?? this.env.BOT_WALLET_ADDRESS, "funder");
    const [upBalance, downBalance] = await Promise.all([
      this.publicClient.readContract({
        address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
        abi: ctfAbi,
        functionName: "balanceOf",
        args: [owner, BigInt(positionTokenIds.upTokenId)],
      }),
      this.publicClient.readContract({
        address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
        abi: ctfAbi,
        functionName: "balanceOf",
        args: [owner, BigInt(positionTokenIds.downTokenId)],
      }),
    ]);
    if (upBalance < rawAmount || downBalance < rawAmount) {
      throw new Error(
        `ctf_merge_balance_insufficient: owner=${owner} required=${rawAmount.toString()} upBalance=${upBalance.toString()} downBalance=${downBalance.toString()}`,
      );
    }
  }

  private async write(
    action: "split" | "merge",
    conditionId: string,
    amount: number,
    functionName: "splitPosition" | "mergePositions",
    partition: bigint[],
    options: CtfActionOptions,
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
    const collateral = await this.resolveCollateral(conditionId, options.positionTokenIds);
    const rawAmount = sharesToBaseUnits(amount);
    if (action === "merge") {
      await this.assertSufficientMergeBalances(options.positionTokenIds, rawAmount);
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
                asHex(collateral.token, "collateralToken"),
                zeroHash,
                asHex(conditionId, "conditionId"),
                partition,
                rawAmount,
              ],
            }),
            value: "0",
          },
        ],
        `CTF ${action}`,
      );
      return {
        simulated: false,
        confirmed: result.confirmed,
        state: result.state,
        action,
        amount,
        conditionId,
        collateralToken: collateral.token,
        collateralSource: collateral.source,
        ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
      };
    }

    const txHash = await this.walletClient.writeContract({
      address: asHex(this.env.CTF_CONTRACT_ADDRESS, "CTF_CONTRACT_ADDRESS"),
      abi: ctfAbi,
      functionName,
      args: [
        asHex(collateral.token, "collateralToken"),
        zeroHash,
        asHex(conditionId, "conditionId"),
        partition,
        rawAmount,
      ],
      chain: undefined,
      account: this.walletClient.account!,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      simulated: false,
      confirmed: true,
      action,
      amount,
      conditionId,
      collateralToken: collateral.token,
      collateralSource: collateral.source,
      txHash,
    };
  }
}
