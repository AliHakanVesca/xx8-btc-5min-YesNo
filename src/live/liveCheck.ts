import {
  AssetType as V1AssetType,
  Chain as V1Chain,
  ClobClient as V1ClobClient,
  SignatureType as V1SignatureType,
} from "@polymarket/clob-client";
import {
  AssetType as V2AssetType,
  Chain as V2Chain,
  ClobClient as V2ClobClient,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../config/schema.js";
import { createClobAdapter } from "../infra/clob/index.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { RelayerApiClient } from "../infra/relayer/relayerApiClient.js";
import { SystemClock } from "../infra/time/clock.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { UserWsClient } from "../infra/ws/userWsClient.js";
import { assessMergeExecutionReadiness, classifyWalletTopology } from "./topology.js";

interface ProbeStatus {
  ok: boolean;
  details?: string;
}

interface LiveCheckReport {
  summary: {
    readyForLiveSmall: boolean;
    blockers: string[];
    warnings: string[];
  };
  runtime: {
    stackMode: AppEnv["POLY_STACK_MODE"];
    useClobV2: boolean;
    dryRun: boolean;
    clobBaseUrl: string;
    rpcUrl: string;
    signatureType: number;
    signerAddress: string;
    configuredWalletAddress: string;
    funderAddress: string;
    topology: string;
    collateralSymbol: AppEnv["ACTIVE_COLLATERAL_SYMBOL"];
    mergeExecutionEnabled: boolean;
  };
  rpc: {
    chainId: number;
    blockNumber: string;
    signerPol: string;
    funderPol: string;
  };
  auth: {
    apiCredsPresent: boolean;
    apiKeysCount?: number;
    openOrdersCount?: number;
    collateralBalance?: string;
    collateralAllowance?: string;
  };
  market: {
    currentSlug?: string;
    currentConditionId?: string;
    upTokenId?: string;
    downTokenId?: string;
    tickSize?: number;
    minOrderSize?: number;
    source?: string;
  };
  connectivity: {
    gamma: ProbeStatus;
    clobRead: ProbeStatus;
    marketWs: ProbeStatus;
    userWs: ProbeStatus;
  };
  relayer: {
    configured: boolean;
    baseUrl?: string;
    apiKeyAddress?: string;
    ownerMatchesSigner: boolean;
    expectedFunderAddress?: string;
    transactionHistoryCount?: number;
    safeDeployed?: boolean;
    probe: ProbeStatus;
  };
  merge: {
    enabled: boolean;
    ready: boolean;
    severity: "ok" | "warn" | "block";
    reason?: string;
  };
  recommendedEnv: Record<string, string>;
}

function toV1Chain(chainId: number): V1Chain {
  return chainId === 80002 ? V1Chain.AMOY : V1Chain.POLYGON;
}

function toV2Chain(chainId: number): V2Chain {
  return chainId === 80002 ? V2Chain.AMOY : V2Chain.POLYGON;
}

function createSigner(env: AppEnv) {
  if (!env.BOT_PRIVATE_KEY) {
    throw new Error("BOT_PRIVATE_KEY gerekli.");
  }

  const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex);
  return {
    account,
    signerAddress: account.address,
    walletClient: createWalletClient({
      account,
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    }),
  };
}

function hasApiCreds(env: AppEnv): boolean {
  return Boolean(env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE);
}

function recommendedCanaryEnv(): Record<string, string> {
  return {
    DRY_RUN: "false",
    CTF_MERGE_ENABLED: "true",
    LIVE_SMALL_LOTS: "20",
    DEFAULT_LOT: "20",
    MAX_MARKET_SHARES_PER_SIDE: "60",
    MAX_ONE_SIDED_EXPOSURE_SHARES: "30",
    MAX_CYCLES_PER_MARKET: "2",
    MAX_BUYS_PER_SIDE: "2",
    DAILY_MAX_LOSS_USDC: "10",
    MARKET_MAX_LOSS_USDC: "4",
    MIN_USDC_BALANCE: "40",
  };
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

function extractAllowanceRaw(balanceAllowance: unknown): string | undefined {
  const direct = (balanceAllowance as { allowance?: unknown } | null)?.allowance;
  if (typeof direct === "string") {
    return direct;
  }

  const allowances = (balanceAllowance as { allowances?: Record<string, unknown> } | null)?.allowances;
  if (!allowances || typeof allowances !== "object") {
    return undefined;
  }

  const values = Object.values(allowances).filter((value): value is string => typeof value === "string");
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((max, current) => (BigInt(current) > BigInt(max) ? current : max));
}

function isProbablyPublicRpc(url: string): boolean {
  return [
    "polygon-rpc.com",
    "publicnode.com",
    "1rpc.io",
    "drpc.org",
    "llamarpc.com",
    "ankr.com",
  ].some((host) => url.includes(host));
}

async function probeMarketWs(env: AppEnv, assetIds: string[]): Promise<ProbeStatus> {
  return new Promise((resolve) => {
    const client = new MarketWsClient(env);
    let opened = false;
    let settled = false;

    const finish = (status: ProbeStatus) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      client.disconnect();
      resolve(status);
    };

    const timeout = setTimeout(() => {
      finish(opened ? { ok: true, details: "transport acildi, ilk book event timeout icinde gelmedi" } : { ok: false, details: "market ws timeout" });
    }, 3000);

    client.once("open", () => {
      opened = true;
    });
    client.once("book", () => finish({ ok: true, details: "book event alindi" }));
    client.once("error", (error: Error) => finish({ ok: false, details: error.message }));
    client.once("close", () => {
      if (!settled && !opened) {
        finish({ ok: false, details: "market ws erken kapandi" });
      }
    });

    client.connect(assetIds);
  });
}

