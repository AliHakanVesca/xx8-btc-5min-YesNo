import type { OrderResult, TakerOrderType } from "../infra/clob/types.js";
import type { EntryBuyDecision } from "../strategy/xuan5m/entryLadderEngine.js";
import type { XuanMarketState } from "../strategy/xuan5m/marketState.js";
import type { StrategyExecutionMode } from "../strategy/xuan5m/executionModes.js";

export type PairOrderGroupStatus =
  | "PENDING"
  | "BOTH_FILLED"
  | "UP_ONLY"
  | "DOWN_ONLY"
  | "NONE_FILLED"
  | "FAILED";

export interface PairOrderGroup {
  groupId: string;
  marketSlug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  intendedQty: number;
  maxUpPrice?: number | undefined;
  maxDownPrice?: number | undefined;
  orderType: TakerOrderType;
  mode: "STRICT" | "XUAN";
  selectedMode:
    | "STRICT_PAIR_SWEEP"
    | "XUAN_SOFT_PAIR_SWEEP"
    | "XUAN_HARD_PAIR_SWEEP"
    | "TEMPORAL_SINGLE_LEG_SEED"
    | "PAIRGROUP_COVERED_SEED";
  createdAt: number;
  status: PairOrderGroupStatus;
  baselineUpShares: number;
  baselineDownShares: number;
  rawPair: number;
  effectivePair: number;
  negativeEdgeUsdc: number;
  marketNegativeSpentBefore: number;
  marketNegativeSpentAfter: number;
}

export interface PairExecutionResult {
  group: PairOrderGroup;
  upResult?: OrderResult | undefined;
  downResult?: OrderResult | undefined;
  status: PairOrderGroupStatus;
  filledUpQty: number;
  filledDownQty: number;
}

export interface PairGroupFillSnapshot {
  upBoughtQty: number;
  downBoughtQty: number;
}

function buildGroupId(conditionId: string, createdAt: number): string {
  return `pair-${conditionId.slice(0, 10)}-${createdAt}`;
}

export function createPairOrderGroup(args: {
  conditionId: string;
  marketSlug: string;
  upTokenId: string;
  downTokenId: string;
  intendedQty: number;
  maxUpPrice?: number | undefined;
  maxDownPrice?: number | undefined;
  mode: "STRICT" | "XUAN";
  selectedMode: Extract<
    StrategyExecutionMode,
    | "STRICT_PAIR_SWEEP"
    | "XUAN_SOFT_PAIR_SWEEP"
    | "XUAN_HARD_PAIR_SWEEP"
    | "TEMPORAL_SINGLE_LEG_SEED"
    | "PAIRGROUP_COVERED_SEED"
  >;
  createdAt: number;
  state: XuanMarketState;
  rawPair: number;
  effectivePair: number;
  negativeEdgeUsdc: number;
}): PairOrderGroup {
  return {
    groupId: buildGroupId(args.conditionId, args.createdAt),
    marketSlug: args.marketSlug,
    conditionId: args.conditionId,
    upTokenId: args.upTokenId,
    downTokenId: args.downTokenId,
    intendedQty: args.intendedQty,
    ...(args.maxUpPrice !== undefined ? { maxUpPrice: args.maxUpPrice } : {}),
    ...(args.maxDownPrice !== undefined ? { maxDownPrice: args.maxDownPrice } : {}),
    orderType: args.mode === "STRICT" ? "FOK" : "FAK",
    mode: args.mode,
    selectedMode: args.selectedMode,
    createdAt: args.createdAt,
    status: "PENDING",
    baselineUpShares: args.state.upShares,
    baselineDownShares: args.state.downShares,
    rawPair: args.rawPair,
    effectivePair: args.effectivePair,
    negativeEdgeUsdc: args.negativeEdgeUsdc,
    marketNegativeSpentBefore: args.state.negativePairEdgeConsumedUsdc,
    marketNegativeSpentAfter: Number((args.state.negativePairEdgeConsumedUsdc + args.negativeEdgeUsdc).toFixed(6)),
  };
}

export function applyPairOrderType(entryBuys: EntryBuyDecision[], group: PairOrderGroup): EntryBuyDecision[] {
  return entryBuys.map((entryBuy) => ({
    ...entryBuy,
    order: {
      ...entryBuy.order,
      orderType: group.orderType,
      metadata: `${group.groupId}:${entryBuy.side}`,
    },
  }));
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function extractMatchedShares(result: OrderResult | undefined): number {
  const raw = asObject(result?.raw);
  const direct = Number(raw?.takingAmount ?? 0);
  if (Number.isFinite(direct) && direct > 0) {
    return normalize(direct);
  }
  return 0;
}

export function resolvePairOrderGroupStatus(
  group: PairOrderGroup,
  state: XuanMarketState,
  fillSnapshot?: PairGroupFillSnapshot,
): PairOrderGroupStatus {
  const upDelta = fillSnapshot?.upBoughtQty ?? Math.max(0, state.upShares - group.baselineUpShares);
  const downDelta = fillSnapshot?.downBoughtQty ?? Math.max(0, state.downShares - group.baselineDownShares);
  const upFilled = upDelta > 1e-6;
  const downFilled = downDelta > 1e-6;

  if (upFilled && downFilled) {
    return "BOTH_FILLED";
  }
  if (upFilled) {
    return "UP_ONLY";
  }
  if (downFilled) {
    return "DOWN_ONLY";
  }
  return "PENDING";
}

export function finalizePairExecutionResult(args: {
  group: PairOrderGroup;
  upResult?: OrderResult | undefined;
  downResult?: OrderResult | undefined;
  state: XuanMarketState;
  fillSnapshot?: PairGroupFillSnapshot | undefined;
  reconcileObservedAfterSubmit?: boolean | undefined;
  requireReconcileBeforeNoneFilled?: boolean | undefined;
}): PairExecutionResult {
  const anySuccess = args.upResult?.success || args.downResult?.success;
  const anySubmitted = args.upResult || args.downResult;
  const upFilledQty = normalize(args.fillSnapshot?.upBoughtQty ?? extractMatchedShares(args.upResult));
  const downFilledQty = normalize(args.fillSnapshot?.downBoughtQty ?? extractMatchedShares(args.downResult));
  const stateStatus = resolvePairOrderGroupStatus(args.group, args.state, {
    upBoughtQty: upFilledQty,
    downBoughtQty: downFilledQty,
  });

  let status: PairOrderGroupStatus = stateStatus;
  if (!anySubmitted) {
    status = "FAILED";
  } else if (!anySuccess && stateStatus === "PENDING") {
    status = "FAILED";
  } else if (
    stateStatus === "PENDING" &&
    args.upResult &&
    args.downResult &&
    (!args.requireReconcileBeforeNoneFilled || args.reconcileObservedAfterSubmit)
  ) {
    status = "NONE_FILLED";
  }

  return {
    group: {
      ...args.group,
      status,
    },
    upResult: args.upResult,
    downResult: args.downResult,
    status,
    filledUpQty: upFilledQty,
    filledDownQty: downFilledQty,
  };
}
