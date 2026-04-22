import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { buildCanonicalReferenceBundle } from "../../src/analytics/xuanCanonicalReference.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("xuan canonical reference extraction", () => {
  it("builds a hybrid authority reference from JSON trade tape and SQLite lifecycle activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuan-canonical-"));
    cleanupDirs.push(dir);
    const jsonPath = join(dir, "xuan.json");
    const sqlitePath = join(dir, "wallet.sqlite");
    const slug = "btc-updown-5m-1776253500";
    const wallet = "0xcfb103c37c0234f524c632d964ed31f117b5f694";

    await writeFile(
      jsonPath,
      JSON.stringify([
        {
          slug,
          outcome: "Up",
          side: "BUY",
          size: 5,
          price: 0.48,
          timestamp: 1776253504,
          proxyWallet: wallet,
          transactionHash: "0xtx1",
        },
        {
          slug,
          outcome: "Down",
          side: "BUY",
          size: 5,
          price: 0.53,
          timestamp: 1776253506,
          proxyWallet: wallet,
          transactionHash: "0xtx2",
        },
        {
          slug,
          outcome: "Up",
          side: "BUY",
          size: 5,
          price: 0.57,
          timestamp: 1776253526,
          proxyWallet: wallet,
          transactionHash: "0xtx3",
        },
      ]),
      "utf8",
    );

    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        slug TEXT,
        type TEXT NOT NULL,
        timestamp INTEGER,
        size REAL,
        price REAL,
        side TEXT,
        outcome TEXT,
        transaction_hash TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO activity_events (
        wallet, slug, type, timestamp, size, price, side, outcome, transaction_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(wallet, slug, "TRADE", 1776253504, 5, 0.48, "BUY", "Up", "0xtx1");
    insert.run(wallet, slug, "TRADE", 1776253506, 5, 0.53, "BUY", "Down", "0xtx2");
    insert.run(wallet, slug, "MERGE", 1776253510, 5, 0, null, null, "0xmerge1");
    insert.run(wallet, slug, "TRADE", 1776253526, 5, 0.57, "BUY", "Up", "0xtx3");
    insert.run(wallet, slug, "REDEEM", 1776253800, 5, 0, null, null, "0xredeem1");
    db.close();

    const bundle = await buildCanonicalReferenceBundle({
      filePath: jsonPath,
      sqlitePath,
      slugs: [slug],
      wallet,
    });

    expect(bundle.sources).toMatchObject({
      tradeTapeFile: jsonPath,
      lifecycleSqlitePath: sqlitePath,
      wallet,
    });
    expect(bundle.references).toHaveLength(1);
    expect(bundle.references[0]).toMatchObject({
      slug,
      mergeCount: 1,
      redeemCount: 1,
      authority: {
        tradeTape: "json_verified_by_activity",
        lifecycle: "sqlite_activity",
        verifiedBuyCount: 3,
        totalBuyCount: 3,
        mergeEventCount: 1,
        redeemEventCount: 1,
      },
      finalResidualSide: "FLAT",
      finalResidualBucket: "flat",
    });
    expect(
      bundle.references[0]?.orderedClipSequence.map((event) => ({
        kind: event.kind,
        phase: event.phase,
        tx: event.transactionHash ?? null,
      })),
    ).toEqual([
      { kind: "BUY", phase: "ENTRY", tx: "0xtx1" },
      { kind: "BUY", phase: "COMPLETION", tx: "0xtx2" },
      { kind: "MERGE", phase: "MERGE", tx: null },
      { kind: "BUY", phase: "ENTRY", tx: "0xtx3" },
      { kind: "REDEEM", phase: "REDEEM", tx: null },
    ]);
  });
});
