import { deriveExpectedFunderAddress, resolveRelayerExecutionMode, type RelayerExecutionMode } from "../infra/relayer/txType.js";

export interface WalletTopology {
  configuredWalletAddress: string;
  signerAddress: string;
  funderAddress: string;
  signatureType: number;
  signerMatchesConfiguredWallet: boolean;
  signerMatchesFunder: boolean;
  mode: RelayerExecutionMode;
  expectedFunderAddress?: string;
  expectedFunderMatchesConfiguredFunder: boolean;
}

export interface MergeExecutionReadiness {
  ready: boolean;
  severity: "ok" | "warn" | "block";
  reason?: string;
}

export function classifyWalletTopology(args: {
  configuredWalletAddress: string;
  signerAddress: string;
  funderAddress?: string;
  signatureType: number;
  chainId: number;
}): WalletTopology {
  const funderAddress = args.funderAddress ?? args.configuredWalletAddress;
  const expectedFunderAddress = deriveExpectedFunderAddress(
    args.signerAddress as `0x${string}`,
    args.chainId,
    args.signatureType,
  );

  return {
    configuredWalletAddress: args.configuredWalletAddress,
    signerAddress: args.signerAddress,
    funderAddress,
    signatureType: args.signatureType,
    signerMatchesConfiguredWallet:
      args.signerAddress.toLowerCase() === args.configuredWalletAddress.toLowerCase(),
    signerMatchesFunder: args.signerAddress.toLowerCase() === funderAddress.toLowerCase(),
    mode: resolveRelayerExecutionMode(args.signatureType),
    ...(expectedFunderAddress ? { expectedFunderAddress } : {}),
    expectedFunderMatchesConfiguredFunder: expectedFunderAddress
      ? expectedFunderAddress.toLowerCase() === funderAddress.toLowerCase()
      : true,
  };
}

export function assessMergeExecutionReadiness(args: {
  topology: WalletTopology;
  mergeEnabled: boolean;
  relayerConfigured: boolean;
  relayerOwnerMatchesSigner: boolean;
  safeDeployed?: boolean;
}): MergeExecutionReadiness {
  if (!args.mergeEnabled) {
    return {
      ready: false,
      severity: "warn",
      reason: "CTF_MERGE_ENABLED=false; otomatik merge bilerek kapali.",
    };
  }

  if (!args.topology.expectedFunderMatchesConfiguredFunder) {
    return {
      ready: false,
      severity: "block",
      reason: "Configured funder beklenen safe/proxy adresiyle eslesmiyor.",
    };
  }

  if (args.topology.mode === "direct") {
    return args.topology.signerMatchesFunder
      ? { ready: true, severity: "ok" }
      : {
          ready: false,
          severity: "block",
          reason: "Signature type 0 icin signer ve funder ayni adres olmali.",
        };
  }

  if (!args.relayerConfigured) {
    return {
      ready: false,
      severity: "block",
      reason: "Safe/proxy merge icin relayer API credentials gerekli.",
    };
  }

  if (!args.relayerOwnerMatchesSigner) {
    return {
      ready: false,
      severity: "block",
      reason: "POLY_RELAYER_API_KEY_ADDRESS signer adresiyle eslesmiyor.",
    };
  }

  if (args.topology.mode === "safe" && args.safeDeployed === false) {
    return {
      ready: false,
      severity: "block",
      reason: "Safe deploy edilmemis; relayer merge oncesi deploy gerekli.",
    };
  }

  return {
    ready: true,
    severity: "ok",
  };
}
