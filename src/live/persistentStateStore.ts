import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { OutcomeSide } from "../infra/clob/types.js";
import { createMarketState, type FillRecord, type InventoryLot, type MergeRecord, type XuanMarketState } from "../strategy/xuan5m/marketState.js";
import { takerFeePerShare } from "../strategy/xuan5m/sumAvgEngine.js";
import type { StrategyExecutionMode } from "../strategy/xuan5m/executionModes.js";

export const DEFAULT_PERSISTENT_STATE_PATH = "data/runtime/xuan-state.sqlite";
export const RISK_BUDGET_TIME_ZONE = "Europe/Istanbul";

export type PersistentLotSource = "USER_WS" | "BALANCE_RECONCILE" | "REST_RESTORE";
export type PersistentPriceSnapshotKind = "threshold" | "live";
export type PersistentPriceSnapshotSource = "metadata" | "rtds" | "binance" | "chainlink" | "estimated";

export interface StoredPriceSnapshot {
  marketSlug: string;
  conditionId: string;
  kind: PersistentPriceSnapshotKind;
  source: PersistentPriceSnapshotSource;
  price: number;
  timestampMs: number;
  estimatedThreshold: boolean;
  note?: string | undefined;
}

export interface StoredRiskBudget {
  date: string;
  wallet: string;
  dailyNegativeSpentUsdc: number;
  dailyPositiveRealizedUsdc: number;
  marketSlug?: string | undefined;
  marketNegativeSpentUsdc: number;
  resetAt: string;
  updatedAt: string;
}

export interface SafeHaltState {
  active: boolean;
  reason?: string | undefined;
  updatedAt?: number | undefined;
}

export interface PartialPairGroupSnapshot {
  groupId: string;
  status: "UP_ONLY" | "DOWN_ONLY";
  createdAt: number;
}

export interface ValidationRunRecord {
  kind: string;
  status: string;
  timestamp: number;
  payload?: Record<string, unknown> | undefined;
}

export interface PersistentFillContext {
  orderId?: string | undefined;
  groupId?: string | undefined;
  executionMode?: StrategyExecutionMode | undefined;
  source: PersistentLotSource;
  txHash?: string | undefined;
}

interface StoredLotRow {
  lot_id: string;
  group_id: string | null;
  market_slug: string;
  condition_id: string;
  outcome: OutcomeSide;
  side: "BUY" | "SELL";
  qty_original: number;
  qty_open: number;
  price: number;
  effective_price: number;
  fee_usdc: number;
  tx_hash: string | null;
  order_id: string | null;
  execution_mode: string | null;
  source: PersistentLotSource;
  timestamp: number;
}

