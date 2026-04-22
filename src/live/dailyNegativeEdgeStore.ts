import { readFile } from "node:fs/promises";
import { writeJson } from "../utils/fs.js";

export const DEFAULT_DAILY_NEGATIVE_EDGE_STORE_PATH = "data/runtime/daily-negative-edge.json";
export const DAILY_NEGATIVE_EDGE_STORE_TIME_ZONE = "Europe/Istanbul";

export interface PersistedDailyNegativeEdgeState {
  date: string;
  timeZone: string;
  dailyNegativeEdgeSpentUsdc: number;
  updatedAt: string;
}

export interface LoadedDailyNegativeEdgeState {
  path: string;
  date: string;
  timeZone: string;
  dailyNegativeEdgeSpentUsdc: number;
  loadedFromDisk: boolean;
  resetFromDate?: string | undefined;
}

function normalizeValue(value: number): number {
  return Number(Math.max(0, value).toFixed(6));
}

export function dailyNegativeEdgeDateKey(
  now: Date = new Date(),
  timeZone = DAILY_NEGATIVE_EDGE_STORE_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

export async function loadDailyNegativeEdgeState(
  path = DEFAULT_DAILY_NEGATIVE_EDGE_STORE_PATH,
): Promise<PersistedDailyNegativeEdgeState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedDailyNegativeEdgeState>;
    if (
      typeof parsed.date !== "string" ||
      typeof parsed.timeZone !== "string" ||
      typeof parsed.dailyNegativeEdgeSpentUsdc !== "number" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return undefined;
    }
    return {
      date: parsed.date,
      timeZone: parsed.timeZone,
      dailyNegativeEdgeSpentUsdc: normalizeValue(parsed.dailyNegativeEdgeSpentUsdc),
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return undefined;
  }
}

export async function resolvePersistedDailyNegativeEdgeSpentUsdc(args?: {
  path?: string;
  now?: Date;
  timeZone?: string;
}): Promise<LoadedDailyNegativeEdgeState> {
  const path = args?.path ?? DEFAULT_DAILY_NEGATIVE_EDGE_STORE_PATH;
  const timeZone = args?.timeZone ?? DAILY_NEGATIVE_EDGE_STORE_TIME_ZONE;
  const date = dailyNegativeEdgeDateKey(args?.now, timeZone);
  const loaded = await loadDailyNegativeEdgeState(path);

  if (!loaded) {
    return {
      path,
      date,
      timeZone,
      dailyNegativeEdgeSpentUsdc: 0,
      loadedFromDisk: false,
    };
  }

  if (loaded.date !== date) {
    return {
      path,
      date,
      timeZone,
      dailyNegativeEdgeSpentUsdc: 0,
      loadedFromDisk: true,
      resetFromDate: loaded.date,
    };
  }

  return {
    path,
    date,
    timeZone,
    dailyNegativeEdgeSpentUsdc: loaded.dailyNegativeEdgeSpentUsdc,
    loadedFromDisk: true,
  };
}

export async function persistDailyNegativeEdgeSpentUsdc(args: {
  value: number;
  path?: string;
  now?: Date;
  timeZone?: string;
}): Promise<PersistedDailyNegativeEdgeState> {
  const path = args.path ?? DEFAULT_DAILY_NEGATIVE_EDGE_STORE_PATH;
  const timeZone = args.timeZone ?? DAILY_NEGATIVE_EDGE_STORE_TIME_ZONE;
  const payload: PersistedDailyNegativeEdgeState = {
    date: dailyNegativeEdgeDateKey(args.now, timeZone),
    timeZone,
    dailyNegativeEdgeSpentUsdc: normalizeValue(args.value),
    updatedAt: (args.now ?? new Date()).toISOString(),
  };
  await writeJson(path, payload);
  return payload;
}
