import { describe, expect, it } from "vitest";
import { buildLivePaperSample, buildLivePaperTick, summarizeLivePaperSamples } from "../../src/analytics/livePaper.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { createMergeBatchTracker } from "../../src/strategy/xuan5m/mergeCoordinator.js";

function buildBook(assetId: string, market: string, bid: number, ask: number, timestamp: number) {
  return {
    market,
    assetId,
    timestamp,
    bids: [{ price: bid, size: 180 }],
    asks: [{ price: ask, size: 180 }],
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
  };
}

describe("live paper analytics", () => {
  it("builds a live paper sample with entry-buy-first decision when books are fresh", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    });
    const market = buildOfflineMarket(1713696000);
    const nowTs = market.startTs + 20;
    const sample = buildLivePaperSample({
      env,
      market,
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(sample.hasBooks).toBe(true);
    expect(sample.allowNewEntries).toBe(true);
    expect(sample.entryBuyCount).toBe(2);
    expect(sample.balancedPairEntryCount).toBe(2);
    expect(sample.laggingRebalanceCount).toBe(0);
    expect(sample.buyShares).toBe(10);
    expect(sample.buyNotional).toBeCloseTo(4.8, 8);
    expect(sample.mergeShares).toBe(5);
    expect(sample.pairTakerCost).toBeLessThan(1);
  });

  it("summarizes live paper samples", () => {
    const summary = summarizeLivePaperSamples({
      marketSlug: "btc-updown-5m-1713696000",
      configuredDurationSec: 20,
      startedAt: 1713696000,
      endedAt: 1713696018,
      samples: [
        {
          timestamp: 1713696005,
          phase: "ENTRY",
          secsToClose: 295,
          hasBooks: true,
          entryBuyCount: 2,
          balancedPairEntryCount: 2,
          laggingRebalanceCount: 0,
          buyShares: 40,
          buyNotional: 19.2,
          hasCompletion: false,
          hasUnwind: false,
          mergeShares: 20,
          allowNewEntries: true,
          completionOnly: false,
          hardCancel: false,
          riskReasons: [],
          pairAskSum: 0.96,
          pairTakerCost: 0.9959424,
          pairEdge: 0.0040576,
        },
        {
          timestamp: 1713696015,
          phase: "HARD_CANCEL",
          secsToClose: 8,
          hasBooks: true,
          entryBuyCount: 0,
          balancedPairEntryCount: 0,
          laggingRebalanceCount: 0,
          buyShares: 0,
          buyNotional: 0,
          hasCompletion: false,
          hasUnwind: false,
          mergeShares: 0,
          allowNewEntries: false,
          completionOnly: true,
          hardCancel: true,
          riskReasons: [],
          pairAskSum: 1,
          pairTakerCost: 1.036,
          pairEdge: -0.036,
        },
      ],
    });

    expect(summary).toMatchObject({
      marketSlug: "btc-updown-5m-1713696000",
      sampleCount: 2,
      samplesWithBooks: 2,
      entryBuyReadyCount: 1,
      balancedPairReadyCount: 1,
      laggingRebalanceReadyCount: 0,
      completionOnlyCount: 1,
      hardCancelCount: 1,
      averageBuyShares: 20,
      averageBuyNotional: 9.6,
    });
    expect(summary.bestPairEdge).toBeCloseTo(0.0040576, 8);
    expect(summary.worstPairEdge).toBeCloseTo(-0.036, 8);
  });

  it("does not mark preopen next-market books as entry-ready", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    });
    const market = buildOfflineMarket(1713696300);
    const nowTs = market.startTs - 20;
    const sample = buildLivePaperSample({
      env,
      market,
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(sample.phase).toBe("PREOPEN");
    expect(sample.entryBuyCount).toBe(0);
    expect(sample.allowNewEntries).toBe(false);
    expect(sample.hardCancel).toBe(true);
    expect(sample.riskReasons).toEqual(["preopen"]);
  });

  it("applies simulated live-paper fills to state without sending orders", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      MERGE_BATCH_MODE: "HYBRID_DELAYED",
    });
    const config = buildStrategyConfig(env);
    const market = buildOfflineMarket(1713696000);
    const nowTs = market.startTs + 20;
    const tick = buildLivePaperTick({
      config,
      market,
      state: createMarketState(market),
      mergeTracker: createMergeBatchTracker(),
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(tick.executions).toHaveLength(2);
    expect(tick.executions.every((execution) => execution.status === "filled")).toBe(true);
    expect(tick.sample.simulatedFillCount).toBe(2);
    expect(tick.sample.simulatedBuyShares).toBe(10);
    expect(tick.stateAfter.upShares).toBe(5);
    expect(tick.stateAfter.downShares).toBe(5);
    expect(tick.merge?.status).toBe("skipped");
  });

  it("records simulated merge when the configured merge gate allows it", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      MERGE_BATCH_MODE: "IMMEDIATE",
      MERGE_DUST_LEAVE_SHARES: "0",
    });
    const config = buildStrategyConfig(env);
    const market = buildOfflineMarket(1713696000);
    const nowTs = market.startTs + 20;
    const tick = buildLivePaperTick({
      config,
      market,
      state: createMarketState(market),
      mergeTracker: createMergeBatchTracker(),
      nowTs,
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.47, 0.48, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.47, 0.48, nowTs),
    });

    expect(tick.merge).toMatchObject({ status: "merged", mergedShares: 5 });
    expect(tick.sample.simulatedMergeShares).toBe(5);
    expect(tick.stateAfter.upShares).toBe(0);
    expect(tick.stateAfter.downShares).toBe(0);
    expect(tick.stateAfter.mergeCount).toBe(1);
  });
});
