import type { ClobAdapter } from "../infra/clob/types.js";

export class HeartbeatManager {
  private heartbeatId?: string;

  constructor(private readonly clob: ClobAdapter) {}

  async pulse(): Promise<void> {
    if (!this.clob.postHeartbeat) {
      return;
    }
    const result = await this.clob.postHeartbeat(this.heartbeatId);
    this.heartbeatId = result.heartbeatId;
  }
}
