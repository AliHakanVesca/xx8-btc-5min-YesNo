import { describe, expect, it } from "vitest";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";
import { chooseLot } from "../../src/strategy/xuan5m/lotLadder.js";
import { evaluateRisk } from "../../src/strategy/xuan5m/riskEngine.js";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";
import { applyFill, applyMerge } from "../../src/strategy/xuan5m/inventoryState.js";
import {
  xuanConfiguredFreshStagedSeedMinLot,
  xuanConfiguredMicroLot,
} from "../../src/strategy/xuan5m/xuanLotFamilyClassifier.js";

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
    ).toBe(8);
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

  it("keeps post-merge xuan recycle open when low collateral still funds the smallest pair", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        XUAN_BASE_LOT_LADDER: "5,8,12,15",
        LIVE_SMALL_LOT_LADDER: "5,8,12,15",
        MIN_USDC_BALANCE_FOR_NEW_ENTRY: "12",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 15,
      price: 0.48,
      timestamp: market.startTs + 4,
      makerTaker: "taker",
      executionMode: "PAIRGROUP_COVERED_SEED",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 15,
      price: 0.48,
      timestamp: market.startTs + 8,
      makerTaker: "taker",
      executionMode: "PARTIAL_FAST_COMPLETION",
    });
    state = applyMerge(state, {
      amount: 14.99,
      timestamp: market.startTs + 35,
      simulated: true,
    });

    const risk = evaluateRisk(xuanConfig, state, {
      secsToClose: 120,
      staleBookMs: 100,
      balanceStaleMs: 100,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 8,
    });

    expect(risk.tradable).toBe(true);
    expect(risk.allowNewEntries).toBe(true);
    expect(risk.completionOnly).toBe(false);
    expect(risk.reasons).toContain("low_usdc_post_merge_recycle_allowed");
    expect(risk.reasons).not.toContain("low_usdc_no_new_entry");
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

    expect(xuanConfig.xuanBaseLotLadder).toEqual([60, 80, 145, 214, 265]);
    expect(xuanConfiguredFreshStagedSeedMinLot(xuanConfig)).toBe(40);
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
    expect(xuanConfig.maxMatchedAgeBeforeForcedMergeSec).toBeGreaterThanOrEqual(180);
    expect(xuanConfig.allowAnyNewBuyInLast10S).toBe(false);
    expect(xuanConfig.xuanRhythmMinWaitSec).toBeGreaterThanOrEqual(4);
    expect(xuanConfig.xuanRhythmMaxWaitSec).toBeLessThanOrEqual(12);
    expect(xuanConfig.priceToBeatLateStartFallbackEnabled).toBe(true);
    expect(xuanConfig.freshSeedHardCutoffSec).toBeGreaterThanOrEqual(285);
    expect(xuanConfig.campaignLaunchXuanProbePct).toBeGreaterThanOrEqual(1);
    expect(xuanConfig.campaignLaunchXuanProbeMaxDebtUsdc).toBeGreaterThanOrEqual(8);
    expect(xuanConfig.campaignLaunchXuanProbeMaxAgeSec).toBeGreaterThanOrEqual(285);
  });

  it("respects an explicit aggressive public-footprint bankroll ladder", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        XUAN_BASE_LOT_LADDER: "60,75,83,90",
        LIVE_SMALL_LOT_LADDER: "60,75,83,90",
        MAX_MARKET_EXPOSURE_SHARES: "190",
        MAX_MARKET_SHARES_PER_SIDE: "190",
        MAX_ONE_SIDED_EXPOSURE_SHARES: "95",
        MAX_CYCLES_PER_MARKET: "4",
        MAX_BUYS_PER_SIDE: "5",
        MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC: "12",
        MAX_NEGATIVE_EDGE_PER_MARKET_USDC: "12",
        ORPHAN_LEG_MAX_NOTIONAL_USDC: "88",
        MAX_MARKET_ORPHAN_USDC: "99",
        MAX_SINGLE_ORPHAN_QTY: "90",
      }),
    );

    expect(xuanConfig.xuanBaseLotLadder).toEqual([60, 75, 83, 90]);
    expect(xuanConfig.liveSmallLotLadder).toEqual([60, 75, 83, 90]);
    expect(xuanConfig.defaultLot).toBe(60);
    expect(xuanConfig.cloneChildPreferredShares).toBe(60);
    expect(xuanConfig.maxMarketExposureShares).toBe(190);
    expect(xuanConfig.maxMarketSharesPerSide).toBe(190);
    expect(xuanConfig.maxOneSidedExposureShares).toBe(95);
    expect(xuanConfig.maxCyclesPerMarket).toBe(4);
    expect(xuanConfig.maxBuysPerSide).toBe(5);
    expect(xuanConfig.maxNegativePairEdgePerMarketUsdc).toBeGreaterThanOrEqual(12);
    expect(xuanConfig.maxNegativePairEdgePerMarketUsdc).toBeLessThan(140);
    expect(xuanConfig.maxNegativeEdgePerMarketUsdc).toBeGreaterThanOrEqual(12);
    expect(xuanConfig.maxNegativeEdgePerMarketUsdc).toBeLessThan(140);
    expect(xuanConfig.orphanLegMaxNotionalUsdc).toBeGreaterThanOrEqual(88);
    expect(xuanConfig.orphanLegMaxNotionalUsdc).toBeLessThan(320);
    expect(xuanConfig.maxMarketOrphanUsdc).toBeGreaterThanOrEqual(99);
    expect(xuanConfig.maxMarketOrphanUsdc).toBeLessThan(650);
    expect(xuanConfig.maxSingleOrphanQty).toBe(90);
  });

  it("keeps explicit small aggressive public-footprint merge windows small", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        XUAN_BASE_LOT_LADDER: "5,8,12,15",
        LIVE_SMALL_LOT_LADDER: "5,8,12,15",
        MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC: "75",
      }),
    );

    expect(xuanConfig.xuanBaseLotLadder).toEqual([5, 8, 12, 15]);
    expect(xuanConfig.xuanMicroPairMaxQty).toBe(15);
    expect(xuanConfiguredMicroLot(xuanConfig)).toBe(15);
    expect(xuanConfiguredFreshStagedSeedMinLot(xuanConfig)).toBe(15);
    expect(xuanConfig.marketBasketMinMergeShares).toBe(15);
    expect(xuanConfig.marketBasketMergeTargetMaxShares).toBe(15);
    expect(xuanConfig.mergeBatchMode).toBe("IMMEDIATE");
    expect(xuanConfig.maxMatchedAgeBeforeForcedMergeSec).toBe(5);
    expect(xuanConfig.campaignLaunchVwapTiers).toEqual([15]);
  });

  it("uses a fixed five-share aggressive profile with immediate 5/5 merge targets", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        XUAN_BASE_LOT_LADDER: "5",
        LIVE_SMALL_LOT_LADDER: "5",
        DEFAULT_LOT: "5",
        MARKET_BASKET_MIN_MERGE_SHARES: "40",
        MARKET_BASKET_MERGE_TARGET_MULTIPLIER: "3",
        MARKET_BASKET_MERGE_TARGET_MAX_SHARES: "900",
        MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE: "2",
        MIN_FIRST_MATCHED_AGE_BEFORE_MERGE_SEC: "45",
        MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC: "75",
      }),
    );

    expect(xuanConfig.xuanBaseLotLadder).toEqual([5]);
    expect(xuanConfig.liveSmallLotLadder).toEqual([5]);
    expect(xuanConfig.lotLadder).toEqual([5]);
    expect(xuanConfig.xuanMicroPairMaxQty).toBe(5);
    expect(xuanConfiguredMicroLot(xuanConfig)).toBe(5);
    expect(xuanConfiguredFreshStagedSeedMinLot(xuanConfig)).toBe(5);
    expect(xuanConfig.xuanSoftSweepMaxQty).toBe(5);
    expect(xuanConfig.xuanHardSweepMaxQty).toBe(5);
    expect(xuanConfig.xuanPairSweepSoftCap).toBeCloseTo(1.006, 6);
    expect(xuanConfig.xuanPairSweepHardCap).toBeCloseTo(1.006, 6);
    expect(xuanConfig.marketBasketBootstrapMaxEffectivePair).toBeCloseTo(1.006, 6);
    expect(xuanConfig.coveredSeedMaxQty).toBe(5);
    expect(xuanConfig.singleLegSeedMaxQty).toBe(5);
    expect(xuanConfig.emergencyCompletionMaxQty).toBe(5);
    expect(xuanConfig.highSideEmergencyMaxQty).toBe(5);
    expect(xuanConfig.finalHardCompletionMaxQty).toBe(5);
    expect(xuanConfig.xuanBasketCampaignCompletionClipMaxQty).toBe(5);
    expect(xuanConfig.cloneChildPreferredShares).toBe(5);
    expect(xuanConfig.campaignLaunchVwapTiers).toEqual([5]);
    expect(xuanConfig.marketBasketMinMergeShares).toBe(5);
    expect(xuanConfig.marketBasketMergeTargetMultiplier).toBe(1);
    expect(xuanConfig.marketBasketMergeTargetMaxShares).toBe(5);
    expect(xuanConfig.mergeBatchMode).toBe("IMMEDIATE");
    expect(xuanConfig.minCompletedCyclesBeforeFirstMerge).toBe(1);
    expect(xuanConfig.minFirstMatchedAgeBeforeMergeSec).toBe(0);
    expect(xuanConfig.maxMatchedAgeBeforeForcedMergeSec).toBe(5);

    const lot = chooseLot(xuanConfig, {
      marketSlug: "btc-updown-5m-1777464000",
      dryRunOrSmallLive: false,
      secsFromOpen: 13,
      imbalance: 0,
      bookDepthGood: true,
      bestAskUp: 0.5,
      bestAskDown: 0.5,
      topTwoAskDepthMin: 1000,
      flatPosition: true,
      postMergeCount: 0,
      totalShares: 0,
      pairCostWithinCap: true,
      pairCostComfortable: true,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: false,
    });

    expect(lot).toBe(5);
  });

  it("caps public-footprint family lots to the configured ladder max", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        XUAN_BASE_LOT_LADDER: "5,8,12,15",
        LIVE_SMALL_LOT_LADDER: "5,8,12,15",
        DEFAULT_LOT: "5",
      }),
    );

    const lot = chooseLot(xuanConfig, {
      marketSlug: "btc-updown-5m-1777464000",
      dryRunOrSmallLive: false,
      secsFromOpen: 13,
      imbalance: 0,
      bookDepthGood: true,
      bestAskUp: 0.5,
      bestAskDown: 0.5,
      topTwoAskDepthMin: 1000,
      flatPosition: true,
      postMergeCount: 0,
      totalShares: 0,
      pairCostWithinCap: true,
      pairCostComfortable: true,
      inventoryBalanced: true,
      recentBothSidesFilled: false,
      marketVolumeHigh: true,
      pnlTodayPositive: false,
    });

    expect(lot).toBe(15);
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

  it("does not force completion-only for managed xuan high-low recycle imbalance", () => {
    const xuanConfig = buildStrategyConfig(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_MODE: "XUAN",
        XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
        XUAN_CLONE_INTENSITY: "AGGRESSIVE",
        LIVE_SMALL_LOT_LADDER: "80,100,125,145",
      }),
    );
    const market = buildOfflineMarket(1713696000);
    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      size: 125,
      price: 0.38,
      timestamp: market.startTs + 80,
      makerTaker: "taker",
      executionMode: "PARTIAL_SOFT_COMPLETION",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      size: 95,
      price: 0.58,
      timestamp: market.startTs + 81,
      makerTaker: "taker",
      executionMode: "HIGH_LOW_COMPLETION_CHASE",
    });

    const risk = evaluateRisk(xuanConfig, state, {
      secsToClose: 24,
      staleBookMs: 100,
      balanceStaleMs: 100,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    });

    expect(risk.reasons).not.toContain("rebalance_imbalance");
    expect(risk.completionOnly).toBe(false);
  });
});
