import type { MarketOrderArgs, OutcomeSide, OrderLevel } from "../infra/clob/types.js";
import { OrderBookState } from "../strategy/xuan5m/orderBookState.js";

function normalizeShares(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

function normalizeAmount(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

function buildChildOrder(baseOrder: MarketOrderArgs, shareTarget: number, limitPrice: number): MarketOrderArgs {
  return {
    ...baseOrder,
    shareTarget: normalizeShares(shareTarget),
    price: Number(limitPrice.toFixed(6)),
    amount: normalizeAmount(shareTarget * limitPrice),
  };
}

function asksForOutcome(books: OrderBookState, outcome: OutcomeSide): OrderLevel[] {
  const book = outcome === "UP" ? books.up : books.down;
  return [...(book?.asks ?? [])]
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .sort((left, right) => left.price - right.price);
}

export function planCloneChildBuyOrders(args: {
  order: MarketOrderArgs;
  outcome: OutcomeSide;
  books: OrderBookState;
  minOrderSize: number;
  preferredChildShares?: number | undefined;
  maxChildOrders?: number | undefined;
}): MarketOrderArgs[] {
  const { order } = args;
  if (
    order.side !== "BUY" ||
    order.price === undefined ||
    order.shareTarget === undefined ||
    !Number.isFinite(order.price) ||
    !Number.isFinite(order.shareTarget)
  ) {
    return [order];
  }

  const targetShares = normalizeShares(order.shareTarget);
  if (targetShares <= 0) {
    return [order];
  }

  const levels = asksForOutcome(args.books, args.outcome).filter((level) => level.price <= order.price! + 1e-9);
  if (levels.length === 0) {
    return [order];
  }

  const bestLevelDepth = levels[0]?.size ?? 0;
  const shouldSplit = targetShares > bestLevelDepth + 1e-6 || levels.length > 1;
  if (!shouldSplit) {
    return [order];
  }

  const preferredChildShares = normalizeShares(
    Math.max(
      args.minOrderSize,
      args.preferredChildShares ?? Math.max(args.minOrderSize, Math.min(30, targetShares / 4)),
    ),
  );
  const maxChildOrders = Math.max(2, args.maxChildOrders ?? 6);
  const children: MarketOrderArgs[] = [];
  let remainingShares = targetShares;

  for (const level of levels) {
    if (remainingShares <= 1e-6 || children.length >= maxChildOrders) {
      break;
    }

    let allocatableAtLevel = Math.min(remainingShares, level.size);
    while (allocatableAtLevel > 1e-6 && children.length < maxChildOrders) {
      const rawChunkShares = Math.min(allocatableAtLevel, preferredChildShares);
      const chunkRemainder = normalizeShares(allocatableAtLevel - rawChunkShares);
      const chunkShares = normalizeShares(
        chunkRemainder > 0 && chunkRemainder <= args.minOrderSize
          ? allocatableAtLevel
          : rawChunkShares,
      );
      if (chunkShares <= 1e-6) {
        break;
      }
      children.push(buildChildOrder(order, chunkShares, Math.min(order.price, level.price)));
      remainingShares = normalizeShares(remainingShares - chunkShares);
      allocatableAtLevel = normalizeShares(allocatableAtLevel - chunkShares);
    }
  }

  if (children.length === 0) {
    return [order];
  }

  if (remainingShares > 1e-6) {
    const lastChild = children[children.length - 1]!;
    const resizedShares = normalizeShares((lastChild.shareTarget ?? 0) + remainingShares);
    children[children.length - 1] = buildChildOrder(lastChild, resizedShares, order.price);
  }

  return children.length > 1 ? children : [order];
}
