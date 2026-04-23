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
import { evaluateEntryBuys, type EntryBuyDecision, type EntryDecisionTrace } from "./entryLadderEngine.js";
import type { XuanMarketState } from "./marketState.js";
import { OrderBookState } from "./orderBookState.js";
import { pairEntryCap } from "./modePolicy.js";
import { pairCostWithBothTaker } from "./sumAvgEngine.js";
import type { StrategyExecutionMode } from "./executionModes.js";
import type { FairValueSnapshot } from "./fairValueEngine.js";

export interface BotDecision {
  phase: ReturnType<typeof getStrategyPhase>;
  risk: RiskEvaluation;
  entryBuys: EntryBuyDecision[];
  completion?: CompletionDecision | undefined;
  unwind?: UnwindDecision | undefined;
  mergeShares: number;
  trace: BotDecisionTrace;
}

export interface BotDecisionTrace {
  secsFromOpen: number;
  secsToClose: number;
  lot: number;
  totalShares: number;
  shareGap: number;
  inventoryBalanced: boolean;
  bestAskUp: number;
  bestAskDown: number;
  pairCap: number;
  pairTakerCost: number;
  selectedMode?: StrategyExecutionMode | undefined;
  fairValue?: FairValueSnapshot | undefined;
  entry: EntryDecisionTrace;
}

export interface TickInput {
  config: XuanStrategyConfig;
  state: XuanMarketState;
  books: OrderBookState;
  nowTs: number;
  riskContext: RiskContext;
  dryRunOrSmallLive: boolean;
  dailyNegativeEdgeSpentUsdc?: number;
  fairValueSnapshot?: FairValueSnapshot | undefined;
  allowControlledOverlap?: boolean | undefined;
}

function overrideRiskForPhase(
  phase: ReturnType<typeof getStrategyPhase>,
  risk: RiskEvaluation,
): RiskEvaluation {
  if (phase === "PREOPEN") {
    return {
      tradable: false,
      allowNewEntries: false,
      completionOnly: false,
      hardCancel: true,
      reasons: ["preopen"],
    };
  }

  if (phase === "CLOSED") {
    return {
      tradable: false,
      allowNewEntries: false,
      completionOnly: false,
      hardCancel: true,
      reasons: ["closed"],
    };
  }

  return risk;
}

export class Xuan5mBot {
  evaluateTick(input: TickInput): BotDecision {
    const { config, state, books, nowTs, riskContext } = input;
    const phase = getStrategyPhase(nowTs, state.market.startTs, state.market.endTs, config);
    const risk = overrideRiskForPhase(phase, evaluateRisk(config, state, riskContext));
    const secsFromOpen = nowTs - state.market.startTs;
    const secsToClose = state.market.endTs - nowTs;
    const totalShares = state.upShares + state.downShares;
    const shareGap = Math.abs(state.upShares - state.downShares);
    const bestAskUp = books.bestAsk("UP");
    const bestAskDown = books.bestAsk("DOWN");
    const pairTakerCost = pairCostWithBothTaker(
      bestAskUp,
      bestAskDown,
      config.cryptoTakerFeeRate,
    );
    const pairCap = pairEntryCap(config);
    const pairDecisionCap =
      config.botMode === "XUAN" && config.allowInitialNegativePairSweep
        ? Math.max(pairCap, config.xuanPairSweepSoftCap)
        : pairCap;
    const inventoryBalanced = shareGap <= config.completionMinQty;

    const lot = chooseLot(config, {
      dryRunOrSmallLive: input.dryRunOrSmallLive,
      secsFromOpen,
      imbalance: shareGap / Math.max(totalShares, 1),
      bookDepthGood:
        Math.min(
          books.depthAtOrBetter("UP", bestAskUp, "ask"),
          books.depthAtOrBetter("DOWN", bestAskDown, "ask"),
        ) >= config.defaultLot,
      pairCostWithinCap: pairTakerCost <= pairDecisionCap,
      pairCostComfortable: pairTakerCost <= pairDecisionCap - config.minEdgePerShare,
      inventoryBalanced,
      recentBothSidesFilled: state.fillHistory.some((fill) => fill.outcome === "UP") && state.fillHistory.some((fill) => fill.outcome === "DOWN"),
      marketVolumeHigh: true,
      pnlTodayPositive: riskContext.dailyLossUsdc <= 0,
    });

    const entryEvaluation = evaluateEntryBuys(config, state, books, {
      secsFromOpen,
      secsToClose,
      lot,
      dailyNegativeEdgeSpentUsdc: input.dailyNegativeEdgeSpentUsdc ?? state.negativeEdgeConsumedUsdc,
      fairValueSnapshot: input.fairValueSnapshot,
      allowControlledOverlap: input.allowControlledOverlap,
    });

    const entryBuys =
      risk.allowNewEntries
        ? entryEvaluation.decisions
        : [];

    const inventoryAdjustment = risk.tradable && !risk.allowNewEntries
        ? chooseInventoryAdjustment(config, state, books, {
          secsToClose,
          usdcBalance: riskContext.usdcBalance,
          nowTs,
          fairValueSnapshot: input.fairValueSnapshot,
        }) ?? undefined
      : undefined;
    const mergePlan = planMerge(config, projectMergeState(state, entryBuys, inventoryAdjustment?.completion));

    return {
      phase,
      risk,
      entryBuys,
      completion: inventoryAdjustment?.completion,
      unwind: inventoryAdjustment?.unwind,
      mergeShares: mergePlan.shouldMerge ? mergePlan.mergeable : 0,
      trace: {
        secsFromOpen,
        secsToClose,
        lot,
        totalShares,
        shareGap,
        inventoryBalanced,
        bestAskUp,
        bestAskDown,
        pairCap,
        pairTakerCost,
        ...(input.fairValueSnapshot ? { fairValue: input.fairValueSnapshot } : {}),
        selectedMode:
          entryBuys[0]?.mode ??
          inventoryAdjustment?.completion?.mode ??
          inventoryAdjustment?.unwind?.mode ??
          entryEvaluation.trace.selectedMode,
        entry: risk.allowNewEntries
          ? entryEvaluation.trace
          : {
              ...entryEvaluation.trace,
              gatedByRisk: true,
              skipReason: entryEvaluation.trace.skipReason ?? "risk_blocked",
            },
      },
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
