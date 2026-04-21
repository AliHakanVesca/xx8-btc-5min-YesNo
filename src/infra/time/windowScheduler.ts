import type { Clock } from "./clock.js";

export type MarketPhase =
  | "PREOPEN"
  | "ENTRY"
  | "NORMAL"
  | "COMPLETION_ONLY"
  | "HARD_CANCEL"
  | "CLOSED";

export interface WindowBounds {
  startTs: number;
  endTs: number;
  slug: string;
}

export function getBtc5mWindowStart(unixTs: number): number {
  return Math.floor(unixTs / 300) * 300;
}

export function toBtc5mSlug(startTs: number): string {
  return `btc-updown-5m-${startTs}`;
}

export function getWindowBounds(unixTs: number): WindowBounds {
  const startTs = getBtc5mWindowStart(unixTs);
  return {
    startTs,
    endTs: startTs + 300,
    slug: toBtc5mSlug(startTs),
  };
}

export function getCurrentAndNextWindows(clock: Clock): { current: WindowBounds; next: WindowBounds; previous: WindowBounds } {
  const current = getWindowBounds(clock.now());
  const next = getWindowBounds(current.endTs);
  const previous = getWindowBounds(current.startTs - 1);
  return { current, next, previous };
}

export function getMarketPhase(
  nowTs: number,
  startTs: number,
  endTs: number,
  normalEntryCutoffSecToClose: number,
  completionOnlyCutoffSecToClose: number,
  hardCancelSecToClose: number,
): MarketPhase {
  if (nowTs < startTs) {
    return "PREOPEN";
  }

  if (nowTs >= endTs) {
    return "CLOSED";
  }

  const secsToClose = endTs - nowTs;
  if (secsToClose <= hardCancelSecToClose) {
    return "HARD_CANCEL";
  }
  if (secsToClose <= completionOnlyCutoffSecToClose) {
    return "COMPLETION_ONLY";
  }
  if (secsToClose <= normalEntryCutoffSecToClose) {
    return "NORMAL";
  }
  return "ENTRY";
}
