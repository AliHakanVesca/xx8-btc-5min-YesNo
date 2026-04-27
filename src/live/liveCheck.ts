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
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { createClobAdapter } from "../infra/clob/index.js";
import { GammaClient } from "../infra/gamma/gammaClient.js";
import { discoverCurrentAndNextMarkets } from "../infra/gamma/marketDiscovery.js";
import { RelayerApiClient } from "../infra/relayer/relayerApiClient.js";
import { SystemClock } from "../infra/time/clock.js";
import { MarketWsClient } from "../infra/ws/marketWsClient.js";
import { UserWsClient } from "../infra/ws/userWsClient.js";
import { assessMergeExecutionReadiness, classifyWalletTopology, resolveConfiguredFunderAddress } from "./topology.js";
import { buildInventoryActionPlan, fetchInventorySnapshot } from "./inventoryManager.js";
import { resolveExchangeSpender } from "../infra/polygon/polymarketContracts.js";
import { PersistentStateStore } from "./persistentStateStore.js";
import {
  classifyComparisonFlowSummary,
  type ComparisonFlowSummary,
} from "../analytics/xuanReplayComparator.js";

interface ProbeStatus {
  ok: boolean;
  details?: string;
}

type RuntimeChildOrderDispatchReadinessStatus = "PASS" | "WARN" | "SKIPPED" | "UNKNOWN";

