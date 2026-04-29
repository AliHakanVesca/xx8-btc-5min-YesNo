import { describe, expect, it } from "vitest";
import {
  deriveOrderResultSuccess,
  extractOrderResultStatusCode,
  isOrderResultAccepted,
  summarizeOrderResult,
} from "../../src/infra/clob/orderResult.js";

describe("orderResult helpers", () => {
  it("marks http 400 payloads as unsuccessful", () => {
    expect(deriveOrderResultSuccess({ status: 400, error: "no match" }, 400)).toBe(false);
  });

  it("treats matched orders as accepted", () => {
    expect(
      isOrderResultAccepted({
        success: true,
        simulated: false,
        status: "matched",
        orderId: "0xabc",
        raw: { status: "matched" },
      }),
    ).toBe(true);
  });

  it("treats 400 responses as rejected", () => {
    expect(
      isOrderResultAccepted({
        success: false,
        simulated: false,
        status: "400",
        orderId: "unknown-order-id",
        raw: { status: 400, error: "order rejected" },
      }),
    ).toBe(false);
  });

  it("extracts status and error summary", () => {
    const summary = summarizeOrderResult({
      success: false,
      simulated: false,
      orderId: "unknown-order-id",
      status: "400",
      raw: { status: 400, error: "no match" },
      requestedAt: 0,
    });

    expect(extractOrderResultStatusCode({ status: "400", raw: { status: 400 } })).toBe(400);
    expect(summary).toMatchObject({
      success: false,
      status: "400",
      statusCode: 400,
      error: "no match",
    });
  });

  it("redacts CLOB auth headers and signed order payloads from raw summaries", () => {
    const summary = summarizeOrderResult({
      success: false,
      simulated: false,
      orderId: "unknown-order-id",
      status: "400",
      raw: {
        status: 400,
        error: "invalid amount",
        config: {
          headers: {
            POLY_API_KEY: "api-key-secret",
            POLY_PASSPHRASE: "passphrase-secret",
            POLY_SIGNATURE: "signature-secret",
          },
          data: JSON.stringify({
            owner: "api-key-secret",
            order: {
              signature: "0xabc123",
              tokenId: "token-id",
            },
          }),
        },
      },
      requestedAt: 0,
    });

    expect(JSON.stringify(summary)).not.toContain("api-key-secret");
    expect(JSON.stringify(summary)).not.toContain("passphrase-secret");
    expect(JSON.stringify(summary)).not.toContain("signature-secret");
    expect(JSON.stringify(summary)).not.toContain("0xabc123");
    expect(summary).toMatchObject({
      raw: {
        config: {
          headers: {
            POLY_API_KEY: "[redacted]",
            POLY_PASSPHRASE: "[redacted]",
            POLY_SIGNATURE: "[redacted]",
          },
        },
      },
    });
  });
});
