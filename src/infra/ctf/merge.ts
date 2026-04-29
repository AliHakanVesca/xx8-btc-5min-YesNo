import { CtfClient, type CtfActionOptions, type CtfTxResult } from "./ctfClient.js";

export async function mergeImmediate(
  client: CtfClient,
  conditionId: string,
  amount: number,
  options: CtfActionOptions = {},
): Promise<CtfTxResult> {
  return client.mergePositions(conditionId, amount, options);
}
