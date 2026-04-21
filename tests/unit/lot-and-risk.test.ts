import { describe, expect, it } from "vitest";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";
import { chooseLot } from "../../src/strategy/xuan5m/lotLadder.js";
import { evaluateRisk } from "../../src/strategy/xuan5m/riskEngine.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";

describe("lot ladder and risk windows", () => {
  const config = buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    }),
  );

  it("uses live-small lot in dry mode", () => {
    expect(
      chooseLot(config, {
        dryRunOrSmallLive: true,
        secsFromOpen: 10,
        imbalance: 0,
        bookDepthGood: true,
        pairCostWithinCap: true,
        pairCostComfortable: true,
        inventoryBalanced: true,
        recentBothSidesFilled: true,
        marketVolumeHigh: true,
        pnlTodayPositive: true,
      }),
    ).toBe(20);
  });

  it("moves to completion-only late in the window", () => {
    const state = createMarketState(buildOfflineMarket(1713696000));
    const risk = evaluateRisk(config, state, {
      secsToClose: 15,
      staleBookMs: 100,
      balanceStaleMs: 100,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    });

    expect(risk.completionOnly).toBe(true);
    expect(risk.allowNewEntries).toBe(false);
  });
});
