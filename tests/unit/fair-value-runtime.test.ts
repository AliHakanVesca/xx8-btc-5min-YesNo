import { describe, expect, it } from "vitest";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";
import type { MarketInfo } from "../../src/infra/clob/types.js";
import type { BtcPriceFeed } from "../../src/infra/ws/btcPriceFeed.js";
import { MarketFairValueRuntime } from "../../src/live/fairValueRuntime.js";
import type { PersistentStateStore } from "../../src/live/persistentStateStore.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv(
      {
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        ...overrides,
      },
      { enforceLiveRequirements: false },
    ),
  );
}

function buildMarket(startTs: number): MarketInfo {
  return {
    slug: "btc-updown-5m-test",
    conditionId: "0xtest",
    startTs,
    endTs: startTs + 300,
    tickSize: 0.01,
    minOrderSize: 5,
    feeRate: 0,
    feesEnabled: false,
    negRisk: true,
    tokens: {
      UP: { tokenId: "up", outcome: "UP", label: "Up" },
      DOWN: { tokenId: "down", outcome: "DOWN", label: "Down" },
    },
    source: "fallback",
  };
}

function buildPriceFeed(timestampMs: number): BtcPriceFeed {
  return {
    snapshot: () => ({
      primary: { source: "rtds", price: 78_000, timestampMs },
      secondary: undefined,
      history: [],
    }),
  } as unknown as BtcPriceFeed;
}

function buildStateStore(recorded: unknown[]): PersistentStateStore {
  return {
    loadLatestPriceSnapshot: () => undefined,
    recordPriceSnapshot: (snapshot: unknown) => {
      recorded.push(snapshot);
    },
  } as unknown as PersistentStateStore;
}

describe("fair value runtime", () => {
  it("captures a late-start threshold only when fallback is explicitly enabled", () => {
    const nowMs = Date.now();
    const disabledRecords: unknown[] = [];
    const disabledRuntime = new MarketFairValueRuntime(
      buildConfig({ PRICE_TO_BEAT_LATE_START_FALLBACK_ENABLED: "false" }),
      buildMarket(0),
      buildStateStore(disabledRecords),
      buildPriceFeed(nowMs),
    );

    disabledRuntime.evaluate(50);
    expect(disabledRecords).not.toContainEqual(expect.objectContaining({ kind: "threshold" }));

    const enabledRecords: unknown[] = [];
    const enabledRuntime = new MarketFairValueRuntime(
      buildConfig({
        PRICE_TO_BEAT_LATE_START_FALLBACK_ENABLED: "true",
        PRICE_TO_BEAT_LATE_START_MAX_MARKET_AGE_SEC: "90",
      }),
      buildMarket(0),
      buildStateStore(enabledRecords),
      buildPriceFeed(nowMs),
    );

    enabledRuntime.evaluate(50);

    expect(enabledRecords).toContainEqual(
      expect.objectContaining({
        kind: "threshold",
        source: "late_estimated",
        estimatedThreshold: true,
        note: "late_captured_50000ms_after_start",
      }),
    );
  });
});
