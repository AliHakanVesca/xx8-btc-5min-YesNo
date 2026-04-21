import { CtfClient, type CtfTxResult } from "./ctfClient.js";

export async function redeemResolved(client: CtfClient, conditionId: string): Promise<CtfTxResult> {
  return client.redeemPositions(conditionId);
}
