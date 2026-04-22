import { describe, expect, it } from "vitest";
import {
  resolveCollateralApprovalSpenders,
  resolveExchangeSpender,
  V1_CTF_EXCHANGE,
  V1_NEG_RISK_CTF_EXCHANGE,
  V2_CTF_EXCHANGE,
  V2_NEG_RISK_CTF_EXCHANGE,
} from "../../src/infra/polygon/polymarketContracts.js";

describe("polymarket contract helpers", () => {
  it("resolves current stack spenders", () => {
    expect(resolveExchangeSpender({ useClobV2: false, negRisk: false })).toBe(V1_CTF_EXCHANGE);
    expect(resolveExchangeSpender({ useClobV2: false, negRisk: true })).toBe(V1_NEG_RISK_CTF_EXCHANGE);
  });

  it("resolves v2 spenders", () => {
    expect(resolveExchangeSpender({ useClobV2: true, negRisk: false })).toBe(V2_CTF_EXCHANGE);
    expect(resolveExchangeSpender({ useClobV2: true, negRisk: true })).toBe(V2_NEG_RISK_CTF_EXCHANGE);
  });

  it("lists both approval spenders for a stack", () => {
    expect(resolveCollateralApprovalSpenders(false)).toEqual([V1_CTF_EXCHANGE, V1_NEG_RISK_CTF_EXCHANGE]);
    expect(resolveCollateralApprovalSpenders(true)).toEqual([V2_CTF_EXCHANGE, V2_NEG_RISK_CTF_EXCHANGE]);
  });
});
