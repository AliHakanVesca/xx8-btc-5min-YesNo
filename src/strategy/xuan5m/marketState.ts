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

export interface PlannedOppositeCompletionState {
  plannedOppositeSide: OutcomeSide;
  plannedOppositeQty: number;
  plannedOppositeFilledQty: number;
  plannedOppositeMissingQty: number;
  plannedOppositeAgeSec: number;
  plannedPairGroupOpenedAt: number;
  plannedLowSideAvg: number;
}

function normalizeTraceNumber(value: number): number {
  return Number(value.toFixed(6));
}

function oppositeSide(side: OutcomeSide): OutcomeSide {
  return side === "UP" ? "DOWN" : "UP";
}

function isPlannedOppositeCoverageMode(mode: StrategyExecutionMode | undefined): boolean {
  return (
    mode === "HIGH_LOW_COMPLETION_CHASE" ||
    mode === "CHEAP_LATE_COMPLETION_CHASE" ||
    mode === "PARTIAL_FAST_COMPLETION" ||
    mode === "PARTIAL_SOFT_COMPLETION" ||
    mode === "PARTIAL_EMERGENCY_COMPLETION" ||
    mode === "POST_MERGE_RESIDUAL_COMPLETION"
  );
}

function isPlannedOppositeSeedMode(mode: StrategyExecutionMode | undefined, includeTemporalSingleLegSeeds: boolean): boolean {
  return mode === "PAIRGROUP_COVERED_SEED" || (includeTemporalSingleLegSeeds && mode === "TEMPORAL_SINGLE_LEG_SEED");
}

export function plannedOppositeCompletionState(
  state: XuanMarketState,
  nowTs: number,
  dustShares = 1e-6,
  includeTemporalSingleLegSeeds = false,
): PlannedOppositeCompletionState | undefined {
  const candidates = (["UP", "DOWN"] as OutcomeSide[])
    .map((side) => {
      const lots = side === "UP" ? state.upLots : state.downLots;
      const stagedLots = lots.filter((lot) =>
        isPlannedOppositeSeedMode(lot.executionMode, includeTemporalSingleLegSeeds),
      );
      const plannedQty = stagedLots.reduce((sum, lot) => sum + lot.size, 0);
      if (plannedQty <= dustShares || stagedLots.length === 0) {
        return undefined;
      }
      const plannedCost = stagedLots.reduce((sum, lot) => sum + lot.size * lot.price, 0);
      const openedAt = Math.min(...stagedLots.map((lot) => lot.timestamp));
      const opposite = oppositeSide(side);
      const oppositeLots = opposite === "UP" ? state.upLots : state.downLots;
      const oppositeShares = oppositeLots
        .filter((lot) => lot.timestamp >= openedAt && isPlannedOppositeCoverageMode(lot.executionMode))
        .reduce((sum, lot) => sum + lot.size, 0);
      const sameShares = side === "UP" ? state.upShares : state.downShares;
      const existingOppositeCoverage = Math.min(oppositeShares, plannedQty);
      const missingQty = Math.max(0, Math.min(plannedQty, sameShares) - existingOppositeCoverage);
      if (missingQty <= dustShares) {
        return undefined;
      }
      return {
        plannedOppositeSide: opposite,
        plannedOppositeQty: normalizeTraceNumber(plannedQty),
        plannedOppositeFilledQty: normalizeTraceNumber(existingOppositeCoverage),
        plannedOppositeMissingQty: normalizeTraceNumber(missingQty),
        plannedOppositeAgeSec: normalizeTraceNumber(Math.max(0, nowTs - openedAt)),
        plannedPairGroupOpenedAt: openedAt,
        plannedLowSideAvg: normalizeTraceNumber(plannedCost / plannedQty),
      };
    })
    .filter((item): item is PlannedOppositeCompletionState => item !== undefined)
    .sort((left, right) => right.plannedOppositeMissingQty - left.plannedOppositeMissingQty);

  return candidates[0];
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
