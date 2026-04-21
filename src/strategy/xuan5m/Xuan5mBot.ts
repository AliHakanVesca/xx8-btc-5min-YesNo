import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { chooseLot } from "./lotLadder.js";
import { planMerge } from "./mergeCoordinator.js";
import { evaluateRisk, type RiskContext, type RiskEvaluation } from "./riskEngine.js";
import { getStrategyPhase } from "./scheduler.js";
import {
  chooseInventoryAdjustment,
  type CompletionDecision,
  type UnwindDecision,
} from "./completionEngine.js";
import { chooseEntryBuys, type EntryBuyDecision } from "./entryLadderEngine.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";
import { pairEntryCap } from "./modePolicy.js";
import { pairCostWithBothTaker } from "./sumAvgEngine.js";

export interface BotDecision {
  phase: ReturnType<typeof getStrategyPhase>;
  risk: RiskEvaluation;
  entryBuys: EntryBuyDecision[];
  completion?: CompletionDecision | undefined;
  unwind?: UnwindDecision | undefined;
  mergeShares: number;
}

export interface TickInput {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  books: OrderBookState;
  nowTs: number;
  riskContext: RiskContext;
  dryRunOrSmallLive: boolean;
}

export class Xuan5mBot {
  evaluateTick(input: TickInput): BotDecision {
    const { config, state, books, nowTs, riskContext } = input;
    const phase = getStrategyPhase(nowTs, state.market.startTs, state.market.endTs, config);
    const risk = evaluateRisk(config, state, riskContext);
    const secsFromOpen = nowTs - state.market.startTs;
    const secsToClose = state.market.endTs - nowTs;
    const pairTakerCost = pairCostWithBothTaker(
      books.bestAsk("UP"),
      books.bestAsk("DOWN"),
      config.cryptoTakerFeeRate,
    );
    const pairCap = pairEntryCap(config);
    const inventoryBalanced = Math.abs(state.upShares - state.downShares) <= state.market.minOrderSize;

    const lot = chooseLot(config, {
      dryRunOrSmallLive: input.dryRunOrSmallLive,
      secsFromOpen,
      imbalance: Math.abs(state.upShares - state.downShares) / Math.max(state.upShares + state.downShares, 1),
      bookDepthGood:
        Math.min(
          books.depthAtOrBetter("UP", books.bestAsk("UP"), "ask"),
          books.depthAtOrBetter("DOWN", books.bestAsk("DOWN"), "ask"),
        ) >= config.defaultLot,
      pairCostWithinCap: pairTakerCost <= pairCap,
      pairCostComfortable: pairTakerCost <= pairCap - config.minEdgePerShare,
      inventoryBalanced,
      recentBothSidesFilled: state.fillHistory.some((fill) => fill.outcome === "UP") && state.fillHistory.some((fill) => fill.outcome === "DOWN"),
      marketVolumeHigh: true,
      pnlTodayPositive: riskContext.dailyLossUsdc <= 0,
    });

    const baseMergePlan = planMerge(config, state);

    const entryBuys =
      risk.allowNewEntries
        ? chooseEntryBuys(config, state, books, {
            secsFromOpen,
            secsToClose,
            lot,
          })
        : [];

    const inventoryAdjustment = risk.tradable && !risk.allowNewEntries
      ? chooseInventoryAdjustment(config, state, books, { secsToClose }) ?? undefined
      : undefined;
    const mergePlan = planMerge(config, projectMergeState(state, entryBuys, inventoryAdjustment?.completion));

    return {
      phase,
      risk,
      entryBuys,
      completion: inventoryAdjustment?.completion,
      unwind: inventoryAdjustment?.unwind,
      mergeShares: mergePlan.shouldMerge ? mergePlan.mergeable : 0,
    };
  }
}

function projectMergeState(
  state: XuanMarketState,
  entryBuys: EntryBuyDecision[],
  completion: CompletionDecision | undefined,
): XuanMarketState {
  let projectedState = {
    ...state,
    upShares: state.upShares,
    downShares: state.downShares,
  };

  for (const entryBuy of entryBuys) {
    if (entryBuy.side === "UP") {
      projectedState = {
        ...projectedState,
        upShares: projectedState.upShares + entryBuy.size,
      };
    } else {
      projectedState = {
        ...projectedState,
        downShares: projectedState.downShares + entryBuy.size,
      };
    }
  }

  if (!completion) {
    return projectedState;
  }

  return {
    ...projectedState,
    upShares: projectedState.upShares + (completion.sideToBuy === "UP" ? completion.missingShares : 0),
    downShares: projectedState.downShares + (completion.sideToBuy === "DOWN" ? completion.missingShares : 0),
  };
}
