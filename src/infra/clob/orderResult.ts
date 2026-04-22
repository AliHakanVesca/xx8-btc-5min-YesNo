import type { OrderResult } from "./types.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseNumericStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

export function extractOrderResultStatusCode(result: Pick<OrderResult, "status" | "raw">): number | undefined {
  const direct = parseNumericStatus(result.status);
  if (direct !== undefined) {
    return direct;
  }

  const raw = asObject(result.raw);
  return raw ? parseNumericStatus(raw.status) : undefined;
}

export function deriveOrderResultSuccess(raw: unknown, fallbackStatus?: unknown): boolean {
  const statusCode =
    parseNumericStatus(fallbackStatus) ??
    parseNumericStatus(asObject(raw)?.status);

  if (statusCode !== undefined) {
    return statusCode < 400;
  }

  const rawObject = asObject(raw);
  if (!rawObject) {
    return true;
  }

  if (typeof rawObject.success === "boolean") {
    return rawObject.success;
  }

  const errorValue = rawObject.error;
  if (errorValue !== undefined && errorValue !== null && String(errorValue).length > 0) {
    return false;
  }

  const statusText = String(rawObject.status ?? fallbackStatus ?? "").toLowerCase();
  if (["rejected", "failed", "error", "rate_limited", "invalid"].includes(statusText)) {
    return false;
  }

  return true;
}

export function isOrderResultAccepted(
  result: Pick<OrderResult, "success" | "simulated" | "status" | "orderId" | "raw">,
): boolean {
  if (result.simulated) {
    return true;
  }

  if (!result.success) {
    return false;
  }

  const statusCode = extractOrderResultStatusCode(result);
  if (statusCode !== undefined) {
    return statusCode < 400;
  }

  const statusText = String(result.status ?? "").toLowerCase();
  if (["rejected", "failed", "error", "rate_limited", "invalid"].includes(statusText)) {
    return false;
  }

  if (result.orderId === "unknown-order-id" && statusText.length === 0) {
    return false;
  }

  return true;
}

export function summarizeOrderResult(result: OrderResult): Record<string, unknown> {
  const raw = asObject(result.raw);
  const statusCode = extractOrderResultStatusCode(result);
  return {
    success: result.success,
    simulated: result.simulated,
    orderId: result.orderId,
    status: result.status,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(raw?.error !== undefined ? { error: raw.error } : {}),
    ...(raw?.message !== undefined ? { message: raw.message } : {}),
    ...(raw?.errorMsg !== undefined ? { errorMsg: raw.errorMsg } : {}),
    ...(raw?.warnings !== undefined ? { warnings: raw.warnings } : {}),
    ...(raw ? { raw } : {}),
  };
}
