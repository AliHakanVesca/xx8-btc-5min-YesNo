import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Command } from "commander";
import { loadEnv } from "./config/env.js";
import { writeEnvUpdates } from "./config/envFile.js";
import { writeJson } from "./utils/fs.js";
import { createLogger, writeStructuredLog } from "./observability/logger.js";
import { analyzeXuanFile, writeXuanMarkdownReport } from "./infra/dataApi/xuanAnalyzer.js";
import { runSyntheticReplay } from "./analytics/replaySimulator.js";
import { runMultiSyntheticReplay } from "./analytics/multiReplay.js";
import { runLivePaperSession } from "./analytics/livePaper.js";
import {
  isPaperSessionVariant,
  paperSessionVariants,
  runPaperSession,
  type PaperSessionReport,
  type PaperSessionVariant,
} from "./analytics/paperSession.js";
import {
  buildCanonicalReferenceBundle,
  buildCanonicalReferenceFromPaperSession,
  loadCanonicalReferenceBundleFile,
  writeCanonicalReferenceBundle,
} from "./analytics/xuanCanonicalReference.js";
import { resolveBundledExactReferenceBundle } from "./analytics/xuanExactReference.js";
import {
  buildComparisonFlowSummary,
  buildFlowCalibrationSummary,
  classifyComparisonFlowSummary,
  compareCanonicalReference,
  XUAN_FLOW_CALIBRATION_VERSION,
  type ComparisonFlowSummary,
  type FlowCalibrationSummary,
} from "./analytics/xuanReplayComparator.js";
import {
  buildRuntimeCanonicalExtractBundle,
  toCanonicalReferenceBundle,
  writeRuntimeCanonicalExtractBundle,
} from "./analytics/runtimeCanonicalReference.js";
import { createClobAdapter } from "./infra/clob/index.js";
import { createOrDeriveActiveApiKey } from "./infra/clob/apiKeyLifecycle.js";
import { SystemClock } from "./infra/time/clock.js";
import { GammaClient } from "./infra/gamma/gammaClient.js";
import { buildOfflineMarket, discoverCurrentAndNextMarkets } from "./infra/gamma/marketDiscovery.js";
import { buildStrategyConfig } from "./config/strategyPresets.js";
import { createMarketState } from "./strategy/xuan5m/marketState.js";
import { buildSyntheticBook } from "./analytics/replaySimulator.js";
import { OrderBookState } from "./strategy/xuan5m/orderBookState.js";
import { Xuan5mBot } from "./strategy/xuan5m/Xuan5mBot.js";
import { OrderManager } from "./execution/orderManager.js";
import { TakerCompletionManager } from "./execution/takerCompletionManager.js";
import { CtfClient } from "./infra/ctf/ctfClient.js";
import { renderDashboard } from "./observability/dashboard.js";
import { runLiveCheck } from "./live/liveCheck.js";
import { runContinuousBotDaemon } from "./live/continuousBotDaemon.js";
import { runCaptureSession } from "./live/captureSession.js";
import {
  buildInventoryActionPlan,
  executeInventoryActionPlan,
  fetchInventorySnapshot,
  manageInventory,
} from "./live/inventoryManager.js";
import { PersistentStateStore } from "./live/persistentStateStore.js";
import { resolveConfiguredFunderAddress } from "./live/topology.js";
import { approveCollateralSpenders } from "./infra/polygon/collateralApproval.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extractFlowSummariesFromValidationRuns(
  runs: ReturnType<PersistentStateStore["recentValidationRuns"]>,
): ComparisonFlowSummary[] {
  const acceptedByFootprint = new Map<string, number>();
  return runs
    .filter(
      (run) => {
        if (
          run.payload?.flowCalibrationVersion !== XUAN_FLOW_CALIBRATION_VERSION ||
          run.payload?.flowCalibrationAccepted === false ||
          (run.payload?.flowStatus as { status?: unknown } | undefined)?.status === "FAIL"
        ) {
          return false;
        }
        const footprintKey = [
          String(run.payload?.command ?? "unknown"),
          String(run.payload?.variant ?? "runtime"),
          String(run.payload?.referenceSlug ?? run.payload?.marketSlug ?? "unknown"),
        ].join(":");
        const acceptedCount = acceptedByFootprint.get(footprintKey) ?? 0;
        if (acceptedCount >= 3) {
          return false;
        }
        acceptedByFootprint.set(footprintKey, acceptedCount + 1);
        return true;
      },
    )
    .map((run) => run.payload?.flowSummary)
    .filter((summary): summary is ComparisonFlowSummary => {
      if (!summary || typeof summary !== "object") {
        return false;
      }
      const candidate = summary as Partial<Record<keyof ComparisonFlowSummary, unknown>>;
      return (
        typeof candidate.flowLineageSimilarity === "number" &&
        typeof candidate.activeFlowPeakSimilarity === "number" &&
        typeof candidate.cycleCompletionLatencySimilarity === "number"
      );
    });
}

function completionPatienceMultiplierFromCalibration(
  calibration: Pick<
    FlowCalibrationSummary,
    | "status"
    | "recommendedFocus"
    | "completionLatencyDirection"
    | "averageCycleCompletionLatencyDeltaSec"
    | "averageCycleCompletionLatencyDeltaP50Sec"
    | "averageCycleCompletionLatencyDeltaP75Sec"
  >,
): number {
  if (calibration.status !== "WARN" && calibration.status !== "FAIL") {
    return 1;
  }
  const focus = new Set(calibration.recommendedFocus);
  const latencyDeltaSec = Math.abs(
    calibration.averageCycleCompletionLatencyDeltaP75Sec || calibration.averageCycleCompletionLatencyDeltaSec,
  );
  if (focus.has("collect_replay_flow_samples")) {
    return 0.63;
  }
  if (
    focus.has("tune_completion_patience_and_release") &&
    calibration.averageCycleCompletionLatencyDeltaP50Sec !== undefined &&
    Math.abs(calibration.averageCycleCompletionLatencyDeltaP50Sec) <= 2 &&
    latencyDeltaSec >= 4
  ) {
    return 0.63;
  }
  if (focus.has("release_completion_earlier") || calibration.completionLatencyDirection === "candidate_late") {
    if (
      calibration.averageCycleCompletionLatencyDeltaP50Sec !== undefined &&
      Math.abs(calibration.averageCycleCompletionLatencyDeltaP50Sec) <= 2 &&
      latencyDeltaSec >= 4
    ) {
      return 0.63;
    }
    return latencyDeltaSec >= 6 ? 0.25 : latencyDeltaSec >= 2 ? 0.55 : 0.75;
  }
  if (focus.has("increase_completion_patience") || calibration.completionLatencyDirection === "candidate_early") {
    return latencyDeltaSec >= 6 ? 1.28 : latencyDeltaSec >= 3 ? 1.2 : 1.12;
  }
  return 1;
}

function openingSeedTimingFromCalibration(
  calibration: Pick<
    FlowCalibrationSummary,
    | "status"
    | "recommendedFocus"
    | "openingEntryTimingDirection"
    | "averageFirstEntryOffsetDeltaSec"
  >,
): {
  openingSeedOffsetShiftSec: number;
  openingSeedReleaseBias: "neutral" | "earlier" | "later";
} {
  if (calibration.status !== "WARN" && calibration.status !== "FAIL") {
    return { openingSeedOffsetShiftSec: 0, openingSeedReleaseBias: "neutral" };
  }
  const focus = new Set(calibration.recommendedFocus);
  const coldStartCalibration = focus.has("collect_replay_flow_samples");
  const maintainEarlyOpening = focus.has("maintain_opening_seed_early");
  const releaseEarlier =
    focus.has("release_opening_seed_earlier") ||
    (calibration.openingEntryTimingDirection === "candidate_late" &&
      Math.abs(calibration.averageFirstEntryOffsetDeltaSec ?? 0) >= 4);
  const delayRelease =
    focus.has("delay_opening_seed_release") ||
    (calibration.openingEntryTimingDirection === "candidate_early" &&
      Math.abs(calibration.averageFirstEntryOffsetDeltaSec ?? 0) >= 4);
  const absoluteDeltaSec = Math.abs(calibration.averageFirstEntryOffsetDeltaSec ?? 0);
  if (coldStartCalibration || maintainEarlyOpening) {
    return { openingSeedOffsetShiftSec: 6, openingSeedReleaseBias: "earlier" };
  }
  if (releaseEarlier) {
    return {
      openingSeedOffsetShiftSec: Math.min(8, Math.max(6, Math.round(absoluteDeltaSec))),
      openingSeedReleaseBias: "earlier",
    };
  }
  if (delayRelease) {
    return {
      openingSeedOffsetShiftSec: -Math.min(8, Math.max(2, Math.round(absoluteDeltaSec))),
      openingSeedReleaseBias: "later",
    };
  }
  return { openingSeedOffsetShiftSec: 0, openingSeedReleaseBias: "neutral" };
}

