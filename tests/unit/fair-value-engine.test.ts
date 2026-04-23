import { describe, expect, it } from "vitest";
import { fairValueGate, evaluateFairValue, type BtcPricePoint } from "../../src/strategy/xuan5m/fairValueEngine.js";
import { buildStrategyConfig } from "../../src/config/strategyPresets.js";
import { parseEnv } from "../../src/config/env.js";

function buildConfig() {
  return buildStrategyConfig(
    parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    }),
  );
}

function buildHistory(): BtcPricePoint[] {
  return [
    { source: "rtds", price: 78000, timestampMs: 1_000 },
    { source: "rtds", price: 78020, timestampMs: 6_000 },
    { source: "rtds", price: 78010, timestampMs: 11_000 },
    { source: "rtds", price: 78040, timestampMs: 16_000 },
    { source: "rtds", price: 78070, timestampMs: 21_000 },
  ];
}

describe("fair value engine", () => {
  it("computes a valid fair value snapshot when threshold and live price exist", () => {
    const config = buildConfig();
    const snapshot = evaluateFairValue({
      config,
      marketStartTs: 0,
      marketEndTs: 300,
      nowTs: 120,
      priceToBeat: 78000,
      priceToBeatSource: "rtds",
      priceToBeatTimestampMs: 0,
      estimatedThreshold: false,
      primaryPrice: { source: "rtds", price: 78070, timestampMs: 21_000 },
      secondaryPrice: { source: "binance", price: 78069, timestampMs: 21_100 },
      history: buildHistory(),
    });

    expect(snapshot.status).toBe("valid");
    expect(snapshot.priceToBeat).toBe(78000);
    expect(snapshot.livePrice).toBe(78070);
    expect(snapshot.fairUp).toBeGreaterThan(snapshot.fairDown ?? 0);
  });

  it("rejects underdog buys when fair value is materially below the ask", () => {
    const config = buildConfig();
    const decision = fairValueGate({
      config,
      snapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.11,
        fairDown: 0.89,
      },
      side: "UP",
      sidePrice: 0.2,
      mode: "seed",
      secsToClose: 240,
      effectiveCost: 1.01,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "fair_value_underdog_price",
    });
  });

  it("allows high-side strict pair entries under the pair sweep cap", () => {
    const config = buildConfig();
    const decision = fairValueGate({
      config,
      snapshot: {
        status: "valid",
        estimatedThreshold: false,
        fairUp: 0.03,
        fairDown: 0.97,
      },
      side: "DOWN",
      sidePrice: 0.96,
      mode: "pair",
      secsToClose: 240,
      effectiveCost: 1.0055,
      required: true,
    });

    expect(decision).toEqual({ allowed: true });
  });
});
