import { describe, expect, it } from "vitest";
import {
  scoreTradeBehaviorSimilarity,
  type LiveXuanTimelineRow,
} from "../../src/analytics/liveXuanCompare.js";

function row(
  actor: "xuan" | "ours",
  sec: number,
  action: string,
  side: string,
  qty: number,
): LiveXuanTimelineRow {
  return {
    actor,
    sec,
    timestamp: 1_700_000_000 + sec,
    timeUtc: new Date((1_700_000_000 + sec) * 1000).toISOString().replace(".000Z", "Z"),
    action,
    side,
    qty,
    usdc: qty * 0.5,
    upQty: side === "UP" ? qty : 0,
    downQty: side === "DOWN" ? qty : 0,
    upAfter: side === "UP" ? qty : 0,
    downAfter: side === "DOWN" ? qty : 0,
    realizedPnl: action === "MERGE" ? qty * 0.02 : 0,
    cumPnl: action === "MERGE" ? qty * 0.02 : 0,
  };
}

describe("live xuan compare", () => {
  it("scores identical trade behavior above the 95 target", () => {
    const rows = [
      row("xuan", 10, "BUY", "DOWN", 60),
      row("ours", 11, "BUY", "DOWN", 60),
      row("xuan", 28, "BUY", "UP", 60),
      row("ours", 29, "BUY", "UP", 60),
      row("xuan", 250, "MERGE", "PAIR", 60),
      row("ours", 251, "MERGE", "PAIR", 60),
    ];

    const score = scoreTradeBehaviorSimilarity(rows);

    expect(score.score).toBeGreaterThanOrEqual(95);
    expect(score.status).toBe("PASS");
    expect(score.gaps).toEqual([]);
  });

  it("penalizes sparse early-merge behavior against xuan continuation flow", () => {
    const rows = [
      row("ours", 4, "BUY", "DOWN", 110),
      row("xuan", 10, "BUY", "DOWN", 61.4),
      row("ours", 19, "BUY", "UP", 110),
      row("xuan", 20, "BUY", "UP", 61.4),
      row("xuan", 98, "BUY", "UP", 61.4),
      row("ours", 160, "MERGE", "PAIR", 110),
      row("xuan", 206, "BUY", "DOWN", 266.1),
      row("xuan", 278, "MERGE", "PAIR", 511.7),
    ];

    const score = scoreTradeBehaviorSimilarity(rows);

    expect(score.score).toBeLessThan(75);
    expect(score.gaps).toEqual(
      expect.arrayContaining([
        "action_side_sequence_mismatch",
        "quantity_exposure_mismatch",
        "merge_size_mismatch",
      ]),
    );
  });

  it("penalizes same counts when buy-side chronology is reversed", () => {
    const rows = [
      row("xuan", 10, "BUY", "DOWN", 60),
      row("xuan", 30, "BUY", "UP", 60),
      row("xuan", 250, "MERGE", "PAIR", 60),
      row("ours", 10, "BUY", "UP", 60),
      row("ours", 30, "BUY", "DOWN", 60),
      row("ours", 250, "MERGE", "PAIR", 60),
    ];

    const score = scoreTradeBehaviorSimilarity(rows);

    expect(score.score).toBeLessThan(95);
    expect(score.gaps).toContain("action_side_sequence_mismatch");
  });

  it("tolerates sub-cent per-share merge pnl drift when trade behavior is aligned", () => {
    const rows = [
      row("xuan", 16, "BUY", "DOWN", 214.1),
      row("ours", 12, "BUY", "DOWN", 214),
      row("xuan", 36, "BUY", "UP", 214.1),
      row("ours", 31, "BUY", "UP", 214),
      row("xuan", 126, "BUY", "DOWN", 214.1),
      row("ours", 126, "BUY", "DOWN", 214),
      row("xuan", 146, "BUY", "UP", 214.1),
      row("ours", 146, "BUY", "UP", 214),
      { ...row("xuan", 178, "MERGE", "PAIR", 642.3), realizedPnl: 3.64817, cumPnl: 3.64817 },
      { ...row("ours", 178, "MERGE", "PAIR", 641.99), realizedPnl: -2.409626, cumPnl: -2.409626 },
      row("xuan", 230, "BUY", "DOWN", 255.2),
      row("ours", 230, "BUY", "DOWN", 255.195),
      row("xuan", 276, "BUY", "UP", 255.2),
      row("ours", 276, "BUY", "UP", 255.195),
    ];

    const score = scoreTradeBehaviorSimilarity(rows);

    expect(score.score).toBeGreaterThanOrEqual(95);
    expect(score.gaps).not.toContain("merge_pnl_mismatch");
    expect(score.pnlScore).toBe(90);
  });
});
