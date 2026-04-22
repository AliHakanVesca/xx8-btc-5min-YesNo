import type { AppEnv } from "../config/schema.js";
import { buildStrategyConfig } from "../config/strategyPresets.js";
import { writeStructuredLog } from "../observability/logger.js";
import { JsonlTraceLogger } from "../observability/jsonlTrace.js";
import { runStatefulBotSession, type BotSessionOptions, type BotSessionReport } from "./statefulBotSession.js";
import { PersistentStateStore } from "./persistentStateStore.js";
import { resolveConfiguredFunderAddress } from "./topology.js";

export interface ContinuousBotDaemonOptions extends BotSessionOptions {
  maxMarkets?: number;
  interSessionPauseMs?: number;
}

export interface ContinuousBotDaemonReport {
  runtime: {
    mode: "live-daemon";
    maxMarkets: number;
    requestedDurationSec: number;
    tickMs: number;
    initialBookWaitMs: number;
    balanceSyncMs: number;
    interSessionPauseMs: number;
    stateDbPath: string;
  };
  summary: {
    startedAt: number;
    endedAt: number;
    marketsCompleted: number;
    initialDailyNegativeEdgeSpentUsdc: number;
    finalDailyNegativeEdgeSpentUsdc: number;
  };
  sessions: Array<{
    market: BotSessionReport["market"];
    summary: BotSessionReport["summary"];
    finalState: BotSessionReport["finalState"];
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runContinuousBotDaemon(
  env: AppEnv,
  options: ContinuousBotDaemonOptions = {},
): Promise<ContinuousBotDaemonReport> {
  const resolvedOptions = {
    durationSec: Math.max(10, Math.floor(options.durationSec ?? 600)),
    tickMs: Math.max(250, Math.floor(options.tickMs ?? 1000)),
    initialBookWaitMs: Math.max(1000, Math.floor(options.initialBookWaitMs ?? 8000)),
    balanceSyncMs: Math.max(1000, Math.floor(options.balanceSyncMs ?? 5000)),
    interSessionPauseMs: Math.max(250, Math.floor(options.interSessionPauseMs ?? 1500)),
    maxMarkets: Math.max(0, Math.floor(options.maxMarkets ?? 0)),
    dailyBudgetStorePath: options.dailyBudgetStorePath ?? "",
  };

  const startedAt = Math.floor(Date.now() / 1000);
  const sessions: ContinuousBotDaemonReport["sessions"] = [];
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  const wallet = resolveConfiguredFunderAddress(env);
  const traceLogger = new JsonlTraceLogger(env, {
    runId: `daemon-${startedAt}`,
    source: "continuous_daemon",
    botMode: env.BOT_MODE,
    dryRun: env.DRY_RUN,
  });
  const persistedBudget = stateStore.loadRiskBudget({
    wallet,
    now: new Date(startedAt * 1000),
  });
  let dailyNegativeEdgeSpentUsdc = Math.max(
    0,
    Number(options.initialDailyNegativeEdgeSpentUsdc ?? persistedBudget.dailyNegativeSpentUsdc),
  );
  const initialDailyNegativeEdgeSpentUsdc = dailyNegativeEdgeSpentUsdc;
  stateStore.upsertRiskBudget({
    wallet,
    dailyNegativeSpentUsdc: dailyNegativeEdgeSpentUsdc,
    now: new Date(startedAt * 1000),
  });
  stateStore.recordMarketRollover({
    status: "daemon_start",
    timestamp: startedAt,
    payload: {
      initialDailyNegativeEdgeSpentUsdc,
    },
  });
  await traceLogger.write("market_rollover", {
    status: "daemon_start",
    startedAt,
    stateDbPath: config.stateStorePath,
    initialDailyNegativeEdgeSpentUsdc,
  });

  while (resolvedOptions.maxMarkets === 0 || sessions.length < resolvedOptions.maxMarkets) {
    const report = await runStatefulBotSession(env, {
      durationSec: resolvedOptions.durationSec,
      tickMs: resolvedOptions.tickMs,
      initialBookWaitMs: resolvedOptions.initialBookWaitMs,
      balanceSyncMs: resolvedOptions.balanceSyncMs,
      marketSelection: "auto",
      initialDailyNegativeEdgeSpentUsdc: dailyNegativeEdgeSpentUsdc,
    });

    sessions.push({
      market: report.market,
      summary: report.summary,
      finalState: report.finalState,
    });
    await traceLogger.write("market_rollover", {
      status: "market_completed",
      marketSlug: report.market.slug,
      conditionId: report.market.conditionId,
      startedAt: report.summary.startedAt,
      endedAt: report.summary.endedAt,
      finalDailyNegativeEdgeSpentUsdc: report.finalState.finalDailyNegativeEdgeSpentUsdc,
    });
    dailyNegativeEdgeSpentUsdc = report.finalState.finalDailyNegativeEdgeSpentUsdc;
    stateStore.upsertRiskBudget({
      wallet,
      dailyNegativeSpentUsdc: dailyNegativeEdgeSpentUsdc,
      marketSlug: report.market.slug,
      marketNegativeSpentUsdc: report.finalState.negativePairEdgeConsumedUsdc,
      now: new Date(report.summary.endedAt * 1000),
    });
    stateStore.recordMarketRollover({
      status: "market_completed",
      timestamp: report.summary.endedAt,
      marketSlug: report.market.slug,
      conditionId: report.market.conditionId,
      payload: {
        finalDailyNegativeEdgeSpentUsdc: report.finalState.finalDailyNegativeEdgeSpentUsdc,
      },
    });

    if (resolvedOptions.maxMarkets !== 0 && sessions.length >= resolvedOptions.maxMarkets) {
      break;
    }

    await sleep(resolvedOptions.interSessionPauseMs);
  }

  const payload: ContinuousBotDaemonReport = {
    runtime: {
      mode: "live-daemon",
      maxMarkets: resolvedOptions.maxMarkets,
      requestedDurationSec: resolvedOptions.durationSec,
      tickMs: resolvedOptions.tickMs,
      initialBookWaitMs: resolvedOptions.initialBookWaitMs,
      balanceSyncMs: resolvedOptions.balanceSyncMs,
      interSessionPauseMs: resolvedOptions.interSessionPauseMs,
      stateDbPath: config.stateStorePath,
    },
    summary: {
      startedAt,
      endedAt: Math.floor(Date.now() / 1000),
      marketsCompleted: sessions.length,
      initialDailyNegativeEdgeSpentUsdc,
      finalDailyNegativeEdgeSpentUsdc: dailyNegativeEdgeSpentUsdc,
    },
    sessions,
  };

  await traceLogger.write("market_rollover", {
    status: "daemon_end",
    endedAt: payload.summary.endedAt,
    marketsCompleted: sessions.length,
    finalDailyNegativeEdgeSpentUsdc: dailyNegativeEdgeSpentUsdc,
  });
  stateStore.recordMarketRollover({
    status: "daemon_end",
    timestamp: payload.summary.endedAt,
    payload: {
      marketsCompleted: sessions.length,
      finalDailyNegativeEdgeSpentUsdc: dailyNegativeEdgeSpentUsdc,
    },
  });
  await traceLogger.flush();
  stateStore.close();
  await writeStructuredLog("orders", { event: "bot_live_daemon", ...payload });
  return payload;
}
