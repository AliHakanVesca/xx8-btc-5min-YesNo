import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDailyNegativeEdgeState,
  persistDailyNegativeEdgeSpentUsdc,
  resolvePersistedDailyNegativeEdgeSpentUsdc,
} from "../../src/live/dailyNegativeEdgeStore.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function buildStorePath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xx8-daily-budget-"));
  tempDirs.push(dir);
  return join(dir, `${name}.json`);
}

describe("daily negative edge store", () => {
  it("persists and reloads the same-day daily budget", async () => {
    const path = await buildStorePath("same-day");
    const now = new Date("2026-04-22T09:00:00.000Z");

    await persistDailyNegativeEdgeSpentUsdc({
      path,
      value: 1.23456789,
      now,
    });

    const raw = await loadDailyNegativeEdgeState(path);
    const loaded = await resolvePersistedDailyNegativeEdgeSpentUsdc({
      path,
      now,
    });

    expect(raw?.dailyNegativeEdgeSpentUsdc).toBe(1.234568);
    expect(loaded.dailyNegativeEdgeSpentUsdc).toBe(1.234568);
    expect(loaded.loadedFromDisk).toBe(true);
    expect(loaded.resetFromDate).toBeUndefined();
  });

  it("resets the carried budget when the stored day is stale", async () => {
    const path = await buildStorePath("new-day");

    await persistDailyNegativeEdgeSpentUsdc({
      path,
      value: 2.5,
      now: new Date("2026-04-21T09:00:00.000Z"),
    });

    const loaded = await resolvePersistedDailyNegativeEdgeSpentUsdc({
      path,
      now: new Date("2026-04-22T09:00:00.000Z"),
    });

    expect(loaded.dailyNegativeEdgeSpentUsdc).toBe(0);
    expect(loaded.loadedFromDisk).toBe(true);
    expect(loaded.resetFromDate).toBe("2026-04-21");
  });
});
