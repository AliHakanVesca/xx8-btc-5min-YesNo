import type { OutcomeSide } from "../infra/clob/types.js";
import type { PaperSessionStepResult } from "./paperSession.js";

export type ClipBucket = "1_5" | "6_10" | "11_15" | "16_30" | "31_plus";
export type CycleBucket = "0" | "1" | "2_3" | "4_plus";
export type RepairLatencyBucket = "none" | "0_10" | "10_30" | "30_90" | "90_plus";
export type ResidualMagnitudeBucket = "flat" | "dust" | "small" | "medium" | "large";

export interface FootprintSummary {
  buySequence: OutcomeSide[];
  alternatingTransitionCount: number;
  cycleCount: number;
  cycleBucket: CycleBucket;
  clipBucketCounts: Record<ClipBucket, number>;
  mergeCount: number;
  partialRepairLatencyBucket: RepairLatencyBucket;
  dominantResidualSide: OutcomeSide | "FLAT";
  residualMagnitudeBucket: ResidualMagnitudeBucket;
}

function bucketClip(size: number): ClipBucket {
  if (size <= 5) return "1_5";
  if (size <= 10) return "6_10";
  if (size <= 15) return "11_15";
  if (size <= 30) return "16_30";
  return "31_plus";
}

function bucketCycle(count: number): CycleBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  return "4_plus";
}

function bucketRepairLatency(latencySec: number | undefined): RepairLatencyBucket {
  if (latencySec === undefined) return "none";
  if (latencySec <= 10) return "0_10";
  if (latencySec <= 30) return "10_30";
  if (latencySec <= 90) return "30_90";
  return "90_plus";
}

function bucketResidualMagnitude(shares: number): ResidualMagnitudeBucket {
  if (shares <= 0) return "flat";
  if (shares <= 0.5) return "dust";
  if (shares <= 5) return "small";
  if (shares <= 15) return "medium";
  return "large";
}

function firstPartialTimestamp(steps: PaperSessionStepResult[]): number | undefined {
  const step = steps.find((candidate) => {
    const hasEntryBuy = candidate.execution.fills.some((fill) => fill.kind === "entry" && fill.action === "BUY");
    const hasSingleSide = candidate.execution.fills
      .filter((fill) => fill.kind === "entry" && fill.action === "BUY")
      .map((fill) => fill.side)
      .length === 1;
    return hasEntryBuy && hasSingleSide;
  });
  return step?.timestamp;
}

function firstCompletionTimestamp(steps: PaperSessionStepResult[]): number | undefined {
  return steps.find((step) => step.execution.fills.some((fill) => fill.kind === "completion"))?.timestamp;
}

export function buildFootprintSummary(args: {
  steps: PaperSessionStepResult[];
  finalUpShares: number;
  finalDownShares: number;
}): FootprintSummary {
  const buySequence = args.steps.flatMap((step) =>
    step.execution.fills
      .filter((fill) => fill.action === "BUY")
      .map((fill) => fill.side),
  );
  const alternatingTransitionCount = buySequence.reduce((acc, side, index) => {
    if (index === 0) return 0;
    return acc + (buySequence[index - 1] !== side ? 1 : 0);
  }, 0);
  const clipBucketCounts: Record<ClipBucket, number> = {
    "1_5": 0,
    "6_10": 0,
    "11_15": 0,
    "16_30": 0,
    "31_plus": 0,
  };
  for (const fill of args.steps.flatMap((step) => step.execution.fills.filter((candidate) => candidate.action === "BUY"))) {
    clipBucketCounts[bucketClip(fill.size)] += 1;
  }

  const cycleCount = args.steps.filter((step) => step.execution.mergeShares > 0).length;
  const residualUp = args.finalUpShares;
  const residualDown = args.finalDownShares;
  const dominantResidualSide =
    residualUp === residualDown ? "FLAT" : residualUp > residualDown ? "UP" : "DOWN";
  const residualMagnitudeBucket = bucketResidualMagnitude(Math.max(residualUp, residualDown));
  const partialTs = firstPartialTimestamp(args.steps);
  const completionTs = firstCompletionTimestamp(args.steps);
  const latencySec =
    partialTs !== undefined && completionTs !== undefined && completionTs >= partialTs
      ? completionTs - partialTs
      : undefined;

  return {
    buySequence,
    alternatingTransitionCount,
    cycleCount,
    cycleBucket: bucketCycle(cycleCount),
    clipBucketCounts,
    mergeCount: cycleCount,
    partialRepairLatencyBucket: bucketRepairLatency(latencySec),
    dominantResidualSide,
    residualMagnitudeBucket,
  };
}
