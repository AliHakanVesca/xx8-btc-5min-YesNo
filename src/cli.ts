import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Command } from "commander";
import { loadEnv } from "./config/env.js";
import { writeEnvUpdates } from "./config/envFile.js";
import { writeJson } from "./utils/fs.js";
import { createLogger, writeStructuredLog } from "./observability/logger.js";
import { analyzeXuanFile, writeXuanMarkdownReport } from "./infra/dataApi/xuanAnalyzer.js";
import { runSyntheticReplay } from "./analytics/replaySimulator.js";
import { runMultiSyntheticReplay } from "./analytics/multiReplay.js";
import { runLivePaperSession } from "./analytics/livePaper.js";
import { runPaperSession, type PaperSessionVariant } from "./analytics/paperSession.js";
import {
  buildCanonicalReferenceBundle,
  buildCanonicalReferenceFromPaperSession,
  writeCanonicalReferenceBundle,
} from "./analytics/xuanCanonicalReference.js";
import { compareCanonicalReference } from "./analytics/xuanReplayComparator.js";
import {
  buildRuntimeCanonicalExtractBundle,
  toCanonicalReferenceBundle,
  writeRuntimeCanonicalExtractBundle,
} from "./analytics/runtimeCanonicalReference.js";
import { createClobAdapter } from "./infra/clob/index.js";
import { createOrDeriveActiveApiKey } from "./infra/clob/apiKeyLifecycle.js";
import { SystemClock } from "./infra/time/clock.js";
import { GammaClient } from "./infra/gamma/gammaClient.js";
import { buildOfflineMarket, discoverCurrentAndNextMarkets } from "./infra/gamma/marketDiscovery.js";
import { buildStrategyConfig } from "./config/strategyPresets.js";
import { createMarketState } from "./strategy/xuan5m/marketState.js";
import { buildSyntheticBook } from "./analytics/replaySimulator.js";
import { OrderBookState } from "./strategy/xuan5m/orderBookState.js";
import { Xuan5mBot } from "./strategy/xuan5m/Xuan5mBot.js";
import { OrderManager } from "./execution/orderManager.js";
import { TakerCompletionManager } from "./execution/takerCompletionManager.js";
import { CtfClient } from "./infra/ctf/ctfClient.js";
import { renderDashboard } from "./observability/dashboard.js";
import { runLiveCheck } from "./live/liveCheck.js";
import { runContinuousBotDaemon } from "./live/continuousBotDaemon.js";
import { runCaptureSession } from "./live/captureSession.js";
import {
  buildInventoryActionPlan,
  executeInventoryActionPlan,
  fetchInventorySnapshot,
  manageInventory,
} from "./live/inventoryManager.js";
import { PersistentStateStore } from "./live/persistentStateStore.js";
import { resolveConfiguredFunderAddress } from "./live/topology.js";
import { approveCollateralSpenders } from "./infra/polygon/collateralApproval.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runAnalyzeXuan(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const preferredPath = "data/xuanxuan008_data_20260415_145447.json";
  const fallbackPath = "tests/fixtures/xuan_sample.json";
  const filePath = (await fileExists(preferredPath)) ? preferredPath : fallbackPath;

  if (filePath === fallbackPath) {
    logger.warn({ filePath }, "Real xuan export missing; using bundled fixture.");
  }

  const report = await analyzeXuanFile(filePath);
  const markdownPath = await writeXuanMarkdownReport(report);
  logger.info({ filePath, markdownPath, report }, "xuan analysis complete");
  console.log(JSON.stringify({ filePath, markdownPath, report }, null, 2));
}

const defaultXuanReferenceSlugs = [
  "btc-updown-5m-1776253500",
  "btc-updown-5m-1776253200",
  "btc-updown-5m-1776252300",
  "btc-updown-5m-1776247200",
];

const preferredXuanSqlitePath = "/Users/cakir/Documents/tmp/polymarket-wallet-sc/data/polymarket-wallets.sqlite";

async function resolveDefaultXuanTradeTapePath(): Promise<string> {
  const preferredPath = "data/xuanxuan008_data_20260415_145447.json";
  const fallbackPath = "tests/fixtures/xuan_sample.json";
  return (await fileExists(preferredPath)) ? preferredPath : fallbackPath;
}

