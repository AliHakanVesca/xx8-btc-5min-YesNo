import type { AppEnv } from "../config/schema.js";
import type { XuanStrategyConfig } from "../config/strategyPresets.js";
import { DataApiClient } from "../infra/dataApi/dataApiClient.js";
import { CtfClient, type CtfTxResult } from "../infra/ctf/ctfClient.js";
import { SystemClock } from "../infra/time/clock.js";
import { getCurrentAndNextWindows } from "../infra/time/windowScheduler.js";
import { resolveConfiguredFunderAddress } from "./topology.js";

const BTC_5M_SLUG_PATTERN = /^btc-updown-5m-(\d+)$/;

type InventoryRelation = "current" | "previous" | "next" | "historical" | "unknown";
type InventoryActionType = "redeem" | "merge";

interface RawPosition {
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  curPrice?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface InventoryPositionView {
  asset: string;
  conditionId: string;
  slug: string;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  oppositeAsset?: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  redeemable: boolean;
  mergeableHint: boolean;
  title?: string;
  knownBtc5m: boolean;
  relation: InventoryRelation;
  startTs?: number;
  endTs?: number;
}

export interface InventoryMarketView {
  slug: string;
  conditionId: string;
  title?: string;
  relation: InventoryRelation;
  knownBtc5m: boolean;
  startTs?: number;
  endTs?: number;
  resolved: boolean;
  redeemable: boolean;
  upAsset?: string;
  downAsset?: string;
  upShares: number;
  downShares: number;
  totalShares: number;
  mergeable: number;
  residualUp: number;
  residualDown: number;
  imbalanceRatio: number;
  positions: InventoryPositionView[];
}

export interface InventorySnapshot {
  walletAddress: string;
  nowTs: number;
  previousSlug: string;
  currentSlug: string;
  nextSlug: string;
  markets: InventoryMarketView[];
  unknownMarkets: InventoryMarketView[];
  currentMarket?: InventoryMarketView;
}

export interface InventoryActionPlanItem {
  type: InventoryActionType;
  conditionId: string;
  slug: string;
  relation: InventoryRelation;
  amount?: number;
  reason: string;
}

export interface InventoryActionPlan {
  blockNewEntries: boolean;
  blockReasons: string[];
  currentMarket?: InventoryMarketView;
  redeem: InventoryActionPlanItem[];
  merge: InventoryActionPlanItem[];
}

export interface InventoryActionResult extends InventoryActionPlanItem {
  result: CtfTxResult;
}

export interface InventoryManageReport {
  before: InventorySnapshot;
  after: InventorySnapshot;
  plan: InventoryActionPlan;
  actions: InventoryActionResult[];
}

function normalizeNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(6));
}

function normalizeOutcome(value: unknown): "UP" | "DOWN" | "UNKNOWN" {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("up") || normalized.includes("yes")) {
    return "UP";
  }
  if (normalized.includes("down") || normalized.includes("no")) {
    return "DOWN";
  }
  return "UNKNOWN";
}

function parseBtc5mSlug(slug: string): { startTs: number; endTs: number } | undefined {
  const matched = BTC_5M_SLUG_PATTERN.exec(slug);
  if (!matched) {
    return undefined;
  }
  const startTs = Number(matched[1]);
  if (!Number.isFinite(startTs)) {
    return undefined;
  }
  return {
    startTs,
    endTs: startTs + 300,
  };
}

function relationForSlug(
  slug: string,
  windows: ReturnType<typeof getCurrentAndNextWindows>,
): InventoryRelation {
  if (slug === windows.current.slug) {
    return "current";
  }
  if (slug === windows.previous.slug) {
    return "previous";
  }
  if (slug === windows.next.slug) {
    return "next";
  }
  return parseBtc5mSlug(slug) ? "historical" : "unknown";
}

