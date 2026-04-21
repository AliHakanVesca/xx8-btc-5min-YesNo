import { CtfClient, type CtfTxResult } from "./ctfClient.js";

export async function mergeImmediate(
  client: CtfClient,
  conditionId: string,
  amount: number,
): Promise<CtfTxResult> {
  return client.mergePositions(conditionId, amount);
}
