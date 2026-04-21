import { deriveProxyWallet, deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive.js";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config/index.js";

export type RelayerExecutionMode = "direct" | "proxy" | "safe";

export function resolveRelayerExecutionMode(signatureType: number): RelayerExecutionMode {
  if (signatureType === 2) {
    return "safe";
  }
  if (signatureType === 1) {
    return "proxy";
  }
  return "direct";
}

export function deriveExpectedFunderAddress(
  signerAddress: `0x${string}`,
  chainId: number,
  signatureType: number,
): `0x${string}` | undefined {
  const mode = resolveRelayerExecutionMode(signatureType);
  const config = getContractConfig(chainId);

  if (mode === "safe") {
    return deriveSafe(signerAddress, config.SafeContracts.SafeFactory) as `0x${string}`;
  }

  if (mode === "proxy") {
    return deriveProxyWallet(signerAddress, config.ProxyContracts.ProxyFactory) as `0x${string}`;
  }

  return undefined;
}
