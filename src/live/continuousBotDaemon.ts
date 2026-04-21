import type { AppEnv } from "../config/schema.js";
import { writeStructuredLog } from "../observability/logger.js";
import { runStatefulBotSession, type BotSessionOptions, type BotSessionReport } from "./statefulBotSession.js";

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
  };
  summary: {
    startedAt: number;
    endedAt: number;
    marketsCompleted: number;
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
  };

  const startedAt = Math.floor(Date.now() / 1000);
  const sessions: ContinuousBotDaemonReport["sessions"] = [];

  while (resolvedOptions.maxMarkets === 0 || sessions.length < resolvedOptions.maxMarkets) {
    const report = await runStatefulBotSession(env, {
      durationSec: resolvedOptions.durationSec,
      tickMs: resolvedOptions.tickMs,
      initialBookWaitMs: resolvedOptions.initialBookWaitMs,
      balanceSyncMs: resolvedOptions.balanceSyncMs,
      marketSelection: "auto",
    });

    sessions.push({
      market: report.market,
      summary: report.summary,
      finalState: report.finalState,
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
    },
    summary: {
      startedAt,
      endedAt: Math.floor(Date.now() / 1000),
      marketsCompleted: sessions.length,
    },
    sessions,
  };

  await writeStructuredLog("orders", { event: "bot_live_daemon", ...payload });
  return payload;
}
