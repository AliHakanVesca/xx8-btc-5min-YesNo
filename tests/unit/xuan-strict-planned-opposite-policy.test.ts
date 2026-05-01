import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import {
  shouldBlockSmallLotExpensiveCompletion,
  xuanSmallLotCompletionHardStopCap,
} from "../../src/strategy/xuan5m/xuanStrictPlannedOppositePolicy.js";

function buildConfig(overrides: Record<string, string> = {}) {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
      BOT_MODE: "XUAN",
      XUAN_CLONE_MODE: "PUBLIC_FOOTPRINT",
      XUAN_CLONE_INTENSITY: "AGGRESSIVE",
      XUAN_BASE_LOT_LADDER: "15",
      LIVE_SMALL_LOT_LADDER: "15",
      ...overrides,
    }),
  );
}

describe("xuan strict planned opposite policy", () => {
  it("hard-stops expensive small-lot completion outside final emergency", () => {
    const config = buildConfig();

    expect(xuanSmallLotCompletionHardStopCap(config)).toBeCloseTo(1.06, 6);
    expect(
      shouldBlockSmallLotExpensiveCompletion({
        config,
        costWithFees: 1.312,
        secsToClose: 180,
        oldGap: 15,
        minOrderSize: 5,
      }),
    ).toBe(true);
    expect(
      shouldBlockSmallLotExpensiveCompletion({
        config,
        costWithFees: 1.045,
        secsToClose: 180,
        oldGap: 15,
        minOrderSize: 5,
      }),
    ).toBe(false);
  });

  it("keeps the hard stop scoped to small aggressive Xuan and final emergency rules", () => {
    const smallConfig = buildConfig();
    const largeConfig = buildConfig({
      XUAN_BASE_LOT_LADDER: "40",
      LIVE_SMALL_LOT_LADDER: "40",
    });

    expect(
      shouldBlockSmallLotExpensiveCompletion({
        config: smallConfig,
        costWithFees: 1.312,
        secsToClose: 1,
        oldGap: 15,
        minOrderSize: 5,
      }),
    ).toBe(false);
    expect(
      shouldBlockSmallLotExpensiveCompletion({
        config: largeConfig,
        costWithFees: 1.312,
        secsToClose: 180,
        oldGap: 40,
        minOrderSize: 5,
      }),
    ).toBe(false);
  });
});
