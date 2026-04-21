import type { XuanStrategyConfig } from "../../config/strategyPresets.js";
import { getMarketPhase } from "../../infra/time/windowScheduler.js";

export function getStrategyPhase(
  nowTs: number,
  startTs: number,
  endTs: number,
  config: XuanStrategyConfig,
) {
  return getMarketPhase(
    nowTs,
    startTs,
    endTs,
    config.normalEntryCutoffSecToClose,
    config.completionOnlyCutoffSecToClose,
    config.hardCancelSecToClose,
  );
}
