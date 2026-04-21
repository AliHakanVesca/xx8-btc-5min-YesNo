export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function roundToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) {
    return value;
  }
  return Math.round(value / tickSize) * tickSize;
}

export function roundDownToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) {
    return value;
  }
  return Math.floor(value / tickSize) * tickSize;
}

export function roundUpToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) {
    return value;
  }
  return Math.ceil(value / tickSize) * tickSize;
}

export function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(q, 0, 1) * (sorted.length - 1);
  const base = Math.floor(position);
  const fraction = position - base;
  const lower = sorted[base] ?? sorted[sorted.length - 1] ?? 0;
  const upper = sorted[base + 1] ?? lower;
  return lower + (upper - lower) * fraction;
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

export function formatFixed(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}
