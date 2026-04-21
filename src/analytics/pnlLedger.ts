export interface LedgerFill {
  side: "UP" | "DOWN";
  price: number;
  size: number;
  feeUsd: number;
}

export interface LedgerMerge {
  shares: number;
  pairCost: number;
}

export class PnlLedger {
  private fills: LedgerFill[] = [];
  private merges: LedgerMerge[] = [];

  recordFill(fill: LedgerFill): void {
    this.fills.push(fill);
  }

  recordMerge(merge: LedgerMerge): void {
    this.merges.push(merge);
  }

  realizedMergeProfit(): number {
    return this.merges.reduce((acc, merge) => acc + merge.shares * (1 - merge.pairCost), 0);
  }

  totalFees(): number {
    return this.fills.reduce((acc, fill) => acc + fill.feeUsd, 0);
  }
}
