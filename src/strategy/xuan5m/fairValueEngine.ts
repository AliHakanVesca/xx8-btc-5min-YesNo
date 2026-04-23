import type { OutcomeSide } from "../../infra/clob/types.js";
import type { XuanStrategyConfig } from "../../config/strategyPresets.js";

export type FairValueStatus =
  | "valid"
  | "disabled"
  | "threshold_missing"
  | "live_missing"
  | "source_diverged"
  | "insufficient_history";

export type FairValueMode = "pair" | "completion" | "emergency" | "seed";

export interface BtcPricePoint {
  source: "rtds" | "binance" | "chainlink";
  price: number;
  timestampMs: number;
}

export interface FairValueSnapshot {
  status: FairValueStatus;
  estimatedThreshold: boolean;
  priceToBeat?: number | undefined;
  priceToBeatSource?: string | undefined;
  priceToBeatTimestampMs?: number | undefined;
  livePrice?: number | undefined;
  livePriceSource?: string | undefined;
  fairUp?: number | undefined;
  fairDown?: number | undefined;
  projectedVolFraction?: number | undefined;
  realizedVol30s?: number | undefined;
  realizedVol60s?: number | undefined;
  sourceDivergenceAbs?: number | undefined;
  sourceDivergenceFrac?: number | undefined;
  note?: string | undefined;
}

export interface FairValueGateDecision {
  allowed: boolean;
  reason?: string | undefined;
}

interface VolatilityWindow {
  stdev: number;
  avgStepSec: number;
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function sampleStandardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absolute);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-absolute * absolute);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

function computeVolatilityWindow(history: BtcPricePoint[], nowTsMs: number, windowMs: number): VolatilityWindow | undefined {
  const points = history
    .filter((point) => nowTsMs - point.timestampMs <= windowMs)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (points.length < 4) {
    return undefined;
  }

  const returns: number[] = [];
  const stepsSec: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (previous.price <= 0 || current.price <= 0) {
      continue;
    }
    const deltaSec = (current.timestampMs - previous.timestampMs) / 1000;
    if (deltaSec <= 0) {
      continue;
    }
    returns.push(Math.log(current.price / previous.price));
    stepsSec.push(deltaSec);
  }

  if (returns.length < 3 || stepsSec.length === 0) {
    return undefined;
  }

  return {
    stdev: sampleStandardDeviation(returns),
    avgStepSec: mean(stepsSec),
  };
}

function projectVolatilityFraction(
  history: BtcPricePoint[],
  nowTsMs: number,
  timeLeftSec: number,
): { projectedVolFraction: number; realizedVol30s?: number; realizedVol60s?: number } {
  const vol30 = computeVolatilityWindow(history, nowTsMs, 30_000);
  const vol60 = computeVolatilityWindow(history, nowTsMs, 60_000);

  const projected30 =
    vol30 && vol30.avgStepSec > 0 ? vol30.stdev * Math.sqrt(Math.max(timeLeftSec, 1) / vol30.avgStepSec) : 0;
  const projected60 =
    vol60 && vol60.avgStepSec > 0 ? vol60.stdev * Math.sqrt(Math.max(timeLeftSec, 1) / vol60.avgStepSec) : 0;

  return {
    projectedVolFraction: Math.max(projected30, projected60, 0.0005),
    ...(projected30 > 0 ? { realizedVol30s: normalize(projected30) } : {}),
    ...(projected60 > 0 ? { realizedVol60s: normalize(projected60) } : {}),
  };
}

