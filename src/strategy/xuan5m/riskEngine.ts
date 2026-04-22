import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { imbalance } from "./inventoryState.js";
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
  if (currentImbalance > config.maxImbalanceFrac) advisoryReasons.push("rebalance_imbalance");
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
  const shouldCompletionOnlyForLowBalance = lowBalanceForNewEntry && completionAllowedUnderLowBalance;
  const completionOnly =
    hardCancel ||
    Boolean(ctx.forceCompletionOnly) ||
    ctx.secsToClose <= config.completionOnlyCutoffSecToClose ||
    shouldCompletionOnlyForLowBalance ||
    (Boolean(ctx.forceNoNewEntries) && config.lowCollateralMode === "NO_NEW_ENTRY_BUT_MANAGE") ||
    (currentImbalance > config.maxImbalanceFrac && ctx.secsToClose <= config.normalEntryCutoffSecToClose);
  const allowNewEntries =
    !hardCancel &&
    !ctx.forceNoNewEntries &&
    !ctx.forceCompletionOnly &&
    ctx.secsToClose > config.normalEntryCutoffSecToClose &&
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
