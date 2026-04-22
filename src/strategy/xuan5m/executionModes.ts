export type StrategyExecutionMode =
  | "STRICT_PAIR_SWEEP"
  | "XUAN_SOFT_PAIR_SWEEP"
  | "XUAN_HARD_PAIR_SWEEP"
  | "PAIRGROUP_COVERED_SEED"
  | "PARTIAL_FAST_COMPLETION"
  | "PARTIAL_SOFT_COMPLETION"
  | "PARTIAL_EMERGENCY_COMPLETION"
  | "POST_MERGE_RESIDUAL_COMPLETION"
  | "UNWIND";

const CLASSIFIED_BUY_MODES: StrategyExecutionMode[] = [
  "STRICT_PAIR_SWEEP",
  "XUAN_SOFT_PAIR_SWEEP",
  "XUAN_HARD_PAIR_SWEEP",
  "PAIRGROUP_COVERED_SEED",
  "PARTIAL_FAST_COMPLETION",
  "PARTIAL_SOFT_COMPLETION",
  "PARTIAL_EMERGENCY_COMPLETION",
  "POST_MERGE_RESIDUAL_COMPLETION",
];

export function isClassifiedBuyMode(mode: string | undefined): mode is StrategyExecutionMode {
  return mode !== undefined && CLASSIFIED_BUY_MODES.includes(mode as StrategyExecutionMode);
}
