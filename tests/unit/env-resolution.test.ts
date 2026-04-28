import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";

describe("env resolution", () => {
  it("defaults to post-cutover V2 production", () => {
    const env = parseEnv({
      DRY_RUN: "true",
    });

    expect(env.POLY_STACK_MODE).toBe("post-cutover-v2");
    expect(env.USE_CLOB_V2).toBe(true);
    expect(env.POLY_CLOB_BASE_URL).toBe("https://clob.polymarket.com");
    expect(env.ACTIVE_COLLATERAL_TOKEN).toBe("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
    expect(env.ACTIVE_COLLATERAL_SYMBOL).toBe("pUSD");
  });

  it("derives explicit legacy V1 defaults", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "current-prod-v1",
    });

    expect(env.USE_CLOB_V2).toBe(false);
    expect(env.POLY_CLOB_BASE_URL).toBe("https://clob.polymarket.com");
    expect(env.ACTIVE_COLLATERAL_SYMBOL).toBe("USDC.e");
  });

  it("derives post-cutover V2 defaults", () => {
    const env = parseEnv({
      DRY_RUN: "true",
      POLY_STACK_MODE: "post-cutover-v2",
      POLY_PUSD_TOKEN: "0x1111111111111111111111111111111111111111",
    });

    expect(env.USE_CLOB_V2).toBe(true);
    expect(env.POLY_CLOB_BASE_URL).toBe("https://clob.polymarket.com");
    expect(env.ACTIVE_COLLATERAL_TOKEN).toBe("0x1111111111111111111111111111111111111111");
    expect(env.ACTIVE_COLLATERAL_SYMBOL).toBe("pUSD");
  });

  it("rejects inconsistent stack flags", () => {
    expect(() =>
      parseEnv({
        DRY_RUN: "true",
        POLY_STACK_MODE: "current-prod-v1",
        USE_CLOB_V2: "true",
      }),
    ).toThrow(/USE_CLOB_V2=true/);
  });

  it("requires live secrets and collateral placeholders to be replaced", () => {
    expect(() =>
      parseEnv({
        DRY_RUN: "false",
        POLY_STACK_MODE: "current-prod-v1",
      }),
    ).toThrow(/Live mod/);
  });

  it("can bootstrap missing live API credentials when enforcement is disabled", () => {
    const env = parseEnv(
      {
        DRY_RUN: "false",
        POLY_STACK_MODE: "current-prod-v1",
        BOT_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
        BOT_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222",
        CTF_CONTRACT_ADDRESS: "0x3333333333333333333333333333333333333333",
        POLY_USDC_TOKEN: "0x4444444444444444444444444444444444444444",
      },
      { enforceLiveRequirements: false },
    );

    expect(env.POLY_STACK_MODE).toBe("current-prod-v1");
    expect(env.POLY_API_KEY).toBeUndefined();
    expect(env.POLY_API_SECRET).toBeUndefined();
    expect(env.POLY_API_PASSPHRASE).toBeUndefined();
  });
});
