import type { XuanMetricsReport } from "../infra/dataApi/xuanAnalyzer.js";

export interface BacktestSummary {
  targetMedianPairVwapSum: number;
  targetMedianImbalance: number;
  notes: string[];
}

export function buildBacktestSummary(report: XuanMetricsReport): BacktestSummary {
  return {
    targetMedianPairVwapSum: report.medianPairVwapSum,
    targetMedianImbalance: report.medianImbalance,
    notes: [
      "Historical orderbook data is not bundled, so this is a behavioral target summary rather than a full replay.",
      "Use live recorder output to calibrate paper-mode fill simulation against xuan metrics.",
    ],
  };
}