interface RuntimeChildOrderDispatchReadiness {
  status: RuntimeChildOrderDispatchReadinessStatus;
  reasons: string[];
  pairSubmitCount: number;
  flowIntentPairSubmitCount: number;
  compressedPairSubmitCount: number;
  averageInterChildDelayMs: number | null;
  maxInterChildDelayMs: number | null;
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
    selectedExchangeSpender?: string;
    selectedExchangeAllowance?: string;
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
  validation: {
    latestReplayStatus?: string;
    latestReplayTimestamp?: number;
    runtimeChildOrderDispatch: RuntimeChildOrderDispatchReadiness;
  };
  xuanAggressiveClone: {
    enabled: boolean;
    lastFootprintScore?: number;
    topBlockers: string[];
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

function isReplayComparatorStatus(status: string | undefined): status is "pass" | "warn" | "fail" {
  return status === "pass" || status === "warn" || status === "fail";
}

function extractComparisonFlowSummary(payload: Record<string, unknown> | undefined): ComparisonFlowSummary | undefined {
  const summary = payload?.flowSummary;
  if (!summary || typeof summary !== "object") {
    return undefined;
  }
  const candidate = summary as Partial<Record<keyof ComparisonFlowSummary, unknown>>;
  if (
    typeof candidate.flowLineageSimilarity !== "number" ||
    typeof candidate.activeFlowPeakSimilarity !== "number" ||
    typeof candidate.cycleCompletionLatencySimilarity !== "number"
  ) {
    return undefined;
  }
  return summary as ComparisonFlowSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isRuntimeChildOrderDispatchReadinessStatus(
  status: unknown,
): status is RuntimeChildOrderDispatchReadinessStatus {
  return status === "PASS" || status === "WARN" || status === "SKIPPED" || status === "UNKNOWN";
}

function extractRuntimeChildOrderDispatchReadiness(
  payload: Record<string, unknown> | undefined,
): RuntimeChildOrderDispatchReadiness {
  const statusCandidate = isRecord(payload?.runtimeChildOrderDispatchStatus)
    ? payload.runtimeChildOrderDispatchStatus
    : undefined;
  const runtimeDataStatus = isRecord(payload?.runtimeDataStatus) ? payload.runtimeDataStatus : undefined;
  const diagnostics = isRecord(runtimeDataStatus?.diagnostics) ? runtimeDataStatus.diagnostics : undefined;
  const summaryCandidate =
    (isRecord(statusCandidate?.summary) ? statusCandidate.summary : undefined) ??
    (isRecord(payload?.runtimeChildOrderDispatch) ? payload.runtimeChildOrderDispatch : undefined) ??
    (isRecord(diagnostics?.childOrderDispatch) ? diagnostics.childOrderDispatch : undefined);
  const reasons = Array.isArray(statusCandidate?.reasons)
    ? statusCandidate.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const status = isRuntimeChildOrderDispatchReadinessStatus(statusCandidate?.status)
    ? statusCandidate.status
    : summaryCandidate
      ? "UNKNOWN"
      : "UNKNOWN";

  return {
    status,
    reasons: status === "UNKNOWN" && reasons.length === 0 ? ["runtime_child_order_dispatch_status_missing"] : reasons,
    pairSubmitCount: asNumber(summaryCandidate?.pairSubmitCount),
    flowIntentPairSubmitCount: asNumber(summaryCandidate?.flowIntentPairSubmitCount),
    compressedPairSubmitCount: asNumber(summaryCandidate?.compressedPairSubmitCount),
    averageInterChildDelayMs: asNullableNumber(summaryCandidate?.averageInterChildDelayMs),
    maxInterChildDelayMs: asNullableNumber(summaryCandidate?.maxInterChildDelayMs),
  };
}

function extractXuanAggressiveCloneReadiness(
  config: ReturnType<typeof buildStrategyConfig>,
  payload: Record<string, unknown> | undefined,
): LiveCheckReport["xuanAggressiveClone"] {
  const summary = isRecord(payload?.summary) ? payload.summary : undefined;
  const reportSummary = isRecord(payload?.reportSummary) ? payload.reportSummary : undefined;
  const flowStatus = isRecord(payload?.flowStatus) ? payload.flowStatus : undefined;
  const directScore = typeof payload?.score === "number" ? payload.score : undefined;
  const summaryScore = typeof summary?.xuanConformanceScore === "number" ? summary.xuanConformanceScore : undefined;
  const reportScore = typeof reportSummary?.score === "number" ? reportSummary.score : undefined;
  const passBlockers = Array.isArray(summary?.xuanPassBlockers)
    ? summary.xuanPassBlockers.filter((item): item is string => typeof item === "string")
    : [];
  const directFlowReasons = Array.isArray(payload?.flowReasons)
    ? payload.flowReasons.filter((item): item is string => typeof item === "string")
    : [];
  const reportFlowReasons = Array.isArray(reportSummary?.flowReasons)
    ? reportSummary.flowReasons.filter((item): item is string => typeof item === "string")
    : [];
  const statusFlowReasons = Array.isArray(flowStatus?.reasons)
    ? flowStatus.reasons.filter((item): item is string => typeof item === "string")
    : [];
  const lastFootprintScore = directScore ?? summaryScore ?? reportScore;

  return {
    enabled: config.xuanCloneMode === "PUBLIC_FOOTPRINT" && config.xuanCloneIntensity === "AGGRESSIVE",
    ...(lastFootprintScore !== undefined ? { lastFootprintScore } : {}),
    topBlockers: [...passBlockers, ...directFlowReasons, ...reportFlowReasons, ...statusFlowReasons].slice(0, 5),
  };
}

function recommendedCanaryEnv(): Record<string, string> {
  const report = {
    DRY_RUN: "false",
    CTF_MERGE_ENABLED: "true",
    STATE_STORE: "SQLITE",
    VALIDATION_SEQUENCE: "REPLAY_THEN_LIVE",
    REPLAY_REQUIRED_BEFORE_LIVE: "true",
    LIVE_SMALL_LOT_LADDER: "5,10,15",
    DEFAULT_LOT: "5",
    MAX_MARKET_SHARES_PER_SIDE: "60",
    MAX_ONE_SIDED_EXPOSURE_SHARES: "30",
    MAX_CYCLES_PER_MARKET: "2",
    MAX_BUYS_PER_SIDE: "2",
    STRICT_PAIR_EFFECTIVE_CAP: "1.006",
    NORMAL_PAIR_EFFECTIVE_CAP: "1.020",
    PAIR_SWEEP_STRICT_CAP: "1.006",
    XUAN_PAIR_SWEEP_SOFT_CAP: "1.020",
    XUAN_PAIR_SWEEP_HARD_CAP: "1.045",
    ENABLE_XUAN_HARD_PAIR_SWEEP: "true",
    XUAN_HARD_SWEEP_MAX_QTY: "5",
    ALLOW_SINGLE_LEG_SEED: "false",
    ALLOW_CHEAP_UNDERDOG_SEED: "false",
    ALLOW_XUAN_COVERED_SEED: "true",
    SINGLE_LEG_ORPHAN_CAP: "0.62",
    SINGLE_LEG_FAIR_VALUE_VETO: "true",
    SINGLE_LEG_ORPHAN_MAX_FAIR_PREMIUM: "0.035",
    ORPHAN_LEG_MAX_NOTIONAL_USDC: "5",
    ORPHAN_LEG_MAX_AGE_SEC: "90",
    MAX_MARKET_ORPHAN_USDC: "5",
    MAX_SINGLE_ORPHAN_QTY: "5",
    PRICE_TO_BEAT_LATE_START_FALLBACK_ENABLED: "false",
    DAILY_MAX_LOSS_USDC: "10",
    MARKET_MAX_LOSS_USDC: "4",
    MIN_USDC_BALANCE_FOR_NEW_ENTRY: "25",
    MIN_USDC_BALANCE_FOR_COMPLETION: "5",
  };
  return report;
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

function extractAllowanceMap(balanceAllowance: unknown): Record<string, string> {
  const allowances = (balanceAllowance as { allowances?: Record<string, unknown> } | null)?.allowances;
  if (!allowances || typeof allowances !== "object") {
    const direct = (balanceAllowance as { allowance?: unknown } | null)?.allowance;
    return typeof direct === "string" ? { direct } : {};
  }

  return Object.fromEntries(
    Object.entries(allowances).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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
    funderAddress: resolveConfiguredFunderAddress(env),
    signatureType: env.POLY_SIGNATURE_TYPE,
    chainId: env.POLY_CHAIN_ID,
  });
  const clob = createClobAdapter(env);
  const clock = new SystemClock();
  const gamma = new GammaClient(env);
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
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
  const latestReplayValidation = stateStore.latestValidationRun("replay");
  const runtimeChildOrderDispatchReadiness = extractRuntimeChildOrderDispatchReadiness(
    latestReplayValidation?.payload,
  );

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
  if (config.validationSequence === "REPLAY_THEN_LIVE" && config.replayRequiredBeforeLive) {
    if (!latestReplayValidation) {
      blockers.push("Replay comparator kaydi bulunmadi. Live oncesi once npm run xuan:compare-paper veya npm run xuan:compare-runtime calistir.");
    } else if (!isReplayComparatorStatus(latestReplayValidation.status)) {
      blockers.push("En son replay kaydi comparator verdict degil. Plain paper/session kaydi live gate icin yeterli degil.");
    } else if (latestReplayValidation.status === "fail") {
      blockers.push("Replay validation FAIL durumda. Live oncesi comparator FAIL duzeltilmeli.");
    } else {
      if (latestReplayValidation.status === "warn") {
        warnings.push("Replay validation WARN. Footprint similarity orta seviyede; live smoke oncesi sonucu dikkatle degerlendir.");
      }
      const flowSummary = extractComparisonFlowSummary(latestReplayValidation.payload);
      if (flowSummary) {
        const flowStatus = classifyComparisonFlowSummary(flowSummary);
        if (flowStatus.status === "FAIL") {
          blockers.push(`Replay flowSummary FAIL: ${flowStatus.reasons.join(",")}. Live oncesi flow davranisi duzeltilmeli.`);
        } else if (flowStatus.status === "WARN") {
          warnings.push(`Replay flowSummary WARN: ${flowStatus.reasons.join(",")}. Multi-flow benzerligi dikkatle izlenmeli.`);
        }
      } else {
        warnings.push("Replay validation flowSummary icermiyor. Flow-lineage/active-peak alt skorlari icin compare komutunu tekrar calistir.");
      }
      if (runtimeChildOrderDispatchReadiness.status === "WARN") {
        warnings.push(
          `Runtime child-order dispatch WARN: ${runtimeChildOrderDispatchReadiness.reasons.join(",")}. Live smoke oncesi child-order mikro-zamanlamasi izlenmeli.`,
        );
      }
    }
  }

  const gammaStatus: ProbeStatus = { ok: false };
  const clobReadStatus: ProbeStatus = { ok: false };
  let marketInfo: LiveCheckReport["market"] = {};
  let selectedExchangeSpender: string | undefined;
  let selectedExchangeAllowanceRaw: string | undefined;
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
    selectedExchangeSpender = resolveExchangeSpender({
      useClobV2: env.USE_CLOB_V2,
      negRisk: current.negRisk,
    });

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
        const allowanceMap = extractAllowanceMap(balanceAllowance);
        selectedExchangeAllowanceRaw = selectedExchangeSpender
          ? allowanceMap[selectedExchangeSpender] ?? balanceAllowance.allowance
          : collateralAllowanceRaw;
        auth = {
          apiCredsPresent: true,
          apiKeysCount: apiKeys.apiKeys.length,
          openOrdersCount: openOrders.length,
          collateralBalance: formatTokenAmount(BigInt(balanceAllowance.balance), Number(collateralDecimals)),
          ...(collateralAllowanceRaw
            ? { collateralAllowance: formatTokenAmount(BigInt(collateralAllowanceRaw), Number(collateralDecimals)) }
            : {}),
          ...(selectedExchangeSpender ? { selectedExchangeSpender } : {}),
          ...(selectedExchangeAllowanceRaw
            ? { selectedExchangeAllowance: formatTokenAmount(BigInt(selectedExchangeAllowanceRaw), Number(collateralDecimals)) }
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
        const allowanceMap = extractAllowanceMap(balanceAllowance);
        selectedExchangeAllowanceRaw = selectedExchangeSpender
          ? allowanceMap[selectedExchangeSpender] ?? balanceAllowance.allowance
          : collateralAllowanceRaw;
        auth = {
          apiCredsPresent: true,
          apiKeysCount: apiKeys.apiKeys.length,
          openOrdersCount: openOrders.length,
          collateralBalance: formatTokenAmount(BigInt(balanceAllowance.balance), Number(collateralDecimals)),
          ...(collateralAllowanceRaw
            ? { collateralAllowance: formatTokenAmount(BigInt(collateralAllowanceRaw), Number(collateralDecimals)) }
            : {}),
          ...(selectedExchangeSpender ? { selectedExchangeSpender } : {}),
          ...(selectedExchangeAllowanceRaw
            ? { selectedExchangeAllowance: formatTokenAmount(BigInt(selectedExchangeAllowanceRaw), Number(collateralDecimals)) }
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
  if (selectedExchangeSpender && Number(auth.selectedExchangeAllowance ?? "0") < env.MIN_USDC_BALANCE_FOR_NEW_ENTRY) {
    blockers.push(
      `Secili exchange spender allowance yetersiz (${selectedExchangeSpender} -> ${auth.selectedExchangeAllowance ?? "0"}). collateral:approve gerekli.`,
    );
  }
  if (Number(auth.collateralBalance ?? "0") < env.MIN_USDC_BALANCE_FOR_NEW_ENTRY) {
    blockers.push("CLOB collateral balance min live esiginin altinda.");
  }

  try {
    const inventorySnapshot = await fetchInventorySnapshot(env, config);
    const inventoryPlan = buildInventoryActionPlan(inventorySnapshot, config);
    const actionableMarkets = inventorySnapshot.markets.filter(
      (market) => market.totalShares >= config.dustSharesThreshold,
    ).length;
    if (actionableMarkets > 0) {
      warnings.push(`Funder uzerinde ${actionableMarkets} markette residual inventory bulundu.`);
    }
    if (inventoryPlan.blockNewEntries) {
      blockers.push(`Startup inventory policy yeni entry'i bloklar: ${inventoryPlan.blockReasons.join(", ")}`);
    }
  } catch (error) {
    warnings.push(`Inventory snapshot alinamadi: ${error instanceof Error ? error.message : String(error)}`);
  }

  const xuanAggressiveClone = extractXuanAggressiveCloneReadiness(
    config,
    isRecord(latestReplayValidation?.payload) ? latestReplayValidation.payload : undefined,
  );
  const report = {
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
    validation: {
      ...(latestReplayValidation ? { latestReplayStatus: latestReplayValidation.status } : {}),
      ...(latestReplayValidation ? { latestReplayTimestamp: latestReplayValidation.timestamp } : {}),
      runtimeChildOrderDispatch: runtimeChildOrderDispatchReadiness,
    },
    xuanAggressiveClone,
    recommendedEnv: recommendedCanaryEnv(),
  };
  stateStore.close();
  return report;
}
