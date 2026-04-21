import type { OrderResult, TakerOrderType } from "../infra/clob/types.js";
import type { EntryBuyDecision } from "../strategy/xuan5m/entryLadderEngine.js";
import type { XuanMarketState } from "../strategy/xuan5m/marketState.js";

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
  createdAt: number;
  status: PairOrderGroupStatus;
  baselineUpShares: number;
  baselineDownShares: number;
}

export interface PairExecutionResult {
  group: PairOrderGroup;
  upResult?: OrderResult | undefined;
  downResult?: OrderResult | undefined;
  status: PairOrderGroupStatus;
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
  createdAt: number;
  state: XuanMarketState;
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
    createdAt: args.createdAt,
    status: "PENDING",
    baselineUpShares: args.state.upShares,
    baselineDownShares: args.state.downShares,
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

export function resolvePairOrderGroupStatus(group: PairOrderGroup, state: XuanMarketState): PairOrderGroupStatus {
  const upDelta = Math.max(0, state.upShares - group.baselineUpShares);
  const downDelta = Math.max(0, state.downShares - group.baselineDownShares);
  const upFilled = upDelta >= state.market.minOrderSize;
  const downFilled = downDelta >= state.market.minOrderSize;

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
}): PairExecutionResult {
  const anySuccess = args.upResult?.success || args.downResult?.success;
  const anySubmitted = args.upResult || args.downResult;
  const stateStatus = resolvePairOrderGroupStatus(args.group, args.state);

  let status: PairOrderGroupStatus = stateStatus;
  if (!anySubmitted) {
    status = "FAILED";
  } else if (!anySuccess && stateStatus === "PENDING") {
    status = "FAILED";
  } else if (stateStatus === "PENDING" && args.upResult && args.downResult) {
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
  };
}
