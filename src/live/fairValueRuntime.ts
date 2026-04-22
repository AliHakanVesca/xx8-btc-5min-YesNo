import type { MarketInfo } from "../infra/clob/types.js";
import type { BtcPriceFeed } from "../infra/ws/btcPriceFeed.js";
import { evaluateFairValue, type FairValueSnapshot } from "../strategy/xuan5m/fairValueEngine.js";
import type { XuanStrategyConfig } from "../config/strategyPresets.js";
import type { PersistentStateStore } from "./persistentStateStore.js";

export class MarketFairValueRuntime {
  private priceToBeat: number | undefined;
  private priceToBeatSource: string | undefined;
  private priceToBeatTimestampMs: number | undefined;
  private estimatedThreshold = false;
  private lastLiveSnapshotSecond = 0;

  constructor(
    private readonly config: Pick<
      XuanStrategyConfig,
      | "enableFairValueFilter"
      | "fairValueMaxSourceDivergenceFrac"
      | "fairValueMaxSourceDivergenceUsd"
      | "priceToBeatPolicy"
      | "priceToBeatStartCaptureWindowMs"
      | "priceToBeatMaxFeedAgeMs"
      | "priceToBeatProvisionalAllowed"
      | "priceToBeatExplicitOverrideAllowed"
      | "priceToBeatFailClosedAfterSec"
    >,
    private readonly market: MarketInfo,
    private readonly stateStore: PersistentStateStore,
    private readonly priceFeed: BtcPriceFeed,
  ) {
    const storedThreshold = stateStore.loadLatestPriceSnapshot(market.slug, "threshold");
    if (storedThreshold) {
      this.priceToBeat = storedThreshold.price;
      this.priceToBeatSource = storedThreshold.source;
      this.priceToBeatTimestampMs = storedThreshold.timestampMs;
      this.estimatedThreshold = storedThreshold.estimatedThreshold;
    }
    this.applyExplicitThreshold();
  }

  evaluate(nowTs: number): FairValueSnapshot {
    const feedSnapshot = this.priceFeed.snapshot();
    this.applyExplicitThreshold();
    this.maybeCaptureThreshold(nowTs, feedSnapshot);
    this.maybePersistLiveSnapshot(nowTs, feedSnapshot);
    const snapshot = evaluateFairValue({
      config: this.config,
      marketStartTs: this.market.startTs,
      marketEndTs: this.market.endTs,
      nowTs,
      priceToBeat: this.priceToBeat,
      priceToBeatSource: this.priceToBeatSource,
      priceToBeatTimestampMs: this.priceToBeatTimestampMs,
      estimatedThreshold: this.estimatedThreshold,
      primaryPrice: feedSnapshot.primary,
      secondaryPrice: feedSnapshot.secondary,
      history: feedSnapshot.history,
    });
    if (
      snapshot.status === "threshold_missing" &&
      nowTs - this.market.startTs >= this.config.priceToBeatFailClosedAfterSec
    ) {
      return {
        ...snapshot,
        note: "price_to_beat_fail_closed",
      };
    }
    return snapshot;
  }

  private maybeCaptureThreshold(nowTs: number, feedSnapshot: ReturnType<BtcPriceFeed["snapshot"]>): void {
    if (this.priceToBeat !== undefined) {
      return;
    }
    if (this.config.priceToBeatPolicy !== "EXPLICIT_OR_START_CAPTURE") {
      return;
    }
    if (!this.config.priceToBeatProvisionalAllowed) {
      return;
    }
    if (nowTs < this.market.startTs) {
      return;
    }
    if (!feedSnapshot.primary) {
      return;
    }
    const driftMs = (nowTs - this.market.startTs) * 1000;
    if (driftMs > this.config.priceToBeatStartCaptureWindowMs) {
      return;
    }
    if (Date.now() - feedSnapshot.primary.timestampMs > this.config.priceToBeatMaxFeedAgeMs) {
      return;
    }

    this.priceToBeat = feedSnapshot.primary.price;
    this.priceToBeatSource = "estimated";
    this.priceToBeatTimestampMs = feedSnapshot.primary.timestampMs;
    this.estimatedThreshold = true;
    this.stateStore.recordPriceSnapshot({
      marketSlug: this.market.slug,
      conditionId: this.market.conditionId,
      kind: "threshold",
      source: "estimated",
      price: this.priceToBeat,
      timestampMs: this.priceToBeatTimestampMs,
      estimatedThreshold: this.estimatedThreshold,
      note: `captured_${Math.floor(driftMs)}ms_after_start`,
    });
  }

  private applyExplicitThreshold(): void {
    if (this.market.priceToBeat === undefined || !Number.isFinite(this.market.priceToBeat) || this.market.priceToBeat <= 0) {
      return;
    }
    if (this.priceToBeat !== undefined && !this.config.priceToBeatExplicitOverrideAllowed && this.estimatedThreshold) {
      return;
    }
    if (this.priceToBeat === this.market.priceToBeat && this.priceToBeatSource === "metadata") {
      return;
    }
    this.priceToBeat = this.market.priceToBeat;
    this.priceToBeatSource = this.market.priceToBeatSource ?? "metadata";
    this.priceToBeatTimestampMs = this.market.startTs * 1000;
    this.estimatedThreshold = false;
    this.stateStore.recordPriceSnapshot({
      marketSlug: this.market.slug,
      conditionId: this.market.conditionId,
      kind: "threshold",
      source: "metadata",
      price: this.market.priceToBeat,
      timestampMs: this.priceToBeatTimestampMs,
      estimatedThreshold: false,
      note: "explicit_threshold",
    });
  }

  private maybePersistLiveSnapshot(nowTs: number, feedSnapshot: ReturnType<BtcPriceFeed["snapshot"]>): void {
    if (!feedSnapshot.primary) {
      return;
    }
    if (nowTs === this.lastLiveSnapshotSecond) {
      return;
    }
    this.lastLiveSnapshotSecond = nowTs;
    this.stateStore.recordPriceSnapshot({
      marketSlug: this.market.slug,
      conditionId: this.market.conditionId,
      kind: "live",
      source: feedSnapshot.primary.source,
      price: feedSnapshot.primary.price,
      timestampMs: feedSnapshot.primary.timestampMs,
      estimatedThreshold: false,
      note: "live_btc_price",
    });
  }
}
