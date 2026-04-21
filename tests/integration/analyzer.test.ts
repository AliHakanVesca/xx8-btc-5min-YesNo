import { describe, expect, it } from "vitest";
import fixture from "../fixtures/xuan_sample.json" with { type: "json" };
import { analyzeXuanPayload } from "../../src/infra/dataApi/xuanAnalyzer.js";

describe("xuan analyzer", () => {
  it("computes metrics from sample export", () => {
    const report = analyzeXuanPayload(fixture, "fixture");
    expect(report.totalTrades).toBe(8);
    expect(report.marketCount).toBe(2);
    expect(report.buyCount).toBe(8);
    expect(report.sellCount).toBe(0);
    expect(report.equalFillCountMarketCount).toBe(2);
    expect(report.medianFillSize).toBe(60);
    expect(report.medianPairVwapSum).toBeGreaterThan(0.95);
    expect(report.medianPairVwapSum).toBeLessThan(1);
  });
});
