import type { AppEnv } from "./schema.js";

export interface XuanStrategyConfig {
  marketAsset: string;
  marketDurationSec: number;
  entryTakerBuyEnabled: boolean;
  entryTakerPairCap: number;
  completionCap: number;
  minEdgePerShare: number;
  cryptoTakerFeeRate: number;
  enterFromOpenSecMin: number;
  enterFromOpenSecMax: number;
  normalEntryCutoffSecToClose: number;
  completionOnlyCutoffSecToClose: number;
  hardCancelSecToClose: number;
  maxMarketSharesPerSide: number;
  maxOneSidedExposureShares: number;
  maxImbalanceFrac: number;
  forceRebalanceImbalanceFrac: number;
  rebalanceLeadingFraction: number;
  rebalanceMaxLaggingMultiplier: number;
  lotLadder: number[];
  liveSmallLots: number[];
  defaultLot: number;
  mergeMinShares: number;
  maxCyclesPerMarket: number;
  maxBuysPerSide: number;
  reentryDelayMs: number;
  partialCompletionFractions: number[];
  maxResidualHoldShares: number;
  residualUnwindSecToClose: number;
  sellUnwindEnabled: boolean;
  dailyMaxLossUsdc: number;
  marketMaxLossUsdc: number;
  minUsdcBalance: number;
}

export function buildStrategyConfig(env: AppEnv): XuanStrategyConfig {
  return {
    marketAsset: "btc",
    marketDurationSec: 300,
    entryTakerBuyEnabled: env.ENTRY_TAKER_BUY_ENABLED,
    entryTakerPairCap: env.ENTRY_TAKER_PAIR_CAP,
    completionCap: env.COMPLETION_CAP,
    minEdgePerShare: env.MIN_EDGE_PER_SHARE,
    cryptoTakerFeeRate: 0.072,
    enterFromOpenSecMin: env.ENTER_FROM_OPEN_SEC_MIN,
    enterFromOpenSecMax: env.ENTER_FROM_OPEN_SEC_MAX,
    normalEntryCutoffSecToClose: env.NORMAL_ENTRY_CUTOFF_SEC_TO_CLOSE,
    completionOnlyCutoffSecToClose: env.COMPLETION_ONLY_CUTOFF_SEC_TO_CLOSE,
    hardCancelSecToClose: env.HARD_CANCEL_SEC_TO_CLOSE,
    maxMarketSharesPerSide: env.MAX_MARKET_SHARES_PER_SIDE,
    maxOneSidedExposureShares: env.MAX_ONE_SIDED_EXPOSURE_SHARES,
    maxImbalanceFrac: env.MAX_IMBALANCE_FRAC,
    forceRebalanceImbalanceFrac: env.FORCE_REBALANCE_IMBALANCE_FRAC,
    rebalanceLeadingFraction: env.REBALANCE_LEADING_FRACTION,
    rebalanceMaxLaggingMultiplier: env.REBALANCE_MAX_LAGGING_MULTIPLIER,
    lotLadder: env.LOT_LADDER,
    liveSmallLots: env.LIVE_SMALL_LOTS,
    defaultLot: env.DEFAULT_LOT,
    mergeMinShares: env.MERGE_MIN_SHARES,
    maxCyclesPerMarket: env.MAX_CYCLES_PER_MARKET,
    maxBuysPerSide: env.MAX_BUYS_PER_SIDE,
    reentryDelayMs: 1000,
    partialCompletionFractions: env.PARTIAL_COMPLETION_FRACTIONS,
    maxResidualHoldShares: env.MAX_RESIDUAL_HOLD_SHARES,
    residualUnwindSecToClose: env.RESIDUAL_UNWIND_SEC_TO_CLOSE,
    sellUnwindEnabled: env.SELL_UNWIND_ENABLED,
    dailyMaxLossUsdc: env.DAILY_MAX_LOSS_USDC,
    marketMaxLossUsdc: env.MARKET_MAX_LOSS_USDC,
    minUsdcBalance: env.MIN_USDC_BALANCE,
  };
}