async function probeUserWs(env: AppEnv, conditionId: string): Promise<ProbeStatus> {
  if (!hasApiCreds(env)) {
    return { ok: false, details: "api credential eksik; user ws probe atlandi" };
  }

  return new Promise((resolve) => {
    const client = new UserWsClient(env);
    let opened = false;
    let settled = false;

    const finish = (status: ProbeStatus) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      client.disconnect();
      resolve(status);
    };

    const timeout = setTimeout(() => {
      finish(opened ? { ok: true, details: "user ws transport acildi" } : { ok: false, details: "user ws timeout" });
    }, 3000);

    client.once("open", () => {
      opened = true;
    });
    client.once("warn", (error: Error) => finish({ ok: false, details: error.message }));
    client.once("error", (error: Error) => finish({ ok: false, details: error.message }));
    client.once("close", () => {
      if (!settled && !opened) {
        finish({ ok: false, details: "user ws erken kapandi" });
      }
    });
    client.once("order", () => finish({ ok: true, details: "order event alindi" }));
    client.once("trade", () => finish({ ok: true, details: "trade event alindi" }));

    client.connect([conditionId]);
  });
}

export async function runLiveCheck(env: AppEnv): Promise<LiveCheckReport> {
  const signer = createSigner(env);
  const relayerConfigured = Boolean(
    env.POLY_RELAYER_API_KEY &&
      env.POLY_RELAYER_API_KEY_ADDRESS &&
      env.POLY_RELAYER_BASE_URL,
  );
  const relayerOwnerMatchesSigner = relayerConfigured
    ? env.POLY_RELAYER_API_KEY_ADDRESS!.toLowerCase() === signer.signerAddress.toLowerCase()
    : false;
  const topology = classifyWalletTopology({
    configuredWalletAddress: env.BOT_WALLET_ADDRESS,
    signerAddress: signer.signerAddress,
    funderAddress: env.POLY_FUNDER ?? env.BOT_WALLET_ADDRESS,
    signatureType: env.POLY_SIGNATURE_TYPE,
    chainId: env.POLY_CHAIN_ID,
  });
  const clob = createClobAdapter(env);
  const clock = new SystemClock();
  const gamma = new GammaClient(env);
  const publicClient = createPublicClient({
    chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
    transport: http(env.POLY_RPC_URL),
  });

  let chainId = env.POLY_CHAIN_ID;
  let blockNumber = 0n;
  let signerPolRaw = 0n;
  let funderPolRaw = 0n;
  let collateralDecimals = 6;
  let funderCollateralRaw = 0n;
  let relayerStatus: ProbeStatus =
    topology.mode === "direct"
      ? { ok: true, details: "direct mode; relayer gerekli degil" }
      : { ok: false, details: "relayer probe calismadi" };
  let safeDeployed: boolean | undefined;
  let relayerTransactionHistoryCount: number | undefined;

  const blockers: string[] = [];
  const warnings: string[] = [];

  try {
    [
      chainId,
      blockNumber,
      signerPolRaw,
      funderPolRaw,
      collateralDecimals,
      funderCollateralRaw,
    ] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
      publicClient.getBalance({ address: topology.signerAddress as `0x${string}` }),
      publicClient.getBalance({ address: topology.funderAddress as `0x${string}` }),
      publicClient.readContract({
        address: env.ACTIVE_COLLATERAL_TOKEN as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: env.ACTIVE_COLLATERAL_TOKEN as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [topology.funderAddress as `0x${string}`],
      }),
    ]);
  } catch (error) {
    blockers.push(`RPC preflight basarisiz: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!topology.signerMatchesConfiguredWallet) {
    blockers.push("BOT_WALLET_ADDRESS private key'den tureyen signer adresiyle eslesmiyor.");
  }
  if (!hasApiCreds(env)) {
    blockers.push("POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE eksik.");
  }
  if (isProbablyPublicRpc(env.POLY_RPC_URL)) {
    warnings.push("POLY_RPC_URL paylasimli public RPC. Ilk canary icin calisabilir ama rate-limit / stale-read riski yuksek.");
  }
  if (env.DRY_RUN) {
    warnings.push("DRY_RUN=true. Bu iyi; canliya cikmadan once false yapilacak.");
  }

  const gammaStatus: ProbeStatus = { ok: false };
  const clobReadStatus: ProbeStatus = { ok: false };
  let marketInfo: LiveCheckReport["market"] = {};
  let auth: LiveCheckReport["auth"] = {
    apiCredsPresent: hasApiCreds(env),
  };
  let marketWsStatus: ProbeStatus = { ok: false, details: "probe atlanamadi" };
  let userWsStatus: ProbeStatus = { ok: false, details: "probe atlanamadi" };

  if (topology.mode !== "direct") {
    if (!relayerConfigured) {
      relayerStatus = {
        ok: false,
        details: "POLY_RELAYER_API_KEY / POLY_RELAYER_API_KEY_ADDRESS / POLY_RELAYER_BASE_URL eksik",
      };
    } else {
      try {
        const relayer = new RelayerApiClient(env);
        relayer.ensureTopology();
        const [transactions, deployed] = await Promise.all([
          relayer.listTransactions(),
          topology.mode === "safe" ? relayer.isSafeDeployed() : Promise.resolve(undefined),
        ]);
        relayerTransactionHistoryCount = transactions.length;
        safeDeployed = deployed;
        relayerStatus = {
          ok: true,
          details:
            topology.mode === "safe"
              ? `relayer auth ok, tx history=${transactions.length}, safeDeployed=${String(deployed)}`
              : `relayer auth ok, tx history=${transactions.length}`,
        };
      } catch (error) {
        relayerStatus = {
          ok: false,
          details: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const merge = assessMergeExecutionReadiness({
    topology,
    mergeEnabled: env.CTF_MERGE_ENABLED,
    relayerConfigured,
    relayerOwnerMatchesSigner,
    ...(safeDeployed !== undefined ? { safeDeployed } : {}),
  });
  if (!merge.ready) {
    if (merge.severity === "block") {
      blockers.push(merge.reason ?? "merge execution hazir degil");
    } else if (merge.reason) {
      warnings.push(merge.reason);
    }
  }
  if (topology.mode !== "direct" && env.CTF_MERGE_ENABLED && !relayerStatus.ok) {
    blockers.push(`Relayer preflight basarisiz: ${relayerStatus.details ?? "bilinmeyen hata"}`);
  }

  try {
    const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
    const current = discovery.current;
    gammaStatus.ok = true;
    gammaStatus.details = current.slug;
    marketInfo = {
      currentSlug: current.slug,
      currentConditionId: current.conditionId,
      upTokenId: current.tokens.UP.tokenId,
      downTokenId: current.tokens.DOWN.tokenId,
      tickSize: current.tickSize,
      minOrderSize: current.minOrderSize,
      source: current.source,
    };

    try {
      await clob.getOrderBook(current.tokens.UP.tokenId);
      clobReadStatus.ok = true;
      clobReadStatus.details = "orderbook alindi";
    } catch (error) {
      clobReadStatus.ok = false;
      clobReadStatus.details = error instanceof Error ? error.message : String(error);
      blockers.push("CLOB read/orderbook erisimi basarisiz.");
    }

    marketWsStatus = await probeMarketWs(env, [current.tokens.UP.tokenId, current.tokens.DOWN.tokenId]);
    if (!marketWsStatus.ok) {
      blockers.push(`Market WS hazir degil: ${marketWsStatus.details ?? "bilinmeyen hata"}`);
    }

    userWsStatus = await probeUserWs(env, current.conditionId);
    if (!userWsStatus.ok) {
      warnings.push(`User WS best-effort probe basarisiz: ${userWsStatus.details ?? "bilinmeyen hata"}`);
    }
  } catch (error) {
    gammaStatus.ok = false;
    gammaStatus.details = error instanceof Error ? error.message : String(error);
    blockers.push("Gamma market discovery basarisiz.");
  }

  if (hasApiCreds(env)) {
    try {
      if (env.USE_CLOB_V2) {
        const client = new V2ClobClient({
          host: env.POLY_CLOB_BASE_URL,
          chain: toV2Chain(env.POLY_CHAIN_ID),
          signer: signer.walletClient,
          creds: {
            key: env.POLY_API_KEY!,
            secret: env.POLY_API_SECRET!,
            passphrase: env.POLY_API_PASSPHRASE!,
          },
          signatureType: env.POLY_SIGNATURE_TYPE as SignatureTypeV2,
          ...(env.POLY_FUNDER ? { funderAddress: env.POLY_FUNDER } : {}),
          retryOnError: true,
          throwOnError: true,
        });
        await client.updateBalanceAllowance({ asset_type: V2AssetType.COLLATERAL });
        const [apiKeys, openOrders, balanceAllowance] = await Promise.all([
          client.getApiKeys(),
          client.getOpenOrders(),
          client.getBalanceAllowance({ asset_type: V2AssetType.COLLATERAL }),
        ]);
        const collateralAllowanceRaw = extractAllowanceRaw(balanceAllowance);
        auth = {
          apiCredsPresent: true,
          apiKeysCount: apiKeys.apiKeys.length,
          openOrdersCount: openOrders.length,
          collateralBalance: formatTokenAmount(BigInt(balanceAllowance.balance), Number(collateralDecimals)),
          ...(collateralAllowanceRaw
            ? { collateralAllowance: formatTokenAmount(BigInt(collateralAllowanceRaw), Number(collateralDecimals)) }
            : {}),
        };
      } else {
        const client = new V1ClobClient(
          env.POLY_CLOB_BASE_URL,
          toV1Chain(env.POLY_CHAIN_ID),
          signer.walletClient,
          {
            key: env.POLY_API_KEY!,
            secret: env.POLY_API_SECRET!,
            passphrase: env.POLY_API_PASSPHRASE!,
          },
          env.POLY_SIGNATURE_TYPE as V1SignatureType,
          env.POLY_FUNDER,
          undefined,
          true,
          undefined,
          undefined,
          true,
          undefined,
          true,
        );
        await client.updateBalanceAllowance({ asset_type: V1AssetType.COLLATERAL });
        const [apiKeys, openOrders, balanceAllowance] = await Promise.all([
          client.getApiKeys(),
          client.getOpenOrders(),
          client.getBalanceAllowance({ asset_type: V1AssetType.COLLATERAL }),
        ]);
        const collateralAllowanceRaw = extractAllowanceRaw(balanceAllowance);
        auth = {
          apiCredsPresent: true,
          apiKeysCount: apiKeys.apiKeys.length,
          openOrdersCount: openOrders.length,
          collateralBalance: formatTokenAmount(BigInt(balanceAllowance.balance), Number(collateralDecimals)),
          ...(collateralAllowanceRaw
            ? { collateralAllowance: formatTokenAmount(BigInt(collateralAllowanceRaw), Number(collateralDecimals)) }
            : {}),
        };
      }
    } catch (error) {
      blockers.push(`CLOB authenticated preflight basarisiz: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (Number(auth.collateralAllowance ?? "0") <= 0) {
    blockers.push("Collateral allowance 0 veya okunamadi; buy emirleri fail eder.");
  }
  if (Number(auth.collateralBalance ?? "0") < env.MIN_USDC_BALANCE) {
    blockers.push("CLOB collateral balance min live esiginin altinda.");
  }

  return {
    summary: {
      readyForLiveSmall: blockers.length === 0,
      blockers,
      warnings,
    },
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      dryRun: env.DRY_RUN,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      rpcUrl: env.POLY_RPC_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      signerAddress: topology.signerAddress,
      configuredWalletAddress: topology.configuredWalletAddress,
      funderAddress: topology.funderAddress,
      topology: topology.mode,
      collateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
      mergeExecutionEnabled: env.CTF_MERGE_ENABLED,
    },
    rpc: {
      chainId,
      blockNumber: blockNumber.toString(),
      signerPol: formatUnits(signerPolRaw, 18),
      funderPol: formatUnits(funderPolRaw, 18),
    },
    auth,
    market: marketInfo,
    connectivity: {
      gamma: gammaStatus,
      clobRead: clobReadStatus,
      marketWs: marketWsStatus,
      userWs: userWsStatus,
    },
    relayer: {
      configured: relayerConfigured,
      ...(env.POLY_RELAYER_BASE_URL ? { baseUrl: env.POLY_RELAYER_BASE_URL } : {}),
      ...(env.POLY_RELAYER_API_KEY_ADDRESS ? { apiKeyAddress: env.POLY_RELAYER_API_KEY_ADDRESS } : {}),
      ownerMatchesSigner: relayerOwnerMatchesSigner,
      ...(topology.expectedFunderAddress ? { expectedFunderAddress: topology.expectedFunderAddress } : {}),
      ...(relayerTransactionHistoryCount !== undefined
        ? { transactionHistoryCount: relayerTransactionHistoryCount }
        : {}),
      ...(safeDeployed !== undefined ? { safeDeployed } : {}),
      probe: relayerStatus,
    },
    merge: {
      enabled: env.CTF_MERGE_ENABLED,
      ready: merge.ready,
      severity: merge.severity,
      ...(merge.reason ? { reason: merge.reason } : {}),
    },
    recommendedEnv: recommendedCanaryEnv(),
  };
}
