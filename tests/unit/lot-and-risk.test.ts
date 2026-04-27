import { describe, expect, it } from "vitest";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";
import { chooseLot } from "../../src/strategy/xuan5m/lotLadder.js";
import { evaluateRisk } from "../../src/strategy/xuan5m/riskEngine.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { applyFill } from "../../src/strategy/xuan5m/inventoryState.js";

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
    ).toBe(5);
  });

  it("uses the clipped mid lot early in live bankroll-adjusted mode", () => {
    expect(
      chooseLot(config, {
        dryRunOrSmallLive: false,
        secsFromOpen: 20,
        imbalance: 0,
        bookDepthGood: true,
        pairCostWithinCap: true,
        pairCostComfortable: true,
        inventoryBalanced: true,
        recentBothSidesFilled: false,
        marketVolumeHigh: true,
        pnlTodayPositive: false,
      }),
    ).toBe(10);
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

  it("switches to no-new-entry but keeps completion-only active under low collateral", () => {
    const state = createMarketState(buildOfflineMarket(1713696000));
    const risk = evaluateRisk(config, state, {
      secsToClose: 120,
      staleBookMs: 100,
      balanceStaleMs: 100,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 12,
    });

    expect(risk.tradable).toBe(true);
    expect(risk.allowNewEntries).toBe(false);
    expect(risk.completionOnly).toBe(true);
    expect(risk.reasons).toContain("low_usdc_no_new_entry");
  });

  it("keeps new entries open for balanced debt campaign repair after normal entry cutoff", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 40,
      price: 0.56,
      timestamp: market.startTs + 1,
      makerTaker: "taker",
      executionMode: "TEMPORAL_SINGLE_LEG_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 40,
      price: 0.5,
      timestamp: market.startTs + 2,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });

    const risk = evaluateRisk(xuanConfig, state, {
      secsToClose: 41,
      staleBookMs: 100,
      balanceStaleMs: 100,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    });

    expect(risk.completionOnly).toBe(false);
    expect(risk.allowNewEntries).toBe(true);
  });

  it("expands public-footprint limits under aggressive xuan clone intensity", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
    );

    expect(xuanConfig.xuanBaseLotLadder).toEqual([80, 100, 125, 145]);
    expect(xuanConfig.maxMarketExposureShares).toBeGreaterThanOrEqual(4200);
    expect(xuanConfig.maxMarketSharesPerSide).toBeGreaterThanOrEqual(4200);
    expect(xuanConfig.maxOneSidedExposureShares).toBeGreaterThanOrEqual(1800);
    expect(xuanConfig.maxNegativeDailyBudgetUsdc).toBeGreaterThanOrEqual(180);
    expect(xuanConfig.maxBuysPerSide).toBeGreaterThanOrEqual(16);
    expect(xuanConfig.maxCyclesPerMarket).toBeGreaterThanOrEqual(14);
    expect(xuanConfig.maxConsecutiveSingleLegSeedsPerSide).toBeGreaterThanOrEqual(3);
    expect(xuanConfig.allowNewPairInLast30S).toBe(true);
    expect(xuanConfig.allowSingleLegSeedInLast60S).toBe(true);
    expect(xuanConfig.finalWindowCompletionOnlySec).toBe(10);
    expect(xuanConfig.finalWindowNoChaseSec).toBe(5);
    expect(xuanConfig.allowAnyNewBuyInLast10S).toBe(false);
    expect(xuanConfig.xuanRhythmMinWaitSec).toBeGreaterThanOrEqual(4);
    expect(xuanConfig.xuanRhythmMaxWaitSec).toBeLessThanOrEqual(12);
    expect(xuanConfig.priceToBeatLateStartFallbackEnabled).toBe(true);
    expect(xuanConfig.freshSeedHardCutoffSec).toBeGreaterThanOrEqual(285);
    expect(xuanConfig.campaignLaunchXuanProbePct).toBeGreaterThanOrEqual(1);
    expect(xuanConfig.campaignLaunchXuanProbeMaxDebtUsdc).toBeGreaterThanOrEqual(8);
    expect(xuanConfig.campaignLaunchXuanProbeMaxAgeSec).toBeGreaterThanOrEqual(285);
  });

  it("does not flag moderate recycle imbalance as a risk reason in aggressive public-footprint mode", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 115,
      price: 0.52,
      timestamp: market.startTs + 5,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 107,
      price: 0.49,
      timestamp: market.startTs + 6,
      makerTaker: "taker",
      executionMode: "XUAN_HARD_PAIR_SWEEP",
    });

    const risk = evaluateRisk(xuanConfig, state, {
      secsToClose: 120,
      staleBookMs: 100,
      balanceStaleMs: 100,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    });

    expect(risk.reasons).not.toContain("rebalance_imbalance");
    expect(risk.allowNewEntries).toBe(true);
  });
});
