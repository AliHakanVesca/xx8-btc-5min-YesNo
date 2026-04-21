import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Command } from "commander";
import { loadEnv } from "./config/env.js";
import { writeEnvUpdates } from "./config/envFile.js";
import { createLogger, writeStructuredLog } from "./observability/logger.js";
import { analyzeXuanFile, writeXuanMarkdownReport } from "./infra/dataApi/xuanAnalyzer.js";
import { runSyntheticReplay } from "./analytics/replaySimulator.js";
import { runMultiSyntheticReplay } from "./analytics/multiReplay.js";
import { runLivePaperSession } from "./analytics/livePaper.js";
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
import { runStatefulBotSession } from "./live/statefulBotSession.js";
import { runCaptureSession } from "./live/captureSession.js";

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

async function runPaper(): Promise<void> {
  const env = loadEnv();
  const replay = runSyntheticReplay(env);
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
  const replay = runMultiSyntheticReplay(env, options.windows);
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
          lotLadder: config.lotLadder,
          liveSmallLots: config.liveSmallLots,
          defaultLot: config.defaultLot,
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
  tickMs: number;
  initialBookWaitMs: number;
  balanceSyncMs: number;
}): Promise<void> {
  const env = loadEnv();
  if (env.DRY_RUN) {
    throw new Error("bot:live icin once DRY_RUN=false yap.");
  }

  const report = await runStatefulBotSession(env, {
    durationSec: options.durationSec,
    tickMs: options.tickMs,
    initialBookWaitMs: options.initialBookWaitMs,
    balanceSyncMs: options.balanceSyncMs,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runLiveCheckCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const report = await runLiveCheck(env);
  await writeStructuredLog("system", { event: "live_check", report });
  console.log(JSON.stringify(report, null, 2));
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program.name("xx8-btc-5min-yesno");
  program.command("config:show").action(async () => runConfigShow());
  program.command("live:check").action(async () => runLiveCheckCommand());
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
  program.command("paper").action(async () => runPaper());
  program
    .command("paper:multi")
    .option("--windows <n>", "Number of offline 5m windows to simulate", "3")
    .action(async (options: { windows: string }) => runPaperMulti({ windows: Number(options.windows) }));
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
    .option("--duration-sec <n>", "Run the live market session for N seconds", "240")
    .option("--tick-ms <n>", "Decision loop interval in milliseconds", "1000")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .option("--balance-sync-ms <n>", "How often to reconcile ERC1155 balances", "5000")
    .action(
      async (options: {
        durationSec: string;
        tickMs: string;
        initialBookWaitMs: string;
        balanceSyncMs: string;
      }) =>
        runBotLive({
          durationSec: Number(options.durationSec),
          tickMs: Number(options.tickMs),
          initialBookWaitMs: Number(options.initialBookWaitMs),
          balanceSyncMs: Number(options.balanceSyncMs),
        }),
    );

  await program.parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli();
}
