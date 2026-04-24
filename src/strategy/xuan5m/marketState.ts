import type { MarketInfo, OutcomeSide, TradeSide } from "../../infra/clob/types.js";
import type { StrategyExecutionMode } from "./executionModes.js";

export interface InventoryLot {
  size: number;
  price: number;
  timestamp: number;
  executionMode?: StrategyExecutionMode | undefined;
}

export interface FillRecord {
  outcome: OutcomeSide;
  side: TradeSide;
  price: number;
  size: number;
  timestamp: number;
  makerTaker: "maker" | "taker" | "unknown";
  executionMode?: StrategyExecutionMode | undefined;
  flowLineage?: string | undefined;
}

export interface MergeRecord {
  amount: number;
  timestamp: number;
  simulated: boolean;
  flowLineage?: string | undefined;
  matchedUpCost?: number | undefined;
  matchedDownCost?: number | undefined;
  mergeReturn?: number | undefined;
  realizedPnl?: number | undefined;
  remainingUpShares?: number | undefined;
  remainingDownShares?: number | undefined;
}

export interface XuanMarketState {
  market: MarketInfo;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upLots: InventoryLot[];
  downLots: InventoryLot[];
  openOrderIds: string[];
  fillHistory: FillRecord[];
  mergeHistory: MergeRecord[];
  cycleNo: number;
  negativeEdgeConsumedUsdc: number;
  negativePairEdgeConsumedUsdc: number;
  negativeCompletionEdgeConsumedUsdc: number;
  lastFilledSide?: OutcomeSide;
  stuckSide?: OutcomeSide;
  lastExecutionMode?: StrategyExecutionMode | undefined;
  consecutiveSeedSide?: OutcomeSide | undefined;
  consecutiveSeedCount: number;
  reentryDisabled: boolean;
  postMergeCompletionOnlyUntil?: number | undefined;
}

function isRecentSeedFill(fill: FillRecord, nowTs: number, windowSec: number): boolean {
  return (
    fill.side === "BUY" &&
    (fill.executionMode === "TEMPORAL_SINGLE_LEG_SEED" || fill.executionMode === "PAIRGROUP_COVERED_SEED") &&
    nowTs - fill.timestamp <= windowSec
  );
}

export function countRecentSeedFlowCount(
  fillHistory: FillRecord[],
  nowTs: number,
  windowSec = 120,
): number {
  return fillHistory.filter((fill) => isRecentSeedFill(fill, nowTs, windowSec)).length;
}

export function countActiveIndependentFlowCount(
  fillHistory: FillRecord[],
  nowTs: number,
  windowSec = 120,
): number {
  const recentSeedFills = fillHistory
    .filter((fill) => isRecentSeedFill(fill, nowTs, windowSec))
    .sort((left, right) => left.timestamp - right.timestamp);
  const groups: Array<{ lastTimestamp: number; sides: Set<OutcomeSide>; hasPairGroupCoveredSeed: boolean }> = [];
  const pairedSeedWindowSec = 4;

  for (const fill of recentSeedFills) {
    if (!isRecentSeedFill(fill, nowTs, windowSec)) {
      continue;
    }
    const lastGroup = groups.at(-1);
    const canAttachToRecentPairedSeed =
      lastGroup !== undefined &&
      fill.timestamp - lastGroup.lastTimestamp <= pairedSeedWindowSec &&
      (lastGroup.hasPairGroupCoveredSeed || fill.executionMode === "PAIRGROUP_COVERED_SEED") &&
      (lastGroup.sides.size < 2 || lastGroup.sides.has(fill.outcome));
    if (canAttachToRecentPairedSeed && lastGroup) {
      lastGroup.lastTimestamp = fill.timestamp;
      lastGroup.sides.add(fill.outcome);
      lastGroup.hasPairGroupCoveredSeed =
        lastGroup.hasPairGroupCoveredSeed || fill.executionMode === "PAIRGROUP_COVERED_SEED";
      continue;
    }
    groups.push({
      lastTimestamp: fill.timestamp,
      sides: new Set([fill.outcome]),
      hasPairGroupCoveredSeed: fill.executionMode === "PAIRGROUP_COVERED_SEED",
    });
  }
  return groups.length;
}

export function createMarketState(market: MarketInfo): XuanMarketState {
  return {
    market,
    upShares: 0,
    downShares: 0,
    upCost: 0,
    downCost: 0,
    upLots: [],
    downLots: [],
    openOrderIds: [],
    fillHistory: [],
    mergeHistory: [],
    cycleNo: 0,
    negativeEdgeConsumedUsdc: 0,
    negativePairEdgeConsumedUsdc: 0,
    negativeCompletionEdgeConsumedUsdc: 0,
    consecutiveSeedCount: 0,
    reentryDisabled: false,
  };
}
