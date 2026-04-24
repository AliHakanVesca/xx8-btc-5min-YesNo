import { describe, expect, it } from "vitest";
import { runMultiSyntheticReplay } from "../../src/analytics/multiReplay.js";
import { parseEnv } from "../../src/config/env.js";

describe("multi synthetic replay", () => {
  it("aggregates entry buys, completion, and merge scenarios across multiple windows", () => {
    const report = runMultiSyntheticReplay(
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
      }),
      2,
    );

    expect(report.summary).toMatchObject({
      windowCount: 2,
      scenariosPerWindow: 8,
      totalScenarioCount: 16,
      entryBuyScenarioCount: 6,
      balancedPairScenarioCount: 6,
      laggingRebalanceScenarioCount: 0,
      completionScenarioCount: 2,
      unwindScenarioCount: 0,
      mergeScenarioCount: 10,
      completionOnlyScenarioCount: 8,
      hardCancelScenarioCount: 2,
      totalEntryBuyShares: 60,
      totalCompletionShares: 20,
      totalUnwindShares: 0,
      totalMergeShares: 250,
    });
    expect(report.summary.totalEntryBuyNotional).toBeCloseTo(28.7, 8);

    const firstSlug = report.scenarios[0]?.marketSlug ?? "";
    const windowStartTs = Number(firstSlug.split("-").at(-1));
    expect(Number.isFinite(windowStartTs)).toBe(true);
    expect(windowStartTs % 300).toBe(0);

    const profitableCompletion = report.scenarios.find((scenario) => scenario.scenarioName === "profitable-completion");
    expect(profitableCompletion?.orders.completion?.missingShares).toBe(10);
    expect(profitableCompletion?.economics.completionWithinCap).toBe(true);
    expect(profitableCompletion?.orders.mergeShares).toBe(10);

    const openingPairSeed = report.scenarios.find((scenario) => scenario.scenarioName === "open-balanced-entry");
    expect(openingPairSeed?.orders.entryBuyCount).toBe(2);
    expect(openingPairSeed?.orders.entryBuys.map((entry) => entry.side)).toEqual(["UP", "DOWN"]);
    expect(openingPairSeed?.orders.totalEntryBuyShares).toBe(10);
    expect(openingPairSeed?.orders.mergeShares).toBe(5);

    const rebalanceScenario = report.scenarios.find((scenario) => scenario.scenarioName === "mid-rebalance-buy-only");
    expect(rebalanceScenario?.orders.entryBuyCount).toBe(0);
    expect(rebalanceScenario?.orders.laggingRebalanceCount).toBe(0);
    expect(rebalanceScenario?.orders.balancedPairEntryCount).toBe(0);
    expect(rebalanceScenario?.orders.entryBuys).toHaveLength(0);
    expect(rebalanceScenario?.orders.completion).toBeUndefined();
    expect(rebalanceScenario?.orders.mergeShares).toBe(10);

    const mergeQueue = report.scenarios.find((scenario) => scenario.scenarioName === "merge-queue");
    expect(mergeQueue?.orders.entryBuyCount).toBe(2);
    expect(mergeQueue?.orders.balancedPairEntryCount).toBe(2);
    expect(mergeQueue?.orders.totalEntryBuyShares).toBe(10);
    expect(mergeQueue?.orders.mergeShares).toBe(95);

    const blockedCompletion = report.scenarios.find(
      (scenario) => scenario.scenarioName === "expensive-completion-blocked",
    );
    expect(blockedCompletion?.orders.completion).toBeUndefined();
    expect(blockedCompletion?.economics.completionWithinCap).toBe(false);

    const lateHoldScenario = report.scenarios.find((scenario) => scenario.scenarioName === "late-residual-hold");
    expect(lateHoldScenario?.orders.unwind).toBeUndefined();
    expect(lateHoldScenario?.orders.completion).toBeUndefined();
  });
});
