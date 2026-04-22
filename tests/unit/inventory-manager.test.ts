import { describe, expect, it } from "vitest";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";
import type { InventorySnapshot } from "../../src/live/inventoryManager.js";
import { buildInventoryActionPlan } from "../../src/live/inventoryManager.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      ...overrides,
    }),
  );
}

describe("inventory manager", () => {
  it("blocks new entries when unknown inventory exists above dust threshold", () => {
    const snapshot: InventorySnapshot = {
      walletAddress: "0xeb724b33cb2d2f886989f035db9ab304a1d248ba",
      nowTs: 1776846000,
      previousSlug: "btc-updown-5m-1776845100",
      currentSlug: "btc-updown-5m-1776845400",
      nextSlug: "btc-updown-5m-1776845700",
      markets: [
        {
          slug: "some-other-market",
          conditionId: "0xunknown",
          relation: "unknown",
          knownBtc5m: false,
          resolved: false,
          redeemable: false,
          upShares: 3,
          downShares: 0,
          totalShares: 3,
          mergeable: 0,
          residualUp: 3,
          residualDown: 0,
          imbalanceRatio: 1,
          positions: [],
        },
      ],
      unknownMarkets: [
        {
          slug: "some-other-market",
          conditionId: "0xunknown",
          relation: "unknown",
          knownBtc5m: false,
          resolved: false,
          redeemable: false,
          upShares: 3,
          downShares: 0,
          totalShares: 3,
          mergeable: 0,
          residualUp: 3,
          residualDown: 0,
          imbalanceRatio: 1,
          positions: [],
        },
      ],
    };

    const plan = buildInventoryActionPlan(snapshot, buildConfig());

    expect(plan.blockNewEntries).toBe(true);
    expect(plan.blockReasons).toContain("unknown_inventory:some-other-market");
  });

  it("plans redeem for resolved btc 5m inventory and merge for unresolved matched inventory", () => {
    const snapshot: InventorySnapshot = {
      walletAddress: "0xeb724b33cb2d2f886989f035db9ab304a1d248ba",
      nowTs: 1776846000,
      previousSlug: "btc-updown-5m-1776845100",
      currentSlug: "btc-updown-5m-1776845400",
      nextSlug: "btc-updown-5m-1776845700",
      currentMarket: {
        slug: "btc-updown-5m-1776845400",
        conditionId: "0xcurrent",
        relation: "current",
        knownBtc5m: true,
        startTs: 1776845400,
        endTs: 1776845700,
        resolved: false,
        redeemable: false,
        upShares: 12,
        downShares: 10,
        totalShares: 22,
        mergeable: 10,
        residualUp: 2,
        residualDown: 0,
        imbalanceRatio: 0.090909,
        positions: [],
      },
      markets: [
        {
          slug: "btc-updown-5m-1776845400",
          conditionId: "0xcurrent",
          relation: "current",
          knownBtc5m: true,
          startTs: 1776845400,
          endTs: 1776845700,
          resolved: false,
          redeemable: false,
          upShares: 12,
          downShares: 10,
          totalShares: 22,
          mergeable: 10,
          residualUp: 2,
          residualDown: 0,
          imbalanceRatio: 0.090909,
          positions: [],
        },
        {
          slug: "btc-updown-5m-1776844800",
          conditionId: "0xresolved",
          relation: "historical",
          knownBtc5m: true,
          startTs: 1776844800,
          endTs: 1776845100,
          resolved: true,
          redeemable: true,
          upShares: 8,
          downShares: 0,
          totalShares: 8,
          mergeable: 0,
          residualUp: 8,
          residualDown: 0,
          imbalanceRatio: 1,
          positions: [],
        },
      ],
      unknownMarkets: [],
    };

    const plan = buildInventoryActionPlan(
      snapshot,
      buildConfig({
        HARD_IMBALANCE_RATIO: "0.05",
      }),
    );

    expect(plan.redeem).toHaveLength(1);
    expect(plan.redeem[0]).toMatchObject({
      conditionId: "0xresolved",
      type: "redeem",
    });
    expect(plan.merge).toHaveLength(1);
    expect(plan.merge[0]).toMatchObject({
      conditionId: "0xcurrent",
      type: "merge",
      amount: 10,
    });
    expect(plan.blockNewEntries).toBe(true);
    expect(plan.blockReasons).toContain("current_market_hard_imbalance:btc-updown-5m-1776845400");
  });
});