function replayFlowCountBiasFromCalibration(
  calibration: Pick<
    FlowCalibrationSummary,
    | "status"
    | "recommendedFocus"
    | "averageSideSequenceMismatchOffsetDeltaSec"
    | "averageChildOrderGlobalAbsDelayP75Sec"
    | "averageChildOrderMicroTimingMaxAbsDeltaSec"
    | "averageChildOrderSideInversionCount"
  >,
): {
  recentSeedFlowCountBonus: number;
  activeIndependentFlowCountBonus: number;
  overlapSeedOffsetShiftSec: number;
  semanticRoleAlignmentBias: "neutral" | "align_high_low_role" | "preserve_raw_side" | "cycle_role_arbitration";
  childOrderMicroTimingBias: "neutral" | "flow_intent";
  completionRoleReleaseOrderBias: "neutral" | "role_order";
} {
  if (calibration.status !== "WARN" && calibration.status !== "FAIL") {
    return {
      recentSeedFlowCountBonus: 0,
      activeIndependentFlowCountBonus: 0,
      overlapSeedOffsetShiftSec: 0,
      semanticRoleAlignmentBias: "neutral",
      childOrderMicroTimingBias: "neutral",
      completionRoleReleaseOrderBias: "neutral",
    };
  }

  const focus = new Set(calibration.recommendedFocus);
  if (focus.has("collect_replay_flow_samples")) {
    return {
      recentSeedFlowCountBonus: 0,
      activeIndependentFlowCountBonus: 0,
      overlapSeedOffsetShiftSec: 0,
      semanticRoleAlignmentBias: "preserve_raw_side",
      childOrderMicroTimingBias: "neutral",
      completionRoleReleaseOrderBias: "neutral",
    };
  }
  const preserveRawSide =
    focus.has("preserve_raw_side_before_role_override") ||
    focus.has("guard_role_alignment_against_side_regression") ||
    focus.has("improve_seed_side_rhythm");
  const highLowRoleRequested =
    focus.has("align_high_low_role_sequence") ||
    focus.has("compress_high_low_role_rhythm") ||
    focus.has("tune_completion_role_release_order") ||
    focus.has("align_completion_release_role_sequence");
  const childOrderRequested =
    focus.has("improve_child_order_micro_timing") ||
    focus.has("compress_child_order_timing") ||
    focus.has("stabilize_child_order_side_rhythm") ||
    focus.has("tune_completion_role_release_order");
  const roleArbitration = preserveRawSide && highLowRoleRequested && childOrderRequested;
  const highLowRoleCompression = !preserveRawSide && highLowRoleRequested;
  const sideCadenceShiftSec = focus.has("compress_overlap_seed_rhythm")
    ? Math.ceil((calibration.averageSideSequenceMismatchOffsetDeltaSec ?? 0) * 0.4)
    : 0;
  const childOrderCadenceShiftSec = childOrderRequested
    ? Math.min(
        10,
        Math.ceil(
          Math.max(
            calibration.averageChildOrderGlobalAbsDelayP75Sec ?? 0,
            (calibration.averageChildOrderMicroTimingMaxAbsDeltaSec ?? 0) * 0.25,
          ),
        ),
      )
    : 0;
  const sideInversionPressure = (calibration.averageChildOrderSideInversionCount ?? 0) > 0 ? 1 : 0;

  return {
    recentSeedFlowCountBonus:
      (focus.has("increase_lineage_preservation") ? 1 : 0) +
      (focus.has("compress_overlap_seed_rhythm") ? 1 : 0) +
      (highLowRoleCompression ? 1 : 0) +
      sideInversionPressure,
    activeIndependentFlowCountBonus:
      focus.has("allow_more_parallel_flow_when_budget_supports") || highLowRoleCompression ? 1 : 0,
    overlapSeedOffsetShiftSec: Math.min(10, Math.max(0, sideCadenceShiftSec, childOrderCadenceShiftSec)),
    semanticRoleAlignmentBias: roleArbitration
      ? "cycle_role_arbitration"
      : preserveRawSide
      ? "preserve_raw_side"
      : highLowRoleCompression
        ? "align_high_low_role"
        : "neutral",
    childOrderMicroTimingBias: childOrderRequested ? "flow_intent" : "neutral",
    completionRoleReleaseOrderBias: focus.has("tune_completion_role_release_order") ? "role_order" : "neutral",
  };
}

