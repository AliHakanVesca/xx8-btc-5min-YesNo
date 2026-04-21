import type { OutcomeSide } from "../../infra/clob/types.js";

export interface BalanceSnapshot {
  up: number;
  down: number;
}

export interface GhostFillCheck {
  ghost: boolean;
  inferredOutcome?: OutcomeSide;
  inferredSize?: number;
}

export function inferFillFromBalances(before: BalanceSnapshot, after: BalanceSnapshot): GhostFillCheck {
  const upDelta = after.up - before.up;
  const downDelta = after.down - before.down;
  if (upDelta > 0 && downDelta <= 0) {
    return { ghost: false, inferredOutcome: "UP", inferredSize: upDelta };
  }
  if (downDelta > 0 && upDelta <= 0) {
    return { ghost: false, inferredOutcome: "DOWN", inferredSize: downDelta };
  }
  if (upDelta <= 0 && downDelta <= 0) {
    return { ghost: true };
  }
  return { ghost: false };
}
