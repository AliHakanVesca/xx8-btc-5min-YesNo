import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import type { LimitOrderArgs } from "../../infra/clob/types.js";
import { chooseLot } from "./lotLadder.js";
import { planMerge } from "./mergeCoordinator.js";
import { buildMakerPairQuote } from "./quoteEngine.js";
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

export interface BotDecision {
  phase: ReturnType<typeof getStrategyPhase>;
  risk: RiskEvaluation;
  entryBuys: EntryBuyDecision[];
  makerOrders: LimitOrderArgs[];
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

    const lot = chooseLot(config, {
      dryRunOrSmallLive: input.dryRunOrSmallLive,
      secsFromOpen,
      imbalance: Math.abs(state.upShares - state.downShares) / Math.max(state.upShares + state.downShares, 1),
      bookDepthGood: books.depthAtOrBetter("UP", books.bestBid("UP"), "bid") >= config.defaultLot,
      edgeStrong: books.bestAsk("UP") + books.bestAsk("DOWN") <= config.combinedCapBase,
      edgeVeryStrong: books.bestAsk("UP") + books.bestAsk("DOWN") <= config.combinedCapSafe,
      recentBothSidesFilled: state.fillHistory.some((fill) => fill.outcome === "UP") && state.fillHistory.some((fill) => fill.outcome === "DOWN"),
      marketVolumeHigh: true,
      pnlTodayPositive: riskContext.dailyLossUsdc <= 0,
    });

    const baseMergePlan = planMerge(config, state);
    const mergeReadyWithoutDrift =
      baseMergePlan.shouldMerge && Math.abs(state.upShares - state.downShares) <= state.market.minOrderSize;

    const entryBuys =
      risk.allowNewEntries
        ? chooseEntryBuys(config, state, books, {
            secsFromOpen,
            secsToClose,
            lot,
          })
        : [];

    const makerOrders: LimitOrderArgs[] = [];
    if (risk.allowNewEntries && config.makerQuotingEnabled && entryBuys.length === 0 && !mergeReadyWithoutDrift) {
      const quote = buildMakerPairQuote(config, state, books, {
        secsFromOpen,
        secsToClose,
        lot,
      });
      if (quote) {
        if (quote.upSize > 0) {
          makerOrders.push({
            tokenId: state.market.tokens.UP.tokenId,
            price: quote.upPrice,
            size: quote.upSize,
            side: "BUY",
            orderType: "GTC",
            postOnly: true,
            expiration: Math.floor(Date.now() / 1000) + 60 + Math.max(30, secsToClose),
          });
        }
        if (quote.downSize > 0) {
          makerOrders.push({
            tokenId: state.market.tokens.DOWN.tokenId,
            price: quote.downPrice,
            size: quote.downSize,
            side: "BUY",
            orderType: "GTC",
            postOnly: true,
            expiration: Math.floor(Date.now() / 1000) + 60 + Math.max(30, secsToClose),
          });
        }
      }
    }

    const inventoryAdjustment = risk.tradable && !risk.allowNewEntries
      ? chooseInventoryAdjustment(config, state, books, { secsToClose }) ?? undefined
      : undefined;
    const mergePlan = planMerge(config, projectMergeState(state, entryBuys, inventoryAdjustment?.completion));

    return {
      phase,
      risk,
      entryBuys,
      makerOrders,
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