async function resolveDefaultXuanSqlitePath(): Promise<string | undefined> {
  return (await fileExists(preferredXuanSqlitePath)) ? preferredXuanSqlitePath : undefined;
}

async function runXuanExtractCommand(options: {
  jsonPath?: string;
  sqlitePath?: string;
  wallet?: string;
  slugs?: string[];
  out?: string;
}): Promise<void> {
  const jsonPath = options.jsonPath && options.jsonPath.length > 0 ? options.jsonPath : await resolveDefaultXuanTradeTapePath();
  const sqlitePath =
    options.sqlitePath && options.sqlitePath.length > 0 ? options.sqlitePath : await resolveDefaultXuanSqlitePath();
  const slugs = options.slugs && options.slugs.length > 0 ? options.slugs : defaultXuanReferenceSlugs;
  const bundle = await buildCanonicalReferenceBundle({
    filePath: jsonPath,
    sqlitePath,
    wallet: options.wallet,
    slugs,
  });
  const outputPath = await writeCanonicalReferenceBundle(bundle, options.out && options.out.length > 0 ? options.out : undefined);
  await writeStructuredLog("markets", {
    event: "xuan_canonical_extract",
    outputPath,
    sources: bundle.sources,
    slugs: bundle.slugs,
  });
  console.log(
    JSON.stringify(
      {
        outputPath,
        bundle,
      },
      null,
      2,
    ),
  );
}

async function runXuanComparePaperCommand(options: {
  variant: PaperSessionVariant;
  referenceSlug: string;
  jsonPath?: string;
  sqlitePath?: string;
  wallet?: string;
  out?: string;
}): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const jsonPath = options.jsonPath && options.jsonPath.length > 0 ? options.jsonPath : await resolveDefaultXuanTradeTapePath();
  const sqlitePath =
    options.sqlitePath && options.sqlitePath.length > 0 ? options.sqlitePath : await resolveDefaultXuanSqlitePath();
  const bundle = await buildCanonicalReferenceBundle({
    filePath: jsonPath,
    sqlitePath,
    wallet: options.wallet,
    slugs: [options.referenceSlug],
  });
  const reference = bundle.references.find((item) => item.slug === options.referenceSlug);
  if (!reference) {
    throw new Error(`Canonical reference bulunamadi: ${options.referenceSlug}`);
  }

  const replay = runPaperSession(env, options.variant);
  const candidate = buildCanonicalReferenceFromPaperSession(replay);
  const comparison = compareCanonicalReference(reference, { ...candidate, slug: reference.slug });
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "replay",
    status: comparison.verdict.toLowerCase(),
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "xuan:compare-paper",
      variant: options.variant,
      referenceSlug: options.referenceSlug,
      score: comparison.score,
      verdict: comparison.verdict,
    },
  });
  stateStore.close();

  const output = {
    reference,
    candidate,
    comparison,
    sources: bundle.sources,
  };
  const outputPath = options.out && options.out.length > 0 ? options.out : `reports/xuan_compare_${options.variant}_${options.referenceSlug}.json`;
  await writeStructuredLog("markets", {
    event: "xuan_compare_paper",
    referenceSlug: options.referenceSlug,
    variant: options.variant,
    verdict: comparison.verdict,
    score: comparison.score,
  });
  await writeJson(outputPath, output);
  console.log(JSON.stringify({ outputPath, output }, null, 2));
  if (comparison.verdict === "FAIL") {
    process.exitCode = 1;
  }
}

async function runXuanExtractRuntimeCommand(options: {
  stateDbPath?: string;
  logsDir?: string;
  marketSlugs?: string[];
  out?: string;
}): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const bundle = await buildRuntimeCanonicalExtractBundle({
    stateDbPath: options.stateDbPath && options.stateDbPath.length > 0 ? options.stateDbPath : config.stateStorePath,
    logsDir: options.logsDir,
    marketSlugs: options.marketSlugs,
  });
  const outputPath = await writeRuntimeCanonicalExtractBundle(
    bundle,
    options.out && options.out.length > 0 ? options.out : undefined,
  );
  await writeStructuredLog("markets", {
    event: "runtime_canonical_extract",
    outputPath,
    sources: bundle.sources,
    slugs: bundle.slugs,
  });
  console.log(
    JSON.stringify(
      {
        outputPath,
        bundle,
      },
      null,
      2,
    ),
  );
}

