import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOfflineMarket } from "../../src/infra/gamma/marketDiscovery.js";
import { PersistentStateStore } from "../../src/live/persistentStateStore.js";
import { applyFill, applyMerge } from "../../src/strategy/xuan5m/inventoryState.js";
import { createMarketState } from "../../src/strategy/xuan5m/marketState.js";

describe("persistent state store", () => {
  it("restores fifo lots and threshold snapshots from sqlite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuan-state-"));
    const dbPath = join(dir, "state.sqlite");
    const market = buildOfflineMarket(1713696000);
    const createdAt = market.startTs + 1;

    let state = createMarketState(market);
    state = applyFill(state, {
      outcome: "UP",
      side: "BUY",
      price: 0.2,
      size: 10,
      timestamp: createdAt,
      makerTaker: "taker",
    });
    state = applyFill(state, {
      outcome: "DOWN",
      side: "BUY",
      price: 0.7,
      size: 10,
      timestamp: createdAt + 1,
      makerTaker: "taker",
    });

    const store = new PersistentStateStore(dbPath);
    store.recordFill(state, state.fillHistory[0]!, { source: "USER_WS" });
    store.recordFill(state, state.fillHistory[1]!, { source: "USER_WS" });
    store.upsertMarketState(state);
    store.recordPriceSnapshot({
      marketSlug: market.slug,
      conditionId: market.conditionId,
      kind: "threshold",
      source: "rtds",
      price: 78000,
      timestampMs: market.startTs * 1000,
      estimatedThreshold: false,
      note: "captured_at_market_start",
    });

    const preMerge = state;
    state = applyMerge(state, {
      amount: 6,
      timestamp: market.startTs + 20,
      simulated: false,
    });
    store.recordMerge(preMerge, state.mergeHistory.at(-1)!);
    store.upsertMarketState(state);
    store.close();

    const reopened = new PersistentStateStore(dbPath);
    const restored = reopened.loadMarketState(createMarketState(market));
    const snapshot = reopened.loadLatestPriceSnapshot(market.slug, "threshold");
    reopened.close();

    expect(restored.upShares).toBe(4);
    expect(restored.downShares).toBe(4);
    expect(restored.upCost).toBeCloseTo(0.8, 8);
    expect(restored.downCost).toBeCloseTo(2.8, 8);
    expect(restored.upLots).toEqual([
      expect.objectContaining({
        size: 4,
        price: 0.2,
      }),
    ]);
    expect(snapshot).toMatchObject({
      price: 78000,
      source: "rtds",
      estimatedThreshold: false,
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("persists latest open partial pair group and replay validation state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuan-state-"));
    const dbPath = join(dir, "state.sqlite");
    const market = buildOfflineMarket(1713696000);
    const state = createMarketState(market);
    const store = new PersistentStateStore(dbPath);

    store.upsertPairGroup({
      groupId: "pair-1",
      marketSlug: market.slug,
      conditionId: market.conditionId,
      upTokenId: market.tokens.UP.tokenId,
      downTokenId: market.tokens.DOWN.tokenId,
      intendedQty: 5,
      maxUpPrice: 0.55,
      maxDownPrice: 0.46,
      orderType: "FAK",
      mode: "XUAN",
      selectedMode: "XUAN_SOFT_PAIR_SWEEP",
      createdAt: market.startTs + 10,
      status: "DOWN_ONLY",
      baselineUpShares: state.upShares,
      baselineDownShares: state.downShares,
      rawPair: 1.01,
      effectivePair: 1.0457,
      negativeEdgeUsdc: 0.22,
      marketNegativeSpentBefore: 0,
      marketNegativeSpentAfter: 0.22,
    });
    store.recordValidationRun({
      kind: "replay",
      status: "ok",
      timestamp: market.startTs + 15,
      payload: {
        marketSlug: market.slug,
      },
    });

    const partial = store.loadLatestOpenPartialPairGroup(market.slug);
    const validation = store.latestValidationRun("replay");
    store.close();

    expect(partial).toEqual({
      groupId: "pair-1",
      status: "DOWN_ONLY",
      createdAt: market.startTs + 10,
    });
    expect(validation).toMatchObject({
      kind: "replay",
      status: "ok",
      timestamp: market.startTs + 15,
      payload: {
        marketSlug: market.slug,
      },
    });

    await rm(dir, { recursive: true, force: true });
  });
});