function countBy(values: Array<string | null | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value && value.length > 0 ? value : "none";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildPaperStrategyTraceSummary(
  replay: PaperSessionReport,
  replayFlowCountBias: ReturnType<typeof replayFlowCountBiasFromCalibration>,
): {
  residualSeverity: Record<string, number>;
  overlapRepairArbitration: Record<string, number>;
  overlapRepairOutcome: Record<string, number>;
  sideRhythm: {
    decision: Record<string, number>;
    intendedSide: Record<string, number>;
    selectedSide: Record<string, number>;
    averageScoreDelta: number | null;
  };
  childOrder: {
    reason: Record<string, number>;
    intendedSide: Record<string, number>;
    selectedSide: Record<string, number>;
  };
  semanticRoleTarget: Record<string, number>;
  completionReleaseRole: Record<string, number>;
  completionPatience: {
    calibration: Record<string, number>;
    roleMultiplier: Record<string, number>;
    effectiveMultiplier: Record<string, number>;
    waitUntilSec: Record<string, number>;
  };
  seedSizingMode: Record<string, number>;
  repairSizingMode: Record<string, number>;
  flowBudget: {
    recentSeedFlowCountBonus: number;
    activeIndependentFlowCountBonus: number;
    overlapSeedOffsetShiftSec: number;
    semanticRoleAlignmentBias: string;
    childOrderMicroTimingBias: string;
    completionRoleReleaseOrderBias: string;
  };
  stickyCarry: {
    observable: boolean;
    reason: string;
  };
} {
  const traces = replay.steps.map((step) => step.decision.entryTrace).filter((trace) => trace !== undefined);
  const seedCandidates = traces.flatMap((trace) => trace.seedCandidates ?? []);
  const sideRhythmDeltas = traces
    .map((trace) => trace.sideRhythmScoreDelta)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  return {
    residualSeverity: countBy(traces.map((trace) => trace.residualSeverityLevel)),
    overlapRepairArbitration: countBy(traces.map((trace) => trace.overlapRepairArbitration)),
    overlapRepairOutcome: countBy(traces.map((trace) => trace.overlapRepairOutcome)),
    sideRhythm: {
      decision: countBy(traces.map((trace) => trace.sideRhythmDecision)),
      intendedSide: countBy(traces.map((trace) => trace.sideRhythmIntendedSide)),
      selectedSide: countBy(traces.map((trace) => trace.sideRhythmSelectedSide)),
      averageScoreDelta:
        sideRhythmDeltas.length > 0
          ? Number(
              (
                sideRhythmDeltas.reduce((sum, value) => sum + value, 0) / sideRhythmDeltas.length
              ).toFixed(6),
            )
          : null,
    },
    childOrder: {
      reason: countBy(traces.map((trace) => trace.childOrderReason)),
      intendedSide: countBy(traces.map((trace) => trace.childOrderIntendedSide)),
      selectedSide: countBy(traces.map((trace) => trace.childOrderSelectedSide)),
    },
    semanticRoleTarget: countBy(traces.map((trace) => trace.semanticRoleTarget)),
    completionReleaseRole: countBy([
      ...traces.map((trace) => trace.completionReleaseRole),
      ...replay.steps.map((step) => step.decision.completionReleaseRole),
    ]),
    completionPatience: {
      calibration: countBy([
        ...traces.map((trace) => trace.completionCalibrationPatienceMultiplier?.toFixed(2)),
        ...replay.steps.map((step) => step.decision.completionCalibrationPatienceMultiplier?.toFixed(2)),
      ]),
      roleMultiplier: countBy([
        ...traces.map((trace) => trace.completionRolePatienceMultiplier?.toFixed(2)),
        ...replay.steps.map((step) => step.decision.completionRolePatienceMultiplier?.toFixed(2)),
      ]),
      effectiveMultiplier: countBy([
        ...traces.map((trace) => trace.completionEffectivePatienceMultiplier?.toFixed(2)),
        ...replay.steps.map((step) => step.decision.completionEffectivePatienceMultiplier?.toFixed(2)),
      ]),
      waitUntilSec: countBy([
        ...traces.map((trace) => trace.completionWaitUntilSec?.toFixed(1)),
        ...replay.steps.map((step) => step.decision.completionWaitUntilSec?.toFixed(1)),
      ]),
    },
    seedSizingMode: countBy(seedCandidates.map((candidate) => candidate.sizingMode)),
    repairSizingMode: countBy(traces.map((trace) => trace.repairSizingMode)),
    flowBudget: {
      recentSeedFlowCountBonus: replayFlowCountBias.recentSeedFlowCountBonus,
      activeIndependentFlowCountBonus: replayFlowCountBias.activeIndependentFlowCountBonus,
      overlapSeedOffsetShiftSec: replayFlowCountBias.overlapSeedOffsetShiftSec,
      semanticRoleAlignmentBias: replayFlowCountBias.semanticRoleAlignmentBias,
      childOrderMicroTimingBias: replayFlowCountBias.childOrderMicroTimingBias,
      completionRoleReleaseOrderBias: replayFlowCountBias.completionRoleReleaseOrderBias,
    },
    stickyCarry: {
      observable: false,
      reason: "paper_session_trace_runtime_carry_persisted_state_disinda",
    },
  };
}

function isNoRuntimeFillStatus(
  diagnostics: {
    buyCount: number;
    lifecycleEventCount: number;
    runtimeDataStatus: string;
  } | undefined,
): boolean {
  return (
    diagnostics?.runtimeDataStatus === "no_runtime_fills" ||
    ((diagnostics?.buyCount ?? 0) === 0 && (diagnostics?.lifecycleEventCount ?? 0) === 0)
  );
}

function buildNoRuntimeFillsReportSummary(
  runtimeDataStatus: Record<string, unknown>,
  runtimeChildOrderDispatchStatus?: RuntimeChildOrderDispatchStatus | undefined,
): Record<string, unknown> {
  return {
    status: "NO_RUNTIME_FILLS",
    severity: "DATA_ABSENCE",
    finalVerdict: "WARN",
    operatorMessage:
      "Local runtime store has no BUY, merge, or redeem activity for this market; this is not a strategy failure.",
    runtimeDataStatus,
    ...(runtimeChildOrderDispatchStatus
      ? { runtimeChildOrderDispatch: runtimeChildOrderDispatchStatus }
      : {}),
  };
}

type RuntimeChildOrderDispatchStatus = {
  status: "PASS" | "WARN" | "SKIPPED";
  reasons: string[];
  summary: Record<string, unknown> | null;
};

function buildRuntimeChildOrderDispatchStatus(
  dispatch: Record<string, unknown> | undefined,
  options: { runtimeDataAbsent?: boolean; paperReplay?: boolean } = {},
): RuntimeChildOrderDispatchStatus {
  if (options.paperReplay) {
    return {
      status: "SKIPPED",
      reasons: ["paper_replay_has_no_runtime_child_order_dispatch"],
      summary: null,
    };
  }
  if (!dispatch) {
    return {
      status: "WARN",
      reasons: ["runtime_child_order_dispatch_missing"],
      summary: null,
    };
  }
  const pairSubmitCount = typeof dispatch.pairSubmitCount === "number" ? dispatch.pairSubmitCount : 0;
  const flowIntentPairSubmitCount =
    typeof dispatch.flowIntentPairSubmitCount === "number" ? dispatch.flowIntentPairSubmitCount : 0;
  const compressedPairSubmitCount =
    typeof dispatch.compressedPairSubmitCount === "number" ? dispatch.compressedPairSubmitCount : 0;
  const maxInterChildDelayMs =
    typeof dispatch.maxInterChildDelayMs === "number" ? dispatch.maxInterChildDelayMs : null;
  const reasons: string[] = [];
  if (pairSubmitCount === 0) {
    if (options.runtimeDataAbsent) {
      return {
        status: "SKIPPED",
        reasons: ["runtime_child_order_dispatch_not_applicable_no_runtime_fills"],
        summary: dispatch,
      };
    }
    reasons.push("runtime_child_order_dispatch_no_pair_submits");
  }
  if (flowIntentPairSubmitCount > 0 && compressedPairSubmitCount < flowIntentPairSubmitCount) {
    reasons.push("runtime_child_order_flow_intent_not_compressed");
  }
  if (maxInterChildDelayMs !== null && maxInterChildDelayMs > 40) {
    reasons.push("runtime_child_order_delay_above_xuan_cap");
  }
  return {
    status: reasons.length > 0 ? "WARN" : "PASS",
    reasons,
    summary: dispatch,
  };
}

function buildComparisonReportSummary(args: {
  verdict: string;
  score?: number | undefined;
  flowStatus: { status: string; reasons: string[] };
  exactLifecycleParityRequired?: boolean | undefined;
  exactLifecycleParityBroken?: boolean | undefined;
  runtimeChildOrderDispatchStatus?: RuntimeChildOrderDispatchStatus | undefined;
}): Record<string, unknown> {
  return {
    status: args.verdict,
    score: args.score ?? null,
    flowStatus: args.flowStatus.status,
    flowReasons: args.flowStatus.reasons,
    exactLifecycleParity: {
      required: Boolean(args.exactLifecycleParityRequired),
      broken: Boolean(args.exactLifecycleParityBroken),
      gate: args.exactLifecycleParityRequired ? "BUY_MERGE_REDEEM_CI_GATE" : "not_required",
    },
    ...(args.runtimeChildOrderDispatchStatus
      ? { runtimeChildOrderDispatch: args.runtimeChildOrderDispatchStatus }
      : {}),
  };
}

async function runAnalyzeXuan(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const preferredPath = "data/xuanxuan008_data_20260415_145447.json";
  const fallbackPath = "tests/fixtures/xuan_sample.json";
  const filePath = (await fileExists(preferredPath)) ? preferredPath : fallbackPath;

  if (filePath === fallbackPath) {
    logger.warn({ filePath }, "Real xuan export missing; using bundled fixture.");
  }

  const report = await analyzeXuanFile(filePath);
  const markdownPath = await writeXuanMarkdownReport(report);
  logger.info({ filePath, markdownPath, report }, "xuan analysis complete");
  console.log(JSON.stringify({ filePath, markdownPath, report }, null, 2));
}

const defaultXuanReferenceSlugs = [
  "btc-updown-5m-1776253500",
  "btc-updown-5m-1776248100",
  "btc-updown-5m-1776928800",
  "btc-updown-5m-1776253200",
  "btc-updown-5m-1776252300",
  "btc-updown-5m-1776247200",
];

const preferredXuanSqlitePath = "/Users/cakir/Documents/tmp/polymarket-wallet-sc/data/polymarket-wallets.sqlite";
const bundledCanonicalFixturePath = "tests/fixtures/xuan_public_sequence_bundle.json";

async function resolveDefaultXuanTradeTapePath(): Promise<string> {
  const preferredPath = "data/xuanxuan008_data_20260415_145447.json";
  const fallbackPath = "tests/fixtures/xuan_sample.json";
  return (await fileExists(preferredPath)) ? preferredPath : fallbackPath;
}

async function resolveDefaultXuanSqlitePath(): Promise<string | undefined> {
  return (await fileExists(preferredXuanSqlitePath)) ? preferredXuanSqlitePath : undefined;
}

async function resolveCanonicalReferenceBundleForSlug(options: {
  referenceSlug: string;
  jsonPath?: string | undefined;
  sqlitePath?: string | undefined;
  wallet?: string | undefined;
}) {
  const hasExplicitSource = Boolean(
    (options.jsonPath && options.jsonPath.length > 0) || (options.sqlitePath && options.sqlitePath.length > 0),
  );
  if (!hasExplicitSource) {
    const bundledExact = resolveBundledExactReferenceBundle(options.referenceSlug);
    if (bundledExact) {
      return bundledExact;
    }
  }
  if (!hasExplicitSource && (await fileExists(bundledCanonicalFixturePath))) {
    const bundled = await loadCanonicalReferenceBundleFile(bundledCanonicalFixturePath);
    if (bundled.references.some((item) => item.slug === options.referenceSlug)) {
      return bundled;
    }
  }

  const jsonPath = options.jsonPath && options.jsonPath.length > 0 ? options.jsonPath : await resolveDefaultXuanTradeTapePath();
  const sqlitePath =
    options.sqlitePath && options.sqlitePath.length > 0 ? options.sqlitePath : await resolveDefaultXuanSqlitePath();
  return buildCanonicalReferenceBundle({
    filePath: jsonPath,
    sqlitePath,
    wallet: options.wallet,
    slugs: [options.referenceSlug],
  });
}

async function runXuanExtractCommand(options: {
  jsonPath?: string;
  sqlitePath?: string;
  wallet?: string;
  slugs?: string[];
  out?: string;
}): Promise<void> {
  const jsonPath = options.jsonPath && options.jsonPath.length > 0 ? options.jsonPath : await resolveDefaultXuanTradeTapePath();
  const sqlitePath =
    options.sqlitePath && options.sqlitePath.length > 0 ? options.sqlitePath : await resolveDefaultXuanSqlitePath();
  const slugs = options.slugs && options.slugs.length > 0 ? options.slugs : defaultXuanReferenceSlugs;
  const bundle = await buildCanonicalReferenceBundle({
    filePath: jsonPath,
    sqlitePath,
    wallet: options.wallet,
    slugs,
  });
  const outputPath = await writeCanonicalReferenceBundle(bundle, options.out && options.out.length > 0 ? options.out : undefined);
  await writeStructuredLog("markets", {
    event: "xuan_canonical_extract",
    outputPath,
    sources: bundle.sources,
    slugs: bundle.slugs,
  });
  console.log(
    JSON.stringify(
      {
        outputPath,
        bundle,
      },
      null,
      2,
    ),
  );
}

async function runXuanComparePaperCommand(options: {
  variant: PaperSessionVariant | string;
  referenceSlug: string;
  jsonPath?: string;
  sqlitePath?: string;
  wallet?: string;
  out?: string;
  isolatedCalibration?: boolean;
}): Promise<void> {
  if (!isPaperSessionVariant(options.variant)) {
    throw new Error(`Gecersiz paper replay variant: ${options.variant}. Desteklenenler: ${paperSessionVariants.join(", ")}`);
  }
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const bundle = await resolveCanonicalReferenceBundleForSlug({
    referenceSlug: options.referenceSlug,
    jsonPath: options.jsonPath,
    sqlitePath: options.sqlitePath,
    wallet: options.wallet,
  });
  const reference = bundle.references.find((item) => item.slug === options.referenceSlug);
  if (!reference) {
    throw new Error(`Canonical reference bulunamadi: ${options.referenceSlug}`);
  }

  const isolatedCalibration = Boolean(options.isolatedCalibration);
  const stateStore = isolatedCalibration ? undefined : new PersistentStateStore(config.stateStorePath);
  const preReplayFlowCalibration = buildFlowCalibrationSummary(
    stateStore ? extractFlowSummariesFromValidationRuns(stateStore.recentValidationRuns("replay", 12)) : [],
  );
  const openingSeedTiming = openingSeedTimingFromCalibration(preReplayFlowCalibration);
  const replayFlowCountBias = replayFlowCountBiasFromCalibration(preReplayFlowCalibration);
  const replay = runPaperSession(env, options.variant, {
    completionPatienceMultiplier: completionPatienceMultiplierFromCalibration(preReplayFlowCalibration),
    ...openingSeedTiming,
    ...replayFlowCountBias,
    mergeCohortCompression: preReplayFlowCalibration.status === "WARN" || preReplayFlowCalibration.status === "FAIL",
    orderPriorityAwareFill: replayFlowCountBias.semanticRoleAlignmentBias === "align_high_low_role",
  });
  const strategyTraceSummary = buildPaperStrategyTraceSummary(replay, replayFlowCountBias);
  const candidate = buildCanonicalReferenceFromPaperSession(replay);
  const comparison = compareCanonicalReference(reference, { ...candidate, slug: reference.slug });
  const flowSummary = buildComparisonFlowSummary(comparison);
  const flowStatus = classifyComparisonFlowSummary(flowSummary);
  const runtimeChildOrderDispatchStatus = buildRuntimeChildOrderDispatchStatus(undefined, { paperReplay: true });
  const flowCalibrationAccepted = comparison.verdict !== "FAIL" && flowStatus.status !== "FAIL";
  if (stateStore) {
    stateStore.recordValidationRun({
      kind: "replay",
      status: comparison.verdict.toLowerCase(),
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        command: "xuan:compare-paper",
        variant: options.variant,
        referenceSlug: options.referenceSlug,
        score: comparison.score,
        verdict: comparison.verdict,
        flowCalibrationVersion: XUAN_FLOW_CALIBRATION_VERSION,
        flowCalibrationAccepted,
        preReplayFlowCalibration,
        strategyTraceSummary,
        flowSummary,
        flowStatus,
        runtimeChildOrderDispatchStatus,
      },
    });
  }
  const flowCalibration = stateStore
    ? buildFlowCalibrationSummary(
        extractFlowSummariesFromValidationRuns(stateStore.recentValidationRuns("replay", 12)),
      )
    : buildFlowCalibrationSummary([flowSummary]);
  stateStore?.close();

  const output = {
    reference,
    candidate,
    comparison,
    flowSummary,
    flowStatus,
    runtimeChildOrderDispatchStatus,
    flowCalibration,
    preReplayFlowCalibration,
    strategyTraceSummary,
    reportSummary: buildComparisonReportSummary({
      verdict: comparison.verdict,
      score: comparison.score,
      flowStatus,
      runtimeChildOrderDispatchStatus,
      exactLifecycleParityRequired: comparison.details.exactLifecycleParityRequired,
      exactLifecycleParityBroken: comparison.details.exactLifecycleParityBroken,
    }),
    isolatedCalibration,
    sources: bundle.sources,
  };
  const outputPath = options.out && options.out.length > 0 ? options.out : `reports/xuan_compare_${options.variant}_${options.referenceSlug}.json`;
  await writeStructuredLog("markets", {
    event: "xuan_compare_paper",
    referenceSlug: options.referenceSlug,
    variant: options.variant,
    verdict: comparison.verdict,
    score: comparison.score,
    flowSummary,
    flowStatus,
    runtimeChildOrderDispatchStatus,
    flowCalibration,
    preReplayFlowCalibration,
    strategyTraceSummary,
    reportSummary: output.reportSummary,
    isolatedCalibration,
  });
  await writeJson(outputPath, output);
  console.log(JSON.stringify({ outputPath, output }, null, 2));
  if (comparison.verdict === "FAIL") {
    process.exitCode = 1;
  }
}

