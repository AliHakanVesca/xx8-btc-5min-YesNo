import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import xlsx from "xlsx";
import fixture from "../fixtures/xuan_sample.json" with { type: "json" };
import { analyzeXuanActivityWorkbook, analyzeXuanPayload } from "../../src/infra/dataApi/xuanAnalyzer.js";

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

  it("imports Activity_Log workbook rows with trade and lifecycle counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuan-activity-"));
    const workbookPath = join(dir, "activity.xlsx");
    try {
      const workbook = xlsx.utils.book_new();
      const activityRows: Record<string, unknown>[] = [];
      for (let index = 0; index < 45; index += 1) {
        const seconds = index === 0 ? 4 : index === 44 ? 282 : 10 + index * 5;
        const marketStart = 1_777_147_200 + Math.floor(index / 7) * 300;
        activityRows.push({
          seq: index + 1,
          timestamp_unix: marketStart + seconds,
          market_start_unix: marketStart,
          seconds_from_market_start: seconds,
          type: "TRADE",
          side: "BUY",
          outcome: index % 2 === 0 ? "Down" : "Up",
          size_tokens: 129.59805,
          api_price_usd: index % 2 === 0 ? 0.47 : 0.43,
          slug: `btc-updown-5m-${marketStart}`,
        });
      }
      const lifecycleSeconds = [164, 188, 206, 210, 250, 276, 278, 278, 280, 282, 332, 338, 344, 350, 356];
      for (const [index, seconds] of lifecycleSeconds.entries()) {
        const marketStart = 1_777_147_200 + Math.floor(index / 2) * 300;
        activityRows.push({
          seq: 46 + index,
          timestamp_unix: marketStart + seconds,
          market_start_unix: marketStart,
          seconds_from_market_start: seconds,
          type: index < 10 ? "MERGE" : "REDEEM",
          size_tokens: 129.59805,
          usdcSize: 129.59805,
          slug: `btc-updown-5m-${marketStart}`,
        });
      }
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(activityRows), "Activity_Log");
      xlsx.utils.book_append_sheet(
        workbook,
        xlsx.utils.json_to_sheet([{ slug: "btc-updown-5m-1777147200", records_captured: 60 }]),
        "Market_Summary",
      );
      xlsx.writeFile(workbook, workbookPath);

      const bundle = await analyzeXuanActivityWorkbook(workbookPath);
      expect(bundle.report.totalTrades).toBe(45);
      expect(bundle.report.buyCount).toBe(45);
      expect(bundle.report.sellCount).toBe(0);
      expect(bundle.report.downCount).toBe(23);
      expect(bundle.report.upCount).toBe(22);
      expect(bundle.report.mergeCount).toBe(10);
      expect(bundle.report.redeemCount).toBe(5);
      expect(bundle.report.firstBuySec).toBe(4);
      expect(bundle.report.lastBuySec).toBe(282);
      expect(bundle.report.medianFillSize).toBe(129.59805);
      expect(bundle.report.buyOnlyRate).toBe(1);
      expect(bundle.report.mergeTimingBuckets.first_window_160_210s).toBe(4);
      expect(bundle.report.mergeTimingBuckets.final_276_282s).toBe(5);
      expect(bundle.sourceLimitNote).toContain("slice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
