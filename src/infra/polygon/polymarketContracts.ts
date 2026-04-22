export const V1_CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const V1_NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
export const V1_NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

export const V2_CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
export const V2_NEG_RISK_CTF_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

export function resolveExchangeSpender(args: {
  useClobV2: boolean;
  negRisk: boolean;
}): string {
  if (args.useClobV2) {
    return args.negRisk ? V2_NEG_RISK_CTF_EXCHANGE : V2_CTF_EXCHANGE;
  }
  return args.negRisk ? V1_NEG_RISK_CTF_EXCHANGE : V1_CTF_EXCHANGE;
}

export function resolveCollateralApprovalSpenders(useClobV2: boolean): string[] {
  return useClobV2
    ? [V2_CTF_EXCHANGE, V2_NEG_RISK_CTF_EXCHANGE]
    : [V1_CTF_EXCHANGE, V1_NEG_RISK_CTF_EXCHANGE];
}