async function runXuanExtractRuntimeCommand(options: {
  stateDbPath?: string;
  logsDir?: string;
  marketSlugs?: string[];
  out?: string;
}): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const bundle = await buildRuntimeCanonicalExtractBundle({
    stateDbPath: options.stateDbPath && options.stateDbPath.length > 0 ? options.stateDbPath : config.stateStorePath,
    logsDir: options.logsDir,
    marketSlugs: options.marketSlugs,
  });
  const outputPath = await writeRuntimeCanonicalExtractBundle(
    bundle,
    options.out && options.out.length > 0 ? options.out : undefined,
  );
  await writeStructuredLog("markets", {
    event: "runtime_canonical_extract",
    outputPath,
    sources: bundle.sources,
    slugs: bundle.slugs,
  });
  console.log(
    JSON.stringify(
      {
        outputPath,
        bundle,
      },
      null,
      2,
    ),
  );
}

async function runXuanCompareRuntimeCommand(options: {
  referenceSlug: string;
  marketSlug: string;
  jsonPath?: string;
  sqlitePath?: string;
  wallet?: string;
  stateDbPath?: string;
  logsDir?: string;
  out?: string;
}): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const referenceBundle = await resolveCanonicalReferenceBundleForSlug({
    referenceSlug: options.referenceSlug,
    jsonPath: options.jsonPath,
    sqlitePath: options.sqlitePath,
    wallet: options.wallet,
  });
  const reference = referenceBundle.references.find((item) => item.slug === options.referenceSlug);
  if (!reference) {
    throw new Error(`Canonical reference bulunamadi: ${options.referenceSlug}`);
  }

  const runtimeBundle = await buildRuntimeCanonicalExtractBundle({
    stateDbPath: options.stateDbPath && options.stateDbPath.length > 0 ? options.stateDbPath : config.stateStorePath,
    logsDir: options.logsDir,
    marketSlugs: [options.marketSlug],
  });
  const candidate = runtimeBundle.references.find((item) => item.slug === options.marketSlug);
  if (!candidate) {
    throw new Error(`Runtime canonical candidate bulunamadi: ${options.marketSlug}`);
  }
  const runtimeDiagnostics = runtimeBundle.diagnosticsBySlug[options.marketSlug];
  const runtimeChildOrderDispatch =
    runtimeDiagnostics?.childOrderDispatch as Record<string, unknown> | undefined;
  const runtimeDataAbsent = isNoRuntimeFillStatus(runtimeDiagnostics);
  const runtimeChildOrderDispatchStatus = buildRuntimeChildOrderDispatchStatus(runtimeChildOrderDispatch, {
    runtimeDataAbsent,
  });
  if (runtimeDataAbsent) {
    const runtimeDataStatus = {
      status: "NO_RUNTIME_FILLS",
      reason: "local_sqlite_has_no_buy_merge_or_redeem_activity_for_market",
      marketSlug: options.marketSlug,
      diagnostics: runtimeDiagnostics,
    };
    const stateStore = new PersistentStateStore(config.stateStorePath);
    stateStore.recordValidationRun({
      kind: "replay",
      status: "no_runtime_fills",
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        command: "xuan:compare-runtime",
        referenceSlug: options.referenceSlug,
        marketSlug: options.marketSlug,
        verdict: "NO_RUNTIME_FILLS",
        flowCalibrationVersion: XUAN_FLOW_CALIBRATION_VERSION,
        flowCalibrationAccepted: false,
        runtimeDataStatus,
        runtimeChildOrderDispatch,
        runtimeChildOrderDispatchStatus,
      },
    });
    const flowCalibration = buildFlowCalibrationSummary(
      extractFlowSummariesFromValidationRuns(stateStore.recentValidationRuns("replay", 12)),
    );
    stateStore.close();
    const output = {
      referenceBundle,
      runtimeBundle,
      candidateBundle: toCanonicalReferenceBundle(runtimeBundle),
      runtimeDataStatus,
      comparison: null,
      flowSummary: null,
      flowStatus: {
        status: "WARN",
        reasons: ["no_runtime_fills"],
      },
      runtimeChildOrderDispatch,
      runtimeChildOrderDispatchStatus,
      flowCalibration,
      reportSummary: buildNoRuntimeFillsReportSummary(runtimeDataStatus, runtimeChildOrderDispatchStatus),
    };
    const outputPath =
      options.out && options.out.length > 0
        ? options.out
        : `reports/xuan_compare_runtime_${options.marketSlug}_vs_${options.referenceSlug}.json`;
    await writeStructuredLog("markets", {
      event: "xuan_compare_runtime",
      referenceSlug: options.referenceSlug,
      marketSlug: options.marketSlug,
      verdict: "NO_RUNTIME_FILLS",
      runtimeDataStatus,
      runtimeChildOrderDispatch,
      runtimeChildOrderDispatchStatus,
      flowCalibration,
      reportSummary: output.reportSummary,
    });
    await writeJson(outputPath, output);
    console.log(JSON.stringify({ outputPath, output }, null, 2));
    return;
  }

  const comparison = compareCanonicalReference(reference, candidate, {
    hardFails: runtimeBundle.hardFailsBySlug[options.marketSlug],
    requireExactLifecycleParity: options.referenceSlug === "btc-updown-5m-1776253500",
  });
  const flowSummary = buildComparisonFlowSummary(comparison);
  const flowStatus = classifyComparisonFlowSummary(flowSummary);
  const flowCalibrationAccepted = comparison.verdict !== "FAIL" && flowStatus.status !== "FAIL";
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "replay",
    status: comparison.verdict.toLowerCase(),
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "xuan:compare-runtime",
      referenceSlug: options.referenceSlug,
      marketSlug: options.marketSlug,
      score: comparison.score,
      verdict: comparison.verdict,
      flowCalibrationVersion: XUAN_FLOW_CALIBRATION_VERSION,
      flowCalibrationAccepted,
      flowSummary,
      flowStatus,
      runtimeChildOrderDispatch,
      runtimeChildOrderDispatchStatus,
    },
  });
  const flowCalibration = buildFlowCalibrationSummary(
    extractFlowSummariesFromValidationRuns(stateStore.recentValidationRuns("replay", 12)),
  );
  stateStore.close();

  const output = {
    referenceBundle,
    runtimeBundle,
    candidateBundle: toCanonicalReferenceBundle(runtimeBundle),
    comparison,
    flowSummary,
    flowStatus,
    runtimeChildOrderDispatch,
    runtimeChildOrderDispatchStatus,
    flowCalibration,
    reportSummary: buildComparisonReportSummary({
      verdict: comparison.verdict,
      score: comparison.score,
      flowStatus,
      exactLifecycleParityRequired: comparison.details.exactLifecycleParityRequired,
      exactLifecycleParityBroken: comparison.details.exactLifecycleParityBroken,
    }),
  };
  const outputPath =
    options.out && options.out.length > 0
      ? options.out
      : `reports/xuan_compare_runtime_${options.marketSlug}_vs_${options.referenceSlug}.json`;
  await writeStructuredLog("markets", {
    event: "xuan_compare_runtime",
    referenceSlug: options.referenceSlug,
    marketSlug: options.marketSlug,
    verdict: comparison.verdict,
    score: comparison.score,
    flowSummary,
    flowStatus,
    runtimeChildOrderDispatch,
    runtimeChildOrderDispatchStatus,
    flowCalibration,
    reportSummary: output.reportSummary,
  });
  await writeJson(outputPath, output);
  console.log(JSON.stringify({ outputPath, output }, null, 2));
  if (comparison.verdict === "FAIL") {
    process.exitCode = 1;
  }
}

