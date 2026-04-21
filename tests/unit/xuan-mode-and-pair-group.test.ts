import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { applyPairOrderType, createPairOrderGroup, resolvePairOrderGroupStatus } from "../../src/execution/pairOrderGroup.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { chooseInventoryAdjustment } from "../../src/strategy/xuan5m/completionEngine.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { OrderBookState } from "../../src/strategy/xuan5m/orderBookState.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      ...overrides,
    }),
  );
}

function buildBook(
  assetId: string,
  market: string,
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
) {
  return {
    market,
    assetId,
    timestamp: 1713696010,
    bids,
    asks,
    minOrderSize: 5,
    tickSize: 0.01,
    negRisk: false,
  };
}

describe("xuan mode and pair order groups", () => {
  it("rejects soft-negative completion in strict mode", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 36.8;
    state.downShares = 20;
    state.downCost = 9.2;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.537, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "STRICT",
      }),
      state,
      books,
      { secsToClose: 60 },
    );

    expect(adjustment).toBeNull();
  });

  it("allows soft-negative completion in xuan mode when imbalance is meaningful", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 80;
    state.upCost = 36.8;
    state.downShares = 20;
    state.downCost = 9.2;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.45, size: 200 }], [{ price: 0.46, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.537, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
      }),
      state,
      books,
      { secsToClose: 60 },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 60,
      capMode: "soft",
    });
    expect(adjustment?.completion?.negativeEdgeUsdc).toBeGreaterThan(0);
  });

  it("allows emergency completion in xuan mode for small hard-imbalance clips", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    state.upShares = 70;
    state.upCost = 34.3;

    const books = new OrderBookState(
      buildBook(market.tokens.UP.tokenId, market.conditionId, [{ price: 0.48, size: 200 }], [{ price: 0.49, size: 200 }]),
      buildBook(
        market.tokens.DOWN.tokenId,
        market.conditionId,
        [{ price: 0.54, size: 200 }],
        [{ price: 0.55, size: 200 }],
      ),
    );

    const adjustment = chooseInventoryAdjustment(
      buildConfig({
        BOT_MODE: "XUAN",
        PARTIAL_COMPLETION_FRACTIONS: "0.4,0.2",
      }),
      state,
      books,
      { secsToClose: 45 },
    );

    expect(adjustment?.completion).toMatchObject({
      sideToBuy: "DOWN",
      missingShares: 28,
      capMode: "emergency",
    });
    expect(adjustment?.completion?.negativeEdgeUsdc).toBeGreaterThan(1);
  });

  it("assigns paired order type by mode and tracks partial/both-filled status", () => {
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const strictGroup = createPairOrderGroup({
      conditionId: market.conditionId,
      marketSlug: market.slug,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 20,
      maxUpPrice: 0.48,
      maxDownPrice: 0.49,
      mode: "STRICT",
      createdAt: 1713696010,
      state,
    });
    const xuanGroup = createPairOrderGroup({
      conditionId: market.conditionId,
      marketSlug: market.slug,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 20,
      maxUpPrice: 0.48,
      maxDownPrice: 0.49,
      mode: "XUAN",
      createdAt: 1713696010,
      state,
    });

    const groupedEntries = applyPairOrderType(
      [
        {
          side: "UP",
          size: 20,
          reason: "balanced_pair_seed",
          expectedAveragePrice: 0.48,
          effectivePricePerShare: 0.4979712,
          pairCostWithFees: 0.9959424,
          order: {
            tokenId: market.tokens.UP.tokenId,
            side: "BUY",
            amount: 20,
            price: 0.48,
            orderType: "FAK",
            userUsdcBalance: 20,
          },
        },
        {
          side: "DOWN",
          size: 20,
          reason: "balanced_pair_seed",
          expectedAveragePrice: 0.49,
          effectivePricePerShare: 0.5079928,
          pairCostWithFees: 0.9959424,
          order: {
            tokenId: market.tokens.DOWN.tokenId,
            side: "BUY",
            amount: 20,
            price: 0.49,
            orderType: "FAK",
            userUsdcBalance: 20,
          },
        },
      ],
      strictGroup,
    );

    expect(strictGroup.orderType).toBe("FOK");
    expect(xuanGroup.orderType).toBe("FAK");
    expect(groupedEntries.map((entry) => entry.order.orderType)).toEqual(["FOK", "FOK"]);
    expect(groupedEntries.every((entry) => entry.order.metadata?.startsWith(`${strictGroup.groupId}:`))).toBe(true);

    state.upShares = 20;
    expect(resolvePairOrderGroupStatus(xuanGroup, state)).toBe("UP_ONLY");
    state.downShares = 20;
    expect(resolvePairOrderGroupStatus(xuanGroup, state)).toBe("BOTH_FILLED");
  });
});
