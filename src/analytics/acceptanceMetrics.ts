import type { BotDecision } from "../strategy/xuan5m/Xuan5mBot.js";

export interface AcceptanceReport {
  entryBuyCount: number;
  makerOrderCount: number;
  hasCompletion: boolean;
  hasUnwind: boolean;
  mergeShares: number;
  completionOnly: boolean;
  hardCancel: boolean;
}

export function buildAcceptanceReport(decision: BotDecision): AcceptanceReport {
  return {
    entryBuyCount: decision.entryBuys.length,
    makerOrderCount: decision.makerOrders.length,
    hasCompletion: Boolean(decision.completion),
    hasUnwind: Boolean(decision.unwind),
    mergeShares: decision.mergeShares,
    completionOnly: decision.risk.completionOnly,
    hardCancel: decision.risk.hardCancel,
  };
}
