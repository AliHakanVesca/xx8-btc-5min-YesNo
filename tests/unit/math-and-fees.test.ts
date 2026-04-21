import { describe, expect, it } from "vitest";
import { roundDownToTick, roundToTick } from "../../src/utils/math.js";
import {
  completionCost,
  pairCostWithBothTaker,
  takerFeePerShare,
  takerFeeUsd,
} from "../../src/strategy/xuan5m/sumAvgEngine.js";

describe("math and fee helpers", () => {
  it("calculates crypto taker fee", () => {
    expect(takerFeeUsd(100, 0.5)).toBeCloseTo(1.8, 8);
    expect(takerFeePerShare(0.5)).toBeCloseTo(0.018, 8);
  });

  it("rounds prices to tick", () => {
    expect(roundToTick(0.487, 0.01)).toBeCloseTo(0.49, 8);
    expect(roundDownToTick(0.487, 0.01)).toBeCloseTo(0.48, 8);
  });

  it("computes pair and completion costs", () => {
    expect(pairCostWithBothTaker(0.48, 0.48)).toBeCloseTo(0.9959424, 8);
    expect(completionCost(0.47, 0.49)).toBeCloseTo(0.9779928, 8);
  });
});