function toPositionView(raw: RawPosition, windows: ReturnType<typeof getCurrentAndNextWindows>): InventoryPositionView | undefined {
  const slug = String(raw.slug ?? raw.eventSlug ?? "");
  const asset = String(raw.asset ?? "");
  const conditionId = String(raw.conditionId ?? "");
  if (!slug || !asset || !conditionId) {
    return undefined;
  }

  const timing = parseBtc5mSlug(slug);
  return {
    asset,
    conditionId,
    slug,
    outcome: normalizeOutcome(raw.outcome),
    ...(typeof raw.oppositeAsset === "string" ? { oppositeAsset: raw.oppositeAsset } : {}),
    size: normalizeNumber(raw.size),
    avgPrice: normalizeNumber(raw.avgPrice),
    curPrice: normalizeNumber(raw.curPrice),
    redeemable: Boolean(raw.redeemable),
    mergeableHint: Boolean(raw.mergeable),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    knownBtc5m: Boolean(timing),
    relation: relationForSlug(slug, windows),
    ...(timing ?? {}),
  };
}

function coercePositions(payload: unknown): RawPosition[] {
  if (Array.isArray(payload)) {
    return payload as RawPosition[];
  }
  const nested = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(nested) ? (nested as RawPosition[]) : [];
}

function buildInventoryMarketView(
  nowTs: number,
  slug: string,
  conditionId: string,
  positions: InventoryPositionView[],
): InventoryMarketView {
  const up = positions.find((position) => position.outcome === "UP");
  const down = positions.find((position) => position.outcome === "DOWN");
  const upShares = normalizeNumber(up?.size ?? 0);
  const downShares = normalizeNumber(down?.size ?? 0);
  const mergeable = normalizeNumber(Math.min(upShares, downShares));
  const totalShares = normalizeNumber(upShares + downShares);
  const timing = parseBtc5mSlug(slug);
  const resolved = positions.some((position) => position.redeemable) || Boolean(timing && nowTs >= timing.endTs);
  return {
    slug,
    conditionId,
    ...(positions[0]?.title ? { title: positions[0].title } : {}),
    relation: positions[0]?.relation ?? "unknown",
    knownBtc5m: positions.every((position) => position.knownBtc5m),
    ...(timing ?? {}),
    resolved,
    redeemable: positions.some((position) => position.redeemable),
    ...(up ? { upAsset: up.asset } : {}),
    ...(down ? { downAsset: down.asset } : {}),
    upShares,
    downShares,
    totalShares,
    mergeable,
    residualUp: normalizeNumber(Math.max(0, upShares - mergeable)),
    residualDown: normalizeNumber(Math.max(0, downShares - mergeable)),
    imbalanceRatio: normalizeNumber(Math.abs(upShares - downShares) / Math.max(totalShares, 1)),
    positions,
  };
}