interface LotConsumption {
  lotId: string;
  qty: number;
  price: number;
  effectivePrice: number;
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function ensureSqliteDir(path: string): void {
  if (path === ":memory:") {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
}

function dateKey(now: Date = new Date(), timeZone = RISK_BUDGET_TIME_ZONE): string {
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

function toInventoryLots(rows: StoredLotRow[]): InventoryLot[] {
  return rows
    .filter((row) => row.qty_open > 1e-6)
    .sort((left, right) => left.timestamp - right.timestamp || left.lot_id.localeCompare(right.lot_id))
    .map((row) => ({
      size: normalize(row.qty_open),
      price: row.price,
      timestamp: row.timestamp,
      executionMode: row.execution_mode === null ? undefined : (row.execution_mode as StrategyExecutionMode),
    }));
}

function computeShares(rows: StoredLotRow[]): number {
  return normalize(rows.reduce((acc, row) => acc + row.qty_open, 0));
}

function computeRawCost(rows: StoredLotRow[]): number {
  return normalize(rows.reduce((acc, row) => acc + row.qty_open * row.price, 0));
}

function computeEffectiveCost(rows: StoredLotRow[]): number {
  return normalize(rows.reduce((acc, row) => acc + row.qty_open * row.effective_price, 0));
}

export class PersistentStateStore {
  private readonly db: DatabaseSync;

  constructor(path = DEFAULT_PERSISTENT_STATE_PATH) {
    ensureSqliteDir(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS pair_groups (
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

      CREATE TABLE IF NOT EXISTS inventory_lots (
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
        close_reason TEXT,
        FOREIGN KEY(group_id) REFERENCES pair_groups(group_id)
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_lots_market_outcome_open
      ON inventory_lots (market_slug, outcome, qty_open, timestamp);

      CREATE TABLE IF NOT EXISTS lot_matches (
        match_id TEXT PRIMARY KEY,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        up_lot_id TEXT NOT NULL,
        down_lot_id TEXT NOT NULL,
        matched_qty REAL NOT NULL,
        up_cost_basis REAL NOT NULL,
        down_cost_basis REAL NOT NULL,
        effective_pair_cost REAL NOT NULL,
        expected_merge_return REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        merge_tx_hash TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS merge_events (
        merge_id TEXT PRIMARY KEY,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        amount REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        simulated INTEGER NOT NULL,
        matched_up_cost REAL,
        matched_down_cost REAL,
        merge_return REAL,
        realized_pnl REAL,
        remaining_up_shares REAL,
        remaining_down_shares REAL,
        tx_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS merge_redeem_events (
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

      CREATE TABLE IF NOT EXISTS market_state (
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

      CREATE TABLE IF NOT EXISTS external_activity (
        activity_id TEXT PRIMARY KEY,
        market_slug TEXT,
        condition_id TEXT,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        tx_hash TEXT,
        reason TEXT,
        bot_recognized INTEGER NOT NULL,
        response_mode TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_budgets (
        budget_id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        wallet TEXT NOT NULL,
        daily_negative_spent_usdc REAL NOT NULL,
        daily_positive_realized_usdc REAL NOT NULL,
        market_slug TEXT,
        market_negative_spent_usdc REAL NOT NULL,
        reset_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_budgets_date_wallet
      ON risk_budgets (date, wallet);

      CREATE TABLE IF NOT EXISTS market_rollovers (
        rollover_id TEXT PRIMARY KEY,
        market_slug TEXT,
        condition_id TEXT,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT
      );

      CREATE TABLE IF NOT EXISTS reconcile_runs (
        reconcile_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        market_slug TEXT,
        condition_id TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        requires_manual_resume INTEGER NOT NULL,
        mismatch_shares REAL,
        payload_json TEXT
      );

      CREATE TABLE IF NOT EXISTS validation_runs (
        validation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_flags (
        flag_key TEXT PRIMARY KEY,
        flag_value TEXT NOT NULL,
        reason TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS price_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        price REAL NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        estimated_threshold INTEGER NOT NULL,
        note TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertPairGroup(group: {
    groupId: string;
    marketSlug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    intendedQty: number;
    maxUpPrice?: number | undefined;
    maxDownPrice?: number | undefined;
    orderType: string;
    mode: string;
    selectedMode: string;
    createdAt: number;
    status: string;
    baselineUpShares: number;
    baselineDownShares: number;
    rawPair: number;
    effectivePair: number;
    negativeEdgeUsdc: number;
    marketNegativeSpentBefore: number;
    marketNegativeSpentAfter: number;
  }): void {
    const payload = {
      ...group,
      maxUpPrice: group.maxUpPrice ?? null,
      maxDownPrice: group.maxDownPrice ?? null,
    };
    this.db
      .prepare(`
        INSERT INTO pair_groups (
          group_id, market_slug, condition_id, up_token_id, down_token_id, intended_qty,
          max_up_price, max_down_price, order_type, mode, selected_mode, created_at, status,
          baseline_up_shares, baseline_down_shares, raw_pair, effective_pair, negative_edge_usdc,
          market_negative_spent_before, market_negative_spent_after
        ) VALUES (
          @groupId, @marketSlug, @conditionId, @upTokenId, @downTokenId, @intendedQty,
          @maxUpPrice, @maxDownPrice, @orderType, @mode, @selectedMode, @createdAt, @status,
          @baselineUpShares, @baselineDownShares, @rawPair, @effectivePair, @negativeEdgeUsdc,
          @marketNegativeSpentBefore, @marketNegativeSpentAfter
        )
        ON CONFLICT(group_id) DO UPDATE SET
          status = excluded.status,
          max_up_price = excluded.max_up_price,
          max_down_price = excluded.max_down_price,
          negative_edge_usdc = excluded.negative_edge_usdc,
          market_negative_spent_before = excluded.market_negative_spent_before,
          market_negative_spent_after = excluded.market_negative_spent_after
      `)
      .run(payload);
  }

  recordFill(state: XuanMarketState, fill: FillRecord, context: PersistentFillContext): void {
    if (fill.side === "BUY") {
      const feePerShare = takerFeePerShare(fill.price, state.market.feeRate);
      this.db
        .prepare(`
          INSERT INTO inventory_lots (
            lot_id, group_id, market_slug, condition_id, outcome, side, qty_original, qty_open, price,
            effective_price, fee_usdc, tx_hash, order_id, execution_mode, source, timestamp
          ) VALUES (
            @lotId, @groupId, @marketSlug, @conditionId, @outcome, @side, @qtyOriginal, @qtyOpen, @price,
            @effectivePrice, @feeUsdc, @txHash, @orderId, @executionMode, @source, @timestamp
          )
        `)
        .run({
          lotId: randomUUID(),
          groupId: context.groupId ?? null,
          marketSlug: state.market.slug,
          conditionId: state.market.conditionId,
          outcome: fill.outcome,
          side: fill.side,
          qtyOriginal: normalize(fill.size),
          qtyOpen: normalize(fill.size),
          price: fill.price,
          effectivePrice: normalize(fill.price + feePerShare),
          feeUsdc: normalize(fill.size * feePerShare),
          txHash: context.txHash ?? null,
          orderId: context.orderId ?? null,
          executionMode: context.executionMode ?? fill.executionMode ?? null,
          source: context.source,
          timestamp: fill.timestamp,
        });
      return;
    }

    const consumed = this.consumeLots(state.market.slug, fill.outcome, fill.size, fill.timestamp, "sell");
    if (consumed.consumedQty <= 1e-6) {
      return;
    }
  }

  recordMerge(state: XuanMarketState, merge: MergeRecord): void {
    const matchedQty = normalize(Math.min(state.upShares, state.downShares, merge.amount));
    if (matchedQty <= 1e-6) {
      return;
    }

    const upConsumed = this.consumeLots(state.market.slug, "UP", matchedQty, merge.timestamp, "merge");
    const downConsumed = this.consumeLots(state.market.slug, "DOWN", matchedQty, merge.timestamp, "merge");
    let upIndex = 0;
    let downIndex = 0;

    while (upIndex < upConsumed.parts.length && downIndex < downConsumed.parts.length) {
      const up = upConsumed.parts[upIndex]!;
      const down = downConsumed.parts[downIndex]!;
      const qty = normalize(Math.min(up.qty, down.qty));
      const upCostBasis = normalize(qty * up.price);
      const downCostBasis = normalize(qty * down.price);
      this.db
        .prepare(`
          INSERT INTO lot_matches (
            match_id, market_slug, condition_id, up_lot_id, down_lot_id, matched_qty,
            up_cost_basis, down_cost_basis, effective_pair_cost, expected_merge_return,
            realized_pnl, merge_tx_hash, created_at
          ) VALUES (
            @matchId, @marketSlug, @conditionId, @upLotId, @downLotId, @matchedQty,
            @upCostBasis, @downCostBasis, @effectivePairCost, @expectedMergeReturn,
            @realizedPnl, @mergeTxHash, @createdAt
          )
        `)
        .run({
          matchId: randomUUID(),
          marketSlug: state.market.slug,
          conditionId: state.market.conditionId,
          upLotId: up.lotId,
          downLotId: down.lotId,
          matchedQty: qty,
          upCostBasis,
          downCostBasis,
          effectivePairCost: normalize(up.effectivePrice + down.effectivePrice),
          expectedMergeReturn: qty,
          realizedPnl: normalize(qty - upCostBasis - downCostBasis),
          mergeTxHash: null,
          createdAt: merge.timestamp,
        });

      up.qty = normalize(up.qty - qty);
      down.qty = normalize(down.qty - qty);
      if (up.qty <= 1e-6) {
        upIndex += 1;
      }
      if (down.qty <= 1e-6) {
        downIndex += 1;
      }
    }

    this.db
      .prepare(`
        INSERT INTO merge_events (
          merge_id, market_slug, condition_id, amount, timestamp, simulated, matched_up_cost,
          matched_down_cost, merge_return, realized_pnl, remaining_up_shares, remaining_down_shares, tx_hash
        ) VALUES (
          @mergeId, @marketSlug, @conditionId, @amount, @timestamp, @simulated, @matchedUpCost,
          @matchedDownCost, @mergeReturn, @realizedPnl, @remainingUpShares, @remainingDownShares, @txHash
        )
      `)
      .run({
        mergeId: randomUUID(),
        marketSlug: state.market.slug,
        conditionId: state.market.conditionId,
        amount: matchedQty,
        timestamp: merge.timestamp,
        simulated: merge.simulated ? 1 : 0,
        matchedUpCost: merge.matchedUpCost ?? null,
        matchedDownCost: merge.matchedDownCost ?? null,
        mergeReturn: merge.mergeReturn ?? null,
        realizedPnl: merge.realizedPnl ?? null,
        remainingUpShares: merge.remainingUpShares ?? null,
        remainingDownShares: merge.remainingDownShares ?? null,
        txHash: null,
      });

    this.recordMergeRedeemEvent({
      marketSlug: state.market.slug,
      conditionId: state.market.conditionId,
      action: "merge",
      amount: matchedQty,
      timestamp: merge.timestamp,
      simulated: merge.simulated,
      matchedUpCost: merge.matchedUpCost,
      matchedDownCost: merge.matchedDownCost,
      mergeReturn: merge.mergeReturn,
      realizedPnl: merge.realizedPnl,
      remainingUpShares: merge.remainingUpShares,
      remainingDownShares: merge.remainingDownShares,
    });
  }

  recordExternalActivity(args: {
    marketSlug?: string | undefined;
    conditionId?: string | undefined;
    timestamp: number;
    type: string;
    action: string;
    txHash?: string | undefined;
    reason?: string | undefined;
    botRecognized: boolean;
    responseMode: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO external_activity (
          activity_id, market_slug, condition_id, timestamp, type, action, tx_hash,
          reason, bot_recognized, response_mode
        ) VALUES (
          @activityId, @marketSlug, @conditionId, @timestamp, @type, @action, @txHash,
          @reason, @botRecognized, @responseMode
        )
      `)
      .run({
        activityId: randomUUID(),
        marketSlug: args.marketSlug ?? null,
        conditionId: args.conditionId ?? null,
        timestamp: args.timestamp,
        type: args.type,
        action: args.action,
        txHash: args.txHash ?? null,
        reason: args.reason ?? null,
        botRecognized: args.botRecognized ? 1 : 0,
        responseMode: args.responseMode,
      });
  }

  recordMergeRedeemEvent(args: {
    marketSlug: string;
    conditionId: string;
    action: "merge" | "redeem";
    amount?: number | undefined;
    timestamp: number;
    simulated: boolean;
    reason?: string | undefined;
    matchedUpCost?: number | undefined;
    matchedDownCost?: number | undefined;
    mergeReturn?: number | undefined;
    realizedPnl?: number | undefined;
    remainingUpShares?: number | undefined;
    remainingDownShares?: number | undefined;
    txHash?: string | undefined;
  }): void {
    this.db
      .prepare(`
        INSERT INTO merge_redeem_events (
          event_id, market_slug, condition_id, action, amount, timestamp, simulated, reason,
          matched_up_cost, matched_down_cost, merge_return, realized_pnl,
          remaining_up_shares, remaining_down_shares, tx_hash
        ) VALUES (
          @eventId, @marketSlug, @conditionId, @action, @amount, @timestamp, @simulated, @reason,
          @matchedUpCost, @matchedDownCost, @mergeReturn, @realizedPnl,
          @remainingUpShares, @remainingDownShares, @txHash
        )
      `)
      .run({
        eventId: randomUUID(),
        marketSlug: args.marketSlug,
        conditionId: args.conditionId,
        action: args.action,
        amount: args.amount ?? null,
        timestamp: args.timestamp,
        simulated: args.simulated ? 1 : 0,
        reason: args.reason ?? null,
        matchedUpCost: args.matchedUpCost ?? null,
        matchedDownCost: args.matchedDownCost ?? null,
        mergeReturn: args.mergeReturn ?? null,
        realizedPnl: args.realizedPnl ?? null,
        remainingUpShares: args.remainingUpShares ?? null,
        remainingDownShares: args.remainingDownShares ?? null,
        txHash: args.txHash ?? null,
      });
  }

  loadRiskBudget(args: {
    wallet: string;
    now?: Date | undefined;
    timeZone?: string | undefined;
  }): StoredRiskBudget {
    const date = dateKey(args.now, args.timeZone);
    const row = this.db
      .prepare(`
        SELECT date, wallet, daily_negative_spent_usdc, daily_positive_realized_usdc,
               market_slug, market_negative_spent_usdc, reset_at, updated_at
        FROM risk_budgets
        WHERE date = ? AND wallet = ?
        LIMIT 1
      `)
      .get(date, args.wallet) as
      | {
          date: string;
          wallet: string;
          daily_negative_spent_usdc: number;
          daily_positive_realized_usdc: number;
          market_slug: string | null;
          market_negative_spent_usdc: number;
          reset_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return {
        date,
        wallet: args.wallet,
        dailyNegativeSpentUsdc: 0,
        dailyPositiveRealizedUsdc: 0,
        marketNegativeSpentUsdc: 0,
        resetAt: (args.now ?? new Date()).toISOString(),
        updatedAt: (args.now ?? new Date()).toISOString(),
      };
    }

    return {
      date: row.date,
      wallet: row.wallet,
      dailyNegativeSpentUsdc: row.daily_negative_spent_usdc,
      dailyPositiveRealizedUsdc: row.daily_positive_realized_usdc,
      marketSlug: row.market_slug ?? undefined,
      marketNegativeSpentUsdc: row.market_negative_spent_usdc,
      resetAt: row.reset_at,
      updatedAt: row.updated_at,
    };
  }

  upsertRiskBudget(args: {
    wallet: string;
    dailyNegativeSpentUsdc: number;
    dailyPositiveRealizedUsdc?: number | undefined;
    marketSlug?: string | undefined;
    marketNegativeSpentUsdc?: number | undefined;
    now?: Date | undefined;
    timeZone?: string | undefined;
  }): StoredRiskBudget {
    const now = args.now ?? new Date();
    const date = dateKey(now, args.timeZone);
    const current = this.loadRiskBudget({
      wallet: args.wallet,
      now,
      timeZone: args.timeZone,
    });
    const payload: StoredRiskBudget = {
      date,
      wallet: args.wallet,
      dailyNegativeSpentUsdc: normalize(args.dailyNegativeSpentUsdc),
      dailyPositiveRealizedUsdc: normalize(args.dailyPositiveRealizedUsdc ?? current.dailyPositiveRealizedUsdc),
      marketSlug: args.marketSlug ?? current.marketSlug,
      marketNegativeSpentUsdc: normalize(args.marketNegativeSpentUsdc ?? current.marketNegativeSpentUsdc),
      resetAt: current.resetAt,
      updatedAt: now.toISOString(),
    };
    this.db
      .prepare(`
        INSERT INTO risk_budgets (
          budget_id, date, wallet, daily_negative_spent_usdc, daily_positive_realized_usdc,
          market_slug, market_negative_spent_usdc, reset_at, updated_at
        ) VALUES (
          @budgetId, @date, @wallet, @dailyNegativeSpentUsdc, @dailyPositiveRealizedUsdc,
          @marketSlug, @marketNegativeSpentUsdc, @resetAt, @updatedAt
        )
        ON CONFLICT(date, wallet) DO UPDATE SET
          daily_negative_spent_usdc = excluded.daily_negative_spent_usdc,
          daily_positive_realized_usdc = excluded.daily_positive_realized_usdc,
          market_slug = excluded.market_slug,
          market_negative_spent_usdc = excluded.market_negative_spent_usdc,
          updated_at = excluded.updated_at
      `)
      .run({
        budgetId: randomUUID(),
        ...payload,
        marketSlug: payload.marketSlug ?? null,
      });
    return payload;
  }

  recordMarketRollover(args: {
    status: string;
    timestamp: number;
    marketSlug?: string | undefined;
    conditionId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  }): void {
    this.db
      .prepare(`
        INSERT INTO market_rollovers (
          rollover_id, market_slug, condition_id, status, timestamp, payload_json
        ) VALUES (
          @rolloverId, @marketSlug, @conditionId, @status, @timestamp, @payloadJson
        )
      `)
      .run({
        rolloverId: randomUUID(),
        marketSlug: args.marketSlug ?? null,
        conditionId: args.conditionId ?? null,
        status: args.status,
        timestamp: args.timestamp,
        payloadJson: args.payload ? JSON.stringify(args.payload) : null,
      });
  }

  recordReconcileRun(args: {
    scope: string;
    timestamp: number;
    status: string;
    requiresManualResume: boolean;
    marketSlug?: string | undefined;
    conditionId?: string | undefined;
    mismatchShares?: number | undefined;
    payload?: Record<string, unknown> | undefined;
  }): void {
    this.db
      .prepare(`
        INSERT INTO reconcile_runs (
          reconcile_id, scope, market_slug, condition_id, timestamp, status,
          requires_manual_resume, mismatch_shares, payload_json
        ) VALUES (
          @reconcileId, @scope, @marketSlug, @conditionId, @timestamp, @status,
          @requiresManualResume, @mismatchShares, @payloadJson
        )
      `)
      .run({
        reconcileId: randomUUID(),
        scope: args.scope,
        marketSlug: args.marketSlug ?? null,
        conditionId: args.conditionId ?? null,
        timestamp: args.timestamp,
        status: args.status,
        requiresManualResume: args.requiresManualResume ? 1 : 0,
        mismatchShares: args.mismatchShares ?? null,
        payloadJson: args.payload ? JSON.stringify(args.payload) : null,
      });
  }

  setSafeHalt(args: { active: boolean; reason?: string | undefined; timestamp?: number | undefined }): void {
    this.db
      .prepare(`
        INSERT INTO runtime_flags (flag_key, flag_value, reason, updated_at)
        VALUES ('safe_halt', @flagValue, @reason, @updatedAt)
        ON CONFLICT(flag_key) DO UPDATE SET
          flag_value = excluded.flag_value,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `)
      .run({
        flagValue: args.active ? "1" : "0",
        reason: args.reason ?? null,
        updatedAt: args.timestamp ?? Math.floor(Date.now() / 1000),
      });
  }

  loadSafeHalt(): SafeHaltState {
    const row = this.db
      .prepare(`
        SELECT flag_value, reason, updated_at
        FROM runtime_flags
        WHERE flag_key = 'safe_halt'
        LIMIT 1
      `)
      .get() as
      | {
          flag_value: string;
          reason: string | null;
          updated_at: number;
        }
      | undefined;
    return {
      active: row?.flag_value === "1",
      reason: row?.reason ?? undefined,
      updatedAt: row?.updated_at,
    };
  }

  latestReconcileRun(): { timestamp: number; status: string; requiresManualResume: boolean } | undefined {
    const row = this.db
      .prepare(`
        SELECT timestamp, status, requires_manual_resume
        FROM reconcile_runs
        ORDER BY timestamp DESC
        LIMIT 1
      `)
      .get() as
      | {
          timestamp: number;
          status: string;
          requires_manual_resume: number;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      timestamp: row.timestamp,
      status: row.status,
      requiresManualResume: Boolean(row.requires_manual_resume),
    };
  }

  recordValidationRun(args: {
    kind: string;
    status: string;
    timestamp: number;
    payload?: Record<string, unknown> | undefined;
  }): void {
    this.db
      .prepare(`
        INSERT INTO validation_runs (
          validation_id, kind, status, timestamp, payload_json
        ) VALUES (
          @validationId, @kind, @status, @timestamp, @payloadJson
        )
      `)
      .run({
        validationId: randomUUID(),
        kind: args.kind,
        status: args.status,
        timestamp: args.timestamp,
        payloadJson: args.payload ? JSON.stringify(args.payload) : null,
      });
  }

  latestValidationRun(kind?: string): ValidationRunRecord | undefined {
    const row = kind
      ? (this.db
          .prepare(`
            SELECT kind, status, timestamp, payload_json
            FROM validation_runs
            WHERE kind = ?
            ORDER BY timestamp DESC
            LIMIT 1
          `)
          .get(kind) as
          | {
              kind: string;
              status: string;
              timestamp: number;
              payload_json: string | null;
            }
          | undefined)
      : (this.db
          .prepare(`
            SELECT kind, status, timestamp, payload_json
            FROM validation_runs
            ORDER BY timestamp DESC
            LIMIT 1
          `)
          .get() as
          | {
              kind: string;
              status: string;
              timestamp: number;
              payload_json: string | null;
            }
          | undefined);
    if (!row) {
      return undefined;
    }
    return {
      kind: row.kind,
      status: row.status,
      timestamp: row.timestamp,
      payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : undefined,
    };
  }

  recordPriceSnapshot(snapshot: StoredPriceSnapshot): void {
    this.db
      .prepare(`
        INSERT INTO price_snapshots (
          snapshot_id, market_slug, condition_id, kind, source, price, timestamp_ms, estimated_threshold, note
        ) VALUES (
          @snapshotId, @marketSlug, @conditionId, @kind, @source, @price, @timestampMs, @estimatedThreshold, @note
        )
      `)
      .run({
        snapshotId: randomUUID(),
        marketSlug: snapshot.marketSlug,
        conditionId: snapshot.conditionId,
        kind: snapshot.kind,
        source: snapshot.source,
        price: snapshot.price,
        timestampMs: snapshot.timestampMs,
        estimatedThreshold: snapshot.estimatedThreshold ? 1 : 0,
        note: snapshot.note ?? null,
      });
  }

  loadLatestPriceSnapshot(
    marketSlug: string,
    kind: PersistentPriceSnapshotKind,
  ): StoredPriceSnapshot | undefined {
    const row = this.db
      .prepare(`
        SELECT market_slug, condition_id, kind, source, price, timestamp_ms, estimated_threshold, note
        FROM price_snapshots
        WHERE market_slug = ? AND kind = ?
        ORDER BY timestamp_ms DESC
        LIMIT 1
      `)
      .get(marketSlug, kind) as
      | {
          market_slug: string;
          condition_id: string;
          kind: PersistentPriceSnapshotKind;
          source: PersistentPriceSnapshotSource;
          price: number;
          timestamp_ms: number;
          estimated_threshold: number;
          note: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      marketSlug: row.market_slug,
      conditionId: row.condition_id,
      kind: row.kind,
      source: row.source,
      price: row.price,
      timestampMs: row.timestamp_ms,
      estimatedThreshold: Boolean(row.estimated_threshold),
      note: row.note ?? undefined,
    };
  }

  upsertMarketState(state: XuanMarketState, noNewEntryReason?: string | undefined): void {
    const upRows = this.loadOpenLotRows(state.market.slug, "UP");
    const downRows = this.loadOpenLotRows(state.market.slug, "DOWN");
    const upShares = computeShares(upRows);
    const downShares = computeShares(downRows);
    const mergeable = normalize(Math.min(upShares, downShares));
    const residualUp = normalize(Math.max(0, upShares - mergeable));
    const residualDown = normalize(Math.max(0, downShares - mergeable));
    const residualUpAvgCost = upShares > 0 ? normalize(computeRawCost(upRows) / upShares) : 0;
    const residualDownAvgCost = downShares > 0 ? normalize(computeRawCost(downRows) / downShares) : 0;
    const residualUpAvgEffectiveCost = upShares > 0 ? normalize(computeEffectiveCost(upRows) / upShares) : 0;
    const residualDownAvgEffectiveCost = downShares > 0 ? normalize(computeEffectiveCost(downRows) / downShares) : 0;

    this.db
      .prepare(`
        INSERT INTO market_state (
          market_slug, condition_id, up_shares, down_shares, mergeable, residual_up, residual_down,
          residual_up_avg_cost, residual_down_avg_cost, residual_up_avg_effective_cost,
          residual_down_avg_effective_cost, negative_edge_consumed_usdc, negative_pair_edge_consumed_usdc,
          negative_completion_edge_consumed_usdc, last_execution_mode, consecutive_seed_side,
          consecutive_seed_count, reentry_disabled, post_merge_completion_only_until, updated_at, no_new_entry_reason
        ) VALUES (
          @marketSlug, @conditionId, @upShares, @downShares, @mergeable, @residualUp, @residualDown,
          @residualUpAvgCost, @residualDownAvgCost, @residualUpAvgEffectiveCost,
          @residualDownAvgEffectiveCost, @negativeEdgeConsumedUsdc, @negativePairEdgeConsumedUsdc,
          @negativeCompletionEdgeConsumedUsdc, @lastExecutionMode, @consecutiveSeedSide,
          @consecutiveSeedCount, @reentryDisabled, @postMergeCompletionOnlyUntil, @updatedAt, @noNewEntryReason
        )
        ON CONFLICT(market_slug) DO UPDATE SET
          condition_id = excluded.condition_id,
          up_shares = excluded.up_shares,
          down_shares = excluded.down_shares,
          mergeable = excluded.mergeable,
          residual_up = excluded.residual_up,
          residual_down = excluded.residual_down,
          residual_up_avg_cost = excluded.residual_up_avg_cost,
          residual_down_avg_cost = excluded.residual_down_avg_cost,
          residual_up_avg_effective_cost = excluded.residual_up_avg_effective_cost,
          residual_down_avg_effective_cost = excluded.residual_down_avg_effective_cost,
          negative_edge_consumed_usdc = excluded.negative_edge_consumed_usdc,
          negative_pair_edge_consumed_usdc = excluded.negative_pair_edge_consumed_usdc,
          negative_completion_edge_consumed_usdc = excluded.negative_completion_edge_consumed_usdc,
          last_execution_mode = excluded.last_execution_mode,
          consecutive_seed_side = excluded.consecutive_seed_side,
          consecutive_seed_count = excluded.consecutive_seed_count,
          reentry_disabled = excluded.reentry_disabled,
          post_merge_completion_only_until = excluded.post_merge_completion_only_until,
          updated_at = excluded.updated_at,
          no_new_entry_reason = excluded.no_new_entry_reason
      `)
      .run({
        marketSlug: state.market.slug,
        conditionId: state.market.conditionId,
        upShares,
        downShares,
        mergeable,
        residualUp,
        residualDown,
        residualUpAvgCost,
        residualDownAvgCost,
        residualUpAvgEffectiveCost,
        residualDownAvgEffectiveCost,
        negativeEdgeConsumedUsdc: state.negativeEdgeConsumedUsdc,
        negativePairEdgeConsumedUsdc: state.negativePairEdgeConsumedUsdc,
        negativeCompletionEdgeConsumedUsdc: state.negativeCompletionEdgeConsumedUsdc,
        lastExecutionMode: state.lastExecutionMode ?? null,
        consecutiveSeedSide: state.consecutiveSeedSide ?? null,
        consecutiveSeedCount: state.consecutiveSeedCount,
        reentryDisabled: state.reentryDisabled ? 1 : 0,
        postMergeCompletionOnlyUntil: state.postMergeCompletionOnlyUntil ?? null,
        updatedAt: Math.floor(Date.now() / 1000),
        noNewEntryReason: noNewEntryReason ?? null,
      });
  }

  loadMarketState(state: XuanMarketState): XuanMarketState {
    const snapshot = this.db
      .prepare(`
        SELECT *
        FROM market_state
        WHERE market_slug = ?
        LIMIT 1
      `)
      .get(state.market.slug) as
      | {
          negative_edge_consumed_usdc: number;
          negative_pair_edge_consumed_usdc: number;
          negative_completion_edge_consumed_usdc: number;
          last_execution_mode: string | null;
          consecutive_seed_side: OutcomeSide | null;
          consecutive_seed_count: number;
          reentry_disabled: number;
          post_merge_completion_only_until: number | null;
        }
      | undefined;

    const upRows = this.loadOpenLotRows(state.market.slug, "UP");
    const downRows = this.loadOpenLotRows(state.market.slug, "DOWN");
    if (upRows.length === 0 && downRows.length === 0 && !snapshot) {
      return state;
    }

    return {
      ...state,
      upLots: toInventoryLots(upRows),
      downLots: toInventoryLots(downRows),
      upShares: computeShares(upRows),
      downShares: computeShares(downRows),
      upCost: computeRawCost(upRows),
      downCost: computeRawCost(downRows),
      negativeEdgeConsumedUsdc: snapshot?.negative_edge_consumed_usdc ?? 0,
      negativePairEdgeConsumedUsdc: snapshot?.negative_pair_edge_consumed_usdc ?? 0,
      negativeCompletionEdgeConsumedUsdc: snapshot?.negative_completion_edge_consumed_usdc ?? 0,
      lastExecutionMode:
        snapshot?.last_execution_mode === null
          ? undefined
          : (snapshot?.last_execution_mode as StrategyExecutionMode),
      consecutiveSeedSide: snapshot?.consecutive_seed_side ?? undefined,
      consecutiveSeedCount: snapshot?.consecutive_seed_count ?? 0,
      reentryDisabled: Boolean(snapshot?.reentry_disabled ?? 0),
      postMergeCompletionOnlyUntil: snapshot?.post_merge_completion_only_until ?? undefined,
    };
  }

  loadPairGroupFillSnapshot(groupId: string): { upBoughtQty: number; downBoughtQty: number } {
    const rows = this.db
      .prepare(`
        SELECT outcome, COALESCE(SUM(qty_original), 0) AS bought_qty
        FROM inventory_lots
        WHERE group_id = ? AND side = 'BUY'
        GROUP BY outcome
      `)
      .all(groupId) as Array<{ outcome: OutcomeSide; bought_qty: number }>;

    return {
      upBoughtQty: normalize(rows.find((row) => row.outcome === "UP")?.bought_qty ?? 0),
      downBoughtQty: normalize(rows.find((row) => row.outcome === "DOWN")?.bought_qty ?? 0),
    };
  }

  loadLatestOpenPartialPairGroup(marketSlug: string): PartialPairGroupSnapshot | undefined {
    const row = this.db
      .prepare(`
        SELECT group_id, status, created_at
        FROM pair_groups
        WHERE market_slug = ? AND status IN ('UP_ONLY', 'DOWN_ONLY')
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(marketSlug) as
      | {
          group_id: string;
          status: "UP_ONLY" | "DOWN_ONLY";
          created_at: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      groupId: row.group_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private consumeLots(
    marketSlug: string,
    outcome: OutcomeSide,
    requestedQty: number,
    closedAt: number,
    closeReason: "merge" | "sell",
  ): { consumedQty: number; parts: LotConsumption[] } {
    const rows = this.loadOpenLotRows(marketSlug, outcome);
    let remaining = normalize(requestedQty);
    const parts: LotConsumption[] = [];

    for (const row of rows) {
      if (remaining <= 1e-6) {
        break;
      }
      const takeQty = normalize(Math.min(row.qty_open, remaining));
      if (takeQty <= 1e-6) {
        continue;
      }
      const nextQtyOpen = normalize(row.qty_open - takeQty);
      this.db
        .prepare(`
          UPDATE inventory_lots
          SET qty_open = ?, closed_at = CASE WHEN ? <= 1e-6 THEN ? ELSE closed_at END,
              close_reason = CASE WHEN ? <= 1e-6 THEN ? ELSE close_reason END
          WHERE lot_id = ?
        `)
        .run(nextQtyOpen, nextQtyOpen, closedAt, nextQtyOpen, closeReason, row.lot_id);
      parts.push({
        lotId: row.lot_id,
        qty: takeQty,
        price: row.price,
        effectivePrice: row.effective_price,
      });
      remaining = normalize(remaining - takeQty);
    }

    return {
      consumedQty: normalize(requestedQty - remaining),
      parts,
    };
  }

  private loadOpenLotRows(marketSlug: string, outcome: OutcomeSide): StoredLotRow[] {
    return this.db
      .prepare(`
        SELECT *
        FROM inventory_lots
        WHERE market_slug = ? AND outcome = ? AND qty_open > 1e-6
        ORDER BY timestamp ASC, lot_id ASC
      `)
      .all(marketSlug, outcome) as unknown as StoredLotRow[];
  }
}
