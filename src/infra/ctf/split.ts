import { CtfClient, type CtfTxResult } from "./ctfClient.js";

export async function splitCollateral(
  client: CtfClient,
  conditionId: string,
  amount: number,
): Promise<CtfTxResult> {
  return client.splitPosition(conditionId, amount);
}
