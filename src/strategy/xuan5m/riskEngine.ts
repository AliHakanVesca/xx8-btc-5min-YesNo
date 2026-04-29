import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { imbalance, matchedEffectivePairCost, mergeableShares } from "./inventoryState.js";
import type { XuanMarketState } from "./marketState.js";

export interface RiskContext {
  secsToClose: number;
  staleBookMs: number;
  balanceStaleMs: number;
  bookIsCrossed: boolean;
  dailyLossUsdc: number;
  marketLossUsdc: number;
  usdcBalance: number;
  forceNoNewEntries?: boolean;
  forceCompletionOnly?: boolean;
  forceSafeHalt?: boolean;
  externalReasons?: string[];
}

export interface RiskEvaluation {
  tradable: boolean;
  allowNewEntries: boolean;
  completionOnly: boolean;
  hardCancel: boolean;
  reasons: string[];
}

export function evaluateRisk(
  config: XuanStrategyConfig,
  state: XuanMarketState,
  ctx: RiskContext,
): RiskEvaluation {
  const blockingReasons: string[] = [];
  const advisoryReasons: string[] = [];
  const currentImbalance = imbalance(state);
  const externalReasons = ctx.externalReasons ?? [];
  const aggressivePublicFootprint =
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanCloneIntensity === "AGGRESSIVE";
  const xuanRecycleImbalanceThreshold = aggressivePublicFootprint
    ? Math.max(config.maxImbalanceFrac, config.hardImbalanceRatio)
    : config.maxImbalanceFrac;
  if (ctx.forceSafeHalt) {
    return {
      tradable: false,
      allowNewEntries: false,
      completionOnly: false,
      hardCancel: true,
      reasons: ["safe_halt", ...externalReasons],
    };
  }
  const lowBalanceForNewEntry = ctx.usdcBalance < config.minUsdcBalanceForNewEntry;
  const lowBalanceForCompletion = ctx.usdcBalance < config.minUsdcBalanceForCompletion;
  const completionAllowedUnderLowBalance =
    config.lowCollateralMode === "NO_NEW_ENTRY_BUT_MANAGE" &&
    config.allowCompletionUnderMinBalance &&
    !lowBalanceForCompletion;

  if (ctx.staleBookMs > 2000) blockingReasons.push("book_stale");
  if (ctx.balanceStaleMs > 5000) blockingReasons.push("balance_stale");
  if (ctx.bookIsCrossed) blockingReasons.push("crossed_book");
  if (ctx.dailyLossUsdc >= config.dailyMaxLossUsdc) blockingReasons.push("daily_loss_limit");
  if (ctx.marketLossUsdc >= config.marketMaxLossUsdc) blockingReasons.push("market_loss_limit");
  const matchedShares = mergeableShares(state);
  const shareGap = Math.abs(state.upShares - state.downShares);
  const xuanManagedRecycleResidual =
    aggressivePublicFootprint &&
    ctx.secsToClose > config.finalWindowNoChaseSec &&
    matchedShares <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
    Math.max(state.upShares, state.downShares) <=
      Math.max(config.maxSingleOrphanQty, config.liveSmallLotLadder[0] ?? config.defaultLot, state.market.minOrderSize) + 1e-9;
  const xuanManagedRecycleImbalance =
    aggressivePublicFootprint &&
    ctx.secsToClose > config.finalWindowNoChaseSec &&
    (
      xuanManagedRecycleResidual ||
      (
        matchedShares >= state.market.minOrderSize - 1e-9 &&
        shareGap <=
          Math.max(
            config.liveSmallLotLadder[0] ?? config.defaultLot,
            config.completionMinQty,
            state.market.minOrderSize,
          ) + 1e-9
      )
    );
  if (currentImbalance > xuanRecycleImbalanceThreshold && !xuanManagedRecycleImbalance) {
    advisoryReasons.push("rebalance_imbalance");
  }
  if (lowBalanceForNewEntry) {
    advisoryReasons.push("low_usdc_no_new_entry");
  }
  if (ctx.forceNoNewEntries) {
    advisoryReasons.push("startup_no_new_entry");
  }
  if (ctx.forceCompletionOnly) {
    advisoryReasons.push("startup_completion_only");
  }
  advisoryReasons.push(...externalReasons);

  const hardCancel = ctx.secsToClose <= config.hardCancelSecToClose || blockingReasons.includes("book_stale");
  const campaignRepairWindowOpen =
    config.botMode === "XUAN" &&
    config.xuanCloneMode === "PUBLIC_FOOTPRINT" &&
    config.xuanBasketCampaignEnabled &&
    config.marketBasketContinuationEnabled &&
    ctx.secsToClose > config.finalWindowCompletionOnlySec &&
    mergeableShares(state) >= config.marketBasketContinuationMinMatchedShares - 1e-9 &&
    Math.abs(state.upShares - state.downShares) <= Math.max(config.postMergeFlatDustShares, 1e-6) + 1e-9 &&
    matchedEffectivePairCost(state, config.cryptoTakerFeeRate) > 1 + 1e-9;
  const postMergeDustRecycleWindowOpen =
    aggressivePublicFootprint &&
    state.mergeHistory.length > 0 &&
    state.upShares + state.downShares <=
      Math.max(config.postMergeFlatDustShares * 2, state.market.minOrderSize * 0.01, 0.05) + 1e-9 &&
    ctx.secsToClose > config.finalWindowNoChaseSec;
  const shouldCompletionOnlyForLowBalance = lowBalanceForNewEntry && completionAllowedUnderLowBalance;
  const completionOnly =
    hardCancel ||
    Boolean(ctx.forceCompletionOnly) ||
    ctx.secsToClose <= config.completionOnlyCutoffSecToClose ||
    shouldCompletionOnlyForLowBalance ||
    (Boolean(ctx.forceNoNewEntries) && config.lowCollateralMode === "NO_NEW_ENTRY_BUT_MANAGE") ||
    (
      currentImbalance > xuanRecycleImbalanceThreshold &&
      !xuanManagedRecycleImbalance &&
      ctx.secsToClose <= config.normalEntryCutoffSecToClose
    );
  const allowNewEntries =
    !hardCancel &&
    !ctx.forceNoNewEntries &&
    !ctx.forceCompletionOnly &&
    (ctx.secsToClose > config.normalEntryCutoffSecToClose || campaignRepairWindowOpen || postMergeDustRecycleWindowOpen) &&
    blockingReasons.length === 0 &&
    (!lowBalanceForNewEntry || config.allowNewEntryUnderMinBalance);
  const tradable =
    blockingReasons.length === 0 &&
    (!lowBalanceForNewEntry || completionOnly || config.allowNewEntryUnderMinBalance);

  return {
    tradable,
    allowNewEntries,
    completionOnly,
    hardCancel,
    reasons: [...blockingReasons, ...advisoryReasons],
  };
}