export function evaluateFairValue(args: {
  config: Pick<
    XuanStrategyConfig,
    "enableFairValueFilter" | "fairValueMaxSourceDivergenceFrac" | "fairValueMaxSourceDivergenceUsd"
  >;
  marketStartTs: number;
  marketEndTs: number;
  nowTs: number;
  priceToBeat?: number | undefined;
  priceToBeatSource?: string | undefined;
  priceToBeatTimestampMs?: number | undefined;
  estimatedThreshold?: boolean | undefined;
  primaryPrice?: BtcPricePoint | undefined;
  secondaryPrice?: BtcPricePoint | undefined;
  history: BtcPricePoint[];
}): FairValueSnapshot {
  if (!args.config.enableFairValueFilter) {
    return {
      status: "disabled",
      estimatedThreshold: Boolean(args.estimatedThreshold),
    };
  }

  if (args.priceToBeat === undefined || !Number.isFinite(args.priceToBeat) || args.priceToBeat <= 0) {
    return {
      status: "threshold_missing",
      estimatedThreshold: Boolean(args.estimatedThreshold),
    };
  }

  if (!args.primaryPrice || !Number.isFinite(args.primaryPrice.price) || args.primaryPrice.price <= 0) {
    return {
      status: "live_missing",
      estimatedThreshold: Boolean(args.estimatedThreshold),
      priceToBeat: args.priceToBeat,
      priceToBeatSource: args.priceToBeatSource,
      priceToBeatTimestampMs: args.priceToBeatTimestampMs,
    };
  }

  if (args.secondaryPrice) {
    const divergenceAbs = Math.abs(args.primaryPrice.price - args.secondaryPrice.price);
    const divergenceFrac = divergenceAbs / Math.max(args.primaryPrice.price, args.secondaryPrice.price, 1);
    if (
      divergenceAbs > args.config.fairValueMaxSourceDivergenceUsd &&
      divergenceFrac > args.config.fairValueMaxSourceDivergenceFrac
    ) {
      return {
        status: "source_diverged",
        estimatedThreshold: Boolean(args.estimatedThreshold),
        priceToBeat: normalize(args.priceToBeat),
        priceToBeatSource: args.priceToBeatSource,
        priceToBeatTimestampMs: args.priceToBeatTimestampMs,
        livePrice: normalize(args.primaryPrice.price),
        livePriceSource: args.primaryPrice.source,
        sourceDivergenceAbs: normalize(divergenceAbs),
        sourceDivergenceFrac: normalize(divergenceFrac),
      };
    }
  }

  const timeLeftSec = Math.max(1, args.marketEndTs - args.nowTs);
  const volatility = projectVolatilityFraction(args.history, args.nowTs * 1000, timeLeftSec);
  const livePrice = args.primaryPrice.price;
  const stdDevUsd = Math.max(livePrice * volatility.projectedVolFraction, 5);
  const zScore = (livePrice - args.priceToBeat) / stdDevUsd;
  const fairUp = Math.min(0.999999, Math.max(0.000001, normalCdf(zScore)));
  const fairDown = 1 - fairUp;

  return {
    status:
      args.history.length >= 4 || volatility.projectedVolFraction > 0
        ? "valid"
        : "insufficient_history",
    estimatedThreshold: Boolean(args.estimatedThreshold),
    priceToBeat: normalize(args.priceToBeat),
    priceToBeatSource: args.priceToBeatSource,
    priceToBeatTimestampMs: args.priceToBeatTimestampMs,
    livePrice: normalize(livePrice),
    livePriceSource: args.primaryPrice.source,
    fairUp: normalize(fairUp),
    fairDown: normalize(fairDown),
    projectedVolFraction: normalize(volatility.projectedVolFraction),
    ...(volatility.realizedVol30s !== undefined ? { realizedVol30s: volatility.realizedVol30s } : {}),
    ...(volatility.realizedVol60s !== undefined ? { realizedVol60s: volatility.realizedVol60s } : {}),
    ...(args.secondaryPrice
      ? {
          sourceDivergenceAbs: normalize(Math.abs(args.primaryPrice.price - args.secondaryPrice.price)),
          sourceDivergenceFrac: normalize(
            Math.abs(args.primaryPrice.price - args.secondaryPrice.price) /
              Math.max(args.primaryPrice.price, args.secondaryPrice.price, 1),
          ),
        }
      : {}),
  };
}

function fairValueForSide(snapshot: FairValueSnapshot, side: OutcomeSide): number | undefined {
  return side === "UP" ? snapshot.fairUp : snapshot.fairDown;
}

function maxPremiumForMode(config: Pick<
  XuanStrategyConfig,
  "maxFairPremiumForSeed" | "maxFairPremiumForCompletion" | "maxFairPremiumForEmergency"
>, mode: FairValueMode): number {
  if (mode === "seed") {
    return config.maxFairPremiumForSeed;
  }
  if (mode === "emergency") {
    return config.maxFairPremiumForEmergency;
  }
  return config.maxFairPremiumForCompletion;
}

export function fairValueGate(args: {
  config: Pick<
    XuanStrategyConfig,
    | "maxFairPremiumForSeed"
    | "maxFairPremiumForCompletion"
    | "maxFairPremiumForEmergency"
    | "forbidUnderdogBuyIfFairBelowPrice"
    | "fairValueUnderdogPriceThreshold"
    | "highSidePriceThreshold"
    | "completionStrictCap"
    | "pairSweepStrictCap"
    | "fairValueFailClosedForHighSideChase"
  >;
  snapshot?: FairValueSnapshot | undefined;
  side: OutcomeSide;
  sidePrice: number;
  mode: FairValueMode;
  secsToClose: number;
  effectiveCost?: number | undefined;
  required?: boolean | undefined;
}): FairValueGateDecision {
  const premium = maxPremiumForMode(args.config, args.mode);
  const isUnderdog = args.sidePrice <= args.config.fairValueUnderdogPriceThreshold;
  const isHighSide = args.sidePrice >= args.config.highSidePriceThreshold;
  const fairValueRequired = Boolean(args.required);

  if (!args.snapshot || args.snapshot.status !== "valid") {
    if (!fairValueRequired) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: args.snapshot?.status ?? "fair_value_missing",
    };
  }

  if (!isUnderdog && !isHighSide) {
    return { allowed: true };
  }

  const fair = fairValueForSide(args.snapshot, args.side);
  if (fair === undefined) {
    return {
      allowed: false,
      reason: "fair_value_missing_side",
    };
  }

  if (isUnderdog) {
    if (args.mode !== "completion" && args.secsToClose <= 120) {
      return {
        allowed: false,
        reason: "fair_value_late_underdog",
      };
    }

    if (args.config.forbidUnderdogBuyIfFairBelowPrice && fair + premium < args.sidePrice) {
      return {
        allowed: false,
        reason: "fair_value_underdog_price",
      };
    }
  }

  if (isHighSide) {
    const highSideStrictCap = args.mode === "pair" ? args.config.pairSweepStrictCap : args.config.completionStrictCap;
    if (args.effectiveCost !== undefined && args.effectiveCost <= highSideStrictCap) {
      return { allowed: true };
    }

    if (args.config.fairValueFailClosedForHighSideChase && fairValueRequired && fair + premium < args.sidePrice) {
      return {
        allowed: false,
        reason: "fair_value_high_side_price",
      };
    }

    if (fair + premium < args.sidePrice) {
      if (!args.config.fairValueFailClosedForHighSideChase && !fairValueRequired) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "fair_value_high_side_price",
      };
    }
  }

  return { allowed: true };
}