async function runXuanCompareRuntimeCommand(options: {
  referenceSlug: string;
  marketSlug: string;
  jsonPath?: string;
  sqlitePath?: string;
  wallet?: string;
  stateDbPath?: string;
  logsDir?: string;
  out?: string;
}): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const jsonPath = options.jsonPath && options.jsonPath.length > 0 ? options.jsonPath : await resolveDefaultXuanTradeTapePath();
  const sqlitePath =
    options.sqlitePath && options.sqlitePath.length > 0 ? options.sqlitePath : await resolveDefaultXuanSqlitePath();
  const referenceBundle = await buildCanonicalReferenceBundle({
    filePath: jsonPath,
    sqlitePath,
    wallet: options.wallet,
    slugs: [options.referenceSlug],
  });
  const reference = referenceBundle.references.find((item) => item.slug === options.referenceSlug);
  if (!reference) {
    throw new Error(`Canonical reference bulunamadi: ${options.referenceSlug}`);
  }

  const runtimeBundle = await buildRuntimeCanonicalExtractBundle({
    stateDbPath: options.stateDbPath && options.stateDbPath.length > 0 ? options.stateDbPath : config.stateStorePath,
    logsDir: options.logsDir,
    marketSlugs: [options.marketSlug],
  });
  const candidate = runtimeBundle.references.find((item) => item.slug === options.marketSlug);
  if (!candidate) {
    throw new Error(`Runtime canonical candidate bulunamadi: ${options.marketSlug}`);
  }

  const comparison = compareCanonicalReference(reference, candidate, {
    hardFails: runtimeBundle.hardFailsBySlug[options.marketSlug],
  });
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "replay",
    status: comparison.verdict.toLowerCase(),
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "xuan:compare-runtime",
      referenceSlug: options.referenceSlug,
      marketSlug: options.marketSlug,
      score: comparison.score,
      verdict: comparison.verdict,
    },
  });
  stateStore.close();

  const output = {
    referenceBundle,
    runtimeBundle,
    candidateBundle: toCanonicalReferenceBundle(runtimeBundle),
    comparison,
  };
  const outputPath =
    options.out && options.out.length > 0
      ? options.out
      : `reports/xuan_compare_runtime_${options.marketSlug}_vs_${options.referenceSlug}.json`;
  await writeStructuredLog("markets", {
    event: "xuan_compare_runtime",
    referenceSlug: options.referenceSlug,
    marketSlug: options.marketSlug,
    verdict: comparison.verdict,
    score: comparison.score,
  });
  await writeJson(outputPath, output);
  console.log(JSON.stringify({ outputPath, output }, null, 2));
  if (comparison.verdict === "FAIL") {
    process.exitCode = 1;
  }
}