export async function fetchInventorySnapshot(
  env: AppEnv,
  config: Pick<XuanStrategyConfig, "inventoryPositionLimit" | "inventorySizeThreshold">,
): Promise<InventorySnapshot> {
  const dataApi = new DataApiClient(env);
  const clock = new SystemClock();
  const windows = getCurrentAndNextWindows(clock);
  const walletAddress = resolveConfiguredFunderAddress(env);
  const payload = await dataApi.getPositions({
    user: walletAddress,
    sizeThreshold: config.inventorySizeThreshold,
    limit: config.inventoryPositionLimit,
  });

  const positions = coercePositions(payload)
    .map((raw) => toPositionView(raw, windows))
    .filter((position): position is InventoryPositionView => position !== undefined);
  const grouped = new Map<string, InventoryPositionView[]>();

  for (const position of positions) {
    const key = `${position.conditionId}::${position.slug}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(position);
    } else {
      grouped.set(key, [position]);
    }
  }

  const markets = [...grouped.entries()]
    .map(([key, bucket]) => {
      const [conditionId = "", slug = ""] = key.split("::");
      return buildInventoryMarketView(clock.now(), slug, conditionId, bucket);
    })
    .sort((left, right) => {
      if ((left.startTs ?? 0) !== (right.startTs ?? 0)) {
        return (right.startTs ?? 0) - (left.startTs ?? 0);
      }
      return right.totalShares - left.totalShares;
    });

  const unknownMarkets = markets.filter((market) => !market.knownBtc5m);
  const currentMarket = markets.find((market) => market.slug === windows.current.slug);

  return {
    walletAddress,
    nowTs: clock.now(),
    previousSlug: windows.previous.slug,
    currentSlug: windows.current.slug,
    nextSlug: windows.next.slug,
    markets,
    unknownMarkets,
    ...(currentMarket ? { currentMarket } : {}),
  };
}

export function buildInventoryActionPlan(
  snapshot: InventorySnapshot,
  config: Pick<
    XuanStrategyConfig,
    | "unknownInventoryPolicy"
    | "resolvedInventoryPolicy"
    | "mergeableInventoryPolicy"
    | "mergeMode"
    | "redeemMode"
    | "mergeMinShares"
    | "redeemMinShares"
    | "dustSharesThreshold"
    | "hardImbalanceRatio"
  >,
): InventoryActionPlan {
  const blockReasons: string[] = [];
  const redeem: InventoryActionPlanItem[] = [];
  const merge: InventoryActionPlanItem[] = [];

  if (config.unknownInventoryPolicy === "BLOCK_NEW_ENTRY") {
    for (const market of snapshot.unknownMarkets) {
      if (market.totalShares >= config.dustSharesThreshold) {
        blockReasons.push(`unknown_inventory:${market.slug}`);
      }
    }
  }

  for (const market of snapshot.markets) {
    if (!market.knownBtc5m) {
      continue;
    }

    if (
      market.resolved &&
      market.redeemable &&
      config.redeemMode === "AUTO" &&
      config.resolvedInventoryPolicy === "AUTO_REDEEM" &&
      market.totalShares >= config.redeemMinShares
    ) {
      redeem.push({
        type: "redeem",
        conditionId: market.conditionId,
        slug: market.slug,
        relation: market.relation,
        reason: "resolved_inventory",
      });
      continue;
    }

    if (
      !market.resolved &&
      config.mergeMode === "AUTO" &&
      config.mergeableInventoryPolicy === "AUTO_MERGE" &&
      market.mergeable >= config.mergeMinShares
    ) {
      merge.push({
        type: "merge",
        conditionId: market.conditionId,
        slug: market.slug,
        relation: market.relation,
        amount: market.mergeable,
        reason: "mergeable_inventory",
      });
    }
  }

  const currentMarket = snapshot.currentMarket;
  if (currentMarket && currentMarket.imbalanceRatio >= config.hardImbalanceRatio) {
    blockReasons.push(`current_market_hard_imbalance:${currentMarket.slug}`);
  }

  return {
    blockNewEntries: blockReasons.length > 0,
    blockReasons,
    ...(currentMarket ? { currentMarket } : {}),
    redeem,
    merge,
  };
}

async function executeRedeemWithRetry(
  ctf: CtfClient,
  conditionId: string,
  retryEnabled: boolean,
  retryMax: number,
): Promise<CtfTxResult> {
  let lastError: Error | undefined;
  const attempts = retryEnabled ? Math.max(1, retryMax) : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ctf.redeemPositions(conditionId);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= attempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }

  throw lastError ?? new Error("redeem failed");
}

export async function executeInventoryActionPlan(
  env: AppEnv,
  plan: InventoryActionPlan,
  config: Pick<XuanStrategyConfig, "redeemRetryEnabled" | "redeemRetryMax">,
): Promise<InventoryActionResult[]> {
  const ctf = new CtfClient(env);
  const actions: InventoryActionResult[] = [];

  for (const item of plan.redeem) {
    const result = await executeRedeemWithRetry(ctf, item.conditionId, config.redeemRetryEnabled, config.redeemRetryMax);
    actions.push({
      ...item,
      result,
    });
  }

  for (const item of plan.merge) {
    const result = await ctf.mergePositions(item.conditionId, item.amount ?? 0);
    actions.push({
      ...item,
      result,
    });
  }

  return actions;
}

export async function manageInventory(
  env: AppEnv,
  config: Pick<
    XuanStrategyConfig,
    | "inventoryPositionLimit"
    | "inventorySizeThreshold"
    | "unknownInventoryPolicy"
    | "resolvedInventoryPolicy"
    | "mergeableInventoryPolicy"
    | "mergeMode"
    | "redeemMode"
    | "mergeMinShares"
    | "redeemMinShares"
    | "dustSharesThreshold"
    | "hardImbalanceRatio"
    | "redeemRetryEnabled"
    | "redeemRetryMax"
  >,
): Promise<InventoryManageReport> {
  const before = await fetchInventorySnapshot(env, config);
  const plan = buildInventoryActionPlan(before, config);
  const actions = await executeInventoryActionPlan(env, plan, config);
  const after = await fetchInventorySnapshot(env, config);

  return {
    before,
    after,
    plan,
    actions,
  };
}
