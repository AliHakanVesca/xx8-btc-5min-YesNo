import { describe, expect, it } from "vitest";
import { buildLivePaperSample, summarizeLivePaperSamples } from "../../src/analytics/livePaper.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { parseEnv } from "../../src/config/env.js";

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
      upBook: buildBook(market.tokens.UP.tokenId, market.conditionId, 0.48, 0.49, nowTs),
      downBook: buildBook(market.tokens.DOWN.tokenId, market.conditionId, 0.48, 0.49, nowTs),
    });

    expect(sample.hasBooks).toBe(true);
    expect(sample.allowNewEntries).toBe(true);
    expect(sample.entryBuyCount).toBe(2);
    expect(sample.makerOrderCount).toBe(0);
    expect(sample.buyShares).toBe(60);
    expect(sample.buyNotional).toBeCloseTo(29.4, 8);
    expect(sample.quotedShares).toBe(0);
    expect(sample.mergeShares).toBe(30);
    expect(sample.pairTakerCost).toBeGreaterThan(1);
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
          makerOrderCount: 0,
          buyShares: 60,
          buyNotional: 29.4,
          quotedShares: 0,
          quotedNotional: 0,
          hasCompletion: false,
          hasUnwind: false,
          mergeShares: 30,
          allowNewEntries: true,
          completionOnly: false,
          hardCancel: false,
          riskReasons: [],
          pairAskSum: 0.98,
          pairTakerCost: 1.0159856,
          pairEdge: -0.0159856,
        },
        {
          timestamp: 1713696015,
          phase: "HARD_CANCEL",
          secsToClose: 8,
          hasBooks: true,
          entryBuyCount: 0,
          makerOrderCount: 0,
          buyShares: 0,
          buyNotional: 0,
          quotedShares: 0,
          quotedNotional: 0,
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
      makerReadyCount: 0,
      completionOnlyCount: 1,
      hardCancelCount: 1,
      averageBuyShares: 30,
      averageBuyNotional: 14.7,
      averageQuotedShares: 0,
      averageQuotedNotional: 0,
    });
    expect(summary.bestPairEdge).toBeCloseTo(-0.0159856, 8);
    expect(summary.worstPairEdge).toBeCloseTo(-0.036, 8);
  });
});
