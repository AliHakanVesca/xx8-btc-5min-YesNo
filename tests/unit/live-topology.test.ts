import { describe, expect, it } from "vitest";
import { assessMergeExecutionReadiness, classifyWalletTopology, resolveConfiguredFunderAddress } from "../../src/live/topology.js";

describe("live topology", () => {
  it("allows SAFE merge when derived funder, relayer owner, and deployment are all ready", () => {
    const topology = classifyWalletTopology({
      configuredWalletAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      signerAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      funderAddress: "0xeb724b33cb2d2f886989f035db9ab304a1d248ba",
      signatureType: 2,
      chainId: 137,
    });

    const readiness = assessMergeExecutionReadiness({
      topology,
      mergeEnabled: true,
      relayerConfigured: true,
      relayerOwnerMatchesSigner: true,
      safeDeployed: true,
    });

    expect(topology.mode).toBe("safe");
    expect(topology.expectedFunderMatchesConfiguredFunder).toBe(true);
    expect(readiness).toEqual({ ready: true, severity: "ok" });
  });

  it("blocks SAFE merge when configured funder does not match the derived SAFE address", () => {
    const topology = classifyWalletTopology({
      configuredWalletAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      signerAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      funderAddress: "0x1111111111111111111111111111111111111111",
      signatureType: 2,
      chainId: 137,
    });

    const readiness = assessMergeExecutionReadiness({
      topology,
      mergeEnabled: true,
      relayerConfigured: true,
      relayerOwnerMatchesSigner: true,
      safeDeployed: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.severity).toBe("block");
    expect(readiness.reason).toContain("Configured funder");
  });

  it("allows direct merge only when signer and funder are the same address", () => {
    const topology = classifyWalletTopology({
      configuredWalletAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      signerAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      funderAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      signatureType: 0,
      chainId: 137,
    });

    const readiness = assessMergeExecutionReadiness({
      topology,
      mergeEnabled: true,
      relayerConfigured: false,
      relayerOwnerMatchesSigner: false,
    });

    expect(topology.mode).toBe("direct");
    expect(readiness).toEqual({ ready: true, severity: "ok" });
  });

  it("warns when merge is explicitly disabled", () => {
    const topology = classifyWalletTopology({
      configuredWalletAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      signerAddress: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
      funderAddress: "0xeb724b33cb2d2f886989f035db9ab304a1d248ba",
      signatureType: 2,
      chainId: 137,
    });

    const readiness = assessMergeExecutionReadiness({
      topology,
      mergeEnabled: false,
      relayerConfigured: true,
      relayerOwnerMatchesSigner: true,
      safeDeployed: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.severity).toBe("warn");
    expect(readiness.reason).toContain("CTF_MERGE_ENABLED=false");
  });

  it("uses funder address as collateral owner when configured", () => {
    expect(
      resolveConfiguredFunderAddress({
        BOT_WALLET_ADDRESS: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
        POLY_FUNDER: "0xeb724b33cb2d2f886989f035db9ab304a1d248ba",
      }),
    ).toBe("0xeb724b33cb2d2f886989f035db9ab304a1d248ba");
  });

  it("falls back to bot wallet when no funder is configured", () => {
    expect(
      resolveConfiguredFunderAddress({
        BOT_WALLET_ADDRESS: "0x84CC411f0452791010E70E80FFF6255B1f757A29",
        POLY_FUNDER: undefined,
      }),
    ).toBe("0x84CC411f0452791010E70E80FFF6255B1f757A29");
  });
});
