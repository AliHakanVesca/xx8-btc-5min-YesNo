import type { BotDecision } from "../strategy/xuan5m/Xuan5mBot.js";
import type { XuanMarketState } from "../strategy/xuan5m/marketState.js";

export function renderDashboard(state: XuanMarketState, decision: BotDecision, nowTs: number): string {
  const secsFromOpen = nowTs - state.market.startTs;
  const secsToClose = state.market.endTs - nowTs;
  return [
    `market=${state.market.slug}`,
    `phase=${decision.phase}`,
    `secs_from_open=${secsFromOpen}`,
    `secs_to_close=${secsToClose}`,
    `up_shares=${state.upShares.toFixed(2)}`,
    `down_shares=${state.downShares.toFixed(2)}`,
    `entry_buys=${decision.entryBuys.length}`,
    `maker_orders=${decision.makerOrders.length}`,
    `completion=${decision.completion ? "yes" : "no"}`,
    `unwind=${decision.unwind ? "yes" : "no"}`,
    `merge_shares=${decision.mergeShares.toFixed(2)}`,
    `risk=${decision.risk.reasons.join(",") || "ok"}`,
  ].join("\n");
}