async function runPaper(): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const replay = runSyntheticReplay(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "paper",
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "paper",
      marketSlug: replay.marketSlug,
    },
  });
  stateStore.close();
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    replay,
  };
  await writeStructuredLog("markets", payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function runPaperMulti(options: { windows: number }): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const replay = runMultiSyntheticReplay(env, options.windows);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "paper",
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "paper:multi",
      windows: options.windows,
      scenarioCount: replay.scenarios.length,
    },
  });
  stateStore.close();
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    replay,
  };
  await writeStructuredLog("markets", { event: "paper_multi", ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

async function runPaperSessionCommand(options: { variant: PaperSessionVariant }): Promise<void> {
  if (!isPaperSessionVariant(options.variant)) {
    throw new Error(`Gecersiz paper replay variant: ${options.variant}. Desteklenenler: ${paperSessionVariants.join(", ")}`);
  }
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const replay = runPaperSession(env, options.variant);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordValidationRun({
    kind: "paper",
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      command: "paper:session",
      variant: options.variant,
      marketSlug: replay.market.slug,
    },
  });
  stateStore.close();
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    replay,
  };
  await writeStructuredLog("markets", { event: "paper_session", ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

async function runPaperLive(options: {
  durationSec: number;
  sampleMs: number;
  initialBookWaitMs: number;
}): Promise<void> {
  const env = loadEnv();
  const report = await runLivePaperSession(env, options);
  const payload = {
    runtime: {
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
    },
    report,
  };
  await writeStructuredLog("markets", { event: "paper_live", ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

async function runConfigShow(): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  console.log(
    JSON.stringify(
      {
        botMode: env.BOT_MODE,
        stackMode: env.POLY_STACK_MODE,
        useClobV2: env.USE_CLOB_V2,
        clobBaseUrl: env.POLY_CLOB_BASE_URL,
        marketWsUrl: env.POLY_MARKET_WS_URL,
        userWsUrl: env.POLY_USER_WS_URL,
        signatureType: env.POLY_SIGNATURE_TYPE,
        funder: env.POLY_FUNDER,
        activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
        activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
        dryRun: env.DRY_RUN,
        strategy: {
          stateStore: config.stateStore,
          stateStorePath: config.stateStorePath,
          priceToBeatPolicy: config.priceToBeatPolicy,
          enableMakerLayer: config.enableMakerLayer,
          entryTakerBuyEnabled: config.entryTakerBuyEnabled,
          entryTakerPairCap: config.entryTakerPairCap,
          completionCap: config.completionCap,
          minEdgePerShare: config.minEdgePerShare,
          strictPairEffectiveCap: config.strictPairEffectiveCap,
          normalPairEffectiveCap: config.normalPairEffectiveCap,
          completionSoftCap: config.completionSoftCap,
          completionHardCap: config.completionHardCap,
          emergencyCompletionMaxQty: config.emergencyCompletionMaxQty,
          maxNegativeEdgePerMarketUsdc: config.maxNegativeEdgePerMarketUsdc,
          maxMarketExposureShares: config.maxMarketExposureShares,
          softImbalanceRatio: config.softImbalanceRatio,
          hardImbalanceRatio: config.hardImbalanceRatio,
          partialFastWindowSec: config.partialFastWindowSec,
          partialSoftWindowSec: config.partialSoftWindowSec,
          partialPatientWindowSec: config.partialPatientWindowSec,
          partialFastCap: config.partialFastCap,
          partialSoftCap: config.partialSoftCap,
          partialHardCap: config.partialHardCap,
          partialEmergencyCap: config.partialEmergencyCap,
          lotLadder: config.lotLadder,
          xuanBaseLotLadder: config.xuanBaseLotLadder,
          liveSmallLots: config.liveSmallLotLadder,
          defaultLot: config.defaultLot,
          rejectUnclassifiedBuy: config.rejectUnclassifiedBuy,
          requireManualResumeConfirm: config.requireManualResumeConfirm,
          mergeMinShares: config.mergeMinShares,
          maxMarketSharesPerSide: config.maxMarketSharesPerSide,
          maxOneSidedExposureShares: config.maxOneSidedExposureShares,
          maxImbalanceFrac: config.maxImbalanceFrac,
          forceRebalanceImbalanceFrac: config.forceRebalanceImbalanceFrac,
          rebalanceLeadingFraction: config.rebalanceLeadingFraction,
          rebalanceMaxLaggingMultiplier: config.rebalanceMaxLaggingMultiplier,
          maxCyclesPerMarket: config.maxCyclesPerMarket,
          maxBuysPerSide: config.maxBuysPerSide,
          enterFromOpenSecMin: config.enterFromOpenSecMin,
          enterFromOpenSecMax: config.enterFromOpenSecMax,
          normalEntryCutoffSecToClose: config.normalEntryCutoffSecToClose,
          completionOnlyCutoffSecToClose: config.completionOnlyCutoffSecToClose,
          hardCancelSecToClose: config.hardCancelSecToClose,
          partialCompletionFractions: config.partialCompletionFractions,
          maxResidualHoldShares: config.maxResidualHoldShares,
          residualUnwindSecToClose: config.residualUnwindSecToClose,
          sellUnwindEnabled: config.sellUnwindEnabled,
          dailyMaxLossUsdc: config.dailyMaxLossUsdc,
          marketMaxLossUsdc: config.marketMaxLossUsdc,
          minUsdcBalance: config.minUsdcBalance,
        },
      },
      null,
      2,
    ),
  );
}

async function runCaptureCommand(options: {
  durationSec: number;
  initialBookWaitMs: number;
}): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const report = await runCaptureSession(env, {
    durationSec: options.durationSec,
    initialBookWaitMs: options.initialBookWaitMs,
  });
  await writeStructuredLog("system", { event: "capture_session", report });
  console.log(JSON.stringify(report, null, 2));
}

function redactSecret(value: string): string {
  if (value.length <= 10) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function runClobDerive(options: { writeEnv?: boolean; envFile: string }): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const result = await createOrDeriveActiveApiKey(env);

  if (options.writeEnv) {
    await writeEnvUpdates(options.envFile, {
      POLY_API_KEY: result.creds.key,
      POLY_API_SECRET: result.creds.secret,
      POLY_API_PASSPHRASE: result.creds.passphrase,
    });
  }

  console.log(
    JSON.stringify(
      {
        stackMode: env.POLY_STACK_MODE,
        adapterVersion: result.adapterVersion,
        host: result.host,
        signerAddress: result.signerAddress,
        signatureType: result.signatureType,
        funder: result.funder,
        wroteEnv: options.writeEnv ?? false,
        envFile: options.writeEnv ? options.envFile : undefined,
        creds: {
          key: redactSecret(result.creds.key),
          secret: redactSecret(result.creds.secret),
          passphrase: redactSecret(result.creds.passphrase),
        },
      },
      null,
      2,
    ),
  );
}

async function runBotOnce(mode: "dry" | "live"): Promise<void> {
  const env = loadEnv();
  if (mode === "dry" && !env.DRY_RUN) {
    throw new Error("bot:dry icin DRY_RUN=true olmali. Canli emir icin bot:live kullan.");
  }
  if (mode === "live" && env.DRY_RUN) {
    throw new Error("bot:live icin once DRY_RUN=false yap.");
  }

  const logger = createLogger(env);
  const clob = createClobAdapter(env);
  const clock = new SystemClock();
  const gamma = new GammaClient(env);
  const config = buildStrategyConfig(env);

  let market = buildOfflineMarket(Math.floor(clock.now() / 300) * 300);
  try {
    const discovery = await discoverCurrentAndNextMarkets({ env, gammaClient: gamma, clob, clock });
    market = discovery.current;
  } catch (error) {
    logger.warn({ error }, "Live discovery failed, using offline market.");
  }

  const state = createMarketState(market);
  const bot = new Xuan5mBot();
  const nowTs = clock.now();
  const decision = bot.evaluateTick({
    config,
    state,
    books: new OrderBookState(
      buildSyntheticBook(market.tokens.UP.tokenId, market.conditionId, 0.48, 0.49),
      buildSyntheticBook(market.tokens.DOWN.tokenId, market.conditionId, 0.48, 0.49),
    ),
    nowTs,
    riskContext: {
      secsToClose: market.endTs - nowTs,
      staleBookMs: 200,
      balanceStaleMs: 200,
      bookIsCrossed: false,
      dailyLossUsdc: 0,
      marketLossUsdc: 0,
      usdcBalance: 100,
    },
    dryRunOrSmallLive: true,
  });

  const orderManager = new OrderManager(clob);
  const completionManager = new TakerCompletionManager(orderManager);
  const ctf = new CtfClient(env);

  const entryBuys =
    decision.entryBuys.length > 0
      ? await Promise.all(decision.entryBuys.map((entryBuy) => completionManager.execute(entryBuy.order)))
      : [];
  const completion = decision.completion ? await completionManager.complete(decision.completion.order) : null;
  const unwind = decision.unwind && !decision.completion ? await completionManager.complete(decision.unwind.order) : null;
  const merge =
    decision.mergeShares <= 0
      ? null
      : !env.CTF_MERGE_ENABLED
        ? {
            simulated: true,
            skipped: true,
            action: "merge" as const,
            amount: decision.mergeShares,
            conditionId: market.conditionId,
            reason: "CTF_MERGE_ENABLED=false",
          }
        : await ctf.mergePositions(market.conditionId, decision.mergeShares);
  const redeem =
    merge && !merge.skipped && env.CTF_AUTO_REDEEM_ENABLED
      ? await ctf.redeemPositions(market.conditionId)
      : null;

  const payload = {
    runtime: {
      mode,
      stackMode: env.POLY_STACK_MODE,
      useClobV2: env.USE_CLOB_V2,
      clobBaseUrl: env.POLY_CLOB_BASE_URL,
      signatureType: env.POLY_SIGNATURE_TYPE,
      funder: env.POLY_FUNDER,
      activeCollateralToken: env.ACTIVE_COLLATERAL_TOKEN,
      activeCollateralSymbol: env.ACTIVE_COLLATERAL_SYMBOL,
      ctfMergeEnabled: env.CTF_MERGE_ENABLED,
      ctfAutoRedeemEnabled: env.CTF_AUTO_REDEEM_ENABLED,
    },
    market: market.slug,
    decision,
    entryBuys,
    completion,
    unwind,
    merge,
    redeem,
    dashboard: renderDashboard(state, decision, nowTs),
  };

  await writeStructuredLog("orders", payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function runBotDry(): Promise<void> {
  await runBotOnce("dry");
}

async function runBotLive(options: {
  durationSec: number;
  postCloseReconcileSec?: number;
  tickMs: number;
  initialBookWaitMs: number;
  balanceSyncMs: number;
  maxMarkets: number;
  interSessionPauseMs: number;
  marketSelection: "auto" | "current" | "next";
}): Promise<void> {
  const env = loadEnv();
  if (env.DRY_RUN) {
    throw new Error("bot:live icin once DRY_RUN=false yap.");
  }

  const postCloseOptions =
    options.postCloseReconcileSec === undefined
      ? {}
      : { postCloseReconcileSec: options.postCloseReconcileSec };
  const report = await runContinuousBotDaemon(env, {
    durationSec: options.durationSec,
    ...postCloseOptions,
    tickMs: options.tickMs,
    initialBookWaitMs: options.initialBookWaitMs,
    balanceSyncMs: options.balanceSyncMs,
    maxMarkets: options.maxMarkets,
    interSessionPauseMs: options.interSessionPauseMs,
    marketSelection: options.marketSelection,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runLiveCheckCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const report = await runLiveCheck(env);
  await writeStructuredLog("system", { event: "live_check", report });
  console.log(JSON.stringify(report, null, 2));
}

async function runInventoryReportCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const config = buildStrategyConfig(env);
  const snapshot = await fetchInventorySnapshot(env, config);
  await writeStructuredLog("inventory_snapshots", { event: "inventory_report", snapshot });
  console.log(JSON.stringify(snapshot, null, 2));
}

async function runInventoryReconcileCommand(): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const config = buildStrategyConfig(env);
  const snapshot = await fetchInventorySnapshot(env, config);
  const plan = buildInventoryActionPlan(snapshot, config);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  stateStore.recordReconcileRun({
    scope: "inventory_reconcile_cli",
    marketSlug: snapshot.currentMarket?.slug,
    conditionId: snapshot.currentMarket?.conditionId,
    timestamp: Math.floor(Date.now() / 1000),
    status: "ok",
    requiresManualResume: false,
    mismatchShares: 0,
    payload: {
      blockNewEntries: plan.blockNewEntries,
      blockReasons: plan.blockReasons,
      marketCount: snapshot.markets.length,
    },
  });
  const payload = { snapshot, plan };
  await writeStructuredLog("inventory_snapshots", { event: "inventory_reconcile", ...payload });
  stateStore.close();
  console.log(JSON.stringify(payload, null, 2));
}

async function runBotResumeCommand(options: { confirm?: boolean }): Promise<void> {
  const env = loadEnv({ enforceLiveRequirements: false });
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);
  const halt = stateStore.loadSafeHalt();
  const latestReconcile = stateStore.latestReconcileRun();

  if (!halt.active) {
    stateStore.close();
    console.log(JSON.stringify({ resumed: false, reason: "safe_halt_not_active" }, null, 2));
    return;
  }

  if (!options.confirm) {
    stateStore.close();
    throw new Error("bot:resume icin --confirm zorunlu.");
  }

  if (!latestReconcile || (halt.updatedAt !== undefined && latestReconcile.timestamp < halt.updatedAt)) {
    stateStore.close();
    throw new Error("SAFE_HALT kaldirmadan once npm run inventory:reconcile calistirilmali.");
  }

  stateStore.setSafeHalt({
    active: false,
    reason: "manual_resume_confirmed",
    timestamp: Math.floor(Date.now() / 1000),
  });
  stateStore.recordReconcileRun({
    scope: "bot_resume_cli",
    timestamp: Math.floor(Date.now() / 1000),
    status: "resume_confirmed",
    requiresManualResume: false,
    payload: {
      wallet: resolveConfiguredFunderAddress(env),
    },
  });
  stateStore.close();
  console.log(JSON.stringify({ resumed: true, stateDbPath: config.stateStorePath }, null, 2));
}

async function runInventoryActionCommand(action: "merge" | "redeem" | "manage"): Promise<void> {
  const env = loadEnv();
  const config = buildStrategyConfig(env);
  const stateStore = new PersistentStateStore(config.stateStorePath);

  if (action === "manage") {
    const report = await manageInventory(env, config);
    for (const item of report.actions) {
      stateStore.recordMergeRedeemEvent({
        marketSlug: item.slug,
        conditionId: item.conditionId,
        action: item.type,
        amount: item.amount,
        timestamp: Math.floor(Date.now() / 1000),
        simulated: item.result.simulated,
        reason: item.reason,
        txHash: item.result.txHash,
      });
    }
    await writeStructuredLog("merge_redeem", { event: "inventory_manage", report });
    stateStore.close();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const snapshot = await fetchInventorySnapshot(env, config);
  const plan = buildInventoryActionPlan(snapshot, config);
  const filteredPlan = {
    ...plan,
    redeem: action === "redeem" ? plan.redeem : [],
    merge: action === "merge" ? plan.merge : [],
  };
  const actions = await executeInventoryActionPlan(env, filteredPlan, config);
  for (const item of actions) {
    stateStore.recordMergeRedeemEvent({
      marketSlug: item.slug,
      conditionId: item.conditionId,
      action: item.type,
      amount: item.amount,
      timestamp: Math.floor(Date.now() / 1000),
      simulated: item.result.simulated,
      reason: item.reason,
      txHash: item.result.txHash,
    });
  }
  const payload = {
    before: snapshot,
    plan: filteredPlan,
    actions,
    after: await fetchInventorySnapshot(env, config),
  };
  await writeStructuredLog("merge_redeem", { event: `inventory_${action}_only`, ...payload });
  stateStore.close();
  console.log(JSON.stringify(payload, null, 2));
}

async function runCollateralApproveCommand(): Promise<void> {
  const env = loadEnv();
  const approvals = await approveCollateralSpenders(env);
  await writeStructuredLog("system", { event: "collateral_approve", approvals });
  console.log(
    JSON.stringify(
      {
        token: env.ACTIVE_COLLATERAL_TOKEN,
        approvals,
      },
      null,
      2,
    ),
  );
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program.name("xx8-btc-5min-yesno");
  program.command("config:show").action(async () => runConfigShow());
  program.command("live:check").action(async () => runLiveCheckCommand());
  program.command("collateral:approve").action(async () => runCollateralApproveCommand());
  program.command("inventory:report").action(async () => runInventoryReportCommand());
  program.command("inventory:reconcile").action(async () => runInventoryReconcileCommand());
  program.command("inventory:merge-only").action(async () => runInventoryActionCommand("merge"));
  program.command("inventory:redeem-only").action(async () => runInventoryActionCommand("redeem"));
  program.command("inventory:manage").action(async () => runInventoryActionCommand("manage"));
  program
    .command("bot:resume")
    .option("--confirm", "Clear persisted SAFE_HALT after manual reconcile")
    .action(async (options: { confirm?: boolean }) => runBotResumeCommand(options));
  program
    .command("capture")
    .option("--duration-sec <n>", "Capture current+next market feeds for N seconds", "75")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .action(async (options: { durationSec: string; initialBookWaitMs: string }) =>
      runCaptureCommand({
        durationSec: Number(options.durationSec),
        initialBookWaitMs: Number(options.initialBookWaitMs),
      }),
    );
  program
    .command("clob:derive")
    .option("--write-env", "Write derived POLY_API_* values into the env file")
    .option("--env-file <path>", "Env file path to update", ".env")
    .action(async (options: { writeEnv?: boolean; envFile: string }) => runClobDerive(options));
  program.command("analyze:xuan").action(async () => runAnalyzeXuan());
  program
    .command("xuan:extract")
    .option("--json-path <path>", "Trade tape JSON path")
    .option("--sqlite-path <path>", "Lifecycle authority SQLite path")
    .option("--wallet <address>", "Wallet/proxy address override")
    .option("--slugs <items...>", "Reference slug list")
    .option("--out <path>", "Output bundle path")
    .action(
      async (options: {
        jsonPath?: string;
        sqlitePath?: string;
        wallet?: string;
        slugs?: string[];
        out?: string;
      }) => runXuanExtractCommand(options),
    );
  program
    .command("xuan:compare-paper")
    .option("--variant <name>", "Synthetic session profile: xuan-flow | blocked-completion", "xuan-flow")
    .option("--reference-slug <slug>", "Canonical reference slug", defaultXuanReferenceSlugs[0])
    .option("--json-path <path>", "Trade tape JSON path")
    .option("--sqlite-path <path>", "Lifecycle authority SQLite path")
    .option("--wallet <address>", "Wallet/proxy address override")
    .option("--out <path>", "Output comparison path")
    .option("--isolated-calibration", "Do not read or write replay calibration history")
    .action(
      async (options: {
        variant: PaperSessionVariant;
        referenceSlug: string;
        jsonPath?: string;
        sqlitePath?: string;
        wallet?: string;
        out?: string;
        isolatedCalibration?: boolean;
      }) => runXuanComparePaperCommand(options),
    );
  program
    .command("xuan:extract-runtime")
    .option("--state-db-path <path>", "Runtime/state SQLite path")
    .option("--logs-dir <path>", "JSONL logs directory")
    .option("--market-slugs <items...>", "Runtime market slug list")
    .option("--out <path>", "Output bundle path")
    .action(
      async (options: {
        stateDbPath?: string;
        logsDir?: string;
        marketSlugs?: string[];
        out?: string;
      }) => runXuanExtractRuntimeCommand(options),
    );
  program
    .command("xuan:compare-runtime")
    .option("--reference-slug <slug>", "Canonical reference slug", defaultXuanReferenceSlugs[0])
    .requiredOption("--market-slug <slug>", "Runtime market slug")
    .option("--json-path <path>", "Trade tape JSON path")
    .option("--sqlite-path <path>", "Lifecycle authority SQLite path")
    .option("--wallet <address>", "Wallet/proxy address override")
    .option("--state-db-path <path>", "Runtime/state SQLite path")
    .option("--logs-dir <path>", "JSONL logs directory")
    .option("--out <path>", "Output comparison path")
    .action(
      async (options: {
        referenceSlug: string;
        marketSlug: string;
        jsonPath?: string;
        sqlitePath?: string;
        wallet?: string;
        stateDbPath?: string;
        logsDir?: string;
        out?: string;
      }) => runXuanCompareRuntimeCommand(options),
    );
  program.command("paper").action(async () => runPaper());
  program
    .command("paper:multi")
    .option("--windows <n>", "Number of offline 5m windows to simulate", "3")
    .action(async (options: { windows: string }) => runPaperMulti({ windows: Number(options.windows) }));
  program
    .command("paper:session")
    .option("--variant <name>", "Synthetic session profile: xuan-flow | blocked-completion", "xuan-flow")
    .action(async (options: { variant: PaperSessionVariant }) => runPaperSessionCommand(options));
  program
    .command("paper:live")
    .option("--duration-sec <n>", "Observe the live market for N seconds", "20")
    .option("--sample-ms <n>", "Sampling interval in milliseconds", "2000")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .action(async (options: { durationSec: string; sampleMs: string; initialBookWaitMs: string }) =>
      runPaperLive({
        durationSec: Number(options.durationSec),
        sampleMs: Number(options.sampleMs),
        initialBookWaitMs: Number(options.initialBookWaitMs),
      }),
    );
  program.command("bot:dry").action(async () => runBotDry());
  program
    .command("bot:live")
    .option("--duration-sec <n>", "Run each live market session for at most N seconds", "600")
    .option("--post-close-reconcile-sec <n>", "Wait after market close for balance reconcile/finalize; omitted auto-enables 60s for --max-markets 1")
    .option("--tick-ms <n>", "Decision loop interval in milliseconds", "1000")
    .option("--initial-book-wait-ms <n>", "How long to wait for initial orderbooks", "8000")
    .option("--balance-sync-ms <n>", "How often to reconcile ERC1155 balances", "5000")
    .option("--max-markets <n>", "Stop after N markets; 0 keeps the daemon running", "0")
    .option("--inter-session-pause-ms <n>", "Pause between finished markets before rollover", "1500")
    .option("--market-selection <mode>", "Market selection: auto | current | next", "auto")
    .action(
      async (options: {
        durationSec: string;
        postCloseReconcileSec?: string;
        tickMs: string;
        initialBookWaitMs: string;
        balanceSyncMs: string;
        maxMarkets: string;
        interSessionPauseMs: string;
        marketSelection: string;
      }) =>
        runBotLive({
          durationSec: Number(options.durationSec),
          ...(options.postCloseReconcileSec === undefined
            ? {}
            : { postCloseReconcileSec: Number(options.postCloseReconcileSec) }),
          tickMs: Number(options.tickMs),
          initialBookWaitMs: Number(options.initialBookWaitMs),
          balanceSyncMs: Number(options.balanceSyncMs),
          maxMarkets: Number(options.maxMarkets),
          interSessionPauseMs: Number(options.interSessionPauseMs),
          marketSelection:
            options.marketSelection === "current" || options.marketSelection === "next" ? options.marketSelection : "auto",
        }),
    );

  await program.parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli();
}