async function runPaper(): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const replay = runSyntheticReplay(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "paper",
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "paper",
      marketSlug: replay.marketSlug,
    },
  });
  stateStore.close();
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    replay,
  };
  await writeStructuredLog("markets", payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function runPaperMulti(options: { windows: number }): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const replay = runMultiSyntheticReplay(env, options.windows);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "paper",
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "paper:multi",
      windows: options.windows,
      scenarioCount: replay.scenarios.length,
    },
  });
  stateStore.close();
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    replay,
  };
  await writeStructuredLog("markets", { event: "paper_multi", ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

async function runPaperSessionCommand(options: { variant: PaperSessionVariant }): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const replay = runPaperSession(env, options.variant);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "paper",
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "paper:session",
      variant: options.variant,
      marketSlug: replay.market.slug,
    },
  });
  stateStore.close();
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    replay,
  };
  await writeStructuredLog("markets", { event: "paper_session", ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

async function runPaperLive(options: {
  durationSec: number;
  sampleMs: number;
  initialBookWaitMs: number;
}): Promise<void> {
  const env = loadEnv();
  const report = await runLivePaperSession(env, options);
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    report,
  };
  await writeStructuredLog("markets", { event: "paper_live", ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

async function runConfigShow(): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  console.log(
    JSON.stringify(
      {
        botMode: env.BOT_MODE,
        stackMode: env.POLY_STACK_MODE,
        useClobV2: env.USE_CLOB_V2,
        clobBaseUrl: env.POLY_CLOB_BASE_URL,
        marketWsUrl: env.POLY_MARKET_WS_URL,
        userWsUrl: env.POLY_USER_WS_URL,
        signatureType: env.POLY_SIGNATURE_TYPE,
        funder: env.POLY_FUNDER,
        activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
        activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
        dryRun: env.DRY_RUN,
        strategy: {
          stateStore: config.stateStore,
          stateStorePath: config.stateStorePath,
          priceToBeatPolicy: config.priceToBeatPolicy,
          enableMakerLayer: config.enableMakerLayer,
          entryTakerBuyEnabled: config.entryTakerBuyEnabled,
          entryTakerPairCap: config.entryTakerPairCap,
          completionCap: config.completionCap,
          minEdgePerShare: config.minEdgePerShare,
          strictPairEffectiveCap: config.strictPairEffectiveCap,
          normalPairEffectiveCap: config.normalPairEffectiveCap,
          completionSoftCap: config.completionSoftCap,
          completionHardCap: config.completionHardCap,
          emergencyCompletionMaxQty: config.emergencyCompletionMaxQty,
          maxNegativeEdgePerMarketUsdc: config.maxNegativeEdgePerMarketUsdc,
          maxMarketExposureShares: config.maxMarketExposureShares,
          softImbalanceRatio: config.softImbalanceRatio,
          hardImbalanceRatio: config.hardImbalanceRatio,
          partialFastWindowSec: config.partialFastWindowSec,
          partialSoftWindowSec: config.partialSoftWindowSec,
          partialPatientWindowSec: config.partialPatientWindowSec,
          partialFastCap: config.partialFastCap,
          partialSoftCap: config.partialSoftCap,
          partialHardCap: config.partialHardCap,
          partialEmergencyCap: config.partialEmergencyCap,
          lotLadder: config.lotLadder,
          xuanBaseLotLadder: config.xuanBaseLotLadder,
          liveSmallLots: config.liveSmallLotLadder,
          defaultLot: config.defaultLot,
          rejectUnclassifiedBuy: config.rejectUnclassifiedBuy,
          requireManualResumeConfirm: config.requireManualResumeConfirm,
          mergeMinShares: config.mergeMinShares,
          maxMarketSharesPerSide: config.maxMarketSharesPerSide,
          maxOneSidedExposureShares: config.maxOneSidedExposureShares,
          maxImbalanceFrac: config.maxImbalanceFrac,
          forceRebalanceImbalanceFrac: config.forceRebalanceImbalanceFrac,
          rebalanceLeadingFraction: config.rebalanceLeadingFraction,
          rebalanceMaxLaggingMultiplier: config.rebalanceMaxLaggingMultiplier,
          maxCyclesPerMarket: config.maxCyclesPerMarket,
          maxBuysPerSide: config.maxBuysPerSide,
          enterFromOpenSecMin: config.enterFromOpenSecMin,
          enterFromOpenSecMax: config.enterFromOpenSecMax,
          normalEntryCutoffSecToClose: config.normalEntryCutoffSecToClose,
          completionOnlyCutoffSecToClose: config.completionOnlyCutoffSecToClose,
          hardCancelSecToClose: config.hardCancelSecToClose,
          partialCompletionFractions: config.partialCompletionFractions,
          maxResidualHoldShares: config.maxResidualHoldShares,
          residualUnwindSecToClose: config.residualUnwindSecToClose,
          sellUnwindEnabled: config.sellUnwindEnabled,
          dailyMaxLossUsdc: config.dailyMaxLossUsdc,
          marketMaxLossUsdc: config.marketMaxLossUsdc,
          minUsdcBalance: config.minUsdcBalance,
        },
      },
      null,
      2,
    ),
  );
}

async function runCaptureCommand(options: {
  durationSec: number;
  initialBookWaitMs: number;
}): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const report = await runCaptureSession(env, {
    durationSec: options.durationSec,
    initialBookWaitMs: options.initialBookWaitMs,
  });
  await writeStructuredLog("system", { event: "capture_session", report });
  console.log(JSON.stringify(report, null, 2));
}

function redactSecret(value: string): string {
  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function runClobDerive(options: { writeEnv?: boolean; envFile: string }): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const result = await createOrDeriveActiveApiKey(env);

  if (options.writeEnv) {
    await writeEnvUpdates(options.envFile, {
      POLY_API_KEY: result.creds.key,
      POLY_API_SECRET: result.creds.secret,
      POLY_API_PASSPHRASE: result.creds.passphrase,
    });
  }

  console.log(
    JSON.stringify(
      {
        stackMode: env.POLY_STACK_MODE,
        adapterVersion: result.adapterVersion,
        host: result.host,
        signerAddress: result.signerAddress,
        signatureType: result.signatureType,
        funder: result.funder,
        wroteEnv: options.writeEnv ?? false,
        envFile: options.writeEnv ? options.envFile : undefined,
        creds: {
          key: redactSecret(result.creds.key),
          secret: redactSecret(result.creds.secret),
          passphrase: redactSecret(result.creds.passphrase),
        },
      },
      null,
      2,
    ),
  );
}

async function runBotOnce(mode: "dry" | "live"): Promise<void> {
  const env = loadEnv();
  if (mode === "dry" && !env.DRY_RUN) {
    throw new Error("bot:dry icin DRY_RUN=true olmali. Canli emir icin bot:live kullan.");
  }
  if (mode === "live" && env.DRY_RUN) {
    throw new Error("bot:live icin once DRY_RUN=false yap.");
  }

  const logger = createLogger(env);
  const clob = createClobAdapter(env);
  const clock = new SystemClock();
  const gamma = new GammaClient(env);
  const config = buildStrategyConfig(env);

  let market = buildOfflineMarket(Math.floor(clock.now() / 300) * 300);
  try {
    const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
    market = discovery.current;
  } catch (error) {
    logger.warn({ error }, "Live discovery failed, using offline market.");
  }

  const state = createMarketState(market);
  const bot = new Xuan5mBot();
  const nowTs = clock.now();
  const decision = bot.evaluateTick({
    config,
    state,
    books: new OrderBookState(
      buildSyntheticBook(market.tokens.UP.tokenId, market.conditionId, 0.48, 0.49),
      buildSyntheticBook(market.tokens.DOWN.tokenId, market.conditionId, 0.48, 0.49),
    ),
    nowTs,
    riskContext: {
      secsToClose: market.endTs - nowTs,
      staleBookMs: 200,
      balanceStaleMs: 200,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    },
    dryRunOrSmallLive: true,
  });

  const orderManager = new OrderManager(clob);
  const completionManager = new TakerCompletionManager(orderManager);
  const ctf = new CtfClient(env);

  const entryBuys =
    decision.entryBuys.length > 0
      ? await Promise.all(decision.entryBuys.map((entryBuy) => completionManager.execute(entryBuy.order)))
      : [];
  const completion = decision.completion ? await completionManager.complete(decision.completion.order) : null;
  const unwind = decision.unwind && !decision.completion ? await completionManager.complete(decision.unwind.order) : null;
  const merge =
    decision.mergeShares <= 0
      ? null
      : !env.CTF_MERGE_ENABLED
        ? {
            simulated: true,
            skipped: true,
            action: "merge" as const,
            amount: decision.mergeShares,
            conditionId: market.conditionId,
            reason: "CTF_MERGE_ENABLED=false",
          }
        : await ctf.mergePositions(market.conditionId, decision.mergeShares);
  const redeem =
    merge && !merge.skipped && env.CTF_AUTO_REDEEM_ENABLED
      ? await ctf.redeemPositions(market.conditionId)
      : null;

  const payload = {
    runtime: {
      mode,
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
      ctfMergeEnabled: env.CTF_MERGE_ENABLED,
      ctfAutoRedeemEnabled: env.CTF_AUTO_REDEEM_ENABLED,
    },
    market: market.slug,
    decision,
    entryBuys,
    completion,
    unwind,
    merge,
    redeem,
    dashboard: renderDashboard(state, decision, nowTs),
  };

  await writeStructuredLog("orders", payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function runBotDry(): Promise<void> {
  await runBotOnce("dry");
}

async function runBotLive(options: {
  durationSec: number;
  postCloseReconcileSec?: number;
  tickMs: number;
  initialBookWaitMs: number;
  balanceSyncMs: number;
  maxMarkets: number;
  interSessionPauseMs: number;
  marketSelection: "auto" | "current" | "next";
}): Promise<void> {
  const env = loadEnv();
  if (env.DRY_RUN) {
    throw new Error("bot:live icin once DRY_RUN=false yap.");
  }

  const postCloseOptions =
    options.postCloseReconcileSec === undefined
      ? {}
      : { postCloseReconcileSec: options.postCloseReconcileSec };
  const report = await runContinuousBotDaemon(env, {
    durationSec: options.durationSec,
    ...postCloseOptions,
    tickMs: options.tickMs,
    initialBookWaitMs: options.initialBookWaitMs,
    balanceSyncMs: options.balanceSyncMs,
    maxMarkets: options.maxMarkets,
    interSessionPauseMs: options.interSessionPauseMs,
    marketSelection: options.marketSelection,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runLiveCheckCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const report = await runLiveCheck(env);
  await writeStructuredLog("system", { event: "live_check", report });
  console.log(JSON.stringify(report, null, 2));
}

async function runInventoryReportCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const config = buildStrategyConfig(env);
  const snapshot = await fetchInventorySnapshot(env, config);
  await writeStructuredLog("inventory_snapshots", { event: "inventory_report", snapshot });
  console.log(JSON.stringify(snapshot, null, 2));
}

async function runInventoryReconcileCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const config = buildStrategyConfig(env);
  const snapshot = await fetchInventorySnapshot(env, config);
  const plan = buildInventoryActionPlan(snapshot, config);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordReconcileRun({
    scope: "inventory_reconcile_cli",
    marketSlug: snapshot.currentMarket?.slug,
    conditionId: snapshot.currentMarket?.conditionId,
    timestamp: Math.floor(Date.now() / 1000),
    status: "ok",
    requiresManualResume: false,
    mismatchShares: 0,
    payload: {
      blockNewEntries: plan.blockNewEntries,
      blockReasons: plan.blockReasons,
      marketCount: snapshot.markets.length,
    },
  });
  const payload = { snapshot, plan };
  await writeStructuredLog("inventory_snapshots", { event: "inventory_reconcile", ...payload });
  stateStore.close();
  console.log(JSON.stringify(payload, null, 2));
}

async function runBotResumeCommand(options: { confirm?: boolean }): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  const halt = stateStore.loadSafeHalt();
  const latestReconcile = stateStore.latestReconcileRun();

  if (!halt.active) {
    stateStore.close();
    console.log(JSON.stringify({ resumed: false, reason: "safe_halt_not_active" }, null, 2));
    return;
  }

  if (!options.confirm) {
    stateStore.close();
    throw new Error("bot:resume icin --confirm zorunlu.");
  }

  if (!latestReconcile || (halt.updatedAt !== undefined && latestReconcile.timestamp < halt.updatedAt)) {
    stateStore.close();
    throw new Error("SAFE_HALT kaldirmadan once npm run inventory:reconcile calistirilmali.");
  }

  stateStore.setSafeHalt({
    active: false,
    reason: "manual_resume_confirmed",
    timestamp: Math.floor(Date.now() / 1000),
  });
  stateStore.recordReconcileRun({
    scope: "bot_resume_cli",
    timestamp: Math.floor(Date.now() / 1000),
    status: "resume_confirmed",
    requiresManualResume: false,
    payload: {
      wallet: resolveConfiguredFunderAddress(env),
    },
  });
  stateStore.close();
  console.log(JSON.stringify({ resumed: true, stateDbPath: config.stateStorePath }, null, 2));
}

async function runInventoryActionCommand(action: "merge" | "redeem" | "manage"): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);

  if (action === "manage") {
    const report = await manageInventory(env, config);
    for (const item of report.actions) {
      stateStore.recordMergeRedeemEvent({
        marketSlug: item.slug,
        conditionId: item.conditionId,
        action: item.type,
        amount: item.amount,
        timestamp: Math.floor(Date.now() / 1000),
        simulated: item.result.simulated,
        reason: item.reason,
        txHash: item.result.txHash,
      });
    }
    await writeStructuredLog("merge_redeem", { event: "inventory_manage", report });
    stateStore.close();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const snapshot = await fetchInventorySnapshot(env, config);
  const plan = buildInventoryActionPlan(snapshot, config);
  const filteredPlan = {
    ...plan,
    redeem: action === "redeem" ? plan.redeem : [],
    merge: action === "merge" ? plan.merge : [],
  };
  const actions = await executeInventoryActionPlan(env, filteredPlan, config);
  for (const item of actions) {
    stateStore.recordMergeRedeemEvent({
      marketSlug: item.slug,
      conditionId: item.conditionId,
      action: item.type,
      amount: item.amount,
      timestamp: Math.floor(Date.now() / 1000),
      simulated: item.result.simulated,
      reason: item.reason,
      txHash: item.result.txHash,
    });
  }
  const payload = {
    before: snapshot,
    plan: filteredPlan,
    actions,
    after: await fetchInventorySnapshot(env, config),
  };
  await writeStructuredLog("merge_redeem", { event: `inventory_${action}_only`, ...payload });
  stateStore.close();
  console.log(JSON.stringify(payload, null, 2));
}

async function runCollateralApproveCommand(): Promise<void> {
  const env = loadEnv();
  const approvals = await approveCollateralSpenders(env);
  await writeStructuredLog("system", { event: "collateral_approve", approvals });
  console.log(
    JSON.stringify(
      {
        token: env.ACTIVE_COLLATERAL_TOKEN,
        approvals,
      },
      null,
      2,
    ),
  );
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program.name("xx8-btc-5min-yesno");
  program.command("config:show").action(async () => runConfigShow());
  program.command("live:check").action(async () => runLiveCheckCommand());
  program.command("collateral:approve").action(async () => runCollateralApproveCommand());
  program.command("inventory:report").action(async () => runInventoryReportCommand());
  program.command("inventory:reconcile").action(async () => runInventoryReconcileCommand());
  program.command("inventory:merge-only").action(async () => runInventoryActionCommand("merge"));
  program.command("inventory:redeem-only").action(async () => runInventoryActionCommand("redeem"));
  program.command("inventory:manage").action(async () => runInventoryActionCommand("manage"));
  program
    .command("bot:resume")
    .option("--confirm", "Clear persisted SAFE_HALT after manual reconcile")
    .action(async (options: { confirm?: boolean }) => runBotResumeCommand(options));
  program
    .command("capture")
    .option("--duration-sec <n>", "Capture current+next market feeds for N seconds", "75")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .action(async (options: { durationSec: string; initialBookWaitMs: string }) =>
      runCaptureCommand({
        durationSec: Number(options.durationSec),
        initialBookWaitMs: Number(options.initialBookWaitMs),
      }),
    );
  program
    .command("clob:derive")
    .option("--write-env", "Write derived POLY_API_* values into the env file")
    .option("--env-file <path>", "Env file path to update", ".env")
    .action(async (options: { writeEnv?: boolean; envFile: string }) => runClobDerive(options));
  program.command("analyze:xuan").action(async () => runAnalyzeXuan());
  program
    .command("xuan:extract")
    .option("--json-path <path>", "Trade tape JSON path")
    .option("--sqlite-path <path>", "Lifecycle authority SQLite path")
    .option("--wallet <address>", "Wallet/proxy address override")
    .option("--slugs <items...>", "Reference slug list")
    .option("--out <path>", "Output bundle path")
    .action(
      async (options: {
        jsonPath?: string;
        sqlitePath?: string;
        wallet?: string;
        slugs?: string[];
        out?: string;
      }) => runXuanExtractCommand(options),
    );
  program
    .command("xuan:compare-paper")
    .option("--variant <name>", "Synthetic session profile: xuan-flow | blocked-completion", "xuan-flow")
    .option("--reference-slug <slug>", "Canonical reference slug", defaultXuanReferenceSlugs[0])
    .option("--json-path <path>", "Trade tape JSON path")
    .option("--sqlite-path <path>", "Lifecycle authority SQLite path")
    .option("--wallet <address>", "Wallet/proxy address override")
    .option("--out <path>", "Output comparison path")
    .action(
      async (options: {
        variant: PaperSessionVariant;
        referenceSlug: string;
        jsonPath?: string;
        sqlitePath?: string;
        wallet?: string;
        out?: string;
      }) => runXuanComparePaperCommand(options),
    );
  program
    .command("xuan:extract-runtime")
    .option("--state-db-path <path>", "Runtime/state SQLite path")
    .option("--logs-dir <path>", "JSONL logs directory")
    .option("--market-slugs <items...>", "Runtime market slug list")
    .option("--out <path>", "Output bundle path")
    .action(
      async (options: {
        stateDbPath?: string;
        logsDir?: string;
        marketSlugs?: string[];
        out?: string;
      }) => runXuanExtractRuntimeCommand(options),
    );
  program
    .command("xuan:compare-runtime")
    .option("--reference-slug <slug>", "Canonical reference slug", defaultXuanReferenceSlugs[0])
    .requiredOption("--market-slug <slug>", "Runtime market slug")
    .option("--json-path <path>", "Trade tape JSON path")
    .option("--sqlite-path <path>", "Lifecycle authority SQLite path")
    .option("--wallet <address>", "Wallet/proxy address override")
    .option("--state-db-path <path>", "Runtime/state SQLite path")
    .option("--logs-dir <path>", "JSONL logs directory")
    .option("--out <path>", "Output comparison path")
    .action(
      async (options: {
        referenceSlug: string;
        marketSlug: string;
        jsonPath?: string;
        sqlitePath?: string;
        wallet?: string;
        stateDbPath?: string;
        logsDir?: string;
        out?: string;
      }) => runXuanCompareRuntimeCommand(options),
    );
  program.command("paper").action(async () => runPaper());
  program
    .command("paper:multi")
    .option("--windows <n>", "Number of offline 5m windows to simulate", "3")
    .action(async (options: { windows: string }) => runPaperMulti({ windows: Number(options.windows) }));
  program
    .command("paper:session")
    .option("--variant <name>", "Synthetic session profile: xuan-flow | blocked-completion", "xuan-flow")
    .action(async (options: { variant: PaperSessionVariant }) => runPaperSessionCommand(options));
  program
    .command("paper:live")
    .option("--duration-sec <n>", "Observe the live market for N seconds", "20")
    .option("--sample-ms <n>", "Sampling interval in milliseconds", "2000")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .action(async (options: { durationSec: string; sampleMs: string; initialBookWaitMs: string }) =>
      runPaperLive({
        durationSec: Number(options.durationSec),
        sampleMs: Number(options.sampleMs),
        initialBookWaitMs: Number(options.initialBookWaitMs),
      }),
    );
  program.command("bot:dry").action(async () => runBotDry());
  program
    .command("bot:live")
    .option("--duration-sec <n>", "Run each live market session for at most N seconds", "600")
    .option("--post-close-reconcile-sec <n>", "Wait after market close for balance reconcile/finalize; omitted auto-enables 60s for --max-markets 1")
    .option("--tick-ms <n>", "Decision loop interval in milliseconds", "1000")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .option("--balance-sync-ms <n>", "How often to reconcile ERC1155 balances", "5000")
    .option("--max-markets <n>", "Stop after N markets; 0 keeps the daemon running", "0")
    .option("--inter-session-pause-ms <n>", "Pause between finished markets before rollover", "1500")
    .option("--market-selection <mode>", "Market selection: auto | current | next", "auto")
    .action(
      async (options: {
        durationSec: string;
        postCloseReconcileSec?: string;
        tickMs: string;
        initialBookWaitMs: string;
        balanceSyncMs: string;
        maxMarkets: string;
        interSessionPauseMs: string;
        marketSelection: string;
      }) =>
        runBotLive({
          durationSec: Number(options.durationSec),
          ...(options.postCloseReconcileSec === undefined
            ? {}
            : { postCloseReconcileSec: Number(options.postCloseReconcileSec) }),
          tickMs: Number(options.tickMs),
          initialBookWaitMs: Number(options.initialBookWaitMs),
          balanceSyncMs: Number(options.balanceSyncMs),
          maxMarkets: Number(options.maxMarkets),
          interSessionPauseMs: Number(options.interSessionPauseMs),
          marketSelection:
            options.marketSelection === "current" || options.marketSelection === "next" ? options.marketSelection : "auto",
        }),
    );

  await program.parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli();
}
