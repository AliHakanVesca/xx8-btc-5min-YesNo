import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { buildRuntimeCanonicalExtractBundle } from "../../src/analytics/runtimeCanonicalReference.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeJsonl(path: string, records: Record<string, unknown>[]): Promise<void> {
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
}

function createRuntimeDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE pair_groups (
      group_id TEXT PRIMARY KEY,
      market_slug TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      up_token_id TEXT NOT NULL,
      down_token_id TEXT NOT NULL,
      intended_qty REAL NOT NULL,
      max_up_price REAL,
      max_down_price REAL,
      order_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      selected_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      baseline_up_shares REAL NOT NULL,
      baseline_down_shares REAL NOT NULL,
      raw_pair REAL NOT NULL,
      effective_pair REAL NOT NULL,
      negative_edge_usdc REAL NOT NULL,
      market_negative_spent_before REAL NOT NULL,
      market_negative_spent_after REAL NOT NULL
    );
    CREATE TABLE inventory_lots (
      lot_id TEXT PRIMARY KEY,
      group_id TEXT,
      market_slug TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      qty_original REAL NOT NULL,
      qty_open REAL NOT NULL,
      price REAL NOT NULL,
      effective_price REAL NOT NULL,
      fee_usdc REAL NOT NULL,
      tx_hash TEXT,
      order_id TEXT,
      execution_mode TEXT,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      closed_at INTEGER,
      close_reason TEXT
    );
    CREATE TABLE merge_redeem_events (
      event_id TEXT PRIMARY KEY,
      market_slug TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      action TEXT NOT NULL,
      amount REAL,
      timestamp INTEGER NOT NULL,
      simulated INTEGER NOT NULL,
      reason TEXT,
      matched_up_cost REAL,
      matched_down_cost REAL,
      merge_return REAL,
      realized_pnl REAL,
      remaining_up_shares REAL,
      remaining_down_shares REAL,
      tx_hash TEXT
    );
    CREATE TABLE market_state (
      market_slug TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      up_shares REAL NOT NULL,
      down_shares REAL NOT NULL,
      mergeable REAL NOT NULL,
      residual_up REAL NOT NULL,
      residual_down REAL NOT NULL,
      residual_up_avg_cost REAL NOT NULL,
      residual_down_avg_cost REAL NOT NULL,
      residual_up_avg_effective_cost REAL NOT NULL,
      residual_down_avg_effective_cost REAL NOT NULL,
      negative_edge_consumed_usdc REAL NOT NULL,
      negative_pair_edge_consumed_usdc REAL NOT NULL,
      negative_completion_edge_consumed_usdc REAL NOT NULL,
      last_execution_mode TEXT,
      consecutive_seed_side TEXT,
      consecutive_seed_count INTEGER NOT NULL,
      reentry_disabled INTEGER NOT NULL,
      post_merge_completion_only_until INTEGER,
      updated_at INTEGER NOT NULL,
      no_new_entry_reason TEXT
    );
  `);
  return db;
}

describe("runtime canonical reference extraction", () => {
  it("marks a requested market with no local runtime fills as no_runtime_fills instead of a broken strategy footprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-canonical-empty-"));
    cleanupDirs.push(dir);
    const dbPath = join(dir, "runtime.sqlite");
    const logsDir = join(dir, "logs");
    await mkdir(logsDir, { recursive: true });

    const db = createRuntimeDb(dbPath);
    db.close();
    await writeJsonl(join(logsDir, "decision_trace.jsonl"), []);
    await writeJsonl(join(logsDir, "orders.jsonl"), []);
    await writeJsonl(join(logsDir, "risk_events.jsonl"), []);

    const slug = "btc-updown-5m-1777000300";
    const bundle = await buildRuntimeCanonicalExtractBundle({
      stateDbPath: dbPath,
      logsDir,
      marketSlugs: [slug],
    });

    expect(bundle.references).toHaveLength(1);
    expect(bundle.references[0]?.authority.totalBuyCount).toBe(0);
    expect(bundle.diagnosticsBySlug[slug]).toMatchObject({
      buyCount: 0,
      lifecycleEventCount: 0,
      runtimeDataStatus: "no_runtime_fills",
    });
  });

  it("extracts a healthy group-primary runtime footprint with normalized clip tiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-canonical-"));
    cleanupDirs.push(dir);
    const dbPath = join(dir, "runtime.sqlite");
    const logsDir = join(dir, "logs");
    await mkdir(logsDir, { recursive: true });

    const db = createRuntimeDb(dbPath);
    const slug = "btc-updown-5m-1777000000";
    const conditionId = "0xcond";
    db.prepare(`
      INSERT INTO pair_groups (
        group_id, market_slug, condition_id, up_token_id, down_token_id, intended_qty, max_up_price, max_down_price,
        order_type, mode, selected_mode, created_at, status, baseline_up_shares, baseline_down_shares, raw_pair, effective_pair,
        negative_edge_usdc, market_negative_spent_before, market_negative_spent_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "g1",
      slug,
      conditionId,
      "up",
      "down",
      5,
      0.55,
      0.46,
      "FAK",
      "XUAN",
      "XUAN_SOFT_PAIR_SWEEP",
      1777000003000,
      "BOTH_FILLED",
      0,
      0,
      1.01,
      1.02,
      0,
      0,
      0,
    );
    const insertLot = db.prepare(`
      INSERT INTO inventory_lots (
        lot_id, group_id, market_slug, condition_id, outcome, side, qty_original, qty_open, price, effective_price,
        fee_usdc, tx_hash, order_id, execution_mode, source, timestamp
      ) VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLot.run("lot1", "g1", slug, conditionId, "DOWN", 5, 0, 0.53, 0.55, 0.1, "0xtx1", "o1", "PAIR", "USER_WS", 1777000004);
    insertLot.run("lot2", "g1", slug, conditionId, "UP", 5, 0, 0.48, 0.5, 0.1, "0xtx2", "o2", "PAIR", "USER_WS", 1777000010);
    db.prepare(`
      INSERT INTO merge_redeem_events (
        event_id, market_slug, condition_id, action, amount, timestamp, simulated, tx_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m1", slug, conditionId, "merge", 5, 1777000014, 0, "0xmerge");
    db.prepare(`
      INSERT INTO market_state (
        market_slug, condition_id, up_shares, down_shares, mergeable, residual_up, residual_down,
        residual_up_avg_cost, residual_down_avg_cost, residual_up_avg_effective_cost, residual_down_avg_effective_cost,
        negative_edge_consumed_usdc, negative_pair_edge_consumed_usdc, negative_completion_edge_consumed_usdc,
        consecutive_seed_count, reentry_disabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slug, conditionId, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1777000014);
    db.close();

    await writeJsonl(join(logsDir, "decision_trace.jsonl"), []);
    await writeJsonl(join(logsDir, "orders.jsonl"), [
      {
        ts: 1777000004,
        marketSlug: slug,
        eventType: "pair_orders_submit",
        sequentialPairExecution: true,
        interChildDelayMs: 40,
        childOrderReason: "flow_intent",
        childOrderMicroTimingBias: "flow_intent",
      },
      {
        ts: 1777000010,
        marketSlug: slug,
        eventType: "pair_orders_submit",
        sequentialPairExecution: false,
        interChildDelayMs: 120,
        childOrderReason: "default",
        childOrderMicroTimingBias: "neutral",
      },
    ]);
    await writeJsonl(join(logsDir, "risk_events.jsonl"), []);

    const bundle = await buildRuntimeCanonicalExtractBundle({
      stateDbPath: dbPath,
      logsDir,
      marketSlugs: [slug],
    });

    expect(bundle.references).toHaveLength(1);
    expect(bundle.references[0]).toMatchObject({
      slug,
      cycleCount: 1,
      completionCount: 1,
      mergeCount: 1,
      repairLatencyBucket: "0_10",
    });
    expect(bundle.references[0]?.normalizedClipTierCounts["1x"]).toBe(2);
    expect(bundle.hardFailsBySlug[slug]).toEqual({
      overshoot: 0,
      sameSideAmplification: 0,
      completionQtyExceedsMissing: 0,
      grouplessBotFill: 0,
      repairSizeZeroWithGap: 0,
      mergeMissWithValidQty: 0,
    });
    expect(bundle.diagnosticsBySlug[slug]?.childOrderDispatch).toEqual({
      pairSubmitCount: 2,
      sequentialPairSubmitCount: 1,
      flowIntentPairSubmitCount: 1,
      compressedPairSubmitCount: 1,
      averageInterChildDelayMs: 80,
      maxInterChildDelayMs: 120,
    });
  });

  it("surfaces broken-live hard fails from groupless fills, repair_size_zero, and merge miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-canonical-broken-"));
    cleanupDirs.push(dir);
    const dbPath = join(dir, "runtime.sqlite");
    const logsDir = join(dir, "logs");
    await mkdir(logsDir, { recursive: true });

    const db = createRuntimeDb(dbPath);
    const slug = "btc-updown-5m-1776863400";
    const conditionId = "0xbroken";
    db.prepare(`
      INSERT INTO pair_groups (
        group_id, market_slug, condition_id, up_token_id, down_token_id, intended_qty, max_up_price, max_down_price,
        order_type, mode, selected_mode, created_at, status, baseline_up_shares, baseline_down_shares, raw_pair, effective_pair,
        negative_edge_usdc, market_negative_spent_before, market_negative_spent_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "g1",
      slug,
      conditionId,
      "up",
      "down",
      5,
      0.55,
      0.46,
      "FAK",
      "XUAN",
      "XUAN_HARD_PAIR_SWEEP",
      1776863433000,
      "NONE_FILLED",
      0,
      0,
      1.01,
      1.0457,
      0.22,
      0,
      0.22,
    );
    const insertLot = db.prepare(`
      INSERT INTO inventory_lots (
        lot_id, group_id, market_slug, condition_id, outcome, side, qty_original, qty_open, price, effective_price,
        fee_usdc, tx_hash, order_id, execution_mode, source, timestamp
      ) VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLot.run("lot1", null, slug, conditionId, "DOWN", 4.90872, 4.90872, 0.44, 0.45, 0.1, "0xtx1", "o1", null, "BALANCE_RECONCILE", 1776863438);
    insertLot.run("lot2", "g1", slug, conditionId, "UP", 5.013927, 5.013927, 0.57, 0.59, 0.1, "0xtx2", "o2", "PAIR", "BALANCE_RECONCILE", 1776863443);
    db.prepare(`
      INSERT INTO market_state (
        market_slug, condition_id, up_shares, down_shares, mergeable, residual_up, residual_down,
        residual_up_avg_cost, residual_down_avg_cost, residual_up_avg_effective_cost, residual_down_avg_effective_cost,
        negative_edge_consumed_usdc, negative_pair_edge_consumed_usdc, negative_completion_edge_consumed_usdc,
        consecutive_seed_count, reentry_disabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slug, conditionId, 5.013927, 4.90872, 4.90872, 0.105207, 0, 0.57, 0.44, 0.59, 0.45, 0, 0, 0, 0, 0, 1776863444);
    db.close();

    await writeJsonl(join(logsDir, "decision_trace.jsonl"), [
      {
        ts: 1776863688,
        marketSlug: slug,
        entrySkipReason: "repair_size_zero",
        shareGap: 4.693193,
      },
    ]);
    await writeJsonl(join(logsDir, "risk_events.jsonl"), [
      {
        ts: 1776863688,
        marketSlug: slug,
        reason: "repair_size_zero",
      },
    ]);

    const bundle = await buildRuntimeCanonicalExtractBundle({
      stateDbPath: dbPath,
      logsDir,
      marketSlugs: [slug],
    });

    expect(bundle.hardFailsBySlug[slug]).toMatchObject({
      grouplessBotFill: 1,
      repairSizeZeroWithGap: 1,
      mergeMissWithValidQty: 1,
    });
    expect(bundle.diagnosticsBySlug[slug]).toMatchObject({
      marketBaseLot: 5,
      mergeableAtEnd: 4.90872,
    });
  });
});
