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

  if (ctx.staleBookMs > 2000) blockingReasons.push("book_stale");
  if (ctx.balanceStaleMs > 5000) blockingReasons.push("balance_stale");
  if (ctx.bookIsCrossed) blockingReasons.push("crossed_book");
  if (ctx.dailyLossUsdc >= config.dailyMaxLossUsdc) blockingReasons.push("daily_loss_limit");
  if (ctx.marketLossUsdc >= config.marketMaxLossUsdc) blockingReasons.push("market_loss_limit");
  if (ctx.usdcBalance < config.minUsdcBalance) blockingReasons.push("low_usdc_balance");
  if (currentImbalance > config.maxImbalanceFrac) advisoryReasons.push("rebalance_imbalance");

  const hardCancel = ctx.secsToClose <= config.hardCancelSecToClose || blockingReasons.includes("book_stale");
  const completionOnly =
    hardCancel ||
    ctx.secsToClose <= config.completionOnlyCutoffSecToClose ||
    (currentImbalance > config.maxImbalanceFrac && ctx.secsToClose <= config.normalEntryCutoffSecToClose);
  const allowNewEntries =
    !hardCancel &&
    ctx.secsToClose > config.normalEntryCutoffSecToClose &&
    blockingReasons.length === 0;

  return {
    tradable: blockingReasons.length === 0 || completionOnly,
    allowNewEntries,
    completionOnly,
    hardCancel,
    reasons: [...blockingReasons, ...advisoryReasons],
  };
}
