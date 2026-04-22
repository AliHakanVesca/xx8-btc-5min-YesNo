import type { AppEnv } from "../../config/schema.js";
import type { ClobAdapter, ClobMarketInfo, MarketInfo, OutcomeSide } from "../clob/types.js";
import type { Clock } from "../time/clock.js";
import { getCurrentAndNextWindows, toBtc5mSlug } from "../time/windowScheduler.js";
import { GammaClient } from "./gammaClient.js";

function zeroPadToken(slug: string, side: OutcomeSide): string {
  return `${slug}-${side.toLowerCase()}`;
}

function normalizeOutcomeLabel(value: unknown): OutcomeSide | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (normalized.includes("up")) {
    return "UP";
  }
  if (normalized.includes("down")) {
    return "DOWN";
  }
  return undefined;
}

function extractConditionId(raw: any): string | undefined {
  return raw?.conditionId ?? raw?.condition_id ?? raw?.market ?? raw?.id;
}

function extractTickSize(raw: any): number | undefined {
  const value = raw?.tickSize ?? raw?.minimum_tick_size ?? raw?.tick_size;
  return value === undefined ? undefined : Number(value);
}

function extractMinOrderSize(raw: any): number | undefined {
  const value = raw?.minimumOrderSize ?? raw?.minimum_order_size ?? raw?.minOrderSize;
  return value === undefined ? undefined : Number(value);
}

function extractExplicitPriceToBeat(raw: any): number | undefined {
  const candidates = [
    raw?.priceToBeat,
    raw?.price_to_beat,
    raw?.threshold,
    raw?.thresholdPrice,
    raw?.threshold_price,
    raw?.strike,
    raw?.strikePrice,
    raw?.strike_price,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return undefined;
}

function extractTokenMappings(raw: any): Array<{ tokenId: string; outcome: OutcomeSide }> {
  const entries: Array<{ tokenId: string; outcome: OutcomeSide }> = [];

  const directTokens = Array.isArray(raw?.tokens)
    ? raw.tokens
    : Array.isArray(raw?.clobTokens)
      ? raw.clobTokens
      : Array.isArray(raw?.outcomes)
        ? raw.outcomes
        : [];

  for (const token of directTokens) {
    const tokenId = String(token?.token_id ?? token?.tokenId ?? token?.asset_id ?? token?.id ?? "");
    const outcome = normalizeOutcomeLabel(token?.outcome ?? token?.label ?? token?.name);
    if (tokenId && outcome) {
      entries.push({ tokenId, outcome });
    }
  }

  return entries;
}

function marketFromSources(
  slug: string,
  startTs: number,
  endTs: number,
  gammaRaw: any,
  clobInfo: ClobMarketInfo | null,
): MarketInfo {
  const mappedTokens = extractTokenMappings(gammaRaw);

  const clobTokens =
    clobInfo?.tokens
      .map((token) => {
        const outcome = normalizeOutcomeLabel(token.outcome);
        return outcome ? { tokenId: token.tokenId, outcome } : undefined;
      })
      .filter((token): token is { tokenId: string; outcome: OutcomeSide } => token !== undefined) ?? [];

  const tokenEntries = [...mappedTokens, ...clobTokens];

  const upToken = tokenEntries.find((entry) => entry.outcome === "UP");
  const downToken = tokenEntries.find((entry) => entry.outcome === "DOWN");

  return {
    slug,
    conditionId: extractConditionId(gammaRaw) ?? slug,
    startTs,
    endTs,
    tickSize: clobInfo?.tickSize ?? extractTickSize(gammaRaw) ?? 0.01,
    minOrderSize: clobInfo?.minOrderSize ?? extractMinOrderSize(gammaRaw) ?? 5,
    feeRate: clobInfo?.feeRate ?? Number(gammaRaw?.fee_rate ?? 0.072),
    feesEnabled: Boolean(gammaRaw?.feesEnabled ?? gammaRaw?.fees_enabled ?? true),
    negRisk: clobInfo?.negRisk ?? Boolean(gammaRaw?.negRisk ?? false),
    ...(extractExplicitPriceToBeat(gammaRaw) !== undefined
      ? {
          priceToBeat: extractExplicitPriceToBeat(gammaRaw),
          priceToBeatSource: "metadata" as const,
        }
      : {}),
    tokens: {
      UP: {
        tokenId: upToken?.tokenId ?? zeroPadToken(slug, "UP"),
        outcome: "UP",
        label: "Up",
      },
      DOWN: {
        tokenId: downToken?.tokenId ?? zeroPadToken(slug, "DOWN"),
        outcome: "DOWN",
        label: "Down",
      },
    },
    source: gammaRaw ? "gamma" : clobInfo ? "clob" : "fallback",
  };
}

export async function discoverWindowMarket(args: {
  env: AppEnv;
  gammaClient: GammaClient;
  clob: ClobAdapter;
  slug: string;
  startTs: number;
  endTs: number;
}): Promise<MarketInfo> {
  let gammaRaw: unknown | null = null;
  try {
    gammaRaw = await args.gammaClient.findMarketBySlug(args.slug);
  } catch {
    gammaRaw = null;
  }

  const conditionId = extractConditionId(gammaRaw);
  let clobInfo: ClobMarketInfo | null = null;
  if (conditionId) {
    try {
      clobInfo = await args.clob.getClobMarketInfo(conditionId);
    } catch {
      clobInfo = null;
    }
  }

  return marketFromSources(args.slug, args.startTs, args.endTs, gammaRaw, clobInfo);
}

export async function discoverCurrentAndNextMarkets(args: {
  env: AppEnv;
  gammaClient: GammaClient;
  clob: ClobAdapter;
  clock: Clock;
}): Promise<{ previous: MarketInfo; current: MarketInfo; next: MarketInfo }> {
  const { previous, current, next } = getCurrentAndNextWindows(args.clock);

  const [previousMarket, currentMarket, nextMarket] = await Promise.all([
    discoverWindowMarket({ ...args, slug: previous.slug, startTs: previous.startTs, endTs: previous.endTs }),
    discoverWindowMarket({ ...args, slug: current.slug, startTs: current.startTs, endTs: current.endTs }),
    discoverWindowMarket({ ...args, slug: next.slug, startTs: next.startTs, endTs: next.endTs }),
  ]);

  return {
    previous: previousMarket,
    current: currentMarket,
    next: nextMarket,
  };
}

export function buildOfflineMarket(startTs: number): MarketInfo {
  const slug = toBtc5mSlug(startTs);
  return {
    slug,
    conditionId: slug,
    startTs,
    endTs: startTs + 300,
    tickSize: 0.01,
    minOrderSize: 5,
    feeRate: 0.072,
    feesEnabled: true,
    negRisk: false,
    tokens: {
      UP: { tokenId: zeroPadToken(slug, "UP"), outcome: "UP", label: "Up" },
      DOWN: { tokenId: zeroPadToken(slug, "DOWN"), outcome: "DOWN", label: "Down" },
    },
    source: "fallback",
  };
}
